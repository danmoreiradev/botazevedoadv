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

// Login
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
  if (qrCodeString) res.json({ qr: qrCodeString });
  else res.status(404).send('QR Code não disponível.');
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
  } catch {
    res.status(500).json({ connected: false });
  }
});

// Tickets
const tickets = new Map();
const TICKET_TIMEOUT = 2 * 60 * 60 * 1000;

const generateTicketId = () =>
  'Ticket#' + Math.random().toString(36).substr(2, 6).toUpperCase();

// Limpa tickets antigos
setInterval(() => {
  const now = Date.now();
  for (const [sender, ticket] of tickets.entries()) {
    if (now - ticket.lastActivity > TICKET_TIMEOUT) {
      tickets.delete(sender);
    }
  }
}, 1000 * 60 * 10);

const startSock = async () => {
  const { state, saveCreds } = await useMultiFileAuthState('auth');
  const { version } = await fetchLatestBaileysVersion();

  sock = makeWASocket({
    version,
    auth: state,
    getMessage: async () => ({ conversation: 'Mensagem recuperada' })
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
      setTimeout(() => {
        sock.sendMessage(sock.user.id, {
          text: '✅ Bot conectado com sucesso!'
        });
      }, 2000);
    }
  });

  sock.ev.on('messages.upsert', async ({ messages }) => {
    const msg = messages[0];
    if (!msg.message || msg.key.fromMe) return;

    const sender = msg.key.remoteJid;
    const texto = msg.message.conversation || msg.message?.extendedTextMessage?.text || '';
    const now = Date.now();

    let ticket = tickets.get(sender);

    if (!ticket || now - ticket.lastActivity > TICKET_TIMEOUT) {
      ticket = { ticketId: generateTicketId(), lastActivity: now };
      tickets.set(sender, ticket);

      await sock.sendMessage(sender, {
        text:
`Olá! 👋 Seja bem-vindo(a) ao *Azevedo e Juvencio - Sociedade de Advogados.*

📌 Seu atendimento foi iniciado com o número: *${ticket.ticketId}*

Digite o número da opção desejada:

1️⃣ Direito Digital (desbloqueio de contas)
2️⃣ Direito Cível e Contratual
3️⃣ Direito do Consumidor
4️⃣ Outros Assuntos`
      });
      return;
    }

    ticket.lastActivity = now;

    const send = async (text) => {
      await delay(1200 + Math.random() * 1000);
      await sock.sendMessage(sender, { text });
    };

    if (texto === '1') {
      await send(
`✳️ *Direito Digital – Desbloqueio de Contas*

Entendido! Problemas com redes sociais e contas bloqueadas exigem agilidade.

Para que possamos analisar a viabilidade da recuperação, por favor, nos envie:

📲 *Qual a plataforma?*
Instagram, Facebook, WhatsApp, Mercado Livre, Uber, etc.

❓ *O que aconteceu?*
A conta foi hackeada, banida por violação de termos ou você perdeu o acesso de outra forma?
Descreva os fatos de maneira fundamentada.

📸 *Prints são fundamentais!*
Envie capturas da mensagem de erro ou do aviso de suspensão.

👨‍⚖️ Um especialista em Direito Digital analisará seu caso e entrará em contato em breve.`
      );
    }

    if (texto === '2') {
      await send(
`✳️ *Direito Cível e Contratual*

Perfeito. Para direcionarmos você ao especialista em contratos e questões cíveis, precisamos entender o cenário:

📄 *Tipo de demanda*
Análise ou elaboração de contrato, cobrança, problema imobiliário ou responsabilidade civil?

📝 *Resumo do caso*
Explique brevemente a situação (texto ou áudio).

📎 *Documentação*
Se houver contrato, notificação ou documento assinado, envie o arquivo ou foto.

⏳ Aguarde um momento, nossa equipe jurídica já foi notificada e falará com você em instantes.`
      );
    }

    if (texto === '3') {
      await send(
`✳️ *Direito do Consumidor*

Compreendido! Vamos ajudar você a garantir seus direitos.

🛒 *Qual o problema?*
Cobrança indevida, negativação, produto com defeito, serviço não entregue ou problema com bancos, telefonia ou planos de saúde?

💰 *Houve prejuízo financeiro?*
Informe o valor aproximado.

📂 *Provas*
Envie notas fiscais, protocolos, e-mails ou prints de conversas.

👨‍⚖️ Um advogado especialista entrará em contato para orientar os próximos passos.`
      );
    }

    if (texto === '4') {
      await send(
`✳️ *Outros Assuntos*

Sem problemas! Mesmo que seu caso não se encaixe nas opções anteriores, queremos te ouvir.

📝 Descreva brevemente o assunto ou dúvida.
🎤 Se preferir, envie um áudio com mais detalhes.

📨 Sua mensagem será encaminhada para triagem, e o profissional adequado entrará em contato o mais rápido possível.`
      );
    }

    await send(
`✅ *Obrigado pelas informações!*

Elas já foram enviadas ao nosso sistema.

⏱️ *Tempo estimado de resposta:*  
15 a 30 minutos, dentro do horário comercial.

Se precisar adicionar algo mais, pode enviar agora.`
    );
  });
};

startSock();

app.listen(port, () =>
  console.log(`✅ Servidor iniciado na porta ${port}`)
);