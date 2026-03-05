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

const mongoUri = process.env.MONGODB_URI;
const client = new MongoClient(mongoUri);

let lastQr = null;
let currentUser = null;
let sock;

// Memória de Tickets e Bloqueios
const activeTickets = new Map();

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
            browser: ['Azevedo Advogados', 'Chrome', '1.0.0']
        });

        sock.ev.on('creds.update', saveCreds);

        sock.ev.on('messages.upsert', async m => {
            const msg = m.messages[0];
            if (!msg.message) return;

            const from = msg.key.remoteJid;
            const isMe = msg.key.fromMe; // Detecta se a mensagem saiu de você
            const now = Date.now();

            // 1. LÓGICA DE INTERVENÇÃO HUMANA
            // Se você (atendente) mandar mensagem, bloqueia o bot para este contato por 3 dias
            if (isMe) {
                const blockUntil = now + (3 * 24 * 60 * 60 * 1000); // 3 dias em ms
                activeTickets.set(from, { 
                    paused: true, 
                    until: blockUntil,
                    reason: 'Intervenção Humana'
                });
                console.log(`🤖 Bot pausado para ${from} devido à resposta humana.`);
                return;
            }

            // 2. VERIFICAÇÃO DE BLOQUEIO/PAUSA
            const ticket = activeTickets.get(from);
            if (ticket && ticket.paused) {
                if (now < ticket.until) {
                    return; // Bot ignora o cliente totalmente
                } else {
                    activeTickets.delete(from); // Passou 3 dias, remove bloqueio
                }
            }

            // 3. SCRIPT DE OPÇÕES (SEU CÓDIGO)
            const messageType = Object.keys(msg.message)[0];
            const texto = msg.message.conversation || 
                          msg.message.extendedTextMessage?.text || 
                          msg.message.buttonsResponseMessage?.selectedButtonId || 
                          msg.message.listResponseMessage?.singleSelectReply?.selectedRowId || "";

            // Se não tem ticket ou expirou atividade normal (2h)
            if (!ticket || (now - ticket.lastActivity > 2 * 60 * 60 * 1000)) {
                const ticketId = Math.floor(1000 + Math.random() * 9000);
                activeTickets.set(from, { 
                    id: ticketId, 
                    aguardandoOpcao: true, 
                    obrigadoEnviado: false, 
                    lastActivity: now 
                });

                const saudacao = new Date().getHours() < 12 ? 'Bom dia' : new Date().getHours() < 18 ? 'Boa tarde' : 'Boa noite';

                const sections = [{
                    title: "Áreas de Atuação",
                    rows: [
                        {title: "Direito Digital", rowId: "1", description: "Desbloqueio de contas"},
                        {title: "Direito Cível", rowId: "2", description: "Contratos e Cível"},
                        {title: "Direito do Consumidor", rowId: "3", description: "Problemas de consumo"},
                        {title: "Direito Imobiliário", rowId: "4", description: "Imóveis e Aluguel"},
                        {title: "Direito Trabalhista", rowId: "5", description: "Questões de trabalho"},
                        {title: "Direito Empresarial", rowId: "6", description: "Empresas"},
                        {title: "Outros Assuntos", rowId: "7", description: "Diversos"},
                        {title: "Processo em Andamento", rowId: "8", description: "Já sou cliente"}
                    ]
                }];

                await sock.sendMessage(from, {
                    text: `${saudacao}! 👋 Seja bem-vindo(a) ao *Azevedo e Juvencio - Sociedade de Advogados* ⚖️\nSeu atendimento foi iniciado: 🎫 *${ticketId}*\n\nSelecione no menu abaixo a opção desejada:`,
                    footer: "Azevedo & Juvencio",
                    buttonText: "Ver Opções",
                    sections
                });
                return;
            }

            ticket.lastActivity = now;

            const respostas = {
                '1': `📱 *Direito Digital (Desbloqueio de Contas)*\n\n📌 Qual a plataforma?\n📌 O que aconteceu?\n📸 Envie prints.\n\nUm especialista analisará seu caso.`,
                '2': `📄 *Direito Cível e Contratual*\n\n📌 Tipo de demanda?\n📝 Resumo do caso?\n📎 Documentação?\n\nEquipe notificada.`,
                '3': `🛒 *Direito do Consumidor*\n\n📌 Qual o problema?\n💰 Prejuízo financeiro?\n📸 Provas?\n\nEntraremos em contato.`,
                '4': `🏠 *Direito Imobiliário*\n\n📌 Objeto da consulta?\n📝 Resumo da situação?\n📎 Documentos?\n\nUm especialista falará com você.`,
                '5': `👷 *Direito Trabalhista*\n\n📌 Situação atual?\n📌 Principais reclamações?\n📝 Detalhes?\n\nEntraremos em contato em instantes.`,
                '6': `🏢 *Direito Empresarial*\n\n📌 Natureza da demanda?\n🏷️ Dados da empresa?\n📝 Descrição?\n\nUm advogado falará com você.`,
                '7': `📝 *Outros Assuntos*\n\n📌 Descreva brevemente seu assunto.\n🎤 Pode enviar áudio.\n\nSua mensagem foi para triagem.`,
                '8': `📂 *Atendimento/Processo em Andamento*\n\n📌 Nome completo.\n📌 Número do processo/CPF.\n📌 Qual a sua solicitação?\n\nEstamos localizando seu histórico.`
            };

            if (ticket.aguardandoOpcao && respostas[texto]) {
                await sock.sendMessage(from, { text: respostas[texto] });
                ticket.aguardandoOpcao = false;
                return;
            }

            if (!ticket.aguardandoOpcao && !ticket.obrigadoEnviado) {
                const MIN_DETALHE = 30;
                if (texto.length < MIN_DETALHE && messageType !== 'imageMessage' && messageType !== 'documentMessage') {
                    await sock.sendMessage(from, { text: `⚠️ Descreva melhor a situação (mínimo ${MIN_DETALHE} caracteres).` });
                    return;
                }
                ticket.obrigadoEnviado = true;
                await sock.sendMessage(from, { text: `✅ Informações recebidas! Retornaremos em 15-30 minutos.` });
            }
        });

        sock.ev.on('connection.update', (update) => {
            const { connection, lastDisconnect, qr } = update;
            if (qr) { lastQr = qr; io.emit('qr', qr); }
            if (connection === 'open') {
                lastQr = null;
                currentUser = { number: sock.user.id.split(':')[0], name: sock.user.name || 'Bot Azevedo', pic: 'https://www.w3schools.com/howto/img_avatar.png' };
                io.emit('connected', currentUser);
            }
            if (connection === 'close') {
                if ((lastDisconnect.error instanceof Boom)?.output?.statusCode !== DisconnectReason.loggedOut) startBot();
            }
        });

    } catch (err) { console.error(err); }
}

io.on('connection', (socket) => {
    if (currentUser) socket.emit('connected', currentUser);
    else if (lastQr) socket.emit('qr', lastQr);
});

app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'index.html')));
app.get('/logout', async (req, res) => {
    await client.db('bot_whatsapp').collection('auth_session').deleteMany({});
    io.emit('disconnected');
    setTimeout(() => process.exit(0), 1000);
});

server.listen(port, () => startBot());