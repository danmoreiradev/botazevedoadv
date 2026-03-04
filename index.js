import './keepAlive.js';
import express from 'express';
import session from 'express-session';
import MongoStore from 'connect-mongo';
import mongoose from 'mongoose';
import baileysPkg from '@whiskeysockets/baileys';
import fs from 'fs';
import path from 'path';
import QRCode from 'qrcode'; // npm install qrcode
import { fileURLToPath } from 'url';

const { useSingleFileAuthState, default: makeWASocket, DisconnectReason } = baileysPkg;

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
app.get('/', (req, res) => {
  res.send('🤖 Bot WhatsApp rodando! Acesse /qr para ver o QR Code.');
});

app.listen(PORT, () => {
  console.log(`✅ Servidor iniciado na porta ${PORT}`);
});

// 🔹 Caminho para salvar a sessão do Baileys
const SESSION_FILE_PATH = path.join(__dirname, 'baileys_auth_state.json');
const { state, saveState } = useSingleFileAuthState(SESSION_FILE_PATH);

let qrCodeString = ''; // 🔹 variável global para armazenar o QR Code atual

// 🔹 Rota para exibir QR Code
app.get('/qr', async (req, res) => {
  if(!qrCodeString) return res.send('QR Code ainda não gerado. Reinicie o bot se necessário.');
  const qrHtml = `<h2>Escaneie o QR Code no WhatsApp</h2><img src="${qrCodeString}" />`;
  res.send(qrHtml);
});

// 🔹 Inicializa WhatsApp
const startWhatsApp = async () => {
  const sock = makeWASocket({
    auth: state,
    browser: ['Ubuntu','Chrome','22.04.4']
  });

  // 🔹 Salva sessão
  sock.ev.on('creds.update', saveState);

  // 🔹 Conexão aberta / fechada
  sock.ev.on('connection.update', async (update) => {
    const { connection, lastDisconnect, qr } = update;

    // 🔹 Se gerar QR Code, converte para URL de imagem para web
    if(qr) {
      qrCodeString = await QRCode.toDataURL(qr);
      console.log('📲 QR Code gerado. Acesse /qr para escanear.');
    }

    if(connection === 'close') {
      const shouldReconnect = !(lastDisconnect?.error?.output?.statusCode === 401);
      console.log('❌ Conexão fechada. Reconectando...', lastDisconnect?.error?.message || '');
      if(shouldReconnect) startWhatsApp();
    } else if(connection === 'open') {
      console.log('✅ WhatsApp conectado com sucesso!');
      qrCodeString = ''; // limpa QR Code depois da conexão
    }
  });

  // 🔹 Evento de mensagens recebidas
  sock.ev.on('messages.upsert', async ({ messages, type }) => {
    if(type !== 'notify') return;
    const msg = messages[0];
    if(!msg.message) return;

    const text = msg.message.conversation || msg.message.extendedTextMessage?.text;
    console.log(`Mensagem recebida de ${msg.key.remoteJid}:`, text);

    if(text?.toLowerCase() === 'oi') {
      await sock.sendMessage(msg.key.remoteJid, { text: 'Olá! Bot funcionando ✅' });
    }
  });
};

startWhatsApp();