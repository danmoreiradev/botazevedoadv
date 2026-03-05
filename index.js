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
const axios = require('axios');

const app = express();
const server = http.createServer(app);
const io = new Server(server);
const port = process.env.PORT || 10000;

const mongoUri = process.env.MONGODB_URI;
const client = new MongoClient(mongoUri);

let lastQr = null;
let currentUser = null;
let sock;
let lastBotMessageId = null; 

let ticketsColl;
let authColl;

// --- FUNÇÃO DE ESTADO MONGODB ---
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
                        if (type === 'app-state-sync-key' && value) {
                            value = require('@whiskeysockets/baileys').proto.Message.AppStateSyncKeyData.fromObject(value);
                        }
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
        const db = client.db('bot_whatsapp');
        authColl = db.collection('auth_session');
        ticketsColl = db.collection('active_tickets');

        const { state, saveCreds } = await useMongoDBAuthState(authColl);
        const { version } = await fetchLatestBaileysVersion();

        sock = makeWASocket({
            version,
            auth: state,
            logger: P({ level: 'silent' }),
            browser: ['Azevedo Advogados', 'Chrome', '1.0.0'],
            connectTimeoutMs: 80000,
            defaultQueryTimeoutMs: 0, 
            retryRequestDelayMs: 3000
        });

        sock.ev.on('creds.update', saveCreds);

        sock.ev.on('messages.upsert', async m => {
            const msg = m.messages[0];
            if (!msg.message || msg.key.remoteJid === 'status@broadcast') return;

            const from = msg.key.remoteJid;
            const isMe = msg.key.fromMe;
            const timestamp = msg.messageTimestamp;
            const agora = Math.floor(Date.now() / 1000);

            // Busca ticket no DB
            let ticket = await ticketsColl.findOne({ _id: from });

            const sendBotMsg = async (jid, content) => {
                try {
                    const sent = await sock.sendMessage(jid, content);
                    lastBotMessageId = sent.key.id; 
                    return sent;
                } catch (err) {
                    console.error("❌ Erro de Timeout contornado:", err.message);
                    return null; 
                }
            };

            // --- 1. TRAVA HUMANA (3 DIAS) ---
            if (isMe) {
                const diferencaTempo = agora - timestamp;
                // Se a mensagem sou EU mandando e não é o ID da última mensagem do bot
                if (msg.key.id !== lastBotMessageId && diferencaTempo > 1) {
                    const blockUntil = Date.now() + (3 * 24 * 60 * 60 * 1000); 
                    await ticketsColl.updateOne(
                        { _id: from }, 
                        { $set: { paused: true, until: blockUntil, lastActivity: Date.now() } }, 
                        { upsert: true }
                    );
                    console.log(`⚠️ ATENDENTE ASSUMIU: Bot travado para ${from} por 3 dias.`);
                }
                return;
            }

            // --- 2. VERIFICAÇÃO DE PAUSA NO BANCO ---
            if (ticket && ticket.paused) {
                if (Date.now() < ticket.until) {
                    return; // Bot ignorando porque você interviu
                } else {
                    // Passou os 3 dias, remove a pausa
                    await ticketsColl.updateOne({ _id: from }, { $set: { paused: false } });
                }
            }

            const textoRaw = msg.message.conversation || msg.message.extendedTextMessage?.text || "";
            const texto = textoRaw.trim();

            // --- 3. LOGICA DO MENU ---
            const timeoutMenu = 2 * 60 * 60 * 1000; 
            if (!ticket || (Date.now() - (ticket.lastActivity || 0) > timeoutMenu)) {
                const ticketId = Math.floor(1000 + Math.random() * 9000);
                await ticketsColl.replaceOne({ _id: from }, {
                    _id: from,
                    id: ticketId,
                    aguardandoOpcao: true,
                    obrigadoEnviado: false,
                    lastActivity: Date.now(),
                    paused: false
                }, { upsert: true });

                const menuTexto = `Olá! 👋 Seja bem-vindo(a) ao *Azevedo e Juvencio*\n🎫 Atendimento: *${ticketId}*\n\n1️⃣ Direito Digital\n2️⃣ Direito Cível\n3️⃣ Direito do Consumidor\n4️⃣ Direito Imobiliário\n5️⃣ Direito Trabalhista\n6️⃣ Direito Empresarial\n7️⃣ Outros Assuntos\n8️⃣ Já sou cliente`;
                await sendBotMsg(from, { text: menuTexto });
                return;
            }

            // Atualiza atividade
            await ticketsColl.updateOne({ _id: from }, { $set: { lastActivity: Date.now() } });

            const respostas = {
                '1': `📱 *Direito Digital*\n📌 Qual a plataforma?\n📌 O que aconteceu?`,
                '2': `📄 *Direito Cível*\n📌 Tipo de demanda?\n📝 Resumo do caso?`,
                '3': `🛒 *Direito do Consumidor*\n📌 Qual o problema?`,
                '4': `🏠 *Direito Imobiliário*\n📌 Objeto?\n📝 Situação?`,
                '5': `👷 *Direito Trabalhista*\n📌 Situação atual?`,
                '6': `🏢 *Direito Empresarial*\n📌 Natureza?`,
                '7': `📝 *Outros Assuntos*\n📌 Descreva brevemente seu assunto.`,
                '8': `📂 *Já sou cliente*\n📌 Nome completo e CPF.`
            };

            if (ticket.aguardandoOpcao) {
                if (respostas[texto]) {
                    const ok = await sendBotMsg(from, { text: respostas[texto] });
                    if (ok) await ticketsColl.updateOne({ _id: from }, { $set: { aguardandoOpcao: false } });
                }
                return;
            }

            // Validação de detalhes
            if (!ticket.aguardandoOpcao && !ticket.obrigadoEnviado) {
                const isMedia = msg.message.imageMessage || msg.message.documentMessage;
                if (texto.length < 30 && !isMedia) {
                    await sendBotMsg(from, { text: `⚠️ Por favor, descreva melhor a situação (mínimo 30 caracteres).` });
                    return;
                }
                const ok = await sendBotMsg(from, { text: `✅ Recebido! Retornaremos em breve.` });
                if (ok) await ticketsColl.updateOne({ _id: from }, { $set: { obrigadoEnviado: true } });
            }
        });

        sock.ev.on('connection.update', (update) => {
            const { connection, lastDisconnect, qr } = update;
            if (qr) { lastQr = qr; io.emit('qr', qr); }
            if (connection === 'open') {
                lastQr = null;
                currentUser = { number: sock.user.id.split(':')[0], name: 'Azevedo e Juvencio', pic: 'https://www.w3schools.com/howto/img_avatar.png' };
                io.emit('connected', currentUser);
                console.log('✅ Bot Online!');
            }
            if (connection === 'close') {
                const shouldReconnect = (lastDisconnect.error instanceof Boom)?.output?.statusCode !== DisconnectReason.loggedOut;
                if (shouldReconnect) startBot();
            }
        });

    } catch (err) { 
        console.error("Erro crítico:", err);
        setTimeout(startBot, 5000);
    }
}

// --- PING DE SURVIVAL ---
setInterval(async () => {
    try {
        const host = process.env.RENDER_EXTERNAL_HOSTNAME || `localhost:${port}`;
        const protocol = host.includes('localhost') ? 'http' : 'https';
        await axios.get(`${protocol}://${host}/`);
        console.log('🚀 Keep-alive: Ping enviado.');
    } catch (e) { console.log('Ping failed, but app is alive.'); }
}, 5 * 60 * 1000);

app.get('/', (req, res) => res.send('Bot Ativo!'));
app.get('/logout', async (req, res) => {
    await authColl.deleteMany({});
    await ticketsColl.deleteMany({});
    process.exit(0);
});

server.listen(port, () => startBot());