import './keepAlive.js';
import express from 'express';
import session from 'express-session';
import MongoStore from 'connect-mongo';
import mongoose from 'mongoose';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const PORT = process.env.PORT || 10000;

// 🔹 Caminho para salvar a sessão do Baileys
const SESSION_FILE_PATH = path.join(__dirname, 'baileys_auth_state.json');

// =======================
// MongoDB
// =======================
const connectDB = async () => {
  if (!process.env.MONGO_URI) throw new Error('❌ MONGO_URI não definida.');
  await mongoose.connect(process.env.MONGO_URI);
  console.log('✅ Conectado ao MongoDB com sucesso!');
};

try {
  await connectDB();
} catch (err) {
  console.error('❌ Erro ao conectar no MongoDB:', err);
  process.exit(1);
}

// 🔹 Configura session do Express com MongoStore
app.use(session({
  secret: process.env.SESSION_SECRET || 'azevedo-secret',
  resave: false,
  saveUninitialized: false,
  store: MongoStore.create({ mongoUrl: process.env.MONGO_URI })
}));

// 🔹 Inicializa servidor Express
app.listen(PORT, () => {
  console.log(`✅ Servidor iniciado na porta ${PORT}`);
});

// =======================
// WhatsApp Baileys
// =======================
let sock; // variável global do socket

const startWhatsApp = async () => {
  try {
    // 🔹 Import dinâmico do Baileys
    const baileysPkg = await import('@whiskeysockets/baileys');
    const { useSingleFileAuthState, makeWASocket, DisconnectReason } = baileysPkg;

    // 🔹 Carrega ou cria sessão
    const { state, saveState } = useSingleFileAuthState(SESSION_FILE_PATH);

    sock = makeWASocket({
      printQRInTerminal: true,
      auth: state,
      browser: ['Ubuntu', 'Chrome', '22.04.4']
    });

    // 🔹 Salva sessão sempre que houver atualização
    sock.ev.on('creds.update', saveState);

    // 🔹 Atualização de conexão
    sock.ev.on('connection.update', (update) => {
      const { connection, lastDisconnect } = update;
      if (connection === 'close') {
        const statusCode = (lastDisconnect?.error?.output?.statusCode) || null;
        console.log(`❌ Conexão fechada. Código: ${statusCode}. Reconectando...`);
        // Reconecta se não for erro 401 (sessão inválida)
        if (statusCode !== 401) startWhatsApp();
      } else if (connection === 'open') {
        console.log('✅ WhatsApp conectado com sucesso!');
      }
    });

    // 🔹 Mensagens recebidas
    sock.ev.on('messages.upsert', async ({ messages, type }) => {
      if (type !== 'notify') return;
      const msg = messages[0];
      if (!msg.message) return;

      const text = msg.message.conversation || msg.message.extendedTextMessage?.text;
      console.log(`Mensagem recebida de ${msg.key.remoteJid}:`, text);

      // Resposta automática de teste
      if (text?.toLowerCase() === 'oi') {
        await sock.sendMessage(msg.key.remoteJid, { text: 'Olá! Bot funcionando ✅' });
      }
    });

  } catch (err) {
    console.error('❌ Erro ao iniciar WhatsApp:', err);
    setTimeout(startWhatsApp, 5000); // tenta reiniciar após 5s
  }
};

// 🔹 Inicializa WhatsApp
startWhatsApp();