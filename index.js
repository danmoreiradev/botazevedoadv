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
let genAI = null; // Apenas declare a variável, sem valor por enquanto.
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
    saveUninitialized: false, // Melhor para produção
    store: store, // Agora as sessões ficam salvas no Banco, não na memória!
    cookie: { maxAge: 1000 * 60 * 60 * 24 } // 24 horas de login
}));

const mongoUri = process.env.MONGODB_URI;
const client = new MongoClient(mongoUri);

let lastQr = null;
let currentUser = null;
let sock;
const botMessageIds = new Set();
const processing = new Set();

let ticketsColl, authColl, knowledgeColl, userLoginColl, clientsColl, ticketHistoryColl, countersColl;

async function sendBotMsg(jid, content) {
    try {
        const sent = await sock.sendMessage(jid, content);
        const id = sent?.key?.id;

        // Mantém um conjunto de IDs enviados pelo próprio bot.
        // Evita confundir mensagens simultâneas do bot com intervenção humana.
        if (id) {
            botMessageIds.add(id);
            setTimeout(() => botMessageIds.delete(id), 60 * 1000);
        }

        return sent;
    } catch (err) {
        console.error('Erro ao enviar:', err);
        return null;
    }
}

function validarCPF(cpf) {
    cpf = cpf.replace(/[^\d]+/g, ''); // Remove tudo que não for número
    if (cpf === '' || cpf.length !== 11 || /^(\d)\1{10}$/.test(cpf)) return false;
    
    let add = 0, rev = 0;
    for (let i = 0; i < 9; i++) add += parseInt(cpf.charAt(i)) * (10 - i);
    rev = 11 - (add % 11);
    if (rev === 10 || rev === 11) rev = 0;
    if (rev !== parseInt(cpf.charAt(9))) return false;
    
    add = 0;
    for (let i = 0; i < 10; i++) add += parseInt(cpf.charAt(i)) * (11 - i);
    rev = 11 - (add % 11);
    if (rev === 10 || rev === 11) rev = 0;
    if (rev !== parseInt(cpf.charAt(10))) return false;
    
    return true;
}


const MENU_OPCOES = `1️⃣ Direito Digital (Desbloqueio de conta)
2️⃣ Direito Cível
3️⃣ Direito do Consumidor
4️⃣ Direito Imobiliário
5️⃣ Direito Trabalhista
6️⃣ Direito Empresarial
7️⃣ Outros Assuntos
8️⃣ Processo em andamento`;

const PERGUNTA_CADASTRO_CLIENTE = `Antes de finalizar a triagem, deseja se cadastrar como cliente para facilitar seus próximos atendimentos?

1️⃣ Sim
2️⃣ Não`;

const RESPOSTAS_AREAS = {
    '1': `📱 *Direito Digital (Desbloqueio de Contas)*

Para direcionarmos corretamente o atendimento, informe:

📌 Qual é a plataforma? (Instagram, Facebook, WhatsApp, Mercado Livre, Uber etc.)
📌 O que aconteceu com a conta?
📸 Se possível, envie prints da mensagem de erro, bloqueio ou suspensão.

Pode responder por texto, áudio ou enviar os documentos por aqui.`,

    '2': `📄 *Direito Cível e Contratual*

Para direcionarmos corretamente o atendimento, informe:

📌 Qual é a situação ou dúvida principal?
📝 Faça um breve resumo do caso.
📎 Se houver contrato, notificação ou outro documento, pode enviar por aqui.

Pode responder por texto ou áudio.`,

    '3': `🛒 *Direito do Consumidor*

Para direcionarmos corretamente o atendimento, informe:

📌 Qual é o problema ocorrido?
💰 Houve algum prejuízo financeiro? Se sim, qual o valor aproximado?
📸 Se possível, envie notas, protocolos, e-mails ou prints relacionados ao caso.

Pode responder por texto ou áudio.`,

    '4': `🏠 *Direito Imobiliário*

Para direcionarmos corretamente o atendimento, informe:

📌 O assunto envolve compra e venda, locação, despejo, usucapião, escritura, condomínio ou outro tema?
📝 Faça um breve resumo da situação.
📎 Se houver contrato, matrícula ou notificação, pode enviar por aqui.

Pode responder por texto ou áudio.`,

    '5': `👷 *Direito Trabalhista*

Para direcionarmos corretamente o atendimento, informe:

📌 Você ainda trabalha na empresa ou já foi desligado?
📌 Qual é o principal problema ou dúvida trabalhista?
📝 Conte brevemente o que aconteceu.

Pode responder por texto ou áudio.`,

    '6': `🏢 *Direito Empresarial*

Para direcionarmos corretamente o atendimento, informe:

📌 Qual é a necessidade da empresa?
🏷️ Se desejar, informe o nome ou segmento da empresa.
📝 Faça um breve resumo da situação ou dúvida.

Pode responder por texto ou áudio.`,

    '7': `📝 *Outros Assuntos*

Sem problemas. Descreva brevemente o assunto ou a dúvida para que possamos encaminhar ao profissional adequado.

Pode responder por texto ou áudio.`,

    '8': `📂 *Atendimento / Processo em Andamento*

Para localizarmos o atendimento, informe:

📌 Nome completo do titular.
📌 Número do processo, caso tenha em mãos.
📌 O que você precisa: andamento, envio de documento ou contato com o advogado responsável?

Se precisar enviar algum documento, pode anexar por aqui.`
};

function normalizarTexto(texto = '') {
    return texto
        .toLowerCase()
        .normalize('NFD')
        .replace(/[\u0300-\u036f]/g, '')
        .trim();
}

function respostaPositiva(texto = '') {
    const valor = normalizarTexto(texto);
    return ['1', 'sim', 's', 'quero', 'desejo', 'pode', 'pode cadastrar'].includes(valor);
}

function respostaNegativa(texto = '') {
    const valor = normalizarTexto(texto);
    return ['2', 'nao', 'n', 'nao obrigado', 'nao obrigada', 'nao quero', 'prefiro nao', 'agora nao'].includes(valor);
}

function clienteQuerEncerrar(texto = '') {
    const valor = normalizarTexto(texto);
    const frases = [
        'pode encerrar',
        'pode finalizar',
        'quero encerrar',
        'quero finalizar',
        'era so isso',
        'e so isso',
        'nao preciso mais',
        'atendimento finalizado',
        'duvida resolvida'
    ];
    return frases.some(frase => valor.includes(frase));
}

function ehLeadAutomatico(texto = '') {
    const valor = normalizarTexto(texto);
    return valor.includes('gostaria de saber mais') ||
        valor.includes('vi no facebook') ||
        valor.includes('vi no instagram') ||
        valor.includes('anuncio') ||
        valor.includes('tenho interesse');
}

function primeiroNome(nome = '') {
    return nome.trim().split(/\s+/)[0] || '';
}

function validarNomeESobrenome(texto = '') {
    const partes = texto.trim().replace(/\s+/g, ' ').split(' ').filter(Boolean);
    if (partes.length < 2) return null;
    if (partes.some(parte => parte.length < 2)) return null;

    return {
        nome: partes[0],
        sobrenome: partes.slice(1).join(' '),
        nomeCompleto: partes.join(' ')
    };
}

function normalizarJid(jid) {
    if (!jid || typeof jid !== 'string') return null;
    try {
        return jidNormalizedUser(jid);
    } catch (_) {
        return jid;
    }
}

function numeroDePnJid(jid) {
    if (!jid || !jid.endsWith('@s.whatsapp.net')) return null;
    return jid.split('@')[0].split(':')[0] || null;
}

async function obterIdentificadoresContato(msg, rawJid) {
    const jids = new Set();
    const numeros = new Set();

    const adicionarJid = (jid) => {
        const normalizado = normalizarJid(jid);
        if (!normalizado) return;

        jids.add(normalizado);
        const numero = numeroDePnJid(normalizado);
        if (numero) numeros.add(numero);
    };

    adicionarJid(rawJid);
    adicionarJid(msg?.key?.remoteJidAlt);
    adicionarJid(msg?.key?.participantPn);
    adicionarJid(msg?.participantPn);

    const jidNormalizado = normalizarJid(rawJid);

    // Baileys atual mantém o mapeamento LID -> PN no signalRepository quando disponível.
    if (jidNormalizado?.endsWith('@lid') && sock?.signalRepository?.lidMapping?.getPNForLID) {
        try {
            const pn = await sock.signalRepository.lidMapping.getPNForLID(jidNormalizado);
            adicionarJid(pn);
        } catch (err) {
            console.warn(`[LID] Não foi possível resolver ${jidNormalizado}:`, err?.message || err);
        }
    }

    // O número telefônico é um identificador adicional. Nunca tratamos o número interno do @lid como telefone.
    for (const numero of numeros) {
        jids.add(numero);
    }

    const identificadores = [...jids];
    const whatsappNumbers = [...numeros];
    const jidPreferencial = identificadores.find(id => id.endsWith('@s.whatsapp.net')) || jidNormalizado || rawJid;
    const numeroPrincipal = whatsappNumbers[0] || null;
    const chaveAtiva = numeroPrincipal || jidPreferencial;

    return {
        identificadores,
        whatsappNumbers,
        jidPreferencial,
        numeroPrincipal,
        chaveAtiva
    };
}

async function buscarClientePorContato(contato) {
    const filtros = [];

    if (contato.identificadores.length) {
        filtros.push({ identificadores: { $in: contato.identificadores } });
        filtros.push({ lastRawJid: { $in: contato.identificadores } });
    }

    if (contato.whatsappNumbers.length) {
        filtros.push({ whatsappNumbers: { $in: contato.whatsappNumbers } });
        filtros.push({ numeroReal: { $in: contato.whatsappNumbers } });
    }

    if (!filtros.length) return null;

    const cliente = await clientsColl.findOne({ $or: filtros });
    if (!cliente) return null;

    // Cadastros da versão anterior possuíam apenas CPF. Para a saudação nominal,
    // consideramos cliente identificado apenas quando nome + sobrenome já existem.
    if (!cliente.cpf || !cliente.nome || !cliente.sobrenome) return null;

    return cliente;
}

async function buscarTicketAtivo(contato) {
    const filtros = [];

    if (contato.identificadores.length) {
        filtros.push({ identificadores: { $in: contato.identificadores } });
    }

    if (contato.whatsappNumbers.length) {
        filtros.push({ whatsappNumbers: { $in: contato.whatsappNumbers } });
        filtros.push({ numeroReal: { $in: contato.whatsappNumbers } });
    }

    if (contato.chaveAtiva) filtros.push({ _id: contato.chaveAtiva });

    if (!filtros.length) return null;
    return ticketsColl.findOne({ $or: filtros });
}

async function gerarNumeroTicket() {
    const resultado = await countersColl.findOneAndUpdate(
        { _id: 'ticket_sequence' },
        {
            $inc: { seq: 1 },
            $setOnInsert: { createdAt: Date.now() }
        },
        {
            upsert: true,
            returnDocument: 'after'
        }
    );

    // Compatibilidade com versões do driver MongoDB que retornam ModifyResult.value.
    const doc = resultado?.value || resultado;
    const seq = doc?.seq;

    if (!seq) {
        throw new Error('Não foi possível gerar a sequência do ticket.');
    }

    return {
        seq,
        ticketNumber: `AJ-${String(seq).padStart(6, '0')}`
    };
}

function mensagemRecepcao(cliente, ticketNumber) {
    if (cliente?.nome) {
        return `Olá, ${primeiroNome(cliente.nome)}! Seja bem-vindo de volta à *Azevedo & Juvencio Advogados*. 👋\n\nSeu novo atendimento é o ticket *${ticketNumber}*.\n\nSegue as opções. Digite apenas o número:\n\n${MENU_OPCOES}`;
    }

    return `Olá! Seja bem-vindo à *Azevedo & Juvencio Advogados*. 👋\n\nSeu atendimento é o ticket *${ticketNumber}*.\n\nPara começar, escolha uma opção digitando apenas o número:\n\n${MENU_OPCOES}`;
}

async function registrarTicketHistorico(ticket) {
    await ticketHistoryColl.updateOne(
        { _id: ticket.ticketNumber },
        {
            $set: {
                ticketNumber: ticket.ticketNumber,
                id: ticket.id,
                status: ticket.status,
                origem: ticket.origem,
                clienteId: ticket.clienteId || null,
                clienteNome: ticket.clienteNome || null,
                cpf: ticket.cpf || null,
                identificadores: ticket.identificadores || [],
                whatsappNumbers: ticket.whatsappNumbers || [],
                numeroReal: ticket.numeroReal || null,
                lastRawJid: ticket.lastRawJid,
                area: ticket.area || null,
                createdAt: ticket.createdAt,
                updatedAt: Date.now()
            }
        },
        { upsert: true }
    );
}

async function atualizarHistorico(ticketNumber, campos) {
    if (!ticketNumber) return;
    await ticketHistoryColl.updateOne(
        { _id: ticketNumber },
        { $set: { ...campos, updatedAt: Date.now() } }
    );
}

async function fecharTicketAnterior(ticket, status = 'encerrado_timeout') {
    if (!ticket) return;

    await atualizarHistorico(ticket.ticketNumber, {
        status,
        closedAt: Date.now()
    });

    await ticketsColl.deleteOne({ _id: ticket._id });
}

async function criarNovoTicket({ contato, rawJid, textoInicial, cliente = null, paused = false }) {
    const { seq, ticketNumber } = await gerarNumeroTicket();
    const agora = Date.now();
    const tresDiasEmMs = 3 * 24 * 60 * 60 * 1000;

    const ticket = {
        _id: contato.chaveAtiva,
        id: seq,
        ticketNumber,
        status: paused ? 'em_atendimento_humano' : 'aguardando_opcao',
        origem: ehLeadAutomatico(textoInicial) ? 'lead_anuncio' : 'organico',
        clienteId: cliente?._id || null,
        clienteNome: cliente?.nomeCompleto || (cliente ? `${cliente.nome} ${cliente.sobrenome}`.trim() : null),
        cpf: cliente?.cpf || null,
        clienteCadastrado: !!cliente,
        identificadores: contato.identificadores,
        whatsappNumbers: contato.whatsappNumbers,
        numeroReal: contato.numeroPrincipal,
        lastRawJid: rawJid,
        aguardandoOpcao: !paused,
        aguardandoDetalhes: false,
        aguardandoCadastroCliente: false,
        aguardandoNomeCadastro: false,
        aguardandoCPFCadastro: false,
        nomeCadastroTemp: null,
        paused,
        until: paused ? agora + tresDiasEmMs : null,
        lastActivity: agora,
        createdAt: agora
    };

    await ticketsColl.replaceOne(
        { _id: ticket._id },
        ticket,
        { upsert: true }
    );

    await registrarTicketHistorico(ticket);

    if (cliente) {
        await clientsColl.updateOne(
            { _id: cliente._id },
            {
                $addToSet: {
                    identificadores: { $each: contato.identificadores },
                    whatsappNumbers: { $each: contato.whatsappNumbers },
                    ticketNumbers: ticketNumber
                },
                $set: {
                    numeroReal: contato.numeroPrincipal || cliente.numeroReal || null,
                    lastRawJid: rawJid,
                    lastSeenAt: agora,
                    updatedAt: agora
                }
            }
        );
    }

    return ticket;
}

async function encaminharParaEspecialista(ticket, jid, mensagem = null) {
    const tresDiasEmMs = 3 * 24 * 60 * 60 * 1000;
    const agora = Date.now();

    if (mensagem) {
        await sendBotMsg(jid, { text: mensagem });
    }

    await ticketsColl.updateOne(
        { _id: ticket._id },
        {
            $set: {
                status: 'aguardando_especialista',
                aguardandoCadastroCliente: false,
                aguardandoNomeCadastro: false,
                aguardandoCPFCadastro: false,
                paused: true,
                until: agora + tresDiasEmMs,
                lastActivity: agora
            }
        }
    );

    await atualizarHistorico(ticket.ticketNumber, {
        status: 'aguardando_especialista'
    });
}

async function salvarCadastroCliente(ticket, contato, rawJid, nomeInfo, cpfLimpo) {
    const agora = Date.now();

    await clientsColl.updateOne(
        { _id: cpfLimpo },
        {
            $set: {
                cpf: cpfLimpo,
                nome: nomeInfo.nome,
                sobrenome: nomeInfo.sobrenome,
                nomeCompleto: nomeInfo.nomeCompleto,
                numeroReal: contato.numeroPrincipal,
                lastRawJid: rawJid,
                updatedAt: agora,
                lastSeenAt: agora
            },
            $setOnInsert: {
                createdAt: agora
            },
            $addToSet: {
                identificadores: { $each: contato.identificadores },
                whatsappNumbers: { $each: contato.whatsappNumbers },
                ticketNumbers: ticket.ticketNumber
            }
        },
        { upsert: true }
    );

    await ticketsColl.updateOne(
        { _id: ticket._id },
        {
            $set: {
                clienteId: cpfLimpo,
                cpf: cpfLimpo,
                clienteNome: nomeInfo.nomeCompleto,
                clienteCadastrado: true,
                nomeCadastroTemp: null,
                aguardandoCadastroCliente: false,
                aguardandoNomeCadastro: false,
                aguardandoCPFCadastro: false,
                lastActivity: agora
            }
        }
    );

    await atualizarHistorico(ticket.ticketNumber, {
        clienteId: cpfLimpo,
        cpf: cpfLimpo,
        clienteNome: nomeInfo.nomeCompleto,
        cadastroRealizado: true
    });
}

async function startBot() {
    try {
        await client.connect();
        const db = client.db('bot_whatsapp');
        authColl = db.collection('auth_session');
        ticketsColl = db.collection('active_tickets');
        knowledgeColl = db.collection('knowledge_base');
        userLoginColl = db.collection('user_login');
        clientsColl = db.collection('client_registry');
        ticketHistoryColl = db.collection('ticket_history');
        countersColl = db.collection('counters');

        // Índices para manter CPF e número de ticket únicos e acelerar a identificação do cliente.
        await Promise.all([
            clientsColl.createIndex({ cpf: 1 }, { unique: true, sparse: true }),
            clientsColl.createIndex({ identificadores: 1 }),
            clientsColl.createIndex({ whatsappNumbers: 1 }),
            ticketHistoryColl.createIndex({ ticketNumber: 1 }, { unique: true }),
            ticketHistoryColl.createIndex({ identificadores: 1 }),
            ticketsColl.createIndex({ ticketNumber: 1 }, { unique: true, sparse: true })
        ]);
        
        apiKeysColl = db.collection('api_keys');
        const geminiKeyDoc = await apiKeysColl.findOne({ nome: "gemini" });
        
        if (geminiKeyDoc && geminiKeyDoc.chave) {
            genAI = new GoogleGenerativeAI(geminiKeyDoc.chave);
            // Definimos o modelo GLOBALMENTE com a API v1 para evitar o erro 404
            global.geminiModel = genAI.getGenerativeModel(
            { model: "gemini-3.1-flash-lite-preview" }, 
            { apiVersion: 'v1beta' } // MUDAR DE 'v1' PARA 'v1beta'
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
    const msg = m.messages?.[0];
    if (!msg?.message || msg.key.remoteJid === 'status@broadcast') return;

    const rawJid = msg.key.remoteJid;
    if (!rawJid || rawJid.endsWith('@g.us') || rawJid.endsWith('@newsletter')) return;

    const msgId = msg.key.id;
    if (!msgId || processing.has(msgId)) return;

    processing.add(msgId);
    setTimeout(() => processing.delete(msgId), 10 * 1000);

    const isMe = !!msg.key.fromMe;
    const textoRaw =
        msg.message.conversation ||
        msg.message.extendedTextMessage?.text ||
        msg.message.imageMessage?.caption ||
        msg.message.videoMessage?.caption ||
        msg.message.documentMessage?.caption ||
        '';
    const texto = textoRaw.trim();
    const isMedia = !!(
        msg.message.imageMessage ||
        msg.message.videoMessage ||
        msg.message.documentMessage ||
        msg.message.audioMessage
    );

    const timeoutNovoAtendimento = 2 * 60 * 60 * 1000;
    const tresDiasEmMs = 3 * 24 * 60 * 60 * 1000;

    try {
        const contato = await obterIdentificadoresContato(msg, rawJid);
        let ticket = await buscarTicketAtivo(contato);

        // Tickets criados pelo fluxo antigo não possuem ticketNumber.
        // Em vez de tentar reaproveitar estados incompatíveis, iniciamos o novo fluxo limpo.
        if (ticket && !ticket.ticketNumber) {
            await ticketsColl.deleteOne({ _id: ticket._id });
            ticket = null;
        }

        // Mensagem enviada manualmente pelo escritório.
        if (isMe) {
            if (botMessageIds.has(msgId)) return;

            let cliente = await buscarClientePorContato(contato);

            if (!ticket) {
                ticket = await criarNovoTicket({
                    contato,
                    rawJid,
                    textoInicial: texto,
                    cliente,
                    paused: true
                });
                console.log(`[Ticket ${ticket.ticketNumber}] Atendimento iniciado manualmente.`);
            } else {
                await ticketsColl.updateOne(
                    { _id: ticket._id },
                    {
                        $set: {
                            status: 'em_atendimento_humano',
                            paused: true,
                            until: Date.now() + tresDiasEmMs,
                            lastActivity: Date.now()
                        },
                        $addToSet: {
                            identificadores: { $each: contato.identificadores },
                            whatsappNumbers: { $each: contato.whatsappNumbers }
                        }
                    }
                );

                await atualizarHistorico(ticket.ticketNumber, {
                    status: 'em_atendimento_humano'
                });
            }
            return;
        }

        // Se o cliente explicitamente encerrar durante atendimento humano, fecha o ticket atual.
        // O cadastro já foi oferecido ao fim da triagem automatizada.
        if (ticket?.paused && clienteQuerEncerrar(texto)) {
            await sendBotMsg(rawJid, {
                text: `Atendimento *${ticket.ticketNumber}* encerrado. Obrigado pelo contato! Ficamos à disposição. 👋`
            });

            await atualizarHistorico(ticket.ticketNumber, {
                status: 'encerrado',
                closedAt: Date.now()
            });

            await ticketsColl.deleteOne({ _id: ticket._id });
            return;
        }

        // Mesmo se um humano tiver intervido, respostas de cadastro em andamento continuam sendo processadas.
        const emFluxoCadastro = !!(
            ticket?.aguardandoCadastroCliente ||
            ticket?.aguardandoNomeCadastro ||
            ticket?.aguardandoCPFCadastro
        );

        if (ticket?.paused && !emFluxoCadastro) {
            if (Date.now() < (ticket.until || 0)) {
                console.log(`[Ticket ${ticket.ticketNumber}] Bot pausado durante atendimento humano.`);
                return;
            }

            await ticketsColl.updateOne(
                { _id: ticket._id },
                { $set: { paused: false, until: null } }
            );
            ticket.paused = false;
        }

        // Novo atendimento: sempre gera novo ticket e envia as opções imediatamente, inclusive para LEAD.
        const ticketExpirou = ticket && (Date.now() - (ticket.lastActivity || 0) > timeoutNovoAtendimento);

        if (!ticket || ticketExpirou) {
            if (ticketExpirou) {
                await fecharTicketAnterior(ticket, 'encerrado_timeout');
                ticket = null;
            }

            const cliente = await buscarClientePorContato(contato);
            ticket = await criarNovoTicket({
                contato,
                rawJid,
                textoInicial: texto,
                cliente,
                paused: false
            });

            await sendBotMsg(rawJid, {
                text: mensagemRecepcao(cliente, ticket.ticketNumber)
            });

            console.log(`[Ticket ${ticket.ticketNumber}] Novo atendimento aberto${cliente ? ` para ${cliente.nome}` : ''}.`);
            return;
        }

        // Atualiza os identificadores observados no ticket ativo. Isso ajuda a ligar PN e LID do mesmo contato.
        await ticketsColl.updateOne(
            { _id: ticket._id },
            {
                $set: {
                    lastRawJid: rawJid,
                    numeroReal: contato.numeroPrincipal || ticket.numeroReal || null,
                    lastActivity: Date.now()
                },
                $addToSet: {
                    identificadores: { $each: contato.identificadores },
                    whatsappNumbers: { $each: contato.whatsappNumbers }
                }
            }
        );

        // 1) MENU PRINCIPAL
        if (ticket.aguardandoOpcao) {
            if (!RESPOSTAS_AREAS[texto]) {
                await sendBotMsg(rawJid, {
                    text: `Por favor, digite apenas o número da opção desejada:\n\n${MENU_OPCOES}`
                });
                return;
            }

            const area = {
                '1': 'Direito Digital',
                '2': 'Direito Cível',
                '3': 'Direito do Consumidor',
                '4': 'Direito Imobiliário',
                '5': 'Direito Trabalhista',
                '6': 'Direito Empresarial',
                '7': 'Outros Assuntos',
                '8': 'Processo em andamento'
            }[texto];

            await sendBotMsg(rawJid, { text: RESPOSTAS_AREAS[texto] });

            await ticketsColl.updateOne(
                { _id: ticket._id },
                {
                    $set: {
                        area,
                        status: 'aguardando_detalhes',
                        aguardandoOpcao: false,
                        aguardandoDetalhes: true,
                        lastActivity: Date.now()
                    }
                }
            );

            await atualizarHistorico(ticket.ticketNumber, {
                area,
                status: 'aguardando_detalhes'
            });
            return;
        }

        // 2) RECEBE OS DETALHES DO CASO
        if (ticket.aguardandoDetalhes) {
            if (!texto && !isMedia) {
                await sendBotMsg(rawJid, {
                    text: `Envie um breve resumo por texto ou áudio. Se houver documentos ou prints, pode anexá-los aqui.`
                });
                return;
            }

            await ticketsColl.updateOne(
                { _id: ticket._id },
                {
                    $set: {
                        aguardandoDetalhes: false,
                        status: ticket.clienteCadastrado ? 'aguardando_especialista' : 'aguardando_cadastro',
                        lastActivity: Date.now()
                    }
                }
            );

            if (ticket.clienteCadastrado) {
                await encaminharParaEspecialista(
                    ticket,
                    rawJid,
                    `✅ Recebido! Seu ticket *${ticket.ticketNumber}* foi encaminhado para nossa equipe. Um especialista dará continuidade ao atendimento.`
                );
                return;
            }

            await sendBotMsg(rawJid, {
                text: `✅ Recebido! Seu atendimento está registrado no ticket *${ticket.ticketNumber}*.\n\n${PERGUNTA_CADASTRO_CLIENTE}`
            });

            await ticketsColl.updateOne(
                { _id: ticket._id },
                {
                    $set: {
                        aguardandoCadastroCliente: true,
                        status: 'aguardando_cadastro',
                        lastActivity: Date.now()
                    }
                }
            );

            await atualizarHistorico(ticket.ticketNumber, {
                status: 'aguardando_cadastro'
            });
            return;
        }

        // 3) CADASTRO OPCIONAL
        if (ticket.aguardandoCadastroCliente) {
            if (respostaNegativa(texto)) {
                await atualizarHistorico(ticket.ticketNumber, { cadastroRecusado: true });
                await encaminharParaEspecialista(
                    ticket,
                    rawJid,
                    `Sem problemas! Seu ticket *${ticket.ticketNumber}* foi encaminhado para nossa equipe. Um especialista dará continuidade ao atendimento.`
                );
                return;
            }

            if (!respostaPositiva(texto)) {
                await sendBotMsg(rawJid, {
                    text: `Deseja se cadastrar como cliente?\n\n1️⃣ Sim\n2️⃣ Não`
                });
                return;
            }

            await sendBotMsg(rawJid, {
                text: `Perfeito. Informe seu *nome e sobrenome*:`
            });

            await ticketsColl.updateOne(
                { _id: ticket._id },
                {
                    $set: {
                        aguardandoCadastroCliente: false,
                        aguardandoNomeCadastro: true,
                        lastActivity: Date.now()
                    }
                }
            );
            return;
        }

        // 4) NOME + SOBRENOME
        if (ticket.aguardandoNomeCadastro) {
            const nomeInfo = validarNomeESobrenome(texto);

            if (!nomeInfo) {
                await sendBotMsg(rawJid, {
                    text: `Por favor, informe pelo menos *nome e sobrenome*. Exemplo: Daniel Silva.`
                });
                return;
            }

            await sendBotMsg(rawJid, {
                text: `Obrigado, ${nomeInfo.nome}. Agora digite seu *CPF* com 11 números:`
            });

            await ticketsColl.updateOne(
                { _id: ticket._id },
                {
                    $set: {
                        nomeCadastroTemp: nomeInfo,
                        aguardandoNomeCadastro: false,
                        aguardandoCPFCadastro: true,
                        lastActivity: Date.now()
                    }
                }
            );
            return;
        }

        // 5) CPF E GRAVAÇÃO DO CLIENTE
        if (ticket.aguardandoCPFCadastro) {
            const cpfLimpo = texto.replace(/[^\d]+/g, '');

            if (!validarCPF(cpfLimpo)) {
                await sendBotMsg(rawJid, {
                    text: `CPF inválido. Confira os números e digite novamente os 11 dígitos:`
                });
                return;
            }

            const nomeInfo = ticket.nomeCadastroTemp;
            if (!nomeInfo?.nome || !nomeInfo?.sobrenome) {
                await sendBotMsg(rawJid, {
                    text: `Precisamos confirmar seu nome. Informe novamente seu *nome e sobrenome*:`
                });

                await ticketsColl.updateOne(
                    { _id: ticket._id },
                    {
                        $set: {
                            aguardandoNomeCadastro: true,
                            aguardandoCPFCadastro: false,
                            lastActivity: Date.now()
                        }
                    }
                );
                return;
            }

            await salvarCadastroCliente(ticket, contato, rawJid, nomeInfo, cpfLimpo);

            await sendBotMsg(rawJid, {
                text: `✅ Cadastro realizado, ${nomeInfo.nome}! Nos próximos atendimentos vamos reconhecer você automaticamente.\n\nSeu ticket *${ticket.ticketNumber}* foi encaminhado para nossa equipe. Um especialista dará continuidade ao atendimento.`
            });

            // Atualiza a cópia local para o encaminhamento final.
            ticket.clienteCadastrado = true;
            ticket.clienteNome = nomeInfo.nomeCompleto;
            ticket.cpf = cpfLimpo;

            await encaminharParaEspecialista(ticket, rawJid);
            return;
        }

        // Estado de segurança: se o ticket existir mas não estiver em nenhum passo válido,
        // mantém a conversa simples e não cria um segundo ticket por engano.
        console.warn(`[Ticket ${ticket.ticketNumber}] Estado não reconhecido. Reiniciando menu do mesmo ticket.`);
        await sendBotMsg(rawJid, {
            text: `Vamos continuar pelo ticket *${ticket.ticketNumber}*. Escolha uma opção:\n\n${MENU_OPCOES}`
        });
        await ticketsColl.updateOne(
            { _id: ticket._id },
            {
                $set: {
                    status: 'aguardando_opcao',
                    aguardandoOpcao: true,
                    aguardandoDetalhes: false,
                    aguardandoCadastroCliente: false,
                    aguardandoNomeCadastro: false,
                    aguardandoCPFCadastro: false,
                    lastActivity: Date.now()
                }
            }
        );
    } catch (err) {
        console.error('Erro interno no atendimento:', err);
    }
});

        // Atualiza o cadastro quando o Baileys informar um novo mapeamento LID <-> número.
        // O fluxo principal não depende deste evento; ele é apenas uma camada extra de persistência.
        sock.ev.on('lid-mapping.update', async ({ lid, pn }) => {
            try {
                const lidNormalizado = normalizarJid(lid);
                const pnNormalizado = normalizarJid(pn);
                const numero = numeroDePnJid(pnNormalizado);
                const ids = [lidNormalizado, pnNormalizado, numero].filter(Boolean);

                if (!ids.length || !clientsColl) return;

                const cliente = await clientsColl.findOne({
                    $or: [
                        { identificadores: { $in: ids } },
                        ...(numero ? [{ whatsappNumbers: numero }, { numeroReal: numero }] : [])
                    ]
                });

                if (!cliente) return;

                await clientsColl.updateOne(
                    { _id: cliente._id },
                    {
                        $addToSet: {
                            identificadores: { $each: ids },
                            ...(numero ? { whatsappNumbers: numero } : {})
                        },
                        $set: {
                            ...(numero ? { numeroReal: numero } : {}),
                            updatedAt: Date.now()
                        }
                    }
                );
            } catch (err) {
                console.warn('[LID] Falha ao persistir mapeamento:', err?.message || err);
            }
        });
        sock.ev.on('connection.update', async (update) => {
            const { connection, lastDisconnect, qr } = update;
            if (qr) { lastQr = qr; io.emit('qr', qr); }
            
            if (connection === 'open') {
                lastQr = null;
                const userNumber = sock.user.id.split(':')[0];
                let ppUrl = null;
                try { ppUrl = await sock.profilePictureUrl(sock.user.id, 'image'); } catch (e) { ppUrl = null; }

                currentUser = { number: userNumber, name: 'Azevedo e Juvencio', pic: ppUrl };
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
    // Buscamos e ordenamos pelos mais recentes primeiro
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
        // O segredo está em converter a string recebida em ObjectId do MongoDB
        const result = await knowledgeColl.deleteOne({ _id: new ObjectId(id) });
        
        if (result.deletedCount === 1) {
            res.sendStatus(200);
        } else {
            res.status(404).send("Item não encontrado");
        }
    } catch (err) {
        console.error("Erro ao deletar:", err);
        res.status(500).send("Erro interno");
    }
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

setInterval(async () => {
    if (!ticketsColl || !ticketHistoryColl) return;

    try {
        const limiteInatividade = Date.now() - (24 * 60 * 60 * 1000);
        const antigos = await ticketsColl.find(
            { lastActivity: { $lt: limiteInatividade } },
            { projection: { ticketNumber: 1 } }
        ).toArray();

        const ticketNumbers = antigos.map(t => t.ticketNumber).filter(Boolean);

        if (ticketNumbers.length) {
            await ticketHistoryColl.updateMany(
                { _id: { $in: ticketNumbers } },
                {
                    $set: {
                        status: 'encerrado_inatividade',
                        closedAt: Date.now(),
                        updatedAt: Date.now()
                    }
                }
            );
        }

        const result = await ticketsColl.deleteMany({
            lastActivity: { $lt: limiteInatividade }
        });

        if (result.deletedCount > 0) {
            console.log(`[Auto-Limpeza] ${result.deletedCount} tickets inativos removidos da fila ativa.`);
        }
    } catch (err) {
        console.error('[Auto-Limpeza] Erro:', err);
    }
}, 60 * 60 * 1000);

server.listen(port, () => startBot());