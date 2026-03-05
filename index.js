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

const app = express();
const server = http.createServer(app);
const io = new Server(server);
const port = process.env.PORT || 10000;

// Configuração MongoDB
const mongoUri = process.env.MONGODB_URI;
const client = new MongoClient(mongoUri);

let lastQr = null;
let currentUser = null;
let sock;

// Memória de Tickets, Estados e Bloqueios
const activeTickets = new Map();

// Adaptador de Autenticação para MongoDB
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
        const collection = client.db('bot_whatsapp').collection('auth_session');
        const { state, saveCreds } = await useMongoDBAuthState(collection);
        const { version } = await fetchLatestBaileysVersion();

        sock = makeWASocket({
            version,
            auth: state,
            logger: P({ level: 'silent' }),
            browser: ['Bot Azevedo', 'Chrome', '1.0.0']
        });

        sock.ev.on('creds.update', saveCreds);

        // --- LÓGICA DE MENSAGENS E ATENDIMENTO ---
        sock.ev.on('messages.upsert', async m => {
            const msg = m.messages[0];
            if (!msg.message) return;

            const from = msg.key.remoteJid;
            const isMe = msg.key.fromMe;
            const now = Date.now();

            // 1. INTERVENÇÃO HUMANA: Se você responder, o bot para por 3 dias
            if (isMe) {
                const blockUntil = now + (3 * 24 * 60 * 60 * 1000); 
                activeTickets.set(from, { paused: true, until: blockUntil });
                console.log(`🤖 Intervenção detectada. Bot pausado para ${from} por 3 dias.`);
                return;
            }

            // 2. VERIFICAÇÃO DE PAUSA
            const ticket = activeTickets.get(from);
            if (ticket && ticket.paused) {
                if (now < ticket.until) return; // Silêncio total
                else activeTickets.delete(from); // Expirou os 3 dias
            }

            // 3. CAPTURA DE TEXTO
            const messageType = Object.keys(msg.message)[0];
            const textoRaw = msg.message.conversation || 
                             msg.message.extendedTextMessage?.text || "";
            const texto = textoRaw.trim();

            // 4. SAUDAÇÃO E MENU INICIAL (TEXTO PARA COMPATIBILIDADE 100%)
            if (!ticket || (now - ticket.lastActivity > 2 * 60 * 60 * 1000)) {
                const ticketId = Math.floor(1000 + Math.random() * 9000);
                activeTickets.set(from, { 
                    id: ticketId, 
                    aguardandoOpcao: true, 
                    obrigadoEnviado: false, 
                    lastActivity: now 
                });

                const hora = new Date().getHours();
                const saudacao = hora < 12 ? 'Bom dia' : hora < 18 ? 'Boa tarde' : 'Boa noite';

                const menuTexto = `${saudacao}! 👋 Seja bem-vindo(a) ao *Azevedo e Juvencio - Sociedade de Advogados* ⚖️\n` +
                    `Seu atendimento foi iniciado: 🎫 *${ticketId}*\n\n` +
                    `*Digite o número da opção desejada:*\n\n` +
                    `1️⃣ Direito Digital (desbloqueio de contas)\n` +
                    `2️⃣ Direito Cível e Contratual\n` +
                    `3️⃣ Direito do Consumidor\n` +
                    `4️⃣ Direito Imobiliário\n` +
                    `5️⃣ Direito Trabalhista\n` +
                    `6️⃣ Direito Empresarial\n` +
                    `7️⃣ Outros Assuntos\n` +
                    `8️⃣ Desejo falar de um atendimento/processo em andamento`;

                await sock.sendMessage(from, { text: menuTexto });
                return;
            }

            ticket.lastActivity = now;

            // 5. RESPOSTAS DAS OPÇÕES
            const respostas = {
                '1': `📱 *Direito Digital (Desbloqueio de Contas)*\n\nEntendido! Problemas com redes sociais exigem agilidade.\n\n📌 Qual a plataforma?\n📌 O que aconteceu? (Hackeada, banida, etc)\n📸 Envie prints do erro.\n\nUm especialista analisará seu caso e entrará em contato em breve.`,
                '2': `📄 *Direito Cível e Contratual*\n\n📌 Tipo de demanda: Análise de contrato, cobrança ou outro?\n📝 Resumo: Explique brevemente a situação.\n📎 Documentação: Envie fotos do contrato se houver.\n\nNossa equipe jurídica já foi notificada.`,
                '3': `🛒 *Direito do Consumidor*\n\n📌 Qual o problema? Cobrança indevida, defeito, bancos/telefonia?\n💰 Prejuízo: Informe o valor aproximado.\n📸 Provas: Notas fiscais ou protocolos.\n\nUm especialista entrará em contato em breve.`,
                '4': `🏠 *Direito Imobiliário*\n\n📌 Objeto: Compra/Venda, Aluguel, Usucapião ou Condomínio?\n📝 Resumo: Conte o que está acontecendo.\n📎 Documentos: Envie fotos do contrato ou matrícula.\n\nUm especialista analisará seu caso em breve.`,
                '5': `👷 *Direito Trabalhista*\n\n📌 Situação: Ainda trabalha ou foi desligado?\n📌 Reclamações: Horas extras, falta de registro, assédio?\n📝 Detalhes: Explique brevemente os fatos.\n\nNossa equipe especializada entrará em contato em instantes.`,
                '6': `🏢 *Direito Empresarial*\n\n📌 Natureza: Consultoria, Defesa, Societário ou Tributário?\n🏷️ Empresa: Nome ou segmento de atuação.\n📝 Descrição: Descreva o cenário ou dúvida.\n\nUm advogado corporativo entrará em contato.`,
                '7': `📝 *Outros Assuntos*\n\n📌 Por favor, descreva brevemente seu assunto ou dúvida.\n🎤 Sinta-se à vontade para enviar um áudio.\n\nSua mensagem será encaminhada para nossa triagem imediatamente.`,
                '8': `📂 *Atendimento/Processo em Andamento*\n\n📌 Nome completo do titular.\n📌 Número do processo ou CPF.\n📌 Solicitação: Deseja saber andamento ou enviar documento?\n\nEstamos localizando seu histórico para agilizar o suporte.`
            };

            // Se o usuário digitou a opção
            if (ticket.aguardandoOpcao && respostas[texto]) {
                await sock.sendMessage(from, { text: respostas[texto] });
                ticket.aguardandoOpcao = false;
                return;
            }

            // 6. VALIDAÇÃO DE DETALHES (Pós-opção)
            if (!ticket.aguardandoOpcao && !ticket.obrigadoEnviado) {
                const MIN_DETALHE = 30;
                // Ignora regra de caracteres se for anexo (foto/doc)
                if (texto.length < MIN_DETALHE && !msg.message.imageMessage && !msg.message.documentMessage) {
                    await sock.sendMessage(from, { 
                        text: `⚠️ Para que possamos analisar corretamente, precisamos de mais detalhes.\n\nPor favor, descreva melhor a situação com pelo menos ${MIN_DETALHE} caracteres.` 
                    });
                    return;
                }
                ticket.obrigadoEnviado = true;
                await sock.sendMessage(from, { 
                    text: `✅ Obrigado pelas informações! Elas já foram enviadas ao nosso sistema.\n\n⏱️ Tempo estimado de resposta: de 15 a 30 minutos dentro do horário comercial.\nSe precisar adicionar algo, pode enviar agora.` 
                });
            }
        });

        // Eventos de Conexão
        sock.ev.on('connection.update', async (update) => {
            const { connection, lastDisconnect, qr } = update;
            if (qr) { lastQr = qr; io.emit('qr', qr); }

            if (connection === 'open') {
                lastQr = null;
                const user = sock.user;
                let ppUrl;
                try { ppUrl = await sock.profilePictureUrl(user.id, 'image'); } catch { ppUrl = 'https://www.w3schools.com/howto/img_avatar.png'; }
                currentUser = { number: user.id.split(':')[0], name: user.name || 'Bot Azevedo', pic: ppUrl };
                io.emit('connected', currentUser);
                console.log('✅ WhatsApp Conectado!');
            }

            if (connection === 'close') {
                currentUser = null;
                const shouldReconnect = (lastDisconnect.error instanceof Boom)?.output?.statusCode !== DisconnectReason.loggedOut;
                if (shouldReconnect) startBot();
            }
        });

    } catch (err) {
        console.error("Erro fatal:", err);
    }
}

// Socket.io e Rotas
io.on('connection', (socket) => {
    if (currentUser) socket.emit('connected', currentUser);
    else if (lastQr) socket.emit('qr', lastQr);
});

app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'index.html')));

app.get('/logout', async (req, res) => {
    try {
        await client.db('bot_whatsapp').collection('auth_session').deleteMany({});
        if (sock) { await sock.logout(); sock.ev.removeAllListeners(); }
        currentUser = null; lastQr = null;
        io.emit('disconnected');
        setTimeout(() => process.exit(0), 1000);
    } catch (e) { res.status(500).send("Erro"); }
});

server.listen(port, () => {
    console.log(`🌐 Servidor ativo na porta ${port}`);
    startBot();
});