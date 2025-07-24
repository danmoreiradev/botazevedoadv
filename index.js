import './keepAlive.js';
import 'dotenv/config';
import express from 'express';
import * as baileys from '@whiskeysockets/baileys';
import { Boom } from '@hapi/boom';
import path from 'path';
import { fileURLToPath } from 'url';
import fetch from 'node-fetch';
import session from 'express-session';
import crypto from 'crypto';

const makeWASocket = baileys.makeWASocket;
const useMultiFileAuthState = baileys.useMultiFileAuthState;
const fetchLatestBaileysVersion = baileys.fetchLatestBaileysVersion;
const DisconnectReason = baileys.DisconnectReason;

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();
const port = process.env.PORT || 3000;

// Configurações de segurança
const SENHA_APP = process.env.SENHA_APP;
if (!SENHA_APP) {
  console.error('ERRO: Variável SENHA_APP não configurada no .env');
  process.exit(1);
}

let sock;
let qrCodeString = '';
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

// Middleware
app.use(express.urlencoded({ extended: true }));
app.use(session({
  secret: process.env.SESSION_SECRET || crypto.randomBytes(32).toString('hex'),
  resave: false,
  saveUninitialized: false,
  cookie: {
    secure: process.env.NODE_ENV === 'production',
    httpOnly: true,
    maxAge: 24 * 60 * 60 * 1000 // 1 dia
  }
}));
app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));
app.use(express.static(path.join(__dirname, 'public')));
app.use(express.json());

// Keep-alive Render
setInterval(() => {
  fetch(`https://botazevedoadv.onrender.com`).catch(() => {});
}, 1000 * 60 * 10); // a cada 10 minutos

// Rotas de autenticação
app.get('/login', (req, res) => {
  res.sendFile(path.join(__dirname, 'views', 'login.html'));
});

app.post('/login', (req, res) => {
  try {
    const { senha } = req.body;

    if (!senha) {
      return res.status(400).json({ success: false, message: 'Senha não fornecida' });
    }

    if (senha === SENHA_APP) {
      req.session.logado = true;
      req.session.regenerate(() => {
        res.json({ success: true });
      });
    } else {
      res.status(401).json({ success: false, message: 'Senha incorreta. Tente novamente.' });
    }
  } catch (error) {
    console.error('Erro no login:', error);
    res.status(500).json({ success: false, message: 'Erro interno no servidor' });
  }
});

app.get('/logout', (req, res) => {
  req.session.destroy();
  res.redirect('/login');
});

// Rotas protegidas
const requireAuth = (req, res, next) => {
  if (!req.session.logado) {
    return res.redirect('/login');
  }
  next();
};

app.get('/', (req, res) => {
  res.redirect('/qr');
});

app.get('/qr', requireAuth, (req, res) => {
  res.sendFile(path.join(__dirname, 'views', 'qr.html'));
});

app.get('/get-qr', requireAuth, (req, res) => {
  if (qrCodeString) {
    res.json({ qr: qrCodeString });
  } else {
    res.status(404).send('QR Code não disponível no momento.');
  }
});

app.get('/session-info', requireAuth, async (req, res) => {
  try {
    if (!sock || !sock.user) return res.json({ connected: false });

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

// Controle de última interação por usuário (anti-flood)
const lastInteraction = new Map();
const TIMEOUT = 30 * 60 * 1000;

const startSock = async () => {
  const { state, saveCreds } = await useMultiFileAuthState('auth');
  const { version } = await fetchLatestBaileysVersion();

  sock = makeWASocket({
    version,
    auth: state,
    getMessage: async () => ({ conversation: "Mensagem recuperada" })
  });

  sock.ev.on('creds.update', saveCreds);

  sock.ev.on('connection.update', ({ connection, qr, lastDisconnect }) => {
    if (qr) qrCodeString = qr;
    if (connection === 'close') {
      const statusCode = lastDisconnect?.error?.output?.statusCode;
      if (statusCode !== DisconnectReason.loggedOut) startSock();
    }
    if (connection === 'open') {
      qrCodeString = '';
      sock.sendMessage(sock.user.id, {
        text: "✅ Conectado com sucesso ao bot do Azevedo - Advogados Associados!"
      });
    }
  });

  sock.ev.on('messages.upsert', async ({ messages }) => {
    const msg = messages[0];
    if (!msg.message || msg.key.fromMe) return;

    const sender = msg.key.remoteJid;
    const texto = msg.message?.conversation || msg.message?.extendedTextMessage?.text || '';
    if (texto.trim().length < 1) return;

    const now = Date.now();
    const lastTime = lastInteraction.get(sender) || 0;

    const send = async (text) => {
      await delay(1200 + Math.random() * 1000);
      await sock.sendMessage(sender, { text });
    };

    lastInteraction.set(sender, now);

    if (texto === '1') {
      await send("Perfeito! Para que possamos te ajudar da melhor forma com seu problema aéreo, por favor, nos envie as informações que você tem.");
      await send("✈️ Especifique o problema: Foi atraso, cancelamento, overbooking, ou extravio/dano de bagagem?");
      await send("📝 Detalhe os fatos: Conte-nos o que aconteceu, mesmo que seja por áudio!");
      await send("📎 Envie documentos: passagem aérea, comprovantes e quaisquer outras provas.");
      await send("👨‍⚖️ Um especialista entrará em contato em breve para analisar seu caso.");
      return;
    } else if (texto === '2') {
      await send("Certo! Para que nosso time de Direito Imobiliário possa te auxiliar:");
      await send("📎 Envie o contrato com a construtora.");
      await send("📝 Explique o motivo da sua consulta e qual é o problema.");
      await send("👨‍⚖️ Um especialista analisará sua demanda e entrará em contato.");
      return;
    } else if (texto === '3') {
      await send("Entendido. Um de nossos atendentes entrará em contato em breve.");
      await send("📝 Por favor, descreva brevemente sobre o que você precisa de ajuda.");
      return;
    }

    if (now - lastTime < TIMEOUT) return;

    await send("Olá! 👋 Seja bem-vindo(a) ao Azevedo - Advogados Associados.\n\nEscolha uma das opções:\n\n1️⃣ Direito Aéreo\n2️⃣ Direito Imobiliário\n3️⃣ Outros assuntos");
  });
};

startSock();

app.listen(port, () => console.log(`✅ Servidor iniciado na porta ${port}`));
