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

// Adaptador de Autenticação para MongoDB
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
        console.log("🔄 Conectando ao Banco de Dados...");
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

        // Lógica de Resposta Automática (Teste de Vida)
        sock.ev.on('messages.upsert', async m => {
            const msg = m.messages[0];
            if (!msg.message || msg.key.fromMe) return;

            const messageType = Object.keys(msg.message)[0];
            const text = messageType === 'conversation' ? msg.message.conversation : 
                         messageType === 'extendedTextMessage' ? msg.message.extendedTextMessage.text : '';

            if (text.toLowerCase() === 'oi') {
                await sock.sendMessage(msg.key.remoteJid, { 
                    text: '✅ *Conectado com sucesso!*\n\nSeu bot está online e o painel visual foi atualizado.' 
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
                try { 
                    ppUrl = await sock.profilePictureUrl(user.id, 'image'); 
                } catch { 
                    ppUrl = 'https://www.w3schools.com/howto/img_avatar.png'; 
                }
                
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
                const statusCode = (lastDisconnect.error instanceof Boom)?.output?.statusCode;
                const shouldReconnect = statusCode !== DisconnectReason.loggedOut;
                
                console.log('A conexão fechou. Motivo:', lastDisconnect.error, 'Tentando reconectar?', shouldReconnect);
                
                if (shouldReconnect) {
                    startBot();
                } else {
                    console.log('❌ Sessão encerrada manualmente.');
                }
            }
        });

    } catch (err) {
        console.error("Erro fatal:", err);
    }
}

// Sincronização do Socket.io para novos acessos à página
io.on('connection', (socket) => {
    if (currentUser) socket.emit('connected', currentUser);
    else if (lastQr) socket.emit('qr', lastQr);
});

// Rotas Express
app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'index.html')));

app.get('/logout', async (req, res) => {
    try {
        // Limpa o Banco de Dados
        await client.db('bot_whatsapp').collection('auth_session').deleteMany({});
        
        // Desloga o Socket do WhatsApp
        if (sock) {
            await sock.logout();
            sock.ev.removeAllListeners();
        }
        
        currentUser = null;
        lastQr = null;
        
        // Avisa o Front-end para resetar
        io.emit('disconnected');
        
        console.log("Sessão destruída com sucesso.");
        res.status(200).json({ status: 'success' });
        
        // Pequeno delay para o Render não entrar em loop antes de limpar
        setTimeout(() => process.exit(0), 1000); 
    } catch (e) { 
        res.status(500).json({ status: 'error' }); 
    }
});

server.listen(port, () => {
    console.log(`🌐 Servidor ativo na porta ${port}`);
    startBot();
});