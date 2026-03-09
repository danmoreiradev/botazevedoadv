const { 
    default: makeWASocket, 
    DisconnectReason, 
    fetchLatestBaileysVersion, 
    BufferJSON, 
    initAuthCreds,
    makeCacheableSignalKeyStore,
    proto 
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
const MongoStore = require('connect-mongodb-session')(session);

const app = express();
const server = http.createServer(app);
const io = new Server(server);
const port = process.env.PORT || 10000;

const mongoUri = process.env.MONGODB_URI;
const client = new MongoClient(mongoUri);

// Configuração de Sessão Persistente para o Painel
const store = new MongoStore({
    uri: mongoUri,
    collection: 'web_sessions'
});

app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(session({
    secret: 'azevedo-juvencio-secure-key',
    resave: false,
    saveUninitialized: false,
    store: store,
    cookie: { maxAge: 1000 * 60 * 60 * 24 } // 24 horas
}));

// Variáveis de Estado
let sock;
let lastQr = null;
let currentUser = null;
let lastBotMessageId = null; 
let isConnecting = false;

// Referências das Coleções
let ticketsColl, authColl, knowledgeColl, userLoginColl;

// --- LÓGICA DE PERSISTÊNCIA BAILEYS (ANTI-BAD MAC) ---
async function useMongoDBAuthState(collection) {
    const writeData = (data, id) => collection.replaceOne(
        { _id: id }, 
        JSON.parse(JSON.stringify(data, BufferJSON.replacer)), 
        { upsert: true }
    );

    const readData = async (id) => {
        try {
            const data = await collection.findOne({ _id: id });
            return data ? JSON.parse(JSON.stringify(data), BufferJSON.reviver) : null;
        } catch { return null; }
    };

    const removeData = (id) => collection.deleteOne({ _id: id });

    const creds = await readData('creds') || initAuthCreds();

    return {
        state: {
            creds,
            keys: makeCacheableSignalKeyStore({
                get: async (type, ids) => {
                    const data = {};
                    await Promise.all(ids.map(async id => {
                        let value = await readData(`${type}-${id}`);
                        if (type === 'app-state-sync-key' && value) {
                            value = proto.Message.AppStateSyncKeyData.fromObject(value);
                        }
                        data[id] = value;
                    }));
                    return data;
                },
                set: async (data) => {
                    const tasks = [];
                    for (const type in data) {
                        for (const id in data[type]) {
                            const value = data[type][id];
                            const storeId = `${type}-${id}`;
                            tasks.push(value ? writeData(value, storeId) : removeData(storeId));
                        }
                    }
                    await Promise.all(tasks);
                }
            }, P({ level: 'silent' }))
        },
        saveCreds: () => writeData(creds, 'creds')
    };
}

// --- CORE DO BOT ---
async function startBot() {
    if (isConnecting) return;
    isConnecting = true;

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
            connectTimeoutMs: 120000,
            defaultQueryTimeoutMs: 90000,
            getMessage: async (key) => { return { conversation: 'Processando...' } }
        });

        sock.ev.on('creds.update', saveCreds);

        sock.ev.on('messages.upsert', async m => {
            const msg = m.messages[0];
            if (!msg.message || msg.key.remoteJid === 'status@broadcast') return;

            // UNIFICAÇÃO DE DISPOSITIVOS (FIX TICKET DUPLICADO)
            const rawJid = msg.key.remoteJid;
            const cleanNumber = rawJid.split(':')[0].split('@')[0]; 
            const isMe = msg.key.fromMe;

            const messageType = Object.keys(msg.message)[0];
            if (['protocolMessage', 'senderKeyDistributionMessage'].includes(messageType)) return;

            // Monitoramento de intervenção manual
            if (isMe) {
                if (msg.key.id !== lastBotMessageId) {
                    const blockUntil = Date.now() + (12 * 60 * 60 * 1000); // 12h pausa
                    await ticketsColl.updateOne({ _id: cleanNumber }, { $set: { paused: true, until: blockUntil } }, { upsert: true });
                }
                return;
            }

            // Busca Ticket Atual
            let ticket = await ticketsColl.findOne({ _id: cleanNumber });

            // Bloqueio se estiver pausado (atendimento humano)
            if (ticket?.paused && Date.now() < ticket.until) return;

            const textoRaw = msg.message.conversation || msg.message.extendedTextMessage?.text || "";
            const texto = textoRaw.trim();

            const sendBotMsg = async (content) => {
                const sent = await sock.sendMessage(rawJid, content);
                lastBotMessageId = sent.key.id;
                return sent;
            };

            // Lógica de Fluxo (Menu Inicial)
            const timeoutMenu = 4 * 60 * 60 * 1000;
            if (!ticket || (Date.now() - (ticket.lastActivity || 0) > timeoutMenu)) {
                
                // --- BUSCA NA BASE DE CONHECIMENTO ANTES DO MENU ---
                const kbMatch = await knowledgeColl.findOne({ 
                    pergunta: { $regex: new RegExp(texto, 'i') } 
                });

                if (kbMatch) {
                    await sendBotMsg({ text: `🔍 *Informação encontrada:* \n\n${kbMatch.resposta}` });
                    await sendBotMsg({ text: `Espero ter ajudado! Se precisar de algo mais, digite qualquer coisa para ver o menu.` });
                    await ticketsColl.updateOne({ _id: cleanNumber }, { $set: { lastActivity: Date.now() } }, { upsert: true });
                    return;
                }

                const ticketId = Math.floor(1000 + Math.random() * 9000);
                await ticketsColl.replaceOne({ _id: cleanNumber }, {
                    _id: cleanNumber,
                    id: ticketId,
                    aguardandoOpcao: true,
                    obrigadoEnviado: false,
                    lastActivity: Date.now(),
                    lastRawJid: rawJid
                }, { upsert: true });

                const menu = `Olá! 👋 Bem-vindo ao *Azevedo e Juvencio Advogados*\n🎫 Atendimento: *${ticketId}*\n\nSelecione uma opção:\n\n1️⃣ Direito Digital\n2️⃣ Direito Cível\n3️⃣ Consumidor\n4️⃣ Imobiliário\n5️⃣ Trabalhista\n6️⃣ Empresarial\n7️⃣ Outros\n8️⃣ Processo em andamento`;
                await sendBotMsg({ text: menu });
                return;
            }

            // Lógica de Resposta às Opções
            if (ticket.aguardandoOpcao) {
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
                    await sendBotMsg({ text: respostas[texto] });
                    await ticketsColl.updateOne({ _id: cleanNumber }, { 
                        $set: { aguardandoOpcao: false, lastActivity: Date.now() } 
                    });
                } else {
                    await sendBotMsg({ text: "⚠️ Opção inválida. Por favor, digite apenas o número de 1 a 8." });
                }
                return;
            }

            // Finalização após descrição
            if (!ticket.aguardandoOpcao && !ticket.obrigadoEnviado) {
                if (texto.length > 10 || msg.message.imageMessage) {
                    await sendBotMsg({ text: "✅ Entendido. Nossa equipe analisará e retornará em breve." });
                    await ticketsColl.updateOne({ _id: cleanNumber }, { $set: { obrigadoEnviado: true } });
                }
            }
        });

        sock.ev.on('connection.update', async (update) => {
            const { connection, lastDisconnect, qr } = update;
            if (qr) { lastQr = qr; io.emit('qr', qr); }
            if (connection === 'open') {
                isConnecting = false;
                lastQr = null;
                currentUser = { number: sock.user.id.split(':')[0], name: 'Azevedo e Juvencio' };
                io.emit('connected', currentUser);
                console.log('✅ Bot Online!');
            }
            if (connection === 'close') {
                isConnecting = false;
                const code = (lastDisconnect.error instanceof Boom)?.output?.statusCode;
                if (code !== DisconnectReason.loggedOut) setTimeout(startBot, 5000);
                else io.emit('disconnected');
            }
        });

    } catch (err) {
        isConnecting = false;
        setTimeout(startBot, 10000);
    }
}

// --- ROTAS DO SISTEMA ---

app.get('/login', (req, res) => res.sendFile(path.join(__dirname, 'login.html')));

app.post('/login', async (req, res) => {
    const { user, pass } = req.body;
    const admin = await userLoginColl.findOne({ user, pass });
    if (admin) {
        req.session.loggedIn = true;
        res.redirect('/');
    } else {
        res.send("<script>alert('Usuário/Senha inválidos'); window.location='/login';</script>");
    }
});

app.get('/', (req, res) => {
    if (!req.session.loggedIn) return res.redirect('/login');
    res.sendFile(path.join(__dirname, 'index.html'));
});

// API da Base de Conhecimento
app.get('/api/knowledge', async (req, res) => {
    if (!req.session.loggedIn) return res.sendStatus(401);
    const data = await knowledgeColl.find({}).sort({ date: -1 }).toArray();
    res.json(data);
});

app.post('/api/knowledge', async (req, res) => {
    if (!req.session.loggedIn) return res.sendStatus(401);
    const { pergunta, resposta } = req.body;
    await knowledgeColl.insertOne({ pergunta, resposta, date: new Date() });
    res.sendStatus(201);
});

app.delete('/api/knowledge/:id', async (req, res) => {
    if (!req.session.loggedIn) return res.sendStatus(401);
    const { ObjectId } = require('mongodb');
    await knowledgeColl.deleteOne({ _id: new ObjectId(req.params.id) });
    res.sendStatus(200);
});

app.get('/logout-whatsapp', async (req, res) => {
    await authColl.deleteMany({});
    if (sock) await sock.logout();
    currentUser = null;
    io.emit('disconnected');
    res.sendStatus(200);
});

// Socket.io Connect
io.on('connection', (socket) => {
    if (currentUser) socket.emit('connected', currentUser);
    else if (lastQr) socket.emit('qr', lastQr);
});

// Keep Alive (Render)
setInterval(() => {
    const host = process.env.RENDER_EXTERNAL_HOSTNAME;
    if (host) axios.get(`https://${host}/login`).catch(() => {});
}, 5 * 60 * 1000);

server.listen(port, () => startBot());