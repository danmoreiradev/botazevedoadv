const { 
    default: makeWASocket, 
    useMultiFileAuthState, 
    DisconnectReason, 
    fetchLatestBaileysVersion 
} = require('@whiskeysockets/baileys');
const qrcode = require('qrcode-terminal');
const P = require('pino');
const { Boom } = require('@hapi/boom');
const { MongoClient } = require('mongodb');

// 1. Configuração do MongoDB
const mongoUri = process.env.MONGODB_URI; 
if (!mongoUri) {
    console.error("❌ ERRO: A variável MONGODB_URI não foi definida no Render!");
    process.exit(1);
}
const client = new MongoClient(mongoUri);

async function startBot() {
    // Tenta conectar ao Mongo para validar antes de tudo
    try {
        await client.connect();
        console.log("✅ Conectado ao MongoDB com sucesso!");
    } catch (e) {
        console.error("❌ Erro ao conectar no MongoDB:", e);
    }

    const { state, saveCreds } = await useMultiFileAuthState('auth_info_baileys');
    const { version } = await fetchLatestBaileysVersion();

    const sock = makeWASocket({
        version,
        logger: P({ level: 'error' }),
        auth: state,
        printQRInTerminal: false
    });

    sock.ev.on('creds.update', saveCreds);

    sock.ev.on('connection.update', async (update) => {
        const { connection, lastDisconnect, qr } = update;

        if (qr) {
            console.log('📌 ESCANEIE O QR CODE NO LOG ABAIXO:');
            qrcode.generate(qr, { small: true });
        }

        if (connection === 'close') {
            const shouldReconnect = (lastDisconnect.error instanceof Boom)?.output?.statusCode !== DisconnectReason.loggedOut;
            if (shouldReconnect) startBot();
        } else if (connection === 'open') {
            console.log('✅ WhatsApp Conectado!');

            // TESTE DE VALIDAÇÃO NO MONGO
            const db = client.db('meu_bot');
            await db.collection('validacao').insertOne({ 
                status: 'Bot Online', 
                data: new Date() 
            });
            console.log('📝 Teste de escrita no MongoDB concluído!');
        }
    });
}

startBot();