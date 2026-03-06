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

const app = express();
const server = http.createServer(app);
const io = new Server(server);
const port = process.env.PORT || 10000;

const mongoUri = process.env.MONGODB_URI;
const client = new MongoClient(mongoUri);

let lastQr = null;
let currentUser = null;
let sock;
let lastBotMessageId = null; 

let ticketsColl;
let authColl;

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
                            const storeId = `${type}-${id}`;
                            if (value) await writeData(value, storeId);
                            else await removeData(storeId);
                        }
                    }
                }
            }
        },
        saveCreds: () => writeData(creds, 'creds')
    };
}

async function startBot() {
    try {
        await client.connect();
        const db = client.db('bot_whatsapp');
        authColl = db.collection('auth_session');
        ticketsColl = db.collection('active_tickets');

        const { state, saveCreds } = await useMongoDBAuthState(authColl);
        const { version } = await fetchLatestBaileysVersion();

        sock = makeWASocket({
            version,
            auth: state,
            logger: P({ level: 'silent' }),
            browser: ['Azevedo Advogados', 'Chrome', '1.0.0'],
            connectTimeoutMs: 80000,
            defaultQueryTimeoutMs: 0, 
            retryRequestDelayMs: 3000
        });

        sock.ev.on('creds.update', saveCreds);

        sock.ev.on('messages.upsert', async m => {
            const msg = m.messages[0];
            if (!msg.message || msg.key.remoteJid === 'status@broadcast') return;

            const messageType = Object.keys(msg.message)[0];
            if (['protocolMessage', 'senderKeyDistributionMessage'].includes(messageType)) return;

            const rawJid = msg.key.remoteJid;
            const cleanNumber = rawJid.split('@')[0]; 
            const isMe = msg.key.fromMe;

            if (!isMe) {
                await ticketsColl.updateOne(
                    { _id: cleanNumber },
                    { $set: { lastRawJid: rawJid } }, 
                    { upsert: true }
                );
            }

            // --- 1. Trava humana caso mandar mensagem ---
            if (isMe) {
                const isManual = msg.message.conversation || msg.message.extendedTextMessage || msg.message.imageMessage;
                if (isManual && msg.key.id !== lastBotMessageId) {
                    const blockUntil = Date.now() + (3 * 24 * 60 * 60 * 1000); 
                    const linkedTicket = await ticketsColl.findOne({ lastRawJid: rawJid });
                    const targetId = linkedTicket ? linkedTicket._id : cleanNumber;

                    await ticketsColl.updateOne(
                        { _id: targetId }, 
                        { $set: { paused: true, until: blockUntil, lastActivity: Date.now() } }, 
                        { upsert: true }
                    );
                    console.log(`⚠️ INTERVENÇÃO MANUAL: Chat ${targetId} pausado.`);
                }
                return; 
            }

            let ticket = await ticketsColl.findOne({ _id: cleanNumber });

            if (ticket && ticket.paused) {
                if (Date.now() < ticket.until) return; 
                else await ticketsColl.updateOne({ _id: cleanNumber }, { $set: { paused: false } });
            }

            const sendBotMsg = async (jid, content) => {
                try {
                    const sent = await sock.sendMessage(jid, content);
                    lastBotMessageId = sent.key.id; 
                    return sent;
                } catch (err) {
                    console.error("❌ Erro de envio:", err.message);
                    return null; 
                }
            };

            const textoRaw = msg.message.conversation || msg.message.extendedTextMessage?.text || "";
            const texto = textoRaw.trim();

            // --- 2. LÓGICA DO MENU ---
            const timeoutMenu = 2 * 60 * 60 * 1000; 
            if (!ticket || (Date.now() - (ticket.lastActivity || 0) > timeoutMenu)) {
                const ticketId = Math.floor(1000 + Math.random() * 9000);
                await ticketsColl.replaceOne({ _id: cleanNumber }, {
                    _id: cleanNumber,
                    id: ticketId,
                    aguardandoOpcao: true,
                    obrigadoEnviado: false,
                    lastActivity: Date.now(),
                    paused: false,
                    lastRawJid: rawJid
                }, { upsert: true });

                const menuTexto = `Olá! 👋 Seja bem-vindo(a) ao *Azevedo e Juvencio - Sociedade de Advogados* 
                ⚖️\n🎫 Atendimento: *${ticketId}*\n\n
                1️⃣ Direito Digital (desbloqueio de contas)\n
                2️⃣ Direito Cível e Contratual\n
                3️⃣ Direito do Consumidor\n
                4️⃣ Direito Imobiliário\n
                5️⃣ Direito Trabalhista\n
                6️⃣ Direito Empresarial\n
                7️⃣ Outros Assuntos\n
                8️⃣ Desejo falar de um atendimento/processo em andamento`;
                await sendBotMsg(rawJid, { text: menuTexto });
                return;
            }

            await ticketsColl.updateOne({ _id: cleanNumber }, { $set: { lastActivity: Date.now() } });

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

            // ETAPA: PROCESSAR OPÇÃO DO MENU
            if (ticket.aguardandoOpcao) {
                if (respostas[texto]) {
                    console.log(`✅ Enviando resposta da opção ${texto} para ${cleanNumber}`);
                    await sendBotMsg(rawJid, { text: respostas[texto] });
                    // Garante que o estado mudou ANTES de qualquer outra coisa
                    await ticketsColl.updateOne({ _id: cleanNumber }, { $set: { aguardandoOpcao: false } });
                }
                return;
            }

            // ETAPA: FINALIZAR APÓS DESCRIÇÃO
            if (!ticket.aguardandoOpcao && !ticket.obrigadoEnviado) {
                const isMedia = msg.message.imageMessage || msg.message.documentMessage;
                // Verificamos se ele mandou um texto longo ou um arquivo
                if (texto.length >= 20 || isMedia) {
                    console.log(`🏁 Enviando encerramento para ${cleanNumber}`);
                    const ok = await sendBotMsg(rawJid, { text: `✅ Recebido! Nossa equipe analisará as informações e retornaremos em breve.` });
                    if (ok) {
                        await ticketsColl.updateOne({ _id: cleanNumber }, { $set: { obrigadoEnviado: true } });
                    }
                } else {
                    // Texto curto demais
                    await sendBotMsg(rawJid, { text: `⚠️ Por favor, descreva a situação com um pouco mais de detalhes (ou envie um documento) para que possamos ajudar.` });
                }
                return;
            }
        });

        sock.ev.on('connection.update', async (update) => {
            const { connection, lastDisconnect, qr } = update;
            if (qr) { lastQr = qr; io.emit('qr', qr); }
            if (connection === 'open') {
                lastQr = null;
                const userNumber = sock.user.id.split(':')[0];
                let ppUrl;
                try { ppUrl = await sock.profilePictureUrl(sock.user.id, 'image'); } 
                catch { ppUrl = 'https://www.w3schools.com/howto/img_avatar.png'; }
                currentUser = { number: userNumber, name: 'Azevedo e Juvencio', pic: ppUrl };
                io.emit('connected', currentUser);
                console.log('✅ Bot Online!');
            }
            if (connection === 'close') {
                const shouldReconnect = (lastDisconnect.error instanceof Boom)?.output?.statusCode !== DisconnectReason.loggedOut;
                if (shouldReconnect) startBot();
                else io.emit('disconnected');
            }
        });

    } catch (err) { 
        console.error("Erro crítico:", err);
        setTimeout(startBot, 5000);
    }
}

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

app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'index.html')));

app.get('/logout', async (req, res) => {
    try {
        await authColl.deleteMany({});
        await ticketsColl.deleteMany({});
        if (sock) await sock.logout();
        currentUser = null;
        lastQr = null;
        io.emit('disconnected');
        res.send('Sessão encerrada.');
        setTimeout(() => process.exit(0), 1500);
    } catch (err) { res.status(500).send("Erro"); }
});

server.listen(port, () => startBot());