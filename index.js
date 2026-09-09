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
let geminiModel = null;
let apiKeysColl;

// Cache curto da base de conhecimento para evitar leitura integral do MongoDB
// a cada mensagem recebida. O cache é invalidado quando a base é alterada.
const KNOWLEDGE_CACHE_TTL_MS = 60 * 1000;
const KNOWLEDGE_MAX_ITEMS = 200;
const KNOWLEDGE_MAX_CANDIDATES = 6;
const KNOWLEDGE_SEMANTIC_FALLBACK_ITEMS = 20;
let knowledgeCache = { items: [], loadedAt: 0 };

// Cache das opções de atendimento. O MongoDB passa a ser a fonte de verdade do menu.
const MENU_CACHE_TTL_MS = 30 * 1000;
let menuOptionsCache = { items: [], loadedAt: 0 };

// Configuração de horário de funcionamento editável pelo painel.
// O servidor da hospedagem pode estar em UTC, por isso a verificação sempre usa
// explicitamente o fuso de São Paulo em vez do relógio local do processo Node.js.
const BUSINESS_HOURS_CACHE_TTL_MS = 30 * 1000;
const BUSINESS_HOURS_TIMEZONE = 'America/Sao_Paulo';
const DEFAULT_BUSINESS_HOURS = {
    _id: 'business_hours',
    ativo: true,
    inicio: '08:30',
    fim: '18:00',
    diasAtendimento: [1, 2, 3, 4, 5], // 0=domingo, 1=segunda ... 6=sábado
    timezone: BUSINESS_HOURS_TIMEZONE,
    mensagemForaHorario: 'Nosso horário de atendimento é das {{inicio}}h às {{fim}}h. Mas, para agilizar seu atendimento, conte-nos detalhadamente o seu caso e envie os documentos que você possui para que um advogado especialista possa analisar.'
};
let businessHoursCache = { value: null, loadedAt: 0 };


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

let ticketsColl, authColl, knowledgeColl, userLoginColl, clientsColl, ticketHistoryColl, countersColl, menuOptionsColl, settingsColl;

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


// Valores padrão usados somente para inicializar a coleção no MongoDB.
// Depois da primeira execução, o menu utilizado pelo bot vem de `menu_options`.
const DEFAULT_MENU_OPTIONS = [
    {
        _id: '1',
        numero: '1',
        ordem: 1,
        titulo: 'Direito Digital (Desbloqueio de conta)',
        area: 'Direito Digital',
        ativo: true,
        resposta: `📱 *Direito Digital (Desbloqueio de Contas)*

Para direcionarmos corretamente o atendimento, informe:

📌 Qual é a plataforma? (Instagram, Facebook, WhatsApp, Mercado Livre, Uber etc.)
📌 O que aconteceu com a conta?
📸 Se possível, envie prints da mensagem de erro, bloqueio ou suspensão.

Pode responder por texto, áudio ou enviar os documentos por aqui.`
    },
    {
        _id: '2',
        numero: '2',
        ordem: 2,
        titulo: 'Direito Cível',
        area: 'Direito Cível',
        ativo: true,
        resposta: `📄 *Direito Cível e Contratual*

Para direcionarmos corretamente o atendimento, informe:

📌 Qual é a situação ou dúvida principal?
📝 Faça um breve resumo do caso.
📎 Se houver contrato, notificação ou outro documento, pode enviar por aqui.

Pode responder por texto ou áudio.`
    },
    {
        _id: '3',
        numero: '3',
        ordem: 3,
        titulo: 'Direito do Consumidor',
        area: 'Direito do Consumidor',
        ativo: true,
        resposta: `🛒 *Direito do Consumidor*

Para direcionarmos corretamente o atendimento, informe:

📌 Qual é o problema ocorrido?
💰 Houve algum prejuízo financeiro? Se sim, qual o valor aproximado?
📸 Se possível, envie notas, protocolos, e-mails ou prints relacionados ao caso.

Pode responder por texto ou áudio.`
    },
    {
        _id: '4',
        numero: '4',
        ordem: 4,
        titulo: 'Direito Imobiliário',
        area: 'Direito Imobiliário',
        ativo: true,
        resposta: `🏠 *Direito Imobiliário*

Para direcionarmos corretamente o atendimento, informe:

📌 O assunto envolve compra e venda, locação, despejo, usucapião, escritura, condomínio ou outro tema?
📝 Faça um breve resumo da situação.
📎 Se houver contrato, matrícula ou notificação, pode enviar por aqui.

Pode responder por texto ou áudio.`
    },
    {
        _id: '5',
        numero: '5',
        ordem: 5,
        titulo: 'Direito Trabalhista',
        area: 'Direito Trabalhista',
        ativo: true,
        resposta: `👷 *Direito Trabalhista*

Para direcionarmos corretamente o atendimento, informe:

📌 Você ainda trabalha na empresa ou já foi desligado?
📌 Qual é o principal problema ou dúvida trabalhista?
📝 Conte brevemente o que aconteceu.

Pode responder por texto ou áudio.`
    },
    {
        _id: '6',
        numero: '6',
        ordem: 6,
        titulo: 'Direito Empresarial',
        area: 'Direito Empresarial',
        ativo: true,
        resposta: `🏢 *Direito Empresarial*

Para direcionarmos corretamente o atendimento, informe:

📌 Qual é a necessidade da empresa?
🏷️ Se desejar, informe o nome ou segmento da empresa.
📝 Faça um breve resumo da situação ou dúvida.

Pode responder por texto ou áudio.`
    },
    {
        _id: '7',
        numero: '7',
        ordem: 7,
        titulo: 'Outros Assuntos',
        area: 'Outros Assuntos',
        ativo: true,
        resposta: `📝 *Outros Assuntos*

Sem problemas. Descreva brevemente o assunto ou a dúvida para que possamos encaminhar ao profissional adequado.

Pode responder por texto ou áudio.`
    },
    {
        _id: '8',
        numero: '8',
        ordem: 8,
        titulo: 'Processo em andamento',
        area: 'Processo em andamento',
        ativo: true,
        resposta: `📂 *Atendimento / Processo em Andamento*

Para localizarmos o atendimento, informe:

📌 Nome completo do titular.
📌 Número do processo, caso tenha em mãos.
📌 O que você precisa: andamento, envio de documento ou contato com o advogado responsável?

Se precisar enviar algum documento, pode anexar por aqui.`
    }
];

const PERGUNTA_CADASTRO_CLIENTE = `Antes de finalizar a triagem, deseja se cadastrar como cliente para facilitar seus próximos atendimentos?

1️⃣ Sim
2️⃣ Não`;

function invalidarCacheMenu() {
    menuOptionsCache = { items: [], loadedAt: 0 };
}

const MAX_PERGUNTAS_TRIAGEM = 30;
const MAX_CARACTERES_PERGUNTA = 1200;
const MAX_RESPOSTAS_ACEITAS_POR_PERGUNTA = 50;
const MAX_CARACTERES_RESPOSTA_ACEITA = 200;

function normalizarRespostasAceitas(respostas = [], numeroPergunta = 0) {
    if (typeof respostas === 'string') {
        respostas = respostas.split(/\r?\n|;/);
    }

    if (!Array.isArray(respostas)) return [];
    if (respostas.length > MAX_RESPOSTAS_ACEITAS_POR_PERGUNTA) {
        throw new Error(`A pergunta ${numeroPergunta || ''} pode possuir no máximo ${MAX_RESPOSTAS_ACEITAS_POR_PERGUNTA} respostas aceitas.`.trim());
    }

    const unicas = new Map();
    for (const resposta of respostas) {
        const texto = String(resposta || '').trim();
        if (!texto) continue;
        if (texto.length > MAX_CARACTERES_RESPOSTA_ACEITA) {
            throw new Error(`Uma resposta aceita da pergunta ${numeroPergunta || ''} ultrapassa ${MAX_CARACTERES_RESPOSTA_ACEITA} caracteres.`.trim());
        }
        const chave = normalizarTexto(texto).replace(/[^a-z0-9\s]/g, ' ').replace(/\s+/g, ' ').trim();
        if (chave && !unicas.has(chave)) unicas.set(chave, texto);
    }

    return [...unicas.values()];
}

function normalizarPerguntasTriagem(perguntas = []) {
    if (!Array.isArray(perguntas)) return [];
    if (perguntas.length > MAX_PERGUNTAS_TRIAGEM) {
        throw new Error(`Cada opção pode possuir no máximo ${MAX_PERGUNTAS_TRIAGEM} perguntas.`);
    }

    return perguntas
        .map((item, index) => {
            const objeto = typeof item === 'string' ? { texto: item } : (item || {});
            const texto = String(objeto.texto || '').trim();
            if (!texto) return null;
            if (texto.length > MAX_CARACTERES_PERGUNTA) {
                throw new Error(`A pergunta ${index + 1} ultrapassa ${MAX_CARACTERES_PERGUNTA} caracteres.`);
            }

            return {
                id: String(objeto.id || new ObjectId().toString()),
                texto,
                respostasAceitas: normalizarRespostasAceitas(objeto.respostasAceitas || [], index + 1),
                ordem: index + 1,
                ativo: objeto.ativo !== false
            };
        })
        .filter(Boolean);
}

function perguntasAtivasDaOpcao(opcao = {}) {
    return normalizarPerguntasTriagem(opcao.perguntas || [])
        .filter(pergunta => pergunta.ativo !== false)
        .sort((a, b) => a.ordem - b.ordem);
}

function perguntaAtualDoTicket(ticket) {
    const perguntas = Array.isArray(ticket?.perguntasFluxo) ? ticket.perguntasFluxo : [];
    const indice = Number.isInteger(ticket?.indicePerguntaFluxo) ? ticket.indicePerguntaFluxo : 0;
    return perguntas[indice] || null;
}

function normalizarRespostaParaValidacao(texto = '') {
    return normalizarTexto(String(texto || ''))
        .replace(/[^a-z0-9\s]/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();
}

// As respostas aceitas ficam ocultas inicialmente.
// Com valor 3, a lista aparece apenas após a 3ª resposta inválida.
// Para exibir só após a 4ª resposta inválida, altere este valor para 4.
const EXIBIR_OPCOES_APOS_TENTATIVAS_INVALIDAS = 3;

function formatarPerguntaParaEnvio(pergunta, { mostrarOpcoes = false } = {}) {
    if (!pergunta?.texto) return '';

    const aceitas = Array.isArray(pergunta.respostasAceitas)
        ? pergunta.respostasAceitas.filter(Boolean)
        : [];

    if (!mostrarOpcoes || !aceitas.length) return pergunta.texto;

    return `${pergunta.texto}\n\n*Para ajudar, seguem algumas respostas aceitas:*\n${aceitas.map(item => `• ${item}`).join('\n')}`;
}

function validarRespostaDaPergunta(pergunta, texto = '', isMedia = false, { mostrarOpcoes = false } = {}) {
    const aceitas = Array.isArray(pergunta?.respostasAceitas)
        ? pergunta.respostasAceitas.filter(Boolean)
        : [];

    // Sem respostas pré-definidas, a pergunta continua livre como antes.
    if (!aceitas.length) return { valida: true };

    const perguntaFormatada = formatarPerguntaParaEnvio(pergunta, { mostrarOpcoes });

    // Perguntas validadas precisam de uma resposta textual. Uma legenda também conta como texto.
    if (!String(texto || '').trim()) {
        return {
            valida: false,
            mensagem: mostrarOpcoes
                ? `Para esta pergunta, preciso que a resposta seja enviada por *texto*.\n\n${perguntaFormatada}`
                : `Para esta pergunta, preciso que a resposta seja enviada por *texto*.\n\n${pergunta.texto}`
        };
    }

    const recebida = normalizarRespostaParaValidacao(texto);
    const encontrou = aceitas.some(item => normalizarRespostaParaValidacao(item) === recebida);

    if (encontrou) return { valida: true };

    return {
        valida: false,
        mensagem: mostrarOpcoes
            ? `Ainda não consegui validar sua resposta. Para facilitar:\n\n${perguntaFormatada}`
            : `Não consegui validar essa resposta. Por favor, responda novamente de forma objetiva.\n\n${pergunta.texto}`
    };
}

async function gerarSugestoesRespostasAceitasIA(pergunta, contexto = {}) {
    const perguntaLimpa = String(pergunta || '').trim();
    if (!perguntaLimpa) {
        throw new Error('Informe a pergunta antes de gerar sugestões.');
    }
    if (perguntaLimpa.length > MAX_CARACTERES_PERGUNTA) {
        throw new Error(`A pergunta ultrapassa ${MAX_CARACTERES_PERGUNTA} caracteres.`);
    }
    if (!geminiModel) {
        const erro = new Error('A IA não está disponível no momento. Verifique a chave do Gemini.');
        erro.code = 'IA_INDISPONIVEL';
        throw erro;
    }

    const titulo = String(contexto?.titulo || '').trim().slice(0, 120);
    const area = String(contexto?.area || '').trim().slice(0, 120);

    const prompt = `Você auxilia um advogado a configurar uma triagem de atendimento por WhatsApp.

PERGUNTA CADASTRADA:
${JSON.stringify(perguntaLimpa)}

CONTEXTO DA OPÇÃO:
Título: ${JSON.stringify(titulo || 'não informado')}
Área: ${JSON.stringify(area || 'não informada')}

Sua tarefa é decidir se essa pergunta comporta um conjunto objetivo e finito de respostas aceitas.

Responda SOMENTE em JSON válido, sem markdown, neste formato:
{"adequada":true,"respostas":["Opção 1","Opção 2"],"motivo":""}

REGRAS OBRIGATÓRIAS:
1. Use adequada=true somente para perguntas categóricas em que uma lista de opções ajuda o usuário a responder corretamente.
2. Gere entre 2 e 15 respostas curtas, claras, mutuamente compreensíveis e úteis para um atendimento jurídico real.
3. Não gere variações redundantes, abreviações, gírias ou sinônimos da mesma opção apenas para aumentar a lista.
4. Inclua "Outro" ou equivalente SOMENTE quando fizer sentido e quando a lista não puder ser razoavelmente exaustiva.
5. Exemplos adequados: "Qual rede social?", "Você ainda trabalha na empresa?", "O imóvel é próprio ou alugado?".
6. Exemplos NÃO adequados: nome, CPF, telefone, data específica, valor monetário, número de processo, relato livre, descrição do problema, envio de documento ou qualquer pergunta cuja resposta dependa de um dado particular do cliente.
7. Se não for adequada a respostas fechadas, retorne adequada=false, respostas=[] e explique em motivo, em uma frase curta, que é melhor manter resposta livre.
8. Não dê orientação jurídica, não invente fatos do cliente e não modifique a pergunta.
9. As respostas serão usadas internamente para validação da triagem; escreva-as em português natural e profissional.`;

    const result = await geminiModel.generateContent(prompt);
    const response = await result.response;
    const parsed = extrairJsonIA(response.text());

    if (!parsed || typeof parsed.adequada !== 'boolean' || !Array.isArray(parsed.respostas)) {
        throw new Error('A IA retornou um formato inválido. Tente novamente.');
    }

    if (!parsed.adequada) {
        return {
            adequada: false,
            respostas: [],
            motivo: String(parsed.motivo || 'Esta pergunta é mais adequada para resposta livre.').trim().slice(0, 300)
        };
    }

    const respostas = normalizarRespostasAceitas(parsed.respostas, 0).slice(0, 15);
    if (respostas.length < 2) {
        return {
            adequada: false,
            respostas: [],
            motivo: 'Não foi possível formar uma lista objetiva de respostas para esta pergunta.'
        };
    }

    return { adequada: true, respostas, motivo: '' };
}

function numeroComEmoji(numero) {
    const valor = String(numero ?? '').trim();
    if (!valor) return '';
    if (valor === '10') return '🔟';

    const digitos = {
        '0': '0️⃣', '1': '1️⃣', '2': '2️⃣', '3': '3️⃣', '4': '4️⃣',
        '5': '5️⃣', '6': '6️⃣', '7': '7️⃣', '8': '8️⃣', '9': '9️⃣'
    };

    return valor.split('').map(digito => digitos[digito] || digito).join('');
}

async function garantirMenuPadrao() {
    if (!menuOptionsColl) return;

    // O menu padrão é criado apenas quando a coleção ainda está vazia.
    // Assim, opções excluídas pelo painel não reaparecem após reiniciar o servidor.
    const quantidade = await menuOptionsColl.countDocuments({});
    if (quantidade === 0) {
        const agora = Date.now();
        await menuOptionsColl.insertMany(
            DEFAULT_MENU_OPTIONS.map(item => ({
                ...item,
                emoji: item.emoji || '',
                perguntas: Array.isArray(item.perguntas) ? item.perguntas : [],
                createdAt: agora,
                updatedAt: agora
            }))
        );
    }

    invalidarCacheMenu();
}

async function carregarMenuOpcoes({ incluirInativas = false } = {}) {
    if (!menuOptionsColl) {
        return incluirInativas
            ? DEFAULT_MENU_OPTIONS
            : DEFAULT_MENU_OPTIONS.filter(item => item.ativo !== false);
    }

    const agora = Date.now();
    if (!menuOptionsCache.loadedAt || (agora - menuOptionsCache.loadedAt) >= MENU_CACHE_TTL_MS) {
        const items = await menuOptionsColl
            .find({})
            .sort({ ordem: 1, createdAt: 1, _id: 1 })
            .toArray();

        menuOptionsCache = { items, loadedAt: agora };
    }

    return incluirInativas
        ? menuOptionsCache.items
        : menuOptionsCache.items.filter(item => item.ativo !== false);
}

async function gerarMenuTexto() {
    const opcoes = await carregarMenuOpcoes();
    return opcoes
        .map((item, index) => {
            const emoji = String(item.emoji || '').trim();
            const prefixoEmoji = emoji ? ` ${emoji}` : '';
            return `${numeroComEmoji(index + 1)}${prefixoEmoji} ${item.titulo}`;
        })
        .join('\n');
}

async function buscarOpcaoMenu(numero) {
    const valor = String(numero || '').trim();
    if (!/^\d{1,3}$/.test(valor)) return null;

    const indice = Number.parseInt(valor, 10) - 1;
    if (!Number.isInteger(indice) || indice < 0) return null;

    // O número digitado é a posição visual atual entre as opções ATIVAS.
    // O _id permanece estável, então reordenações não quebram o histórico dos tickets.
    const opcoesAtivas = await carregarMenuOpcoes();
    return opcoesAtivas[indice] || null;
}

function invalidarCacheHorarioFuncionamento() {
    businessHoursCache = { value: null, loadedAt: 0 };
}

function horarioHHMMValido(valor = '') {
    return /^(?:[01]\d|2[0-3]):[0-5]\d$/.test(String(valor || '').trim());
}

function horaParaMinutos(valor = '') {
    if (!horarioHHMMValido(valor)) return null;
    const [hora, minuto] = String(valor).split(':').map(Number);
    return (hora * 60) + minuto;
}

function normalizarDiasAtendimento(dias) {
    if (!Array.isArray(dias)) return [];
    return [...new Set(
        dias
            .map(Number)
            .filter(dia => Number.isInteger(dia) && dia >= 0 && dia <= 6)
    )].sort((a, b) => a - b);
}

async function garantirHorarioFuncionamentoPadrao() {
    if (!settingsColl) return;

    await settingsColl.updateOne(
        { _id: DEFAULT_BUSINESS_HOURS._id },
        {
            $setOnInsert: {
                ...DEFAULT_BUSINESS_HOURS,
                createdAt: Date.now(),
                updatedAt: Date.now()
            }
        },
        { upsert: true }
    );

    invalidarCacheHorarioFuncionamento();
}

async function carregarHorarioFuncionamento() {
    if (!settingsColl) return { ...DEFAULT_BUSINESS_HOURS };

    const agora = Date.now();
    if (
        businessHoursCache.value &&
        businessHoursCache.loadedAt &&
        (agora - businessHoursCache.loadedAt) < BUSINESS_HOURS_CACHE_TTL_MS
    ) {
        return businessHoursCache.value;
    }

    const salvo = await settingsColl.findOne({ _id: DEFAULT_BUSINESS_HOURS._id });
    const config = {
        ...DEFAULT_BUSINESS_HOURS,
        ...(salvo || {}),
        diasAtendimento: normalizarDiasAtendimento(salvo?.diasAtendimento || DEFAULT_BUSINESS_HOURS.diasAtendimento),
        timezone: BUSINESS_HOURS_TIMEZONE
    };

    businessHoursCache = { value: config, loadedAt: agora };
    return config;
}

function obterRelogioNoFuso(data = new Date(), timezone = BUSINESS_HOURS_TIMEZONE) {
    const partes = new Intl.DateTimeFormat('en-US', {
        timeZone: timezone,
        weekday: 'short',
        hour: '2-digit',
        minute: '2-digit',
        hourCycle: 'h23'
    }).formatToParts(data);

    const mapa = Object.fromEntries(partes.map(parte => [parte.type, parte.value]));
    const mapaDias = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };

    return {
        diaSemana: mapaDias[mapa.weekday],
        hora: Number(mapa.hour),
        minuto: Number(mapa.minute),
        minutosDoDia: (Number(mapa.hour) * 60) + Number(mapa.minute)
    };
}

async function verificarHorarioFuncionamento(data = new Date()) {
    const config = await carregarHorarioFuncionamento();

    // Se o controle estiver desativado pelo advogado, o robô funciona 24h.
    if (config.ativo === false) {
        return { aberto: true, config, motivo: 'controle_desativado' };
    }

    const relogio = obterRelogioNoFuso(data, config.timezone || BUSINESS_HOURS_TIMEZONE);
    const inicio = horaParaMinutos(config.inicio);
    const fim = horaParaMinutos(config.fim);
    const diaAtivo = normalizarDiasAtendimento(config.diasAtendimento).includes(relogio.diaSemana);
    const dentroDaFaixa = inicio !== null && fim !== null && relogio.minutosDoDia >= inicio && relogio.minutosDoDia < fim;

    return {
        aberto: diaAtivo && dentroDaFaixa,
        config,
        relogio,
        motivo: !diaAtivo ? 'dia_fora_atendimento' : (dentroDaFaixa ? 'aberto' : 'fora_da_faixa')
    };
}

function montarMensagemForaHorario(config = DEFAULT_BUSINESS_HOURS) {
    const inicio = horarioHHMMValido(config.inicio) ? config.inicio : DEFAULT_BUSINESS_HOURS.inicio;
    const fim = horarioHHMMValido(config.fim) ? config.fim : DEFAULT_BUSINESS_HOURS.fim;
    const modelo = String(config.mensagemForaHorario || DEFAULT_BUSINESS_HOURS.mensagemForaHorario).trim();

    return modelo
        .replace(/\{\{inicio\}\}/g, inicio)
        .replace(/\{\{fim\}\}/g, fim);
}

async function encaminharAutomaticamenteForaDoHorario(ticket, jid, { texto = '', isMedia = false, config } = {}) {
    if (!ticket) return;

    const agora = Date.now();

    // Fora do horário o ticket NÃO é pausado imediatamente. Primeiro aguardamos o
    // relato/documento do cliente; depois oferecemos o cadastro opcional, exatamente
    // como no fluxo normal, e só então encaminhamos para o especialista.
    await ticketsColl.updateOne(
        { _id: ticket._id },
        {
            $set: {
                status: 'aguardando_detalhes_fora_horario',
                aguardandoOpcao: false,
                aguardandoDetalhes: false,
                aguardandoDetalhesForaHorario: true,
                aguardandoPerguntaFluxo: false,
                aguardandoCadastroCliente: false,
                aguardandoNomeCadastro: false,
                aguardandoCPFCadastro: false,
                paused: false,
                until: null,
                foraHorario: true,
                fluxoForaHorarioIniciadoEm: agora,
                lastActivity: agora
            }
        }
    );

    await atualizarHistorico(ticket.ticketNumber, {
        status: 'aguardando_detalhes_fora_horario',
        foraHorario: true,
        fluxoForaHorarioIniciadoEm: agora,
        mensagemInicialForaHorario: String(texto || '').trim().slice(0, 5000) || null,
        mensagemInicialForaHorarioPossuiMidia: !!isMedia,
        horarioFuncionamentoAplicado: {
            inicio: config?.inicio || DEFAULT_BUSINESS_HOURS.inicio,
            fim: config?.fim || DEFAULT_BUSINESS_HOURS.fim,
            diasAtendimento: normalizarDiasAtendimento(config?.diasAtendimento || DEFAULT_BUSINESS_HOURS.diasAtendimento),
            timezone: BUSINESS_HOURS_TIMEZONE
        }
    });

    await sendBotMsg(jid, {
        text: montarMensagemForaHorario(config || DEFAULT_BUSINESS_HOURS)
    });

    console.log(`[Ticket ${ticket.ticketNumber}] Fluxo fora do horário iniciado; aguardando relato do cliente.`);
}

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
        'duvida resolvida',
        'parar por aqui',
        'podemos parar',
        'deixa pra la',
        'deixar pra depois',
        'nao quero continuar',
        'nao vou continuar',
        'prefiro encerrar',
        'vamos encerrar',
        'pode fechar',
        'nao tenho mais duvidas',
        'sem mais duvidas',
        'tchau',
        'ate mais'
    ];
    return frases.some(frase => valor.includes(frase));
}

function invalidarCacheKnowledge() {
    knowledgeCache = { items: [], loadedAt: 0 };
}

const STOPWORDS_IA = new Set([
    'a', 'o', 'as', 'os', 'um', 'uma', 'uns', 'umas', 'de', 'da', 'do', 'das', 'dos',
    'e', 'ou', 'em', 'no', 'na', 'nos', 'nas', 'para', 'por', 'com', 'sem', 'que', 'se',
    'eu', 'me', 'meu', 'minha', 'voce', 'voces', 'isso', 'isto', 'essa', 'esse', 'como',
    'qual', 'quais', 'quando', 'onde', 'porque', 'pra', 'pro', 'tem', 'ter', 'ser', 'esta'
]);

function tokensRelevantes(texto = '') {
    return [...new Set(
        normalizarTexto(texto)
            .replace(/[^a-z0-9\s]/g, ' ')
            .split(/\s+/)
            .filter(token => token.length >= 3 && !STOPWORDS_IA.has(token))
    )];
}

function pontuarItemKnowledge(texto, item) {
    const mensagem = normalizarTexto(texto);
    const pergunta = normalizarTexto(item?.pergunta || '');
    const resposta = normalizarTexto(item?.resposta || '');

    if (!mensagem || !pergunta) return 0;
    if (mensagem === pergunta) return 100;
    if (mensagem.includes(pergunta) || pergunta.includes(mensagem)) return 40;

    const tokensMensagem = new Set(tokensRelevantes(mensagem));
    if (!tokensMensagem.size) return 0;

    const tokensPergunta = new Set(tokensRelevantes(pergunta));
    const tokensResposta = new Set(tokensRelevantes(resposta));

    let score = 0;
    for (const token of tokensMensagem) {
        if (tokensPergunta.has(token)) score += 4;
        else if (tokensResposta.has(token)) score += 1;
    }

    return score;
}

async function carregarKnowledgeBase() {
    if (!knowledgeColl) return [];

    const agora = Date.now();
    if (knowledgeCache.loadedAt && (agora - knowledgeCache.loadedAt) < KNOWLEDGE_CACHE_TTL_MS) {
        return knowledgeCache.items;
    }

    const items = await knowledgeColl
        .find(
            { pergunta: { $type: 'string' }, resposta: { $type: 'string' } },
            { projection: { pergunta: 1, resposta: 1, updatedAt: 1 } }
        )
        .sort({ updatedAt: -1 })
        .limit(KNOWLEDGE_MAX_ITEMS)
        .toArray();

    knowledgeCache = { items, loadedAt: agora };
    return items;
}

async function obterCandidatosKnowledge(texto) {
    const items = await carregarKnowledgeBase();
    const ranqueados = items
        .map(item => ({ ...item, score: pontuarItemKnowledge(texto, item) }))
        .sort((a, b) => b.score - a.score);

    const candidatosFortes = ranqueados
        .filter(item => item.score >= 4)
        .slice(0, KNOWLEDGE_MAX_CANDIDATES);

    if (candidatosFortes.length) return candidatosFortes;

    // Se a mensagem é claramente uma pergunta, permitimos uma pequena janela semântica
    // com os itens mais recentes da base. O Gemini apenas seleciona um item existente;
    // ele não recebe autorização para criar uma resposta fora da base.
    if (possuiSinalDePergunta(texto)) {
        return ranqueados.slice(0, KNOWLEDGE_SEMANTIC_FALLBACK_ITEMS);
    }

    return [];
}

function possuiSinalDeEncerramento(texto = '') {
    const valor = normalizarTexto(texto);
    return [
        'encerr', 'finaliz', 'cancel', 'desist', 'parar por aqui', 'deixa pra la',
        'deixar pra depois', 'nao quero continuar', 'nao vou continuar', 'podemos parar',
        'obrigado era isso', 'obrigada era isso', 'valeu era isso'
    ].some(sinal => valor.includes(sinal));
}

function possuiSinalDePergunta(texto = '') {
    const valor = normalizarTexto(texto);
    if (!valor) return false;
    if (texto.includes('?')) return true;

    return /^(como|qual|quais|quando|onde|por que|porque|posso|pode|preciso|existe|tem|quanto|gostaria de saber|queria saber|duvida|dúvida|saber)\b/.test(valor);
}

function entradaEstruturadaDoFluxo(ticket, texto = '') {
    const valor = normalizarTexto(texto);

    if (ticket?.aguardandoOpcao && /^\d{1,3}$/.test(String(texto).trim())) return true;
    // Durante a triagem, respostas comuns seguem direto para o fluxo. Se o cliente
    // fizer uma pergunta explícita, a knowledge_base ainda pode respondê-la e depois
    // repetir a pergunta atual da triagem.
    if (ticket?.aguardandoPerguntaFluxo && !possuiSinalDePergunta(texto)) return true;
    if (ticket?.aguardandoCadastroCliente && (respostaPositiva(texto) || respostaNegativa(texto))) return true;
    if (ticket?.aguardandoCPFCadastro && /^\d{11}$/.test(texto.replace(/\D/g, ''))) return true;

    // Nome simples não deve acionar IA sem necessidade. Frases com sinais de pergunta/encerramento
    // continuam passando pela IA antes da validação do nome.
    if (
        ticket?.aguardandoNomeCadastro &&
        validarNomeESobrenome(texto) &&
        !possuiSinalDePergunta(texto) &&
        !possuiSinalDeEncerramento(texto)
    ) {
        return true;
    }

    return ['1', '2', 'sim', 'nao', 'não', 's', 'n'].includes(valor);
}

function extrairJsonIA(raw = '') {
    const limpo = String(raw)
        .trim()
        .replace(/^```json\s*/i, '')
        .replace(/^```\s*/i, '')
        .replace(/```$/i, '')
        .trim();

    const inicio = limpo.indexOf('{');
    const fim = limpo.lastIndexOf('}');
    if (inicio === -1 || fim === -1 || fim <= inicio) return null;

    try {
        return JSON.parse(limpo.slice(inicio, fim + 1));
    } catch (_) {
        return null;
    }
}

async function mensagemRetomadaFluxo(ticket) {
    if (!ticket) return '';

    if (ticket.aguardandoOpcao) {
        const menuTexto = await gerarMenuTexto();
        return `\n\nPara continuar o atendimento, escolha uma opção digitando apenas o número:\n\n${menuTexto}`;
    }

    if (ticket.aguardandoPerguntaFluxo) {
        const perguntaAtual = perguntaAtualDoTicket(ticket);
        if (perguntaAtual?.texto) {
            return `\n\nPara continuar o ticket *${ticket.ticketNumber}*:\n\n${formatarPerguntaParaEnvio(perguntaAtual)}`;
        }
    }

    if (ticket.aguardandoDetalhesForaHorario) {
        return `\n\nPara continuar o ticket *${ticket.ticketNumber}*, conte detalhadamente o que aconteceu. Pode responder por texto, áudio ou enviar documentos.`;
    }

    if (ticket.aguardandoDetalhes) {
        return `\n\nPara continuar o ticket *${ticket.ticketNumber}*, conte brevemente o que aconteceu no seu caso. Pode responder por texto ou áudio.`;
    }

    if (ticket.aguardandoCadastroCliente) {
        return `\n\n${PERGUNTA_CADASTRO_CLIENTE}`;
    }

    if (ticket.aguardandoNomeCadastro) {
        return `\n\nPara continuar o cadastro, informe seu *nome e sobrenome*.`;
    }

    if (ticket.aguardandoCPFCadastro) {
        return `\n\nPara continuar o cadastro, informe seu *CPF* com 11 números.`;
    }

    if (ticket.paused || ['aguardando_especialista', 'em_atendimento_humano'].includes(ticket.status)) {
        return `\n\nSeu ticket *${ticket.ticketNumber}* permanece em atendimento pela nossa equipe.`;
    }

    return '';
}

async function analisarMensagemComIA(texto, ticket) {
    if (!texto || !ticket) return null;

    // Encerramentos inequívocos continuam funcionando inclusive durante a triagem sequencial.
    if (clienteQuerEncerrar(texto)) {
        return { acao: 'ENCERRAR', origem: 'regra' };
    }

    // Respostas das perguntas sequenciais são dados do caso e não devem ser consumidas pela IA.
    if (entradaEstruturadaDoFluxo(ticket, texto)) return null;

    // Quando um atendente humano já assumiu a conversa, a IA não responde FAQs para não
    // disputar o diálogo. Ainda permitimos a análise semântica de encerramento logo abaixo.
    const atendimentoHumanoAtivo = ticket.status === 'em_atendimento_humano';
    if (atendimentoHumanoAtivo && !possuiSinalDeEncerramento(texto)) {
        return null;
    }

    let candidatos = [];
    try {
        candidatos = await obterCandidatosKnowledge(texto);
    } catch (err) {
        console.warn('[IA] Falha ao consultar base de conhecimento:', err?.message || err);
    }

    const sinalEncerramento = possuiSinalDeEncerramento(texto);
    const sinalPergunta = possuiSinalDePergunta(texto);

    // Sem indício de encerramento e sem qualquer proximidade com a base, a IA nem é acionada.
    // Isso reduz custo e evita enviar resumos de casos jurídicos desnecessariamente ao modelo.
    if (!sinalEncerramento && !candidatos.length) return null;

    // Fallback resiliente: se o Gemini estiver indisponível, uma correspondência exata/forte
    // ainda pode ser respondida diretamente com o conteúdo já aprovado da base.
    if (!geminiModel) {
        const melhor = candidatos[0];
        if (sinalPergunta && melhor && melhor.score >= 40) {
            return { acao: 'RESPONDER_BASE', resposta: melhor.resposta, origem: 'fallback_base' };
        }
        return null;
    }

    const baseContexto = candidatos.length
        ? candidatos.map((item, index) => (
            `[${index + 1}] PERGUNTA: ${item.pergunta}\nRESPOSTA: ${item.resposta}`
        )).join('\n\n')
        : '(nenhum item relevante localizado na base)';

    const prompt = `Você é o roteador de atendimento da Azevedo & Juvencio Advogados.

Sua tarefa é classificar APENAS a mensagem atual do cliente.

ESTADO ATUAL DO TICKET: ${ticket.status || 'não informado'}
MENSAGEM DO CLIENTE: ${JSON.stringify(texto)}

BASE DE CONHECIMENTO CANDIDATA:
${baseContexto}

Responda SOMENTE em JSON válido, sem markdown, neste formato:
{"acao":"ENCERRAR|RESPONDER_BASE|NENHUMA","indiceBase":null}

REGRAS OBRIGATÓRIAS:
1. Use ENCERRAR somente quando houver intenção clara de terminar, desistir, cancelar ou não prosseguir com o atendimento.
2. Se o estado for aguardando_cadastro, respostas que se limitem a recusar o cadastro opcional, como "não", "não quero" ou "agora não", NÃO encerram o atendimento. Porém, se o cliente disser claramente que não quer continuar o atendimento, aí use ENCERRAR.
3. Use RESPONDER_BASE somente quando a mensagem for uma pergunta ou pedido de informação e UM dos itens da base responder diretamente ao que foi perguntado.
4. Ao usar RESPONDER_BASE, informe em indiceBase o número do item escolhido, começando em 1. Não escreva uma resposta nova.
5. Nunca invente, complete, combine itens ou dê orientação jurídica além da base.
6. Se a mensagem apenas narrar o caso, enviar dados, nome, CPF, documento, opção de menu ou não puder ser respondida com segurança pela base, use NENHUMA e indiceBase null.
7. Em caso de dúvida, prefira NENHUMA.`;

    try {
        const result = await geminiModel.generateContent(prompt);
        const response = await result.response;
        const parsed = extrairJsonIA(response.text());

        if (!parsed || !['ENCERRAR', 'RESPONDER_BASE', 'NENHUMA'].includes(parsed.acao)) {
            console.warn('[IA] Resposta inválida do roteador.');
            return null;
        }

        if (parsed.acao === 'RESPONDER_BASE') {
            const indice = Number(parsed.indiceBase);
            const itemSelecionado = Number.isInteger(indice) && indice >= 1
                ? candidatos[indice - 1]
                : null;

            if (!itemSelecionado?.resposta) return null;

            return {
                acao: 'RESPONDER_BASE',
                resposta: String(itemSelecionado.resposta).trim().slice(0, 3000),
                origem: 'gemini'
            };
        }

        if (parsed.acao === 'ENCERRAR') {
            return { acao: 'ENCERRAR', origem: 'gemini' };
        }

        return null;
    } catch (err) {
        console.error('[IA] Erro ao analisar mensagem:', err?.message || err);

        const melhor = candidatos[0];
        if (sinalPergunta && melhor && melhor.score >= 40) {
            return { acao: 'RESPONDER_BASE', resposta: melhor.resposta, origem: 'fallback_base' };
        }
        return null;
    }
}

async function encerrarTicketPorCliente(ticket, jid) {
    if (!ticket) return;

    await sendBotMsg(jid, {
        text: `Atendimento *${ticket.ticketNumber}* encerrado. Obrigado pelo contato! Ficamos à disposição. 👋`
    });

    await atualizarHistorico(ticket.ticketNumber, {
        status: 'encerrado',
        closedAt: Date.now(),
        encerradoPeloCliente: true
    });

    await ticketsColl.deleteOne({ _id: ticket._id });
}

async function responderInterrupcaoIA(ticket, jid, analiseIA) {
    if (!analiseIA) return false;

    if (analiseIA.acao === 'ENCERRAR') {
        await encerrarTicketPorCliente(ticket, jid);
        return true;
    }

    if (analiseIA.acao === 'RESPONDER_BASE') {
        const retomada = await mensagemRetomadaFluxo(ticket);
        await sendBotMsg(jid, {
            text: `${analiseIA.resposta}${retomada}`
        });

        await ticketsColl.updateOne(
            { _id: ticket._id },
            { $set: { lastActivity: Date.now() } }
        );

        await atualizarHistorico(ticket.ticketNumber, {
            ultimaRespostaIAEm: Date.now()
        });

        console.log(`[Ticket ${ticket.ticketNumber}] IA respondeu com base na knowledge_base (${analiseIA.origem}).`);
        return true;
    }

    return false;
}

async function confirmarMensagemAguardandoEspecialista(ticket, jid) {
    if (!ticket || ticket.status !== 'aguardando_especialista') return;

    const agora = Date.now();
    const intervaloMinimo = 15 * 60 * 1000;
    if (agora - (ticket.lastAutoAckAt || 0) < intervaloMinimo) return;

    await sendBotMsg(jid, {
        text: `📩 Recebemos sua mensagem e ela foi adicionada ao ticket *${ticket.ticketNumber}*. Nossa equipe dará continuidade ao atendimento.`
    });

    await ticketsColl.updateOne(
        { _id: ticket._id },
        {
            $set: {
                lastAutoAckAt: agora,
                lastActivity: agora
            }
        }
    );
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

function normalizarNumeroWhatsApp(valor = '') {
    if (!valor) return null;

    const texto = String(valor).trim();
    const numeroJid = numeroDePnJid(normalizarJid(texto));
    if (numeroJid) return numeroJid;

    // Só aceita valores que já sejam essencialmente um telefone.
    // Não tentamos converter LID em telefone porque o número interno do @lid
    // não corresponde necessariamente ao número real do WhatsApp.
    if (texto.includes('@lid')) return null;

    const digitos = texto.replace(/\D/g, '');
    return digitos.length >= 10 && digitos.length <= 15 ? digitos : null;
}

function extrairNumeroWhatsAppDeFontes(...fontes) {
    const fila = [...fontes];

    while (fila.length) {
        const valor = fila.shift();
        if (valor === null || valor === undefined) continue;

        if (Array.isArray(valor)) {
            fila.push(...valor);
            continue;
        }

        const numero = normalizarNumeroWhatsApp(valor);
        if (numero) return numero;
    }

    return null;
}

async function resolverPnDeLids(...fontes) {
    if (!sock?.signalRepository?.lidMapping?.getPNForLID) return null;

    const fila = [...fontes];
    const lids = new Set();

    while (fila.length) {
        const valor = fila.shift();
        if (valor === null || valor === undefined) continue;

        if (Array.isArray(valor)) {
            fila.push(...valor);
            continue;
        }

        const jid = normalizarJid(String(valor));
        if (jid?.endsWith('@lid')) lids.add(jid);
    }

    for (const lid of lids) {
        try {
            const pn = await sock.signalRepository.lidMapping.getPNForLID(lid);
            const numero = normalizarNumeroWhatsApp(pn);
            if (numero) return { numero, pnJid: normalizarJid(pn), lid };
        } catch (err) {
            console.warn(`[LID] Não foi possível resolver ${lid}:`, err?.message || err);
        }
    }

    return null;
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
    adicionarJid(msg?.key?.participant);
    adicionarJid(msg?.key?.participantAlt);

    // Mantemos também os campos de versões anteriores, caso a instalação atual
    // do Baileys ainda os exponha.
    adicionarJid(msg?.key?.participantPn);
    adicionarJid(msg?.participantPn);

    const jidNormalizado = normalizarJid(rawJid);

    // Tenta resolver qualquer LID observado na mensagem para o PN real.
    // Isso cobre situações em que o WhatsApp entrega o contato usando @lid.
    const mapeamentoLid = await resolverPnDeLids([...jids]);
    if (mapeamentoLid?.pnJid) adicionarJid(mapeamentoLid.pnJid);

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

async function mensagemRecepcao(cliente, ticketNumber) {
    const menuTexto = await gerarMenuTexto();

    if (cliente?.nome) {
        return `Olá, ${primeiroNome(cliente.nome)}! Seja bem-vindo de volta à *Azevedo & Juvencio Advogados*. 👋

Seu novo atendimento é o ticket *${ticketNumber}*.

Segue as opções. Digite apenas o número:

${menuTexto}`;
    }

    return `Olá! Seja bem-vindo à *Azevedo & Juvencio Advogados*. 👋

Seu atendimento é o ticket *${ticketNumber}*.

Para começar, escolha uma opção digitando apenas o número:

${menuTexto}`;
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
        aguardandoDetalhesForaHorario: false,
        aguardandoPerguntaFluxo: false,
        perguntasFluxo: [],
        indicePerguntaFluxo: 0,
        respostasFluxo: [],
        tentativasInvalidasPerguntaFluxo: 0,
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
                aguardandoPerguntaFluxo: false,
                aguardandoDetalhesForaHorario: false,
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

async function concluirTriagemEAvancar(ticket, jid) {
    const agora = Date.now();

    await ticketsColl.updateOne(
        { _id: ticket._id },
        {
            $set: {
                aguardandoPerguntaFluxo: false,
                indicePerguntaFluxo: Array.isArray(ticket.perguntasFluxo) ? ticket.perguntasFluxo.length : 0,
                status: ticket.clienteCadastrado ? 'aguardando_especialista' : 'aguardando_cadastro',
                lastActivity: agora
            }
        }
    );

    if (ticket.clienteCadastrado) {
        await encaminharParaEspecialista(
            ticket,
            jid,
            `✅ Obrigado pelas informações. Seu ticket *${ticket.ticketNumber}* foi encaminhado para nossa equipe. Um especialista dará continuidade ao atendimento.`
        );
        return;
    }

    await sendBotMsg(jid, {
        text: `✅ Obrigado pelas informações. Seu atendimento está registrado no ticket *${ticket.ticketNumber}*.\n\n${PERGUNTA_CADASTRO_CLIENTE}`
    });

    await ticketsColl.updateOne(
        { _id: ticket._id },
        {
            $set: {
                aguardandoCadastroCliente: true,
                status: 'aguardando_cadastro',
                lastActivity: agora
            }
        }
    );

    await atualizarHistorico(ticket.ticketNumber, {
        status: 'aguardando_cadastro',
        triagemConcluidaEm: agora
    });
}

async function salvarCadastroCliente(ticket, contato, rawJid, nomeInfo, cpfLimpo) {
    const agora = Date.now();

    // O número pode ter sido identificado em uma mensagem anterior do mesmo ticket,
    // mesmo que a mensagem do CPF tenha chegado apenas com @lid. Por isso juntamos
    // os dados acumulados no ticket com os identificadores da mensagem atual.
    const identificadoresMesclados = [...new Set([
        ...(Array.isArray(ticket?.identificadores) ? ticket.identificadores : []),
        ...(Array.isArray(contato?.identificadores) ? contato.identificadores : []),
        rawJid
    ].filter(Boolean))];

    const numerosMesclados = [...new Set([
        ...(Array.isArray(ticket?.whatsappNumbers) ? ticket.whatsappNumbers : []),
        ...(Array.isArray(contato?.whatsappNumbers) ? contato.whatsappNumbers : []),
        ticket?.numeroReal,
        contato?.numeroPrincipal
    ].map(normalizarNumeroWhatsApp).filter(Boolean))];

    let numeroPrincipal = extrairNumeroWhatsAppDeFontes(
        contato?.numeroPrincipal,
        ticket?.numeroReal,
        numerosMesclados,
        identificadoresMesclados
    );

    // Última tentativa: se só houver LID, pede ao repositório do Baileys o PN real.
    if (!numeroPrincipal) {
        const resolvido = await resolverPnDeLids(identificadoresMesclados, ticket?.lastRawJid, rawJid);
        if (resolvido?.numero) {
            numeroPrincipal = resolvido.numero;
            numerosMesclados.push(resolvido.numero);
            if (resolvido.pnJid) identificadoresMesclados.push(resolvido.pnJid);
        }
    }

    const camposCliente = {
        cpf: cpfLimpo,
        nome: nomeInfo.nome,
        sobrenome: nomeInfo.sobrenome,
        nomeCompleto: nomeInfo.nomeCompleto,
        lastRawJid: rawJid,
        updatedAt: agora,
        lastSeenAt: agora
    };

    // Não sobrescreve um número já salvo com null/undefined.
    if (numeroPrincipal) camposCliente.numeroReal = numeroPrincipal;

    await clientsColl.updateOne(
        { _id: cpfLimpo },
        {
            $set: camposCliente,
            $setOnInsert: {
                createdAt: agora
            },
            $addToSet: {
                identificadores: { $each: [...new Set(identificadoresMesclados.filter(Boolean))] },
                whatsappNumbers: { $each: [...new Set(numerosMesclados.filter(Boolean))] },
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
        menuOptionsColl = db.collection('menu_options');
        settingsColl = db.collection('settings');

        // Cria as opções atuais e o horário padrão somente se ainda não existirem.
        await garantirMenuPadrao();
        await garantirHorarioFuncionamentoPadrao();

        // Índices para manter CPF e número de ticket únicos e acelerar a identificação do cliente.
        await Promise.all([
            clientsColl.createIndex({ cpf: 1 }, { unique: true, sparse: true }),
            clientsColl.createIndex({ identificadores: 1 }),
            clientsColl.createIndex({ whatsappNumbers: 1 }),
            ticketHistoryColl.createIndex({ ticketNumber: 1 }, { unique: true }),
            ticketHistoryColl.createIndex({ identificadores: 1 }),
            ticketsColl.createIndex({ ticketNumber: 1 }, { unique: true, sparse: true }),
            menuOptionsColl.createIndex({ ordem: 1 })
        ]);
        
        apiKeysColl = db.collection('api_keys');
        const geminiKeyDoc = await apiKeysColl.findOne({ nome: "gemini" });
        
        if (geminiKeyDoc && geminiKeyDoc.chave) {
            genAI = new GoogleGenerativeAI(geminiKeyDoc.chave);
            geminiModel = genAI.getGenerativeModel(
                { model: "gemini-3.1-flash-lite-preview" },
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

        // Antes de iniciar/continuar menu ou triagem, verifica o horário do escritório.
        // Fora do horário iniciamos um fluxo específico: mensagem de aviso -> relato/documentos
        // -> cadastro opcional -> encaminhamento ao especialista. Conversas humanas e cadastros
        // já iniciados não são interrompidos pela virada do horário.
        const ticketExpirouAntesDoHorario = !!(
            ticket &&
            !ticket.paused &&
            (Date.now() - (ticket.lastActivity || 0) > timeoutNovoAtendimento)
        );

        if (ticketExpirouAntesDoHorario) {
            await fecharTicketAnterior(ticket, 'encerrado_timeout');
            ticket = null;
        }

        const situacaoHorario = await verificarHorarioFuncionamento();
        const atendimentoHumanoJaAtivo = ticket?.status === 'em_atendimento_humano';
        const jaAguardandoEspecialista = ticket?.status === 'aguardando_especialista';
        const cadastroJaEmAndamento = !!(
            ticket?.aguardandoCadastroCliente ||
            ticket?.aguardandoNomeCadastro ||
            ticket?.aguardandoCPFCadastro
        );
        const fluxoForaHorarioJaIniciado = !!ticket?.aguardandoDetalhesForaHorario;

        if (
            !situacaoHorario.aberto &&
            !atendimentoHumanoJaAtivo &&
            !jaAguardandoEspecialista &&
            !cadastroJaEmAndamento &&
            !fluxoForaHorarioJaIniciado
        ) {
            if (!ticket) {
                const cliente = await buscarClientePorContato(contato);
                ticket = await criarNovoTicket({
                    contato,
                    rawJid,
                    textoInicial: texto,
                    cliente,
                    paused: false
                });
            }

            await encaminharAutomaticamenteForaDoHorario(ticket, rawJid, {
                texto,
                isMedia,
                config: situacaoHorario.config
            });
            return;
        }

        // A IA funciona como uma interrupção controlada do fluxo:
        // - encerra o ticket quando o cliente claramente quiser parar;
        // - responde dúvidas cobertas pela knowledge_base;
        // - não consome respostas estruturadas de menu/cadastro/CPF.
        // Fazemos a análise antes do "paused" para não deixar dúvidas da base sem resposta
        // enquanto o ticket aguarda um especialista.
        const analiseIAPrevia = ticket && texto
            ? await analisarMensagemComIA(texto, ticket)
            : null;

        if (analiseIAPrevia?.acao === 'ENCERRAR') {
            await responderInterrupcaoIA(ticket, rawJid, analiseIAPrevia);
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
                if (
                    ticket.status !== 'em_atendimento_humano' &&
                    analiseIAPrevia?.acao === 'RESPONDER_BASE'
                ) {
                    await responderInterrupcaoIA(ticket, rawJid, analiseIAPrevia);
                    return;
                }

                // Se apenas está aguardando a equipe e a pergunta não existe na base,
                // ao menos confirma o recebimento. Durante conversa humana ativa, fica silencioso.
                await confirmarMensagemAguardandoEspecialista(ticket, rawJid);

                console.log(`[Ticket ${ticket.ticketNumber}] Bot pausado (${ticket.status}).`);
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
                text: await mensagemRecepcao(cliente, ticket.ticketNumber)
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

        // Se a mensagem atual era uma dúvida respondível pela base, responde agora e mantém
        // exatamente o mesmo passo do fluxo para a próxima mensagem do cliente.
        if (analiseIAPrevia?.acao === 'RESPONDER_BASE') {
            await responderInterrupcaoIA(ticket, rawJid, analiseIAPrevia);
            return;
        }

        // 0.5) FLUXO FORA DO HORÁRIO - recebe o relato e só depois oferece o cadastro.
        if (ticket.aguardandoDetalhesForaHorario) {
            if (!texto && !isMedia) {
                await sendBotMsg(rawJid, {
                    text: `Para agilizar o atendimento, conte detalhadamente o que aconteceu. Pode responder por texto, áudio ou enviar documentos por aqui.`
                });
                return;
            }

            const agora = Date.now();
            await ticketsColl.updateOne(
                { _id: ticket._id },
                {
                    $set: {
                        aguardandoDetalhesForaHorario: false,
                        status: ticket.clienteCadastrado ? 'aguardando_especialista' : 'aguardando_cadastro',
                        lastActivity: agora
                    }
                }
            );

            await atualizarHistorico(ticket.ticketNumber, {
                status: ticket.clienteCadastrado ? 'aguardando_especialista' : 'aguardando_cadastro',
                detalhesForaHorarioRecebidosEm: agora,
                ultimoRelatoForaHorario: String(texto || '').trim().slice(0, 5000) || null,
                ultimoRelatoForaHorarioPossuiMidia: !!isMedia
            });

            if (ticket.clienteCadastrado) {
                await encaminharParaEspecialista(
                    ticket,
                    rawJid,
                    `✅ Recebido! Seu ticket *${ticket.ticketNumber}* foi encaminhado para nossa equipe. Um especialista dará continuidade ao atendimento no próximo período de atendimento.`
                );
                return;
            }

            await sendBotMsg(rawJid, {
                text: `✅ Recebemos as informações do seu caso. Seu atendimento está registrado no ticket *${ticket.ticketNumber}*.\n\n${PERGUNTA_CADASTRO_CLIENTE}`
            });

            await ticketsColl.updateOne(
                { _id: ticket._id },
                {
                    $set: {
                        aguardandoCadastroCliente: true,
                        status: 'aguardando_cadastro',
                        lastActivity: agora
                    }
                }
            );

            await atualizarHistorico(ticket.ticketNumber, {
                status: 'aguardando_cadastro',
                triagemForaHorarioConcluidaEm: agora
            });
            return;
        }

        // 1) MENU PRINCIPAL - opções carregadas dinamicamente do MongoDB
        if (ticket.aguardandoOpcao) {
            const opcaoSelecionada = await buscarOpcaoMenu(texto);

            if (!opcaoSelecionada) {
                const menuTexto = await gerarMenuTexto();
                await sendBotMsg(rawJid, {
                    text: `Por favor, digite apenas o número da opção desejada:\n\n${menuTexto}`
                });
                return;
            }

            const area = String(opcaoSelecionada.area || opcaoSelecionada.titulo || 'Outros Assuntos').trim();
            const respostaArea = String(opcaoSelecionada.resposta || '').trim();
            const perguntasFluxo = perguntasAtivasDaOpcao(opcaoSelecionada);
            const agora = Date.now();

            // Nova lógica: quando a opção possui perguntas, criamos um snapshot no ticket.
            // Assim, editar a opção no painel não altera uma triagem que já está em andamento.
            if (perguntasFluxo.length) {
                await ticketsColl.updateOne(
                    { _id: ticket._id },
                    {
                        $set: {
                            area,
                            menuOptionId: opcaoSelecionada._id,
                            menuOptionTitle: opcaoSelecionada.titulo,
                            menuOptionEmoji: opcaoSelecionada.emoji || '',
                            status: 'aguardando_pergunta_fluxo',
                            aguardandoOpcao: false,
                            aguardandoDetalhes: false,
                            aguardandoPerguntaFluxo: true,
                            perguntasFluxo,
                            indicePerguntaFluxo: 0,
                            respostasFluxo: [],
                            tentativasInvalidasPerguntaFluxo: 0,
                            lastActivity: agora
                        }
                    }
                );

                await atualizarHistorico(ticket.ticketNumber, {
                    area,
                    menuOptionId: opcaoSelecionada._id,
                    menuOptionTitle: opcaoSelecionada.titulo,
                    menuOptionEmoji: opcaoSelecionada.emoji || '',
                    status: 'aguardando_pergunta_fluxo',
                    perguntasTriagem: perguntasFluxo.map(({ id, texto, respostasAceitas, ordem }) => ({ id, texto, respostasAceitas: respostasAceitas || [], ordem })),
                    respostasTriagem: []
                });

                if (respostaArea) {
                    await sendBotMsg(rawJid, { text: respostaArea });
                }

                await sendBotMsg(rawJid, { text: formatarPerguntaParaEnvio(perguntasFluxo[0]) });
                return;
            }

            // Compatibilidade: opções antigas, sem perguntas configuradas, continuam usando
            // a mensagem única de detalhes exatamente como antes.
            if (respostaArea) {
                await sendBotMsg(rawJid, { text: respostaArea });
            } else {
                await sendBotMsg(rawJid, {
                    text: `Conte brevemente o que aconteceu no seu caso. Pode responder por texto ou áudio.`
                });
            }

            await ticketsColl.updateOne(
                { _id: ticket._id },
                {
                    $set: {
                        area,
                        menuOptionId: opcaoSelecionada._id,
                        menuOptionTitle: opcaoSelecionada.titulo,
                        menuOptionEmoji: opcaoSelecionada.emoji || '',
                        status: 'aguardando_detalhes',
                        aguardandoOpcao: false,
                        aguardandoDetalhes: true,
                        aguardandoPerguntaFluxo: false,
                        lastActivity: agora
                    }
                }
            );

            await atualizarHistorico(ticket.ticketNumber, {
                area,
                menuOptionId: opcaoSelecionada._id,
                menuOptionTitle: opcaoSelecionada.titulo,
                menuOptionEmoji: opcaoSelecionada.emoji || '',
                status: 'aguardando_detalhes'
            });
            return;
        }

        // 2) TRIAGEM SEQUENCIAL - uma pergunta por vez
        if (ticket.aguardandoPerguntaFluxo) {
            const perguntas = Array.isArray(ticket.perguntasFluxo) ? ticket.perguntasFluxo : [];
            const indiceAtual = Number.isInteger(ticket.indicePerguntaFluxo) ? ticket.indicePerguntaFluxo : 0;
            const perguntaAtual = perguntas[indiceAtual];

            // Proteção contra tickets inconsistentes.
            if (!perguntaAtual) {
                await concluirTriagemEAvancar(ticket, rawJid);
                return;
            }

            if (!texto && !isMedia) {
                await sendBotMsg(rawJid, {
                    text: `Para continuar, responda à pergunta abaixo:\n\n${formatarPerguntaParaEnvio(perguntaAtual)}`
                });
                return;
            }

            const tentativasInvalidasAtuais = Number.isInteger(ticket.tentativasInvalidasPerguntaFluxo)
                ? ticket.tentativasInvalidasPerguntaFluxo
                : 0;

            // Primeiro valida sem revelar as respostas aceitas.
            let validacaoResposta = validarRespostaDaPergunta(
                perguntaAtual,
                texto,
                isMedia,
                { mostrarOpcoes: false }
            );

            if (!validacaoResposta.valida) {
                const novaTentativaInvalida = tentativasInvalidasAtuais + 1;
                const mostrarOpcoes = novaTentativaInvalida >= EXIBIR_OPCOES_APOS_TENTATIVAS_INVALIDAS;

                // A lista só é exibida quando o cliente já errou o número configurado de vezes.
                if (mostrarOpcoes) {
                    validacaoResposta = validarRespostaDaPergunta(
                        perguntaAtual,
                        texto,
                        isMedia,
                        { mostrarOpcoes: true }
                    );
                }

                await sendBotMsg(rawJid, { text: validacaoResposta.mensagem });
                await ticketsColl.updateOne(
                    { _id: ticket._id },
                    {
                        $set: {
                            tentativasInvalidasPerguntaFluxo: novaTentativaInvalida,
                            lastActivity: Date.now()
                        }
                    }
                );

                ticket.tentativasInvalidasPerguntaFluxo = novaTentativaInvalida;
                return;
            }

            let tipoResposta = 'texto';
            if (msg.message.audioMessage) tipoResposta = 'audio';
            else if (msg.message.imageMessage) tipoResposta = 'imagem';
            else if (msg.message.videoMessage) tipoResposta = 'video';
            else if (msg.message.documentMessage) tipoResposta = 'documento';

            const respostaRegistrada = {
                perguntaId: perguntaAtual.id,
                pergunta: perguntaAtual.texto,
                respostasAceitas: Array.isArray(perguntaAtual.respostasAceitas) ? perguntaAtual.respostasAceitas : [],
                resposta: texto || `[${tipoResposta} recebido]`,
                tipo: tipoResposta,
                respondidaEm: Date.now()
            };

            const respostasAtualizadas = [
                ...(Array.isArray(ticket.respostasFluxo) ? ticket.respostasFluxo : []),
                respostaRegistrada
            ];
            const proximoIndice = indiceAtual + 1;
            const temProximaPergunta = proximoIndice < perguntas.length;

            await ticketsColl.updateOne(
                { _id: ticket._id },
                {
                    $set: {
                        respostasFluxo: respostasAtualizadas,
                        indicePerguntaFluxo: proximoIndice,
                        aguardandoPerguntaFluxo: temProximaPergunta,
                        status: temProximaPergunta ? 'aguardando_pergunta_fluxo' : (ticket.clienteCadastrado ? 'aguardando_especialista' : 'aguardando_cadastro'),
                        lastActivity: Date.now()
                    }
                }
            );

            await atualizarHistorico(ticket.ticketNumber, {
                respostasTriagem: respostasAtualizadas,
                triagemPerguntaAtual: proximoIndice,
                triagemTotalPerguntas: perguntas.length,
                ...(temProximaPergunta ? {} : { triagemConcluidaEm: Date.now() })
            });

            if (temProximaPergunta) {
                await sendBotMsg(rawJid, { text: formatarPerguntaParaEnvio(perguntas[proximoIndice]) });
                return;
            }

            // Atualiza a cópia local antes de reutilizar a função de finalização.
            ticket.respostasFluxo = respostasAtualizadas;
            ticket.indicePerguntaFluxo = proximoIndice;
            ticket.tentativasInvalidasPerguntaFluxo = 0;
            ticket.aguardandoPerguntaFluxo = false;
            await concluirTriagemEAvancar(ticket, rawJid);
            return;
        }

        // 2.1) FLUXO ANTIGO - recebe um único bloco de detalhes quando não há perguntas cadastradas
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
        const menuTextoSeguranca = await gerarMenuTexto();
        await sendBotMsg(rawJid, {
            text: `Vamos continuar pelo ticket *${ticket.ticketNumber}*. Escolha uma opção:\n\n${menuTextoSeguranca}`
        });
        await ticketsColl.updateOne(
            { _id: ticket._id },
            {
                $set: {
                    status: 'aguardando_opcao',
                    aguardandoOpcao: true,
                    aguardandoDetalhes: false,
                    aguardandoPerguntaFluxo: false,
                    perguntasFluxo: [],
                    indicePerguntaFluxo: 0,
                    respostasFluxo: [],
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

// Horário de funcionamento configurável pelo advogado no painel.
app.get('/api/business-hours', async (req, res) => {
    if (!req.session.loggedIn) return res.status(401).send('Acesso negado');

    try {
        const config = await carregarHorarioFuncionamento();
        res.json({
            ativo: config.ativo !== false,
            inicio: config.inicio,
            fim: config.fim,
            diasAtendimento: normalizarDiasAtendimento(config.diasAtendimento),
            timezone: BUSINESS_HOURS_TIMEZONE,
            mensagemForaHorario: config.mensagemForaHorario
        });
    } catch (err) {
        console.error('[Horário] Erro ao carregar configuração:', err);
        res.status(500).json({ erro: 'Não foi possível carregar o horário de funcionamento.' });
    }
});

app.put('/api/business-hours', async (req, res) => {
    if (!req.session.loggedIn) return res.status(401).send('Acesso negado');
    if (!settingsColl) return res.status(503).json({ erro: 'Banco de dados ainda não está disponível.' });

    try {
        const ativo = req.body?.ativo !== false;
        const inicio = String(req.body?.inicio || '').trim();
        const fim = String(req.body?.fim || '').trim();
        const diasAtendimento = normalizarDiasAtendimento(req.body?.diasAtendimento);
        const mensagemForaHorario = String(req.body?.mensagemForaHorario || '').trim();

        if (!horarioHHMMValido(inicio) || !horarioHHMMValido(fim)) {
            return res.status(400).json({ erro: 'Informe os horários de início e término no formato HH:MM.' });
        }

        if (horaParaMinutos(fim) <= horaParaMinutos(inicio)) {
            return res.status(400).json({ erro: 'O horário de término deve ser posterior ao horário de início.' });
        }

        if (!diasAtendimento.length) {
            return res.status(400).json({ erro: 'Selecione pelo menos um dia de atendimento.' });
        }

        if (!mensagemForaHorario || mensagemForaHorario.length > 2000) {
            return res.status(400).json({ erro: 'A mensagem fora do horário deve possuir entre 1 e 2.000 caracteres.' });
        }

        const agora = Date.now();
        await settingsColl.updateOne(
            { _id: DEFAULT_BUSINESS_HOURS._id },
            {
                $set: {
                    ativo,
                    inicio,
                    fim,
                    diasAtendimento,
                    timezone: BUSINESS_HOURS_TIMEZONE,
                    mensagemForaHorario,
                    updatedAt: agora
                },
                $setOnInsert: { createdAt: agora }
            },
            { upsert: true }
        );

        invalidarCacheHorarioFuncionamento();
        const atualizado = await carregarHorarioFuncionamento();
        res.json({
            ativo: atualizado.ativo !== false,
            inicio: atualizado.inicio,
            fim: atualizado.fim,
            diasAtendimento: atualizado.diasAtendimento,
            timezone: BUSINESS_HOURS_TIMEZONE,
            mensagemForaHorario: atualizado.mensagemForaHorario
        });
    } catch (err) {
        console.error('[Horário] Erro ao salvar configuração:', err);
        res.status(500).json({ erro: 'Não foi possível salvar o horário de funcionamento.' });
    }
});

// Sugestão assistida por IA para respostas aceitas de uma pergunta da triagem.
// A IA apenas propõe opções para o painel; nada é salvo automaticamente no MongoDB.
app.post('/api/triage/suggest-answers', async (req, res) => {
    if (!req.session.loggedIn) return res.status(401).send('Acesso negado');

    try {
        const pergunta = String(req.body?.pergunta || '').trim();
        const titulo = String(req.body?.titulo || '').trim();
        const area = String(req.body?.area || '').trim();

        if (!pergunta) {
            return res.status(400).json({ erro: 'Escreva a pergunta antes de gerar as sugestões.' });
        }

        const sugestao = await gerarSugestoesRespostasAceitasIA(pergunta, { titulo, area });
        return res.json(sugestao);
    } catch (err) {
        console.error('[Triagem IA] Erro ao gerar respostas aceitas:', err?.message || err);
        const status = err?.code === 'IA_INDISPONIVEL' ? 503 : 500;
        return res.status(status).json({
            erro: err?.message || 'Não foi possível gerar as sugestões com IA.'
        });
    }
});

// Gestão das opções do atendimento. O painel edita a mesma coleção usada pelo WhatsApp.
app.get('/api/menu-options', async (req, res) => {
    if (!req.session.loggedIn) return res.status(401).send('Acesso negado');

    try {
        const data = await carregarMenuOpcoes({ incluirInativas: true });
        res.json(data);
    } catch (err) {
        console.error('[Menu] Erro ao carregar opções:', err);
        res.status(500).json({ erro: 'Não foi possível carregar as opções.' });
    }
});

app.post('/api/menu-options', async (req, res) => {
    if (!req.session.loggedIn) return res.status(401).send('Acesso negado');

    try {
        const { titulo, area, resposta, emoji, ativo, perguntas } = req.body;
        const tituloLimpo = String(titulo || '').trim();
        const areaLimpa = String(area || '').trim();
        const respostaLimpa = String(resposta || '').trim();
        const emojiLimpo = String(emoji || '').trim();
        let perguntasLimpas;
        try {
            perguntasLimpas = normalizarPerguntasTriagem(perguntas);
        } catch (err) {
            return res.status(400).json({ erro: err.message });
        }

        if (!tituloLimpo || tituloLimpo.length > 120) {
            return res.status(400).json({ erro: 'Informe um título válido com até 120 caracteres.' });
        }
        if (!areaLimpa || areaLimpa.length > 120) {
            return res.status(400).json({ erro: 'Informe uma área interna válida com até 120 caracteres.' });
        }
        if (respostaLimpa.length > 4000) {
            return res.status(400).json({ erro: 'A mensagem introdutória deve possuir no máximo 4.000 caracteres.' });
        }
        if (!respostaLimpa && !perguntasLimpas.some(pergunta => pergunta.ativo !== false)) {
            return res.status(400).json({ erro: 'Cadastre pelo menos uma pergunta ou informe uma mensagem de detalhes.' });
        }
        if (emojiLimpo.length > 24) {
            return res.status(400).json({ erro: 'O campo de emoji deve ter no máximo 24 caracteres.' });
        }

        const quantidade = await menuOptionsColl.countDocuments({});
        if (quantidade >= 50) {
            return res.status(400).json({ erro: 'O menu atingiu o limite de 50 opções.' });
        }

        const ultima = await menuOptionsColl.find({}).sort({ ordem: -1 }).limit(1).next();
        const ordem = Number(ultima?.ordem || 0) + 1;
        const agora = Date.now();
        const id = new ObjectId().toString();

        const novaOpcao = {
            _id: id,
            ordem,
            titulo: tituloLimpo,
            area: areaLimpa,
            resposta: respostaLimpa,
            perguntas: perguntasLimpas,
            emoji: emojiLimpo,
            ativo: ativo !== false,
            createdAt: agora,
            updatedAt: agora
        };

        await menuOptionsColl.insertOne(novaOpcao);
        invalidarCacheMenu();
        res.status(201).json(novaOpcao);
    } catch (err) {
        console.error('[Menu] Erro ao criar opção:', err);
        res.status(500).json({ erro: 'Não foi possível criar a opção.' });
    }
});

app.put('/api/menu-options/:id', async (req, res) => {
    if (!req.session.loggedIn) return res.status(401).send('Acesso negado');

    try {
        const id = String(req.params.id || '').trim();
        const { titulo, area, resposta, emoji, ativo, perguntas } = req.body;

        const existente = await menuOptionsColl.findOne({ _id: id });
        if (!existente) {
            return res.status(404).json({ erro: 'Opção não encontrada.' });
        }

        const tituloLimpo = String(titulo || '').trim();
        const areaLimpa = String(area || '').trim();
        const respostaLimpa = String(resposta || '').trim();
        const emojiLimpo = String(emoji || '').trim();
        let perguntasLimpas;
        try {
            perguntasLimpas = normalizarPerguntasTriagem(perguntas);
        } catch (err) {
            return res.status(400).json({ erro: err.message });
        }

        if (!tituloLimpo || tituloLimpo.length > 120) {
            return res.status(400).json({ erro: 'Informe um título válido com até 120 caracteres.' });
        }
        if (!areaLimpa || areaLimpa.length > 120) {
            return res.status(400).json({ erro: 'Informe uma área interna válida com até 120 caracteres.' });
        }
        if (respostaLimpa.length > 4000) {
            return res.status(400).json({ erro: 'A mensagem introdutória deve possuir no máximo 4.000 caracteres.' });
        }
        if (!respostaLimpa && !perguntasLimpas.some(pergunta => pergunta.ativo !== false)) {
            return res.status(400).json({ erro: 'Cadastre pelo menos uma pergunta ou informe uma mensagem de detalhes.' });
        }
        if (emojiLimpo.length > 24) {
            return res.status(400).json({ erro: 'O campo de emoji deve ter no máximo 24 caracteres.' });
        }

        await menuOptionsColl.updateOne(
            { _id: id },
            {
                $set: {
                    titulo: tituloLimpo,
                    area: areaLimpa,
                    resposta: respostaLimpa,
                    perguntas: perguntasLimpas,
                    emoji: emojiLimpo,
                    ativo: ativo !== false,
                    updatedAt: Date.now()
                }
            }
        );

        invalidarCacheMenu();
        const atualizado = await menuOptionsColl.findOne({ _id: id });
        res.json(atualizado);
    } catch (err) {
        console.error('[Menu] Erro ao atualizar opção:', err);
        res.status(500).json({ erro: 'Não foi possível salvar a opção.' });
    }
});

app.post('/api/menu-options/reorder', async (req, res) => {
    if (!req.session.loggedIn) return res.status(401).send('Acesso negado');

    try {
        const ids = Array.isArray(req.body?.ids) ? req.body.ids.map(id => String(id)) : [];
        const atuais = await menuOptionsColl.find({}, { projection: { _id: 1 } }).toArray();
        const idsAtuais = atuais.map(item => String(item._id));

        if (
            ids.length !== idsAtuais.length ||
            new Set(ids).size !== ids.length ||
            idsAtuais.some(id => !ids.includes(id))
        ) {
            return res.status(400).json({ erro: 'A ordem enviada não corresponde às opções atuais.' });
        }

        const agora = Date.now();
        await menuOptionsColl.bulkWrite(
            ids.map((id, index) => ({
                updateOne: {
                    filter: { _id: id },
                    update: { $set: { ordem: index + 1, updatedAt: agora } }
                }
            }))
        );

        invalidarCacheMenu();
        res.json({ ok: true });
    } catch (err) {
        console.error('[Menu] Erro ao reordenar opções:', err);
        res.status(500).json({ erro: 'Não foi possível alterar a ordem das opções.' });
    }
});

app.delete('/api/menu-options/:id', async (req, res) => {
    if (!req.session.loggedIn) return res.status(401).send('Acesso negado');

    try {
        const id = String(req.params.id || '').trim();
        const quantidade = await menuOptionsColl.countDocuments({});
        if (quantidade <= 1) {
            return res.status(400).json({ erro: 'O atendimento precisa manter pelo menos uma opção cadastrada.' });
        }

        const existente = await menuOptionsColl.findOne({ _id: id });
        if (!existente) return res.status(404).json({ erro: 'Opção não encontrada.' });

        await menuOptionsColl.deleteOne({ _id: id });

        // Normaliza apenas a ordem interna após a exclusão. Os números exibidos no
        // WhatsApp são calculados dinamicamente entre as opções ativas.
        const restantes = await menuOptionsColl.find({}).sort({ ordem: 1, createdAt: 1 }).toArray();
        if (restantes.length) {
            const agora = Date.now();
            await menuOptionsColl.bulkWrite(
                restantes.map((item, index) => ({
                    updateOne: {
                        filter: { _id: item._id },
                        update: { $set: { ordem: index + 1, updatedAt: agora } }
                    }
                }))
            );
        }

        invalidarCacheMenu();
        res.json({ ok: true });
    } catch (err) {
        console.error('[Menu] Erro ao excluir opção:', err);
        res.status(500).json({ erro: 'Não foi possível excluir a opção.' });
    }
});

// Tenta recuperar o telefone real de cadastros antigos que ficaram apenas com LID.
// A recuperação usa, nesta ordem: cadastro do cliente, ticket ativo, histórico e
// mapeamento LID -> PN mantido pelo próprio Baileys.
async function resolverWhatsAppCliente(cliente) {
    if (!cliente) return null;

    let numero = extrairNumeroWhatsAppDeFontes(
        cliente.numeroReal,
        cliente.whatsappNumbers,
        cliente.identificadores,
        cliente.lastRawJid
    );

    const cpf = String(cliente.cpf || cliente._id || '').replace(/\D/g, '');
    const ticketNumbers = Array.isArray(cliente.ticketNumbers) ? cliente.ticketNumbers.filter(Boolean) : [];
    const registrosAuxiliares = [];

    if (!numero && ticketsColl) {
        const filtros = [];
        if (cpf) filtros.push({ clienteId: cpf }, { cpf });
        if (ticketNumbers.length) filtros.push({ ticketNumber: { $in: ticketNumbers } });

        if (filtros.length) {
            const ticketAtivo = await ticketsColl.findOne(
                { $or: filtros },
                {
                    sort: { lastActivity: -1 },
                    projection: {
                        numeroReal: 1,
                        whatsappNumbers: 1,
                        identificadores: 1,
                        lastRawJid: 1
                    }
                }
            );
            if (ticketAtivo) registrosAuxiliares.push(ticketAtivo);
        }
    }

    if (!numero && ticketHistoryColl) {
        const filtros = [];
        if (cpf) filtros.push({ clienteId: cpf }, { cpf });
        if (ticketNumbers.length) filtros.push({ ticketNumber: { $in: ticketNumbers } }, { _id: { $in: ticketNumbers } });

        if (filtros.length) {
            const historico = await ticketHistoryColl.findOne(
                { $or: filtros },
                {
                    sort: { updatedAt: -1 },
                    projection: {
                        numeroReal: 1,
                        whatsappNumbers: 1,
                        identificadores: 1,
                        lastRawJid: 1
                    }
                }
            );
            if (historico) registrosAuxiliares.push(historico);
        }
    }

    if (!numero) {
        for (const registro of registrosAuxiliares) {
            numero = extrairNumeroWhatsAppDeFontes(
                registro.numeroReal,
                registro.whatsappNumbers,
                registro.identificadores,
                registro.lastRawJid
            );
            if (numero) break;
        }
    }

    const todasAsFontes = [
        cliente.identificadores,
        cliente.lastRawJid,
        ...registrosAuxiliares.flatMap(registro => [registro.identificadores, registro.lastRawJid])
    ];

    if (!numero) {
        const resolvido = await resolverPnDeLids(...todasAsFontes);
        if (resolvido?.numero) numero = resolvido.numero;
    }

    // Se conseguimos recuperar o número de um cadastro antigo, corrige o MongoDB
    // para que as próximas consultas não dependam novamente dos fallbacks.
    if (numero && cpf && clientsColl) {
        const pnJid = `${numero}@s.whatsapp.net`;
        await clientsColl.updateOne(
            { $or: [{ _id: cliente._id }, { cpf }] },
            {
                $set: {
                    numeroReal: numero,
                    updatedAt: Date.now()
                },
                $addToSet: {
                    whatsappNumbers: numero,
                    identificadores: pnJid
                }
            }
        );
    }

    return numero;
}

// Clientes cadastrados no atendimento.
app.get('/api/clients', async (req, res) => {
    if (!req.session.loggedIn) return res.status(401).send('Acesso negado');
    if (!clientsColl) return res.status(503).json({ erro: 'Banco de dados ainda não está disponível.' });

    try {
        const clientes = await clientsColl.find(
            {},
            {
                projection: {
                    cpf: 1,
                    nome: 1,
                    sobrenome: 1,
                    nomeCompleto: 1,
                    numeroReal: 1,
                    whatsappNumbers: 1,
                    identificadores: 1,
                    lastRawJid: 1,
                    ticketNumbers: 1,
                    createdAt: 1,
                    updatedAt: 1,
                    lastSeenAt: 1
                }
            }
        ).sort({ nomeCompleto: 1, nome: 1, createdAt: -1 }).toArray();

        const clientesComWhatsApp = await Promise.all(
            clientes.map(async cliente => ({
                ...cliente,
                whatsapp: await resolverWhatsAppCliente(cliente)
            }))
        );

        res.json(clientesComWhatsApp);
    } catch (err) {
        console.error('[Clientes] Erro ao carregar clientes:', err);
        res.status(500).json({ erro: 'Não foi possível carregar os clientes cadastrados.' });
    }
});

app.delete('/api/clients/:cpf', async (req, res) => {
    if (!req.session.loggedIn) return res.status(401).send('Acesso negado');
    if (!clientsColl) return res.status(503).json({ erro: 'Banco de dados ainda não está disponível.' });

    try {
        const cpf = String(req.params.cpf || '').replace(/\D/g, '');
        if (cpf.length !== 11) {
            return res.status(400).json({ erro: 'CPF inválido.' });
        }

        const existente = await clientsColl.findOne({ $or: [{ _id: cpf }, { cpf }] });
        if (!existente) {
            return res.status(404).json({ erro: 'Cliente não encontrado.' });
        }

        const result = await clientsColl.deleteOne({ _id: existente._id });
        if (!result.deletedCount) {
            return res.status(404).json({ erro: 'Cliente não encontrado.' });
        }

        // Remove apenas o vínculo de cadastro dos tickets ativos. O histórico do atendimento
        // é preservado para não apagar registros jurídicos/operacionais já existentes.
        if (ticketsColl) {
            await ticketsColl.updateMany(
                { $or: [{ clienteId: cpf }, { cpf }] },
                {
                    $set: {
                        clienteId: null,
                        cpf: null,
                        clienteNome: null,
                        clienteCadastrado: false,
                        updatedAt: Date.now()
                    }
                }
            );
        }

        res.json({ ok: true });
    } catch (err) {
        console.error('[Clientes] Erro ao remover cliente:', err);
        res.status(500).json({ erro: 'Não foi possível remover o cliente.' });
    }
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
    invalidarCacheKnowledge();
    res.sendStatus(200);
});

app.delete('/api/knowledgeColl/:id', async (req, res) => {
    if (!req.session.loggedIn) return res.status(401).send("Acesso negado");
    
    try {
        const { id } = req.params;
        // O segredo está em converter a string recebida em ObjectId do MongoDB
        const result = await knowledgeColl.deleteOne({ _id: new ObjectId(id) });
        
        if (result.deletedCount === 1) {
            invalidarCacheKnowledge();
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