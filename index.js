import './keepAlive.js';
import express from 'express';
import * as baileys from '@whiskeysockets/baileys';
import { Boom } from '@hapi/boom';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import fetch from 'node-fetch';

const makeWASocket = baileys.default;
const { useMultiFileAuthState, fetchLatestBaileysVersion, DisconnectReason } = baileys;

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();
const port = process.env.PORT || 3000;

let sock;
let qrCodeString = '';

const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

// Keep-alive Render (a cada 10 minutos)
setInterval(() => {
  fetch(`https://botazevedoadv.onrender.com`).catch(() => {});
}, 1000 * 60 * 10);

// Configuração do Express
app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));
app.use(express.static(path.join(__dirname, 'public')));

// Rotas
app.get('/', (req, res) => res.redirect('/qr'));

app.get('/qr', (req, res) => {
  res.sendFile(path.join(__dirname, 'views', 'qr.html'));
});

app.get('/get-qr', (req, res) => {
  if (qrCodeString) {
    res.json({ qr: qrCodeString });
  } else {
    res.status(404).send('QR Code não disponível no momento.');
  }
});

// Mapa para controlar últimas interações
const lastInteraction = new Map(); // para o timeout do menu
const conversaLivre = new Map(); // usuários que estão em conversa livre
const TIMEOUT = 1000 * 60 * 30; // 30 minutos
const CONVERSA_TIMEOUT = 1000 * 60 * 60; // 1 hora

// Função principal do socket
const startSock = async () => {
  const { state, saveCreds } = await useMultiFileAuthState('auth');
  const { version } = await fetchLatestBaileysVersion();

  sock = makeWASocket({
    version,
    auth: state,
    printQRInTerminal: true,
    getMessage: async () => ({ conversation: "Mensagem recuperada" }),
  });

  sock.ev.on('creds.update', saveCreds);

  sock.ev.on('connection.update', (update) => {
    const { connection, qr, lastDisconnect } = update;

    if (qr) qrCodeString = qr;

    if (connection === 'close') {
      const statusCode = lastDisconnect?.error?.output?.statusCode;
      const shouldReconnect = statusCode !== DisconnectReason.loggedOut;
      if (shouldReconnect) startSock();
    }

    if (connection === 'open') {
      qrCodeString = '';
      sock.sendMessage(sock.user.id, {
        text: "✅ Conectado com sucesso ao bot do Azevedo - Advogados Associados!",
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
    const conversaStatus = conversaLivre.get(sender) || 0;

    const send = async (text) => {
      await delay(1200 + Math.random() * 1000);
      await sock.sendMessage(sender, { text });
    };

    // Atualiza tempo da última interação
    lastInteraction.set(sender, now);

    // Se usuário estiver em modo conversa livre, não responder
    if (now - conversaStatus < CONVERSA_TIMEOUT) {
      return;
    }

    // Fluxo das opções
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

    // Caso tenha mandado algo fora das opções, entra em conversa livre
    conversaLivre.set(sender, now);

    // Se última mensagem já tem 30 min, manda o menu de novo
    if (now - lastTime >= TIMEOUT) {
      await send("Olá! 👋 Seja bem-vindo(a) ao Azevedo - Advogados Associados.\n\nEscolha uma das opções:\n\n1️⃣ Direito Aéreo\n2️⃣ Direito Imobiliário\n3️⃣ Outros assuntos");
    }
  });
};

startSock();

app.listen(port, () => {
  console.log("✅ Servidor iniciado na porta " + port);
});
