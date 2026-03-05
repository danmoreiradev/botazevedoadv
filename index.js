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

// Função de Autenticação Customizada para MongoDB
async function useMongoDBAuthState(collection) {
    const writeData = (data, id) => {
        return collection.replaceOne(
            { _id: id }, 
            JSON.parse(JSON.stringify(data, BufferJSON.replacer)), 
            { upsert: true }
        );
    };

    const readData = async (id) => {
        try {
            const data = await collection.findOne({ _id: id });
            if (!data) return null;
            return JSON.parse(JSON.stringify(data), BufferJSON.reviver);
        } catch (error) {
            return null;
        }
    };

    const removeData = async (id) => {
        try {
            await collection.deleteOne({ _id: id });
        } catch (error) {}
    };

    // Inicializa credenciais (Busca no Mongo ou cria novas)
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
        console.log("🔄 Conectando ao MongoDB...");
        await client.connect();
        const collection = client.db('bot_whatsapp').collection('auth_session');

        const { state, saveCreds } = await useMongoDBAuthState(collection);
        const { version } = await fetchLatestBaileysVersion();

        const sock = makeWASocket({
            version,
            auth: state,
            logger: P({ level: 'error' }),
            printQRInTerminal: true
        });

        // Evento crucial: Salva as credenciais no MongoDB
        sock.ev.on('creds.update', saveCreds);

        sock.ev.on('connection.update', async (update) => {
            const { connection, lastDisconnect, qr } = update;
            
            if (qr) {
                console.log("📌 NOVO QR CODE GERADO!");
                io.emit('qr', qr);
            }

            if (connection === 'open') {
                const user = sock.user;
                let ppUrl;
                try {
                    ppUrl = await sock.profilePictureUrl(user.id, 'image');
                } catch {
                    ppUrl = 'https://www.w3schools.com/howto/img_avatar.png';
                }
                
                io.emit('connected', { 
                    number: user.id.split(':')[0], 
                    name: user.name || 'Bot Ativo', 
                    pic: ppUrl 
                });
                console.log('✅ WhatsApp Conectado com Sucesso!');
            }

            if (connection === 'close') {
                const shouldReconnect = (lastDisconnect.error instanceof Boom)?.output?.statusCode !== DisconnectReason.loggedOut;
                if (shouldReconnect) startBot();
            }
        });

    } catch (err) {
        console.error("❌ Erro fatal no StartBot:", err);
    }
}

app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'index.html'));
});

app.get('/logout', async (req, res) => {
    try {
        await client.db('bot_whatsapp').collection('auth_session').deleteMany({});
        res.send('<h1>Sessão limpa! Reiniciando...</h1><script>setTimeout(()=>window.location.href="/", 3000)</script>');
        process.exit(0);
    } catch (e) {
        res.status(500).send("Erro ao deslogar");
    }
});

server.listen(port, () => {
    console.log(`🌐 Web Server em execução na porta ${port}`);
    startBot();
});