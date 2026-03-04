// index.js
import './keepAlive.js';
import express from 'express';
import session from 'express-session';
import MongoStore from 'connect-mongo';
import mongoose from 'mongoose';
import * as baileys from '@whiskeysockets/baileys';
import { Boom } from '@hapi/boom';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import QRCode from 'qrcode';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const PORT = process.env.PORT || 10000;

// ---------------------------
// Conecta ao MongoDB
// ---------------------------
if (!process.env.MONGO_URI) throw new Error('❌ MONGO_URI não definida.');

await mongoose.connect(process.env.MONGO_URI);
console.log('✅ Conectado ao MongoDB com sucesso!');

// ---------------------------
// Configura session do Express com MongoStore
// ---------------------------
app.use(session({
  secret: process.env.SESSION_SECRET || 'azevedo-secret',
  resave: false,
  saveUninitialized: false,
  store: MongoStore.create({ mongoUrl: process.env.MONGO_URI })
}));

// ---------------------------
// Inicializa servidor
// ---------------------------
app.listen(PORT, () => {
  console.log(`✅ Servidor iniciado na porta ${PORT}`);
});

// ---------------------------
// Baileys - WhatsApp
// ---------------------------
const SESSION_FILE_PATH = path.join(__dirname, 'baileys_auth_state.json');

// Importa CommonJS corretamente
import pkg from '@whiskeysockets/baileys';
const { useSingleFileAuthState, default: baileysDefault } = pkg;

const { state, saveState } = useSingleFileAuthState(SESSION_FILE_PATH);
let sock;           // socket do WhatsApp
let lastQR = '';     // último QR gerado

const startWhatsApp = async () => {
  sock = baileysDefault.makeWASocket({
    printQRInTerminal: true,
    auth: state,
    browser: ['Ubuntu','Chrome','22.04.4']
  });

  // Salva sessão
  sock.ev.on('creds.update', saveState);

  // Atualização de conexão
  sock.ev.on('connection.update', (update) => {
    const { connection, lastDisconnect, qr } = update;

    if (qr) {
      lastQR = qr; // guarda último QR para web
      console.log('📸 Novo QR gerado. Atualize a página para ver.');
    }

    if (connection === 'close') {
      const shouldReconnect = (lastDisconnect?.error as Boom)?.output?.statusCode !== 401;
      console.log('❌ Conexão fechada. Reconectando...', lastDisconnect?.error?.message || '');
      if (shouldReconnect) startWhatsApp();
    } else if (connection === 'open') {
      console.log('✅ WhatsApp conectado com sucesso!');
    }
  });

  // Mensagens recebidas
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

// ---------------------------
// Rota web para mostrar status e QR code
// ---------------------------
app.get('/', async (req, res) => {
  let qrImage = '';
  if (!sock?.user && lastQR) {
    qrImage = await QRCode.toDataURL(lastQR);
  }

  res.send(`
    <h1>🤖 Bot Azevedo</h1>
    ${sock?.user ? '<p>WhatsApp conectado ✅</p>' : '<p>WhatsApp não conectado ❌</p>'}
    ${qrImage ? `<img src="${qrImage}" alt="QR Code WhatsApp"/>` : '<p>Aguardando QR code...</p>'}
  `);
});