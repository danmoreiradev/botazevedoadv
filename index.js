const { 
    default: makeWASocket, 
    DisconnectReason, 
    fetchLatestBaileysVersion, 
    BufferJSON, 
    initAuthCreds 
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
let processing = new Set(); // Evita processamento duplicado ultra-rápido

let ticketsColl, authColl, knowledgeColl, userLoginColl;

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
            const cleanNumber = (rawJid.split('@')[0]).split(':')[0]; 
            const isMe = msg.key.fromMe;
            const msgId = msg.key.id;

            // Evita duplicidade
            if (processing.has(msgId)) return;
            processing.add(msgId);
            setTimeout(() => processing.delete(msgId), 10000);

            const blockUntil = Date.now() + (3 * 24 * 60 * 60 * 1000);

            try {
                // --- LÓGICA DE INTERVENÇÃO MANUAL (CELULAR OU WEB) ---
                if (isMe) {
                    // Se a mensagem enviada NÃO foi o bot (ID diferente do último gravado)
                    if (msgId !== lastBotMessageId) {
                        console.log(`[Intervenção Manual] Detectada em ${cleanNumber}. Travando bot por 3 dias.`);
                        
                        await ticketsColl.updateOne(
                            { _id: cleanNumber }, 
                            { 
                                $set: { 
                                    paused: true, 
                                    until: blockUntil, 
                                    lastActivity: Date.now() 
                                } 
                            }, 
                            { upsert: true }
                        );
                    }
                    return; 
                }

                // --- LÓGICA PARA MENSAGENS RECEBIDAS (CLIENTE) ---
                const ticket = await ticketsColl.findOne({ _id: cleanNumber });

                // Verifica se o bot está pausado para este cliente
                if (ticket && ticket.paused) {
                    if (Date.now() < ticket.until) {
                        console.log(`[Bot Pausado] Ignorando mensagem de ${cleanNumber}`);
                        return;
                    } else {
                        // Se o tempo de 3 dias expirou, libera o bot
                        await ticketsColl.updateOne({ _id: cleanNumber }, { $set: { paused: false } });
                    }
                }

                const textoRaw = msg.message.conversation || msg.message.extendedTextMessage?.text || "";
                const texto = textoRaw.trim();
                const timeoutMenu = 2 * 60 * 60 * 1000; 

                // 1. GERAÇÃO DE TICKET / MENU INICIAL
                // Se não existe ticket ou se a última atividade foi há mais de 2 horas
                if (!ticket || (Date.now() - (ticket.lastActivity || 0) > timeoutMenu)) {
                    const ticketId = Math.floor(1000 + Math.random() * 9000);
                    
                    // Dispara a mensagem e grava o ID dela imediatamente
                    const sent = await sock.sendMessage(rawJid, { 
                        text: `Olá! 👋 Bem-vindo(a) ao *Azevedo e Juvencio Advogados* ⚖️\n🎫 Atendimento: *${ticketId}*\n\nDigite o número da opção desejada:\n\n1️⃣ Direito Digital\n2️⃣ Direito Cível\n3️⃣ Direito do Consumidor\n4️⃣ Direito Imobiliário\n5️⃣ Direito Trabalhista\n6️⃣ Direito Empresarial\n7️⃣ Outros Assuntos\n8️⃣ Processo em andamento` 
                    });
                    
                    // GRAVAÇÃO ESSENCIAL: Impede que o bot trave a si mesmo na próxima iteração
                    lastBotMessageId = sent.key.id;

                    await ticketsColl.updateOne({ _id: cleanNumber }, {
                        $set: { 
                            id: ticketId, 
                            aguardandoOpcao: true, 
                            obrigadoEnviado: false, 
                            lastActivity: Date.now(), 
                            paused: false,
                            lastRawJid: rawJid 
                        }
                    }, { upsert: true });
                    return;
                }

                // Atualiza atividade em segundo plano
                ticketsColl.updateOne({ _id: cleanNumber }, { $set: { lastActivity: Date.now() } });

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

                // 2. RESPOSTA ÀS OPÇÕES
                if (ticket.aguardandoOpcao) {
                    if (respostas[texto]) {
                        sendBotMsg(rawJid, { text: respostas[texto] });
                        await ticketsColl.updateOne({ _id: cleanNumber }, { $set: { aguardandoOpcao: false, errosMenu: 0 } });
                    } else {
                        const novosErros = (ticket.errosMenu || 0) + 1;
                        if (novosErros >= 2) {
                            sendBotMsg(rawJid, { text: `✅ Entendido. Já vamos encaminhar você para o especialista, aguarde um momento.` });
                            await ticketsColl.updateOne({ _id: cleanNumber }, { $set: { aguardandoOpcao: false, obrigadoEnviado: true, paused: true, until: blockUntil } });
                        } else {
                            sendBotMsg(rawJid, { text: `⚠️ Opção inválida. Por favor, digite apenas o número (1 a 8).` });
                            await ticketsColl.updateOne({ _id: cleanNumber }, { $set: { errosMenu: novosErros } });
                        }
                    }
                    return;
                }

                // 3. FINALIZAÇÃO (OBRIGADO / ESPECIALISTA)
                if (!ticket.aguardandoOpcao && !ticket.obrigadoEnviado) {
                    const isMedia = !!(msg.message.imageMessage || msg.message.documentMessage || msg.message.audioMessage);
                    
                    if (texto.length >= 20 || isMedia) {
                        sendBotMsg(rawJid, { text: `✅ Recebido! Um especialista já vai atendê-lo, aguarde um momento.` });
                        await ticketsColl.updateOne({ _id: cleanNumber }, { $set: { obrigadoEnviado: true, paused: true, until: blockUntil } });
                    } 
                    else if (!ticket.tentouInsistir) {
                        sendBotMsg(rawJid, { text: `⚠️ Por favor, descreva a situação com um pouco mais de detalhes para facilitar a análise.` });
                        await ticketsColl.updateOne({ _id: cleanNumber }, { $set: { tentouInsistir: true } });
                    } 
                    else {
                        sendBotMsg(rawJid, { text: `✅ Recebido! Já encaminhei seu caso para um especialista, ele já vai atendê-lo.` });
                        await ticketsColl.updateOne({ _id: cleanNumber }, { $set: { obrigadoEnviado: true, paused: true, until: blockUntil } });
                    }
                }

            } catch (err) {
                console.error("Erro interno:", err);
            }
        });

        sock.ev.on('connection.update', async (update) => {
            const { connection, lastDisconnect, qr } = update;
            if (qr) { lastQr = qr; io.emit('qr', qr); }
            
           // --- CORREÇÃO DA FOTO E STATUS (Dentro do sock.ev.on('connection.update')) ---
            if (connection === 'open') {
                lastQr = null;
                const userNumber = sock.user.id.split(':')[0];
                
                // Busca a foto real. Se não tiver, envia vazio para o HTML tratar
                let ppUrl = null;
                try {
                    ppUrl = await sock.profilePictureUrl(sock.user.id, 'image');
                } catch (e) {
                    ppUrl = null; 
                }

                currentUser = { 
                    number: userNumber, 
                    name: 'Azevedo e Juvencio', 
                    pic: ppUrl 
                };
                
                io.emit('connected', currentUser);
            }
                        
            if (connection === 'close') {
                const shouldReconnect = (lastDisconnect.error instanceof Boom)?.output?.statusCode !== DisconnectReason.loggedOut;
                if (shouldReconnect) startBot();
                else {
                    currentUser = null;
                    io.emit('disconnected');
                }
            }
        });

    } catch (err) { 
        console.error("Erro crítico:", err);
        setTimeout(startBot, 5000);
    }
}

// Funções de Banco e Rotas (Mantidas conforme lógica original)
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
    req.session.destroy(() => {
        res.redirect('/login');
    });
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

// IA GRAVAR NO BANCO ---
app.get('/api/knowledgeColl', async (req, res) => {
    if (!req.session.loggedIn) return res.status(401).send("Acesso negado");
    const data = await knowledgeColl.find({}).toArray();
    res.json(data);
});

app.post('/api/knowledgeColl', async (req, res) => {
    if (!req.session.loggedIn) return res.status(401).send("Acesso negado");
    const { pergunta, resposta } = req.body;
    await knowledgeColl.updateOne(
        { pergunta }, 
        { $set: { pergunta, resposta, updatedAt: Date.now() } }, 
        { upsert: true }
    );
    res.sendStatus(200);
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