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
let genAI = null; 
let apiKeysColl;

const app = express();
const server = http.createServer(app);
const io = new Server(server);
const port = process.env.PORT || 10000;

app.use(express.json());
app.use(express.urlencoded({ extended: true }));
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
        
        apiKeysColl = db.collection('api_keys');
        const geminiKeyDoc = await apiKeysColl.findOne({ nome: "gemini" });
        
        if (geminiKeyDoc && geminiKeyDoc.chave) {
            genAI = new GoogleGenerativeAI(geminiKeyDoc.chave);
            global.geminiModel = genAI.getGenerativeModel(
                { model: "gemini-2.5-flash" }, 
                { apiVersion: 'v1beta' } 
            );
            console.log("✅ Sistema Gemini pronto e estável.");
        }

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
            // jidNormalizedUser remove o :device automaticamente (@s.whatsapp.net ou @lid)
            const cleanJid = jidNormalizedUser(rawJid); 
            
            // --- PADRONIZAÇÃO DO ID (A SOLUÇÃO) ---
            // Pegamos apenas os números antes de qualquer @ ou :
            let numeroRealExtraido = cleanJid.split('@')[0].split(':')[0];

            // Se for um LID, tentamos pegar o número real do participante (comum em multi-device)
            if (rawJid.includes('@lid')) {
                const vnumber = msg.key.participant || msg.participant || rawJid;
                numeroRealExtraido = (vnumber.split('@')[0]).split(':')[0];
            }

            const isMe = msg.key.fromMe;
            const msgId = msg.key.id;

            if (processing.has(msgId)) return;
            processing.add(msgId);
            setTimeout(() => processing.delete(msgId), 10000);

            const tresDiasEmMs = 3 * 24 * 60 * 60 * 1000;
            const blockUntil = Date.now() + tresDiasEmMs;

            try {
                // 1. BUSCA O TICKET (Sempre pelo ID limpo)
                let ticket = await ticketsColl.findOne({ _id: numeroRealExtraido });

                // 2. LOGICA DE INTERVENÇÃO HUMANA
                if (isMe) {
                    if (msgId !== lastBotMessageId) {
                        console.log(`[Intervenção] Humano detectado para ${numeroRealExtraido}.`);
                        
                        await ticketsColl.updateOne(
                            { _id: numeroRealExtraido }, 
                            { 
                                $set: { 
                                    paused: true, 
                                    until: blockUntil, 
                                    lastActivity: Date.now(),
                                    aguardandoIA: false,
                                    aguardandoOpcao: false,
                                    obrigadoEnviado: true,
                                    numeroReal: numeroRealExtraido,
                                    lastRawJid: rawJid
                                },
                                $setOnInsert: {
                                    id: Math.floor(1000 + Math.random() * 9000)
                                }
                            }, 
                            { upsert: true }
                        );
                    }
                    return; 
                }

                // 3. VERIFICAÇÃO DE PAUSA ATIVA
                if (ticket && ticket.paused) {
                    if (Date.now() < ticket.until) {
                        return;
                    } else {
                        await ticketsColl.updateOne({ _id: numeroRealExtraido }, { $set: { paused: false, lastRawJid: rawJid } });
                        ticket.paused = false;
                    }
                }

                const textoRaw = msg.message.conversation || msg.message.extendedTextMessage?.text || "";
                const texto = textoRaw.trim();
                const timeoutMenu = 2 * 60 * 60 * 1000; 

                // 4. CRIAÇÃO OU REABERTURA
                if (!ticket || (Date.now() - (ticket.lastActivity || 0) > timeoutMenu)) {
                    const ticketId = Math.floor(1000 + Math.random() * 9000);
                    const textoLower = texto.toLowerCase();
                    const isLead = textoLower.includes("gostaria de saber mais") || textoLower.includes("vi no facebook") || textoLower.includes("anúncio");

                    if (isLead) {
                        await sendBotMsg(rawJid, { text: `✅ Recebido! Um especialista assumirá o seu caso em breve.` });
                        await ticketsColl.updateOne(
                            { _id: numeroRealExtraido },
                            {
                                $set: { 
                                    id: ticketId, numeroReal: numeroRealExtraido,
                                    aguardandoOpcao: false, aguardandoIA: false, 
                                    obrigadoEnviado: true, paused: true, until: blockUntil,
                                    lastActivity: Date.now(), lastRawJid: rawJid
                                }
                            }, { upsert: true });
                        return;
                    }

                    await sendBotMsg(rawJid, { 
                        text: `Olá, sou o assistente do escritório de Advogados: Azevedo & Juvencio. O que podemos te ajudar hoje?` 
                    });

                    await ticketsColl.updateOne(
                        { _id: numeroRealExtraido },
                        {
                            $set: { 
                                id: ticketId, 
                                numeroReal: numeroRealExtraido, 
                                aguardandoIA: true, 
                                aguardandoOpcao: false, 
                                obrigadoEnviado: false, 
                                tentouInsistir: false,
                                lastActivity: Date.now(), 
                                paused: false,
                                lastRawJid: rawJid 
                            }
                        }, { upsert: true });
                    return;
                }

                // 5. ATUALIZA ATIVIDADE E EVITA DUPLICIDADE DE LID
                await ticketsColl.updateOne(
                    { _id: numeroRealExtraido }, 
                    { $set: { lastRawJid: rawJid, lastActivity: Date.now() } }
                );
                
                // Recarrega o ticket atualizado
                ticket = await ticketsColl.findOne({ _id: numeroRealExtraido });

                // --- LÓGICA DE IA ---
                if (ticket.aguardandoIA) {
                    const textoLower = texto.toLowerCase();
                    const isLead = textoLower.includes("gostaria de saber mais") || textoLower.includes("vi no facebook") || textoLower.includes("anúncio");

                    if (isLead) {
                        await sendBotMsg(rawJid, { text: `✅ Recebido! Um especialista assumirá o seu caso em breve.` });
                        await ticketsColl.updateOne({ _id: numeroRealExtraido }, { $set: { aguardandoIA: false, obrigadoEnviado: true, paused: true, until: blockUntil } });
                        return;
                    }

                    if (genAI) {
                        try {
                            const knowledgeDocs = await knowledgeColl.find({}).toArray();
                            const contextText = knowledgeDocs.map(k => `Pergunta: ${k.pergunta}\nResposta: ${k.resposta}`).join('\n\n');

                            const prompt = `Você é um assistente virtual do escritório Azevedo & Juvencio Advogados.
Base de conhecimento autorizada:
${contextText}

Mensagem do cliente: "${texto}"

Regras:
1. Se o cliente pedir para falar com atendente, advogado, humano ou se o assunto não existir na base de conhecimento, responda APENAS com a palavra: ESCALAR_ATENDIMENTO
2. Se a mensagem for claramente um lead automático de anúncios, responda APENAS com a palavra: LEAD_ANUNCIO
3. Se a pergunta puder ser respondida usando a base de conhecimento, responda de forma natural e prestativa.`;

                            const model = genAI.getGenerativeModel(
                                { model: "gemini-2.5-flash" }, 
                                { apiVersion: 'v1beta' } 
                            );
                            const result = await model.generateContent(prompt);
                            const iaResponse = result.response.text().trim();

                            if (iaResponse === 'LEAD_ANUNCIO') {
                                await sendBotMsg(rawJid, { text: `✅ Recebido! Já encaminhei seu caso para um especialista, ele assumirá seu atendimento em breve.` });
                                await ticketsColl.updateOne({_id: numeroRealExtraido }, { $set: { aguardandoIA: false, obrigadoEnviado: true, paused: true, until: blockUntil } });
                                return;
                            } 
                            
                            if (iaResponse === 'ESCALAR_ATENDIMENTO') {
                                await sendBotMsg(rawJid, {
                                    text: `Certo! Vou transferir você. Digite o número da opção desejada:\n\n1️⃣ Direito Digital\n2️⃣ Direito Cível\n3️⃣ Direito do Consumidor\n4️⃣ Direito Imobiliário\n5️⃣ Direito Trabalhista\n6️⃣ Direito Empresarial\n7️⃣ Outros Assuntos\n8️⃣ Processo em andamento`
                                });
                                await ticketsColl.updateOne({ _id: numeroRealExtraido }, { $set: { aguardandoIA: false, aguardandoOpcao: true } });
                                return;
                            }

                            await sendBotMsg(rawJid, { text: `${iaResponse}\n\nPodemos te ajudar em algo a mais?` });
                            return; 

                        } catch (iaError) {
                            console.error("Erro Gemini:", iaError);
                            await sendBotMsg(rawJid, {
                                text: `Tivemos uma instabilidade no assistente. Digite o número da opção desejada:\n\n1️⃣ Direito Digital\n2️⃣ Direito Cível\n3️⃣ Direito do Consumidor\n4️⃣ Direito Imobiliário\n5️⃣ Direito Trabalhista\n6️⃣ Direito Empresarial\n7️⃣ Outros Assuntos\n8️⃣ Processo em andamento`
                            });
                            await ticketsColl.updateOne({ _id: numeroRealExtraido }, { $set: { aguardandoIA: false, aguardandoOpcao: true } });
                            return;
                        }
                    }
                }

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
                        await sendBotMsg(rawJid, { text: `Você escolheu a opção ${texto}. Um especialista já foi notificado e falará com você em instantes.` });
                        await ticketsColl.updateOne({ _id: numeroRealExtraido }, { $set: { aguardandoOpcao: false, obrigadoEnviado: true, paused: true, until: blockUntil } });
                    } else {
                        const novosErros = (ticket.errosMenu || 0) + 1;
                        if (novosErros >= 2) {
                            await sendBotMsg(rawJid, { text: `✅ Entendido. Já vamos encaminhar você para o especialista, aguarde um momento.` });
                            await ticketsColl.updateOne({ _id: numeroRealExtraido }, { $set: { aguardandoOpcao: false, obrigadoEnviado: true, paused: true, until: blockUntil } });
                        } else {
                            await sendBotMsg(rawJid, { text: `⚠️ Opção inválida. Por favor, digite apenas o número (1 a 8).` });
                            await ticketsColl.updateOne({ _id: numeroRealExtraido}, { $set: { errosMenu: novosErros } });
                        }
                    }
                    return;
                }

                if (!ticket.aguardandoOpcao && !ticket.obrigadoEnviado) {
                    const isMedia = !!(msg.message.imageMessage || msg.message.documentMessage || msg.message.audioMessage);
                    if (texto.length >= 20 || isMedia) {
                        await sendBotMsg(rawJid, { text: `✅ Recebido! Um especialista já vai atendê-lo, aguarde um momento.` });
                        await ticketsColl.updateOne({ _id: numeroRealExtraido }, { $set: { obrigadoEnviado: true, paused: true, until: blockUntil } });
                    } else if (!ticket.tentouInsistir) {
                        await sendBotMsg(rawJid, { text: `⚠️ Por favor, descreva a situação com um pouco mais de detalhes para facilitar a análise.` });
                        await ticketsColl.updateOne({ _id: numeroRealExtraido }, { $set: { tentouInsistir: true } });
                    } else {
                        await sendBotMsg(rawJid, { text: `✅ Recebido! Já encaminhei seu caso para um especialista.` });
                        await ticketsColl.updateOne({ _id: numeroRealExtraido }, { $set: { obrigadoEnviado: true, paused: true, until: blockUntil } });
                    }
                }

            } catch (err) {
                console.error("Erro interno:", err);
            }
        });

        sock.ev.on('connection.update', async (update) => {
            const { connection, lastDisconnect, qr } = update;
            if (qr) { lastQr = qr; io.emit('qr', qr); }
            if (connection === 'open') {
                lastQr = null;
                const userNumber = sock.user.id.split(':')[0];
                currentUser = { number: userNumber, name: 'Azevedo e Juvencio', pic: null };
                io.emit('connected', currentUser);
            }
            if (connection === 'close') {
                const shouldReconnect = (lastDisconnect.error instanceof Boom)?.output?.statusCode !== DisconnectReason.loggedOut;
                if (shouldReconnect) startBot();
                else { currentUser = null; io.emit('disconnected'); }
            }
        });

    } catch (err) { 
        console.error("Erro crítico:", err);
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

app.get('/login', (req, res) => res.sendFile(path.join(__dirname, 'login.html')));
app.post('/login', async (req, res) => {
    const { user, pass } = req.body;
    try {
        const adminAccount = await userLoginColl.findOne({ user });
        if (adminAccount && adminAccount.pass === pass) {
            req.session.loggedIn = true;
            res.redirect('/');
        } else res.send("<script>alert('Erro'); window.location='/login';</script>");
    } catch (e) { res.status(500).send("Erro"); }
});

app.get('/', (req, res) => {
    if (!req.session.loggedIn) return res.redirect('/login');
    res.sendFile(path.join(__dirname, 'index.html'));
});

app.get('/logout-panel', (req, res) => {
    req.session.destroy(() => { res.redirect('/login'); });
});

app.get('/logout-whatsapp', async (req, res) => {
    try {
        await authColl.deleteMany({});
        if (sock) await sock.logout();
        currentUser = null; lastQr = null;
        io.emit('disconnected');
        res.sendStatus(200);
    } catch (err) { res.status(500).send("Erro"); }
});

app.get('/api/knowledgeColl', async (req, res) => {
    if (!req.session.loggedIn) return res.status(401).send("Acesso negado");
    const data = await knowledgeColl.find({}).sort({ updatedAt: -1 }).toArray();
    res.json(data);
});

app.post('/api/knowledgeColl', async (req, res) => {
    if (!req.session.loggedIn) return res.status(401).send("Acesso negado");
    const { pergunta, resposta } = req.body;
    await knowledgeColl.updateOne({ pergunta }, { $set: { pergunta, resposta, updatedAt: Date.now() } }, { upsert: true });
    res.sendStatus(200);
});

app.delete('/api/knowledgeColl/:id', async (req, res) => {
    if (!req.session.loggedIn) return res.status(401).send("Acesso negado");
    try {
        const { id } = req.params;
        const result = await knowledgeColl.deleteOne({ _id: new ObjectId(id) });
        res.sendStatus(result.deletedCount === 1 ? 200 : 404);
    } catch (err) { res.status(500).send("Erro interno"); }
});

setInterval(async () => {
    try {
        const host = process.env.RENDER_EXTERNAL_HOSTNAME || `localhost:${port}`;
        const protocol = host.includes('localhost') ? 'http' : 'https';
        await axios.get(`${protocol}://${host}/`);
    } catch (e) {}
}, 5 * 60 * 1000);

io.on('connection', (socket) => {
    if (currentUser) socket.emit('connected', currentUser);
    else if (lastQr) socket.emit('qr', lastQr);
});

server.listen(port, () => startBot());