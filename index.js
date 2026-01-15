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

/* ================= LOGIN ================= */

app.get('/login', (req, res) => {
  res.sendFile(path.join(__dirname, 'views', 'login.html'));
});

app.post('/login', async (req, res) => {
  const match = await bcrypt.compare(req.body.senha, SENHA_HASH);
  if (match) {
    req.session.logado = true;
    res.json({ success: true });
  } else {
    res.json({ success: false });
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
  else res.status(404).send('QR indisponível.');
});

/* ================= BOT ================= */

const tickets = new Map();
const lastMenuSent = new Map();

const INACTIVITY_TIMEOUT = 60 * 60 * 1000; // 1 HORA
const MENU_COOLDOWN = 24 * 60 * 60 * 1000; // 24 HORAS

const generateTicketId = () =>
  'Ticket#' + Math.random().toString(36).substr(2, 6).toUpperCase();

const startSock = async () => {
  const { state, saveCreds } = await useMultiFileAuthState('auth');
  const { version } = await fetchLatestBaileysVersion();

  sock = makeWASocket({ version, auth: state });
  sock.ev.on('creds.update', saveCreds);

  sock.ev.on('connection.update', ({ connection, qr, lastDisconnect }) => {
    if (qr) qrCodeString = qr;
    if (
      connection === 'close' &&
      lastDisconnect?.error?.output?.statusCode !== DisconnectReason.loggedOut
    ) {
      startSock();
    }
  });

  sock.ev.on('messages.upsert', async ({ messages }) => {
    const msg = messages[0];
    if (!msg.message || msg.key.fromMe) return;

    const sender = msg.key.remoteJid;
    const texto =
      msg.message?.conversation ||
      msg.message?.extendedTextMessage?.text ||
      '';

    if (!texto.trim()) return;

    const now = Date.now();
    const nome = msg.pushName || '';
    const saudacao = nome ? `Olá, ${nome}` : 'Olá';

    const send = async text => {
      await delay(1200 + Math.random() * 800);
      await sock.sendMessage(sender, { text });
    };

    let ticket = tickets.get(sender);

    // 🔴 Inatividade de 1 hora
    if (ticket && now - ticket.lastActivity > INACTIVITY_TIMEOUT) {
      tickets.delete(sender);
      ticket = null;
    }

    // 🟢 Novo atendimento (menu só após 24h)
    if (!ticket) {
      if (now - (lastMenuSent.get(sender) || 0) < MENU_COOLDOWN) return;

      ticket = {
        id: generateTicketId(),
        lastActivity: now
      };

      tickets.set(sender, ticket);
      lastMenuSent.set(sender, now);

      await send(
`${saudacao}! 👋 Seja bem-vindo(a) ao *Azevedo e Juvencio - Sociedade de Advogados* ⚖️
Seu atendimento foi iniciado com o número: 🎫 *${ticket.id}*

Digite o número da opção desejada:

1️⃣ Direito Digital (desbloqueio de contas)
2️⃣ Direito Cível e Contratual
3️⃣ Direito do Consumidor
4️⃣ Direito Imobiliário
5️⃣ Direito Trabalhista
6️⃣ Direito Empresarial
7️⃣ Outros Assuntos
8️⃣ Desejo falar de um atendimento/processo em andamento`
      );
      return;
    }

    ticket.lastActivity = now;

    const respostas = {

      '1': `📱 *Direito Digital (Desbloqueio de Contas)*

Entendido! Problemas com redes sociais e contas bloqueadas exigem agilidade.
Para que possamos analisar a viabilidade da recuperação, por favor, nos envie:

📌 Qual a plataforma? (Instagram, Facebook, WhatsApp, Mercado Livre, Uber, etc.)

📌 O que aconteceu? A conta foi hackeada, banida por "violação de termos" ou você perdeu o acesso de outra forma? Detalhe os fatos de maneira fundamentada.

📸 Prints são fundamentais: Envie documentos, como capturas de tela da mensagem de erro ou do aviso de suspensão que aparece para você.

👨‍⚖️ Um especialista em Direito Digital analisará seu caso e entrará em contato em breve.`,

      '2': `📄 *Direito Cível e Contratual*

Perfeito. Para direcionarmos você ao especialista em contratos e questões cíveis, precisamos entender o cenário:

📌 Tipo de demanda: Trata-se de uma análise/elaboração de contrato, uma cobrança, um problema imobiliário ou outra questão de responsabilidade civil?

📝 Resumo do caso: Explique brevemente a situação (pode ser por texto ou áudio).

📎 Documentação: Se houver um contrato, notificação ou documento assinado envolvido, por favor, anexe o arquivo ou foto aqui.

⏳ Aguarde um momento, nossa equipe jurídica especializada em Direito Cível/Contratual já foi notificada e falará com você em instantes.`,

      '3': `🛒 *Direito do Consumidor*

Compreendido! Vamos ajudar você a garantir seus direitos. Por favor, forneça os detalhes abaixo:

📌 Qual o problema? É uma cobrança/negativação indevida, produto com defeito, serviço não entregue ou problema com bancos/telefonia/planos de saúde?

💰 Houve prejuízo financeiro? Se sim, informe o valor aproximado.

📸 Provas: Envie fotos de notas fiscais, números de protocolo de atendimento, emails de reclamação ou prints de conversas.

👨‍⚖️ Um de nossos advogados especialistas em Defesa do Consumidor entrará em contato para dar os próximos passos.`,

      '4': `🏠 *Direito Imobiliário*

Entendido! Questões imobiliárias exigem atenção aos detalhes. Para que possamos te orientar, por favor, nos envie:

📌 Qual o objeto da consulta? É sobre compra e venda, aluguel, despejo, usucapião, regularização de escritura ou problemas com condomínio?

📝 Resumo da situação: Conte-nos o que está acontecendo (pode ser por texto ou áudio).

📎 Documentos: Se possível, envie fotos do contrato, matrícula do imóvel ou notificações recebidas.

👨‍⚖️ Um especialista em Direito Imobiliário analisará seu caso e entrará em contato em breve.`,

      '5': `👷 *Direito Trabalhista*

Compreendido. Vamos analisar seus direitos trabalhistas. Por favor, nos forneça as seguintes informações:

📌 Situação atual: Você ainda trabalha na empresa ou já foi desligado? Se saiu, qual foi a data de saída?

📌 Principais reclamações: O problema é sobre horas extras, falta de registro, verbas rescisórias, assédio ou acidente de trabalho?

📝 Detalhes: Explique brevemente os fatos (texto ou áudio).

👨‍⚖️ Nossa equipe especializada em Direito do Trabalho entrará em contato em instantes para te orientar.`,

      '6': `🏢 *Direito Empresarial*

Perfeito. Para atendermos sua empresa com a agilidade necessária, por favor, informe:

📌 Natureza da demanda: Trata-se de consultoria preventiva, defesa em processos, questões societárias, tributárias ou recuperação de crédito?

🏷️ Dados da empresa: Se preferir, informe o nome da empresa ou o segmento de atuação.

📝 Descrição: Descreva o cenário atual ou a dúvida específica que você possui.

👨‍⚖️ Um de nossos advogados corporativos entrará em contato para agendar uma conversa ou dar continuidade ao atendimento.`,

      '7': `📝 *Outros Assuntos*

Sem problemas! Se o seu caso não se encaixa nas opções anteriores, queremos te ouvir da mesma forma.

📌 Por favor, descreva brevemente o seu assunto ou dúvida.

🎤 Sinta-se à vontade para enviar um áudio, se preferir explicar com mais detalhes.

🔎 Sua mensagem será encaminhada para nossa triagem e o profissional mais adequado para o seu tema entrará em contato o mais rápido possível.`,

      '8': `📂 *Atendimento/Processo em Andamento*

Perfeito! Vamos localizar seu histórico para agilizar o suporte. Por favor, nos informe:

📌 Nome completo do titular da ação/contrato.

📌 Número do processo ou CPF (caso você tenha em mãos).

📌 Qual a sua solicitação? Você deseja saber o andamento, enviar um documento novo ou falar com o advogado responsável?

📎 Se precisar enviar algum documento novo, pode anexar aqui agora.

⏳ Aguarde um momento. Nossa equipe de atendimento ao cliente irá acessar seu cadastro e te responderá em breve.`
    };

    if (respostas[texto]) {
      await send(respostas[texto]);
      await send(
`✅ Obrigado pelas informações! Elas já foram enviadas ao nosso sistema.

⏱️ Tempo estimado de resposta: de 15 a 30 minutos dentro do horário comercial.
Se precisar adicionar algo mais, pode enviar agora.`
      );
    }
  });
};

startSock();

app.listen(port, () =>
  console.log('✅ Servidor iniciado na porta ' + port)
);