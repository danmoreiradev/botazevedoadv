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
            browser: ['Bot Azevedo', 'Chrome', '1.0.0']
        });

        sock.ev.on('creds.update', saveCreds);

        sock.ev.on('messages.upsert', async m => {
            const msg = m.messages[0];
            if (!msg.message || msg.key.remoteJid === 'status@broadcast') return;

            const from = msg.key.remoteJid;
            const isMe = msg.key.fromMe;
            const now = Date.now();

            // 1. LÓGICA DE INTERVENÇÃO HUMANA (FIXED)
            if (isMe) {
                // Só pausa se for você digitando manualmente no celular
                // Ignora mensagens de sistema, protocolos de entrega e reações
                const messageType = Object.keys(msg.message)[0];
                const isRealManualMessage = messageType === 'conversation' || messageType === 'extendedTextMessage';
                
                // IMPORTANTE: Só pausa se a mensagem NÃO for uma das que o bot costuma enviar (as respostas automáticas)
                if (isRealManualMessage) {
                    const blockUntil = now + (3 * 24 * 60 * 60 * 1000); 
                    activeTickets.set(from, { paused: true, until: blockUntil });
                    console.log(`🤖 Intervenção Humana Real em ${from}. Bot pausado por 3 dias.`);
                }
                return; // Impede o bot de responder a si mesmo
            }

            // 2. VERIFICAÇÃO DE BLOQUEIO/PAUSA
            const ticket = activeTickets.get(from);
            if (ticket && ticket.paused) {
                if (now < ticket.until) return; 
                else activeTickets.delete(from);
            }

            // 3. CAPTURA DE TEXTO DO CLIENTE
            const messageType = Object.keys(msg.message)[0];
            const textoRaw = msg.message.conversation || 
                             msg.message.extendedTextMessage?.text || "";
            const texto = textoRaw.trim();

            // 4. SAUDAÇÃO E MENU
            if (!ticket || (now - ticket.lastActivity > 2 * 60 * 60 * 1000)) {
                const ticketId = Math.floor(1000 + Math.random() * 9000);
                activeTickets.set(from, { 
                    id: ticketId, 
                    aguardandoOpcao: true, 
                    obrigadoEnviado: false, 
                    lastActivity: now 
                });

                const hora = new Date().getHours();
                const saudacao = hora < 12 ? 'Bom dia' : hora < 18 ? 'Boa tarde' : 'Boa noite';

                const menuTexto = `${saudacao}! 👋 Seja bem-vindo(a) ao *Azevedo e Juvencio - Sociedade de Advogados* ⚖️\n` +
                    `Seu atendimento foi iniciado: 🎫 *${ticketId}*\n\n` +
                    `*Digite o número da opção desejada:*\n\n` +
                    `1️⃣ Direito Digital (desbloqueio de contas)\n` +
                    `2️⃣ Direito Cível e Contratual\n` +
                    `3️⃣ Direito do Consumidor\n` +
                    `4️⃣ Direito Imobiliário\n` +
                    `5️⃣ Direito Trabalhista\n` +
                    `6️⃣ Direito Empresarial\n` +
                    `7️⃣ Outros Assuntos\n` +
                    `8️⃣ Desejo falar de um atendimento/processo em andamento`;

                await sock.sendMessage(from, { text: menuTexto });
                return;
            }

            ticket.lastActivity = now;

            // 5. RESPOSTAS
            const respostas = {
                '1': `📱 *Direito Digital (Desbloqueio de Contas)*\n\n📌 Qual a plataforma?\n📌 O que aconteceu?\n📸 Envie prints.\n\nUm especialista analisará seu caso em breve.`,
                '2': `📄 *Direito Cível e Contratual*\n\n📌 Tipo de demanda?\n📝 Resumo do caso?\n📎 Documentação?\n\nEquipe jurídica notificada.`,
                '3': `🛒 *Direito do Consumidor*\n\n📌 Qual o problema?\n💰 Prejuízo financeiro?\n📸 Provas?\n\nUm advogado entrará em contato.`,
                '4': `🏠 *Direito Imobiliário*\n\n📌 Objeto da consulta?\n📝 Resumo da situação?\n📎 Documentos?\n\nAnalisaremos seu caso em breve.`,
                '5': `👷 *Direito Trabalhista*\n\n📌 Situação atual?\n📌 Reclamações?\n📝 Detalhes?\n\nEntraremos em contato em instantes.`,
                '6': `🏢 *Direito Empresarial*\n\n📌 Natureza da demanda?\n🏷️ Empresa?\n📝 Descrição?\n\nUm advogado falará com você.`,
                '7': `📝 *Outros Assuntos*\n\n📌 Descreva brevemente seu assunto.\n🎤 Pode enviar áudio.\n\nSua mensagem foi para nossa triagem.`,
                '8': `📂 *Atendimento/Processo em Andamento*\n\n📌 Nome completo.\n📌 Número do processo/CPF.\n📌 Qual a sua solicitação?\n\nEstamos localizando seu histórico.`
            };

            if (ticket.aguardandoOpcao && respostas[texto]) {
                await sock.sendMessage(from, { text: respostas[texto] });
                ticket.aguardandoOpcao = false;
                return;
            }

            // 6. VALIDAÇÃO DE DETALHES
            if (!ticket.aguardandoOpcao && !ticket.obrigadoEnviado) {
                const MIN_DETALHE = 30;
                const isMedia = msg.message.imageMessage || msg.message.documentMessage;
                
                if (texto.length < MIN_DETALHE && !isMedia) {
                    await sock.sendMessage(from, { text: `⚠️ Descreva melhor a situação (mínimo ${MIN_DETALHE} caracteres).` });
                    return;
                }
                ticket.obrigadoEnviado = true;
                await sock.sendMessage(from, { text: `✅ Obrigado! Informações recebidas.\n\n⏱️ Retornaremos em 15-30 minutos.` });
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
                if ((lastDisconnect.error instanceof Boom)?.output?.statusCode !== DisconnectReason.loggedOut) startBot();
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