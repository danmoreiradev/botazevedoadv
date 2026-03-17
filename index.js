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
const session = require('express-session');
const { GoogleGenerativeAI } = require('@google/generative-ai');

// --- CONFIGURAÇÃO DO SERVIDOR WEB ---
const app = express();
const server = http.createServer(app);
const io = new Server(server);
const port = process.env.PORT || 10000;

app.use(express.json());
app.use(express.urlencoded({ extended: true }));

const MongoDBStore = require('connect-mongodb-session')(session);
const store = new MongoDBStore({ uri: process.env.MONGODB_URI, collection: 'sessions' });
app.use(session({
    secret: 'azevedo-secret-key-2026',
    resave: false,
    saveUninitialized: false,
    store: store,
    cookie: { maxAge: 1000 * 60 * 60 * 24 }
}));

const mongoUri = process.env.MONGODB_URI;
const client = new MongoClient(mongoUri);

let sock;
let lastBotMessageId = null; 
let processing = new Set(); 
let genAI = null;
let ticketsColl, authColl, knowledgeColl, userLoginColl, apiKeysColl;

async function sendBotMsg(jid, content) {
    try {
        const sent = await sock.sendMessage(jid, content);
        lastBotMessageId = sent.key.id; 
        return sent;
    } catch (err) { 
        console.error("Erro no envio:", err);
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
        apiKeysColl = db.collection('api_keys');

        console.log("✅ Banco MongoDB Conectado");

        const geminiKeyDoc = await apiKeysColl.findOne({ nome: "gemini" });
        if (geminiKeyDoc && geminiKeyDoc.chave) {
            genAI = new GoogleGenerativeAI(geminiKeyDoc.chave);
            global.geminiModel = genAI.getGenerativeModel({ model: "gemini-1.5-flash" });
        }

        const { state, saveCreds } = await useMongoDBAuthState(authColl);
        const { version } = await fetchLatestBaileysVersion();

        sock = makeWASocket({
            version,
            auth: state,
            logger: P({ level: 'silent' }),
            browser: ['Azevedo Advogados', 'Chrome', '1.0.0'],
            getNextPreKeyId: () => Math.floor(Math.random() * 10000)
        });

        sock.ev.on('creds.update', saveCreds);

        sock.ev.on('messages.upsert', async m => {
            const msg = m.messages[0];
            if (!msg.message || msg.key.remoteJid === 'status@broadcast') return;

            const rawJid = msg.key.remoteJid;
            const cleanNumber = jidNormalizedUser(rawJid).split('@')[0];
            const isMe = msg.key.fromMe;
            const msgId = msg.key.id;

            let numeroRealExtraido = cleanNumber;
            if (rawJid.includes('@lid')) {
                const vnumber = msg.key.participant || msg.participant || rawJid;
                numeroRealExtraido = (vnumber.split('@')[0]).split(':')[0];
            }

            if (processing.has(msgId)) return;
            processing.add(msgId);
            setTimeout(() => processing.delete(msgId), 10000);

            try {
                const textoRaw = msg.message.conversation || msg.message.extendedTextMessage?.text || "";
                const texto = textoRaw.trim();
                const cpfApenasNumeros = texto.replace(/\D/g, '');
                const isCpfValido = cpfApenasNumeros.length === 11;
                const blockUntil = Date.now() + (3 * 24 * 60 * 60 * 1000);

                // Busca inicial do ticket
                let ticket = await ticketsColl.findOne({
                    $or: [ { _id: numeroRealExtraido }, { cpf: isCpfValido ? cpfApenasNumeros : "NULL" } ]
                });

                // 1. INTERVENÇÃO HUMANA
                if (isMe) {
                    if (msgId !== lastBotMessageId && ticket) {
                        await ticketsColl.updateOne({ _id: ticket._id }, { 
                            $set: { paused: true, until: blockUntil, lastActivity: Date.now(), aguardandoIA: false, aguardandoOpcao: false } 
                        });
                    }
                    return; 
                }

                // 2. PORTEIRO DE CPF E UNIFICAÇÃO (CORRIGIDO)
                if (!ticket || !ticket.cpf) {
                    if (!isCpfValido) {
                        await sendBotMsg(rawJid, { text: `Olá! Sou o assistente virtual do escritório Azevedo & Juvencio Advogados. ⚖️\n\nPara iniciarmos seu atendimento, informe seu **CPF** (apenas os 11 números):` });
                        await ticketsColl.updateOne({ _id: numeroRealExtraido }, { $set: { lastActivity: Date.now(), lastRawJid: rawJid } }, { upsert: true });
                        return;
                    } else {
                        const ticketExistente = await ticketsColl.findOne({ cpf: cpfApenasNumeros });
                        
                        if (ticketExistente) {
                            // Se o ticket já existe mas com ID diferente, removemos o antigo para criar o novo (unificação)
                            await ticketsColl.deleteOne({ _id: ticketExistente._id });
                            await ticketsColl.deleteOne({ _id: numeroRealExtraido }); // Limpa lixo temporário se houver

                            const novoTicket = {
                                _id: numeroRealExtraido,
                                cpf: cpfApenasNumeros,
                                numeroReal: numeroRealExtraido,
                                lastRawJid: rawJid,
                                lastActivity: Date.now(),
                                encerrado: false,
                                aguardandoIA: true,
                                paused: false,
                                obrigadoEnviado: false,
                                tentouInsistir: false,
                                errosMenu: 0
                            };
                            await ticketsColl.insertOne(novoTicket);
                            ticket = novoTicket; // Atualiza a referência local

                            await sendBotMsg(rawJid, { text: `✅ CPF localizado! Já identifiquei seu atendimento anterior em nosso sistema.\n\nComo o escritório Azevedo & Juvencio pode ajudar você hoje?` });
                        } else {
                            // Cadastro novo
                            await ticketsColl.updateOne({ _id: numeroRealExtraido }, {
                                $set: { 
                                    cpf: cpfApenasNumeros, 
                                    numeroReal: numeroRealExtraido, 
                                    aguardandoIA: true, 
                                    encerrado: false, 
                                    lastActivity: Date.now(), 
                                    lastRawJid: rawJid, 
                                    paused: false, 
                                    obrigadoEnviado: false 
                                }
                            }, { upsert: true });
                            await sendBotMsg(rawJid, { text: `✅ CPF validado com sucesso! Como o escritório Azevedo & Juvencio pode ajudar você hoje?` });
                        }
                        return;
                    }
                }

                // CADEADO DE PAUSA (Bloqueia o bot se estiver em atendimento humano)
                if (ticket.paused && (Date.now() < ticket.until)) {
                    console.log(`⏸️ Bot pausado para o CPF ${ticket.cpf}`);
                    return;
                }

                // 3. MOTOR IA
                if (ticket.aguardandoIA && genAI) {
                    try {
                        const docs = await knowledgeColl.find({}).toArray();
                        const contextText = docs.map(k => `P: ${k.pergunta}\nR: ${k.resposta}`).join('\n\n');
                        const prompt = `Você é um assistente virtual da Azevedo & Juvencio Advogados.\nBase:\n${contextText}\n\nCliente: "${texto}"\n\nRegras:\n1. Fora da base/atendente: ESCALAR_ATENDIMENTO\n2. Lead: LEAD_ANUNCIO\n3. Resolvido: ENCERRAR_TICKET\n\nResposta:`;

                        const result = await global.geminiModel.generateContent(prompt);
                        const iaRes = result.response.text().trim();

                        if (iaRes.includes('ENCERRAR_TICKET')) {
                            await sendBotMsg(rawJid, { text: `Azevedo & Juvencio agradece seu contato. Tenha um excelente dia! 👋` });
                            await ticketsColl.updateOne({ _id: ticket._id }, { $set: { aguardandoIA: false, encerrado: true, lastActivity: Date.now() } });
                            return;
                        }
                        if (iaRes.includes('LEAD_ANUNCIO')) {
                            await sendBotMsg(rawJid, { text: `Recebemos seu interesse! Um especialista jurídico entrará em contato em instantes! 🤝` });
                            await ticketsColl.updateOne({ _id: ticket._id }, { $set: { aguardandoIA: false, paused: true, until: Date.now() + (48*60*60*1000) } });
                            return;
                        }
                        if (iaRes.includes('ESCALAR_ATENDIMENTO')) {
                            await sendBotMsg(rawJid, { text: `Para que possamos te ajudar com precisão, escolha uma das opções abaixo:\n\n1️⃣ Direito Digital\n2️⃣ Direito Cível\n3️⃣ Direito do Consumidor\n4️⃣ Direito Imobiliário\n5️⃣ Direito Trabalhista\n6️⃣ Direito Empresarial\n7️⃣ Outros Assuntos\n8️⃣ Processo em andamento` });
                            await ticketsColl.updateOne({ _id: ticket._id }, { $set: { aguardandoIA: false, aguardandoOpcao: true, errosMenu: 0 } });
                            return;
                        }

                        await sendBotMsg(rawJid, { text: iaRes });
                        await ticketsColl.updateOne({ _id: ticket._id }, { $set: { lastActivity: Date.now() } });
                        return;

                    } catch (e) {
                        await sendBotMsg(rawJid, { text: `Escolha uma opção para prosseguirmos:\n\n1️⃣ Direito Digital\n2️⃣ Direito Cível\n3️⃣ Direito do Consumidor\n4️⃣ Direito Imobiliário\n5️⃣ Direito Trabalhista\n6️⃣ Direito Empresarial\n7️⃣ Outros Assuntos\n8️⃣ Processo em andamento` });
                        await ticketsColl.updateOne({ _id: ticket._id }, { $set: { aguardandoIA: false, aguardandoOpcao: true, errosMenu: 0 } });
                        return;
                    }
                }

                // 4. RESPOSTA ÀS OPÇÕES
                const respostasMenu = {
                    '1': '⚖️ Direito Digital: Entendido. Por favor, envie um resumo do ocorrido e eventuais provas.',
                    '2': '⚖️ Direito Cível: Certo. Nossa equipe cível analisará sua mensagem em breve.',
                    '3': '⚖️ Direito do Consumidor: Registrado. Informe a empresa e o problema enfrentado.',
                    '4': '⚖️ Direito Imobiliário: Compreendido. Um especialista jurídico falará com você.',
                    '5': '⚖️ Direito Trabalhista: Certo. Informe se você ainda possui vínculo com a empresa.',
                    '6': '⚖️ Direito Empresarial: Setor Empresarial notificado. Por favor, aguarde o contato.',
                    '7': '⚖️ Outros Assuntos: Descreva seu caso com detalhes para direcionarmos corretamente.',
                    '8': '⚖️ Processo em andamento: Informe o número do processo ou o nome completo das partes.'
                };

                if (ticket.aguardandoOpcao) {
                    if (respostasMenu[texto]) {
                        await sendBotMsg(rawJid, { text: respostasMenu[texto] });
                        await ticketsColl.updateOne({ _id: ticket._id }, { $set: { aguardandoOpcao: false, errosMenu: 0, lastActivity: Date.now() } });
                    } else {
                        const novosErros = (ticket.errosMenu || 0) + 1;
                        if (novosErros >= 2) {
                            await sendBotMsg(rawJid, { text: `✅ Entendido. Já vamos encaminhar você para o especialista, aguarde um momento.` });
                            await ticketsColl.updateOne({ _id: ticket._id }, { $set: { aguardandoOpcao: false, obrigadoEnviado: true, paused: true, until: blockUntil } });
                        } else {
                            await sendBotMsg(rawJid, { text: `⚠️ Opção inválida. Digite apenas o número (1 a 8).` });
                            await ticketsColl.updateOne({ _id: ticket._id }, { $set: { errosMenu: novosErros } });
                        }
                    }
                    return;
                }

                // 5. LÓGICA DE INSISTÊNCIA
                if (!ticket.aguardandoOpcao && !ticket.obrigadoEnviado) {
                    const isMedia = !!(msg.message.imageMessage || msg.message.documentMessage || msg.message.audioMessage);
                    
                    if (texto.length >= 20 || isMedia) {
                        await sendBotMsg(rawJid, { text: `✅ Recebido! Um especialista da Azevedo & Juvencio já vai atendê-lo.` });
                        await ticketsColl.updateOne({ _id: ticket._id }, { $set: { obrigadoEnviado: true, paused: true, until: blockUntil } });
                    } else if (!ticket.tentouInsistir) {
                        await sendBotMsg(rawJid, { text: `⚠️ Por favor, descreva a situação com um pouco mais de detalhes para facilitar nossa análise.` });
                        await ticketsColl.updateOne({ _id: ticket._id }, { $set: { tentouInsistir: true } });
                    } else {
                        await sendBotMsg(rawJid, { text: `✅ Recebido! Já encaminhei seu caso para análise interna.` });
                        await ticketsColl.updateOne({ _id: ticket._id }, { $set: { obrigadoEnviado: true, paused: true, until: blockUntil } });
                    }
                }

            } catch (err) { console.error("Erro Fluxo:", err); }
        });

        sock.ev.on('connection.update', (upd) => {
            const { connection, lastDisconnect, qr } = upd;
            if (qr) io.emit('qr', qr);
            if (connection === 'open') io.emit('connected', { number: sock.user.id.split(':')[0] });
            if (connection === 'close') {
                const code = (lastDisconnect.error instanceof Boom)?.output?.statusCode;
                if (code !== DisconnectReason.loggedOut) startBot();
            }
        });

    } catch (err) { setTimeout(startBot, 5000); }
}

// --- ROTAS DO PAINEL ADMIN ---
app.get('/login', (req, res) => res.sendFile(path.join(__dirname, 'login.html')));
app.post('/login', async (req, res) => {
    const admin = await userLoginColl.findOne({ user: req.body.user, pass: req.body.pass });
    if (admin) { req.session.loggedIn = true; res.redirect('/'); }
    else res.send("<script>alert('Credenciais Inválidas'); window.location='/login';</script>");
});
app.get('/', (req, res) => req.session.loggedIn ? res.sendFile(path.join(__dirname, 'index.html')) : res.redirect('/login'));
app.get('/logout-panel', (req, res) => req.session.destroy(() => res.redirect('/login')));
app.get('/logout-whatsapp', async (req, res) => {
    if (!req.session.loggedIn) return res.sendStatus(401);
    await authColl.deleteMany({}); if (sock) await sock.logout();
    io.emit('disconnected'); res.sendStatus(200);
});

// APIs DO PAINEL
app.get('/api/knowledgeColl', async (req, res) => {
    if (!req.session.loggedIn) return res.sendStatus(401);
    res.json(await knowledgeColl.find({}).toArray());
});
app.post('/api/knowledgeColl', async (req, res) => {
    if (!req.session.loggedIn) return res.sendStatus(401);
    const { pergunta, resposta } = req.body;
    await knowledgeColl.updateOne({ pergunta }, { $set: { pergunta, resposta, updatedAt: Date.now() } }, { upsert: true });
    res.sendStatus(200);
});
app.delete('/api/knowledgeColl/:id', async (req, res) => {
    if (!req.session.loggedIn) return res.sendStatus(401);
    await knowledgeColl.deleteOne({ _id: new ObjectId(req.params.id) });
    res.sendStatus(200);
});

async function useMongoDBAuthState(collection) {
    const writeData = (data, id) => collection.replaceOne({ _id: id }, JSON.parse(JSON.stringify(data, BufferJSON.replacer)), { upsert: true });
    const readData = async (id) => {
        const data = await collection.findOne({ _id: id });
        return data ? JSON.parse(JSON.stringify(data), BufferJSON.reviver) : null;
    };
    const removeData = (id) => collection.deleteOne({ _id: id });
    const creds = await readData('creds') || initAuthCreds();
    return {
        state: { creds, keys: {
            get: async (type, ids) => {
                const data = {};
                await Promise.all(ids.map(async id => { data[id] = await readData(`${type}-${id}`); }));
                return data;
            },
            set: async (data) => {
                for (const type in data) {
                    for (const id in data[type]) {
                        const value = data[type][id];
                        if (value) await writeData(value, `${type}-${id}`);
                        else await removeData(`${type}-${id}`);
                    }
                }
            }
        }},
        saveCreds: () => writeData(creds, 'creds')
    };
}

server.listen(port, () => startBot());