// index.js
import './keepAlive.js';
import express from 'express';
import * as baileys from '@whiskeysockets/baileys';
import { Boom } from '@hapi/boom';
import mongoose from 'mongoose';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import fetch from 'node-fetch';
import session from 'express-session';
import bcrypt from 'bcrypt';
import { WhatsAppSession } from './models/WhatsAppSession.js'; // Modelo para MongoDB

// ---------------------- Configurações ----------------------
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();
const port = process.env.PORT || 3000;
const SENHA_HASH = '$2b$10$yZxId/b5NiW6gq/Nb8EFbusyvFZpBFBCOrd36rpyDfcPuhbNAynNK';

const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
let sock;
let qrCodeString = '';

// ---------------------- Conecta ao MongoDB ----------------------
const MONGO_URI = process.env.MONGO_URI || 'mongodb://localhost:27017/wa-bot';
mongoose.connect(MONGO_URI)
  .then(() => console.log('✅ Conectado ao MongoDB com sucesso!'))
  .catch(err => console.error('❌ Erro ao conectar ao MongoDB:', err));

// ---------------------- Middlewares ----------------------
app.use(express.urlencoded({ extended: true }));
app.use(express.json());
app.use(session({
  secret: 'chave-secreta-bot',
  resave: false,
  saveUninitialized: false
}));

app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));
app.use(express.static(path.join(__dirname, 'public')));

// Keep-alive Render
setInterval(() => fetch('https://botazevedoadv.onrender.com').catch(() => {}), 1000 * 60 * 10);

// ---------------------- Rotas ----------------------
app.get('/login', (req, res) => res.sendFile(path.join(__dirname, 'views', 'login.html')));
app.post('/login', async (req, res) => {
  const match = await bcrypt.compare(req.body.senha, SENHA_HASH);
  if (match) {
    req.session.logado = true;
    res.json({ success: true });
  } else {
    res.json({ success: false, message: 'Senha incorreta. Tente novamente.' });
  }
});

app.get('/', (req, res) => res.redirect('/qr'));

app.get('/qr', (req, res) => {
  if (!req.session.logado) return res.redirect('/login');
  res.sendFile(path.join(__dirname, 'views', 'qr.html'));
});

app.get('/get-qr', (req, res) => {
  if (!req.session.logado) return res.status(401).send('Não autorizado.');
  if (qrCodeString) res.json({ qr: qrCodeString });
  else res.status(404).send('QR Code não disponível no momento.');
});

app.get('/session-info', async (req, res) => {
  if (!req.session.logado) return res.status(401).send('Não autorizado.');
  if (!sock || !sock.user) return res.json({ connected: false });

  try {
    let profilePictureUrl;
    try {
      profilePictureUrl = await sock.profilePictureUrl(sock.user.id, 'image');
    } catch {
      profilePictureUrl = 'https://via.placeholder.com/80';
    }

    res.json({
      connected: true,
      user: {
        id: sock.user.id,
        name: sock.user.name || '',
        profilePictureUrl
      }
    });
  } catch (err) {
    console.error('Erro ao obter info da sessão:', err);
    res.status(500).json({ connected: false });
  }
});

// ---------------------- Controle de Tickets ----------------------
const tickets = new Map();
const lastMenuSent = new Map();
const INACTIVITY_TIMEOUT = 60 * 60 * 1000; // 1h
const MENU_COOLDOWN = 24 * 60 * 60 * 1000; // 24h

const generateTicketId = () => 'Ticket#' + Math.random().toString(36).substr(2, 6).toUpperCase();

// ---------------------- Inicia WhatsApp ----------------------
const startSock = async () => {
  // 🔹 Carrega credenciais do MongoDB
  let state = { creds: {} };
  const session = await WhatsAppSession.findById('wa-session');
  if (session) state = { creds: session.creds };

  const { version } = await baileys.fetchLatestBaileysVersion();

  sock = baileys.makeWASocket({ version, auth: state });

  // 🔹 Salva credenciais no MongoDB sempre que atualizar
  sock.ev.on('creds.update', async (creds) => {
    await WhatsAppSession.findByIdAndUpdate('wa-session', { creds }, { upsert: true });
  });

  // ---------------------- Eventos de conexão ----------------------
  sock.ev.on('connection.update', ({ connection, qr, lastDisconnect }) => {
    if (qr) qrCodeString = qr;

    if (connection === 'close') {
      const statusCode = lastDisconnect?.error?.output?.statusCode;
      if (statusCode !== baileys.DisconnectReason.loggedOut) startSock();
    }

    if (connection === 'open') {
      qrCodeString = '';
      console.log('✅ WhatsApp conectado com sucesso!');
      sock.sendMessage(sock.user.id, { text: "✅ Conectado com sucesso ao bot!" });
    }
  });

  // ---------------------- Recebimento de mensagens ----------------------
  sock.ev.on('messages.upsert', async ({ messages }) => {
    const msg = messages[0];
    if (!msg.message || msg.key.fromMe) return;

    const sender = msg.key.remoteJid;
    const texto = msg.message?.conversation || msg.message?.extendedTextMessage?.text || '';
    if (!texto.trim()) return;

    const now = Date.now();
    const nome = msg.pushName || '';
    const saudacao = nome ? `Olá, ${nome}` : 'Olá';
    const send = async (text) => {
      await delay(1200 + Math.random() * 800);
      await sock.sendMessage(sender, { text });
    };

    let ticket = tickets.get(sender);

    if (ticket && now - ticket.lastActivity > INACTIVITY_TIMEOUT) tickets.delete(sender);
    ticket = tickets.get(sender);

    if (!ticket) {
      if (now - (lastMenuSent.get(sender) || 0) < MENU_COOLDOWN) return;

      ticket = { id: generateTicketId(), lastActivity: now, aguardandoOpcao: true };
      tickets.set(sender, ticket);
      lastMenuSent.set(sender, now);

      await send(`${saudacao}! 👋 Seja bem-vindo(a) ao *Azevedo e Juvencio - Sociedade de Advogados* ⚖️
Seu atendimento foi iniciado com o número: 🎫 *${ticket.id}*

Digite o número da opção desejada:

1️⃣ Direito Digital
2️⃣ Direito Cível e Contratual
3️⃣ Direito do Consumidor
4️⃣ Direito Imobiliário
5️⃣ Direito Trabalhista
6️⃣ Direito Empresarial
7️⃣ Outros Assuntos
8️⃣ Desejo falar de um atendimento/processo em andamento`);
      return;
    }

    ticket.lastActivity = now;

    // 🔹 Respostas automáticas
    const respostas = {
      '1': '📱 Direito Digital: ...',
      '2': '📄 Direito Cível e Contratual: ...',
      '3': '🛒 Direito do Consumidor: ...',
      '4': '🏠 Direito Imobiliário: ...',
      '5': '👷 Direito Trabalhista: ...',
      '6': '🏢 Direito Empresarial: ...',
      '7': '📝 Outros Assuntos: ...',
      '8': '📂 Atendimento/Processo em andamento: ...'
    };

    if (ticket.aguardandoOpcao && respostas[texto]) {
      await send(respostas[texto]);
      ticket.aguardandoOpcao = false;
      return;
    }

    if (!ticket.aguardandoOpcao && !ticket.obrigadoEnviado) {
      ticket.obrigadoEnviado = true;
      await send('✅ Obrigado pelas informações! Elas já foram enviadas ao nosso sistema.');
    }
  });
};

// ---------------------- Inicializa ----------------------
startSock();
app.listen(port, () => console.log('✅ Servidor iniciado na porta ' + port));