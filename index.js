const { 
    default: makeWASocket, 
    DisconnectReason, 
    fetchLatestBaileysVersion, 
    BufferJSON, 
    initAuthCreds 
} = require('@whiskeysockets/baileys');
const { MongoClient } = require('mongodb');
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');
const P = require('pino');
const { Boom } = require('@hapi/boom');

const app = express();
const server = http.createServer(app);
const io = new Server(server);
const port = process.env.PORT || 10000;

const mongoUri = process.env.MONGODB_URI;
const client = new MongoClient(mongoUri);

let lastQr = null;
let currentUser = null;
let sock;
let lastBotMessageId = null; // Armazena o ID da última mensagem enviada pelo bot

const activeTickets = new Map();

async function useMongoDBAuthState(collection) {
    const writeData = (data, id) => collection.replaceOne({ _id: id }, JSON.parse(JSON.stringify(data, BufferJSON.replacer)), { upsert: true });
    const readData = async (id) => {
        const data = await collection.findOne({ _id: id });
        return data ? JSON.parse(JSON.stringify(data), BufferJSON.reviver) : null;
    };
    const removeData = (id) => collection.deleteOne({ _id: id });
    const creds = await readData('creds') || initAuthCreds();

    return {
        state: {
            creds,
            keys: {
                get: async (type, ids) => {
                    const data = {};
                    await Promise.all(ids.map(async id => {
                        let value = await readData(`${type}-${id}`);
                        if (type === 'app-state-sync-key' && value) value = require('@whiskeysockets/baileys').proto.Message.AppStateSyncKeyData.fromObject(value);
                        data[id] = value;
                    }));
                    return data;
                },
                set: async (data) => {
                    for (const type in data) {
                        for (const id in data[type]) {
                            const value = data[type][id];
                            const storeId = `${type}-${id}`;
                            if (value) await writeData(value, storeId);
                            else await removeData(storeId);
                        }
                    }
                }
            }
        },
        saveCreds: () => writeData(creds, 'creds')
    };
}

async function startBot() {
    try {
        await client.connect();
        const collection = client.db('bot_whatsapp').collection('auth_session');
        const { state, saveCreds } = await useMongoDBAuthState(collection);
        const { version } = await fetchLatestBaileysVersion();

        sock = makeWASocket({
            version,
            auth: state,
            logger: P({ level: 'silent' }),
            browser: ['Bot Azevedo', 'Chrome', '1.0.0'],
            connectTimeoutMs: 60000,
            defaultQueryTimeoutMs: 0,
        });

        sock.ev.on('creds.update', saveCreds);

        sock.ev.on('messages.upsert', async m => {
            const msg = m.messages[0];
            if (!msg.message || msg.key.remoteJid === 'status@broadcast') return;

            const from = msg.key.remoteJid;
            const isMe = msg.key.fromMe;
            const msgId = msg.key.id;

            // 1. LÓGICA DE INTERVENÇÃO HUMANA (COM ESCUDO DE ID)
            if (isMe) {
                // Se o ID da mensagem for o mesmo que o bot acabou de enviar, IGNORE
                if (msgId === lastBotMessageId) return;

                const messageType = Object.keys(msg.message)[0];
                const isRealText = messageType === 'conversation' || messageType === 'extendedTextMessage';

                if (isRealText) {
                    const blockUntil = Date.now() + (3 * 24 * 60 * 60 * 1000); 
                    activeTickets.set(from, { paused: true, until: blockUntil });
                    console.log(`✅ Intervenção Humana REAL detectada em ${from}. Bot pausado.`);
                }
                return; 
            }

            // 2. VERIFICAÇÃO DE PAUSA
            const ticket = activeTickets.get(from);
            if (ticket && ticket.paused) {
                if (Date.now() < ticket.until) return; 
                else activeTickets.delete(from);
            }

            // 3. CAPTURA DE TEXTO
            const textoRaw = msg.message.conversation || msg.message.extendedTextMessage?.text || "";
            const texto = textoRaw.trim();

            // Função auxiliar para enviar e guardar o ID
            const sendBotMsg = async (jid, content) => {
                const sent = await sock.sendMessage(jid, content);
                lastBotMessageId = sent.key.id; // Salva o ID da mensagem enviada
                return sent;
            };

            // 4. SAUDAÇÃO E MENU
            if (!ticket || (Date.now() - ticket.lastActivity > 2 * 60 * 60 * 1000)) {
                const ticketId = Math.floor(1000 + Math.random() * 9000);
                activeTickets.set(from, { 
                    id: ticketId, 
                    aguardandoOpcao: true, 
                    obrigadoEnviado: false, 
                    lastActivity: Date.now() 
                });

                const hora = new Date().getHours();
                const saudacao = hora < 12 ? 'Bom dia' : hora < 18 ? 'Boa tarde' : 'Boa noite';

                const menuTexto = `${saudacao}! 👋 Seja bem-vindo(a) ao *Azevedo e Juvencio - Sociedade de Advogados* ⚖️\n` +
                    `Seu atendimento foi iniciado: 🎫 *${ticketId}*\n\n` +
                    `*Digite o número da opção desejada:*\n\n` +
                    `1️⃣ Direito Digital\n2️⃣ Direito Cível\n3️⃣ Direito do Consumidor\n4️⃣ Direito Imobiliário\n5️⃣ Direito Trabalhista\n6️⃣ Direito Empresarial\n7️⃣ Outros Assuntos\n8️⃣ Já sou cliente`;

                await sendBotMsg(from, { text: menuTexto });
                return;
            }

            ticket.lastActivity = Date.now();

            // 5. RESPOSTAS
            const respostas = {
                '1': `📱 *Direito Digital*\n\n📌 Qual a plataforma?\n📌 O que aconteceu?\n\nAnalisaremos seu caso em breve.`,
                '2': `📄 *Direito Cível*\n\n📌 Tipo de demanda?\n📝 Resumo do caso?\n\nEquipe notificada.`,
                '3': `🛒 *Direito do Consumidor*\n\n📌 Qual o problema?\n💰 Prejuízo?\n\nUm advogado falará com você.`,
                '4': `🏠 *Direito Imobiliário*\n\n📌 Objeto?\n📝 Situação?\n\nAnalisaremos em breve.`,
                '5': `👷 *Direito Trabalhista*\n\n📌 Situação atual?\n📌 Reclamações?\n\nEntraremos em contato.`,
                '6': `🏢 *Direito Empresarial*\n\n📌 Natureza?\n🏷️ Empresa?\n\nUm advogado falará com você.`,
                '7': `📝 *Outros Assuntos*\n\n📌 Descreva brevemente seu assunto.\n\nSua mensagem foi para triagem.`,
                '8': `📂 *Atendimento em Andamento*\n\n📌 Nome completo.\n📌 CPF.\n\nEstamos localizando seu histórico.`
            };

            if (ticket.aguardandoOpcao && respostas[texto]) {
                await sendBotMsg(from, { text: respostas[texto] });
                ticket.aguardandoOpcao = false;
                return;
            }

            // 6. VALIDAÇÃO DE DETALHES
            if (!ticket.aguardandoOpcao && !ticket.obrigadoEnviado) {
                const MIN_DETALHE = 30;
                if (texto.length < MIN_DETALHE && !msg.message.imageMessage && !msg.message.documentMessage) {
                    await sendBotMsg(from, { text: `⚠️ Descreva melhor a situação (mínimo ${MIN_DETALHE} caracteres).` });
                    return;
                }
                ticket.obrigadoEnviado = true;
                await sendBotMsg(from, { text: `✅ Obrigado! Informações recebidas.\n\n⏱️ Retornaremos em breve.` });
            }
        });

        sock.ev.on('connection.update', (update) => {
            const { connection, lastDisconnect, qr } = update;
            if (qr) { lastQr = qr; io.emit('qr', qr); }
            if (connection === 'open') {
                lastQr = null;
                currentUser = { number: sock.user.id.split(':')[0], name: sock.user.name || 'Bot Azevedo', pic: 'https://www.w3schools.com/howto/img_avatar.png' };
                io.emit('connected', currentUser);
                console.log('✅ Bot Online!');
            }
            if (connection === 'close') {
                const statusCode = (lastDisconnect.error instanceof Boom)?.output?.statusCode;
                if (statusCode !== DisconnectReason.loggedOut) startBot();
            }
        });

    } catch (err) { console.error(err); }
}

io.on('connection', (socket) => {
    if (currentUser) socket.emit('connected', currentUser);
    else if (lastQr) socket.emit('qr', lastQr);
});

app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'index.html')));
app.get('/logout', async (req, res) => {
    await client.db('bot_whatsapp').collection('auth_session').deleteMany({});
    io.emit('disconnected');
    setTimeout(() => process.exit(0), 1000);
});

server.listen(port, () => startBot());