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
let lastBotMsgId = null; 

// Armazena tickets e estados de pausa na memória do servidor
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
            browser: ['Azevedo Advogados', 'Chrome', '1.0.0'],
            connectTimeoutMs: 60000,
            printQRInTerminal: true
        });

        sock.ev.on('creds.update', saveCreds);

        sock.ev.on('messages.upsert', async m => {
            const msg = m.messages[0];
            if (!msg.message || msg.key.remoteJid === 'status@broadcast') return;

            const from = msg.key.remoteJid;
            const isMe = msg.key.fromMe;
            const msgId = msg.key.id;
            const agora = Math.floor(Date.now() / 1000);
            const msgTime = msg.messageTimestamp;

            // 1. FIX INTERVENÇÃO HUMANA: Bloqueia se você digitar manualmente
            if (isMe) {
                // Se a mensagem enviada NÃO for o ID que o bot acabou de disparar
                // E já se passaram mais de 2 segundos (evita o eco do servidor)
                if (msgId !== lastBotMsgId && (agora - msgTime) > 2) {
                    const blockUntil = Date.now() + (3 * 24 * 60 * 60 * 1000); // 3 dias
                    activeTickets.set(from, { paused: true, until: blockUntil });
                    console.log(`👤 ATENDENTE ASSUMIU: Bot pausado para ${from} por 3 dias.`);
                }
                return; // Mata o script aqui para mensagens enviadas por você
            }

            // 2. VERIFICA SE O ATENDIMENTO ESTÁ PAUSADO
            const ticket = activeTickets.get(from);
            if (ticket && ticket.paused) {
                if (Date.now() < ticket.until) return; // Silêncio total do bot
                else activeTickets.delete(from); // Fim da pausa de 3 dias
            }

            // 3. CAPTURA DE TEXTO DO CLIENTE
            const texto = (msg.message.conversation || msg.message.extendedTextMessage?.text || "").trim();

            // Função padrão para enviar mensagem e registrar o ID (Escudo anti-loop)
            const send = async (content) => {
                const s = await sock.sendMessage(from, content);
                lastBotMsgId = s.key.id;
                return s;
            };

            // 4. FLUXO INICIAL (MENU)
            if (!ticket || (Date.now() - ticket.lastActivity > 2 * 60 * 60 * 1000)) {
                const tId = Math.floor(1000 + Math.random() * 9000);
                activeTickets.set(from, { id: tId, step: 'MENU', lastActivity: Date.now() });

                const menu = `Olá! 👋 Seja bem-vindo(a) ao *Azevedo e Juvencio - Sociedade de Advogados* ⚖️\n\n` +
                             `Para iniciar seu atendimento, *digite o NÚMERO* da opção desejada:\n\n` +
                             `1️⃣ Direito Digital\n` +
                             `2️⃣ Direito Cível\n` +
                             `3️⃣ Direito do Consumidor\n` +
                             `4️⃣ Direito Imobiliário\n` +
                             `5️⃣ Direito Trabalhista\n` +
                             `6️⃣ Direito Empresarial\n` +
                             `7️⃣ Outros Assuntos\n` +
                             `8️⃣ Já sou cliente\n\n` +
                             `🎫 Ticket: #${tId}`;
                
                await send({ text: menu });
                return;
            }

            ticket.lastActivity = Date.now();

            const fluxos = {
                '1': '📱 *Direito Digital*\n\nPor favor, descreva o que houve e qual a plataforma envolvida.',
                '2': '📄 *Direito Cível*\n\nPor favor, faça um breve resumo da situação jurídica.',
                '3': '🛒 *Direito do Consumidor*\n\nDescreva o problema com o produto, serviço ou instituição financeira.',
                '4': '🏠 *Direito Imobiliário*\n\nDescreva a situação do imóvel, aluguel ou contrato.',
                '5': '👷 *Direito Trabalhista*\n\nExplique o ocorrido em seu ambiente de trabalho.',
                '6': '🏢 *Direito Empresarial*\n\nDescreva a demanda jurídica da sua empresa.',
                '7': '📝 *Outros Assuntos*\n\nPor favor, descreva seu assunto detalhadamente.',
                '8': '📂 *Já sou cliente*\n\nInforme seu nome completo e, se possível, o número do processo.'
            };

            // Se está aguardando escolha do menu
            if (ticket.step === 'MENU') {
                if (fluxos[texto]) {
                    ticket.step = 'RELATO';
                    await send({ text: fluxos[texto] + '\n\n*(Por favor, detalhe com pelo menos 30 caracteres para análise)*' });
                }
                return;
            }

            // 5. VALIDAÇÃO DO RELATO (Pós-escolha)
            if (ticket.step === 'RELATO' && !ticket.finalizado) {
                const isMedia = msg.message.imageMessage || msg.message.documentMessage;
                
                if (texto.length < 30 && !isMedia) {
                    await send({ text: `⚠️ Para que possamos ajudar, descreva a situação com um pouco mais de detalhes (mínimo 30 caracteres).` });
                    return;
                }
                ticket.finalizado = true;
                await send({ text: `✅ Informações recebidas com sucesso!\n\nUm de nossos especialistas analisará seu caso e entrará em contato em instantes (dentro do horário comercial).` });
            }
        });

        sock.ev.on('connection.update', (u) => {
            const { connection, lastDisconnect, qr } = u;
            if (qr) { lastQr = qr; io.emit('qr', qr); }
            if (connection === 'open') {
                lastQr = null;
                currentUser = { name: 'Azevedo e Juvencio' };
                io.emit('connected', currentUser);
                console.log('✅ BOT ONLINE E BLINDADO');
            }
            if (connection === 'close') {
                const shouldReconnect = (lastDisconnect.error instanceof Boom)?.output?.statusCode !== DisconnectReason.loggedOut;
                if (shouldReconnect) startBot();
            }
        });

    } catch (e) { console.error("Erro no Bot:", e); }
}

// Servidor Web para Render e Socket.io
app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'index.html')));
app.get('/logout', async (req, res) => {
    await client.db('bot_whatsapp').collection('auth_session').deleteMany({});
    io.emit('disconnected');
    setTimeout(() => process.exit(0), 1000);
});

server.listen(port, () => startBot());