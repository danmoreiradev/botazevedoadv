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

// --- INICIALIZAÇÃO ---
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
    secret: 'azevedo-secret-key-2026',
    resave: false,
    saveUninitialized: false,
    store: store,
    cookie: { maxAge: 1000 * 60 * 60 * 24 }
}));

const mongoUri = process.env.MONGODB_URI;
const client = new MongoClient(mongoUri);

let sock;
let lastQr = null;
let currentUser = null;
let lastBotMessageId = null; 
let processing = new Set(); 
let genAI = null;

let ticketsColl, authColl, knowledgeColl, userLoginColl, apiKeysColl;

// --- FUNÇÃO DE ENVIO ---
async function sendBotMsg(jid, content) {
    try {
        const sent = await sock.sendMessage(jid, content);
        lastBotMessageId = sent.key.id; 
        return sent;
    } catch (err) { return null; }
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
            global.geminiModel = genAI.getGenerativeModel({ model: "gemini-3.1-flash-lite-preview" }, 
            { apiVersion: 'v1beta' });
        }

        const { state, saveCreds } = await useMongoDBAuthState(authColl);
        const { version } = await fetchLatestBaileysVersion();

        sock = makeWASocket({
            version,
            auth: state,
            logger: P({ level: 'silent' }),
            browser: ['Azevedo Advogados', 'Chrome', '1.0.0']
        });

        sock.ev.on('creds.update', saveCreds);

        sock.ev.on('messages.upsert', async m => {
            const msg = m.messages[0];
            if (!msg.message || msg.key.remoteJid === 'status@broadcast') return;

            const rawJid = msg.key.remoteJid;
            const cleanJid = jidNormalizedUser(rawJid); 
            const cleanNumber = cleanJid.split('@')[0];
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

                // Busca Ticket
                let ticket = await ticketsColl.findOne({
                    $or: [ { _id: numeroRealExtraido }, { cpf: isCpfValido ? cpfApenasNumeros : "NULL" } ]
                });

                // --- [LÓGICA: INTERVENÇÃO HUMANA] ---
                if (isMe) {
                    if (msgId !== lastBotMessageId && ticket) {
                        // Se VOCÊ mandou mensagem, o bot pausa por 3 dias para não atrapalhar
                        await ticketsColl.updateOne({ _id: ticket._id }, { 
                            $set: { 
                                paused: true, 
                                until: Date.now() + (3 * 24 * 60 * 60 * 1000), 
                                lastActivity: Date.now(), 
                                aguardandoIA: false,
                                aguardandoOpcao: false
                            } 
                        });
                        console.log(`👨‍⚖️ Intervenção humana detectada no CPF ${ticket.cpf}. Bot pausado.`);
                    }
                    return; 
                }

                // 1. PORTEIRO DE CPF (Acesso Restrito)
                if (!ticket || !ticket.cpf) {
                    if (!isCpfValido) {
                        await sendBotMsg(rawJid, { text: `Olá! Sou o assistente virtual do escritório Azevedo & Juvencio Advogados. ⚖️\n\nPara iniciarmos seu atendimento, por favor, informe seu **CPF** (apenas os 11 números):` });
                        await ticketsColl.updateOne({ _id: numeroRealExtraido }, { $set: { lastActivity: Date.now(), lastRawJid: rawJid } }, { upsert: true });
                        return;
                    } else {
                        const ticketExistente = await ticketsColl.findOne({ cpf: cpfApenasNumeros });
                        if (ticketExistente) {
                            await ticketsColl.deleteOne({ _id: numeroRealExtraido });
                            ticket = ticketExistente;
                            await ticketsColl.updateOne({ _id: ticket._id }, { 
                                $set: { _id: numeroRealExtraido, numeroReal: numeroRealExtraido, lastRawJid: rawJid, lastActivity: Date.now(), encerrado: false, aguardandoIA: true, paused: false } 
                            });
                            ticket._id = numeroRealExtraido;
                        } else {
                            await ticketsColl.updateOne({ _id: numeroRealExtraido }, {
                                $set: { cpf: cpfApenasNumeros, numeroReal: numeroRealExtraido, aguardandoIA: true, encerrado: false, lastActivity: Date.now(), lastRawJid: rawJid, paused: false }
                            }, { upsert: true });
                            await sendBotMsg(rawJid, { text: `CPF validado com sucesso! Como podemos ajudar você hoje?` });
                            return;
                        }
                    }
                }

                // Verifica se está pausado (Cadeado do Bot)
                if (ticket.paused && (Date.now() < ticket.until)) return;

                // Reabertura de Ticket Encerrado (após 1h)
                if (ticket.encerrado && (Date.now() - ticket.lastActivity > 60 * 60 * 1000)) {
                    await ticketsColl.updateOne({ _id: ticket._id }, { $set: { aguardandoIA: true, encerrado: false, lastActivity: Date.now() } });
                    await sendBotMsg(rawJid, { text: `Olá! Vi que retornou. Como posso ajudar o Sr(a) novamente?` });
                    return;
                }

                // 2. MOTOR DE IA (SEU PROMPT)
                if (ticket.aguardandoIA && genAI) {
                    try {
                        const docs = await knowledgeColl.find({}).toArray();
                        const contextText = docs.map(k => `P: ${k.pergunta}\nR: ${k.resposta}`).join('\n\n');
                        
                        const prompt = `Você é um assistente virtual do escritório Azevedo & Juvencio Advogados.
Base de conhecimento autorizada:
${contextText}

Mensagem do cliente: "${texto}"

Regras:
1. Se o cliente pedir para falar com atendente, advogado, humano ou se o assunto não existir na base de conhecimento, responda APENAS com a palavra: ESCALAR_ATENDIMENTO
2. Se a mensagem for claramente um lead automático de anúncios, responda APENAS com a palavra: LEAD_ANUNCIO
3. Se a pergunta puder ser respondida usando a base de conhecimento, responda de forma natural e prestativa.
4. Se o cliente agradecer e indicar que a dúvida foi resolvida (ex: "obrigado", "pode encerrar", "era só isso"), responda APENAS com a palavra: ENCERRAR_TICKET

Sua resposta:`;

                        const result = await global.geminiModel.generateContent(prompt);
                        const iaRes = result.response.text().trim();

                        if (iaRes.includes('ENCERRAR_TICKET')) {
                            await sendBotMsg(rawJid, { text: `O escritório Azevedo & Juvencio agradece. Ficamos à disposição! 👋` });
                            await ticketsColl.updateOne({ _id: ticket._id }, { $set: { aguardandoIA: false, encerrado: true, lastActivity: Date.now() } });
                            return;
                        }
                        if (iaRes.includes('LEAD_ANUNCIO')) {
                            await sendBotMsg(rawJid, { text: `Recebemos seu interesse! Um de nossos advogados entrará em contato em instantes para te auxiliar! 🤝` });
                            await ticketsColl.updateOne({ _id: ticket._id }, { $set: { aguardandoIA: false, paused: true, until: Date.now() + (48*60*60*1000) } });
                            return;
                        }
                        if (iaRes.includes('ESCALAR_ATENDIMENTO')) {
                            await sendBotMsg(rawJid, { text: `Para um suporte especializado, escolha uma opção:\n\n1️⃣ Direito Digital\n2️⃣ Direito Cível\n3️⃣ Direito do Consumidor\n4️⃣ Direito Imobiliário\n5️⃣ Direito Trabalhista\n6️⃣ Direito Empresarial\n7️⃣ Outros Assuntos\n8️⃣ Processo em andamento` });
                            await ticketsColl.updateOne({ _id: ticket._id }, { $set: { aguardandoIA: false, aguardandoOpcao: true } });
                            return;
                        }

                        await sendBotMsg(rawJid, { text: iaRes });
                        await ticketsColl.updateOne({ _id: ticket._id }, { $set: { lastActivity: Date.now() } });

                    } catch (e) {
                        // --- FALLBACK EM CASO DE ERRO NA API ---
                        await sendBotMsg(rawJid, { text: `Tivemos uma instabilidade no assistente. Digite o número da opção desejada:\n\n1️⃣ Direito Digital\n2️⃣ Direito Cível\n3️⃣ Direito do Consumidor\n4️⃣ Direito Imobiliário\n5️⃣ Direito Trabalhista\n6️⃣ Direito Empresarial\n7️⃣ Outros Assuntos\n8️⃣ Processo em andamento` });
                        await ticketsColl.updateOne({ _id: ticket._id }, { $set: { aguardandoIA: false, aguardandoOpcao: true } });
                    }
                    return;
                }

                // 3. MENU DE OPÇÕES (TRANSBORDO HUMANO)
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
                        await sendBotMsg(rawJid, { text: `${respostas[texto]}\n\nAguarde o contato de um advogado especialista.` });
                        await ticketsColl.updateOne({ _id: ticket._id }, { $set: { aguardandoOpcao: false, paused: true, until: Date.now() + (24*60*60*1000) } });
                    } else {
                        await sendBotMsg(rawJid, { text: `Opção inválida. Digite de 1 a 8.` });
                    }
                    return;
                }

            } catch (err) { console.error("Erro Mensagem:", err); }
        });

        sock.ev.on('connection.update', (update) => {
            const { connection, lastDisconnect, qr } = update;
            if (qr) { lastQr = qr; io.emit('qr', qr); }
            if (connection === 'open') {
                currentUser = { number: sock.user.id.split(':')[0], name: 'Azevedo e Juvencio' };
                io.emit('connected', currentUser);
            }
            if (connection === 'close') {
                if ((lastDisconnect.error instanceof Boom)?.output?.statusCode !== DisconnectReason.loggedOut) startBot();
            }
        });

    } catch (err) { setTimeout(startBot, 5000); }
}

// --- ROTAS DO PAINEL ---
app.get('/login', (req, res) => res.sendFile(path.join(__dirname, 'login.html')));
app.post('/login', async (req, res) => {
    const { user, pass } = req.body;
    const admin = await userLoginColl.findOne({ user, pass });
    if (admin) { req.session.loggedIn = true; res.redirect('/'); }
    else res.send("<script>alert('Erro'); window.location='/login';</script>");
});
app.get('/', (req, res) => req.session.loggedIn ? res.sendFile(path.join(__dirname, 'index.html')) : res.redirect('/login'));
app.get('/logout-panel', (req, res) => req.session.destroy(() => res.redirect('/login')));
app.get('/logout-whatsapp', async (req, res) => {
    await authColl.deleteMany({});
    if (sock) await sock.logout();
    currentUser = null; io.emit('disconnected');
    res.sendStatus(200);
});

// APIs Conhecimento
app.get('/api/knowledgeColl', async (req, res) => {
    if (!req.session.loggedIn) return res.sendStatus(401);
    const data = await knowledgeColl.find({}).toArray();
    res.json(data);
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