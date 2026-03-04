import './keepAlive.js';
import express from 'express';
import session from 'express-session';
import MongoStore from 'connect-mongo';
import mongoose from 'mongoose';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

// 🔹 Configuração do __dirname em ES Module
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

// 🔹 Import do Baileys adaptado para CommonJS
import baileysPkg from '@whiskeysockets/baileys';
const { useSingleFileAuthState, makeWASocket, DisconnectReason } = baileysPkg;
const { state, saveState } = useSingleFileAuthState(SESSION_FILE_PATH);

// 🔹 Inicializa WhatsApp
const startWhatsApp = async () => {
  const sock = makeWASocket({
    printQRInTerminal: true,
    auth: state,
    browser: ['Ubuntu', 'Chrome', '22.04.4']
  });

  // 🔹 Salva sessão sempre que houver mudança
  sock.ev.on('creds.update', saveState);

  // 🔹 Conexão aberta / fechada
  sock.ev.on('connection.update', (update) => {
    const { connection, lastDisconnect } = update;
    if(connection === 'close') {
      const statusCode = (lastDisconnect?.error)?.output?.statusCode;
      const shouldReconnect = statusCode !== 401;
      console.log('❌ Conexão fechada.', lastDisconnect?.error?.message || '');
      if(shouldReconnect) startWhatsApp(); // reconecta automaticamente
    } else if(connection === 'open') {
      console.log('✅ WhatsApp conectado com sucesso!');
    }
  });

  // 🔹 Evento de mensagens recebidas
  sock.ev.on('messages.upsert', async ({ messages, type }) => {
    if(type !== 'notify') return;
    const msg = messages[0];
    if(!msg.message) return;

    const text = msg.message.conversation || msg.message.extendedTextMessage?.text;
    console.log(`Mensagem recebida de ${msg.key.remoteJid}:`, text);

    // Exemplo simples de resposta automática
    if(text?.toLowerCase() === 'oi') {
      await sock.sendMessage(msg.key.remoteJid, { text: 'Olá! Bot funcionando ✅' });
    }
  });
};

startWhatsApp();