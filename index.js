import './keepAlive.js';
import express from 'express';
import * as baileys from '@whiskeysockets/baileys';
import { Boom } from '@hapi/boom';
import path from 'path';
import { fileURLToPath } from 'url';
import fetch from 'node-fetch';
import session from 'express-session';
import bcrypt from 'bcrypt';

// Configurações básicas
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();
const port = process.env.PORT || 3000;

// Autenticação
const SENHA_HASH = '$2b$10$yZxId/b5NiW6gq/Nb8EFbusyvFZpBFBCOrd36rpyDfcPuhbNAynNK';

// Variáveis globais do WhatsApp
let sock;
let qrCodeString = '';
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

// Sistema de Tickets (NOVO)
const TICKET_EXPIRATION = 2 * 60 * 60 * 1000; // 2 horas
const activeTickets = new Map();
const generateTicketId = () => `TKT${Date.now()}${Math.floor(Math.random() * 10000).toString().padStart(4, '0')}`;

// Controle de flood (existente)
const TIMEOUT = 30 * 60 * 1000; // 30 minutos
const lastInteraction = new Map();

// Configuração do Express
app.use(express.urlencoded({ extended: true }));
app.use(session({
  secret: 'chave-secreta-bot',
  resave: false,
  saveUninitialized: false
}));
app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));
app.use(express.static(path.join(__dirname, 'public')));
app.use(express.json());

// Rotas
app.get('/login', (req, res) => res.sendFile(path.join(__dirname, 'views', 'login.html')));
app.post('/login', async (req, res) => {
  const match = await bcrypt.compare(req.body.senha, SENHA_HASH);
  if (match) {
    req.session.logado = true;
    res.json({ success: true });
  } else {
    res.json({ success: false, message: 'Senha incorreta' });
  }
});

app.get('/', (req, res) => res.redirect('/qr'));
app.get('/qr', (req, res) => !req.session.logado ? res.redirect('/login') : res.sendFile(path.join(__dirname, 'views', 'qr.html')));
app.get('/get-qr', (req, res) => !req.session.logado ? res.status(401).send('Não autorizado') : res.json(qrCodeString ? { qr: qrCodeString } : { status: 'waiting' }));

// WhatsApp Bot
const startSock = async () => {
  const { state, saveCreds } = await useMultiFileAuthState('auth');
  const { version } = await fetchLatestBaileysVersion();

  sock = baileys.makeWASocket({
    version,
    auth: state,
    printQRInTerminal: true,
    getMessage: async () => ({ conversation: "Mensagem recuperada" })
  });

  sock.ev.on('creds.update', saveCreds);

  sock.ev.on('connection.update', (update) => {
    if (update.qr) qrCodeString = update.qr;
    if (update.connection === 'close') {
      const shouldReconnect = update.lastDisconnect?.error?.output?.statusCode !== baileys.DisconnectReason.loggedOut;
      if (shouldReconnect) startSock();
    }
    if (update.connection === 'open') {
      qrCodeString = '';
      sock.sendMessage(sock.user.id, { text: "✅ Conectado com sucesso ao bot do Azevedo - Advogados Associados!" });
    }
  });

  sock.ev.on('messages.upsert', async ({ messages }) => {
    try {
      const msg = messages[0];
      if (!msg.message || msg.key.fromMe) return;

      const sender = msg.key.remoteJid;
      const text = msg.message?.conversation || 
                  msg.message?.extendedTextMessage?.text || 
                  msg.message?.listResponseMessage?.singleSelectReply?.selectedRowId || '';
      
      if (!text.trim()) return;

      const now = Date.now();
      const lastTime = lastInteraction.get(sender) || 0;

      // Função auxiliar para enviar mensagens
      const send = async (message) => {
        await delay(1000 + Math.random() * 500);
        await sock.sendMessage(sender, { text: message });
      };

      // Sistema de Tickets (Implementação completa)
      let userTicket = Array.from(activeTickets.values()).find(t => t.user === sender);
      const isNewInteraction = !userTicket || (now - userTicket.lastInteraction > TICKET_EXPIRATION);

      if (isNewInteraction) {
        if (userTicket) activeTickets.delete(userTicket.id);
        
        const newTicketId = generateTicketId();
        userTicket = {
          id: newTicketId,
          user: sender,
          createdAt: now,
          lastInteraction: now
        };
        activeTickets.set(newTicketId, userTicket);
        
        await send(`📝 Ticket criado: ${newTicketId}`);
      } else {
        userTicket.lastInteraction = now;
        activeTickets.set(userTicket.id, userTicket);
      }

      lastInteraction.set(sender, now);

      // Respostas existentes (mantidas intactas)
      if (text === '1') {
        await send("Perfeito! Para que possamos te ajudar da melhor forma com seu problema aéreo, por favor, nos envie as informações que você tem.");
        await send("✈️ Especifique o problema: Foi atraso, cancelamento, overbooking, ou extravio/dano de bagagem?");
        await send("📝 Detalhe os fatos: Conte-nos o que aconteceu, mesmo que seja por áudio!");
        await send("📎 Envie documentos: passagem aérea, comprovantes e quaisquer outras provas.");
        await send("👨‍⚖️ Um especialista entrará em contato em breve para analisar seu caso.");
        return;
      } else if (text === '2') {
        await send("Certo! Para que nosso time de Direito Imobiliário possa te auxiliar:");
        await send("📎 Envie o contrato com a construtora.");
        await send("📝 Explique o motivo da sua consulta e qual é o problema.");
        await send("👨‍⚖️ Um especialista analisará sua demanda e entrará em contato.");
        return;
      } else if (text === '3') {
        await send("Entendido. Um de nossos atendentes entrará em contato em breve.");
        await send("📝 Por favor, descreva brevemente sobre o que você precisa de ajuda.");
        return;
      }

      // Mensagem inicial se for nova interação
      if (now - lastTime >= TIMEOUT) {
        await sock.sendMessage(sender, {
          text: "Olá! 👋 Seja bem-vindo(a) ao Azevedo - Advogados Associados.",
          footer: "Escolha uma opção",
          title: "Como podemos ajudar?",
          buttonText: "Ver opções",
          sections: [{
            title: "Áreas de Atuação",
            rows: [
              { title: "1️⃣ Direito Aéreo", rowId: "1", description: "Problemas com voos" },
              { title: "2️⃣ Direito Imobiliário", rowId: "2", description: "Questões imobiliárias" },
              { title: "3️⃣ Outros assuntos", rowId: "3", description: "Outras questões" }
            ]
          }]
        });
      }
    } catch (error) {
      console.error('Erro ao processar mensagem:', error);
    }
  });
};

// Inicialização
startSock();
app.listen(port, () => console.log(`✅ Bot iniciado na porta ${port}`));

// Keep-alive
setInterval(() => fetch(`https://botazevedoadv.onrender.com`).catch(() => {}), 600000);