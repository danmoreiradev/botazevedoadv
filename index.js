import './keepAlive.js';
import express from 'express';
import * as baileys from '@whiskeysockets/baileys';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import fetch from 'node-fetch';
import session from 'express-session';
import bcrypt from 'bcrypt';
import { SessionModel, connectDB, mongoStore } from "./mongoSession.js";
import { makeCacheableSignalKeyStore } from '@whiskeysockets/baileys';

// ==========================
// 🔧 UTILITÁRIOS
// ==========================

// Converte Binário do Mongo para Buffer real
function fixBinary(obj) {
  if (!obj) return obj;
  if (obj?._bsontype === 'Binary' && obj.buffer) return Buffer.from(obj.buffer);
  if (obj?.type === 'Buffer' && Array.isArray(obj.data)) return Buffer.from(obj.data);
  if (Array.isArray(obj)) return obj.map(fixBinary);
  if (typeof obj === 'object') for (const key in obj) obj[key] = fixBinary(obj[key]);
  return obj;
}

// Delay assíncrono
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

// ==========================
// 🌐 CONFIGURAÇÕES DO SERVIDOR
// ==========================
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();
const port = process.env.PORT || 3000;

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

// Keep-alive para Render
setInterval(() => {
  fetch('https://botazevedoadv.onrender.com').catch(() => {});
}, 1000 * 60 * 10);

// ==========================
// 🔑 AUTENTICAÇÃO
// ==========================
const SENHA_HASH = '$2b$10$yZxId/b5NiW6gq/Nb8EFbusyvFZpBFBCOrd36rpyDfcPuhbNAynNK';

app.get('/login', (req, res) => res.sendFile(path.join(__dirname, 'views', 'login.html')));
app.post('/login', async (req, res) => {
  const match = await bcrypt.compare(req.body.senha, SENHA_HASH);
  req.session.logado = match;
  res.json({ success: match, message: match ? '' : 'Senha incorreta' });
});

// ==========================
// 🔗 ROTAS PRINCIPAIS
// ==========================
app.get('/', (req, res) => res.redirect('/qr'));
app.get('/qr', (req, res) => !req.session.logado ? res.redirect('/login') : res.sendFile(path.join(__dirname, 'views', 'qr.html')));

let qrCodeString = '';
app.get('/get-qr', (req, res) => {
  if (!req.session.logado) return res.status(401).send('Não autorizado.');
  qrCodeString ? res.json({ qr: qrCodeString }) : res.status(404).send('QR Code não disponível no momento.');
});

let sock;
app.get('/session-info', async (req, res) => {
  if (!req.session.logado) return res.status(401).send('Não autorizado.');
  if (!sock || !sock.user) return res.json({ connected: false });

  let profilePictureUrl = 'https://via.placeholder.com/80';
  try { profilePictureUrl = await sock.profilePictureUrl(sock.user.id, 'image'); } catch {}

  res.json({ 
    connected: true, 
    user: { id: sock.user.id, name: sock.user.name || '', profilePictureUrl } 
  });
});

// ==========================
// 🔌 CONTROLE DE TICKETS DO BOT
// ==========================
const tickets = new Map();
const INACTIVITY_TIMEOUT = 7 * 24 * 60 * 60 * 1000; // 7 dias
const generateTicketId = () => 'Ticket#' + Math.random().toString(36).slice(2, 8).toUpperCase();

// ==========================
// 🔑 INICIALIZAÇÃO DO WA SOCKET
// ==========================
const startSock = async () => {
  const sessionId = "default";

  // Recupera sessão do Mongo
  let sessionData = await SessionModel.findById(sessionId);
  let authState;

  if (sessionData?.value) {
    console.log("🔁 Restaurando sessão do MongoDB...");
    const value = fixBinary(sessionData.value);

    authState = {
      creds: value.creds || baileys.initAuthCreds(),
      keys: makeCacheableSignalKeyStore(value.keys || {}, console)
    };
  } else {
    console.log("🆕 Criando nova sessão...");
    authState = {
      creds: baileys.initAuthCreds(),
      keys: makeCacheableSignalKeyStore(mongoStore, console)
    };
  }

  const { version } = await baileys.fetchLatestBaileysVersion();

  sock = baileys.makeWASocket({
    version,
    printQRInTerminal: false,
    auth: authState
  });

  // Persistência no Mongo
  sock.ev.on('creds.update', async () => {
    try {
      await SessionModel.findByIdAndUpdate(
        sessionId,
        { value: { creds: sock.authState.creds, keys: sock.authState.keys } },
        { upsert: true }
      );
    } catch (err) {
      console.error('❌ Erro salvando sessão no Mongo:', err);
    }
  });

  // Eventos de conexão
  sock.ev.on('connection.update', async ({ connection, lastDisconnect, qr }) => {
    if (qr) qrCodeString = qr;

    if (connection === 'open') {
      console.log('✅ Conectado ao WhatsApp com sucesso');
      qrCodeString = '';
    }

    if (connection === 'close') {
      const reason = lastDisconnect?.error?.output?.statusCode;
      if (reason === baileys.DisconnectReason.connectionReplaced) {
        console.log('❌ Sessão substituída. Limpando sessão...');
        await SessionModel.findByIdAndDelete(sessionId);
      } else {
        console.log('❌ Conexão fechada, reconectando em 5s...');
        setTimeout(() => startSock(), 5000);
      }
    }
  });

  // Mensagens recebidas
  sock.ev.on('messages.upsert', async ({ messages }) => {
    if (!messages?.length) return;
    const msg = messages[0];
    if (!msg.message) return;

    const sender = msg.key.remoteJid;
    if (!sender || !sender.endsWith('@s.whatsapp.net')) return;

    const now = Date.now();
    let ticket = tickets.get(sender);

    if (msg.key.fromMe) {
      const ticketAtual = tickets.get(sender);
      tickets.set(sender, {
        ...(ticketAtual || {}),
        atendimentoHumano: true,
        bloqueadoAte: now + INACTIVITY_TIMEOUT,
        lastActivity: now,
        executionId: null
      });
      return;
    }

    if (ticket?.atendimentoHumano && ticket.bloqueadoAte > now) return;

    const texto = msg.message.conversation || msg.message.extendedTextMessage?.text || '';
    if (!texto.trim()) return;

    if (!ticket) {
      ticket = {
        id: generateTicketId(),
        lastActivity: now,
        aguardandoOpcao: true,
        obrigadoEnviado: false,
        atendimentoHumano: false,
        bloqueadoAte: null,
        executionId: now
      };
      tickets.set(sender, ticket);
      return;
    }

    ticket.lastActivity = now;
    ticket.executionId = now;
    tickets.set(sender, ticket);
  });
};

// ==========================
// 🔌 INICIALIZAÇÃO
// ==========================
await connectDB(process.env.MONGO_URI);
startSock();

app.listen(port, () => console.log(`✅ Servidor iniciado na porta ${port}`));