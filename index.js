const { 
    default: makeWASocket, 
    DisconnectReason, 
    fetchLatestBaileysVersion, 
    BufferJSON, 
    initAuthCreds,
    jidNormalizedUser 
} = require('@whiskeysockets/baileys');
const { MongoClient } = require('mongodb');
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');
const P = require('pino');
const { Boom } = require('@hapi/boom');
const axios = require('axios');
const session = require('express-session');

const app = express();
const server = http.createServer(app);
const io = new Server(server);
const port = process.env.PORT || 10000;

app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(session({
    secret: 'azevedo-secret-key',
    resave: false,
    saveUninitialized: true
}));

const mongoUri = process.env.MONGODB_URI;
const client = new MongoClient(mongoUri);

let lastQr = null;
let currentUser = null;
let sock;
let lastBotMessageId = null; 
let processing = new Set(); 

let ticketsColl, authColl, knowledgeColl, userLoginColl;

async function sendBotMsg(jid, content) {
    try {
        const sent = await sock.sendMessage(jid, content);
        lastBotMessageId = sent.key.id; 
        return sent;
    } catch (err) {
        console.error("Erro ao enviar:", err);
        return null;
    }
}

async function startBot() {
    try {
        await client.connect();
        const db = client.db('bot_whatsapp');
        authColl = db.collection('auth_session');
        ticketsColl = db.collection('active_tickets');
        knowledgeColl = db.collection('knowledge_base');
        userLoginColl = db.collection('user_login');

        const { state, saveCreds } = await useMongoDBAuthState(authColl);
        const { version } = await fetchLatestBaileysVersion();

        sock = makeWASocket({
            version,
            auth: state,
            logger: P({ level: 'silent' }),
            browser: ['Azevedo Advogados', 'Chrome', '1.0.0'],
            connectTimeoutMs: 60000,
            generateHighQualityLinkPreview: false
        });

        sock.ev.on('creds.update', saveCreds);

        sock.ev.on('messages.upsert', async m => {
            const msg = m.messages[0];
            if (!msg.message || msg.key.remoteJid === 'status@broadcast') return;

            const rawJid = msg.key.remoteJid;
            const cleanJid = jidNormalizedUser(rawJid);
            const isMe = msg.key.fromMe;
            const msgId = msg.key.id;

            let numeroRealExtraido = (msg.key.participant || msg.participant || cleanJid).split('@')[0].split(':')[0];

            if (numeroRealExtraido.startsWith('1109')) {
                const contact = sock.contacts ? sock.contacts[cleanJid] : null;
                if (contact && contact.id && !contact.id.includes('lid')) {
                    numeroRealExtraido = contact.id.split('@')[0];
                }
            }

            if (processing.has(msgId)) return;
            processing.add(msgId);
            setTimeout(() => processing.delete(msgId), 10000);

            const blockUntil = Date.now() + (3 * 24 * 60 * 60 * 1000);

            try {
                let ticket = await ticketsColl.findOne({
                    $or: [
                        { _id: numeroRealExtraido },
                        { numeroReal: numeroRealExtraido },
                        { _id: cleanJid.split('@')[0] }
                    ]
                });

                if (isMe) {
                    if (msgId !== lastBotMessageId) {
                        const targetId = ticket ? ticket._id : numeroRealExtraido;
                        await ticketsColl.updateOne(
                            { _id: targetId },
                            { $set: { paused: true, until: blockUntil, lastActivity: Date.now(), numeroReal: numeroRealExtraido } },
                            { upsert: true }
                        );
                    }
                    return;
                }

                if (ticket && ticket.paused) {
                    if (Date.now() < ticket.until) return;
                    else await ticketsColl.updateOne({ _id: ticket._id }, { $set: { paused: false } });
                }

                const textoRaw = msg.message.conversation || msg.message.extendedTextMessage?.text || "";
                const texto = textoRaw.trim();
                const timeoutMenu = 2 * 60 * 60 * 1000;

                if (!ticket || (Date.now() - (ticket.lastActivity || 0) > timeoutMenu)) {
                    const ticketId = Math.floor(1000 + Math.random() * 9000);
                    await sendBotMsg(rawJid, {
                        text: `Olá! 👋 Bem-vindo(a) ao *Azevedo e Juvencio Advogados* ⚖️\n🎫 Atendimento: *${ticketId}*\n\nDigite o número da opção desejada:\n\n1️⃣ Direito Digital\n2️⃣ Direito Cível\n3️⃣ Direito do Consumidor\n4️⃣ Direito Imobiliário\n5️⃣ Direito Trabalhista\n6️⃣ Direito Empresarial\n7️⃣ Outros Assuntos\n8️⃣ Processo em andamento`
                    });

                    await ticketsColl.updateOne(
                        { _id: numeroRealExtraido },
                        {
                            $set: {
                                id: ticketId,
                                numeroReal: numeroRealExtraido,
                                aguardandoOpcao: true,
                                obrigadoEnviado: false,
                                tentouInsistir: false,
                                lastActivity: Date.now(),
                                paused: false,
                                lastRawJid: rawJid
                            }
                        },
                        { upsert: true }
                    );
                    return;
                }

                await ticketsColl.updateOne(
                    { _id: ticket._id },
                    { $set: { lastActivity: Date.now(), lastRawJid: rawJid } }
                );

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

                if (ticket.aguardandoOpcao) {
                    if (respostas[texto]) {
                        await sendBotMsg(rawJid, { text: respostas[texto] });
                        await ticketsColl.updateOne({ _id: ticket._id }, { $set: { aguardandoOpcao: false, errosMenu: 0 } });
                    } else {
                        const novosErros = (ticket.errosMenu || 0) + 1;
                        if (novosErros >= 2) {
                            await sendBotMsg(rawJid, { text: `✅ Entendido. Já vamos encaminhar você para o especialista.` });
                            await ticketsColl.updateOne({ _id: ticket._id }, { $set: { aguardandoOpcao: false, obrigadoEnviado: true, paused: true, until: blockUntil } });
                        } else {
                            await sendBotMsg(rawJid, { text: `⚠️ Opção inválida. Digite de 1 a 8.` });
                            await ticketsColl.updateOne({ _id: ticket._id }, { $set: { errosMenu: novosErros } });
                        }
                    }
                    return;
                }

                if (!ticket.aguardandoOpcao && !ticket.obrigadoEnviado) {
                    const isMedia = !!(msg.message.imageMessage || msg.message.documentMessage || msg.message.audioMessage);
                    if (texto.length >= 20 || isMedia) {
                        await sendBotMsg(rawJid, { text: `✅ Recebido! Um especialista já vai atendê-lo.` });
                        await ticketsColl.updateOne({ _id: ticket._id }, { $set: { obrigadoEnviado: true, paused: true, until: blockUntil } });
                    } else if (!ticket.tentouInsistir) {
                        await sendBotMsg(rawJid, { text: `⚠️ Por favor, descreva com mais detalhes.` });
                        await ticketsColl.updateOne({ _id: ticket._id }, { $set: { tentouInsistir: true } });
                    } else {
                        await sendBotMsg(rawJid, { text: `✅ Recebido! Aguarde o especialista.` });
                        await ticketsColl.updateOne({ _id: ticket._id }, { $set: { obrigadoEnviado: true, paused: true, until: blockUntil } });
                    }
                }
            } catch (err) {
                console.error("Erro interno no upsert:", err);
            }
        });

        sock.ev.on('connection.update', async (update) => {
            const { connection, lastDisconnect, qr } = update;
            if (qr) { lastQr = qr; io.emit('qr', qr); }
            if (connection === 'open') {
                lastQr = null;
                currentUser = { number: sock.user.id.split(':')[0], name: 'Azevedo e Juvencio' };
                io.emit('connected', currentUser);
            }
            if (connection === 'close') {
                const shouldReconnect = (lastDisconnect.error instanceof Boom)?.output?.statusCode !== DisconnectReason.loggedOut;
                if (shouldReconnect) startBot();
                else { currentUser = null; io.emit('disconnected'); }
            }
        });

    } catch (err) { 
        console.error("Erro crítico no startBot:", err);
        setTimeout(startBot, 5000);
    }
}

async function useMongoDBAuthState(collection) {
    const writeData = (data, id) => collection.replaceOne({ _id: id }, JSON.parse(JSON.stringify(data, BufferJSON.replacer)), { upsert: true });
    const readData = async (id) => {
        const data = await collection.findOne({ _id: id });
        return data ? JSON.parse(JSON.stringify(data), BufferJSON.reviver) : null;
    };
    const removeData = (id) => collection.deleteOne({ _id: id });
    const creds = await readData('creds') || initAuthCreds();
    return {
        state: {
            creds,
            keys: {
                get: async (type, ids) => {
                    const data = {};
                    await Promise.all(ids.map(async id => {
                        let value = await readData(`${type}-${id}`);
                        if (type === 'app-state-sync-key' && value) value = require('@whiskeysockets/baileys').proto.Message.AppStateSyncKeyData.fromObject(value);
                        data[id] = value;
                    }));
                    return data;
                },
                set: async (data) => {
                    for (const type in data) {
                        for (const id in data[type]) {
                            const value = data[type][id];
                            if (value) writeData(value, `${type}-${id}`);
                            else removeData(`${type}-${id}`);
                        }
                    }
                }
            }
        },
        saveCreds: () => writeData(creds, 'creds')
    };
}

// Rotas e Servidor
app.get('/login', (req, res) => res.sendFile(path.join(__dirname, 'login.html')));
app.post('/login', async (req, res) => {
    const { user, pass } = req.body;
    const adminAccount = await userLoginColl.findOne({ user });
    if (adminAccount && adminAccount.pass === pass) {
        req.session.loggedIn = true;
        res.redirect('/');
    } else res.send("<script>alert('Erro'); window.location='/login';</script>");
});

app.get('/', (req, res) => {
    if (!req.session.loggedIn) return res.redirect('/login');
    res.sendFile(path.join(__dirname, 'index.html'));
});

server.listen(port, () => startBot());