const { 
    default: makeWASocket, 
    DisconnectReason, 
    useMultiFileAuthState, // Usaremos como fallback ou base
    fetchLatestBaileysVersion 
} = require('@whiskeysockets/baileys');
const { MongoClient } = require('mongodb');
const P = require('pino');
const { Boom } = require('@hapi/boom');
const qrcode = require('qrcode-terminal');

// Configuração do MongoDB vinda do Render
const mongoUri = process.env.MONGODB_URI; 
const client = new MongoClient(mongoUri);

async function startBot() {
    console.log("🚀 Iniciando conexão com MongoDB...");
    await client.connect();
    console.log("✅ MongoDB Conectado!");

    // NOTA: Para um sistema de produção robusto no Render, 
    // o ideal é um adapter customizado. Para este MVP funcional:
    const { state, saveCreds } = await useMultiFileAuthState('auth_info_baileys');

    const { version } = await fetchLatestBaileysVersion();

    const sock = makeWASocket({
        version,
        logger: P({ level: 'error' }),
        auth: state,
        printQRInTerminal: true,
        browser: ['Gemini Bot', 'MacOS', '3.0']
    });

    // Salva as credenciais sempre que houver atualização (login, chaves novas)
    sock.ev.on('creds.update', saveCreds);

    sock.ev.on('connection.update', async (update) => {
        const { connection, lastDisconnect, qr } = update;

        if (qr) {
            console.log("📢 NOVO QR CODE GERADO. ESCANEIE ABAIXO:");
            qrcode.generate(qr, { small: true });
        }

        if (connection === 'close') {
            const shouldReconnect = (lastDisconnect.error instanceof Boom)?.output?.statusCode !== DisconnectReason.loggedOut;
            console.log('❌ Conexão fechada. Reconectando:', shouldReconnect);
            if (shouldReconnect) {
                startBot();
            }
        } else if (connection === 'open') {
            console.log('✨ BOT CONECTADO COM SUCESSO!');
            
            // Teste de gravação no Mongo para validação
            const db = client.db('chatbot_baileys');
            await db.collection('status').updateOne(
                { bot: 'gemini' }, 
                { $set: { lastOnline: new Date(), status: 'connected' } },
                { upsert: true }
            );
            console.log('📁 Status de conexão validado no MongoDB.');
        }
    });

    // Monitor de mensagens simples para validação de eco
    sock.ev.on('messages.upsert', async m => {
        const msg = m.messages[0];
        if (!msg.key.fromMe && m.type === 'notify') {
            console.log(`📩 Mensagem de ${msg.pushName}: ${msg.message?.conversation || 'Mídia'}`);
        }
    });
}

startBot().catch(err => console.error("Erro crítico:", err));npm install @whiskeysockets/baileys pino qrcode-terminal mongodb @hapi/boom