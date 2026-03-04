// index.js
import './keepAlive.js';
import express from 'express';
import session from 'express-session';
import MongoStore from 'connect-mongo';
import mongoose from 'mongoose';
import path from 'path';
import { fileURLToPath } from 'url';
import baileysPkg from '@whiskeysockets/baileys';

const { makeWASocket, useSingleFileAuthState } = baileysPkg;

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const PORT = process.env.PORT || 10000;

const app = express();

// ==========================
// 🔹 Conexão com MongoDB
// ==========================
const connectDB = async () => {
  if (!process.env.MONGO_URI) throw new Error('❌ MONGO_URI não definida.');
  await mongoose.connect(process.env.MONGO_URI);
  console.log('✅ Conectado ao MongoDB com sucesso!');
};
await connectDB();

// ==========================
// 🔹 Configuração de Session
// ==========================
app.use(session({
  secret: process.env.SESSION_SECRET || 'azevedo-secret',
  resave: false,
  saveUninitialized: false,
  store: MongoStore.create({ mongoUrl: process.env.MONGO_URI })
}));

// ==========================
// 🔹 Servidor Express
// ==========================
app.get('/', (req, res) => {
  res.send('Bot Azevedo rodando! WhatsApp no terminal.');
});

app.listen(PORT, () => {
  console.log(`✅ Servidor iniciado na porta ${PORT}`);
});

// ==========================
// 🔹 WhatsApp Baileys
// ==========================
const SESSION_FILE_PATH = path.join(__dirname, 'baileys_auth_state.json');
const { state, saveState } = useSingleFileAuthState(SESSION_FILE_PATH);

const startWhatsApp = async () => {
  try {
    const sock = makeWASocket({
      printQRInTerminal: true,
      auth: state,
      browser: ['Ubuntu', 'Chrome', '22.04.4']
    });

    sock.ev.on('creds.update', saveState);

    sock.ev.on('connection.update', (update) => {
      const { connection, lastDisconnect } = update;
      if (connection === 'close') {
        console.log('❌ Conexão fechada. Reconectando...');
        startWhatsApp();
      } else if (connection === 'open') {
        console.log('✅ WhatsApp conectado com sucesso!');
      }
    });

    sock.ev.on('messages.upsert', async ({ messages, type }) => {
      if (type !== 'notify') return;
      const msg = messages[0];
      if (!msg.message) return;

      const text = msg.message.conversation || msg.message.extendedTextMessage?.text;
      console.log(`Mensagem recebida de ${msg.key.remoteJid}:`, text);

      // Exemplo de resposta automática
      if (text?.toLowerCase() === 'oi') {
        await sock.sendMessage(msg.key.remoteJid, { text: 'Olá! Bot funcionando ✅' });
      }
    });

  } catch (error) {
    console.error('❌ Erro ao iniciar WhatsApp:', error);
    setTimeout(startWhatsApp, 5000); // tenta reconectar em 5s se houver erro
  }
};

startWhatsApp();