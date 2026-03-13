const { 
    default: makeWASocket, 
    DisconnectReason, 
    fetchLatestBaileysVersion, 
    BufferJSON, 
    initAuthCreds,
    jidNormalizedUser 
} = require('@whiskeysockets/baileys');
const { MongoClient, ObjectId } = require('mongodb');
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');
const P = require('pino');
const { Boom } = require('@hapi/boom');
const axios = require('axios');
const session = require('express-session');
const { GoogleGenerativeAI } = require('@google/generative-ai');

// --- CONFIGURAÇÕES DE TEXTO DO MENU ---
const TEXTOS_OPCOES = {
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

let genAI = null; 
let apiKeysColl, ticketsColl, authColl, knowledgeColl, userLoginColl;

const app = express();
const server = http.createServer(app);
const io = new Server(server);
const port = process.env.PORT || 10000;

app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// --- CONFIGURAÇÃO DE SESSÃO ---
const MongoDBStore = require('connect-mongodb-session')(session);
const store = new MongoDBStore({
    uri: process.env.MONGODB_URI,
    collection: 'sessions'
});

app.use(session({
    secret: 'azevedo-secret-key',
    resave: false,
    saveUninitialized: false, 
    store: store, 
    cookie: { maxAge: 1000 * 60 * 60 * 24 } 
}));

const mongoUri = process.env.MONGODB_URI;
const client = new MongoClient(mongoUri);

let lastQr = null;
let currentUser = null;
let sock;
let lastBotMessageId = null; 
let processing = new Set(); 

// --- FUNÇÕES AUXILIARES ---
function extrairIDUnico(jid) {
    if (!jid) return null;
    return jid.split('@')[0].split(':')[0];
}

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

// --- CORE DO BOT (WHATSAPP + IA) ---
async function startBot() {
    try {
        await client.connect();
        const db = client.db('bot_whatsapp');
        authColl = db.collection('auth_session');
        ticketsColl = db.collection('active_tickets');
        knowledgeColl = db.collection('knowledge_base');
        userLoginColl = db.collection('user_login');
        apiKeysColl = db.collection('api_keys');

        const geminiKeyDoc = await apiKeysColl.findOne({ nome: "gemini" });
        if (geminiKeyDoc && geminiKeyDoc.chave) {
            genAI = new GoogleGenerativeAI(geminiKeyDoc.chave);
            console.log("✅ Gemini pronto.");
        }

        const { state, saveCreds } = await useMongoDBAuthState(authColl);
        const { version } = await fetchLatestBaileysVersion();

        sock = makeWASocket({
            version,
            auth: state,
            logger: P({ level: 'silent' }),
            browser: ['Azevedo Advogados', 'Chrome', '1.0.0'],
            connectTimeoutMs: 60000
        });

        sock.ev.on('creds.update', saveCreds);

        sock.ev.on('messages.upsert', async m => {
            const msg = m.messages[0];
           if (!msg.message || msg.key.remoteJid === 'status@broadcast' || msg.key.remoteJid.includes('@lid')) return;

            const rawJid = msg.key.remoteJid;
            const numeroPuro = extrairIDUnico(rawJid);
            const isMe = msg.key.fromMe;
            const msgId = msg.key.id;

            if (processing.has(msgId)) return;
            processing.add(msgId);
            setTimeout(() => processing.delete(msgId), 10000);

            const tresDiasEmMs = 3 * 24 * 60 * 60 * 1000;
            const blockUntil = Date.now() + tresDiasEmMs;

            try {
                let ticket = await ticketsColl.findOne({ _id: numeroPuro });

                // 1. INTERVENÇÃO HUMANA
                if (isMe) {
                    if (msgId !== lastBotMessageId) {
                        await ticketsColl.updateOne(
                            { _id: numeroPuro }, 
                            { 
                                $set: { paused: true, until: blockUntil, lastActivity: Date.now(), lastRawJid: rawJid },
                                $setOnInsert: { id: Math.floor(1000 + Math.random() * 9000), numeroReal: numeroPuro }
                            }, 
                            { upsert: true }
                        );
                    }
                    return; 
                }

                // 2. VERIFICAÇÃO DE PAUSA
                if (ticket && ticket.paused) {
                    if (Date.now() < ticket.until) return;
                    else {
                        await ticketsColl.updateOne({ _id: numeroPuro }, { $set: { paused: false } });
                        ticket.paused = false;
                    }
                }

                // Captura o texto de qualquer origem (Web, Android, iOS, Desktop)
const texto = (
    msg.message?.conversation || 
    msg.message?.extendedTextMessage?.text || 
    msg.message?.imageMessage?.caption || 
    msg.message?.videoMessage?.caption || 
    msg.message?.buttonsResponseMessage?.selectedButtonId || 
    msg.message?.listResponseMessage?.singleSelectReply?.selectedRowId ||
    ""
).trim();

// LOG DE DEPURAÇÃO (Importante para você ver no terminal)
if (texto) {
    console.log(`[Mensagem] Conteúdo extraído: "${texto}" de ${numeroPuro}`);
} else {
    console.log(`[Aviso] Mensagem recebida de ${numeroPuro}, mas o texto veio vazio ou em formato não suportado.`);
}
                const timeoutMenu = 2 * 60 * 60 * 1000; 

                // 3. NOVO TICKET / REABERTURA
                if (!ticket || (Date.now() - (ticket.lastActivity || 0) > timeoutMenu)) {
                    const ticketId = Math.floor(1000 + Math.random() * 9000);
                    const isLead = texto.toLowerCase().includes("anúncio") || texto.toLowerCase().includes("vi no facebook");

                    if (isLead) {
                        await sendBotMsg(rawJid, { text: `✅ Recebido! Um especialista assumirá o seu caso em breve.` });
                        await ticketsColl.updateOne({ _id: numeroPuro }, {
                            $set: { id: ticketId, numeroReal: numeroPuro, paused: true, until: blockUntil, lastActivity: Date.now(), lastRawJid: rawJid, obrigadoEnviado: true }
                        }, { upsert: true });
                        return;
                    }

                    await sendBotMsg(rawJid, { text: `Olá, sou o assistente do escritório Azevedo & Juvencio. Como podemos ajudar?` });
                    await ticketsColl.updateOne({ _id: numeroPuro }, {
                        $set: { id: ticketId, numeroReal: numeroPuro, aguardandoIA: true, lastActivity: Date.now(), paused: false, lastRawJid: rawJid }
                    }, { upsert: true });
                    return;
                }

                // 4. ATUALIZA JID (Sincroniza dispositivo ativo)
                await ticketsColl.updateOne({ _id: numeroPuro }, { $set: { lastRawJid: rawJid, lastActivity: Date.now() } });

                // 5. LÓGICA IA / GEMINI
                if (ticket.aguardandoIA && genAI) {
                    const knowledgeDocs = await knowledgeColl.find({}).toArray();
                    const contextText = knowledgeDocs.map(k => `P: ${k.pergunta}\nR: ${k.resposta}`).join('\n\n');

                    const model = genAI.getGenerativeModel({ model: "gemini-2.5-flash" }, { apiVersion: 'v1beta' });
                    const prompt = `Você é o assistente da Azevedo & Juvencio.\nBase:\n${contextText}\nCliente: "${texto}"\nRegras: ESCALAR_ATENDIMENTO ou LEAD_ANUNCIO se necessário.`;
                    
                    const result = await model.generateContent(prompt);
                    const iaResponse = result.response.text().trim();

                    if (iaResponse.includes('LEAD_ANUNCIO')) {
                        await sendBotMsg(rawJid, { text: `✅ Recebido! Encaminhei seu caso para um especialista.` });
                        await ticketsColl.updateOne({ _id: numeroPuro }, { $set: { aguardandoIA: false, obrigadoEnviado: true, paused: true, until: blockUntil } });
                    } else if (iaResponse.includes('ESCALAR_ATENDIMENTO')) {
                        await sendBotMsg(rawJid, { text: `Vou transferir você. Digite a opção:\n1️⃣ Digital\n2️⃣ Cível\n3️⃣ Consumidor\n4️⃣ Imobiliário\n5️⃣ Trabalhista\n6️⃣ Empresarial\n7️⃣ Outros\n8️⃣ Processo` });
                        await ticketsColl.updateOne({ _id: numeroPuro }, { $set: { aguardandoIA: false, aguardandoOpcao: true } });
                    } else {
                        await sendBotMsg(rawJid, { text: `${iaResponse}\n\nAlgo mais?` });
                    }
                    return;
                }

                // 6. LÓGICA DE OPÇÕES
                if (ticket.aguardandoOpcao) {
                    const resposta = TEXTOS_OPCOES[texto];
                    if (resposta) {
                        await sendBotMsg(rawJid, { text: resposta });
                        await ticketsColl.updateOne({ _id: numeroPuro }, { $set: { aguardandoOpcao: false, obrigadoEnviado: true, paused: true, until: blockUntil } });
                    } else {
                        await sendBotMsg(rawJid, { text: "Por favor, escolha uma opção de 1 a 8." });
                    }
                    return;
                }

            } catch (err) { console.error("Erro interno:", err); }
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
            }
        });

    } catch (err) { setTimeout(startBot, 5000); }
}

// --- FUNÇÃO DE AUTENTICAÇÃO MONGODB (CORRIGIDA) ---
async function useMongoDBAuthState(collection) {
    const writeData = async (data, id) => {
        return await collection.replaceOne(
            { _id: id }, 
            JSON.parse(JSON.stringify(data, BufferJSON.replacer)), 
            { upsert: true }
        );
    };

    const readData = async (id) => {
        const data = await collection.findOne({ _id: id });
        return data ? JSON.parse(JSON.stringify(data), BufferJSON.reviver) : null;
    };

    const removeData = async (id) => {
        return await collection.deleteOne({ _id: id });
    };

    const creds = await readData('creds') || initAuthCreds();

    return {
        state: {
            creds,
            keys: {
                get: async (type, ids) => {
                    const data = {};
                    await Promise.all(ids.map(async id => {
                        let value = await readData(`${type}-${id}`);
                        if (type === 'app-state-sync-key' && value) {
                            value = require('@whiskeysockets/baileys').proto.Message.AppStateSyncKeyData.fromObject(value);
                        }
                        data[id] = value;
                    }));
                    return data;
                },
                set: async (data) => {
                    for (const type in data) {
                        for (const id in data[type]) {
                            const value = data[type][id];
                            const key = `${type}-${id}`;
                            // O SEGREDO ESTÁ AQUI: O 'await' obriga o banco a gravar uma chave antes de ir para a próxima
                            if (value) {
                                await writeData(value, key);
                            } else {
                                await removeData(key);
                            }
                        }
                    }
                }
            }
        },
        saveCreds: async () => {
            await writeData(creds, 'creds');
        }
    };
}

// --- ROTAS DO PAINEL (LOGIN E INTERFACE) ---
app.get('/login', (req, res) => res.sendFile(path.join(__dirname, 'login.html')));

app.post('/login', async (req, res) => {
    const { user, pass } = req.body;
    const admin = await userLoginColl.findOne({ user });
    if (admin && admin.pass === pass) {
        req.session.loggedIn = true;
        res.redirect('/');
    } else {
        res.send("<script>alert('Credenciais inválidas'); window.location='/login';</script>");
    }
});

app.get('/', (req, res) => {
    if (!req.session.loggedIn) return res.redirect('/login');
    res.sendFile(path.join(__dirname, 'index.html'));
});

app.get('/logout-whatsapp', async (req, res) => {
    if (!req.session.loggedIn) return res.sendStatus(401);
    await authColl.deleteMany({});
    if (sock) await sock.logout();
    currentUser = null;
    io.emit('disconnected');
    res.sendStatus(200);
});

// --- ROTAS DA API (CRUD KNOWLEDGE BASE) ---
app.get('/api/knowledgeColl', async (req, res) => {
    if (!req.session.loggedIn) return res.status(401).json([]);
    const docs = await knowledgeColl.find({}).toArray();
    res.json(docs);
});

app.post('/api/knowledgeColl', async (req, res) => {
    if (!req.session.loggedIn) return res.status(401).send("Acesso negado");
    const { pergunta, resposta } = req.body;
    await knowledgeColl.insertOne({ pergunta, resposta });
    res.sendStatus(201);
});

app.delete('/api/knowledgeColl/:id', async (req, res) => {
    if (!req.session.loggedIn) return res.status(401).send("Acesso negado");
    try {
        await knowledgeColl.deleteOne({ _id: new ObjectId(req.params.id) });
        res.sendStatus(200);
    } catch (e) {
        res.status(500).send("Erro ao deletar");
    }
});

// --- ROTAS DA API (CONFIGURAÇÕES / CHAVES) ---
app.get('/api/apiKeysColl', async (req, res) => {
    if (!req.session.loggedIn) return res.status(401).json([]);
    const keys = await apiKeysColl.find({}).toArray();
    res.json(keys);
});

app.post('/api/apiKeysColl', async (req, res) => {
    if (!req.session.loggedIn) return res.status(401).send("Acesso negado");
    const { nome, chave } = req.body;
    await apiKeysColl.updateOne({ nome }, { $set: { chave } }, { upsert: true });
    // Recarrega o Gemini se a chave for alterada
    if (nome === "gemini") {
        genAI = new GoogleGenerativeAI(chave);
        console.log("🔄 Gemini recarregado com nova chave.");
    }
    res.sendStatus(200);
});

// --- SOCKET.IO EVENTOS ---
io.on('connection', (socket) => {
    if (lastQr) socket.emit('qr', lastQr);
    if (currentUser) socket.emit('connected', currentUser);
});

// --- INICIALIZAÇÃO ---
server.listen(port, () => {
    console.log(`🚀 Servidor rodando em http://localhost:${port}`);
    startBot();
});