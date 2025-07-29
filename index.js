import './keepAlive.js';
import express from 'express';
import * as baileys from '@whiskeysockets/baileys';
import { Boom } from '@hapi/boom';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import fetch from 'node-fetch';
import session from 'express-session';
import bcrypt from 'bcrypt';

const makeWASocket = baileys.makeWASocket;
const useMultiFileAuthState = baileys.useMultiFileAuthState;
const fetchLatestBaileysVersion = baileys.fetchLatestBaileysVersion;
const DisconnectReason = baileys.DisconnectReason;

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();
const port = process.env.PORT || 3000;

const SENHA_HASH = '$2b$10$yZxId/b5NiW6gq/Nb8EFbusyvFZpBFBCOrd36rpyDfcPuhbNAynNK';

let sock;
let qrCodeString = '';
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

// ===== NOVAS CONSTANTES ===== //
const TICKET_TIMEOUT = 2 * 60 * 60 * 1000; // 2 horas em milissegundos
const activeTickets = new Map();
const generateTicketId = () => `TKT${Date.now()}${Math.floor(Math.random() * 1000)}`;
// ============================ //

// Middleware
app.use(express.urlencoded({ extended: true }));
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
  fetch(`https://botazevedoadv.onrender.com`).catch(() => {});
}, 1000 * 60 * 10);

// Rotas (mantidas iguais)
app.get('/login', (req, res) => {
  res.sendFile(path.join(__dirname, 'views', 'login.html'));
});

app.use(express.json());

app.post('/login', async (req, res) => {
  const senha = req.body.senha;
  const match = await bcrypt.compare(senha, SENHA_HASH);
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
  res.json(qrCodeString ? { qr: qrCodeString } : { status: 'waiting' });
});

app.get('/session-info', async (req, res) => {
  if (!req.session.logado) return res.status(401).send('Não autorizado.');
  if (!sock || !sock.user) return res.json({ connected: false });

  try {
    const profilePictureUrl = await sock.profilePictureUrl(sock.user.id, 'image').catch(() => 'https://via.placeholder.com/80');
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
    const texto = msg.message?.conversation || 
                 msg.message?.extendedTextMessage?.text || 
                 msg.message?.listResponseMessage?.singleSelectReply?.selectedRowId || '';
    
    if (texto.trim().length < 1) return;

    const now = Date.now();
    const lastTime = lastInteraction.get(sender) || 0;

    const send = async (text) => {
      await delay(1200 + Math.random() * 1000);
      await sock.sendMessage(sender, { text });
    };

    // ===== LÓGICA DE TICKETS ===== //
    let ticket = Array.from(activeTickets.values()).find(t => t.user === sender);
    
    // Se não tem ticket ou ticket expirado
    if (!ticket || (now - ticket.lastInteraction > TICKET_TIMEOUT)) {
      if (ticket) activeTickets.delete(ticket.id);
      
      const ticketId = generateTicketId();
      ticket = {
        id: ticketId,
        user: sender,
        createdAt: now,
        lastInteraction: now
      };
      activeTickets.set(ticketId, ticket);
      
      await send(`📝 Ticket criado: ${ticketId}`);
    } else {
      // Atualiza última interação
      ticket.lastInteraction = now;
      activeTickets.set(ticket.id, ticket);
    }
    // ============================= //

    lastInteraction.set(sender, now);

    // Mensagens originais mantidas intactas
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

    await sock.sendMessage(sender, {
      text: "Olá! 👋 Seja bem-vindo(a) ao Azevedo - Advogados Associados.",
      footer: "Escolha uma das opções abaixo",
      title: "Como podemos ajudar você?",
      buttonText: "Ver opções",
      sections: [
        {
          title: "Áreas de Atuação",
          rows: [
            { title: "1️⃣ Direito Aéreo", rowId: "1", description: "Problemas com voos e companhias aéreas" },
            { title: "2️⃣ Direito Imobiliário", rowId: "2", description: "Questões com construtoras e imóveis" },
            { title: "3️⃣ Outros assuntos", rowId: "3", description: "Outras questões jurídicas" }
          ]
        }
      ]
    });
  });
};

startSock();

app.listen(port, () => console.log("✅ Servidor iniciado na porta " + port));