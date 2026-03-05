const { default: makeWASocket, DisconnectReason, fetchLatestBaileysVersion } = require('@whiskeysockets/baileys');
const { MongoClient } = require('mongodb');
const { useMongoDBAuthState } = require('baileys-mongodb-library');
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');
const P = require('pino');
const { Boom } = require('@hapi/boom');

const app = express();
const server = http.createServer(app);
const io = new Server(server);
const port = process.env.PORT || 3000;

// Configuração MongoDB
const mongoUri = process.env.MONGODB_URI;
const client = new MongoClient(mongoUri);

async function startBot() {
    await client.connect();
    const db = client.db('bot_whatsapp');
    const collection = db.collection('auth');
    const { state, saveCreds } = await useMongoDBAuthState(collection);
    const { version } = await fetchLatestBaileysVersion();

    const sock = makeWASocket({
        version,
        auth: state,
        logger: P({ level: 'error' }),
        printQRInTerminal: false
    });

    sock.ev.on('creds.update', saveCreds);

    sock.ev.on('connection.update', async (update) => {
        const { connection, lastDisconnect, qr } = update;

        if (qr) {
            io.emit('qr', qr); // Envia o QR para o HTML
        }

        if (connection === 'open') {
            const user = sock.user;
            const ppUrl = await sock.profilePictureUrl(user.id, 'image').catch(() => 'https://www.w3schools.com/howto/img_avatar.png');
            io.emit('connected', { 
                number: user.id.split(':')[0], 
                name: user.name, 
                pic: ppUrl 
            });
            console.log('✅ Conectado!');
        }

        if (connection === 'close') {
            const shouldReconnect = (lastDisconnect.error instanceof Boom)?.output?.statusCode !== DisconnectReason.loggedOut;
            if (shouldReconnect) startBot();
            else io.emit('disconnected');
        }
    });

    // Rota para Desconectar
    app.get('/logout', async (req, res) => {
        await collection.deleteMany({}); // Limpa o Mongo
        await sock.logout();
        res.send('Sessão encerrada. Reinicie o bot.');
        process.exit(0); // Força reinício no Render
    });
}

app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'index.html'));
});

server.listen(port, () => {
    console.log(`🌐 Servidor rodando na porta ${port}`);
    startBot();
});