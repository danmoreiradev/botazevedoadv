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

// Configuração MongoDB
const mongoUri = process.env.MONGODB_URI;
const client = new MongoClient(mongoUri);

let lastQr = null;
let currentUser = null;
let sock;

// Adaptador Manual de Auth para MongoDB (Persistência Blindada)
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

        // Monitor de Mensagens (O TESTE DO "OI")
        sock.ev.on('messages.upsert', async m => {
            const msg = m.messages[0];
            if (!msg.message || msg.key.fromMe) return;

            const messageType = Object.keys(msg.message)[0];
            const text = messageType === 'conversation' ? msg.message.conversation : 
                         messageType === 'extendedTextMessage' ? msg.message.extendedTextMessage.text : '';

            if (text.toLowerCase() === 'oi') {
                console.log(`📩 Respondendo teste para: ${msg.key.remoteJid}`);
                await sock.sendMessage(msg.key.remoteJid, { 
                    text: '✅ *Conectado com sucesso!*\n\nSeu bot Baileys + MongoDB está operante no Render.' 
                });
            }
        });

        sock.ev.on('connection.update', async (update) => {
            const { connection, lastDisconnect, qr } = update;
            
            if (qr) {
                lastQr = qr;
                io.emit('qr', qr);
            }

            if (connection === 'open') {
                lastQr = null;
                const user = sock.user;
                let ppUrl;
                try { ppUrl = await sock.profilePictureUrl(user.id, 'image'); } catch { ppUrl = 'https://www.w3schools.com/howto/img_avatar.png'; }
                
                currentUser = { 
                    number: user.id.split(':')[0], 
                    name: user.name || 'Bot Azevedo', 
                    pic: ppUrl 
                };
                io.emit('connected', currentUser);
                console.log('✅ WhatsApp Conectado!');
            }

            if (connection === 'close') {
                currentUser = null;
                const shouldReconnect = (lastDisconnect.error instanceof Boom)?.output?.statusCode !== DisconnectReason.loggedOut;
                if (shouldReconnect) startBot();
            }
        });

    } catch (err) {
        console.error("Erro no Servidor:", err);
    }
}

// Socket.io: Mantém a interface Web sincronizada
io.on('connection', (socket) => {
    if (currentUser) socket.emit('connected', currentUser);
    else if (lastQr) socket.emit('qr', lastQr);
});

app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'index.html')));

app.get('/logout', async (req, res) => {
    try {
        await client.db('bot_whatsapp').collection('auth_session').deleteMany({});
        if (sock) await sock.logout();
        currentUser = null;
        res.send('<h1>Desconectado! Reiniciando...</h1><script>setTimeout(()=>window.location.href="/", 2000)</script>');
        process.exit(0);
    } catch (e) { res.status(500).send("Erro"); }
});

server.listen(port, () => {
    console.log(`🌐 Servidor rodando na porta ${port}`);
    startBot();
});