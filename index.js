import './keepAlive.js';
import express from 'express';
import * as baileys from '@whiskeysockets/baileys';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import fetch from 'node-fetch';
import session from 'express-session';
import bcrypt from 'bcrypt';
import { SessionModel, connectDB } from "./mongoSession.js";
import { makeCacheableSignalKeyStore } from '@whiskeysockets/baileys';

// Corrige Binary do Mongo para Buffer real
function fixBinary(obj) {
  if (!obj) return obj;
  if (obj?._bsontype === 'Binary' && obj.buffer) return Buffer.from(obj.buffer);
  if (obj?.type === 'Buffer' && Array.isArray(obj.data)) return Buffer.from(obj.data);
  if (Array.isArray(obj)) return obj.map(fixBinary);
  if (typeof obj === 'object') for (const key in obj) obj[key] = fixBinary(obj[key]);
  return obj;
}

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();
const port = process.env.PORT || 3000;

const SENHA_HASH = '$2b$10$yZxId/b5NiW6gq/Nb8EFbusyvFZpBFBCOrd36rpyDfcPuhbNAynNK';
let sock;
let qrCodeString = '';
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

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
setInterval(() => {
  fetch('https://botazevedoadv.onrender.com').catch(() => {});
}, 1000 * 60 * 10);

// LOGIN
app.get('/login', (req, res) => res.sendFile(path.join(__dirname, 'views', 'login.html')));
app.post('/login', async (req, res) => {
  const match = await bcrypt.compare(req.body.senha, SENHA_HASH);
  req.session.logado = match;
  res.json({ success: match, message: match ? '' : 'Senha incorreta' });
});

app.get('/', (req, res) => res.redirect('/qr'));
app.get('/qr', (req, res) => !req.session.logado ? res.redirect('/login') : res.sendFile(path.join(__dirname, 'views', 'qr.html')));
app.get('/get-qr', (req, res) => {
  if (!req.session.logado) return res.status(401).send('Não autorizado.');
  qrCodeString ? res.json({ qr: qrCodeString }) : res.status(404).send('QR Code não disponível no momento.');
});
app.get('/session-info', async (req, res) => {
  if (!req.session.logado) return res.status(401).send('Não autorizado.');
  if (!sock || !sock.user) return res.json({ connected: false });

  let profilePictureUrl = 'https://via.placeholder.com/80';
  try { profilePictureUrl = await sock.profilePictureUrl(sock.user.id, 'image'); } catch {}
  res.json({ connected: true, user: { id: sock.user.id, name: sock.user.name || '', profilePictureUrl } });
});

// CONTROLE DE SESSÃO DO BOT
const tickets = new Map();
const INACTIVITY_TIMEOUT = 7 * 24 * 60 * 60 * 1000; // 7 dias
const generateTicketId = () => 'Ticket#' + Math.random().toString(36).slice(2, 8).toUpperCase();

// ==========================
// 🔑 FUNÇÃO PRINCIPAL: START SOCK
// ==========================
const startSock = async () => {
  const sessionId = "default";

  // 🔁 Carrega sessão do Mongo
  let sessionData = await SessionModel.findById(sessionId);
  let authState;

  if (sessionData?.value) {
    console.log("🔁 Restaurando sessão Mongo...");
    const value = fixBinary(sessionData.value);
    authState = {
      creds: value.creds,
      keys: makeCacheableSignalKeyStore(value.keys, console)
    };
  } else {
    console.log("🆕 Criando nova sessão...");
    authState = {
      creds: baileys.initAuthCreds(),
      keys: makeCacheableSignalKeyStore({}, console)
    };
  }

  const { version } = await baileys.fetchLatestBaileysVersion();

  sock = baileys.makeWASocket({
    version,
    printQRInTerminal: false,
    auth: authState
  });

  // 💾 Salva sessão no Mongo
  sock.ev.on('creds.update', async () => {
    await SessionModel.findByIdAndUpdate(
      sessionId,
      { value: { creds: sock.authState.creds, keys: sock.authState.keys } },
      { upsert: true }
    );
  });

  // 🌐 Eventos de conexão
  sock.ev.on("connection.update", async ({ connection, lastDisconnect, qr }) => {
    if (qr) qrCodeString = qr;
    if (connection === "open") console.log("✅ Conectado ao WhatsApp com sucesso");
    if (connection === "close") {
      const reason = lastDisconnect?.error?.output?.statusCode;
      if (reason === baileys.DisconnectReason.connectionReplaced) {
        console.log("❌ Sessão substituída. Limpando sessão...");
        await SessionModel.findByIdAndDelete(sessionId);
      } else {
        console.log("❌ Conexão fechada, tentando reconectar...");
        setTimeout(() => startSock(), 5000);
      }
    }
  });

  // 📨 Mensagens recebidas
  sock.ev.on('messages.upsert', async ({ messages }) => {
    if (!messages?.length) return;
    const msg = messages[0];
    if (!msg.message) return;

    const sender = msg.key.remoteJid;
    if (!sender || !sender.endsWith('@s.whatsapp.net')) return;

    const now = Date.now();
    let ticket = tickets.get(sender);

    // HUMANO assume atendimento
    if (msg.key.fromMe) {
      const ticketAtual = tickets.get(sender);
      if (ticketAtual && ticketAtual.executionId) return;
      tickets.set(sender, {
        ...(ticketAtual || {}),
        atendimentoHumano: true,
        bloqueadoAte: Date.now() + INACTIVITY_TIMEOUT,
        lastActivity: Date.now(),
        executionId: null
      });
      return;
    }

    if (ticket?.atendimentoHumano && ticket.bloqueadoAte > now) return;

    const texto = msg.message.conversation || msg.message.extendedTextMessage?.text || '';
    if (!texto.trim()) return;

    const send = async (text) => {
      let currentTicket = tickets.get(sender);
      if (!currentTicket || currentTicket.atendimentoHumano) return;
      const execId = currentTicket.executionId;
      await delay(1500);
      currentTicket = tickets.get(sender);
      if (!currentTicket || currentTicket.atendimentoHumano || currentTicket.executionId !== execId) return;
      await sock.sendPresenceUpdate('composing', sender);
      await delay(800);
      currentTicket = tickets.get(sender);
      if (!currentTicket || currentTicket.atendimentoHumano || currentTicket.executionId !== execId) return;
      await sock.sendMessage(sender, { text });
    };

    // Expira tickets
    if (ticket && now - ticket.lastActivity > INACTIVITY_TIMEOUT) tickets.delete(sender);

    if (!ticket) {
      ticket = {
        id: generateTicketId(),
        lastActivity: now,
        aguardandoOpcao: true,
        obrigadoEnviado: false,
        atendimentoHumano: false,
        bloqueadoAte: null,
        executionId: Date.now()
      };
      tickets.set(sender, ticket);
      return;
    }

    ticket.lastActivity = now;
    ticket.executionId = Date.now();
    tickets.set(sender, ticket);
  });
};

// ==========================
// 🔌 INICIALIZAÇÃO
// ==========================
await connectDB(process.env.MONGO_URI);
startSock();
app.listen(port, () => console.log(`✅ Servidor iniciado na porta ${port}`));