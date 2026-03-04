import './keepAlive.js';
import express from 'express';
import session from 'express-session';
import MongoStore from 'connect-mongo';
import mongoose from 'mongoose';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

// ✅ Path do arquivo atual
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const PORT = process.env.PORT || 10000;

// 🔹 Conecta MongoDB
const connectDB = async () => {
  if (!process.env.MONGO_URI) throw new Error('❌ MONGO_URI não definida.');
  await mongoose.connect(process.env.MONGO_URI);
  console.log('✅ Conectado ao MongoDB com sucesso!');
};
await connectDB();

// 🔹 Configura session do Express com MongoStore
app.use(session({
  secret: process.env.SESSION_SECRET || 'azevedo-secret',
  resave: false,
  saveUninitialized: false,
  store: MongoStore.create({ mongoUrl: process.env.MONGO_URI })
}));

// 🔹 Inicializa servidor
app.listen(PORT, () => {
  console.log(`✅ Servidor iniciado na porta ${PORT}`);
});

// 🔹 Caminho para salvar a sessão do Baileys
const SESSION_FILE_PATH = path.join(__dirname, 'baileys_auth_state.json');

// 🔹 Importa Baileys corretamente para Node ESM
import baileysPkg from '@whiskeysockets/baileys';
const { makeWASocket } = baileysPkg;
const { useSingleFileAuthState } = baileysPkg.default || baileysPkg;

// 🔹 Cria ou carrega sessão
const { state, saveState } = useSingleFileAuthState(SESSION_FILE_PATH);

// 🔹 Função principal do WhatsApp
const startWhatsApp = async () => {
  try {
    const sock = makeWASocket({
      printQRInTerminal: true, // Mostra QR Code no terminal
      auth: state,
      browser: ['Ubuntu','Chrome','22.04.4']
    });

    // 🔹 Salva sessão sempre que houver mudança
    sock.ev.on('creds.update', saveState);

    // 🔹 Conexão aberta / reconexão
    sock.ev.on('connection.update', (update) => {
      const { connection, lastDisconnect } = update;
      if(connection === 'close') {
        const shouldReconnect = lastDisconnect?.error?.output?.statusCode !== 401;
        console.log('❌ Conexão fechada. Reconectando...', lastDisconnect?.error?.message || '');
        if(shouldReconnect) startWhatsApp();
      } else if(connection === 'open') {
        console.log('✅ WhatsApp conectado com sucesso!');
      }
    });

    // 🔹 Mensagens recebidas
    sock.ev.on('messages.upsert', async ({ messages, type }) => {
      if(type !== 'notify') return;
      const msg = messages[0];
      if(!msg.message) return;

      const text = msg.message.conversation || msg.message.extendedTextMessage?.text;
      console.log(`Mensagem recebida de ${msg.key.remoteJid}:`, text);

      // Resposta automática simples
      if(text?.toLowerCase() === 'oi') {
        await sock.sendMessage(msg.key.remoteJid, { text: 'Olá! Bot funcionando ✅' });
      }
    });

  } catch (err) {
    console.error('❌ Erro ao iniciar WhatsApp:', err);
    // Tenta reiniciar depois de 5s
    setTimeout(startWhatsApp, 5000);
  }
};

// 🔹 Inicia WhatsApp
startWhatsApp();