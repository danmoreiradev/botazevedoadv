const { 
    default: makeWASocket, 
    DisconnectReason, 
    fetchLatestBaileysVersion, 
    BufferJSON, 
    initAuthCreds,
    jidNormalizedUser,
    downloadMediaMessage,
    makeCacheableSignalKeyStore
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
const crypto = require('crypto');
const dns = require('dns').promises;
const net = require('net');
const { spawn } = require('child_process');

const { GoogleGenerativeAI } = require('@google/generative-ai');
let genAI = null;
let geminiModel = null;
let apiKeysColl;

function normalizarNomeModeloGemini(nome, fallback) {
    const valor = String(nome || '').trim();
    // Modelos que já causaram 404/retirada neste projeto são migrados automaticamente,
    // inclusive quando ainda estiverem definidos em variáveis de ambiente da hospedagem.
    if (!valor) return fallback;
    if (['gemini-2.5-flash-lite', 'gemini-3.1-flash-lite-preview'].includes(valor)) return fallback;
    return valor;
}

// -----------------------------------------------------------------------------
// LEITURA AUTOMÁTICA DE DOCUMENTOS / ARQUIVOS COM GEMINI
// -----------------------------------------------------------------------------
// O arquivo recebido pelo WhatsApp é baixado apenas para a memória do processo,
// enviado ao Gemini e descartado em seguida. O MongoDB armazena somente metadados
// e o resumo estruturado; o binário do documento não é persistido nesta rotina.
// Limites deliberadamente menores para evitar picos de RAM/CPU ao converter arquivos
// para base64. Ajuste estes valores conforme a capacidade da hospedagem.
const DOCUMENT_AI_MAX_PDF_BYTES = 20 * 1024 * 1024;
const DOCUMENT_AI_MAX_IMAGE_BYTES = 10 * 1024 * 1024;
const DOCUMENT_AI_MAX_AUDIO_BYTES = 20 * 1024 * 1024;
const DOCUMENT_AI_MAX_VIDEO_BYTES = 25 * 1024 * 1024;
const DOCUMENT_AI_MAX_TEXT_BYTES = 2 * 1024 * 1024;
const DOCUMENT_AI_MAX_OTHER_BYTES = 12 * 1024 * 1024;
const DOCUMENT_AI_TEXT_MAX_CHARS = 750_000;
const DOCUMENT_AI_MAX_ITEMS = 30;
const DOCUMENT_AI_PROMPT_VERSION = 'aj-doc-v2';

// Apenas uma análise pesada por vez. O WhatsApp continua respondendo normalmente,
// porque a fila roda em paralelo ao fluxo de atendimento.
const DOCUMENT_AI_MAX_CONCURRENCY = 1;
const DOCUMENT_AI_GEMINI_MAX_ATTEMPTS = Math.max(3, Math.min(7, Number(process.env.DOCUMENT_AI_GEMINI_MAX_ATTEMPTS || 5)));
const DOCUMENT_AI_RETRY_BASE_DELAY_MS = Math.max(500, Number(process.env.DOCUMENT_AI_RETRY_BASE_DELAY_MS || 1000));
const DOCUMENT_AI_RETRY_REF_MAX_CHARS = 150_000;
// Modelos estáveis para leitura multimodal. O documento nunca deve depender de um
// único modelo: 404 de modelo descontinuado e 503 temporário acionam fallback.
const DOCUMENT_AI_PREFERRED_MODEL = normalizarNomeModeloGemini(process.env.GEMINI_DOCUMENT_MODEL, 'gemini-3.5-flash-lite');
const DOCUMENT_AI_FALLBACK_MODELS = String(process.env.GEMINI_DOCUMENT_FALLBACK_MODELS || 'gemini-3.6-flash,gemini-3.1-flash-lite')
    .split(',').map(v => v.trim()).filter(Boolean);

let documentAIActiveJobs = 0;
const documentAIQueue = [];

function drenarFilaDocumentoIA() {
    while (documentAIActiveJobs < DOCUMENT_AI_MAX_CONCURRENCY && documentAIQueue.length) {
        const job = documentAIQueue.shift();
        documentAIActiveJobs += 1;

        Promise.resolve()
            .then(job.tarefa)
            .then(job.resolve, job.reject)
            .finally(() => {
                documentAIActiveJobs = Math.max(0, documentAIActiveJobs - 1);
                drenarFilaDocumentoIA();
            });
    }
}

function enfileirarTrabalhoDocumentoIA(tarefa) {
    return new Promise((resolve, reject) => {
        documentAIQueue.push({ tarefa, resolve, reject });
        drenarFilaDocumentoIA();
    });
}

function esperarDocumentoIA(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

const DOCUMENT_AI_MIME_EXACT = new Set([
    'application/pdf',
    'application/json',
    'application/rtf',
    'application/x-javascript',
    'application/x-typescript',
    'application/x-python-code',
    'application/x-ipynb+json',
    'text/plain',
    'text/html',
    'text/css',
    'text/javascript',
    'text/x-typescript',
    'text/csv',
    'text/markdown',
    'text/x-python',
    'text/xml',
    'text/rtf'
]);

function limitarTextoDocumentoIA(valor, max = 5000) {
    return String(valor ?? '').trim().slice(0, max);
}

function limitarListaDocumentoIA(valor, maxItens = 20, maxChars = 1000) {
    if (!Array.isArray(valor)) return [];
    return valor
        .map(item => limitarTextoDocumentoIA(item, maxChars))
        .filter(Boolean)
        .slice(0, maxItens);
}

function numeroSeguroDeLong(valor) {
    if (valor === null || valor === undefined) return null;
    if (typeof valor === 'number') return Number.isFinite(valor) ? valor : null;
    if (typeof valor === 'bigint') return Number(valor);
    if (typeof valor?.toNumber === 'function') {
        try { return valor.toNumber(); } catch (_) { return null; }
    }
    const convertido = Number(valor);
    return Number.isFinite(convertido) ? convertido : null;
}

function conteudoMensagemDesembrulhado(msg) {
    let conteudo = msg?.message || null;

    for (let i = 0; conteudo && i < 5; i++) {
        const proximo =
            conteudo.ephemeralMessage?.message ||
            conteudo.viewOnceMessage?.message ||
            conteudo.viewOnceMessageV2?.message ||
            conteudo.viewOnceMessageV2Extension?.message ||
            conteudo.documentWithCaptionMessage?.message ||
            null;

        if (!proximo) break;
        conteudo = proximo;
    }

    return conteudo || {};
}

function mimePorExtensao(nomeArquivo = '') {
    const ext = String(nomeArquivo).toLowerCase().split('.').pop();
    const mapa = {
        pdf: 'application/pdf',
        txt: 'text/plain',
        csv: 'text/csv',
        json: 'application/json',
        html: 'text/html',
        htm: 'text/html',
        md: 'text/markdown',
        xml: 'text/xml',
        rtf: 'text/rtf',
        jpg: 'image/jpeg',
        jpeg: 'image/jpeg',
        png: 'image/png',
        webp: 'image/webp',
        gif: 'image/gif',
        heic: 'image/heic',
        heif: 'image/heif',
        mp3: 'audio/mpeg',
        m4a: 'audio/mp4',
        wav: 'audio/wav',
        ogg: 'audio/ogg',
        opus: 'audio/ogg',
        mp4: 'video/mp4',
        mov: 'video/quicktime',
        webm: 'video/webm'
    };
    return mapa[ext] || null;
}

function extrairMidiaAnalisavel(msg) {
    const conteudo = conteudoMensagemDesembrulhado(msg);
    let payload = null;
    let tipo = null;

    if (conteudo.documentMessage) {
        payload = conteudo.documentMessage;
        tipo = 'documento';
    } else if (conteudo.imageMessage) {
        payload = conteudo.imageMessage;
        tipo = 'imagem';
    } else if (conteudo.audioMessage) {
        payload = conteudo.audioMessage;
        tipo = 'audio';
    } else if (conteudo.videoMessage) {
        payload = conteudo.videoMessage;
        tipo = 'video';
    }

    if (!payload || !tipo) return null;

    const nomesPadrao = {
        documento: 'documento',
        imagem: 'imagem.jpg',
        audio: 'audio',
        video: 'video.mp4'
    };

    const nomeArquivo = limitarTextoDocumentoIA(
        payload.fileName || payload.title || nomesPadrao[tipo],
        240
    );
    const mimeDeclarado = limitarTextoDocumentoIA(payload.mimetype || '', 120).toLowerCase().split(';')[0].trim();
    const mimeExtensao = mimePorExtensao(nomeArquivo);
    const mimeType = (!mimeDeclarado || mimeDeclarado === 'application/octet-stream' ? mimeExtensao : mimeDeclarado) || (
        tipo === 'imagem' ? 'image/jpeg' :
        tipo === 'audio' ? 'audio/ogg' :
        tipo === 'video' ? 'video/mp4' :
        'application/octet-stream'
    );

    return {
        payload,
        tipo,
        nomeArquivo,
        mimeType,
        tamanhoDeclarado: numeroSeguroDeLong(payload.fileLength),
        caption: limitarTextoDocumentoIA(payload.caption || '', 1500)
    };
}

function mimeSuportadoDiretamentePeloGemini(mimeType = '') {
    const mime = String(mimeType || '').toLowerCase().split(';')[0].trim();
    return mime.startsWith('image/') ||
        mime.startsWith('audio/') ||
        mime.startsWith('video/') ||
        mime.startsWith('text/') ||
        DOCUMENT_AI_MIME_EXACT.has(mime);
}

function mimeEhTextoParaGemini(mimeType = '') {
    const mime = String(mimeType || '').toLowerCase().split(';')[0].trim();
    return mime.startsWith('text/') || [
        'application/json',
        'application/rtf',
        'application/x-javascript',
        'application/x-typescript',
        'application/x-python-code',
        'application/x-ipynb+json'
    ].includes(mime);
}

function limiteArquivoGemini(mimeType = '') {
    const mime = String(mimeType || '').toLowerCase().split(';')[0].trim();
    if (mime === 'application/pdf') return DOCUMENT_AI_MAX_PDF_BYTES;
    if (mime.startsWith('image/')) return DOCUMENT_AI_MAX_IMAGE_BYTES;
    if (mime.startsWith('audio/')) return DOCUMENT_AI_MAX_AUDIO_BYTES;
    if (mime.startsWith('video/')) return DOCUMENT_AI_MAX_VIDEO_BYTES;
    if (mimeEhTextoParaGemini(mime)) return DOCUMENT_AI_MAX_TEXT_BYTES;
    return DOCUMENT_AI_MAX_OTHER_BYTES;
}

function mensagemMimeNaoSuportado(nomeArquivo, mimeType) {
    return `O arquivo ${nomeArquivo || ''} foi registrado no ticket, mas o tipo ${mimeType || 'desconhecido'} não é aceito diretamente pela rotina atual do Gemini. PDFs, imagens, áudios, vídeos e formatos textuais comuns são analisados automaticamente.`;
}


function criarReferenciaRetryDocumentoIA(msg, media) {
    if (!msg || !media?.payload || msg?.key?.fromMe) return null;

    // Guardamos SOMENTE os metadados criptográficos/de-download necessários para
    // tentar recuperar a mídia do WhatsApp novamente. O conteúdo do arquivo não é
    // salvo no MongoDB, evitando aumentar muito o banco.
    const camposPermitidos = [
        'url', 'directPath', 'mediaKey', 'fileEncSha256', 'fileSha256',
        'fileLength', 'mediaKeyTimestamp', 'mimetype', 'fileName', 'title',
        'caption', 'seconds', 'ptt', 'gifPlayback'
    ];

    const payloadMinimo = {};
    for (const campo of camposPermitidos) {
        if (media.payload[campo] !== undefined && media.payload[campo] !== null) {
            payloadMinimo[campo] = media.payload[campo];
        }
    }

    try {
        const serializado = JSON.stringify({
            tipo: media.tipo,
            remoteJid: msg?.key?.remoteJid || null,
            remoteJidAlt: msg?.key?.remoteJidAlt || null,
            payload: payloadMinimo
        }, BufferJSON.replacer);

        if (!serializado || serializado.length > DOCUMENT_AI_RETRY_REF_MAX_CHARS) return null;
        return serializado;
    } catch (err) {
        console.warn('[Documentos IA] Não foi possível criar referência leve para reprocessamento:', err?.message || err);
        return null;
    }
}

function reconstruirMensagemRetryDocumentoIA(retryRef, messageId) {
    if (!retryRef || !messageId) return null;

    try {
        const dados = JSON.parse(String(retryRef), BufferJSON.reviver);
        const campoPorTipo = {
            documento: 'documentMessage',
            imagem: 'imageMessage',
            audio: 'audioMessage',
            video: 'videoMessage'
        };
        const campo = campoPorTipo[dados?.tipo];
        if (!campo || !dados?.payload) return null;

        return {
            key: {
                id: String(messageId),
                remoteJid: dados.remoteJid || dados.remoteJidAlt || null,
                remoteJidAlt: dados.remoteJidAlt || null,
                fromMe: false
            },
            message: {
                [campo]: dados.payload
            }
        };
    } catch (err) {
        console.warn('[Documentos IA] Referência de reprocessamento inválida:', err?.message || err);
        return null;
    }
}

function statusHttpErroDocumentoIA(err) {
    const candidatos = [
        err?.status,
        err?.statusCode,
        err?.response?.status,
        err?.cause?.status,
        err?.cause?.statusCode
    ];

    for (const valor of candidatos) {
        const numero = Number(valor);
        if (Number.isInteger(numero) && numero >= 100 && numero <= 599) return numero;
    }

    const texto = String(err?.message || err || '');
    const match = texto.match(/\[(404|408|429|500|502|503|504)\b/i) || texto.match(/\b(404|408|429|500|502|503|504)\b/);
    return match ? Number(match[1]) : null;
}

function erroDocumentoIATemporario(err) {
    const status = statusHttpErroDocumentoIA(err);
    if ([408, 429, 500, 502, 503, 504].includes(status)) return true;

    return /(high demand|service unavailable|temporar|resource exhausted|rate limit|too many requests|overload|fetch failed|econnreset|etimedout|socket hang up)/i
        .test(String(err?.message || err || ''));
}

function erroDocumentoIADownloadIrrecuperavel(err) {
    return /(media.*not found|arquivo.*não.*encontr|message.*not found|mídia.*expir|media.*expired|gone|not-authorized|forbidden)/i
        .test(String(err?.message || err || ''));
}

function erroModeloGeminiIndisponivel(err) {
    const status = statusHttpErroDocumentoIA(err);
    const texto = String(err?.message || err || '');
    return status === 404 && /(model|models\/|no longer available|not found|deprecated|update your code|latest features)/i.test(texto);
}

function descreverErroDocumentoIA(err, { temRetryRef = false, etapa = 'ia' } = {}) {
    const status = statusHttpErroDocumentoIA(err);
    const texto = String(err?.message || err || '');
    const temporario = erroDocumentoIATemporario(err);
    // Um 404 da API do Gemini NÃO significa que a mídia do WhatsApp expirou.
    // Só classificamos como mídia irrecuperável quando o erro ocorreu no download.
    const downloadIrrecuperavel = etapa === 'download' && (status === 404 || erroDocumentoIADownloadIrrecuperavel(err));

    if (erroModeloGeminiIndisponivel(err)) {
        return {
            codigo: 'GEMINI_MODELO_INDISPONIVEL',
            temporario: false,
            podeReprocessar: !!temRetryRef,
            mensagem: 'O modelo de IA configurado não está mais disponível. O sistema tentou modelos alternativos; você pode gerar a leitura novamente após atualizar o serviço.'
        };
    }

    if (status === 503 || /high demand|service unavailable|overload/i.test(texto)) {
        return {
            codigo: 'GEMINI_SOBRECARREGADO',
            temporario: true,
            podeReprocessar: !!temRetryRef,
            mensagem: 'A IA está temporariamente sobrecarregada. O sistema já realizou novas tentativas automáticas. Tente gerar a leitura novamente em alguns instantes.'
        };
    }

    if (status === 408 || /timed out|timeout/i.test(texto)) {
        return {
            codigo: etapa === 'download' ? 'WHATSAPP_TIMEOUT_MIDIA' : 'GEMINI_TIMEOUT',
            temporario: true,
            podeReprocessar: !!temRetryRef,
            mensagem: etapa === 'download'
                ? 'O WhatsApp demorou para disponibilizar o arquivo. Tente gerar a leitura novamente em alguns instantes.'
                : 'A IA demorou para responder. Tente gerar a leitura novamente em alguns instantes.'
        };
    }

    if (status === 429 || /resource exhausted|rate limit|too many requests/i.test(texto)) {
        return {
            codigo: 'GEMINI_LIMITE_TEMPORARIO',
            temporario: true,
            podeReprocessar: !!temRetryRef,
            mensagem: 'O limite temporário da IA foi atingido. Aguarde alguns instantes e tente gerar a leitura novamente.'
        };
    }

    if (downloadIrrecuperavel) {
        return {
            codigo: 'MIDIA_NAO_RECUPERAVEL',
            temporario: false,
            podeReprocessar: false,
            mensagem: 'Não foi possível recuperar novamente este arquivo do WhatsApp. Se necessário, solicite o reenvio do documento pelo cliente.'
        };
    }

    if (temporario) {
        return {
            codigo: 'FALHA_TEMPORARIA_IA',
            temporario: true,
            podeReprocessar: !!temRetryRef,
            mensagem: 'Houve uma falha temporária de comunicação com a IA. Tente gerar a leitura novamente em alguns instantes.'
        };
    }

    return {
        codigo: 'FALHA_ANALISE_DOCUMENTO',
        temporario: false,
        podeReprocessar: !!temRetryRef,
        mensagem: 'Não foi possível concluir a análise automática deste arquivo. Você pode tentar gerar a leitura novamente.'
    };
}

async function gerarConteudoDocumentoComRetry(partesEntrada) {
    if (!genAI) throw new Error('A IA não está configurada.');

    const nomes = [];
    const vistos = new Set();
    const adicionar = (nome) => {
        nome = String(nome || '').trim();
        if (!nome || vistos.has(nome)) return;
        vistos.add(nome);
        nomes.push(nome);
    };
    adicionar(DOCUMENT_AI_PREFERRED_MODEL);
    DOCUMENT_AI_FALLBACK_MODELS.forEach(adicionar);

    let ultimoErro = null;
    let tentativasExecutadas = 0;
    const modelosTentados = [];

    for (const nomeModelo of nomes) {
        if (tentativasExecutadas >= DOCUMENT_AI_GEMINI_MAX_ATTEMPTS) break;
        let modelo = null;
        try {
            modelo = genAI.getGenerativeModel({ model: nomeModelo, generationConfig: { responseMimeType: 'application/json' } }, { apiVersion: 'v1beta' });
        } catch (err) {
            ultimoErro = err;
            continue;
        }

        modelosTentados.push(nomeModelo);
        // Até duas tentativas por modelo para falhas transitórias; erro 404 de modelo
        // troca imediatamente para o próximo fallback.
        for (let tentativaModelo = 1; tentativaModelo <= 2 && tentativasExecutadas < DOCUMENT_AI_GEMINI_MAX_ATTEMPTS; tentativaModelo++) {
            tentativasExecutadas += 1;
            try {
                const resultado = await modelo.generateContent(partesEntrada);
                return {
                    resultado,
                    tentativas: tentativasExecutadas,
                    modelo: nomeModelo,
                    modelosTentados
                };
            } catch (err) {
                ultimoErro = err;
                if (erroModeloGeminiIndisponivel(err)) {
                    console.warn(`[Documentos IA] Modelo ${nomeModelo} indisponível/retirado. Tentando fallback.`);
                    break;
                }

                const temporario = erroDocumentoIATemporario(err);
                const aindaPodeTentar = temporario && tentativaModelo < 2 && tentativasExecutadas < DOCUMENT_AI_GEMINI_MAX_ATTEMPTS;
                if (!aindaPodeTentar) break;

                const atraso = (DOCUMENT_AI_RETRY_BASE_DELAY_MS * (2 ** Math.max(0, tentativaModelo - 1))) + Math.floor(Math.random() * 350);
                console.warn(`[Documentos IA] ${nomeModelo} indisponível na tentativa ${tentativaModelo}. Nova tentativa em ${atraso}ms.`);
                await esperarDocumentoIA(atraso);
            }
        }
    }

    try {
        ultimoErro.documentAITentativas = tentativasExecutadas;
        ultimoErro.documentAIModelosTentados = modelosTentados;
    } catch (_) {}
    throw ultimoErro || new Error('Falha desconhecida ao consultar os modelos Gemini.');
}

function normalizarAnaliseDocumentoIA(parsed, textoFallback = '') {
    const dados = parsed && typeof parsed === 'object' ? parsed : {};

    const partes = Array.isArray(dados.partesPessoas)
        ? dados.partesPessoas.map(item => {
            if (typeof item === 'string') return limitarTextoDocumentoIA(item, 500);
            const nome = limitarTextoDocumentoIA(item?.nome, 250);
            const papel = limitarTextoDocumentoIA(item?.papel, 250);
            return [nome, papel].filter(Boolean).join(' — ');
        }).filter(Boolean).slice(0, 20)
        : [];

    const datasValores = Array.isArray(dados.datasValores)
        ? dados.datasValores.map(item => {
            if (typeof item === 'string') return limitarTextoDocumentoIA(item, 700);
            const descricao = limitarTextoDocumentoIA(item?.descricao, 350);
            const valor = limitarTextoDocumentoIA(item?.valor, 200);
            return [descricao, valor].filter(Boolean).join(': ');
        }).filter(Boolean).slice(0, 30)
        : [];

    return {
        tipoDocumento: limitarTextoDocumentoIA(dados.tipoDocumento || 'Não identificado', 300),
        resumoExecutivo: limitarTextoDocumentoIA(dados.resumoExecutivo || textoFallback || 'Não foi possível gerar um resumo estruturado.', 5000),
        partesPessoas: partes,
        pontosRelevantes: limitarListaDocumentoIA(dados.pontosRelevantes, 15, 900),
        datasValores,
        obrigacoesPrazos: limitarListaDocumentoIA(dados.obrigacoesPrazos, 15, 900),
        alertasAdvogado: limitarListaDocumentoIA(dados.alertasAdvogado, 15, 900),
        informacoesNaoIdentificadas: limitarListaDocumentoIA(dados.informacoesNaoIdentificadas, 20, 700)
    };
}

function montarPromptAnaliseDocumento(ticket, media) {
    const area = limitarTextoDocumentoIA(ticket?.area || ticket?.menuOptionTitle || 'não definida', 180);
    const legenda = media.caption ? `\nLEGENDA ENVIADA COM O ARQUIVO: ${JSON.stringify(media.caption)}` : '';

    return `Você atua somente como leitor e organizador de documentos para um escritório de advocacia brasileiro.

Analise EXCLUSIVAMENTE o arquivo anexado. Não dê parecer jurídico, não conclua procedência, não invente fatos e não preencha lacunas por suposição.

CONTEXTO INTERNO DO TICKET:
Área informada: ${JSON.stringify(area)}${legenda}

Retorne SOMENTE JSON válido, sem markdown, neste formato:
{
  "tipoDocumento":"",
  "partesPessoas":[{"nome":"","papel":""}],
  "resumoExecutivo":"",
  "pontosRelevantes":[""],
  "datasValores":[{"descricao":"","valor":""}],
  "obrigacoesPrazos":[""],
  "alertasAdvogado":[""],
  "informacoesNaoIdentificadas":[""]
}

REGRAS:
1. O resumo executivo deve ser objetivo, fiel e compreensível em até 4 parágrafos curtos. Evite repetições.
2. Identifique nomes, empresas e papéis somente quando constarem do arquivo.
3. Destaque fatos, cláusulas, pedidos, obrigações, prazos, datas, valores, números de processo, protocolos e documentos citados quando existirem.
4. Em alertasAdvogado, aponte somente pontos do próprio arquivo que merecem conferência humana: ausência aparente de assinatura, divergência interna, página ilegível, prazo mencionado, cláusula relevante ou informação incompleta. Não dê orientação jurídica conclusiva.
5. Quando uma informação não existir ou não puder ser lida, registre isso em informacoesNaoIdentificadas.
6. Não reproduza integralmente o documento e não faça transcrição extensa.
7. Preserve números, datas e valores exatamente como forem identificados no arquivo.
8. Se o arquivo for áudio ou vídeo, resuma também o conteúdo falado relevante.
9. Se o arquivo for uma imagem/print, descreva apenas o que estiver visualmente legível.
10. Se não conseguir ler o conteúdo, deixe isso explícito e não invente.`;
}

async function registrarDocumentoIANoTicket(ticket, documento) {
    if (!ticket?._id || !ticket?.ticketNumber || !documento?.messageId) return false;

    const filtroNovo = {
        _id: ticket._id,
        'documentosIA.messageId': { $ne: documento.messageId }
    };

    const resultado = await ticketsColl.updateOne(
        filtroNovo,
        { $push: { documentosIA: { $each: [documento], $slice: -DOCUMENT_AI_MAX_ITEMS } } }
    );

    if (!resultado.modifiedCount) return false;

    if (ticketHistoryColl) {
        await ticketHistoryColl.updateOne(
            {
                _id: ticket.ticketNumber,
                'documentosIA.messageId': { $ne: documento.messageId }
            },
            {
                $push: { documentosIA: { $each: [documento], $slice: -DOCUMENT_AI_MAX_ITEMS } },
                $set: { updatedAt: Date.now() }
            }
        );
    }

    io.emit('ticket_document_ai_updated', {
        ticketNumber: ticket.ticketNumber,
        messageId: documento.messageId,
        status: documento.statusAnalise
    });

    return true;
}

async function atualizarDocumentoIA(ticket, messageId, campos = {}) {
    if (!ticket?.ticketNumber || !messageId) return;

    const sets = {};
    for (const [chave, valor] of Object.entries(campos)) {
        sets[`documentosIA.$.${chave}`] = valor;
    }

    const tarefas = [];
    if (ticket?._id && ticketsColl) {
        tarefas.push(
            ticketsColl.updateOne(
                { _id: ticket._id, 'documentosIA.messageId': messageId },
                { $set: sets }
            )
        );
    }

    if (ticketHistoryColl) {
        tarefas.push(
            ticketHistoryColl.updateOne(
                { _id: ticket.ticketNumber, 'documentosIA.messageId': messageId },
                { $set: { ...sets, updatedAt: Date.now() } }
            )
        );
    }

    await Promise.allSettled(tarefas);

    io.emit('ticket_document_ai_updated', {
        ticketNumber: ticket.ticketNumber,
        messageId,
        status: campos.statusAnalise || null
    });
}

async function processarArquivoRecebidoComIA(ticket, msg, { reprocessar = false } = {}) {
    // REGRA CENTRAL: documentos enviados pelo escritório/advogado nunca são enviados à IA.
    if (msg?.key?.fromMe) return;

    const media = extrairMidiaAnalisavel(msg);
    if (!media || !ticket?.ticketNumber) return;

    const messageId = String(msg?.key?.id || '').trim();
    if (!messageId) return;

    const agora = Date.now();
    const retryRef = criarReferenciaRetryDocumentoIA(msg, media);

    if (!reprocessar) {
        const documentoInicial = {
            id: `wa_${messageId}`,
            messageId,
            nomeArquivo: media.nomeArquivo,
            mimeType: media.mimeType,
            tipoMidia: media.tipo,
            tamanhoBytes: media.tamanhoDeclarado,
            caption: media.caption || null,
            recebidoEm: agora,
            origemArquivo: 'cliente',
            statusAnalise: 'analisando',
            promptVersion: DOCUMENT_AI_PROMPT_VERSION,
            analisadoEm: null,
            reprocessadoEm: null,
            tentativasManuais: 0,
            tentativasGemini: 0,
            erro: null,
            erroCodigo: null,
            erroTemporario: null,
            retryRef: retryRef || null
        };

        const registrado = await registrarDocumentoIANoTicket(ticket, documentoInicial);
        if (!registrado) return; // idempotência para eventual upsert duplicado do WhatsApp
    } else {
        await atualizarDocumentoIA(ticket, messageId, {
            statusAnalise: 'analisando',
            analisadoEm: null,
            reprocessadoEm: agora,
            erro: null,
            erroCodigo: null,
            erroTemporario: null,
            podeReprocessar: false,
            ...(retryRef ? { retryRef } : {})
        });
    }

    if (!geminiModel) {
        await atualizarDocumentoIA(ticket, messageId, {
            statusAnalise: 'erro',
            erro: 'A IA está indisponível no momento. Verifique a chave/configuração do Gemini.',
            erroCodigo: 'GEMINI_INDISPONIVEL',
            erroTemporario: false,
            analisadoEm: Date.now()
        });
        return;
    }

    if (!mimeSuportadoDiretamentePeloGemini(media.mimeType)) {
        await atualizarDocumentoIA(ticket, messageId, {
            statusAnalise: 'nao_suportado',
            erro: mensagemMimeNaoSuportado(media.nomeArquivo, media.mimeType),
            erroCodigo: 'TIPO_NAO_SUPORTADO',
            erroTemporario: false,
            analisadoEm: Date.now()
        });
        return;
    }

    const limite = limiteArquivoGemini(media.mimeType);
    if (media.tamanhoDeclarado && media.tamanhoDeclarado > limite) {
        await atualizarDocumentoIA(ticket, messageId, {
            statusAnalise: 'erro',
            erro: `Arquivo acima do limite automático configurado para este tipo (${Math.round(limite / 1024 / 1024)} MB).`,
            erroCodigo: 'ARQUIVO_MUITO_GRANDE',
            erroTemporario: false,
            analisadoEm: Date.now()
        });
        return;
    }

    // O arquivo fica aguardando um slot antes do download. Assim vários documentos
    // recebidos em sequência não ocupam memória ao mesmo tempo.
    await atualizarDocumentoIA(ticket, messageId, {
        statusAnalise: 'na_fila',
        erro: null,
        erroCodigo: null,
        erroTemporario: null
    });

    await enfileirarTrabalhoDocumentoIA(async () => {
        let buffer = null;
        let etapaAnalise = 'download';

        try {
            await atualizarDocumentoIA(ticket, messageId, {
                statusAnalise: 'baixando',
                erro: null
            });

            buffer = await downloadMediaMessage(
                msg,
                'buffer',
                {},
                {
                    logger: P({ level: 'silent' }),
                    reuploadRequest: sock?.updateMediaMessage
                        ? sock.updateMediaMessage.bind(sock)
                        : undefined
                }
            );

            if (!Buffer.isBuffer(buffer) || !buffer.length) {
                throw new Error('O WhatsApp não retornou conteúdo para este arquivo.');
            }

            if (buffer.length > limite) {
                throw new Error(`Arquivo acima do limite automático configurado para este tipo (${Math.round(limite / 1024 / 1024)} MB).`);
            }

            await atualizarDocumentoIA(ticket, messageId, {
                tamanhoBytes: buffer.length,
                statusAnalise: 'processando_ia',
                erro: null
            });
            etapaAnalise = 'ia';

            const prompt = montarPromptAnaliseDocumento(ticket, media);
            const partesEntrada = [{ text: prompt }];

            // Texto é enviado como texto, sem base64. Para os demais formatos, o base64
            // só é criado quando o job chega ao primeiro lugar da fila.
            if (mimeEhTextoParaGemini(media.mimeType)) {
                const conteudoTexto = buffer.toString('utf8').slice(0, DOCUMENT_AI_TEXT_MAX_CHARS);
                partesEntrada.push({
                    text: `\n\nCONTEÚDO DO ARQUIVO ${JSON.stringify(media.nomeArquivo)}:\n${conteudoTexto}`
                });
            } else {
                const base64 = buffer.toString('base64');
                partesEntrada.push({
                    inlineData: {
                        mimeType: media.mimeType,
                        data: base64
                    }
                });
            }

            // Libera a referência ao binário original antes da chamada externa. O conteúdo
            // necessário já está em partesEntrada.
            buffer = null;

            const { resultado, tentativas, modelo } = await gerarConteudoDocumentoComRetry(partesEntrada);
            const resposta = await resultado.response;
            const textoResposta = String(resposta.text() || '').trim();
            const parsed = extrairJsonIA(textoResposta);
            const analise = normalizarAnaliseDocumentoIA(parsed, textoResposta);

            await atualizarDocumentoIA(ticket, messageId, {
                ...analise,
                statusAnalise: 'concluida',
                analisadoEm: Date.now(),
                tentativasGemini: tentativas,
                modeloGemini: modelo || DOCUMENT_AI_PREFERRED_MODEL,
                erro: null,
                erroCodigo: null,
                erroTemporario: null,
                podeReprocessar: false
            });

            console.log(`[Ticket ${ticket.ticketNumber}] Arquivo ${media.nomeArquivo} analisado com ${modelo || 'Gemini'} em ${tentativas} tentativa(s).`);
        } catch (err) {
            console.error(`[Ticket ${ticket.ticketNumber}] Falha na análise de arquivo com Gemini:`, err?.message || err);
            const erroTratado = descreverErroDocumentoIA(err, { temRetryRef: !!retryRef, etapa: etapaAnalise });

            await atualizarDocumentoIA(ticket, messageId, {
                statusAnalise: 'erro',
                erro: erroTratado.mensagem,
                erroCodigo: erroTratado.codigo,
                erroTemporario: erroTratado.temporario,
                podeReprocessar: erroTratado.podeReprocessar === true,
                tentativasGemini: Number(err?.documentAITentativas || DOCUMENT_AI_GEMINI_MAX_ATTEMPTS),
                analisadoEm: Date.now()
            });
        } finally {
            buffer = null;
        }
    });
}

function iniciarAnaliseArquivoSemBloquearFluxo(ticket, msg, opcoes = {}) {
    // Segunda proteção explícita: mesmo que esta função seja chamada de outro ponto
    // no futuro, arquivos enviados pelo próprio escritório nunca serão analisados.
    if (!ticket || msg?.key?.fromMe || !extrairMidiaAnalisavel(msg)) return;

    processarArquivoRecebidoComIA(ticket, msg, opcoes).catch(err => {
        console.error('[Documentos IA] Erro não tratado:', err?.message || err);
    });
}

// Cache curto da base de conhecimento para evitar leitura integral do MongoDB
// a cada mensagem recebida. O cache é invalidado quando a base é alterada.
const KNOWLEDGE_CACHE_TTL_MS = 60 * 1000;
const KNOWLEDGE_MAX_ITEMS = 200;
const KNOWLEDGE_MAX_CANDIDATES = 6;
const KNOWLEDGE_SEMANTIC_FALLBACK_ITEMS = 20;
// Consultas da Base não podem depender de um único modelo preview. Usamos um
// modelo estável atual como primeira opção, retry curto e fallback para outros modelos.
const KNOWLEDGE_AI_MAX_ATTEMPTS = Math.max(2, Math.min(5, Number(process.env.KNOWLEDGE_AI_MAX_ATTEMPTS || 3)));
const KNOWLEDGE_AI_RETRY_BASE_MS = Math.max(350, Number(process.env.KNOWLEDGE_AI_RETRY_BASE_MS || 700));
const KNOWLEDGE_AI_TIMEOUT_MS = Math.max(5000, Number(process.env.KNOWLEDGE_AI_TIMEOUT_MS || 14000));
const KNOWLEDGE_AI_PREFERRED_MODEL = normalizarNomeModeloGemini(process.env.GEMINI_KNOWLEDGE_MODEL, 'gemini-3.5-flash-lite');
const KNOWLEDGE_AI_FALLBACK_MODELS = String(process.env.GEMINI_KNOWLEDGE_FALLBACK_MODELS || 'gemini-3.6-flash,gemini-3.1-flash-lite')
    .split(',').map(v => v.trim()).filter(Boolean);
let knowledgeCache = { items: [], loadedAt: 0 };
let knowledgeWebCache = { pages: [], loadedAt: 0 };
const KNOWLEDGE_WEB_CACHE_TTL_MS = 45 * 1000;
const KNOWLEDGE_WEB_MAX_PAGES = 100;
const KNOWLEDGE_WEB_DEFAULT_PAGES = 30;
const KNOWLEDGE_WEB_DISCOVERY_VERSION = 3;
const KNOWLEDGE_WEB_MAX_HTML_BYTES = 1_500_000;
const KNOWLEDGE_WEB_MAX_TEXT_CHARS_PER_PAGE = 18000;
const KNOWLEDGE_WEB_MAX_CANDIDATES = 4;
// A geração de sugestões do site usa um modelo estável e possui retry/fallback
// próprio. Isso evita perder uma página inteira quando um modelo preview sofre
// pico temporário de demanda (HTTP 503/429).
const KNOWLEDGE_WEB_AI_MAX_ATTEMPTS = Math.max(2, Math.min(6, Number(process.env.KNOWLEDGE_WEB_AI_MAX_ATTEMPTS || 4)));
const KNOWLEDGE_WEB_AI_RETRY_BASE_MS = Math.max(500, Number(process.env.KNOWLEDGE_WEB_AI_RETRY_BASE_MS || 1200));
const KNOWLEDGE_WEB_AI_TIMEOUT_MS = Math.max(8000, Number(process.env.KNOWLEDGE_WEB_AI_TIMEOUT_MS || 30000));
const KNOWLEDGE_WEB_AI_PREFERRED_MODEL = normalizarNomeModeloGemini(process.env.GEMINI_KNOWLEDGE_WEB_MODEL, 'gemini-3.5-flash-lite');
const KNOWLEDGE_WEB_AI_FALLBACK_MODELS = String(process.env.GEMINI_KNOWLEDGE_WEB_FALLBACK_MODELS || 'gemini-3.6-flash,gemini-3.1-flash-lite')
    .split(',').map(v => v.trim()).filter(Boolean);


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
app.set('trust proxy', 1);

app.use(express.json());
app.use(express.urlencoded({ extended: true }));
const MongoDBStore = require('connect-mongodb-session')(session);

const store = new MongoDBStore({
  uri: process.env.MONGODB_URI,
  collection: 'sessions'
});

// Nunca usa segredo de sessão previsível. Em produção, defina SESSION_SECRET
// com um valor longo e aleatório para preservar sessões entre reinicializações.
const sessionSecret = process.env.SESSION_SECRET || crypto.randomBytes(48).toString('hex');
if (!process.env.SESSION_SECRET) {
    console.warn('[Segurança] SESSION_SECRET não definido. Foi gerado um segredo efêmero; as sessões serão invalidadas ao reiniciar o servidor.');
}

const sessionMiddleware = session({
    secret: sessionSecret,
    resave: false,
    saveUninitialized: false,
    store,
    cookie: {
        maxAge: 1000 * 60 * 60 * 24,
        httpOnly: true,
        sameSite: 'lax',
        secure: 'auto'
    }
});
app.use(sessionMiddleware);
// A mesma sessão HTTP é reutilizada pelo Socket.IO, permitindo identificar
// o advogado conectado também nos eventos em tempo real.
io.engine.use(sessionMiddleware);

const mongoUri = process.env.MONGODB_URI;
const client = new MongoClient(mongoUri);

let lastQr = null;
let currentUser = null;
let sock;

// -----------------------------------------------------------------------------
// SUPERVISÃO DA SESSÃO BAILEYS / PROTEÇÃO CONTRA CORRIDA CRIPTOGRÁFICA
// -----------------------------------------------------------------------------
// Uma sessão Signal não pode ser usada por dois sockets/processos simultaneamente.
// Reconexões sobrepostas, deploy blue/green ou dois workers apontando para a mesma
// coleção auth_session podem avançar o Double Ratchet em paralelo e produzir o
// placeholder "Aguardando mensagem" no celular do destinatário.
const BAILEYS_INSTANCE_ID = `${process.pid}-${crypto.randomUUID()}`;
const BAILEYS_LEASE_ID = 'primary-whatsapp-session';
const BAILEYS_LEASE_TTL_MS = 30 * 1000;
const BAILEYS_LEASE_RENEW_MS = 10 * 1000;
const BAILEYS_RECONNECT_DELAY_MS = 1800;
let waRuntimeLocksColl = null;
let baileysStartPromise = null;
let baileysReconnectTimer = null;
let baileysLeaseRenewTimer = null;
let baileysAuthWriteQueue = Promise.resolve();
let whatsappConnectionOpenedAt = 0;

// Serializa TODO envio por JID. Isso impede que uma resposta automática e uma
// mensagem do painel alterem a mesma sessão Signal ao mesmo tempo.
const outboundJidChains = new Map();

const botMessageIds = new Set();
// Proteção contra corrida: o Baileys pode emitir o upsert da própria mensagem antes
// de sendMessage() resolver e antes de termos o messageId em botMessageIds. Enquanto
// um envio automático estiver pendente para o JID, qualquer upsert fromMe desse JID
// é tratado como automático, nunca como intervenção humana.
const botPendingJids = new Set();
const panelMessageIds = new Set();
const panelPendingJids = new Set();
const processing = new Set();

// -----------------------------------------------------------------------------
// FILA DE MENSAGENS / RESPONSIVIDADE DO FLUXO
// -----------------------------------------------------------------------------
// Mensagens do mesmo contato são processadas em série. Isso evita que duas respostas
// enviadas em sequência leiam o mesmo estado do ticket e avancem o fluxo fora de ordem.
const inboundContactLocks = new Map();

// Deduplicação por ID real da mensagem. O Baileys pode reenviar o mesmo upsert em
// reconexões/atualizações; o mesmo messageId nunca deve avançar o fluxo duas vezes.
const PROCESSED_MESSAGE_TTL_MS = 10 * 60 * 1000;
const processedMessageIds = new Map();

// Enquanto uma mensagem textual ainda está em processamento, uma segunda cópia
// idêntica do MESMO contato é ignorada. Diferente da versão anterior, não usamos uma
// janela fixa depois do recebimento: assim uma resposta legítima igual à anterior
// pode ser usada na pergunta seguinte assim que o bot efetivamente terminar a etapa.
const inboundPayloadInFlight = new Set();

// Cache leve de LID -> PN. O vínculo quase nunca muda durante a sessão e não há motivo
// para consultar o repositório Signal em toda mensagem recebida.
const LID_PN_RUNTIME_CACHE_TTL_MS = 30 * 60 * 1000;
const lidPnRuntimeCache = new Map();

function chaveFilaContato(msg, rawJid = '') {
    const candidatos = [
        msg?.key?.remoteJidAlt,
        msg?.key?.senderPn,
        msg?.key?.participantPn,
        msg?.senderPn,
        rawJid
    ].filter(Boolean);

    const pn = candidatos
        .map(valor => normalizarJid(String(valor)))
        .find(jid => jid?.endsWith('@s.whatsapp.net'));

    return pn || normalizarJid(rawJid) || String(rawJid || 'desconhecido');
}

async function adquirirLockContato(chave) {
    const key = String(chave || 'desconhecido');

    // Mutex assíncrono simples, sem polling. Quando a mensagem anterior termina, apenas
    // uma das aguardando assume o lock; as demais continuam na fila.
    while (inboundContactLocks.has(key)) {
        try { await inboundContactLocks.get(key); } catch (_) {}
    }

    let liberar;
    const lock = new Promise(resolve => { liberar = resolve; });
    inboundContactLocks.set(key, lock);

    return () => {
        if (inboundContactLocks.get(key) === lock) inboundContactLocks.delete(key);
        liberar();
    };
}

function limparCacheMensagensProcessadas(agora = Date.now()) {
    if (processedMessageIds.size < 1000) return;
    for (const [id, processadaEm] of processedMessageIds) {
        if ((agora - Number(processadaEm || 0)) > PROCESSED_MESSAGE_TTL_MS) {
            processedMessageIds.delete(id);
        }
    }
}

function reservarMensagemParaProcessamento(messageId) {
    const id = String(messageId || '').trim();
    if (!id) return false;

    const agora = Date.now();
    const processadaEm = processedMessageIds.get(id);
    if (processing.has(id)) return false;
    if (processadaEm && (agora - processadaEm) <= PROCESSED_MESSAGE_TTL_MS) return false;

    if (processadaEm) processedMessageIds.delete(id);
    processing.add(id);
    limparCacheMensagensProcessadas(agora);
    return true;
}

function concluirMensagemProcessada(messageId) {
    const id = String(messageId || '').trim();
    if (!id) return;
    processing.delete(id);
    processedMessageIds.set(id, Date.now());
}

function timestampMensagemMs(msg) {
    const numero = numeroSeguroDeLong(msg?.messageTimestamp);
    if (!numero) return null;
    // messageTimestamp do WhatsApp é normalmente expresso em segundos Unix.
    return numero < 10_000_000_000 ? numero * 1000 : numero;
}

function mensagemUpsertEhRecente(msg, upsertType = 'notify') {
    // "notify" representa mensagem nova em tempo real. "append" também pode carregar
    // mensagem recente após reconexão, mas não devemos reprocessar histórico antigo.
    if (String(upsertType || '').toLowerCase() !== 'append') return true;
    const ts = timestampMensagemMs(msg);
    if (!ts) return true;
    return (Date.now() - ts) <= 5 * 60 * 1000;
}

function criarFingerprintPayload(chave, texto = '', isMedia = false, messageId = '') {
    if (isMedia) return null; // anexos são deduplicados pelo messageId, nunca pelo nome/conteúdo
    const normalizado = normalizarTexto(String(texto || '')).replace(/\s+/g, ' ').trim();
    if (!normalizado) return null;
    return `${String(chave || 'desconhecido')}::${normalizado}`;
}

function reservarPayloadEntrada(chave, texto = '', isMedia = false, messageId = '') {
    const fingerprint = criarFingerprintPayload(chave, texto, isMedia, messageId);
    if (!fingerprint) return { fingerprint: null, duplicado: false };
    if (inboundPayloadInFlight.has(fingerprint)) return { fingerprint, duplicado: true };
    inboundPayloadInFlight.add(fingerprint);
    return { fingerprint, duplicado: false };
}

function liberarPayloadEntrada(fingerprint) {
    if (fingerprint) inboundPayloadInFlight.delete(fingerprint);
}

let ticketsColl, authColl, knowledgeColl, knowledgeGapsColl, knowledgeWebSourcesColl, knowledgeWebPagesColl, userLoginColl, clientsColl, ticketHistoryColl, countersColl, menuOptionsColl, settingsColl, crmLeadsColl, ticketMessagesColl, baileysSentMessagesColl;

// -----------------------------------------------------------------------------
// USUÁRIOS, PERMISSÕES E CHAT DO PAINEL
// -----------------------------------------------------------------------------
const PERMISSOES_PAINEL = [
    'tickets', 'clients', 'chat', 'crm', 'crm_params', 'ticket_params', 'whatsapp', 'ia', 'menu', 'business_hours', 'users'
];
const PERMISSOES_ADVOGADO_PADRAO = ['tickets', 'clients', 'chat'];

// O histórico textual/metadados do chat é persistente e paginado.
// Não há mais exclusão automática por quantidade (antigo limite de 500) nem por idade
// (antigo TTL de 60 dias). Arquivos, imagens, áudios e vídeos continuam NÃO sendo
// armazenados como binário no MongoDB; ficam somente as referências/metadados/resumos.
// Caso futuramente seja necessário impor retenção, faça isso por política explícita,
// nunca silenciosamente durante o atendimento.
const CHAT_RETENTION_DAYS = null;
const CHAT_MAX_MESSAGES_PER_TICKET = null;
const CHAT_LIST_LIMIT_DEFAULT = 60;
const CHAT_LIST_LIMIT_MAX = 100;
const CHAT_MAX_TEXT_CHARS = 12000;
const CHAT_EDIT_WINDOW_MS = 15 * 60 * 1000;
const CHAT_MAX_CAPTION_CHARS = 2000;
const CHAT_MAX_UPLOAD_BYTES = 15 * 1024 * 1024;
const CHAT_MEDIA_REF_MAX_CHARS = 150_000;
const CHAT_MEDIA_CACHE_TTL_MS = 10 * 60 * 1000;
const CHAT_MEDIA_CACHE_MAX_BYTES = 40 * 1024 * 1024;
const BAILEYS_DEVICE_REFRESH_TTL_MS = 10 * 60 * 1000;
// Epoch persistido no MongoDB: mensagens anteriores à implantação do controle de
// leitura não aparecem como não lidas para todos os usuários de uma só vez.
let chatUnreadTrackingStartedAt = Date.now();
const chatLastTrimAt = new Map();
const chatMediaCache = new Map();
let chatMediaCacheBytes = 0;
const baileysDeviceRefreshAt = new Map();

// Cache efêmero de mensagens enviadas pelo Baileys. Não ocupa MongoDB e permite
// que a biblioteca recupere a mensagem original caso o WhatsApp solicite retry.
const BAILEYS_SENT_CACHE_TTL_MS = 30 * 60 * 1000;
const BAILEYS_SENT_CACHE_MAX = 1000;
const BAILEYS_SENT_STORE_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const BAILEYS_RETRY_COUNTER_TTL_MS = 60 * 60 * 1000;
const baileysSentMessageCache = new Map();

// Cache efêmero das fotos de perfil dos contatos. A URL do WhatsApp expira e pode
// mudar, portanto nunca é persistida no MongoDB. O cache reduz chamadas repetidas
// ao Baileys quando a Central de Atendimentos renderiza muitas conversas.
const WHATSAPP_PROFILE_PHOTO_CACHE_TTL_MS = 30 * 60 * 1000;
const WHATSAPP_PROFILE_PHOTO_NEGATIVE_TTL_MS = 10 * 60 * 1000;
const whatsappProfilePhotoCache = new Map();

// O cache de contagem de retry fica FORA do socket e sobrevive às recriações da
// conexão dentro do mesmo processo. Isso evita loops de retry após reconexões.
function criarCacheBaileysComTTL(ttlMs = BAILEYS_RETRY_COUNTER_TTL_MS, maxItems = 5000) {
    const mapa = new Map();
    const limpar = () => {
        const agora = Date.now();
        for (const [chave, item] of mapa) {
            if ((agora - Number(item?.savedAt || 0)) > ttlMs) mapa.delete(chave);
        }
        while (mapa.size > maxItems) {
            const primeira = mapa.keys().next().value;
            if (!primeira) break;
            mapa.delete(primeira);
        }
    };

    return {
        get: (key) => {
            const item = mapa.get(String(key));
            if (!item) return undefined;
            if ((Date.now() - Number(item.savedAt || 0)) > ttlMs) {
                mapa.delete(String(key));
                return undefined;
            }
            return item.value;
        },
        set: (key, value) => {
            mapa.set(String(key), { value, savedAt: Date.now() });
            if (mapa.size > maxItems) limpar();
            return true;
        },
        del: (key) => mapa.delete(String(key)),
        flushAll: () => mapa.clear()
    };
}

const baileysMsgRetryCounterCache = criarCacheBaileysComTTL();

function serializarMensagemRetryBaileys(message) {
    try {
        return JSON.stringify(message, BufferJSON.replacer);
    } catch (err) {
        console.warn('[WhatsApp] Não foi possível serializar mensagem para retry persistente:', err?.message || err);
        return null;
    }
}

function desserializarMensagemRetryBaileys(valor) {
    if (!valor) return undefined;
    try {
        return JSON.parse(String(valor), BufferJSON.reviver);
    } catch (err) {
        console.warn('[WhatsApp] Mensagem persistida de retry inválida:', err?.message || err);
        return undefined;
    }
}

function persistirMensagemEnviadaBaileys(sent) {
    const id = String(sent?.key?.id || '').trim();
    if (!id || !sent?.message || !baileysSentMessagesColl) return;

    const messageJson = serializarMensagemRetryBaileys(sent.message);
    if (!messageJson) return;

    const agora = new Date();
    const remoteJids = [...new Set([
        sent?.key?.remoteJid,
        sent?.key?.remoteJidAlt,
        sent?.key?.participant,
        sent?.key?.participantAlt
    ].filter(Boolean).map(String))];

    // Persistência assíncrona: o cache em memória cobre retries imediatos, enquanto
    // o MongoDB permite que getMessage continue funcionando após reconnect/restart.
    baileysSentMessagesColl.updateOne(
        { _id: id },
        {
            $set: {
                messageId: id,
                messageJson,
                remoteJids,
                savedAt: agora,
                expiresAt: new Date(agora.getTime() + BAILEYS_SENT_STORE_TTL_MS)
            }
        },
        { upsert: true }
    ).catch(err => {
        console.warn('[WhatsApp] Falha ao persistir mensagem para retry:', err?.message || err);
    });
}

function guardarMensagemEnviadaBaileys(sent) {
    const id = String(sent?.key?.id || '').trim();
    if (!id || !sent?.message) return;

    baileysSentMessageCache.set(id, { message: sent.message, savedAt: Date.now() });
    persistirMensagemEnviadaBaileys(sent);

    const agora = Date.now();
    for (const [cacheId, item] of baileysSentMessageCache) {
        if ((agora - Number(item?.savedAt || 0)) > BAILEYS_SENT_CACHE_TTL_MS) {
            baileysSentMessageCache.delete(cacheId);
        }
    }

    while (baileysSentMessageCache.size > BAILEYS_SENT_CACHE_MAX) {
        const primeiro = baileysSentMessageCache.keys().next().value;
        if (!primeiro) break;
        baileysSentMessageCache.delete(primeiro);
    }
}

async function obterMensagemEnviadaBaileys(key = {}) {
    const id = String(key?.id || '').trim();
    if (!id) return undefined;

    const item = baileysSentMessageCache.get(id);
    if (item) {
        if ((Date.now() - Number(item.savedAt || 0)) <= BAILEYS_SENT_CACHE_TTL_MS) {
            return item.message;
        }
        baileysSentMessageCache.delete(id);
    }

    if (!baileysSentMessagesColl) return undefined;

    try {
        const persistida = await baileysSentMessagesColl.findOne(
            { _id: id },
            { projection: { messageJson: 1, expiresAt: 1 } }
        );
        if (!persistida?.messageJson) return undefined;
        if (persistida.expiresAt && new Date(persistida.expiresAt).getTime() <= Date.now()) return undefined;

        const message = desserializarMensagemRetryBaileys(persistida.messageJson);
        if (message) {
            baileysSentMessageCache.set(id, { message, savedAt: Date.now() });
            return message;
        }
    } catch (err) {
        console.warn(`[WhatsApp] Falha ao recuperar mensagem ${id} para retry:`, err?.message || err);
    }

    return undefined;
}

async function executarEnvioSerializadoPorJid(jid, tarefa) {
    const chave = normalizarJid(jid) || String(jid || 'desconhecido');
    const anterior = outboundJidChains.get(chave) || Promise.resolve();

    let atual;
    atual = anterior
        .catch(() => {})
        .then(async () => {
            // Após abrir a conexão, damos uma margem curta para as init queries e
            // sincronização de dispositivos/chaves terminarem antes do primeiro envio.
            const desdeAbertura = Date.now() - Number(whatsappConnectionOpenedAt || 0);
            if (whatsappConnectionOpenedAt && desdeAbertura < 900) {
                await new Promise(resolve => setTimeout(resolve, 900 - desdeAbertura));
            }
            return tarefa();
        })
        .finally(() => {
            if (outboundJidChains.get(chave) === atual) outboundJidChains.delete(chave);
        });

    outboundJidChains.set(chave, atual);
    return atual;
}

async function enviarMensagemBaileys(jid, content, options = {}) {
    return executarEnvioSerializadoPorJid(jid, async () => {
        if (!sock?.user) throw new Error('WhatsApp não conectado.');

    const jidNormalizado = normalizarJid(jid) || String(jid || '');
    const opcaoExplicita = Object.prototype.hasOwnProperty.call(options, 'useUserDevicesCache');

    // CONFIABILIDADE > micro-otimização: em conversa 1:1, consultamos a lista de
    // dispositivos fresca por padrão. Chaves/dispositivos podem mudar sem que o envio
    // lance erro; nesses casos a mensagem pode aparecer como "Aguardando mensagem".
    // Quem precisar sobrescrever o comportamento ainda pode passar a opção explicitamente.
    const usarCacheDispositivos = opcaoExplicita ? options.useUserDevicesCache : false;

    try {
        const sent = await sock.sendMessage(jid, content, { ...options, useUserDevicesCache: usarCacheDispositivos });
        if (!usarCacheDispositivos) baileysDeviceRefreshAt.set(jidNormalizado, Date.now());
        guardarMensagemEnviadaBaileys(sent);
        return sent;
    } catch (err) {
        // Se o chamador forçou cache e houver falha explícita, fazemos uma única
        // tentativa com device list fresca. Não repetimos indefinidamente.
        if (usarCacheDispositivos) {
            console.warn(`[WhatsApp] Envio com cache de dispositivos falhou para ${jidNormalizado}; repetindo com atualização fresca.`);
            const sent = await sock.sendMessage(jid, content, { ...options, useUserDevicesCache: false });
            baileysDeviceRefreshAt.set(jidNormalizado, Date.now());
            guardarMensagemEnviadaBaileys(sent);
            return sent;
        }
        throw err;
    }
    });
}

function normalizarUsuarioLogin(valor = '') {
    return String(valor || '').trim().toLowerCase().replace(/\s+/g, '');
}

function normalizarPapelUsuario(valor = '') {
    return String(valor || '').toLowerCase() === 'advogado' ? 'advogado' : 'admin';
}

function normalizarPermissoesUsuario(conta = {}) {
    if (normalizarPapelUsuario(conta.role) === 'admin') return [...PERMISSOES_PAINEL];
    const recebidas = Array.isArray(conta.permissions) ? conta.permissions : PERMISSOES_ADVOGADO_PADRAO;
    return [...new Set(recebidas.map(String).filter(item => PERMISSOES_PAINEL.includes(item)))];
}

function usuarioDaSessao(req) {
    return req?.session?.panelUser || null;
}

function usuarioPode(req, permissao) {
    const user = usuarioDaSessao(req);
    if (!req?.session?.loggedIn || !user) return false;
    if (user.role === 'admin') return true;
    return Array.isArray(user.permissions) && user.permissions.includes(permissao);
}

function exigirLogin(req, res, next) {
    if (!req.session?.loggedIn || !req.session?.panelUser) {
        return res.status(401).json({ erro: 'Sessão expirada. Faça login novamente.' });
    }
    next();
}

function exigirPermissao(permissao) {
    return (req, res, next) => {
        if (!req.session?.loggedIn || !req.session?.panelUser) {
            return res.status(401).json({ erro: 'Sessão expirada. Faça login novamente.' });
        }
        if (!usuarioPode(req, permissao)) {
            return res.status(403).json({ erro: 'Seu usuário não possui permissão para acessar este recurso.' });
        }
        next();
    };
}

function assinaturaPadraoUsuario(nome = '') {
    const limpo = String(nome || '').trim();
    return limpo ? `Dr(a). ${limpo}` : 'Advogado(a)';
}

function sessaoPublicaDaConta(conta = {}) {
    const nome = String(conta.nome || conta.nomeCompleto || conta.user || 'Usuário').trim();
    const assinatura = String(conta.assinatura || assinaturaPadraoUsuario(nome)).trim();
    const role = normalizarPapelUsuario(conta.role);
    return {
        id: String(conta._id || ''),
        user: String(conta.user || '').trim(),
        nome,
        assinatura,
        email: String(conta.email || '').trim(),
        oab: String(conta.oab || '').trim(),
        celular: String(conta.celular || '').trim(),
        theme: String(conta.theme || '').toLowerCase() === 'dark' ? 'dark' : 'light',
        lastAccessAt: Number(conta.lastAccessAt || 0) || null,
        role,
        roleLabel: role === 'admin' ? 'Administrador' : 'Advogado',
        permissions: normalizarPermissoesUsuario(conta)
    };
}

function hashSenhaPainel(senha, salt = crypto.randomBytes(16).toString('hex')) {
    const hash = crypto.scryptSync(String(senha), salt, 64).toString('hex');
    return { salt, hash };
}

function validarSenhaPainel(senha, conta = {}) {
    if (conta.passwordHash && conta.passwordSalt) {
        try {
            const atual = crypto.scryptSync(String(senha), String(conta.passwordSalt), 64);
            const esperado = Buffer.from(String(conta.passwordHash), 'hex');
            return atual.length === esperado.length && crypto.timingSafeEqual(atual, esperado);
        } catch (_) { return false; }
    }
    // Compatibilidade com o cadastro antigo. Ao primeiro login bem-sucedido,
    // a senha em texto simples é migrada automaticamente para scrypt.
    return typeof conta.pass === 'string' && conta.pass === String(senha);
}

async function migrarSenhaLegadaSeNecessario(conta, senha) {
    if (!conta?._id || !conta.pass || conta.passwordHash) return;
    const cred = hashSenhaPainel(senha);
    await userLoginColl.updateOne(
        { _id: conta._id },
        {
            $set: { passwordHash: cred.hash, passwordSalt: cred.salt, updatedAt: Date.now() },
            $unset: { pass: '' }
        }
    );
}

function limitarTextoChat(valor, max = CHAT_MAX_TEXT_CHARS) {
    return String(valor ?? '').trim().slice(0, max);
}


function extrairMidiaChat(msg) {
    const conteudo = conteudoMensagemDesembrulhado(msg);
    let payload = null;
    let tipo = null;
    let nomeArquivo = null;

    if (conteudo.imageMessage) {
        payload = conteudo.imageMessage; tipo = 'image'; nomeArquivo = payload.fileName || 'imagem.jpg';
    } else if (conteudo.videoMessage) {
        payload = conteudo.videoMessage; tipo = 'video'; nomeArquivo = payload.fileName || 'video.mp4';
    } else if (conteudo.audioMessage) {
        payload = conteudo.audioMessage; tipo = 'audio'; nomeArquivo = payload.fileName || 'audio';
    } else if (conteudo.documentMessage) {
        payload = conteudo.documentMessage; tipo = 'document'; nomeArquivo = payload.fileName || payload.title || 'documento';
    } else if (conteudo.stickerMessage) {
        payload = conteudo.stickerMessage; tipo = 'sticker'; nomeArquivo = 'figurinha.webp';
    }

    if (!payload || !tipo) return null;
    const mimeDeclarado = limitarTextoChat(payload.mimetype || '', 120).toLowerCase().split(';')[0].trim();
    const mimeType = mimeDeclarado || mimePorExtensao(nomeArquivo) || (
        tipo === 'image' ? 'image/jpeg' : tipo === 'video' ? 'video/mp4' :
        tipo === 'audio' ? 'audio/ogg' : tipo === 'sticker' ? 'image/webp' : 'application/octet-stream'
    );

    return {
        payload, tipo,
        nomeArquivo: limitarTextoChat(nomeArquivo, 240),
        mimeType,
        tamanhoDeclarado: numeroSeguroDeLong(payload.fileLength)
    };
}

function criarReferenciaMidiaChat(msg) {
    const media = extrairMidiaChat(msg);
    if (!msg || !media?.payload) return null;
    const camposPermitidos = [
        'url', 'directPath', 'mediaKey', 'fileEncSha256', 'fileSha256', 'fileLength',
        'mediaKeyTimestamp', 'mimetype', 'fileName', 'title', 'caption', 'seconds',
        'ptt', 'gifPlayback', 'isAnimated', 'width', 'height'
    ];
    const payloadMinimo = {};
    for (const campo of camposPermitidos) {
        if (media.payload[campo] !== undefined && media.payload[campo] !== null) payloadMinimo[campo] = media.payload[campo];
    }
    try {
        const serializado = JSON.stringify({
            tipo: media.tipo,
            remoteJid: msg?.key?.remoteJid || null,
            remoteJidAlt: msg?.key?.remoteJidAlt || null,
            payload: payloadMinimo
        }, BufferJSON.replacer);
        if (!serializado || serializado.length > CHAT_MEDIA_REF_MAX_CHARS) return null;
        return serializado;
    } catch (err) {
        console.warn('[Chat] Não foi possível criar referência do anexo:', err?.message || err);
        return null;
    }
}

function reconstruirMensagemMidiaChat(mediaRef, messageId, direction = 'in') {
    if (!mediaRef || !messageId) return null;
    try {
        const dados = JSON.parse(String(mediaRef), BufferJSON.reviver);
        const campoPorTipo = {
            image: 'imageMessage', video: 'videoMessage', audio: 'audioMessage',
            document: 'documentMessage', sticker: 'stickerMessage'
        };
        const campo = campoPorTipo[dados?.tipo];
        if (!campo || !dados?.payload) return null;
        return {
            key: {
                id: String(messageId),
                remoteJid: dados.remoteJid || dados.remoteJidAlt || null,
                remoteJidAlt: dados.remoteJidAlt || null,
                fromMe: direction === 'out'
            },
            message: { [campo]: dados.payload }
        };
    } catch (err) {
        console.warn('[Chat] Referência de mídia inválida:', err?.message || err);
        return null;
    }
}

function obterMidiaCacheChat(chave) {
    const item = chatMediaCache.get(chave);
    if (!item) return null;
    if ((Date.now() - item.savedAt) > CHAT_MEDIA_CACHE_TTL_MS) {
        chatMediaCache.delete(chave);
        chatMediaCacheBytes = Math.max(0, chatMediaCacheBytes - item.buffer.length);
        return null;
    }
    chatMediaCache.delete(chave);
    chatMediaCache.set(chave, item);
    return item;
}

function salvarMidiaCacheChat(chave, buffer, mimeType, fileName) {
    if (!Buffer.isBuffer(buffer) || !buffer.length || buffer.length > CHAT_MEDIA_CACHE_MAX_BYTES) return;
    const anterior = chatMediaCache.get(chave);
    if (anterior) chatMediaCacheBytes = Math.max(0, chatMediaCacheBytes - anterior.buffer.length);
    chatMediaCache.set(chave, { buffer, mimeType, fileName, savedAt: Date.now() });
    chatMediaCacheBytes += buffer.length;
    while (chatMediaCacheBytes > CHAT_MEDIA_CACHE_MAX_BYTES && chatMediaCache.size) {
        const primeiraChave = chatMediaCache.keys().next().value;
        const item = chatMediaCache.get(primeiraChave);
        chatMediaCache.delete(primeiraChave);
        if (item?.buffer) chatMediaCacheBytes = Math.max(0, chatMediaCacheBytes - item.buffer.length);
    }
}

function nomeArquivoSeguroHeader(valor = 'arquivo') {
    return String(valor || 'arquivo').replace(/[\r\n"]/g, '_').slice(0, 180) || 'arquivo';
}

function enviarBufferMidiaChat(req, res, buffer, mimeType, fileName, download = false) {
    const tamanho = buffer.length;
    const disposition = download ? 'attachment' : 'inline';
    res.setHeader('Content-Type', mimeType || 'application/octet-stream');
    res.setHeader('Content-Disposition', `${disposition}; filename="${nomeArquivoSeguroHeader(fileName)}"`);
    res.setHeader('Cache-Control', 'private, max-age=300');
    res.setHeader('Accept-Ranges', 'bytes');

    const range = req.headers.range;
    if (range) {
        const match = String(range).match(/bytes=(\d*)-(\d*)/);
        if (match) {
            const start = match[1] ? Number(match[1]) : 0;
            const end = match[2] ? Math.min(Number(match[2]), tamanho - 1) : tamanho - 1;
            if (Number.isFinite(start) && Number.isFinite(end) && start >= 0 && start <= end && start < tamanho) {
                res.status(206);
                res.setHeader('Content-Range', `bytes ${start}-${end}/${tamanho}`);
                res.setHeader('Content-Length', end - start + 1);
                return res.end(buffer.subarray(start, end + 1));
            }
        }
    }
    res.setHeader('Content-Length', tamanho);
    return res.end(buffer);
}

function normalizarReplyToChat(replyTo = null) {
    if (!replyTo || typeof replyTo !== 'object') return null;
    const messageId = limitarTextoChat(replyTo.messageId || '', 180);
    if (!messageId) return null;
    return {
        messageId,
        direction: replyTo.direction === 'out' ? 'out' : 'in',
        tipo: limitarTextoChat(replyTo.tipo || 'text', 30) || 'text',
        texto: limitarTextoChat(replyTo.texto || '', 700),
        fileName: replyTo.fileName ? limitarTextoChat(replyTo.fileName, 180) : null,
        senderName: replyTo.senderName ? limitarTextoChat(replyTo.senderName, 160) : null
    };
}

function contextoInfoMensagemChat(conteudo = {}) {
    return conteudo.extendedTextMessage?.contextInfo ||
        conteudo.imageMessage?.contextInfo ||
        conteudo.videoMessage?.contextInfo ||
        conteudo.audioMessage?.contextInfo ||
        conteudo.documentMessage?.contextInfo ||
        conteudo.stickerMessage?.contextInfo || null;
}

function resumoQuotedMessageChat(quotedMessage = {}) {
    if (!quotedMessage || typeof quotedMessage !== 'object') return { tipo: 'text', texto: '' };
    const texto = limitarTextoChat(
        quotedMessage.conversation || quotedMessage.extendedTextMessage?.text ||
        quotedMessage.imageMessage?.caption || quotedMessage.videoMessage?.caption ||
        quotedMessage.documentMessage?.caption || '', 700
    );
    if (quotedMessage.imageMessage) return { tipo: 'image', texto, fileName: quotedMessage.imageMessage.fileName || 'Imagem' };
    if (quotedMessage.videoMessage) return { tipo: 'video', texto, fileName: quotedMessage.videoMessage.fileName || 'Vídeo' };
    if (quotedMessage.audioMessage) return { tipo: 'audio', texto, fileName: 'Áudio' };
    if (quotedMessage.documentMessage) return { tipo: 'document', texto, fileName: quotedMessage.documentMessage.fileName || quotedMessage.documentMessage.title || 'Documento' };
    if (quotedMessage.stickerMessage) return { tipo: 'sticker', texto, fileName: 'Figurinha' };
    return { tipo: 'text', texto };
}

function extrairReplyToWhatsAppChat(msg) {
    const conteudo = conteudoMensagemDesembrulhado(msg);
    const contextInfo = contextoInfoMensagemChat(conteudo);
    const messageId = limitarTextoChat(contextInfo?.stanzaId || '', 180);
    if (!messageId) return null;
    const resumo = resumoQuotedMessageChat(contextInfo?.quotedMessage || {});
    return normalizarReplyToChat({
        messageId,
        direction: msg?.key?.fromMe ? 'in' : 'out',
        ...resumo,
        senderName: msg?.key?.fromMe ? 'Cliente' : 'Escritório'
    });
}

function snapshotReplyToDocChat(doc = {}) {
    if (!doc?.messageId) return null;
    return normalizarReplyToChat({
        messageId: doc.messageId,
        direction: doc.direction,
        tipo: doc.tipo,
        texto: doc.texto || '',
        fileName: doc.fileName || null,
        senderName: doc.direction === 'in' ? 'Cliente' : (doc.senderName || (doc.source === 'bot' ? 'Assistente automático' : 'Escritório'))
    });
}

async function prepararQuotedMessageChat(ticketNumber, jid, replyToMessageId) {
    const id = limitarTextoChat(replyToMessageId || '', 180);
    if (!id || !ticketMessagesColl) return { quoted: null, snapshot: null };
    const original = await ticketMessagesColl.findOne({ ticketNumber: String(ticketNumber), messageId: id });
    if (!original) {
        const erro = new Error('A mensagem escolhida para resposta não está mais disponível no histórico.');
        erro.statusCode = 409;
        throw erro;
    }

    let quoted = null;
    if (original.mediaRef) {
        quoted = reconstruirMensagemMidiaChat(original.mediaRef, original.messageId, original.direction || 'in');
        if (quoted?.key) quoted.key.remoteJid = jid;
    }
    if (!quoted) {
        const texto = limitarTextoChat(original.texto || original.fileName || 'Mensagem', CHAT_MAX_TEXT_CHARS) || 'Mensagem';
        quoted = {
            key: { id: String(original.messageId), remoteJid: jid, fromMe: original.direction === 'out' },
            message: { conversation: texto }
        };
    }
    return { quoted, snapshot: snapshotReplyToDocChat(original) };
}

function serializarMensagemChat(doc = {}) {
    return {
        id: String(doc._id || `${doc.ticketNumber || ''}:${doc.messageId || ''}`),
        ticketNumber: doc.ticketNumber || null,
        messageId: doc.messageId || null,
        direction: doc.direction || 'in',
        source: doc.source || 'cliente',
        tipo: doc.tipo || 'text',
        texto: doc.texto || '',
        fileName: doc.fileName || null,
        mimeType: doc.mimeType || null,
        fileSize: Number(doc.fileSize || 0) || null,
        hasMedia: !!doc.mediaRef || ['image', 'audio', 'video', 'document', 'sticker'].includes(doc.tipo),
        senderId: doc.senderId || null,
        senderName: doc.senderName || null,
        replyTo: normalizarReplyToChat(doc.replyTo || null),
        createdAt: doc.createdAt instanceof Date ? doc.createdAt.getTime() : Number(doc.createdAt || Date.now()),
        editedAt: doc.editedAt instanceof Date ? doc.editedAt.getTime() : (Number(doc.editedAt || 0) || null),
        editCount: Number(doc.editCount || 0) || 0
    };
}

async function apararHistoricoChatSeNecessario(ticketNumber) {
    // Mantido por compatibilidade com os pontos que registram mensagens.
    // A partir da V7, o histórico NÃO é aparado por quantidade. O carregamento
    // continua paginado, então tickets extensos não precisam ser renderizados de uma vez.
    return;
}

async function removerPoliticasLegadasHistoricoChat() {
    if (!ticketMessagesColl) return;
    try {
        const indexes = await ticketMessagesColl.indexes();
        for (const index of indexes) {
            const ehIndiceCreatedAt = index?.key && Object.keys(index.key).length === 1 && Number(index.key.createdAt) === 1;
            if (ehIndiceCreatedAt && index.expireAfterSeconds !== undefined) {
                await ticketMessagesColl.dropIndex(index.name);
                console.log(`[Chat] TTL legado removido do histórico (${index.name}). Mensagens não expiram mais automaticamente.`);
            }
        }
    } catch (err) {
        // Namespace ainda vazio/índice inexistente não deve impedir a inicialização.
        console.warn('[Chat] Não foi possível revisar o TTL legado do histórico:', err?.message || err);
    }
}

async function registrarMensagemChat(documento = {}) {
    if (!ticketMessagesColl || !documento.ticketNumber || !documento.messageId) return null;
    const registro = {
        _id: documento._id || `msg_${documento.ticketNumber}_${documento.messageId}`,
        ticketNumber: String(documento.ticketNumber),
        messageId: String(documento.messageId),
        direction: documento.direction === 'out' ? 'out' : 'in',
        source: String(documento.source || (documento.direction === 'out' ? 'painel' : 'cliente')).slice(0, 40),
        tipo: String(documento.tipo || 'text').slice(0, 30),
        texto: limitarTextoChat(documento.texto || '', CHAT_MAX_TEXT_CHARS),
        fileName: documento.fileName ? limitarTextoChat(documento.fileName, 240) : null,
        mimeType: documento.mimeType ? limitarTextoChat(documento.mimeType, 120) : null,
        fileSize: Number(documento.fileSize || 0) || null,
        mediaRef: documento.mediaRef ? String(documento.mediaRef).slice(0, CHAT_MEDIA_REF_MAX_CHARS) : null,
        senderId: documento.senderId ? String(documento.senderId).slice(0, 120) : null,
        senderName: documento.senderName ? limitarTextoChat(documento.senderName, 180) : null,
        replyTo: normalizarReplyToChat(documento.replyTo || null),
        createdAt: documento.createdAt instanceof Date ? documento.createdAt : new Date(Number(documento.createdAt || Date.now()))
    };

    if (!registro.texto) delete registro.texto;
    if (!registro.fileName) delete registro.fileName;
    if (!registro.mimeType) delete registro.mimeType;
    if (!registro.fileSize) delete registro.fileSize;
    if (!registro.mediaRef) delete registro.mediaRef;
    if (!registro.senderId) delete registro.senderId;
    if (!registro.senderName) delete registro.senderName;
    if (!registro.replyTo) delete registro.replyTo;

    try {
        await ticketMessagesColl.insertOne(registro);
        const serializada = serializarMensagemChat(registro);
        io.emit('ticket_chat_message', { ticketNumber: registro.ticketNumber, message: serializada });
        apararHistoricoChatSeNecessario(registro.ticketNumber);
        return serializada;
    } catch (err) {
        if (err?.code === 11000) return null;
        throw err;
    }
}

function dadosMensagemChatWhatsApp(msg) {
    const conteudo = conteudoMensagemDesembrulhado(msg);
    const texto = limitarTextoChat(
        conteudo.conversation ||
        conteudo.extendedTextMessage?.text ||
        conteudo.imageMessage?.caption ||
        conteudo.videoMessage?.caption ||
        conteudo.documentMessage?.caption ||
        '',
        CHAT_MAX_TEXT_CHARS
    );
    const media = extrairMidiaAnalisavel(msg);
    let tipo = 'text';
    if (conteudo.imageMessage) tipo = 'image';
    else if (conteudo.audioMessage) tipo = 'audio';
    else if (conteudo.videoMessage) tipo = 'video';
    else if (conteudo.documentMessage) tipo = 'document';
    else if (conteudo.stickerMessage) tipo = 'sticker';

    return {
        tipo,
        texto,
        fileName: media?.nomeArquivo || (tipo !== 'text' ? tipo : null),
        mimeType: media?.mimeType || null,
        fileSize: media?.tamanhoDeclarado || null,
        mediaRef: tipo !== 'text' ? criarReferenciaMidiaChat(msg) : null,
        replyTo: extrairReplyToWhatsAppChat(msg)
    };
}

async function registrarMensagemClienteChat(ticket, msg) {
    if (!ticket?.ticketNumber || !msg?.key?.id || msg?.key?.fromMe) return;
    const dados = dadosMensagemChatWhatsApp(msg);
    if (!dados.texto && dados.tipo === 'text') return;
    const agora = Date.now();
    const registrada = await registrarMensagemChat({
        ticketNumber: ticket.ticketNumber,
        messageId: msg.key.id,
        direction: 'in',
        source: 'cliente',
        ...dados,
        createdAt: agora
    });

    // Cursor leve de leitura: evita contar mensagens do próprio escritório como não lidas.
    // A leitura é individual por usuário e fica em active_tickets.chatLeituras.<userKey>.
    if (registrada && ticketsColl) {
        await ticketsColl.updateOne(
            { _id: ticket._id },
            { $set: { lastInboundChatAt: agora, lastInboundChatMessageId: String(msg.key.id) } }
        ).catch(() => {});
        atualizarHistorico(ticket.ticketNumber, {
            lastInboundChatAt: agora,
            lastInboundChatMessageId: String(msg.key.id)
        }).catch(() => {});
    }

    io.emit('ticket_activity_updated', {
        ticketNumber: ticket.ticketNumber,
        direction: 'in',
        lastActivity: agora,
        lastInboundChatAt: agora,
        hasNewInbound: !!registrada
    });
}

async function registrarMensagemManualWhatsAppChat(ticket, msg) {
    if (!ticket?.ticketNumber || !msg?.key?.id || !msg?.key?.fromMe) return;
    const dados = dadosMensagemChatWhatsApp(msg);
    if (!dados.texto && dados.tipo === 'text') return;
    await registrarMensagemChat({
        ticketNumber: ticket.ticketNumber,
        messageId: msg.key.id,
        direction: 'out',
        source: 'whatsapp_manual',
        senderName: 'Escritório (WhatsApp)',
        ...dados,
        createdAt: Date.now()
    });
}

function filtrosTicketPorJidChat(jid = '') {
    const normalizado = normalizarJid(String(jid || ''));
    const numero = normalizarNumeroWhatsApp(normalizado || jid);
    const filtros = [];
    if (normalizado) {
        filtros.push({ _id: normalizado }, { lastRawJid: normalizado }, { identificadores: normalizado });
    }
    if (numero) {
        filtros.push({ _id: numero }, { numeroReal: numero }, { whatsappNumbers: numero }, { identificadores: numero });
    }
    return filtros;
}

async function registrarMensagemAutomaticaChat(jid, sent, content) {
    if (!ticketMessagesColl || !ticketsColl || !sent?.key?.id || !content?.text) return;
    const filtros = filtrosTicketPorJidChat(jid);
    if (!filtros.length) return;
    const ticket = await ticketsColl.findOne({ $or: filtros }, { projection: { ticketNumber: 1 } });
    if (!ticket?.ticketNumber) return;
    await registrarMensagemChat({
        ticketNumber: ticket.ticketNumber,
        messageId: sent.key.id,
        direction: 'out',
        source: 'bot',
        tipo: 'text',
        texto: limitarTextoChat(content.text, CHAT_MAX_TEXT_CHARS),
        senderName: 'Assistente automático',
        createdAt: Date.now()
    });
}

async function destinoWhatsAppTicket(ticket = {}) {
    // IMPORTANTE — WhatsApp Multi-Device / LID:
    // o CHAT HUMANO deve continuar a conversa usando o MESMO modo de endereçamento
    // observado nas mensagens recebidas. A triagem já faz isso porque responde ao
    // rawJid do upsert. Forçar sempre numero@s.whatsapp.net (PN) aqui pode abrir uma
    // rota criptográfica diferente daquela usada pelo celular do cliente e resultar
    // em "Aguardando mensagem" principalmente em contas/conversas migradas para LID.
    //
    // Ordem segura:
    //   1) lastRawJid, quando for LID;
    //   2) algum LID já observado no ticket;
    //   3) se só houver PN, consultar PN -> LID no Signal Repository;
    //   4) PN como fallback para contatos que ainda não usam LID.

    const identificadores = [
        ticket.lastRawJid,
        ...(Array.isArray(ticket.identificadores) ? ticket.identificadores : [])
    ]
        .map(valor => normalizarJid(String(valor || '')))
        .filter(Boolean);

    const lastRawJid = normalizarJid(String(ticket.lastRawJid || ''));

    // Se a última mensagem do cliente chegou por LID, esta é a rota mais fiel à
    // conversa ativa e deve ser preservada no envio feito pelo advogado.
    if (lastRawJid?.endsWith('@lid')) {
        console.log(`[Chat][Destino] Ticket ${ticket.ticketNumber || '-'} usando LID da conversa: ${lastRawJid}`);
        return lastRawJid;
    }

    // Mesmo que lastRawJid antigo seja PN, um LID observado posteriormente no ticket
    // é preferível ao PN para conversas já migradas para o addressingMode=lid.
    const lidObservado = identificadores.find(jid => String(jid).endsWith('@lid'));
    if (lidObservado) {
        console.log(`[Chat][Destino] Ticket ${ticket.ticketNumber || '-'} usando LID observado: ${lidObservado}`);
        return lidObservado;
    }

    const numero = whatsappDoTicket(ticket);
    const pnJid = numero
        ? normalizarJid(`${numero}@s.whatsapp.net`)
        : identificadores.find(jid => String(jid).endsWith('@s.whatsapp.net')) || null;

    // Nas versões atuais do Baileys, o Signal Repository pode conhecer o LID mesmo
    // quando o ticket só guardou o PN. Se houver mapeamento, roteamos pelo LID.
    if (pnJid && sock?.signalRepository?.lidMapping?.getLIDForPN) {
        try {
            const lidMapeado = normalizarJid(await sock.signalRepository.lidMapping.getLIDForPN(pnJid));
            if (lidMapeado?.endsWith('@lid')) {
                console.log(`[Chat][Destino] Ticket ${ticket.ticketNumber || '-'} mapeou ${pnJid} -> ${lidMapeado}`);

                if (ticket?._id && ticketsColl) {
                    await ticketsColl.updateOne(
                        { _id: ticket._id },
                        {
                            $set: { lastActivity: Date.now() },
                            $addToSet: { identificadores: lidMapeado }
                        }
                    ).catch(() => {});
                }

                return lidMapeado;
            }
        } catch (err) {
            console.warn(`[Chat][Destino] Não foi possível resolver PN ${pnJid} para LID:`, err?.message || err);
        }
    }

    if (pnJid) {
        console.log(`[Chat][Destino] Ticket ${ticket.ticketNumber || '-'} sem LID conhecido; usando PN: ${pnJid}`);
        return pnJid;
    }

    return null;
}

function identidadeAdvogadoSessao(req) {
    const user = usuarioDaSessao(req) || {};
    return {
        id: String(user.id || ''),
        nome: String(user.nome || user.user || 'Advogado(a)').trim(),
        assinatura: String(user.assinatura || assinaturaPadraoUsuario(user.nome || user.user)).trim()
    };
}


function chaveLeituraChatUsuario(req) {
    const user = usuarioDaSessao(req) || {};
    const base = String(user.id || user.user || '').trim();
    if (!base) return null;
    // Chave segura para subdocumento MongoDB (sem pontos/$).
    return `u_${base.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 80)}`;
}

function timestampLeituraChatTicket(ticket = {}, chave = '') {
    if (!chave) return Number(chatUnreadTrackingStartedAt || 0);
    const valor = ticket?.chatLeituras?.[chave];
    if (valor instanceof Date) return valor.getTime();
    const numero = Number(valor || 0);
    if (Number.isFinite(numero) && numero > 0) return numero;
    return Number(chatUnreadTrackingStartedAt || 0);
}

async function marcarTicketChatComoLido(ticketNumber, req, momento = Date.now()) {
    if (!ticketsColl) return false;
    const chave = chaveLeituraChatUsuario(req);
    const numero = String(ticketNumber || '').trim();
    if (!chave || !numero) return false;
    const resultado = await ticketsColl.updateOne(
        { ticketNumber: numero },
        { $set: { [`chatLeituras.${chave}`]: Number(momento) || Date.now() } }
    );
    return !!resultado.matchedCount;
}


function nomeAdvogadoParaWhatsApp(advogado = {}) {
    const nome = String(advogado?.nome || '').trim();
    let assinatura = String(advogado?.assinatura || '').trim();

    // Preserva assinatura explicitamente configurada (Dr./Dra.) e transforma o
    // padrão genérico "Dr(a)." em "Dr." para uma apresentação mais natural.
    if (assinatura) {
        assinatura = assinatura
            .replace(/^dr\(a\)\.?\s*/i, 'Dr ')
            .replace(/^dra\.?\s*/i, 'Dra ')
            .replace(/^dr\.?\s*/i, 'Dr ')
            .replace(/^doutor\(a\)\s+/i, 'Dr ')
            .replace(/^doutora\s+/i, 'Dra ')
            .replace(/^doutor\s+/i, 'Dr ')
            .trim();
        if (assinatura) return assinatura;
    }

    return nome ? `Dr ${nome}` : 'Advogado responsável';
}

function assinaturaNegritoWhatsApp(advogado = {}) {
    return `*${nomeAdvogadoParaWhatsApp(advogado)}*`;
}

async function enviarAvisoAssuncaoAoCliente(ticket, advogado) {
    if (!ticket?.ticketNumber || !sock?.user) return false;

    // A mensagem é apenas informativa. Ela é enviada como mensagem automática do
    // sistema e, portanto, NÃO aciona atualizarEstadoPosEnvioChat nem pausa o fluxo.
    try {
        const jid = await destinoWhatsAppTicket(ticket);
        if (!jid) {
            console.warn(`[Ticket ${ticket.ticketNumber}] Não foi possível identificar o WhatsApp para avisar a assunção.`);
            return false;
        }

        const nomeExibicao = nomeAdvogadoParaWhatsApp(advogado);
        const artigo = /^Dra\b/i.test(nomeExibicao) ? 'A' : 'O';
        const texto = `${artigo} *${nomeExibicao}* assumiu seu atendimento.`;
        const sent = await sendBotMsg(jid, { text: texto });
        if (!sent?.key?.id) return false;

        const agora = Date.now();
        await Promise.allSettled([
            ticketsColl?.updateOne(
                { _id: ticket._id },
                {
                    $set: {
                        mensagemAssuncaoEnviadaEm: agora,
                        mensagemAssuncaoAdvogadoId: String(advogado?.id || '') || null
                    }
                }
            ),
            atualizarHistorico(ticket.ticketNumber, {
                mensagemAssuncaoEnviadaEm: agora,
                mensagemAssuncaoAdvogadoId: String(advogado?.id || '') || null,
                mensagemAssuncaoAdvogadoNome: nomeAdvogadoParaWhatsApp(advogado)
            })
        ]);

        return true;
    } catch (err) {
        console.warn(`[Ticket ${ticket?.ticketNumber || '-'}] Falha ao enviar aviso de assunção:`, err?.message || err);
        return false;
    }
}

async function enviarAvisoEncerramentoAoCliente(ticket, advogado) {
    if (!ticket?.ticketNumber || !sock?.user) return false;

    // O aviso é enviado ANTES do arquivamento enquanto o ticket ainda existe em
    // active_tickets. Assim ele também fica registrado no histórico leve do chat.
    // Como usa sendBotMsg, continua sendo uma mensagem automática do sistema e não
    // é tratada como uma nova intervenção manual do advogado.
    try {
        const jid = await destinoWhatsAppTicket(ticket);
        if (!jid) {
            console.warn(`[Ticket ${ticket.ticketNumber}] Não foi possível identificar o WhatsApp para avisar o encerramento.`);
            return false;
        }

        const nomeExibicao = nomeAdvogadoParaWhatsApp(advogado);
        const artigo = /^Dra\b/i.test(nomeExibicao) ? 'A' : 'O';
        const texto = `${artigo} *${nomeExibicao}* encerrou seu atendimento. Agradecemos pelo contato e permanecemos à disposição.`;
        const sent = await sendBotMsg(jid, { text: texto });
        return !!sent?.key?.id;
    } catch (err) {
        console.warn(`[Ticket ${ticket?.ticketNumber || '-'}] Falha ao enviar aviso de encerramento:`, err?.message || err);
        return false;
    }
}

// -----------------------------------------------------------------------------
// ATRIBUIÇÃO OPERACIONAL DE ATENDIMENTO
// -----------------------------------------------------------------------------
// Abrir/visualizar o chat é SOMENTE LEITURA e nunca atribui responsável.
// A atribuição ocorre exclusivamente por ação explícita em /claim. Se outro advogado
// já estiver responsável, a mesma ação explícita transfere o atendimento de forma
// atômica. Enviar mensagem/arquivo exige que o usuário atual seja o responsável.
async function assumirTicketParaAdvogado(ticketNumber, advogado, { emitirEvento = true, permitirTransferencia = true } = {}) {
    if (!ticketsColl) {
        return { ok: false, status: 503, erro: 'Banco de dados ainda não está disponível.' };
    }

    const numero = String(ticketNumber || '').trim();
    const advogadoId = String(advogado?.id || '').trim();
    const advogadoNome = String(advogado?.nome || advogado?.assinatura || 'Advogado(a)').trim();

    if (!numero || !advogadoId) {
        return { ok: false, status: 400, erro: 'Não foi possível identificar o ticket ou o usuário conectado.' };
    }

    const projection = {
        _id: 1,
        ticketNumber: 1,
        status: 1,
        paused: 1,
        until: 1,
        clienteId: 1,
        advogadoResponsavelId: 1,
        advogadoResponsavelNome: 1,
        atendimentoAssumidoEm: 1,
        lastActivity: 1,
        numeroReal: 1,
        whatsappNumbers: 1,
        identificadores: 1,
        lastRawJid: 1,
        mensagemAssuncaoEnviadaEm: 1,
        mensagemAssuncaoAdvogadoId: 1
    };

    const atual = await ticketsColl.findOne({ ticketNumber: numero }, { projection });
    if (!atual) {
        return { ok: false, status: 404, erro: 'Ticket ativo não encontrado.' };
    }

    const responsavelAtualId = String(atual.advogadoResponsavelId || '').trim();
    const responsavelAtualNome = String(atual.advogadoResponsavelNome || '').trim();

    if (responsavelAtualId === advogadoId) {
        return {
            ok: true,
            alreadyOwned: true,
            transferred: false,
            ticket: atual,
            responsavel: { id: advogadoId, nome: responsavelAtualNome || advogadoNome }
        };
    }

    if (responsavelAtualId && !permitirTransferencia) {
        return {
            ok: false,
            status: 409,
            erro: `Este atendimento já está com ${responsavelAtualNome || 'outro advogado'}.`,
            responsavel: { id: responsavelAtualId, nome: responsavelAtualNome || 'Outro advogado' }
        };
    }

    const agora = Date.now();
    const filtroAtomico = responsavelAtualId
        ? { ticketNumber: numero, advogadoResponsavelId: responsavelAtualId }
        : {
            ticketNumber: numero,
            $or: [
                { advogadoResponsavelId: { $exists: false } },
                { advogadoResponsavelId: null },
                { advogadoResponsavelId: '' }
            ]
        };

    const setCampos = {
        advogadoResponsavelId: advogadoId,
        advogadoResponsavelNome: advogadoNome,
        atendimentoAssumidoEm: agora,
        chatAbertoEm: agora
    };

    if (responsavelAtualId) {
        setCampos.advogadoResponsavelAnteriorId = responsavelAtualId;
        setCampos.advogadoResponsavelAnteriorNome = responsavelAtualNome || null;
        setCampos.atendimentoTransferidoEm = agora;
    }

    const update = { $set: setCampos };
    if (responsavelAtualId) update.$inc = { quantidadeTransferenciasAtendimento: 1 };

    const resultado = await ticketsColl.findOneAndUpdate(
        filtroAtomico,
        update,
        { returnDocument: 'after', projection }
    );

    let atualizado = resultado?.value || resultado;

    if (!atualizado?.ticketNumber) {
        atualizado = await ticketsColl.findOne({ ticketNumber: numero }, { projection });
        if (!atualizado) {
            return { ok: false, status: 404, erro: 'Ticket ativo não encontrado.' };
        }

        const vencedorId = String(atualizado.advogadoResponsavelId || '').trim();
        if (vencedorId !== advogadoId) {
            return {
                ok: false,
                status: 409,
                erro: `O atendimento foi assumido por ${atualizado.advogadoResponsavelNome || 'outro advogado'} antes da sua confirmação.`,
                responsavel: {
                    id: vencedorId || null,
                    nome: atualizado.advogadoResponsavelNome || 'Outro advogado'
                }
            };
        }
    }

    await atualizarHistorico(numero, {
        advogadoResponsavelId: advogadoId,
        advogadoResponsavelNome: advogadoNome,
        atendimentoAssumidoEm: agora,
        chatAbertoEm: agora,
        ...(responsavelAtualId ? {
            advogadoResponsavelAnteriorId: responsavelAtualId,
            advogadoResponsavelAnteriorNome: responsavelAtualNome || null,
            atendimentoTransferidoEm: agora
        } : {})
    });

    if (atualizado.clienteId && clientsColl) {
        await clientsColl.updateOne(
            { _id: atualizado.clienteId },
            { $set: { advogadoResponsavel: advogadoNome, updatedAt: agora } }
        ).catch(() => {});
    }

    // Toda assunção explícita (inclusive transferência) informa o cliente quem passou
    // a conduzir o atendimento. Reabrir o próprio atendimento não envia aviso duplicado.
    await enviarAvisoAssuncaoAoCliente(atualizado, advogado);

    if (emitirEvento) {
        const classificacao = classificarPendenciaTicket(atualizado);
        io.emit('ticket_claimed', {
            ticketNumber: numero,
            status: atualizado.status || null,
            paused: atualizado.paused === true,
            pendenciaTipo: classificacao.tipo,
            pendenciaLabel: classificacao.label,
            statusLabel: classificacao.statusLabel,
            advogadoResponsavelId: advogadoId,
            advogadoResponsavelNome: advogadoNome,
            atendimentoAssumidoEm: agora,
            transferred: !!responsavelAtualId,
            advogadoResponsavelAnteriorId: responsavelAtualId || null,
            advogadoResponsavelAnteriorNome: responsavelAtualNome || null
        });
    }

    return {
        ok: true,
        alreadyOwned: false,
        transferred: !!responsavelAtualId,
        ticket: atualizado,
        responsavel: { id: advogadoId, nome: advogadoNome },
        responsavelAnterior: responsavelAtualId ? { id: responsavelAtualId, nome: responsavelAtualNome || 'Outro advogado' } : null
    };
}

async function garantirTicketDoAdvogado(ticketNumber, advogado) {
    const ticket = await ticketsColl.findOne(
        { ticketNumber: String(ticketNumber || '').trim() },
        {
            projection: {
                _id: 1,
                ticketNumber: 1,
                clienteId: 1,
                numeroReal: 1,
                whatsappNumbers: 1,
                identificadores: 1,
                lastRawJid: 1,
                advogadoResponsavelId: 1,
                advogadoResponsavelNome: 1,
                atendimentoAssumidoEm: 1
            }
        }
    );

    if (!ticket) {
        return { ok: false, status: 404, erro: 'Ticket ativo não encontrado.' };
    }

    const responsavelId = String(ticket.advogadoResponsavelId || '').trim();
    const advogadoId = String(advogado?.id || '').trim();

    if (!responsavelId) {
        return {
            ok: false,
            status: 409,
            codigo: 'ATENDIMENTO_NAO_INICIADO',
            erro: 'Inicie o atendimento antes de enviar mensagens ou arquivos.'
        };
    }

    if (responsavelId !== advogadoId) {
        return {
            ok: false,
            status: 409,
            codigo: 'ATENDIMENTO_DE_OUTRO_ADVOGADO',
            erro: `Este atendimento está com ${ticket.advogadoResponsavelNome || 'outro advogado'}. Use “Assumir atendimento” antes de enviar.`,
            ticket,
            responsavel: {
                id: responsavelId,
                nome: ticket.advogadoResponsavelNome || 'Outro advogado'
            },
            ehResponsavel: false
        };
    }

    return {
        ok: true,
        ticket,
        responsavel: {
            id: responsavelId,
            nome: ticket.advogadoResponsavelNome || advogado?.nome || 'Advogado(a)'
        },
        ehResponsavel: true
    };
}

// -----------------------------------------------------------------------------
// NOTIFICAÇÕES EM TEMPO REAL DO PAINEL
// -----------------------------------------------------------------------------
// Evento leve: envia apenas metadados para o painel conectado, sem conteúdo de
// documentos ou mensagens completas.
function emitirNotificacaoPainel({
    tipo = 'ticket',
    titulo = '',
    mensagem = '',
    ticketNumber = null,
    leadId = null,
    crmNumber = null,
    whatsapp = null,
    createdAt = Date.now()
} = {}) {
    const tipoSeguro = tipo === 'lead' ? 'lead' : 'ticket';
    const ticketSeguro = ticketNumber ? String(ticketNumber).slice(0, 80) : null;
    const leadSeguro = leadId ? String(leadId).slice(0, 120) : null;
    const crmSeguro = crmNumber ? String(crmNumber).slice(0, 80) : null;
    const whatsappSeguro = whatsapp ? String(whatsapp).replace(/\D/g, '').slice(0, 20) : null;
    const id = tipoSeguro === 'lead'
        ? `lead:${leadSeguro || crmSeguro || ticketSeguro || createdAt}`
        : `ticket:${ticketSeguro || createdAt}`;

    io.emit('panel_notification', {
        id,
        tipo: tipoSeguro,
        titulo: String(titulo || (tipoSeguro === 'lead' ? 'Novo lead' : 'Novo ticket')).slice(0, 100),
        mensagem: String(mensagem || '').slice(0, 300),
        ticketNumber: ticketSeguro,
        leadId: leadSeguro,
        crmNumber: crmSeguro,
        whatsapp: whatsappSeguro,
        createdAt: Number(createdAt) || Date.now()
    });
}

async function sendBotMsg(jid, content) {
    const inicioEnvio = Date.now();
    const jidNormalizadoBot = normalizarJid(jid) || String(jid || '');
    if (jidNormalizadoBot) {
        botPendingJids.add(jidNormalizadoBot);
        // Failsafe caso o envio seja interrompido antes do finally.
        setTimeout(() => botPendingJids.delete(jidNormalizadoBot), 8000);
    }

    try {
        // O indicador de digitação só deve aparecer quando o BOT realmente vai responder.
        // Antes ele era disparado ao receber qualquer mensagem do cliente, mesmo quando
        // nenhuma resposta seria enviada, gerando um falso "digitando..." no WhatsApp.
        if (sock?.sendPresenceUpdate) {
            Promise.resolve(sock.sendPresenceUpdate('composing', jid)).catch(() => {});
        }
        const sent = await enviarMensagemBaileys(jid, content);
        const id = sent?.key?.id;
        const duracaoEnvio = Date.now() - inicioEnvio;
        if (duracaoEnvio >= 700) {
            console.warn(`[Performance][WhatsApp] sendMessage para ${normalizarJid(jid) || jid} levou ${duracaoEnvio}ms.`);
        }

        // Mantém um conjunto de IDs enviados pelo próprio bot.
        // Evita confundir mensagens simultâneas do bot com intervenção humana.
        if (id) {
            botMessageIds.add(id);
            setTimeout(() => botMessageIds.delete(id), 60 * 1000);
        }

        // Persistência leve do chat: somente texto/metadados, nunca o binário.
        registrarMensagemAutomaticaChat(jid, sent, content).catch(err => {
            console.warn('[Chat] Falha ao registrar mensagem automática:', err?.message || err);
        });

        // Remove o indicador de digitação sem bloquear a entrega da mensagem.
        if (sock?.sendPresenceUpdate) {
            Promise.resolve(sock.sendPresenceUpdate('paused', jid)).catch(() => {});
        }

        return sent;
    } catch (err) {
        console.error('Erro ao enviar:', err);
        if (sock?.sendPresenceUpdate) {
            Promise.resolve(sock.sendPresenceUpdate('paused', jid)).catch(() => {});
        }
        return null;
    } finally {
        // Mantém uma pequena margem para cobrir o upsert local que pode chegar logo
        // depois da resolução do sendMessage().
        if (jidNormalizadoBot) {
            setTimeout(() => botPendingJids.delete(jidNormalizadoBot), 1500);
        }
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

const PERGUNTA_CADASTRO_CLIENTE = `Se quiser, posso deixar seu cadastro pronto para facilitar os próximos contatos com o escritório. Deseja se cadastrar?

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

function perguntaPareceSolicitarAnexo(texto = '') {
    const normalizado = normalizarTexto(String(texto || ''))
        .replace(/[^a-z0-9\s]/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();

    if (!normalizado) return false;

    // Fallback para perguntas antigas, criadas antes da opção explícita no painel.
    // A regra só é inferida quando também existem respostas Sim/Não.
    return /\b(documento|documentos|imagem|imagens|foto|fotos|print|prints|arquivo|arquivos|anexo|anexos|comprovante|comprovantes|contrato|contratos|laudo|laudos|holerite|holerites|nota fiscal|notas fiscais)\b/.test(normalizado);
}

function respostasPossuemSimENao(respostas = []) {
    const normalizadas = new Set((Array.isArray(respostas) ? respostas : []).map(normalizarRespostaParaValidacao));
    return normalizadas.has('sim') && normalizadas.has('nao');
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

            const respostasAceitas = normalizarRespostasAceitas(objeto.respostasAceitas || [], index + 1);
            const exigirAnexoSeSim = objeto.exigirAnexoSeSim === true || (
                objeto.exigirAnexoSeSim == null &&
                perguntaPareceSolicitarAnexo(texto) &&
                respostasPossuemSimENao(respostasAceitas)
            );

            return {
                id: String(objeto.id || new ObjectId().toString()),
                texto,
                respostasAceitas,
                exigirAnexoSeSim,
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

function respostaEhSim(texto = '') {
    return ['sim', 's'].includes(normalizarRespostaParaValidacao(texto));
}

function respostaEhNao(texto = '') {
    return ['nao', 'n'].includes(normalizarRespostaParaValidacao(texto));
}

function perguntaExigeAnexoSeSim(pergunta = {}) {
    return pergunta?.exigirAnexoSeSim === true;
}

function mensagemSolicitarAnexoPergunta(pergunta = {}) {
    const perguntaTexto = String(pergunta?.texto || '').trim();
    return `Perfeito. Para continuar, envie agora a *imagem ou o documento* por aqui.\n\nSe você não possuir o arquivo, responda *Não*${perguntaTexto ? `.\n\n${perguntaTexto}` : '.'}`;
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
                aguardandoWhatsappCadastro: false,
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

    const mensagemForaHorarioHumanizada = await gerarRespostaHumanizadaIA({
        tipo: 'fora_horario',
        mensagemCliente: texto,
        ticket,
        mensagemBase: montarMensagemForaHorario(config || DEFAULT_BUSINESS_HOURS)
    });

    await sendBotMsg(jid, {
        text: mensagemForaHorarioHumanizada
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

// Normalização específica para linguagem de WhatsApp usada somente pela camada de IA/intenção.
// Não altera o texto original armazenado nem respostas estruturadas de cadastro/triagem.
const ALIASES_MENSAGEM_CLIENTE_IA = new Map([
    ['obg', 'obrigado'], ['obgd', 'obrigado'], ['obrigdo', 'obrigado'], ['brigado', 'obrigado'], ['brigada', 'obrigada'],
    ['vlw', 'valeu'], ['valew', 'valeu'], ['flw', 'falou'], ['blz', 'beleza'],
    ['msg', 'mensagem'], ['msgs', 'mensagens'], ['mensg', 'mensagem'], ['mens', 'mensagem'],
    ['adv', 'advogado'], ['advs', 'advogados'], ['advg', 'advogado'], ['advog', 'advogado'],
    ['vc', 'voce'], ['vcs', 'voces'], ['cê', 'voce'], ['ce', 'voce'],
    ['tb', 'tambem'], ['tbm', 'tambem'], ['tmb', 'tambem'],
    ['pf', 'por favor'], ['pfv', 'por favor'], ['pff', 'por favor'],
    ['q', 'que'], ['pq', 'porque'], ['pqe', 'porque'], ['pk', 'porque'],
    ['n', 'nao'], ['nn', 'nao'], ['s', 'sim'],
    ['hj', 'hoje'], ['agr', 'agora'], ['ctt', 'contato'],
    ['dr', 'doutor'], ['dra', 'doutora']
]);

function normalizarMensagemClienteIA(texto = '') {
    const base = normalizarTexto(texto)
        .replace(/([a-z])\1{2,}/g, '$1$1')
        .replace(/[^a-z0-9\s]/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();
    if (!base) return '';

    const saida = [];
    for (const token of base.split(/\s+/).filter(Boolean)) {
        const alias = ALIASES_MENSAGEM_CLIENTE_IA.get(token);
        if (alias) saida.push(...String(alias).split(/\s+/));
        else saida.push(token);
    }
    return saida.join(' ').replace(/\s+/g, ' ').trim();
}

// -----------------------------------------------------------------------------
// HUMANIZAÇÃO CONTEXTUAL DAS RESPOSTAS AUTOMÁTICAS
// -----------------------------------------------------------------------------
// A IA melhora somente a forma da mensagem. Dados operacionais (como número do
// ticket e horários) são validados antes do envio. Se o Gemini estiver indisponível
// ou ultrapassar o tempo limite, o texto-base humanizado é usado sem interromper o fluxo.
const HUMANIZACAO_IA_TIMEOUT_MS = 2200;
const HUMANIZACAO_IA_MAX_CHARS = 1200;

function saudacaoAtualEscritorio(data = new Date()) {
    const relogio = obterRelogioNoFuso(data, BUSINESS_HOURS_TIMEZONE);
    const hora = Number(relogio?.hora);

    if (Number.isFinite(hora)) {
        if (hora < 12) return 'Bom dia';
        if (hora < 18) return 'Boa tarde';
        return 'Boa noite';
    }

    // Fallback conservador: evita inventar uma saudação temporal caso o relógio
    // não possa ser resolvido corretamente.
    return 'Olá';
}

function detectarCortesiaMensagem(texto = '') {
    const valor = normalizarMensagemClienteIA(texto)
        .replace(/[!?.,;:]+/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();

    let saudacao = null;
    if (/\bbom dia\b/.test(valor)) saudacao = 'Bom dia';
    else if (/\bboa tarde\b/.test(valor)) saudacao = 'Boa tarde';
    else if (/\bboa noite\b/.test(valor)) saudacao = 'Boa noite';
    else if (/^(oi|ola|opa)\b/.test(valor)) saudacao = 'Olá';

    const agradecimento = /\b(obrigado|obrigada|muito obrigado|muito obrigada|agradeco|agradecemos|grato|grata|valeu)\b/.test(valor);

    let restante = ` ${valor} `;
    const expressoesCortesia = [
        /\b(bom dia|boa tarde|boa noite)\b/g,
        /\b(oi|ola|opa)\b/g,
        /\b(muito obrigado|muito obrigada|obrigado|obrigada)\b/g,
        /\b(agradeco|agradecemos|grato|grata|valeu)\b/g,
        /\b(pela ajuda|pelo retorno|pela atencao|pelo atendimento|pela resposta)\b/g,
        /\b(tudo bem|td bem|como vai|como voce esta|como voces estao)\b/g,
        /\b(por favor)\b/g
    ];
    for (const regex of expressoesCortesia) restante = restante.replace(regex, ' ');
    restante = restante.replace(/\s+/g, ' ').trim();

    return {
        saudacao,
        agradecimento,
        somenteCortesia: !!(saudacao || agradecimento) && restante.length === 0
    };
}

function aplicarCortesiaAoFallback(mensagemBase = '') {
    // Mensagens operacionais são continuação da conversa, e não uma nova abertura.
    // Saudações/agradecimentos isolados são tratados em responderInterrupcaoIA().
    return String(mensagemBase || '').trim();
}

function removerSaudacaoDeMensagemOperacional(texto = '') {
    const original = String(texto || '').trim();
    if (!original) return original;

    // Remove apenas uma saudação no início. Isso impede que a IA reabra a conversa
    // com "Bom dia"/"Boa tarde" em cada etapa do fluxo.
    const limpo = original.replace(
        /^\s*(?:(?:bom\s+dia|boa\s+tarde|boa\s+noite|ol[aá]|oi|opa)(?:\s*[,!:.\-–—]+)?\s*)+/i,
        ''
    ).trim();

    return limpo || original;
}

function literaisProtegidosDaMensagem(mensagemBase = '', ticket = null) {
    const texto = String(mensagemBase || '');
    const literais = new Set();

    if (ticket?.ticketNumber && texto.includes(ticket.ticketNumber)) {
        literais.add(String(ticket.ticketNumber));
    }

    // Horários explícitos não podem ser alterados pela IA.
    for (const match of texto.matchAll(/\b(?:[01]\d|2[0-3]):[0-5]\d\b/g)) {
        literais.add(match[0]);
    }

    return [...literais];
}

function limparRespostaHumanizadaIA(raw = '') {
    let texto = String(raw || '')
        .trim()
        .replace(/^```(?:text|markdown)?\s*/i, '')
        .replace(/```$/i, '')
        .trim();

    if ((texto.startsWith('"') && texto.endsWith('"')) || (texto.startsWith('“') && texto.endsWith('”'))) {
        texto = texto.slice(1, -1).trim();
    }

    return texto.slice(0, HUMANIZACAO_IA_MAX_CHARS).trim();
}

async function gerarRespostaHumanizadaIA({
    tipo = 'mensagem_operacional',
    mensagemCliente = '',
    ticket = null,
    mensagemBase = '',
    nomeCliente = ''
} = {}) {
    const base = String(mensagemBase || '').trim();
    if (!base) return '';

    const fallback = aplicarCortesiaAoFallback(base);
    if (!geminiModel) return removerSaudacaoDeMensagemOperacional(fallback);

    const literaisProtegidos = literaisProtegidosDaMensagem(base, ticket);
    const nome = String(nomeCliente || ticket?.clienteNome || '').trim().slice(0, 120);

    const prompt = `Você revisa mensagens automáticas de WhatsApp de um escritório de advocacia brasileiro.

OBJETIVO:
Reescreva a MENSAGEM-BASE para soar humana, cordial, profissional, segura e natural, como se tivesse sido escrita por uma recepcionista jurídica experiente.

TIPO DA MENSAGEM: ${JSON.stringify(tipo)}
MENSAGEM ATUAL DO CLIENTE: ${JSON.stringify(String(mensagemCliente || '').slice(0, 1800))}
NOME DO CLIENTE, SE CONHECIDO: ${JSON.stringify(nome || null)}
NÚMERO DO TICKET: ${JSON.stringify(ticket?.ticketNumber || null)}
MENSAGEM-BASE: ${JSON.stringify(base)}

CONTEXTO DE CONVERSA:
Esta é uma mensagem de MEIO DE FLUXO. O atendimento já foi iniciado e o cliente não deve ser cumprimentado novamente nesta etapa.
A saudação inicial é controlada separadamente pelo sistema.

REGRAS OBRIGATÓRIAS:
1. Preserve integralmente o sentido operacional da MENSAGEM-BASE. Não remova informação importante.
2. Preserve EXATAMENTE números de ticket, horários, nomes e demais dados concretos presentes na MENSAGEM-BASE.
3. É PROIBIDO começar esta resposta com "Bom dia", "Boa tarde", "Boa noite", "Olá", "Oi" ou "Opa". Não acrescente nenhuma saudação nesta rotina.
4. Trate a mensagem como continuação natural da conversa. Não reabra o atendimento e não repita informações que a MENSAGEM-BASE não exige.
5. Não responda automaticamente "nós que agradecemos" só porque o cliente usou uma expressão de cortesia junto com uma informação. Agradecimentos isolados são tratados em outra rotina.
6. Evite frases burocráticas e repetitivas como "recebemos suas informações", "seu atendimento foi encaminhado", "um especialista dará continuidade" e "nossa equipe seguirá com o atendimento", salvo quando forem indispensáveis ao sentido da MENSAGEM-BASE.
7. Prefira português conversacional, profissional e direto, como uma recepcionista jurídica experiente escrevendo no WhatsApp. Use aberturas como "Certo", "Tudo certo" ou "Sem problema" somente quando fizer sentido e sem transformar toda resposta em uma confirmação formal.
8. Não invente prazo, data, valor, análise jurídica, resultado, prioridade, urgência, disponibilidade de advogado ou promessa de retorno.
9. Não diga "em breve", "logo", "aguarde um momento" ou equivalentes, salvo se essas expressões já estiverem na MENSAGEM-BASE.
10. Não dê orientação jurídica e não acrescente fatos sobre o caso.
11. Use de 1 a 3 frases curtas. Evite emoji em mensagens operacionais, salvo se ele já fizer parte da MENSAGEM-BASE.
12. O WhatsApp aceita *negrito*; preserve os trechos destacados da MENSAGEM-BASE.
13. Retorne SOMENTE a mensagem final, sem aspas, JSON, explicações ou markdown em bloco.`;

    try {
        const timeout = new Promise((_, reject) => {
            setTimeout(() => reject(new Error('Timeout da humanização por IA.')), HUMANIZACAO_IA_TIMEOUT_MS);
        });

        const result = await Promise.race([
            geminiModel.generateContent(prompt),
            timeout
        ]);
        const response = await result.response;
        const humanizada = limparRespostaHumanizadaIA(response.text());

        if (!humanizada) return removerSaudacaoDeMensagemOperacional(fallback);

        // Em mensagens operacionais, qualquer saudação gerada pela IA é considerada
        // uma reabertura indevida da conversa. Usamos o texto-base seguro em vez de
        // deixar a mensagem soar repetitiva ou robótica.
        if (/\b(?:bom\s+dia|boa\s+tarde|boa\s+noite|ol[aá]|oi|opa)\b/i.test(humanizada)) {
            console.warn('[Humanização IA] Resposta descartada por inserir saudação no meio do fluxo.');
            return removerSaudacaoDeMensagemOperacional(fallback);
        }

        if (literaisProtegidos.some(literal => !humanizada.includes(literal))) {
            console.warn('[Humanização IA] Resposta descartada por alterar/remover dado protegido.');
            return removerSaudacaoDeMensagemOperacional(fallback);
        }

        // Última proteção contra promessas que não existiam no texto-base.
        const baseNormalizada = normalizarTexto(base);
        const respostaNormalizada = normalizarTexto(humanizada);
        const adicionouPromessaTemporal = /\b(em breve|logo|aguarde um momento|ainda hoje|nas proximas horas)\b/.test(respostaNormalizada) &&
            !/\b(em breve|logo|aguarde um momento|ainda hoje|nas proximas horas)\b/.test(baseNormalizada);
        if (adicionouPromessaTemporal) {
            console.warn('[Humanização IA] Resposta descartada por adicionar promessa temporal.');
            return removerSaudacaoDeMensagemOperacional(fallback);
        }

        // Camada determinística adicional: mesmo que o modelo ignore o prompt,
        // uma saudação não reaparece no meio do fluxo.
        return removerSaudacaoDeMensagemOperacional(humanizada);
    } catch (err) {
        console.warn('[Humanização IA] Usando fallback seguro:', err?.message || err);
        return removerSaudacaoDeMensagemOperacional(fallback);
    }
}

function saudacaoContextualDaMensagem(texto = '') {
    const detectada = detectarCortesiaMensagem(texto).saudacao;
    if (!detectada) return saudacaoAtualEscritorio();
    if (/^(bom dia|boa tarde|boa noite)$/i.test(detectada)) return saudacaoAtualEscritorio();
    return detectada;
}

function respostaPositiva(texto = '') {
    const valor = normalizarTexto(texto);
    return ['1', 'sim', 's', 'quero', 'desejo', 'pode', 'pode cadastrar'].includes(valor);
}

function respostaNegativa(texto = '') {
    const valor = normalizarTexto(texto);
    return ['2', 'nao', 'n', 'nao obrigado', 'nao obrigada', 'nao quero', 'prefiro nao', 'agora nao'].includes(valor);
}

const POS_ENCERRAMENTO_JANELA_MS = 30 * 60 * 1000;
const POS_ENCERRAMENTO_SILENCIO_REPETICAO_MS = 2 * 60 * 1000;

function distanciaEdicaoLimitada(a = '', b = '', limite = 2) {
    a = String(a || '');
    b = String(b || '');
    if (a === b) return 0;
    if (!a || !b) return Math.max(a.length, b.length);
    if (Math.abs(a.length - b.length) > limite) return limite + 1;

    let anterior = Array.from({ length: b.length + 1 }, (_, i) => i);
    for (let i = 1; i <= a.length; i++) {
        const atual = [i];
        let menorLinha = atual[0];
        for (let j = 1; j <= b.length; j++) {
            const custo = a[i - 1] === b[j - 1] ? 0 : 1;
            const valor = Math.min(
                anterior[j] + 1,
                atual[j - 1] + 1,
                anterior[j - 1] + custo
            );
            atual[j] = valor;
            if (valor < menorLinha) menorLinha = valor;
        }
        if (menorLinha > limite) return limite + 1;
        anterior = atual;
    }
    return anterior[b.length];
}

const TERMOS_OPERACIONAIS_CLIENTE = [
    'encerrar', 'finalizar', 'fechar',
    'obrigado', 'obrigada', 'valeu', 'agradeco',
    'perfeito', 'beleza', 'certo', 'combinado', 'entendi', 'tranquilo',
    'tchau', 'gratidao'
];

const ALIASES_OPERACIONAIS_CLIENTE = new Map([
    ['encera', 'encerrar'], ['encerar', 'encerrar'], ['encerra', 'encerrar'], ['encerr', 'encerrar'],
    ['finalizr', 'finalizar'], ['finaliza', 'finalizar'], ['finaliz', 'finalizar'],
    ['fecha', 'fechar'], ['feche', 'fechar'],
    ['obg', 'obrigado'], ['obgd', 'obrigado'], ['obgd', 'obrigado'], ['obrigdo', 'obrigado'],
    ['obrigadoo', 'obrigado'], ['brigado', 'obrigado'], ['brigada', 'obrigada'], ['brigadao', 'obrigado'],
    ['vlw', 'valeu'], ['vlww', 'valeu'], ['valew', 'valeu'],
    ['agradecoo', 'agradeco'], ['agradecido', 'agradeco'], ['agradecida', 'agradeco'],
    ['blz', 'beleza'], ['blza', 'beleza'], ['okay', 'ok'], ['oki', 'ok'], ['okk', 'ok'], ['okey', 'ok'],
    ['flw', 'tchau'], ['falow', 'tchau'], ['falou', 'tchau'], ['xau', 'tchau'],
    ['tmj', 'tmj'], ['showw', 'show']
]);

function canonicalizarTokenOperacional(token = '') {
    let valor = String(token || '').toLowerCase().replace(/[^a-z0-9]/g, '');
    if (!valor) return '';
    // Reduz exageros comuns de digitação: "obrigadooo", "vlwww" etc.
    valor = valor.replace(/([a-z])\1{2,}/g, '$1$1');
    if (ALIASES_OPERACIONAIS_CLIENTE.has(valor)) return ALIASES_OPERACIONAIS_CLIENTE.get(valor);
    if (TERMOS_OPERACIONAIS_CLIENTE.includes(valor)) return valor;

    // Fuzzy apenas para palavras suficientemente longas. Mantém o algoritmo conservador.
    if (valor.length >= 5) {
        let melhor = null;
        let melhorDist = 99;
        for (const termo of TERMOS_OPERACIONAIS_CLIENTE) {
            const limite = Math.max(valor.length, termo.length) >= 8 ? 2 : 1;
            const dist = distanciaEdicaoLimitada(valor, termo, limite);
            if (dist < melhorDist && dist <= limite) {
                melhor = termo;
                melhorDist = dist;
            }
        }
        if (melhor) return melhor;
    }
    return valor;
}

function normalizarIntencaoOperacional(texto = '') {
    return normalizarTexto(texto)
        .replace(/[^a-z0-9\s]/g, ' ')
        .split(/\s+/)
        .filter(Boolean)
        .map(canonicalizarTokenOperacional)
        .join(' ')
        .replace(/\s+/g, ' ')
        .trim();
}

function analisarCortesiaPosEncerramento(texto = '') {
    const original = String(texto || '').trim();
    const valor = normalizarIntencaoOperacional(original);
    if (!valor) return { cortesia: false, motivo: 'vazio' };

    // Uma pergunta ou uma frase que expressa nova necessidade deve abrir novo atendimento.
    if (original.includes('?')) return { cortesia: false, motivo: 'pergunta' };

    const tokens = valor.split(/\s+/).filter(Boolean);
    const nucleosGratidao = new Set(['obrigado', 'obrigada', 'valeu', 'agradeco', 'gratidao']);
    const nucleosConfirmacao = new Set(['ok', 'certo', 'perfeito', 'beleza', 'combinado', 'entendi', 'tranquilo', 'show', 'joia', 'tmj']);
    const nucleosDespedida = new Set(['tchau']);
    const fillers = new Set([
        'muito', 'muita', 'mesmo', 'pela', 'pelo', 'por', 'a', 'o', 'as', 'os', 'de', 'da', 'do',
        'ajuda', 'atendimento', 'atencao', 'retorno', 'suporte', 'gentileza', 'tudo', 'bom', 'boa',
        'ta', 'esta', 'isso', 'ai', 'viu', 'demais', 'legal', 'beleza', 'show', 'bola', 'e', 'so',
        'ate', 'mais', 'logo', 'dia', 'tarde', 'noite', 'trabalho', 'abraco', 'abracos', 'um', 'uma', 'pra', 'voce', 'voces', 'tambem', 'tmj'
    ]);

    let tipo = null;
    if (tokens.some(t => nucleosGratidao.has(t))) tipo = 'gratidao';
    else if (tokens.some(t => nucleosDespedida.has(t))) tipo = 'despedida';
    else if (tokens.some(t => nucleosConfirmacao.has(t))) tipo = 'confirmacao';
    else if (/^(ate mais|boa noite|boa tarde|bom dia|bom trabalho|ate logo|um abraco|abraco)$/.test(valor)) tipo = 'despedida';

    if (!tipo) return { cortesia: false, motivo: 'sem_nucleo' };

    const nucleos = new Set([...nucleosGratidao, ...nucleosConfirmacao, ...nucleosDespedida]);
    const desconhecidos = tokens.filter(t => !nucleos.has(t) && !fillers.has(t));

    // Se sobrou conteúdo relevante, tratamos como novo assunto. Ex.:
    // "obrigado, preciso de ajuda com outro processo" -> abre novo ticket.
    if (desconhecidos.length) return { cortesia: false, motivo: 'conteudo_novo', desconhecidos };

    return { cortesia: true, tipo, valorNormalizado: valor };
}

function filtrosHistoricoPorContato(contato = {}) {
    const filtros = [];
    const ids = Array.isArray(contato.identificadores) ? contato.identificadores.filter(Boolean) : [];
    const numeros = Array.isArray(contato.whatsappNumbers) ? contato.whatsappNumbers.filter(Boolean) : [];
    if (ids.length) {
        filtros.push({ identificadores: { $in: ids } });
        filtros.push({ lastRawJid: { $in: ids } });
    }
    if (numeros.length) {
        filtros.push({ whatsappNumbers: { $in: numeros } });
        filtros.push({ numeroReal: { $in: numeros } });
    }
    if (contato.numeroPrincipal) filtros.push({ numeroReal: contato.numeroPrincipal });
    return filtros;
}

async function buscarEncerramentoRecenteDoContato(contato, janelaMs = POS_ENCERRAMENTO_JANELA_MS) {
    if (!ticketHistoryColl) return null;
    const filtros = filtrosHistoricoPorContato(contato);
    if (!filtros.length) return null;
    const desde = Date.now() - Math.max(60_000, Number(janelaMs || POS_ENCERRAMENTO_JANELA_MS));
    return ticketHistoryColl.find({
        $and: [
            { $or: filtros },
            { closedAt: { $gte: desde } }
        ]
    }).sort({ closedAt: -1 }).limit(1).next();
}

function respostaCortesiaPosEncerramento(historico = {}, analise = {}) {
    const nome = primeiroNome(historico?.clienteNome || '');
    const vocativo = nome ? `, ${nome}` : '';
    if (analise?.tipo === 'gratidao') return `Por nada${vocativo}! Ficamos à disposição quando precisar. 😊`;
    if (analise?.tipo === 'despedida') return `Até mais${vocativo}! Ficamos à disposição. 👋`;
    return `Perfeito${vocativo}. Ficamos à disposição quando precisar. 😊`;
}

function clienteQuerEncerrar(texto = '') {
    const valor = normalizarIntencaoOperacional(texto).replace(/\s+/g, ' ').trim();
    if (!valor) return false;

    // Evita falsos positivos quando o cliente explicitamente diz para NÃO encerrar.
    const negacoesEncerramento = [
        /\bnao\s+(?:pode|podem|quero|queremos|desejo|desejamos|vou|vamos)\s+(?:encerrar|finalizar|fechar)\b/,
        /\b(?:nao|nunca)\s+(?:encerre|encerrem|finalize|finalizem|feche|fechem)\b/,
        /\bainda\s+nao\s+(?:encerre|encerrem|finalize|finalizem|feche|fechem|encerrar|finalizar|fechar)\b/
    ];
    if (negacoesEncerramento.some(regex => regex.test(valor))) return false;

    // Perguntas informativas sobre como/quando encerrar não são comandos de fechamento.
    if (/^(?:como|quando|onde|por que|porque|qual|quais)\b.*\b(?:encerrar|finalizar|fechar)\b/.test(valor)) return false;

    if (['encerrar', 'finalizar', 'fechar', 'encerrar atendimento', 'finalizar atendimento', 'fechar atendimento', 'encerrar ticket', 'finalizar ticket', 'fechar ticket'].includes(valor)) {
        return true;
    }

    const padroesDiretos = [
        /\b(?:pode|podem|poderia|poderiam|podemos)\s+(?:por favor\s+)?(?:encerrar|finalizar|fechar)\b/,
        /\b(?:quero|queremos|desejo|desejamos|prefiro|gostaria de)\s+(?:encerrar|finalizar|fechar)\b/,
        /\b(?:vamos)\s+(?:encerrar|finalizar|fechar)\b/,
        /\b(?:encerrar|finalizar|fechar)\s+(?:o\s+|a\s+|esse\s+|essa\s+|este\s+|esta\s+|meu\s+|minha\s+)?(?:atendimento|ticket|chamado|conversa)\b/,
        /\b(?:atendimento|ticket|chamado|conversa)\s+(?:ja\s+)?(?:pode\s+)?(?:ser\s+)?(?:encerrado|finalizado|fechado)\b/,
        /\b(?:nao quero|nao vou|nao desejo)\s+(?:mais\s+)?continuar\b/,
        /\b(?:nao preciso mais|nao tenho mais duvidas|sem mais duvidas)\b/,
        /\b(?:era so isso|e so isso|duvida resolvida|problema resolvido|assunto resolvido)\b/,
        /\b(?:parar por aqui|podemos parar|deixa pra la|deixar pra depois)\b/,
        /\b(?:obrigado|obrigada|valeu)\s*[,!. ]*\s*(?:era so isso|e so isso|pode encerrar|pode finalizar|pode fechar)\b/,
        /\b(?:tchau|ate mais)\b/
    ];

    return padroesDiretos.some(regex => regex.test(valor));
}

function invalidarCacheKnowledge() {
    knowledgeCache = { items: [], loadedAt: 0 };
}
function invalidarCacheKnowledgeWeb() {
    knowledgeWebCache = { pages: [], loadedAt: 0 };
}

const STOPWORDS_IA = new Set([
    'a', 'o', 'as', 'os', 'um', 'uma', 'uns', 'umas', 'de', 'da', 'do', 'das', 'dos',
    'e', 'ou', 'em', 'no', 'na', 'nos', 'nas', 'para', 'por', 'com', 'sem', 'que', 'se',
    'eu', 'me', 'meu', 'minha', 'voce', 'voces', 'isso', 'isto', 'essa', 'esse', 'como',
    'qual', 'quais', 'quando', 'onde', 'porque', 'pra', 'pro', 'tem', 'ter', 'ser', 'esta',
    'aqui', 'ai', 'la', 'dr', 'dra', 'doutor', 'doutora', 'sr', 'sra', 'saber', 'gostaria',
    'queria', 'quero', 'pode', 'podem'
]);

function tokensRelevantes(texto = '') {
    return [...new Set(
        normalizarMensagemClienteIA(texto)
            .replace(/[^a-z0-9\s]/g, ' ')
            .split(/\s+/)
            .filter(token => token.length >= 3 && !STOPWORDS_IA.has(token))
    )];
}

function tokensCorpusKnowledge(item = {}) {
    const partes = [
        item?.pergunta || '',
        item?.resposta || '',
        ...(Array.isArray(item?.palavrasChave) ? item.palavrasChave : []),
        ...(Array.isArray(item?.variacoesPergunta) ? item.variacoesPergunta : [])
    ];
    return normalizarTexto(partes.join(' '))
        .replace(/[^a-z0-9\s]/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();
}

function ngramsKnowledge(tokens = [], tamanho = 2) {
    const saida = [];
    for (let i = 0; i <= tokens.length - tamanho; i++) {
        const trecho = tokens.slice(i, i + tamanho);
        if (trecho.length === tamanho) saida.push(trecho.join(' '));
    }
    return saida;
}

function distanciaLevenshteinKnowledge(a = '', b = '', limite = 2) {
    a = String(a); b = String(b);
    if (a === b) return 0;
    if (!a || !b) return Math.max(a.length, b.length);
    if (Math.abs(a.length - b.length) > limite) return limite + 1;
    const prev = Array.from({ length: b.length + 1 }, (_, i) => i);
    for (let i = 1; i <= a.length; i++) {
        const cur = [i];
        let menor = cur[0];
        for (let j = 1; j <= b.length; j++) {
            cur[j] = Math.min(
                cur[j - 1] + 1,
                prev[j] + 1,
                prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1)
            );
            menor = Math.min(menor, cur[j]);
        }
        if (menor > limite) return limite + 1;
        for (let j = 0; j <= b.length; j++) prev[j] = cur[j];
    }
    return prev[b.length];
}

function bonusCorrespondenciaLocalKnowledge(texto = '', item = {}) {
    const queryTokens = tokensRelevantes(texto).filter(t => t.length >= 3);
    if (!queryTokens.length) return { bonus: 0, forte: false, motivos: [] };

    const corpus = tokensCorpusKnowledge(item);
    if (!corpus) return { bonus: 0, forte: false, motivos: [] };
    const corpusTokens = [...new Set(corpus.split(/\s+/).filter(Boolean))];
    const corpusSet = new Set(corpusTokens);
    let bonus = 0;
    let forte = false;
    const motivos = [];

    // Nomes próprios e expressões de duas/três palavras são um sinal muito mais
    // confiável do que uma palavra-chave isolada. Ex.: "Pedro Azevedo" presente
    // no conteúdo aprovado da Base deve localizar "Equipe" mesmo sem Gemini.
    const tri = ngramsKnowledge(queryTokens, 3);
    const bi = ngramsKnowledge(queryTokens, 2);
    const triExato = tri.find(frase => corpus.includes(frase));
    const biExato = bi.find(frase => corpus.includes(frase));
    if (triExato) {
        bonus += 105;
        forte = true;
        motivos.push(`frase:${triExato}`);
    } else if (biExato) {
        bonus += 78;
        forte = true;
        motivos.push(`frase:${biExato}`);
    }

    let exatos = 0;
    let aproximados = 0;
    for (const token of queryTokens) {
        if (corpusSet.has(token)) {
            exatos += 1;
            continue;
        }
        if (token.length >= 5) {
            const candidato = corpusTokens.find(ct => ct.length >= 5 && distanciaLevenshteinKnowledge(token, ct, 1) <= 1);
            if (candidato) aproximados += 1;
        }
    }

    const cobertura = exatos / Math.max(1, queryTokens.length);
    if (exatos >= 2) bonus += exatos * 9;
    if (aproximados) bonus += aproximados * 4;
    if (cobertura >= 0.60 && exatos >= 2) {
        bonus += 24;
        forte = true;
        motivos.push(`cobertura:${Math.round(cobertura * 100)}%`);
    }

    // Intenção institucional de equipe: continua sendo apenas mecanismo de busca.
    // O conteúdo factual da resposta vem exclusivamente do item aprovado localizado.
    const q = normalizarMensagemClienteIA(texto);
    const titulo = normalizarTexto(item?.pergunta || '');
    const perguntaEquipe = /\b(?:trabalha|atua|faz parte|equipe|advogad[oa]|profissional)\b/.test(q);
    const itemEquipe = /\b(?:equipe|advogad[oa]|profissional|socios|sócios)\b/.test(`${titulo} ${corpus.slice(0, 1200)}`);
    if (perguntaEquipe && itemEquipe && exatos >= 1) bonus += 18;

    return { bonus, forte, motivos };
}

function pontuarItemKnowledge(texto, item) {
    const mensagem = normalizarMensagemClienteIA(texto);
    const pergunta = normalizarTexto(item?.pergunta || '');
    const resposta = normalizarTexto(item?.resposta || '');
    const palavrasChave = (Array.isArray(item?.palavrasChave) ? item.palavrasChave : [])
        .map(normalizarTexto)
        .filter(Boolean);
    const variacoes = (Array.isArray(item?.variacoesPergunta) ? item.variacoesPergunta : [])
        .map(normalizarTexto)
        .filter(Boolean);
    const prioridade = Math.max(1, Math.min(5, Number(item?.prioridade || 3)));

    if (!mensagem || !pergunta || item?.ativo === false) return 0;
    if (mensagem === pergunta || variacoes.includes(mensagem)) return 140 + prioridade;
    if (mensagem.includes(pergunta) || pergunta.includes(mensagem)) return 65 + prioridade;

    let score = 0;
    for (const variacao of variacoes) {
        if (mensagem.includes(variacao) || variacao.includes(mensagem)) score += 38;
    }
    for (const chave of palavrasChave) {
        if (mensagem === chave) score += 32;
        else if (mensagem.includes(chave)) score += 17;
    }

    const tokensMensagem = new Set(tokensRelevantes(mensagem));
    if (!tokensMensagem.size) return score;
    const tokensPergunta = new Set(tokensRelevantes(pergunta));
    const tokensResposta = new Set(tokensRelevantes(resposta));
    const tokensChave = new Set(palavrasChave.flatMap(tokensRelevantes));
    const tokensVariacoes = new Set(variacoes.flatMap(tokensRelevantes));

    for (const token of tokensMensagem) {
        if (tokensVariacoes.has(token)) score += 9;
        else if (tokensChave.has(token)) score += 8;
        else if (tokensPergunta.has(token)) score += 5;
        else if (tokensResposta.has(token)) score += 1.25;
    }

    const local = bonusCorrespondenciaLocalKnowledge(texto, item);
    score += local.bonus;

    // A prioridade apenas desempata itens semanticamente aderentes.
    if (score > 0) score += prioridade * 0.35;
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
            { pergunta: { $type: 'string' }, resposta: { $type: 'string' }, ativo: { $ne: false } },
            { projection: { pergunta: 1, resposta: 1, palavrasChave: 1, variacoesPergunta: 1, prioridade: 1, ativo: 1, updatedAt: 1 } }
        )
        .sort({ prioridade: -1, updatedAt: -1 })
        .toArray();

    knowledgeCache = { items, loadedAt: agora };
    return items;
}

function limitarTextoIndiceKnowledge(valor = '', max = 420) {
    const texto = String(valor || '').replace(/\s+/g, ' ').trim();
    return texto.length <= max ? texto : `${texto.slice(0, max - 1)}…`;
}

function modelosKnowledgeBaseIA() {
    const itens = [];
    const usados = new Set();
    const adicionarNome = (nome) => {
        nome = String(nome || '').trim();
        if (!nome || usados.has(nome) || !genAI) return;
        usados.add(nome);
        try {
            itens.push({ nome, model: genAI.getGenerativeModel({ model: nome }, { apiVersion: 'v1beta' }) });
        } catch (_) {}
    };

    adicionarNome(KNOWLEDGE_AI_PREFERRED_MODEL);
    KNOWLEDGE_AI_FALLBACK_MODELS.forEach(adicionarNome);
    // Mantém o modelo global por último caso ele tenha sido configurado de forma customizada.
    if (geminiModel) itens.push({ nome: 'modelo-principal', model: geminiModel });
    return itens;
}

async function gerarConteudoKnowledgeBaseComRetry(prompt) {
    const modelos = modelosKnowledgeBaseIA();
    if (!modelos.length) throw new Error('IA da Base indisponível.');

    let ultimoErro = null;
    let tentativa = 0;
    for (let mi = 0; mi < modelos.length && tentativa < KNOWLEDGE_AI_MAX_ATTEMPTS; mi++) {
        const atual = modelos[mi];
        const tentativasModelo = mi === 0 ? 2 : 1;
        for (let local = 0; local < tentativasModelo && tentativa < KNOWLEDGE_AI_MAX_ATTEMPTS; local++) {
            tentativa += 1;
            try {
                const timeout = new Promise((_, reject) => setTimeout(
                    () => reject(new Error('Timeout na consulta da Base de Conhecimento.')),
                    KNOWLEDGE_AI_TIMEOUT_MS
                ));
                const resultado = await Promise.race([atual.model.generateContent(prompt), timeout]);
                return { resultado, modelo: atual.nome, tentativas: tentativa };
            } catch (err) {
                ultimoErro = err;
                const temporario = erroTemporarioKnowledgeWebIA(err);
                const inexistente = Number(err?.status || err?.statusCode || 0) === 404 || /not found|not supported/.test(String(err?.message || '').toLowerCase());
                if (!temporario && !inexistente) throw err;
                if (tentativa >= KNOWLEDGE_AI_MAX_ATTEMPTS) break;
                const atraso = KNOWLEDGE_AI_RETRY_BASE_MS * (2 ** Math.min(tentativa - 1, 2)) + Math.floor(Math.random() * 220);
                console.warn(`[IA Base] Modelo ${atual.nome} indisponível (${tentativa}/${KNOWLEDGE_AI_MAX_ATTEMPTS}). Fallback em ${atraso}ms.`);
                await new Promise(resolve => setTimeout(resolve, atraso));
            }
        }
    }
    throw ultimoErro || new Error('Não foi possível consultar a IA da Base.');
}

async function selecionarKnowledgeSemantico(texto, items = []) {
    if (!geminiModel || !Array.isArray(items) || !items.length) return [];

    // O índice semântico percorre TODA a base ativa. Palavras-chave ajudam, mas não são
    // pré-requisito: título, variações e o conteúdo aprovado também são considerados.
    const indice = items.map((item, idx) => {
        const variacoes = Array.isArray(item.variacoesPergunta) ? item.variacoesPergunta.slice(0, 10) : [];
        const chaves = Array.isArray(item.palavrasChave) ? item.palavrasChave.slice(0, 12) : [];
        return `[${idx + 1}] TÍTULO: ${limitarTextoIndiceKnowledge(item.pergunta, 260)}\n` +
            `VARIAÇÕES: ${variacoes.length ? variacoes.map(v => limitarTextoIndiceKnowledge(v, 120)).join(' | ') : '(nenhuma)'}\n` +
            `TERMOS: ${chaves.length ? chaves.join(', ') : '(nenhum)'}\n` +
            `CONTEÚDO APROVADO (trecho): ${limitarTextoIndiceKnowledge(item.resposta, 1000)}`;
    }).join('\n\n');

    const prompt = `Você é um mecanismo de busca semântica interno de um escritório de advocacia.

PERGUNTA DO CLIENTE (ORIGINAL):
${JSON.stringify(String(texto || '').slice(0, 1800))}
VERSÃO NORMALIZADA DE ABREVIAÇÕES/ERROS COMUNS:
${JSON.stringify(normalizarMensagemClienteIA(texto).slice(0, 1800))}

ÍNDICE COMPLETO DA BASE DE CONHECIMENTO ATIVA:
${indice}

Sua única tarefa é localizar conhecimentos cujo conteúdo aprovado possa responder, total ou parcialmente, ao sentido da pergunta, mesmo que o cliente use sinônimos, abreviações, erros de digitação ou palavras diferentes do cadastro.

Retorne SOMENTE JSON válido:
{"indices":[1,2],"confianca":0}

REGRAS:
1. Analise o SIGNIFICADO da pergunta; não exija repetição de palavras-chave.
2. Os números em indices correspondem aos itens do índice acima. Retorne no máximo 4.
3. Use somente itens realmente relacionados. Não escolha item apenas porque é prioritário ou recente.
4. Se nada da base ajudar com segurança, retorne {"indices":[],"confianca":0}.
5. Não responda ao cliente e não use conhecimento externo.`;

    try {
        const { resultado, modelo } = await gerarConteudoKnowledgeBaseComRetry(prompt);
        const parsed = extrairJsonIA((await resultado.response).text());
        const indices = Array.isArray(parsed?.indices) ? parsed.indices : [];
        const vistos = new Set();
        return indices
            .map(n => Number(n))
            .filter(n => Number.isInteger(n) && n >= 1 && n <= items.length && !vistos.has(n) && vistos.add(n))
            .slice(0, 4)
            .map(n => ({ ...items[n - 1], score: 25, semanticMatch: true }));
    } catch (err) {
        console.warn('[IA] Falha na busca semântica da base:', err?.message || err);
        return [];
    }
}

async function obterCandidatosKnowledge(texto) {
    const items = await carregarKnowledgeBase();
    if (!items.length) return [];

    const ranqueados = items
        .map(item => {
            const local = bonusCorrespondenciaLocalKnowledge(texto, item);
            return { ...item, score: pontuarItemKnowledge(texto, item), localMatchForte: local.forte, localMatchMotivos: local.motivos };
        })
        .sort((a, b) => b.score - a.score);

    const fortes = ranqueados.filter(item => item.score >= 55).slice(0, KNOWLEDGE_MAX_CANDIDATES);
    if (fortes.length) return fortes;

    // Sem correspondência lexical forte, fazemos busca semântica sobre a base inteira.
    // Isso elimina a dependência excessiva de palavras-chave específicas.
    const semanticos = await selecionarKnowledgeSemantico(texto, items);
    if (semanticos.length) return semanticos;

    // Se o Gemini estiver temporariamente indisponível, ainda preservamos um fallback lexical.
    return ranqueados.filter(item => item.score >= 4).slice(0, KNOWLEDGE_MAX_CANDIDATES);
}

// -----------------------------------------------------------------------------
// FONTES WEB DA BASE DE CONHECIMENTO
// -----------------------------------------------------------------------------
// O site nunca responde diretamente ao cliente. O painel sincroniza páginas públicas
// autorizadas, salva o texto no MongoDB e usa esse material somente para GERAR SUGESTÕES
// de novos conhecimentos. Apenas após aprovação humana e inclusão em knowledge_base o
// conteúdo pode participar do atendimento automático.
function ipPrivadoKnowledgeWeb(ip = '') {
    const valor = String(ip || '').toLowerCase();
    const versao = net.isIP(valor);
    if (versao === 4) {
        const partes = valor.split('.').map(Number);
        const [a, b] = partes;
        if (a === 10 || a === 127 || a === 0) return true;
        if (a === 169 && b === 254) return true;
        if (a === 172 && b >= 16 && b <= 31) return true;
        if (a === 192 && b === 168) return true;
        if (a === 100 && b >= 64 && b <= 127) return true;
        if (a === 198 && (b === 18 || b === 19)) return true;
        if (a >= 224) return true;
        return false;
    }
    if (versao === 6) {
        if (valor === '::1' || valor === '::') return true;
        if (valor.startsWith('fc') || valor.startsWith('fd') || valor.startsWith('fe8') || valor.startsWith('fe9') || valor.startsWith('fea') || valor.startsWith('feb')) return true;
        if (valor.startsWith('::ffff:')) return ipPrivadoKnowledgeWeb(valor.slice(7));
        return false;
    }
    return false;
}

async function validarUrlPublicaKnowledgeWeb(valor = '') {
    let url;
    try { url = new URL(String(valor || '').trim()); }
    catch (_) { throw new Error('Informe uma URL válida, começando com http:// ou https://.'); }
    if (!['http:', 'https:'].includes(url.protocol)) throw new Error('A fonte deve usar HTTP ou HTTPS.');
    if (url.username || url.password) throw new Error('URLs com usuário ou senha não são permitidas.');
    url.hash = '';
    const host = String(url.hostname || '').toLowerCase();
    if (!host || host === 'localhost' || host.endsWith('.local')) throw new Error('Endereço local não pode ser usado como fonte da IA.');

    if (net.isIP(host)) {
        if (ipPrivadoKnowledgeWeb(host)) throw new Error('Endereços de rede privada não podem ser usados como fonte.');
    } else {
        let enderecos = [];
        try { enderecos = await dns.lookup(host, { all: true, verbatim: true }); }
        catch (_) { throw new Error('Não foi possível localizar o domínio informado.'); }
        if (!enderecos.length || enderecos.some(item => ipPrivadoKnowledgeWeb(item.address))) {
            throw new Error('O domínio informado resolve para uma rede privada ou inválida.');
        }
    }
    return url;
}

function decodificarEntidadesKnowledgeWeb(texto = '') {
    const mapa = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };
    return String(texto || '')
        .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n) || 32))
        .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCodePoint(parseInt(n, 16) || 32))
        .replace(/&([a-z]+);/gi, (m, nome) => Object.prototype.hasOwnProperty.call(mapa, nome.toLowerCase()) ? mapa[nome.toLowerCase()] : ' ');
}

function extrairTituloKnowledgeWeb(html = '', fallback = '') {
    const match = String(html || '').match(/<title[^>]*>([\s\S]*?)<\/title>/i);
    return limitarTextoIndiceKnowledge(decodificarEntidadesKnowledgeWeb(match?.[1] || fallback).replace(/<[^>]+>/g, ' '), 300);
}

function htmlParaTextoKnowledgeWeb(html = '') {
    return decodificarEntidadesKnowledgeWeb(
        String(html || '')
            .replace(/<!--[\s\S]*?-->/g, ' ')
            .replace(/<(script|style|noscript|svg|template|iframe)[^>]*>[\s\S]*?<\/\1>/gi, ' ')
            .replace(/<(header|nav|footer|aside)[^>]*>[\s\S]*?<\/\1>/gi, ' ')
            .replace(/<br\s*\/?>/gi, '\n')
            .replace(/<\/(p|div|section|article|li|h[1-6]|tr|header|footer|main|nav)>/gi, '\n')
            .replace(/<[^>]+>/g, ' ')
    )
        .replace(/[ \t]+/g, ' ')
        .replace(/\n[ \t]+/g, '\n')
        .replace(/\n{3,}/g, '\n\n')
        .trim()
        .slice(0, KNOWLEDGE_WEB_MAX_TEXT_CHARS_PER_PAGE);
}

function urlCanonicaKnowledgeWeb(valor, origem) {
    try {
        const url = new URL(valor, origem);
        if (!['http:', 'https:'].includes(url.protocol)) return null;
        url.hash = '';
        ['utm_source','utm_medium','utm_campaign','utm_term','utm_content','gclid','fbclid'].forEach(k => url.searchParams.delete(k));
        if (/\.(?:jpg|jpeg|png|webp|gif|svg|ico|pdf|docx?|xlsx?|pptx?|zip|rar|7z|mp3|mp4|avi|mov|css|js|xml)(?:$|\?)/i.test(url.pathname + url.search)) return null;
        return url.toString();
    } catch (_) { return null; }
}

function motivoUrlDescartadaKnowledgeWeb(valor = '', origemPermitida = '') {
    let url;
    try { url = new URL(String(valor || '')); }
    catch (_) { return 'url_invalida'; }
    if (origemPermitida && url.origin !== origemPermitida) return 'outro_dominio';

    // Páginas com parâmetros normalmente representam busca, comentários, tracking,
    // paginação ou variações técnicas. A base web deve refletir páginas institucionais
    // estáveis e facilmente acessíveis pelo público.
    const params = [...url.searchParams.keys()].map(v => String(v || '').toLowerCase());
    if (params.length) return 'parametros';

    const path = decodeURIComponent(String(url.pathname || '/')).toLowerCase().replace(/\/{2,}/g, '/');
    if (/\/(?:wp-admin|wp-login|wp-json|xmlrpc|feed|comments?|comment-page|author|tag|category|search|attachment|trackback|embed)(?:\/|$)/i.test(path)) return 'tecnica';
    if (/\/(?:hello-world|sample-page|pagina-de-exemplo)(?:\/|$)/i.test(path)) return 'padrao_wordpress';
    if (/\/(?:20\d{2})\/(?:0?[1-9]|1[0-2])(?:\/(?:0?[1-9]|[12]\d|3[01]))?(?:\/|$)/i.test(path)) return 'arquivo_data';
    if (/\/page\/\d+(?:\/|$)/i.test(path)) return 'paginacao';
    if (/\/(?:amp)(?:\/|$)/i.test(path)) return 'variacao_amp';
    return '';
}

function profundidadeUrlKnowledgeWeb(valor = '') {
    try {
        return new URL(valor).pathname.split('/').filter(Boolean).length;
    } catch (_) { return 99; }
}

function pontuarUrlPrincipalKnowledgeWeb(valor = '', origemPermitida = '') {
    let url;
    try { url = new URL(String(valor || '')); }
    catch (_) { return -999; }
    const motivo = motivoUrlDescartadaKnowledgeWeb(url.toString(), origemPermitida);
    if (motivo) return -999;
    const path = decodeURIComponent(url.pathname || '/').toLowerCase();
    const profundidade = profundidadeUrlKnowledgeWeb(url.toString());
    if (path === '/' || !path.replace(/\//g, '')) return 100;
    let score = 0;
    if (profundidade === 1) score += 45;
    else if (profundidade === 2) score += 18;
    else score -= 25;

    const positivos = [
        'sobre','quem-somos','escritorio','institucional','equipe','advogado','advogados','profissionais',
        'areas','areas-de-atuacao','atuacao','servicos','especialidades','contato','fale-conosco','atendimento',
        'direito-civil','direito-digital','direito-trabalhista','direito-do-consumidor','consumidor','familia',
        'imobiliario','empresarial','tributario','previdenciario','holding','sucessorio','societario'
    ];
    if (positivos.some(t => path.includes(t))) score += 45;

    const negativos = ['blog','noticia','noticias','artigo','artigos','post','posts','evento','eventos','portfolio','case','cases','politica-de-privacidade','privacy','termos','cookies'];
    if (negativos.some(t => path.includes(t))) score -= 35;
    return score;
}

function urlPrincipalElegivelKnowledgeWeb(valor = '', origemPermitida = '') {
    return pontuarUrlPrincipalKnowledgeWeb(valor, origemPermitida) >= 0;
}

function extrairLinksDeTrechoKnowledgeWeb(html = '', paginaUrl = '', origemPermitida = '') {
    return extrairLinksKnowledgeWeb(html, paginaUrl, origemPermitida)
        .filter(url => urlPrincipalElegivelKnowledgeWeb(url, origemPermitida));
}

function extrairLinksNavegacaoPrincipalKnowledgeWeb(html = '', paginaUrl = '', origemPermitida = '') {
    const bruto = String(html || '');
    const blocos = [];
    const padroes = [
        /<nav\b[^>]*>[\s\S]*?<\/nav>/gi,
        /<header\b[^>]*>[\s\S]*?<\/header>/gi,
        /<(?:div|ul)\b[^>]*(?:id|class)\s*=\s*["'][^"']*(?:menu|nav|navbar|navigation|header-menu|main-menu|primary-menu)[^"']*["'][^>]*>[\s\S]*?<\/(?:div|ul)>/gi
    ];
    for (const regex of padroes) {
        let m;
        while ((m = regex.exec(bruto)) && blocos.length < 40) blocos.push(m[0]);
    }
    const vistos = new Set();
    const links = [];
    for (const bloco of blocos) {
        for (const url of extrairLinksDeTrechoKnowledgeWeb(bloco, paginaUrl, origemPermitida)) {
            if (vistos.has(url)) continue;
            vistos.add(url);
            links.push(url);
        }
    }
    return links.sort((a,b) => pontuarUrlPrincipalKnowledgeWeb(b, origemPermitida) - pontuarUrlPrincipalKnowledgeWeb(a, origemPermitida));
}

function extrairLinksKnowledgeWeb(html = '', paginaUrl = '', origemPermitida = '') {
    const links = [];
    const vistos = new Set();
    const regex = /<a\b[^>]*\bhref\s*=\s*["']([^"']+)["'][^>]*>/gi;
    let match;
    while ((match = regex.exec(String(html || ''))) && links.length < 120) {
        const href = String(match[1] || '').trim();
        if (!href || /^(?:mailto:|tel:|javascript:|#)/i.test(href)) continue;
        const normalizada = urlCanonicaKnowledgeWeb(href, paginaUrl);
        if (!normalizada || vistos.has(normalizada)) continue;
        try {
            const url = new URL(normalizada);
            if (url.origin !== origemPermitida) continue;
        } catch (_) { continue; }
        vistos.add(normalizada);
        links.push(normalizada);
    }
    return links;
}

async function baixarPaginaKnowledgeWeb(urlInicial) {
    let atual = await validarUrlPublicaKnowledgeWeb(urlInicial);
    for (let redir = 0; redir <= 4; redir += 1) {
        const resposta = await axios.get(atual.toString(), {
            responseType: 'text',
            timeout: 9000,
            maxRedirects: 0,
            maxContentLength: KNOWLEDGE_WEB_MAX_HTML_BYTES,
            maxBodyLength: KNOWLEDGE_WEB_MAX_HTML_BYTES,
            validateStatus: status => status >= 200 && status < 400,
            headers: {
                'User-Agent': 'AzevedoJuvencio-KnowledgeBot/1.0 (+base-de-conhecimento)',
                'Accept': 'text/html,text/plain;q=0.9,*/*;q=0.1'
            }
        });
        if (resposta.status >= 300 && resposta.status < 400) {
            const location = resposta.headers?.location;
            if (!location) throw new Error(`Redirecionamento inválido em ${atual.hostname}.`);
            atual = await validarUrlPublicaKnowledgeWeb(new URL(location, atual).toString());
            continue;
        }
        const tipo = String(resposta.headers?.['content-type'] || '').toLowerCase();
        if (!tipo.includes('text/html') && !tipo.includes('text/plain') && !tipo.includes('application/xhtml')) {
            throw new Error('A URL não retornou uma página HTML/texto compatível.');
        }
        const html = String(resposta.data || '').slice(0, KNOWLEDGE_WEB_MAX_HTML_BYTES);
        return { url: atual.toString(), html, tipo };
    }
    throw new Error('A página possui redirecionamentos demais.');
}

async function descobrirUrlsSitemapKnowledgeWeb(urlBase, origemPermitida, limite = KNOWLEDGE_WEB_MAX_PAGES) {
    const paginas = [];
    const paginasVistas = new Set();
    const sitemapsVistos = new Set();
    const filaSitemaps = [];
    try {
        const base = new URL(urlBase);
        filaSitemaps.push(new URL('/sitemap.xml', base.origin).toString());
        filaSitemaps.push(new URL('/wp-sitemap.xml', base.origin).toString());
    } catch (_) { return paginas; }

    while (filaSitemaps.length && paginas.length < limite && sitemapsVistos.size < 20) {
        const sitemapUrl = filaSitemaps.shift();
        if (!sitemapUrl || sitemapsVistos.has(sitemapUrl)) continue;
        sitemapsVistos.add(sitemapUrl);
        try {
            const validada = await validarUrlPublicaKnowledgeWeb(sitemapUrl);
            if (validada.origin !== origemPermitida) continue;
            const resposta = await axios.get(validada.toString(), {
                responseType: 'text', timeout: 8000, maxRedirects: 3,
                maxContentLength: 2 * 1024 * 1024, maxBodyLength: 2 * 1024 * 1024,
                validateStatus: status => status >= 200 && status < 300,
                headers: { 'User-Agent': 'AzevedoJuvencio-KnowledgeBot/1.0 (+base-de-conhecimento)', 'Accept': 'application/xml,text/xml,text/plain;q=0.8,*/*;q=0.1' }
            });
            const xml = String(resposta.data || '').slice(0, 2 * 1024 * 1024);
            const locs = [...xml.matchAll(/<loc[^>]*>([\s\S]*?)<\/loc>/gi)]
                .map(m => decodificarEntidadesKnowledgeWeb(m[1]).trim())
                .filter(Boolean);
            for (const loc of locs) {
                if (paginas.length >= limite) break;
                let parsed;
                try { parsed = new URL(loc, validada); } catch (_) { continue; }
                if (parsed.origin !== origemPermitida) continue;
                parsed.hash = '';
                if (/\.xml(?:$|\?)/i.test(parsed.pathname + parsed.search)) {
                    if (!sitemapsVistos.has(parsed.toString()) && filaSitemaps.length < 40) filaSitemaps.push(parsed.toString());
                    continue;
                }
                const canonica = urlCanonicaKnowledgeWeb(parsed.toString(), urlBase);
                if (!canonica || paginasVistas.has(canonica) || !urlPrincipalElegivelKnowledgeWeb(canonica, origemPermitida)) continue;
                paginasVistas.add(canonica);
                paginas.push(canonica);
            }
        } catch (_) {
            // Sitemap é complementar; ausência/erro não impede a varredura por links internos.
        }
    }
    return paginas.slice(0, limite);
}

async function sincronizarFonteKnowledgeWeb(source) {
    if (!knowledgeWebPagesColl || !knowledgeWebSourcesColl) throw new Error('Fontes web ainda não estão disponíveis.');

    const urlsBrutas = Array.isArray(source.urls) && source.urls.length
        ? source.urls
        : [source.url].filter(Boolean);
    const urlsAutorizadas = [];
    const vistos = new Set();
    for (const valor of urlsBrutas) {
        if (urlsAutorizadas.length >= KNOWLEDGE_WEB_MAX_PAGES) break;
        const validada = await validarUrlPublicaKnowledgeWeb(valor);
        const canonica = urlCanonicaKnowledgeWeb(validada.toString(), validada) || validada.toString();
        if (!vistos.has(canonica)) {
            vistos.add(canonica);
            urlsAutorizadas.push(canonica);
        }
    }
    if (!urlsAutorizadas.length) throw new Error('Informe ao menos uma página pública para sincronizar.');

    const paginas = [];
    const erros = [];
    for (const urlAutorizada of urlsAutorizadas) {
        try {
            const baixada = await baixarPaginaKnowledgeWeb(urlAutorizada);
            const texto = htmlParaTextoKnowledgeWeb(baixada.html);
            if (texto.length < 120) {
                erros.push(`${urlAutorizada}: conteúdo textual insuficiente.`);
                continue;
            }
            const finalCanonical = urlCanonicaKnowledgeWeb(baixada.url, urlAutorizada) || baixada.url;
            const titulo = extrairTituloKnowledgeWeb(baixada.html, new URL(finalCanonical).pathname || source.nome || 'Página');
            paginas.push({
                sourceId: source._id,
                sourceName: source.nome || new URL(finalCanonical).hostname,
                url: finalCanonical,
                requestedUrl: urlAutorizada,
                title: titulo || source.nome || new URL(finalCanonical).hostname,
                text: texto,
                contentHash: crypto.createHash('sha256').update(texto).digest('hex'),
                fetchedAt: Date.now(),
                ativo: source.ativo !== false,
                principal: true,
                discoveryVersion: KNOWLEDGE_WEB_DISCOVERY_VERSION
            });
        } catch (err) {
            erros.push(`${urlAutorizada}: ${String(err?.message || err).slice(0, 180)}`);
        }
    }

    if (!paginas.length) throw new Error(erros[0] || 'Nenhuma das páginas informadas pôde ser importada.');
    const agora = Date.now();
    const urlsAtuais = [...new Set(paginas.map(p => p.url))];
    for (const pagina of paginas) {
        await knowledgeWebPagesColl.updateOne(
            { sourceId: source._id, url: pagina.url },
            { $set: pagina, $setOnInsert: { createdAt: agora } },
            { upsert: true }
        );
    }
    await knowledgeWebPagesColl.updateMany(
        { sourceId: source._id, url: { $nin: urlsAtuais } },
        { $set: { ativo: false, principal: false, updatedAt: agora } }
    );
    await knowledgeWebSourcesColl.updateOne(
        { _id: source._id },
        { $set: {
            urls: urlsAutorizadas,
            url: urlsAutorizadas[0],
            maxPages: urlsAutorizadas.length,
            lastSyncAt: agora,
            lastSyncStatus: erros.length && paginas.length < urlsAutorizadas.length ? 'parcial' : 'ok',
            pageCount: paginas.length,
            ignoredPageCount: 0,
            discoveryVersion: KNOWLEDGE_WEB_DISCOVERY_VERSION,
            principalUrls: urlsAtuais,
            lastError: erros.slice(0, 5).join(' | '),
            webSummary: '',
            webPagesAnalysis: [],
            knowledgeSuggestions: [],
            suggestionsGeneratedAt: null,
            suggestionsStatus: geminiModel ? 'aguardando' : 'indisponivel',
            suggestionsError: '',
            updatedAt: agora
        } }
    );
    invalidarCacheKnowledgeWeb();
    return { pageCount: paginas.length, requestedPageCount: urlsAutorizadas.length, ignoredPageCount: 0, warnings: erros.length };
}

function normalizarSugestaoKnowledgeWeb(item = {}, source = {}, index = 0, pagina = {}) {
    const pergunta = String(item?.pergunta || item?.titulo || '').trim().slice(0, 500);
    const resposta = String(item?.resposta || '').trim().slice(0, 5000);
    if (!pergunta || !resposta) return null;
    const paginaUrl = String(pagina?.url || item?.paginaUrl || '').trim().slice(0, 1800);
    const paginaTitulo = String(pagina?.title || item?.paginaTitulo || '').trim().slice(0, 300);
    const idBase = `${String(source?._id || 'site')}:${paginaUrl}:${pergunta}:${resposta.slice(0, 160)}:${index}`;
    return {
        id: crypto.createHash('sha256').update(idBase).digest('hex').slice(0, 24),
        pergunta,
        resposta,
        palavrasChave: normalizarPalavrasChaveKnowledge(item?.palavrasChave || item?.palavrasChaveSugeridas || []),
        variacoesPergunta: normalizarVariacoesKnowledge(item?.variacoesPergunta || []),
        fonteUrls: [...new Set((Array.isArray(item?.fonteUrls) ? item.fonteUrls : [paginaUrl]).map(v => String(v || '').trim()).filter(Boolean))].slice(0, 6),
        paginaUrl,
        paginaTitulo,
        status: 'pendente',
        geradoEm: Date.now()
    };
}

function resumoPaginaFallbackKnowledgeWeb(page = {}) {
    const texto = String(page?.text || '').replace(/\s+/g, ' ').trim();
    if (!texto) return 'Página sincronizada sem conteúdo textual suficiente.';
    return texto.slice(0, 420) + (texto.length > 420 ? '…' : '');
}

function erroTemporarioKnowledgeWebIA(err) {
    const status = Number(err?.status || err?.statusCode || err?.response?.status || err?.cause?.status || 0);
    const msg = String(err?.message || err || '').toLowerCase();
    return [408, 409, 425, 429, 500, 502, 503, 504].includes(status)
        || /high demand|service unavailable|resource exhausted|rate limit|too many requests|timed out|timeout|temporar|try again|overloaded/.test(msg);
}

function esperarKnowledgeWebIA(ms) {
    return new Promise(resolve => setTimeout(resolve, Math.max(0, Number(ms || 0))));
}

function modelosKnowledgeWebIA() {
    const itens = [];
    const usados = new Set();
    const adicionarNome = (nome) => {
        nome = String(nome || '').trim();
        if (!nome || usados.has(nome) || !genAI) return;
        usados.add(nome);
        try {
            itens.push({
                nome,
                model: genAI.getGenerativeModel({ model: nome }, { apiVersion: 'v1beta' })
            });
        } catch (_) {}
    };

    // Para importação de site preferimos um modelo estável em vez do preview usado
    // nas demais rotinas. O modelo principal ainda funciona como fallback.
    adicionarNome(KNOWLEDGE_WEB_AI_PREFERRED_MODEL);
    if (geminiModel) itens.push({ nome: 'modelo-principal', model: geminiModel });
    KNOWLEDGE_WEB_AI_FALLBACK_MODELS.forEach(adicionarNome);
    return itens;
}

async function gerarConteudoKnowledgeWebComRetry(prompt) {
    const modelos = modelosKnowledgeWebIA();
    if (!modelos.length) throw new Error('A IA não está disponível para gerar sugestões do site.');

    let ultimoErro = null;
    let tentativaGlobal = 0;
    for (let indiceModelo = 0; indiceModelo < modelos.length && tentativaGlobal < KNOWLEDGE_WEB_AI_MAX_ATTEMPTS; indiceModelo++) {
        const atual = modelos[indiceModelo];
        // O primeiro modelo recebe até duas tentativas; os demais funcionam como
        // fallback imediato para não prolongar demais uma sincronização com várias páginas.
        const tentativasModelo = indiceModelo === 0 ? 2 : 1;
        for (let local = 1; local <= tentativasModelo && tentativaGlobal < KNOWLEDGE_WEB_AI_MAX_ATTEMPTS; local++) {
            tentativaGlobal += 1;
            try {
                const timeout = new Promise((_, reject) => {
                    setTimeout(() => reject(new Error('Timeout ao gerar sugestão do site.')), KNOWLEDGE_WEB_AI_TIMEOUT_MS);
                });
                const resultado = await Promise.race([atual.model.generateContent(prompt), timeout]);
                return { resultado, modelo: atual.nome, tentativas: tentativaGlobal };
            } catch (err) {
                ultimoErro = err;
                const temporario = erroTemporarioKnowledgeWebIA(err);
                const modeloInexistente = Number(err?.status || err?.statusCode || 0) === 404 || /not found|not supported/.test(String(err?.message || '').toLowerCase());
                const aindaHaModelo = indiceModelo < modelos.length - 1;
                if (!temporario && !modeloInexistente) throw err;
                if (!temporario && modeloInexistente && !aindaHaModelo) throw err;
                if (tentativaGlobal >= KNOWLEDGE_WEB_AI_MAX_ATTEMPTS) break;

                const atraso = (KNOWLEDGE_WEB_AI_RETRY_BASE_MS * (2 ** Math.min(tentativaGlobal - 1, 3))) + Math.floor(Math.random() * 450);
                console.warn(`[IA Site] Modelo ${atual.nome} indisponível na tentativa ${tentativaGlobal}/${KNOWLEDGE_WEB_AI_MAX_ATTEMPTS}. ${aindaHaModelo ? 'Tentando novamente/fallback' : 'Tentando novamente'} em ${atraso}ms.`);
                await esperarKnowledgeWebIA(atraso);
            }
        }
    }
    throw ultimoErro || new Error('Não foi possível consultar a IA para esta página.');
}

function motivoIgnorarPaginaKnowledgeWeb(page = {}) {
    const url = normalizarTexto(page?.url || '');
    const titulo = normalizarTexto(page?.title || '');
    const texto = normalizarTexto(String(page?.text || '').slice(0, 2500));
    const alvo = `${url} ${titulo}`;
    // Apenas descarte determinístico de resíduos técnicos/automáticos. Conteúdo
    // apenas "pouco relevante" continua visível para decisão do advogado.
    if (/\b(?:wp admin|wp login|feed|replytocom|hello world|pagina 404|erro 404|captcha)\b/.test(alvo)) return 'Página técnica/automática do site.';
    if (/\b(?:politica de cookies|cookie policy|preferencias de cookies)\b/.test(alvo) && texto.length < 5000) return 'Página técnica de cookies.';
    if (!texto || texto.length < 120) return 'Conteúdo textual insuficiente.';
    return '';
}

function criarSugestaoFallbackKnowledgeWeb(page = {}, source = {}, index = 0) {
    const titulo = String(page?.title || 'Página do site').trim().slice(0, 260);
    const resumo = resumoPaginaFallbackKnowledgeWeb(page).slice(0, 1200);
    const pergunta = /\?$/.test(titulo) ? titulo : `Informações sobre ${titulo}`;
    return normalizarSugestaoKnowledgeWeb({
        pergunta,
        resposta: resumo,
        palavrasChave: tokensRelevantes(titulo).slice(0, 8),
        variacoesPergunta: [],
        origemGeracao: 'extracao_fallback'
    }, source, index, page);
}

async function analisarPaginaKnowledgeWeb(source, pagina) {
    const trecho = String(pagina?.text || '').trim().slice(0, 11000);
    const prompt = `Você auxilia a construir uma BASE DE CONHECIMENTO aprovada para atendimento jurídico por WhatsApp.

Analise SOMENTE a página abaixo. Sua tarefa é criar material para REVISÃO HUMANA; nada será publicado automaticamente.

FONTE: ${JSON.stringify(source.nome || source.url || 'Site')}
TÍTULO: ${String(pagina?.title || 'Sem título').slice(0, 260)}
URL: ${pagina?.url}
CONTEÚDO DA PÁGINA:\n${trecho}

Retorne SOMENTE JSON válido:
{
  "resumoPagina":"resumo fiel e objetivo do conteúdo",
  "ignorarPagina":false,
  "confiancaIgnorar":0,
  "motivoIgnorar":"",
  "sugestoes":[
    {
      "pergunta":"título/pergunta principal",
      "resposta":"resposta padrão humana para WhatsApp",
      "palavrasChave":["..."],
      "variacoesPergunta":["..."]
    }
  ]
}

REGRAS OBRIGATÓRIAS:
1. Use EXCLUSIVAMENTE fatos desta página. Não use conhecimento externo e não combine informações de outras URLs.
2. A decisão final é do advogado. NÃO descarte uma página apenas porque ela parece pouco relevante, específica, comercial ou difícil de transformar em FAQ.
3. Por padrão use ignorarPagina=false e gere de 1 a 4 sugestões que representem fielmente os principais conteúdos da página.
4. Use ignorarPagina=true SOMENTE quando estiver MUITO CLARO que o conteúdo é técnico/automático, impróprio, malicioso ou totalmente alheio ao escritório/serviços profissionais. Nesses casos use confiancaIgnorar entre 90 e 100 e explique brevemente o motivo.
5. Se houver qualquer conteúdo que um advogado possa querer aproveitar na Base, use ignorarPagina=false. A relevância final será decidida pelo usuário do painel.
6. O resumoPagina deve ter até 900 caracteres e preservar nomes, áreas, serviços, condições, ressalvas e demais fatos exatamente como constam na página.
7. Em páginas de equipe, preserve nomes, cargos e áreas exatamente como publicados. Nunca invente profissional, especialidade ou qualificação.
8. Em páginas jurídicas ou de serviços, não acrescente lei, prazo, valor, resultado, promessa ou interpretação que não esteja expressamente no conteúdo.
9. As respostas devem ser humanas, claras e apropriadas para WhatsApp, mas não podem adicionar fatos.
10. Palavras-chave e variações servem somente para localizar o conhecimento.
11. Nunca prometa resultado jurídico.`;

    const { resultado, modelo, tentativas } = await gerarConteudoKnowledgeWebComRetry(prompt);
    const parsed = extrairJsonIA((await resultado.response).text());
    if (!parsed || typeof parsed !== 'object') throw new Error('A IA retornou uma análise inválida para a página.');
    return { ...parsed, _modelo: modelo, _tentativas: tentativas };
}

async function gerarSugestoesKnowledgeWeb(source) {
    if (!knowledgeWebPagesColl || !knowledgeWebSourcesColl) throw new Error('Fontes web ainda não estão disponíveis.');
    if (!geminiModel && !genAI) throw new Error('A IA não está disponível para gerar sugestões do site.');

    const pages = await knowledgeWebPagesColl.find(
        { sourceId: source._id, ativo: { $ne: false }, principal: true, discoveryVersion: KNOWLEDGE_WEB_DISCOVERY_VERSION },
        { projection: { _id: 1, title: 1, url: 1, text: 1, fetchedAt: 1, principal: 1 } }
    ).sort({ url: 1 }).limit(KNOWLEDGE_WEB_MAX_PAGES).toArray();
    if (!pages.length) throw new Error('Sincronize as páginas informadas antes de gerar sugestões.');

    const sugestoes = [];
    const webPagesAnalysis = [];
    const avisos = [];
    let paginasOcultadas = 0;

    for (let pageIndex = 0; pageIndex < pages.length; pageIndex++) {
        const page = pages[pageIndex];
        const motivoTecnico = motivoIgnorarPaginaKnowledgeWeb(page);
        if (motivoTecnico) {
            paginasOcultadas += 1;
            continue;
        }

        let analise = null;
        let falhaIA = null;
        try {
            analise = await analisarPaginaKnowledgeWeb(source, page);
        } catch (err) {
            falhaIA = err;
            avisos.push(`${page.title || page.url}: IA temporariamente indisponível; foi criado um rascunho extraído da própria página.`);
            console.warn(`[IA Site] Falha após retries/fallbacks em ${page.url}:`, err?.message || err);
        }

        const ignorarPelaIA = !!analise?.ignorarPagina && Number(analise?.confiancaIgnorar || 0) >= 90;
        if (ignorarPelaIA) {
            paginasOcultadas += 1;
            console.log(`[IA Site] Página omitida por conteúdo claramente fora/técnico: ${page.url} — ${String(analise?.motivoIgnorar || '').slice(0, 220)}`);
            continue;
        }

        const resumoPagina = String(analise?.resumoPagina || '').trim().slice(0, 900) || resumoPaginaFallbackKnowledgeWeb(page);
        let sugestoesPagina = (Array.isArray(analise?.sugestoes) ? analise.sugestoes : [])
            .map((item, index) => normalizarSugestaoKnowledgeWeb(item, source, pageIndex * 10 + index, page))
            .filter(Boolean)
            .slice(0, 4);

        // Se a IA não viu uma FAQ perfeita, a página NÃO some. Criamos um rascunho
        // fiel ao texto para o advogado decidir se aproveita, edita ou ignora.
        if (!sugestoesPagina.length) {
            const fallback = criarSugestaoFallbackKnowledgeWeb(page, source, pageIndex * 10);
            if (fallback) sugestoesPagina = [fallback];
        }

        sugestoes.push(...sugestoesPagina);
        webPagesAnalysis.push({
            pageId: String(page._id || ''),
            url: String(page.url || ''),
            title: String(page.title || 'Página sem título').slice(0, 300),
            resumo: resumoPagina,
            suggestionsCount: sugestoesPagina.length,
            generationMode: falhaIA ? 'rascunho_local' : 'ia',
            model: String(analise?._modelo || ''),
            attempts: Number(analise?._tentativas || 0),
            generatedAt: Date.now()
        });

        // Pequena pausa entre páginas reduz rajadas de requisições e picos 429/503.
        if (pageIndex < pages.length - 1) await esperarKnowledgeWebIA(350 + Math.floor(Math.random() * 250));
    }

    const agora = Date.now();
    const totalComSugestoes = webPagesAnalysis.filter(item => item.suggestionsCount > 0).length;
    const webSummary = `${totalComSugestoes} página${totalComSugestoes === 1 ? '' : 's'} disponibilizada${totalComSugestoes === 1 ? '' : 's'} para revisão. ${paginasOcultadas ? `${paginasOcultadas} página${paginasOcultadas === 1 ? '' : 's'} técnica${paginasOcultadas === 1 ? '' : 's'}/fora do escopo ${paginasOcultadas === 1 ? 'foi omitida' : 'foram omitidas'}.` : 'Nenhuma página foi descartada por relevância.'}`;
    const suggestionsStatus = avisos.length ? 'parcial' : 'ok';
    const suggestionsError = avisos.slice(0, 5).join(' | ').slice(0, 1800);

    await knowledgeWebSourcesColl.updateOne(
        { _id: source._id },
        { $set: {
            webSummary,
            webPagesAnalysis,
            knowledgeSuggestions: sugestoes.slice(0, 300),
            suggestionsGeneratedAt: agora,
            suggestionsStatus,
            suggestionsError,
            updatedAt: agora
        } }
    );
    return {
        resumoFonte: webSummary,
        webPagesAnalysis,
        sugestoes: sugestoes.slice(0, 300),
        suggestionsCount: Math.min(300, sugestoes.length),
        generatedAt: agora,
        suggestionsStatus,
        warnings: avisos.length
    };
}

async function carregarKnowledgeWebPages() {
    if (!knowledgeWebSourcesColl || !knowledgeWebPagesColl) return [];
    const agora = Date.now();
    if (knowledgeWebCache.loadedAt && (agora - knowledgeWebCache.loadedAt) < KNOWLEDGE_WEB_CACHE_TTL_MS) return knowledgeWebCache.pages;
    const fontes = await knowledgeWebSourcesColl.find({ ativo: { $ne: false } }, { projection: { _id: 1, nome: 1 } }).toArray();
    const ids = fontes.map(f => f._id);
    if (!ids.length) return [];
    const nomes = new Map(fontes.map(f => [String(f._id), f.nome || 'Site']));
    const pages = await knowledgeWebPagesColl.find(
        { sourceId: { $in: ids }, ativo: { $ne: false }, principal: true, discoveryVersion: KNOWLEDGE_WEB_DISCOVERY_VERSION },
        { projection: { sourceId: 1, title: 1, url: 1, text: 1, fetchedAt: 1 } }
    ).sort({ fetchedAt: -1 }).limit(120).toArray();
    const result = pages.map(page => ({ ...page, sourceName: nomes.get(String(page.sourceId)) || 'Site' }));
    knowledgeWebCache = { pages: result, loadedAt: agora };
    return result;
}

function pontuarPaginaKnowledgeWeb(texto, pagina = {}) {
    const mensagem = normalizarTexto(texto);
    const titulo = normalizarTexto(pagina.title || '');
    const corpo = normalizarTexto(pagina.text || '');
    const url = normalizarTexto(pagina.url || '');
    if (!mensagem || !corpo) return 0;
    let score = 0;
    if (titulo && (mensagem.includes(titulo) || titulo.includes(mensagem))) score += 45;
    const tokens = tokensRelevantes(mensagem);
    for (const token of tokens) {
        if (titulo.includes(token)) score += 10;
        else if (url.includes(token)) score += 7;
        if (corpo.includes(token)) score += 2;
    }
    return score;
}

async function selecionarPaginasKnowledgeWebSemantico(texto, pages = []) {
    if (!geminiModel || !pages.length) return [];
    const ranqueadas = pages.map(p => ({ ...p, score: pontuarPaginaKnowledgeWeb(texto, p) })).sort((a,b) => b.score - a.score);
    const pool = (ranqueadas.filter(p => p.score > 0).slice(0, 35).length ? ranqueadas.filter(p => p.score > 0).slice(0, 35) : ranqueadas.slice(0, 25));
    const indice = pool.map((p, i) => `[${i+1}] ${limitarTextoIndiceKnowledge(p.title, 180)}\nURL: ${p.url}\nTRECHO: ${limitarTextoIndiceKnowledge(p.text, 1200)}`).join('\n\n');
    const prompt = `Você é um mecanismo de busca semântica sobre páginas de um site previamente sincronizado por um escritório de advocacia.\n\nPERGUNTA DO CLIENTE:\n${JSON.stringify(String(texto || '').slice(0,1800))}\n\nPÁGINAS DISPONÍVEIS:\n${indice}\n\nRetorne SOMENTE JSON válido: {"indices":[1,2],"confianca":0}\n\nEscolha no máximo 4 páginas cujo conteúdo realmente ajude a responder a pergunta. Considere sinônimos e erros de digitação. Não use conhecimento externo. Se nada for suficiente, retorne indices vazio.`;
    try {
        const result = await geminiModel.generateContent(prompt);
        const parsed = extrairJsonIA((await result.response).text());
        const vistos = new Set();
        return (Array.isArray(parsed?.indices) ? parsed.indices : [])
            .map(Number)
            .filter(n => Number.isInteger(n) && n >= 1 && n <= pool.length && !vistos.has(n) && vistos.add(n))
            .slice(0, KNOWLEDGE_WEB_MAX_CANDIDATES)
            .map(n => pool[n-1]);
    } catch (err) {
        console.warn('[IA] Falha na busca semântica das fontes web:', err?.message || err);
        return [];
    }
}

async function obterCandidatosKnowledgeWeb(texto) {
    const pages = await carregarKnowledgeWebPages();
    if (!pages.length) return [];
    const ranqueadas = pages.map(p => ({ ...p, score: pontuarPaginaKnowledgeWeb(texto, p) })).sort((a,b) => b.score - a.score);
    const fortes = ranqueadas.filter(p => p.score >= 18).slice(0, KNOWLEDGE_WEB_MAX_CANDIDATES);
    if (fortes.length) return fortes;
    return selecionarPaginasKnowledgeWebSemantico(texto, pages);
}

async function responderComKnowledgeWeb(texto, candidatos = []) {
    if (!geminiModel || !candidatos.length) return null;
    const contexto = candidatos.map((p, i) => `[${i+1}] FONTE: ${p.sourceName}\nPÁGINA: ${p.title}\nURL: ${p.url}\nCONTEÚDO:\n${String(p.text || '').slice(0, 5000)}`).join('\n\n---\n\n');
    const prompt = `Você atende clientes por WhatsApp em nome de um escritório de advocacia. Responda de forma humana, clara e curta, usando EXCLUSIVAMENTE os trechos do site sincronizado abaixo.\n\nPERGUNTA DO CLIENTE:\n${JSON.stringify(String(texto || '').slice(0,1800))}\n\nCONTEÚDO OFICIAL SINCRONIZADO:\n${contexto}\n\nRetorne SOMENTE JSON válido:\n{"resposta":"...","confianca":0}\n\nREGRAS OBRIGATÓRIAS:\n1. Não use conhecimento geral, memória do modelo ou inferências externas.\n2. Não invente nomes, áreas, prazos, valores, leis, resultados ou serviços.\n3. Se o conteúdo não responder com segurança, retorne resposta vazia e confianca 0.\n4. Pode reorganizar e humanizar a redação, mas preserve fielmente os fatos da fonte.\n5. Responda em português do Brasil, de preferência em 1 a 3 parágrafos curtos.\n6. Não mencione que consultou um banco de dados ou uma IA.`;
    try {
        const result = await geminiModel.generateContent(prompt);
        const parsed = extrairJsonIA((await result.response).text());
        const resposta = String(parsed?.resposta || '').trim().slice(0, 3000);
        const confianca = Math.max(0, Math.min(100, Number(parsed?.confianca || 0)));
        if (!resposta || confianca < 65) return null;
        return { resposta, confianca };
    } catch (err) {
        console.warn('[IA] Falha ao responder com fonte web:', err?.message || err);
        return null;
    }
}

function chaveLacunaKnowledge(texto = '') {
    const normalizado = normalizarMensagemClienteIA(texto).replace(/[^a-z0-9\s]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 700);
    return normalizado ? crypto.createHash('sha256').update(normalizado).digest('hex') : '';
}

async function registrarLacunaKnowledge(texto = '', ticket = null) {
    if (!knowledgeGapsColl) return;
    const exemplo = String(texto || '').trim().slice(0, 700);
    const chave = chaveLacunaKnowledge(exemplo);
    if (!chave || exemplo.length < 4) return;
    const agora = Date.now();
    try {
        await knowledgeGapsColl.updateOne(
            { chave },
            {
                $setOnInsert: { chave, textoExemplo: exemplo, firstSeenAt: agora, createdAt: agora, resolvido: false },
                $set: { lastSeenAt: agora, areaExemplo: String(ticket?.area || ticket?.menuOptionTitle || '').slice(0, 160), updatedAt: agora },
                $inc: { ocorrencias: 1 }
            },
            { upsert: true }
        );
    } catch (err) {
        console.warn('[IA] Falha ao registrar dúvida não coberta:', err?.message || err);
    }
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
    const valor = normalizarMensagemClienteIA(texto);
    if (!valor) return false;
    if (texto.includes('?')) return true;

    if (/^(como|qual|quais|quando|onde|por que|porque|posso|pode|preciso|existe|tem|quanto|gostaria de saber|queria saber|duvida|dúvida|saber)\b/.test(valor)) return true;

    // No WhatsApp o cliente frequentemente pergunta sem usar interrogação.
    // Reconhecemos alguns padrões naturais sem transformar qualquer narrativa em FAQ.
    return /\b(?:voces|vcs)\s+(?:fazem|atendem|trabalham|tem|possuem)\b/.test(valor)
        || /\b(?:trabalham com|atendem casos de|fazem atendimento de|tem advogado|possuem advogado)\b/.test(valor)
        || /^(?:dr|dra|doutor|doutora)\b.*\b(?:trabalha|atende|atua|faz parte)\b/.test(valor);
}

function detectarPedidoAtendimentoHumano(texto = '') {
    let valor = normalizarMensagemClienteIA(texto)
        .replace(/[^a-z0-9\s]/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();
    if (!valor) return { solicitado: false, urgente: false, confianca: 0 };

    // Normaliza abreviações muito comuns do WhatsApp antes da classificação.
    valor = ` ${valor} `
        .replace(/\badvs?\b/g, ' advogado ')
        .replace(/\badvog\b/g, ' advogado ')
        .replace(/\bdout\b/g, ' doutor ')
        .replace(/\batend\b/g, ' atendente ')
        .replace(/\bpessoa real\b/g, ' humano ')
        .replace(/\s+/g, ' ')
        .trim();

    // Negação explícita sempre vence para evitar encaminhamento indevido.
    const negado = [
        /\b(?:nao|nem)\s+(?:quero|preciso|gostaria|necessito).{0,35}\b(?:advogad[oa]|atendente|humano|pessoa|alguem|doutor|doutora)\b/,
        /\b(?:nao|nem)\s+(?:quero|preciso)\s+(?:falar|conversar|contato|atendimento)\b/,
        /\b(?:dispenso|sem necessidade de)\s+(?:advogad[oa]|atendente|humano|pessoa)\b/
    ].some(regex => regex.test(valor));
    if (negado) return { solicitado: false, urgente: false, confianca: 1, origem: 'regra_negacao' };

    const urgente = /\b(?:urgente|urgencia|emergencia|o quanto antes|agora|imediatamente|rapido|rapidamente)\b/.test(valor);

    const padroesFortes = [
        /\b(?:quero|preciso|gostaria|necessito|queria)\s+(?:falar|conversar|ter contato|entrar em contato|ser atendid[oa])\s+(?:com\s+)?(?:um\s+|uma\s+|algum\s+|alguma\s+)?(?:advogad[oa]|atendente|pessoa|humano|alguem|doutor|doutora|dr|dra|especialista|profissional)\b/,
        /\b(?:falar|conversar|contato|atendimento)\s+(?:com\s+)?(?:um\s+|uma\s+|algum\s+|alguma\s+)?(?:advogad[oa]|atendente|pessoa|humano|alguem|doutor|doutora|dr|dra|especialista|profissional)\b/,
        /\b(?:chama|chamar|chame|manda|mande|coloca|coloque)\s+(?:um\s+|uma\s+|algum\s+|alguma\s+)?(?:advogad[oa]|atendente|pessoa|humano|alguem|doutor|doutora|dr|dra)\b/,
        /\b(?:preciso|quero|necessito|gostaria|queria)\s+(?:de\s+)?(?:um\s+|uma\s+|algum\s+|alguma\s+)?(?:advogad[oa]|atendente|humano|alguem|pessoa|especialista)\b/,
        /\b(?:atendimento|suporte)\s+(?:humano|com\s+advogad[oa]|com\s+atendente)\b/,
        /\b(?:advogad[oa]|atendente|humano|especialista)\s+(?:por favor|pf|urgente|agora)\b/,
        /\b(?:tem|ha|cad[eê]|onde esta)\s+(?:alguem|um atendente|uma pessoa|um advogado|advogado)\s+(?:ai|a[ií])?\b/
    ];
    if (padroesFortes.some(regex => regex.test(valor))) {
        return { solicitado: true, urgente, confianca: 1, origem: 'regra_forte' };
    }

    // Frases curtas típicas também são tratadas localmente para resposta imediata.
    const tokens = new Set(valor.split(' ').filter(Boolean));
    const alvoHumano = ['advogado','advogada','atendente','humano','alguem','pessoa','doutor','doutora','dr','dra','especialista','profissional']
        .some(t => tokens.has(t));
    const intencaoContato = ['quero','preciso','necessito','gostaria','queria','falar','conversar','contato','chamar','chama','chame','atendimento','urgente']
        .some(t => tokens.has(t));
    if (alvoHumano && intencaoContato && valor.split(' ').length <= 12) {
        return { solicitado: true, urgente, confianca: 0.9, origem: 'regra_tokens' };
    }

    return { solicitado: false, urgente, confianca: 0, origem: 'nenhuma' };
}

function parecePedidoHumanoAmbiguo(texto = '') {
    const valor = normalizarMensagemClienteIA(texto).replace(/[^a-z0-9\s]/g, ' ').replace(/\s+/g, ' ').trim();
    if (!valor || valor.length > 260) return false;
    const alvo = /\b(?:adv|advogado|advogada|advogad|atendente|atendimento|humano|alguem|pessoa|dr|dra|doutor|doutora|especialista|profissional)\b/.test(valor);
    const intencao = /\b(?:quero|preciso|necessito|gostaria|queria|falar|conversar|contato|chamar|chama|atender|urgente|agora|ajuda)\b/.test(valor);
    return alvo && intencao;
}

async function detectarPedidoAtendimentoHumanoComIA(texto = '') {
    const local = detectarPedidoAtendimentoHumano(texto);
    if (local.solicitado || !parecePedidoHumanoAmbiguo(texto)) return local;

    const prompt = `Classifique APENAS a intenção desta mensagem de WhatsApp:
${JSON.stringify(String(texto || '').slice(0, 500))}

Retorne somente JSON válido: {"solicitado":true,"urgente":false}

Use solicitado=true apenas se a pessoa estiver pedindo para falar, conversar, ser atendida ou entrar em contato com um ser humano, advogado, atendente, doutor ou profissional da equipe.
Não marque true se ela estiver apenas perguntando uma informação sobre advogado, preço, área de atuação ou fazendo uma pergunta jurídica.
Se houver negação (ex.: "não quero falar com advogado"), use false.
Urgente=true somente se houver urgência explícita. Não use conhecimento externo.`;

    try {
        const { resultado } = await gerarConteudoKnowledgeBaseComRetry(prompt);
        const parsed = extrairJsonIA((await resultado.response).text());
        if (typeof parsed?.solicitado === 'boolean') {
            return {
                solicitado: parsed.solicitado === true,
                urgente: parsed.urgente === true || local.urgente === true,
                confianca: parsed.solicitado === true ? 0.75 : 0,
                origem: 'ia_intencao_humano'
            };
        }
    } catch (err) {
        console.warn('[IA] Falha ao classificar pedido de atendimento humano; seguindo regras locais:', err?.message || err);
    }
    return local;
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
    if (ticket?.aguardandoWhatsappCadastro && normalizarNumeroDigitadoCliente(texto)) return true;

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

function escaparControlesInvalidosJson(texto = '') {
    let saida = '';
    let emString = false;
    let escapado = false;
    for (const ch of String(texto || '')) {
        if (escapado) {
            saida += ch;
            escapado = false;
            continue;
        }
        if (ch === '\\') {
            saida += ch;
            if (emString) escapado = true;
            continue;
        }
        if (ch === '"') {
            emString = !emString;
            saida += ch;
            continue;
        }
        if (emString) {
            if (ch === '\n') { saida += '\\n'; continue; }
            if (ch === '\r') { saida += '\\r'; continue; }
            if (ch === '\t') { saida += '\\t'; continue; }
            if (ch.charCodeAt(0) < 32) { saida += ' '; continue; }
        }
        saida += ch;
    }
    return saida;
}

function extrairPrimeiroObjetoJsonBalanceado(texto = '') {
    const valor = String(texto || '');
    let inicio = -1;
    let nivel = 0;
    let emString = false;
    let escapado = false;
    for (let i = 0; i < valor.length; i++) {
        const ch = valor[i];
        if (escapado) { escapado = false; continue; }
        if (ch === '\\' && emString) { escapado = true; continue; }
        if (ch === '"') { emString = !emString; continue; }
        if (emString) continue;
        if (ch === '{') {
            if (inicio < 0) inicio = i;
            nivel += 1;
        } else if (ch === '}' && inicio >= 0) {
            nivel -= 1;
            if (nivel === 0) return valor.slice(inicio, i + 1);
        }
    }
    if (inicio >= 0) {
        const fim = valor.lastIndexOf('}');
        if (fim > inicio) return valor.slice(inicio, fim + 1);
    }
    return '';
}

function tentarParseJsonIA(candidato = '', profundidade = 0) {
    if (!candidato || profundidade > 2) return null;
    const base = String(candidato).trim();
    const tentativas = [];
    const adicionar = (valor) => {
        valor = String(valor || '').trim();
        if (valor && !tentativas.includes(valor)) tentativas.push(valor);
    };

    adicionar(base);
    adicionar(base.replace(/,\s*([}\]])/g, '$1'));
    adicionar(escaparControlesInvalidosJson(base));
    adicionar(escaparControlesInvalidosJson(base).replace(/,\s*([}\]])/g, '$1'));

    for (const tentativa of tentativas) {
        try {
            const parsed = JSON.parse(tentativa);
            if (typeof parsed === 'string' && /[\[{]/.test(parsed)) {
                const interno = tentarParseJsonIA(parsed, profundidade + 1);
                if (interno !== null) return interno;
            }
            return parsed;
        } catch (_) {}
    }
    return null;
}

function extrairJsonIA(raw = '') {
    const limpo = String(raw || '')
        .replace(/^\uFEFF/, '')
        .trim()
        .replace(/^```(?:json)?\s*/i, '')
        .replace(/```\s*$/i, '')
        .trim();

    if (!limpo) return null;

    const direto = tentarParseJsonIA(limpo);
    if (direto !== null) return direto;

    const objeto = extrairPrimeiroObjetoJsonBalanceado(limpo);
    if (objeto) {
        const parsed = tentarParseJsonIA(objeto);
        if (parsed !== null) return parsed;
    }

    // Alguns modelos eventualmente devolvem um objeto JSON escapado como texto.
    if (/\\"[A-Za-zÀ-ÿ0-9_]+\\"\s*:/.test(limpo)) {
        const desescapado = limpo
            .replace(/\\"/g, '"')
            .replace(/\\\\n/g, '\\n')
            .replace(/\\\\r/g, '\\r')
            .replace(/\\\\t/g, '\\t');
        const objetoDesescapado = extrairPrimeiroObjetoJsonBalanceado(desescapado) || desescapado;
        const parsed = tentarParseJsonIA(objetoDesescapado);
        if (parsed !== null) return parsed;
    }

    return null;
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

    if (ticket.aguardandoWhatsappCadastro) {
        return `\n\nPara concluir o cadastro, confirme o *número deste WhatsApp com DDD*. Exemplo: 19 99999-9999.`;
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

    // Pedido de contato humano é uma intenção operacional, não uma pergunta de conhecimento.
    // Portanto não consulta a Base e nunca deve cair em "não encontrei essa informação".
    const pedidoHumano = await detectarPedidoAtendimentoHumanoComIA(texto);
    if (pedidoHumano.solicitado) {
        return {
            acao: 'ATENDIMENTO_HUMANO',
            origem: pedidoHumano.origem || 'regra',
            urgente: pedidoHumano.urgente === true
        };
    }

    const atendimentoHumanoAtivo = ticket.status === 'em_atendimento_humano';
    const cortesia = detectarCortesiaMensagem(texto);

    // Cumprimentos e agradecimentos isolados não são tratados como erro de menu/cadastro.
    // O bot responde a cortesia e retoma exatamente o ponto em que o cliente estava.
    // Se um advogado já assumiu a conversa, o bot permanece silencioso para não disputar o diálogo.
    if (!atendimentoHumanoAtivo && cortesia.somenteCortesia) {
        return { acao: 'CORTESIA', origem: 'regra', cortesia };
    }

    // V31: informações institucionais, nomes de profissionais e demais fatos do escritório
    // NÃO são mais obtidos de usuários ou de outros dados internos do sistema. Para o BOT,
    // a única fonte factual de conhecimento é a Base de Conhecimento aprovada.

    // Respostas das perguntas sequenciais são dados do caso e não devem ser consumidas pela IA.
    if (entradaEstruturadaDoFluxo(ticket, texto)) return null;

    // Quando um atendente humano já assumiu a conversa, a IA não responde FAQs para não
    // disputar o diálogo. Ainda permitimos a análise semântica de encerramento logo abaixo.
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

    // V31: páginas sincronizadas do site NÃO respondem diretamente ao cliente.
    // O site serve apenas para gerar sugestões que um usuário humano poderá aprovar e
    // transformar em itens da Base de Conhecimento. Enquanto não houver aprovação,
    // o conteúdo web não participa do atendimento automático.

    // Perguntas reais nunca devem ficar sem qualquer retorno. Se nenhuma fonte aprovada
    // responder com segurança, registramos a lacuna sem recorrer ao conhecimento geral.
    if (!sinalEncerramento && !candidatos.length) {
        if (sinalPergunta) {
            registrarLacunaKnowledge(texto, ticket).catch(() => {});
            return {
                acao: 'SEM_BASE',
                origem: 'sem_base',
                resposta: 'Não tenho essa informação cadastrada na base no momento. Vou deixar sua dúvida registrada para a equipe verificar.'
            };
        }
        return null;
    }

    // Correspondência local forte: não usamos Gemini para decidir algo que a própria
    // Base já comprova de forma inequívoca. Isso mantém a Base funcionando mesmo durante
    // indisponibilidade da API e reduz a latência de perguntas com nomes/expressões exatas.
    const melhorLocal = candidatos[0];
    const segundoLocal = candidatos[1];
    const margemLocal = Number(melhorLocal?.score || 0) - Number(segundoLocal?.score || 0);
    if (
        sinalPergunta &&
        melhorLocal?.resposta &&
        (melhorLocal.localMatchForte === true || Number(melhorLocal.score || 0) >= 88) &&
        (margemLocal >= 8 || Number(melhorLocal.score || 0) >= 120 || !segundoLocal)
    ) {
        console.log(`[IA Base] Resposta local forte: ${String(melhorLocal.pergunta || '').slice(0, 90)} (score ${Number(melhorLocal.score || 0).toFixed(1)}).`);
        return {
            acao: 'RESPONDER_BASE',
            resposta: String(melhorLocal.resposta).trim().slice(0, 3000),
            origem: 'base_local_forte'
        };
    }

    // Fallback resiliente: se o Gemini estiver indisponível, uma correspondência exata/forte
    // ainda pode ser respondida diretamente com o conteúdo já aprovado da base.
    if (!geminiModel) {
        const melhor = candidatos[0];
        if (sinalPergunta && melhor && (melhor.localMatchForte === true || melhor.score >= 34)) {
            console.warn(`[IA Base] API indisponível; usando correspondência local aprovada (score ${Number(melhor.score || 0).toFixed(1)}).`);
            return { acao: 'RESPONDER_BASE', resposta: melhor.resposta, origem: 'fallback_base_local' };
        }
        if (sinalPergunta) {
            registrarLacunaKnowledge(texto, ticket).catch(() => {});
            return {
                acao: 'SEM_BASE',
                origem: 'sem_base',
                resposta: 'Não tenho essa informação cadastrada na base no momento. Vou deixar sua dúvida registrada para a equipe verificar.'
            };
        }
        return null;
    }

    const baseContexto = candidatos.length
        ? candidatos.map((item, index) => (
            `[${index + 1}] TÍTULO/PERGUNTA: ${item.pergunta}\n` +
            `PALAVRAS-CHAVE: ${(item.palavrasChave || []).join(', ') || '(não cadastradas)'}\n` +
            `PRIORIDADE: ${Number(item.prioridade || 3)}\n` +
            `RESPOSTA APROVADA: ${item.resposta}`
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
5. MODO ESTRITO: nunca use seu conhecimento geral para responder. Nunca invente, complete, interprete juridicamente, combine itens ou acrescente qualquer informação além da RESPOSTA APROVADA escolhida.
6. Escolha um item somente se ele responder diretamente à pergunta atual. Sem correspondência clara, use NENHUMA.
7. Se a mensagem apenas narrar o caso, enviar dados, nome, CPF, documento, opção de menu ou não puder ser respondida com segurança pela base, use NENHUMA e indiceBase null.
8. Em caso de dúvida, prefira NENHUMA.`;

    try {
        const { resultado, modelo } = await gerarConteudoKnowledgeBaseComRetry(prompt);
        const response = await resultado.response;
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

        if (sinalPergunta) {
            registrarLacunaKnowledge(texto, ticket).catch(() => {});
            return {
                acao: 'SEM_BASE',
                origem: 'sem_base',
                resposta: 'Não tenho essa informação cadastrada na base no momento. Vou deixar sua dúvida registrada para a equipe verificar.'
            };
        }
        return null;
    } catch (err) {
        console.error('[IA] Erro ao analisar mensagem:', err?.message || err);

        const melhor = candidatos[0];
        if (sinalPergunta && melhor && (melhor.localMatchForte === true || melhor.score >= 34)) {
            console.warn(`[IA Base] API indisponível; usando correspondência local aprovada (score ${Number(melhor.score || 0).toFixed(1)}).`);
            return { acao: 'RESPONDER_BASE', resposta: melhor.resposta, origem: 'fallback_base_local' };
        }
        if (sinalPergunta) {
            registrarLacunaKnowledge(texto, ticket).catch(() => {});
            return {
                acao: 'SEM_BASE',
                origem: 'sem_base',
                resposta: 'Não tenho essa informação cadastrada na base no momento. Vou deixar sua dúvida registrada para a equipe verificar.'
            };
        }
        return null;
    }
}

async function encerrarTicketPorCliente(ticket, jid, mensagemCliente = '') {
    if (!ticket) return false;

    const agora = Date.now();
    const mensagemFinal = `Certo. O ticket *${ticket.ticketNumber}* foi encerrado conforme solicitado. Agradecemos pelo contato e permanecemos à disposição quando precisar.`;

    // Encerramento é uma ação operacional simples: não depende do Gemini.
    // Persistimos o fechamento e enviamos a confirmação em paralelo para reduzir a latência.
    const [resultadoHistorico, resultadoEnvio] = await Promise.allSettled([
        atualizarHistorico(ticket.ticketNumber, {
            status: 'encerrado',
            closedAt: agora,
            archivedAt: agora,
            encerradoPeloCliente: true,
            mensagemEncerramentoCliente: String(mensagemCliente || '').slice(0, 1200)
        }),
        sendBotMsg(jid, { text: mensagemFinal })
    ]);

    if (resultadoHistorico.status === 'rejected') {
        console.warn(`[Ticket ${ticket.ticketNumber}] Falha ao registrar encerramento solicitado pelo cliente:`, resultadoHistorico.reason?.message || resultadoHistorico.reason);
    }
    if (resultadoEnvio.status === 'rejected') {
        console.warn(`[Ticket ${ticket.ticketNumber}] Falha ao confirmar encerramento ao cliente:`, resultadoEnvio.reason?.message || resultadoEnvio.reason);
    }

    const removido = await ticketsColl.deleteOne({ _id: ticket._id, ticketNumber: ticket.ticketNumber });
    if (!removido.deletedCount) {
        console.warn(`[Ticket ${ticket.ticketNumber}] Ticket já havia sido removido ao processar encerramento do cliente.`);
        return true;
    }

    // Remove o ticket da tela dos advogados imediatamente, sem aguardar atualização manual.
    io.emit('ticket_archived', {
        ticketNumber: ticket.ticketNumber,
        archivedAt: agora,
        archivedById: null,
        archivedByName: 'Cliente',
        encerradoPeloCliente: true
    });

    return true;
}

async function responderInterrupcaoIA(ticket, jid, analiseIA, mensagemCliente = '') {
    if (!analiseIA) return false;

    if (analiseIA.acao === 'ENCERRAR') {
        await encerrarTicketPorCliente(ticket, jid, mensagemCliente);
        return true;
    }

    if (analiseIA.acao === 'ATENDIMENTO_HUMANO') {
        const agora = Date.now();
        const urgente = analiseIA.urgente === true;

        // Se esta rotina foi chamada, existe um ticket ativo. Pedido por advogado/humano
        // nunca consulta a Base e sempre recebe a mesma confirmação operacional.
        // Não usamos cooldown: cada nova insistência explícita recebe retorno claro.
        if (ticket) {
            const mensagemEspera = 'Seu atendimento já está aberto. Aguarde mais um instante que alguém da equipe já vai entrar em contato com você.';
            await Promise.allSettled([
                sendBotMsg(jid, { text: mensagemEspera }),
                ticketsColl.updateOne(
                    { _id: ticket._id },
                    { $set: {
                        ultimaRespostaInsistenciaHumanoEm: agora,
                        solicitouAtendimentoHumanoEm: ticket.solicitouAtendimentoHumanoEm || agora,
                        pedidoAtendimentoUrgente: urgente || ticket.pedidoAtendimentoUrgente === true,
                        lastActivity: agora
                    } }
                ),
                atualizarHistorico(ticket.ticketNumber, {
                    ultimoPedidoRepetidoAtendimentoHumanoEm: agora,
                    solicitouAtendimentoHumanoEm: ticket.solicitouAtendimentoHumanoEm || agora,
                    pedidoAtendimentoUrgente: urgente || ticket.pedidoAtendimentoUrgente === true,
                    mensagemPedidoHumano: String(mensagemCliente || '').trim().slice(0, 1200),
                    origemDeteccaoPedidoHumano: analiseIA.origem || 'regra'
                })
            ]);
            ticket.ultimaRespostaInsistenciaHumanoEm = agora;
            return true;
        }

        return false;
    }

    if (analiseIA.acao === 'CORTESIA') {
        const cortesia = analiseIA.cortesia || detectarCortesiaMensagem(mensagemCliente);
        const aguardandoEquipe = ticket?.paused || ticket?.status === 'aguardando_especialista';

        // Cortesias curtas NÃO passam pelo Gemini. Para "bom dia", "obrigado",
        // "valeu" etc., uma resposta pequena e previsível soa mais humana e evita
        // que a IA repita nome, ticket ou o estado do atendimento sem necessidade.
        // Cada categoria é respondida apenas UMA VEZ por ticket. Repetições posteriores
        // são consumidas silenciosamente, sem disparar confirmação automática novamente.
        const jaRespondeuSaudacao = !!ticket?.saudacaoAutomaticaRespondidaEm;
        const jaRespondeuAgradecimento = !!ticket?.agradecimentoAutomaticoRespondidoEm;
        const responderSaudacao = !!cortesia.saudacao && !jaRespondeuSaudacao;
        const responderAgradecimento = !!cortesia.agradecimento && !jaRespondeuAgradecimento;
        const agora = Date.now();

        if (!responderSaudacao && !responderAgradecimento) {
            await ticketsColl.updateOne(
                { _id: ticket._id },
                { $set: { lastActivity: agora } }
            );
            return true;
        }

        let respostaCortesia = '';
        if (responderSaudacao && responderAgradecimento) {
            respostaCortesia = `${cortesia.saudacao}! Por nada.`;
        } else if (responderSaudacao) {
            respostaCortesia = `${cortesia.saudacao}!`;
        } else if (responderAgradecimento) {
            respostaCortesia = 'Por nada!';
        }

        // Só retomamos uma pergunta realmente pendente. Se o ticket já está com a equipe,
        // não repetimos número do ticket nem status operacional após um simples agradecimento.
        const deveRetomarFluxo = !aguardandoEquipe && ticket?.status !== 'em_atendimento_humano';
        const retomada = deveRetomarFluxo ? await mensagemRetomadaFluxo(ticket) : '';
        const textoFinal = `${respostaCortesia}${retomada}`.trim();

        if (textoFinal) {
            await sendBotMsg(jid, { text: textoFinal });
        }

        const camposTicket = { lastActivity: agora };
        const camposHistorico = { ultimaRespostaCortesiaEm: agora };

        if (responderSaudacao) {
            camposTicket.saudacaoAutomaticaRespondidaEm = agora;
            camposHistorico.saudacaoAutomaticaRespondidaEm = agora;
        }
        if (responderAgradecimento) {
            camposTicket.agradecimentoAutomaticoRespondidoEm = agora;
            camposHistorico.agradecimentoAutomaticoRespondidoEm = agora;
        }

        await ticketsColl.updateOne(
            { _id: ticket._id },
            { $set: camposTicket }
        );
        await atualizarHistorico(ticket.ticketNumber, camposHistorico);
        return true;
    }

    if (analiseIA.acao === 'SEM_BASE') {
        const precisaRetomarEtapa = !!(
            ticket?.aguardandoOpcao || ticket?.aguardandoPerguntaFluxo || ticket?.aguardandoDetalhes ||
            ticket?.aguardandoDetalhesForaHorario || ticket?.aguardandoCadastroCliente || ticket?.aguardandoNomeCadastro ||
            ticket?.aguardandoCPFCadastro || ticket?.aguardandoWhatsappCadastro
        );
        const retomada = precisaRetomarEtapa ? await mensagemRetomadaFluxo(ticket) : '';
        const cortesia = detectarCortesiaMensagem(mensagemCliente);
        const prefixo = cortesia.saudacao ? `${cortesia.saudacao}!\n\n` : '';
        const resposta = String(analiseIA.resposta || '').trim();
        if (!resposta) return false;

        await sendBotMsg(jid, { text: `${prefixo}${resposta}${retomada}` });

        const agora = Date.now();
        await Promise.allSettled([
            ticketsColl.updateOne({ _id: ticket._id }, { $set: { lastActivity: agora } }),
            atualizarHistorico(ticket.ticketNumber, {
                ultimaRespostaIAEm: agora,
                ultimaRespostaIAOrigem: analiseIA.origem || analiseIA.acao
            })
        ]);

        console.log(`[Ticket ${ticket.ticketNumber}] IA respondeu com fonte ${analiseIA.origem || analiseIA.acao}.`);
        return true;
    }

    if (analiseIA.acao === 'RESPONDER_BASE') {
        const retomada = await mensagemRetomadaFluxo(ticket);
        const cortesia = detectarCortesiaMensagem(mensagemCliente);
        const prefixos = [];

        // Se houver uma pergunta real junto com uma expressão de agradecimento
        // (ex.: "Obrigado, vocês atendem bloqueio de Instagram?"), respondemos
        // diretamente à dúvida. Retribuir o agradecimento neste ponto deixa a
        // conversa artificial e repete uma cortesia que não é o objetivo principal
        // da mensagem. Agradecimentos ISOLADOS continuam sendo tratados acima como
        // CORTESIA e recebem somente "Por nada!".
        if (cortesia.saudacao) prefixos.push(`${cortesia.saudacao}!`);
        const prefixo = prefixos.length ? `${prefixos.join(' ')}\n\n` : '';

        // A resposta jurídica/aprovada da knowledge_base não é reescrita pela IA.
        // Humanizamos apenas a abertura, preservando integralmente o conteúdo cadastrado.
        await sendBotMsg(jid, {
            text: `${prefixo}${analiseIA.resposta}${retomada}`
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

async function confirmarMensagemAguardandoEspecialista(ticket, jid, mensagemCliente = '') {
    if (!ticket || ticket.status !== 'aguardando_especialista') return;

    // O cliente pode continuar enviando mensagens e documentos enquanto aguarda
    // o especialista. O conteúdo já é salvo no histórico do chat em outro ponto
    // do fluxo. Aqui apenas atualizamos a atividade do ticket, sem enviar qualquer
    // confirmação automática para não deixar a conversa artificial/robotizada.
    await ticketsColl.updateOne(
        { _id: ticket._id },
        { $set: { lastActivity: Date.now() } }
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


function normalizarCelularUsuario(valor = '') {
    const texto = String(valor || '').trim();
    if (!texto) return '';

    let digitos = texto.replace(/\D/g, '');
    // Para números brasileiros informados apenas com DDD + telefone, armazenamos
    // em E.164 sem o sinal de +. Números internacionais já completos são preservados.
    if (digitos.length === 10 || digitos.length === 11) digitos = `55${digitos}`;
    if (digitos.length < 12 || digitos.length > 15) return '';
    return digitos;
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
        const cache = lidPnRuntimeCache.get(lid);
        if (cache && (Date.now() - Number(cache.salvoEm || 0)) < LID_PN_RUNTIME_CACHE_TTL_MS) {
            return { numero: cache.numero, pnJid: cache.pnJid, lid };
        }

        try {
            const pn = await sock.signalRepository.lidMapping.getPNForLID(lid);
            const numero = normalizarNumeroWhatsApp(pn);
            if (numero) {
                const pnJid = normalizarJid(pn);
                lidPnRuntimeCache.set(lid, { numero, pnJid, salvoEm: Date.now() });
                return { numero, pnJid, lid };
            }
        } catch (err) {
            console.warn(`[LID] Não foi possível resolver ${lid}:`, err?.message || err);
        }
    }

    return null;
}

function normalizarNumeroDigitadoCliente(valor = '') {
    const digitos = String(valor || '').replace(/\D/g, '');
    if (digitos.length < 10 || digitos.length > 15) return null;

    // Para números brasileiros informados somente com DDD + telefone, gravamos
    // no mesmo padrão E.164 que o WhatsApp usa internamente.
    if ((digitos.length === 10 || digitos.length === 11) && !digitos.startsWith('55')) {
        return `55${digitos}`;
    }

    return digitos;
}

async function resolverNumeroWhatsAppCadastro(ticket, contato, rawJid, numeroInformado = null) {
    const identificadoresMesclados = [...new Set([
        ...(Array.isArray(ticket?.identificadores) ? ticket.identificadores : []),
        ...(Array.isArray(contato?.identificadores) ? contato.identificadores : []),
        ticket?.lastRawJid,
        rawJid
    ].filter(Boolean))];

    const numeroDigitado = numeroInformado ? normalizarNumeroDigitadoCliente(numeroInformado) : null;
    const numerosMesclados = [...new Set([
        numeroDigitado,
        ...(Array.isArray(ticket?.whatsappNumbers) ? ticket.whatsappNumbers : []),
        ...(Array.isArray(contato?.whatsappNumbers) ? contato.whatsappNumbers : []),
        ticket?.numeroReal,
        contato?.numeroPrincipal
    ].map(normalizarNumeroWhatsApp).filter(Boolean))];

    let numeroPrincipal = numeroDigitado || extrairNumeroWhatsAppDeFontes(
        contato?.numeroPrincipal,
        ticket?.numeroReal,
        contato?.whatsappNumbers,
        ticket?.whatsappNumbers,
        identificadoresMesclados
    );

    if (!numeroPrincipal) {
        const resolvido = await resolverPnDeLids(identificadoresMesclados);
        if (resolvido?.numero) {
            numeroPrincipal = resolvido.numero;
            numerosMesclados.push(resolvido.numero);
            if (resolvido.pnJid) identificadoresMesclados.push(resolvido.pnJid);
        }
    }

    if (numeroPrincipal) {
        numerosMesclados.push(numeroPrincipal);
        identificadoresMesclados.push(`${numeroPrincipal}@s.whatsapp.net`);
    }

    return {
        numeroPrincipal: numeroPrincipal || null,
        numerosMesclados: [...new Set(numerosMesclados.filter(Boolean))],
        identificadoresMesclados: [...new Set(identificadoresMesclados.filter(Boolean))]
    };
}

async function obterIdentificadoresContato(msg, rawJid, { resolverLid = true } = {}) {
    const jids = new Set();
    const numeros = new Set();

    const adicionarJid = (jid) => {
        const normalizado = normalizarJid(jid);
        if (!normalizado) return;

        jids.add(normalizado);
        const numero = numeroDePnJid(normalizado);
        if (numero) numeros.add(numero);
    };

    // O formato do identificador varia conforme a versão do Baileys e o
    // addressingMode usado pelo WhatsApp. Em conversa privada, o telefone pode
    // aparecer em remoteJid, remoteJidAlt ou senderPn. Em versões intermediárias
    // também encontramos participantPn/participantAlt. Coletamos todos antes de
    // decidir qual deles é o número real.
    [
        rawJid,
        msg?.key?.remoteJid,
        msg?.key?.remoteJidAlt,
        msg?.key?.senderPn,
        msg?.key?.senderLid,
        msg?.key?.participant,
        msg?.key?.participantAlt,
        msg?.key?.participantPn,
        msg?.key?.participantLid,
        msg?.senderPn,
        msg?.senderLid,
        msg?.participantPn,
        msg?.participantAlt
    ].filter(Boolean).forEach(adicionarJid);

    const jidNormalizado = normalizarJid(rawJid);

    // Quando a própria mensagem traz LID e PN ao mesmo tempo, persistimos esse
    // par no repositório do Baileys. Isso evita perder a relação antes do cadastro.
    const lidsObservados = [...jids].filter(jid => String(jid).endsWith('@lid'));
    const pnsObservados = [...jids].filter(jid => String(jid).endsWith('@s.whatsapp.net'));
    if (lidsObservados.length && pnsObservados.length) {
        // Se a própria mensagem já trouxe PN e LID, não bloqueamos o fluxo consultando
        // novamente o Signal. Alimentamos o cache local imediatamente e persistimos o
        // mapeamento em segundo plano.
        const pnPreferido = pnsObservados[0];
        const numeroPn = normalizarNumeroWhatsApp(pnPreferido);
        if (numeroPn) {
            for (const lid of lidsObservados) {
                lidPnRuntimeCache.set(lid, { numero: numeroPn, pnJid: pnPreferido, salvoEm: Date.now() });
            }
        }

        if (sock?.signalRepository?.lidMapping?.storeLIDPNMappings) {
            Promise.resolve(
                sock.signalRepository.lidMapping.storeLIDPNMappings(
                    lidsObservados.flatMap(lid => pnsObservados.map(pn => ({ lid, pn })))
                )
            ).catch(err => {
                console.warn('[LID] Não foi possível persistir o par LID/PN observado:', err?.message || err);
            });
        }
    }

    // Consultar o repositório Signal para converter LID -> PN pode custar centenas de
    // milissegundos. No caminho normal do chatbot primeiro usamos apenas IDs já presentes
    // na própria mensagem/cache. A resolução completa fica para o fallback quando nenhum
    // ticket é encontrado ou quando o número real é necessário para cadastro/envio.
    if (lidsObservados.length && !pnsObservados.length) {
        const agoraCache = Date.now();
        const cacheEncontrado = lidsObservados
            .map(lid => ({ lid, cache: lidPnRuntimeCache.get(lid) }))
            .find(item => item.cache && (agoraCache - Number(item.cache.salvoEm || 0)) < LID_PN_RUNTIME_CACHE_TTL_MS);

        if (cacheEncontrado?.cache?.pnJid) {
            adicionarJid(cacheEncontrado.cache.pnJid);
        } else if (resolverLid) {
            const mapeamentoLid = await resolverPnDeLids([...jids]);
            if (mapeamentoLid?.pnJid) adicionarJid(mapeamentoLid.pnJid);
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
        filtros.push({ whatsapp: { $in: contato.whatsappNumbers } });
    }

    if (!filtros.length) return null;

    const cliente = await clientsColl.findOne({
        $and: [
            { $or: filtros },
            { ativo: { $ne: false } }
        ]
    });

    // No cadastro manual o WhatsApp é o vínculo principal. Nome e CPF podem ficar
    // em branco e ser completados depois pelo advogado no painel.
    return cliente || null;
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

async function mensagemRecepcao(cliente, ticketNumber, mensagemCliente = '') {
    const menuTexto = await gerarMenuTexto();
    const saudacao = saudacaoContextualDaMensagem(mensagemCliente);

    if (cliente) {
        const nomeSaudacao = primeiroNome(cliente.nome || cliente.nomeCompleto || '');
        return `${saudacao}${nomeSaudacao ? `, ${nomeSaudacao}` : ''}! Que bom falar com você novamente. 👋

Abrimos o ticket *${ticketNumber}* para este atendimento.

Para direcionarmos corretamente, escolha uma das opções abaixo e envie apenas o número:

${menuTexto}`;
    }

    return `${saudacao}! Seja bem-vindo à *Azevedo & Juvencio Advogados*. 👋

Abrimos o ticket *${ticketNumber}* para acompanhar seu atendimento.

Para começarmos, escolha uma das opções abaixo e envie apenas o número:

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
                clienteCadastrado: ticket.clienteCadastrado === true || !!ticket.clienteId,
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
        { $set: { ticketNumber, ...campos, updatedAt: Date.now() } },
        { upsert: true }
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

async function criarNovoTicket({ contato, rawJid, textoInicial, cliente = null, paused = false, notificarPainel = false }) {
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
        aguardandoWhatsappCadastro: false,
        nomeCadastroTemp: null,
        cpfCadastroTemp: null,
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

    // O ticket ativo já está persistido e é suficiente para continuar o fluxo.
    // Histórico é uma escrita secundária e não deve segurar a primeira resposta ao cliente.
    registrarTicketHistorico(ticket).catch(err => {
        console.warn(`[Histórico] Não foi possível registrar imediatamente o ticket ${ticket.ticketNumber}:`, err?.message || err);
    });

    // Atualização em tempo real da Central de Atendimentos. Este evento é separado
    // das notificações visuais porque TODO atendimento criado deve aparecer na lista
    // lateral imediatamente, inclusive os iniciados pelo próprio escritório.
    io.emit('ticket_conversation_created', {
        ticketNumber: ticket.ticketNumber,
        clienteNome: ticket.clienteNome || null,
        clienteCadastrado: ticket.clienteCadastrado === true || !!ticket.clienteId,
        whatsapp: contato.numeroPrincipal || ticket.numeroReal || null,
        status: ticket.status || null,
        origem: ticket.origem || 'organico',
        createdAt: ticket.createdAt,
        lastActivity: ticket.lastActivity || ticket.createdAt,
        isActive: true,
        isArchived: false
    });

    // LEADS DE ANÚNCIO entram automaticamente no CRM no mesmo instante em que
    // o ticket é criado. A falha do CRM nunca impede a abertura do atendimento.
    // O resultado é reaproveitado pela notificação para abrir o lead diretamente.
    let resultadoCRMAutomatico = null;
    if (ticket.origem === 'lead_anuncio') {
        try {
            resultadoCRMAutomatico = await sincronizarLeadCRMDoTicket(ticket);
        } catch (err) {
            console.error(`[CRM] Ticket ${ticket.ticketNumber} foi criado, mas não foi possível sincronizar o lead automaticamente:`, err?.message || err);
        }
    }

    if (cliente) {
        clientsColl.updateOne(
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
        ).catch(err => {
            console.warn(`[Clientes] Falha ao atualizar vínculo do ticket ${ticketNumber}:`, err?.message || err);
        });
    }

    // Tickets iniciados pelo próprio escritório não geram alerta. Este parâmetro
    // só é ativado nas mensagens recebidas do cliente. Para leads de anúncio,
    // mostramos apenas "Novo lead" para evitar duas notificações do mesmo contato.
    if (notificarPainel) {
        const whatsapp = contato.numeroPrincipal || ticket.numeroReal || null;
        const nomeExibicao = ticket.clienteNome || cliente?.nomeCompleto || null;

        if (ticket.origem === 'lead_anuncio') {
            const lead = resultadoCRMAutomatico?.lead || null;
            emitirNotificacaoPainel({
                tipo: 'lead',
                titulo: 'Novo lead',
                mensagem: nomeExibicao
                    ? `${nomeExibicao} iniciou um atendimento vindo de anúncio.`
                    : `Novo contato de anúncio no ticket ${ticket.ticketNumber}.`,
                ticketNumber: ticket.ticketNumber,
                leadId: lead?._id ? String(lead._id) : null,
                crmNumber: lead?.crmNumber || null,
                whatsapp,
                createdAt: ticket.createdAt
            });
        } else {
            emitirNotificacaoPainel({
                tipo: 'ticket',
                titulo: 'Novo ticket',
                mensagem: nomeExibicao
                    ? `${nomeExibicao} iniciou o ticket ${ticket.ticketNumber}.`
                    : `Novo atendimento recebido no ticket ${ticket.ticketNumber}.`,
                ticketNumber: ticket.ticketNumber,
                whatsapp,
                createdAt: ticket.createdAt
            });
        }
    }

    return ticket;
}

async function encaminharParaEspecialista(ticket, jid, mensagem = null, { mensagemCliente = '', tipo = 'encaminhamento_especialista' } = {}) {
    const tresDiasEmMs = 3 * 24 * 60 * 60 * 1000;
    const agora = Date.now();

    // REGRA DE CONSISTÊNCIA: o estado que receberá a PRÓXIMA mensagem do cliente
    // precisa ser persistido ANTES de enviarmos qualquer texto ao WhatsApp. Se o
    // cliente responder muito rápido, a resposta não pode cair no passo anterior.
    await ticketsColl.updateOne(
        { _id: ticket._id },
        {
            $set: {
                status: 'aguardando_especialista',
                aguardandoPerguntaFluxo: false,
                aguardandoAnexoPerguntaFluxo: false,
                perguntaAguardandoAnexoId: null,
                respostaAguardandoAnexo: null,
                aguardandoDetalhesForaHorario: false,
                aguardandoCadastroCliente: false,
                aguardandoNomeCadastro: false,
                aguardandoCPFCadastro: false,
                aguardandoWhatsappCadastro: false,
                paused: true,
                until: agora + tresDiasEmMs,
                lastActivity: agora
            }
        }
    );

    ticket.status = 'aguardando_especialista';
    ticket.paused = true;
    ticket.until = agora + tresDiasEmMs;
    ticket.aguardandoPerguntaFluxo = false;
    ticket.aguardandoAnexoPerguntaFluxo = false;
    ticket.perguntaAguardandoAnexoId = null;
    ticket.respostaAguardandoAnexo = null;
    ticket.aguardandoDetalhesForaHorario = false;
    ticket.aguardandoCadastroCliente = false;
    ticket.aguardandoNomeCadastro = false;
    ticket.aguardandoCPFCadastro = false;
    ticket.aguardandoWhatsappCadastro = false;

    atualizarHistorico(ticket.ticketNumber, {
        status: 'aguardando_especialista'
    }).catch(err => console.warn('[Histórico] Falha ao registrar encaminhamento:', err?.message || err));

    if (mensagem) {
        const mensagemHumanizada = await gerarRespostaHumanizadaIA({
            tipo,
            mensagemCliente,
            ticket,
            mensagemBase: mensagem
        });
        await sendBotMsg(jid, { text: mensagemHumanizada });
    }
}

async function concluirTriagemEAvancar(ticket, jid, mensagemCliente = '') {
    const agora = Date.now();

    await ticketsColl.updateOne(
        { _id: ticket._id },
        {
            $set: {
                aguardandoPerguntaFluxo: false,
                aguardandoAnexoPerguntaFluxo: false,
                perguntaAguardandoAnexoId: null,
                respostaAguardandoAnexo: null,
                indicePerguntaFluxo: Array.isArray(ticket.perguntasFluxo) ? ticket.perguntasFluxo.length : 0,
                status: ticket.clienteCadastrado ? 'aguardando_especialista' : 'aguardando_cadastro',
                aguardandoCadastroCliente: !ticket.clienteCadastrado,
                lastActivity: agora
            }
        }
    );

    ticket.aguardandoPerguntaFluxo = false;
    ticket.aguardandoAnexoPerguntaFluxo = false;
    ticket.perguntaAguardandoAnexoId = null;
    ticket.respostaAguardandoAnexo = null;
    ticket.aguardandoCadastroCliente = !ticket.clienteCadastrado;

    if (ticket.clienteCadastrado) {
        await encaminharParaEspecialista(
            ticket,
            jid,
            `Tudo certo. Registrei essas informações no ticket *${ticket.ticketNumber}*. Seu atendimento continua por aqui.`,
            { mensagemCliente, tipo: 'triagem_concluida_cliente_cadastrado' }
        );
        return;
    }

    const confirmacaoTriagem = await gerarRespostaHumanizadaIA({
        tipo: 'triagem_concluida_antes_cadastro',
        mensagemCliente,
        ticket,
        mensagemBase: `Obrigado. Já deixei essas informações registradas no ticket *${ticket.ticketNumber}*.`
    });

    await sendBotMsg(jid, {
        text: `${confirmacaoTriagem}

${PERGUNTA_CADASTRO_CLIENTE}`
    });

    atualizarHistorico(ticket.ticketNumber, {
        status: 'aguardando_cadastro',
        triagemConcluidaEm: agora
    }).catch(err => console.warn('[Histórico] Falha ao registrar conclusão da triagem:', err?.message || err));
}

async function salvarCadastroCliente(ticket, contato, rawJid, nomeInfo, cpfLimpo, numeroInformado = null) {
    const agora = Date.now();
    const identidade = await resolverNumeroWhatsAppCadastro(ticket, contato, rawJid, numeroInformado);
    const numeroPrincipal = identidade.numeroPrincipal;

    if (!numeroPrincipal) {
        // Não cria um cadastro incompleto. O chamador deverá solicitar a confirmação
        // do telefone ao cliente e chamar esta função novamente.
        return { salvo: false, numeroPrincipal: null };
    }

    const camposCliente = {
        cpf: cpfLimpo,
        nome: nomeInfo.nome,
        sobrenome: nomeInfo.sobrenome,
        nomeCompleto: nomeInfo.nomeCompleto,
        numeroReal: numeroPrincipal,
        whatsapp: numeroPrincipal,
        lastRawJid: rawJid,
        updatedAt: agora,
        lastSeenAt: agora
    };

    await clientsColl.updateOne(
        { _id: cpfLimpo },
        {
            $set: camposCliente,
            $setOnInsert: { createdAt: agora },
            $addToSet: {
                identificadores: { $each: identidade.identificadoresMesclados },
                whatsappNumbers: { $each: identidade.numerosMesclados },
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
                numeroReal: numeroPrincipal,
                nomeCadastroTemp: null,
                cpfCadastroTemp: null,
                aguardandoCadastroCliente: false,
                aguardandoNomeCadastro: false,
                aguardandoCPFCadastro: false,
                aguardandoWhatsappCadastro: false,
                lastActivity: agora
            },
            $addToSet: {
                identificadores: { $each: identidade.identificadoresMesclados },
                whatsappNumbers: { $each: identidade.numerosMesclados }
            }
        }
    );

    await atualizarHistorico(ticket.ticketNumber, {
        clienteId: cpfLimpo,
        cpf: cpfLimpo,
        clienteNome: nomeInfo.nomeCompleto,
        numeroReal: numeroPrincipal,
        whatsappNumbers: identidade.numerosMesclados,
        identificadores: identidade.identificadoresMesclados,
        cadastroRealizado: true
    });

    console.log(`[Cadastro] Cliente ${cpfLimpo} salvo com WhatsApp ${numeroPrincipal}.`);
    return { salvo: true, numeroPrincipal };
}

async function adquirirLeaseBaileys() {
    if (!waRuntimeLocksColl) return false;
    const agora = new Date();
    const expiraEm = new Date(agora.getTime() + BAILEYS_LEASE_TTL_MS);

    try {
        const resultado = await waRuntimeLocksColl.findOneAndUpdate(
            {
                _id: BAILEYS_LEASE_ID,
                $or: [
                    { ownerId: BAILEYS_INSTANCE_ID },
                    { expiresAt: { $lte: agora } },
                    { expiresAt: { $exists: false } }
                ]
            },
            {
                $set: {
                    ownerId: BAILEYS_INSTANCE_ID,
                    expiresAt: expiraEm,
                    updatedAt: agora
                },
                $setOnInsert: { createdAt: agora }
            },
            { upsert: true, returnDocument: 'after' }
        );
        const doc = resultado?.value || resultado;
        return String(doc?.ownerId || '') === BAILEYS_INSTANCE_ID;
    } catch (err) {
        // Quando outro processo possui o lock, o upsert pode colidir com o _id.
        if (err?.code === 11000) return false;
        console.warn('[WhatsApp] Falha ao adquirir lease da sessão:', err?.message || err);
        return false;
    }
}

function iniciarRenovacaoLeaseBaileys() {
    if (baileysLeaseRenewTimer) clearInterval(baileysLeaseRenewTimer);
    baileysLeaseRenewTimer = setInterval(async () => {
        if (!waRuntimeLocksColl) return;
        try {
            const agora = new Date();
            const resultado = await waRuntimeLocksColl.updateOne(
                { _id: BAILEYS_LEASE_ID, ownerId: BAILEYS_INSTANCE_ID },
                { $set: { expiresAt: new Date(agora.getTime() + BAILEYS_LEASE_TTL_MS), updatedAt: agora } }
            );
            if (!resultado.matchedCount) {
                console.error('[WhatsApp] Lease da sessão foi perdido. Encerrando socket para evitar duas instâncias criptografando simultaneamente.');
                try { sock?.ws?.close?.(); } catch (_) {}
            }
        } catch (err) {
            console.warn('[WhatsApp] Não foi possível renovar lease da sessão:', err?.message || err);
        }
    }, BAILEYS_LEASE_RENEW_MS);
    baileysLeaseRenewTimer.unref?.();
}

async function liberarLeaseBaileys() {
    if (baileysLeaseRenewTimer) {
        clearInterval(baileysLeaseRenewTimer);
        baileysLeaseRenewTimer = null;
    }
    if (!waRuntimeLocksColl) return;
    try {
        await waRuntimeLocksColl.deleteOne({ _id: BAILEYS_LEASE_ID, ownerId: BAILEYS_INSTANCE_ID });
    } catch (_) {}
}

function agendarReconexaoWhatsapp(atraso = BAILEYS_RECONNECT_DELAY_MS) {
    if (baileysReconnectTimer) return;
    baileysReconnectTimer = setTimeout(() => {
        baileysReconnectTimer = null;
        startBot().catch(err => console.error('[WhatsApp] Falha na reconexão supervisionada:', err));
    }, Math.max(500, Number(atraso) || BAILEYS_RECONNECT_DELAY_MS));
    baileysReconnectTimer.unref?.();
}

async function startBot() {
    if (baileysStartPromise) return baileysStartPromise;
    baileysStartPromise = startBotInterno().finally(() => {
        baileysStartPromise = null;
    });
    return baileysStartPromise;
}

async function startBotInterno() {
    try {
        await client.connect();
        const db = client.db('bot_whatsapp');
        authColl = db.collection('auth_session');
        ticketsColl = db.collection('active_tickets');
        knowledgeColl = db.collection('knowledge_base');
        knowledgeGapsColl = db.collection('knowledge_gaps');
        knowledgeWebSourcesColl = db.collection('knowledge_web_sources');
        knowledgeWebPagesColl = db.collection('knowledge_web_pages');
        userLoginColl = db.collection('user_login');
        clientsColl = db.collection('client_registry');
        ticketHistoryColl = db.collection('ticket_history');
        countersColl = db.collection('counters');
        menuOptionsColl = db.collection('menu_options');
        settingsColl = db.collection('settings');
        crmLeadsColl = db.collection('crm_leads');
        ticketMessagesColl = db.collection('ticket_messages');
        baileysSentMessagesColl = db.collection('baileys_sent_messages');
        waRuntimeLocksColl = db.collection('wa_runtime_locks');

        const possuiLease = await adquirirLeaseBaileys();
        if (!possuiLease) {
            console.warn('[WhatsApp] Outra instância está usando a sessão. Este processo aguardará o lease expirar para conectar com segurança.');
            agendarReconexaoWhatsapp(5000);
            return;
        }
        iniciarRenovacaoLeaseBaileys();

        // Cria as opções atuais e o horário padrão somente se ainda não existirem.
        await garantirMenuPadrao();
        await garantirHorarioFuncionamentoPadrao();
        await garantirParametrosAdministrativos();

        // Início persistente do recurso de mensagens não lidas. Mantém a mesma data
        // entre reinicializações e evita marcar todo o histórico antigo como novo.
        const agoraUnreadTracking = Date.now();
        await settingsColl.updateOne(
            { _id: 'chat_unread_tracking' },
            { $setOnInsert: { startedAt: agoraUnreadTracking, createdAt: agoraUnreadTracking } },
            { upsert: true }
        );
        const unreadTrackingConfig = await settingsColl.findOne({ _id: 'chat_unread_tracking' });
        chatUnreadTrackingStartedAt = Number(unreadTrackingConfig?.startedAt || agoraUnreadTracking) || agoraUnreadTracking;

        // Contas antigas não possuíam papel/permissões. Para preservar o acesso do
        // administrador existente, elas são tratadas como admin na primeira atualização.
        await userLoginColl.updateMany(
            { role: { $exists: false } },
            { $set: { role: 'admin', ativo: true, updatedAt: Date.now() } }
        );
        const usuariosLegados = await userLoginColl.find(
            { $or: [{ userLower: { $exists: false } }, { nome: { $exists: false } }] },
            { projection: { _id: 1, user: 1, nome: 1, assinatura: 1 } }
        ).toArray();
        if (usuariosLegados.length) {
            await userLoginColl.bulkWrite(usuariosLegados.map(item => ({
                updateOne: {
                    filter: { _id: item._id },
                    update: { $set: {
                        userLower: normalizarUsuarioLogin(item.user),
                        nome: String(item.nome || item.user || 'Administrador').trim(),
                        assinatura: String(item.assinatura || assinaturaPadraoUsuario(item.nome || item.user || 'Administrador')).trim()
                    } }
                }
            })), { ordered: false });
        }

        // Índices para manter CPF e número de ticket únicos e acelerar a identificação do cliente.
        await Promise.all([
            clientsColl.createIndex({ cpf: 1 }, { unique: true, sparse: true }),
            clientsColl.createIndex({ identificadores: 1 }),
            clientsColl.createIndex({ whatsappNumbers: 1 }),
            clientsColl.createIndex({ numeroReal: 1 }),
            clientsColl.createIndex({ advogadoResponsavel: 1 }),
            ticketHistoryColl.createIndex({ ticketNumber: 1 }, { unique: true }),
            ticketHistoryColl.createIndex({ identificadores: 1 }),
            ticketsColl.createIndex({ ticketNumber: 1 }, { unique: true, sparse: true }),
            // Estes campos são consultados em TODA mensagem recebida. Sem índices, o MongoDB
            // precisa varrer active_tickets e a resposta do chatbot cresce conforme o uso.
            ticketsColl.createIndex({ identificadores: 1 }),
            ticketsColl.createIndex({ whatsappNumbers: 1 }),
            ticketsColl.createIndex({ numeroReal: 1 }),
            ticketsColl.createIndex({ lastRawJid: 1 }),
            ticketsColl.createIndex({ status: 1, lastActivity: 1 }),
            ticketsColl.createIndex({ area: 1, lastActivity: 1 }),
            ticketsColl.createIndex({ advogadoResponsavelId: 1, status: 1, lastActivity: -1 }),
            ticketsColl.createIndex({ 'documentosIA.messageId': 1 }),
            ticketHistoryColl.createIndex({ 'documentosIA.messageId': 1 }),
            menuOptionsColl.createIndex({ ordem: 1 }),
            crmLeadsColl.createIndex({ crmNumber: 1 }, { unique: true, sparse: true }),
            crmLeadsColl.createIndex({ ticketNumber: 1 }, { unique: true, sparse: true }),
            crmLeadsColl.createIndex({ status: 1, dataProximaAcao: 1 }),
            crmLeadsColl.createIndex({ responsavel: 1, status: 1 }),
            crmLeadsColl.createIndex({ origemTipo: 1, status: 1 }),
            crmLeadsColl.createIndex({ origemTipo: 1, updatedAt: -1 }),
            crmLeadsColl.createIndex({ origemTecnica: 1, updatedAt: -1 }),
            crmLeadsColl.createIndex({ origem: 1, updatedAt: -1 }),
            crmLeadsColl.createIndex({ updatedAt: -1 }),
            userLoginColl.createIndex({ userLower: 1 }),
            userLoginColl.createIndex({ role: 1, ativo: 1 }),
            knowledgeColl.createIndex({ ativo: 1, prioridade: -1, updatedAt: -1 }),
            knowledgeGapsColl.createIndex({ chave: 1 }, { unique: true }),
            knowledgeGapsColl.createIndex({ resolvido: 1, ocorrencias: -1, lastSeenAt: -1 }),
            knowledgeWebSourcesColl.createIndex({ ativo: 1, updatedAt: -1 }),
            knowledgeWebSourcesColl.createIndex({ url: 1 }, { unique: true }),
            knowledgeWebPagesColl.createIndex({ sourceId: 1, url: 1 }, { unique: true }),
            knowledgeWebPagesColl.createIndex({ sourceId: 1, ativo: 1, fetchedAt: -1 }),
            ticketMessagesColl.createIndex({ ticketNumber: 1, createdAt: -1 }),
            ticketMessagesColl.createIndex({ ticketNumber: 1, direction: 1, createdAt: -1 }),
            ticketMessagesColl.createIndex({ ticketNumber: 1, messageId: 1 }, { unique: true }),
            baileysSentMessagesColl.createIndex({ expiresAt: 1 }, { expireAfterSeconds: 0 }),
            baileysSentMessagesColl.createIndex({ messageId: 1 })
        ]);

        // Migração automática da política antiga: versões anteriores criavam um TTL
        // de 60 dias em ticket_messages. Apenas retirar createIndex não basta, pois o
        // índice permanece no MongoDB; por isso removemos explicitamente o TTL legado.
        await removerPoliticasLegadasHistoricoChat();
        
        apiKeysColl = db.collection('api_keys');
        const geminiKeyDoc = await apiKeysColl.findOne({ nome: "gemini" });
        
        if (geminiKeyDoc && geminiKeyDoc.chave) {
            genAI = new GoogleGenerativeAI(geminiKeyDoc.chave);
            const geminiPrimaryModelName = normalizarNomeModeloGemini(process.env.GEMINI_PRIMARY_MODEL, 'gemini-3.5-flash-lite');
            geminiModel = genAI.getGenerativeModel(
                { model: geminiPrimaryModelName },
                { apiVersion: 'v1beta' }
            );
            console.log(`✅ Sistema Gemini pronto. Modelo principal: ${geminiPrimaryModelName}.`);
        }

        const { state, saveCreds } = await useMongoDBAuthState(authColl);
        const { version } = await fetchLatestBaileysVersion();

        const baileysLogger = P({ level: process.env.BAILEYS_LOG_LEVEL || 'warn' });
        const authStateSeguro = {
            creds: state.creds,
            keys: typeof makeCacheableSignalKeyStore === 'function'
                ? makeCacheableSignalKeyStore(state.keys, baileysLogger)
                : state.keys
        };

        const socketAtual = makeWASocket({
            version,
            auth: authStateSeguro,
            logger: baileysLogger,
            browser: ['Azevedo Advogados', 'Chrome', '1.0.0'],
            connectTimeoutMs: 60000,
            generateHighQualityLinkPreview: false,
            syncFullHistory: false,
            shouldSyncHistoryMessage: () => false,
            markOnlineOnConnect: false,
            defaultQueryTimeoutMs: 60 * 1000,
            retryRequestDelayMs: 350,
            maxMsgRetryCount: 5,
            msgRetryCounterCache: baileysMsgRetryCounterCache,
            enableAutoSessionRecreation: true,
            enableRecentMessageCache: true,
            getMessage: async (key) => obterMensagemEnviadaBaileys(key)
        });
        sock = socketAtual;

        socketAtual.ev.on('creds.update', saveCreds);

async function processarMensagemUpsert(msg, upsertType = 'notify') {
    if (!msg?.message || msg.key?.remoteJid === 'status@broadcast') return;
    if (!mensagemUpsertEhRecente(msg, upsertType)) return;

    const rawJid = msg.key?.remoteJid;
    if (!rawJid || rawJid.endsWith('@g.us') || rawJid.endsWith('@newsletter')) return;

    const msgId = String(msg.key?.id || '').trim();
    if (!msgId || !reservarMensagemParaProcessamento(msgId)) return;

    const inicioProcessamentoMensagem = Date.now();
    const isMe = !!msg.key?.fromMe;
    const conteudoEntrada = conteudoMensagemDesembrulhado(msg);
    const textoRaw =
        conteudoEntrada.conversation ||
        conteudoEntrada.extendedTextMessage?.text ||
        conteudoEntrada.imageMessage?.caption ||
        conteudoEntrada.videoMessage?.caption ||
        conteudoEntrada.documentMessage?.caption ||
        '';
    const texto = String(textoRaw || '').trim();
    const isMedia = !!extrairMidiaAnalisavel(msg);
    const chaveFila = chaveFilaContato(msg, rawJid);
    let liberarFilaContato = null;
    let fingerprintEntrada = null;

    try {
        // Mensagens técnicas/sem conteúdo útil não devem entrar no fluxo jurídico.
        if (!texto && !isMedia && !isMe) return;

        if (!isMe) {
            const reservaPayload = reservarPayloadEntrada(chaveFila, texto, isMedia, msgId);
            fingerprintEntrada = reservaPayload.fingerprint;
            if (reservaPayload.duplicado) {
                console.log(`[Fluxo] Cópia idêntica ignorada enquanto a primeira ainda está em processamento para ${chaveFila}.`);
                return;
            }

            // Não envia presença "composing" apenas porque uma mensagem entrou.
            // O BOT ativa o indicador somente dentro de sendBotMsg(), quando há resposta real.
        }

        liberarFilaContato = await adquirirLockContato(chaveFila);

        const timeoutNovoAtendimento = 2 * 60 * 60 * 1000;
        const tresDiasEmMs = 3 * 24 * 60 * 60 * 1000;

        const contato = await obterIdentificadoresContato(msg, rawJid, { resolverLid: false });
        if (!isMe) {
            const cacheAgora = Date.now();
            const candidatosCache = [
                rawJid,
                ...(Array.isArray(contato?.identificadores) ? contato.identificadores : []),
                ...(Array.isArray(contato?.whatsappNumbers) ? contato.whatsappNumbers.map(n => `${n}@s.whatsapp.net`) : [])
            ];
            for (const candidato of candidatosCache) {
                const jidCache = normalizarJid(candidato) || candidato;
                if (jidCache) baileysDeviceRefreshAt.set(String(jidCache), cacheAgora);
            }
        }
        let ticket = await buscarTicketAtivo(contato);

        // Fallback: somente quando o identificador rápido (normalmente @lid) não achou
        // ticket algum, fazemos a resolução LID -> telefone potencialmente mais lenta.
        // Em conversas já abertas esta chamada deixa de ocorrer a cada mensagem.
        if (!ticket && !contato.numeroPrincipal) {
            const mapeamentoLid = await resolverPnDeLids(contato.identificadores);
            if (mapeamentoLid?.numero) {
                contato.numeroPrincipal = mapeamentoLid.numero;
                contato.whatsappNumbers = [...new Set([...(contato.whatsappNumbers || []), mapeamentoLid.numero])];
                if (mapeamentoLid.pnJid) {
                    contato.identificadores = [...new Set([...(contato.identificadores || []), mapeamentoLid.pnJid])];
                    contato.jidPreferencial = mapeamentoLid.pnJid;
                }
                contato.chaveAtiva = mapeamentoLid.numero || contato.chaveAtiva;
                ticket = await buscarTicketAtivo(contato);
            }
        }

        // Tickets criados pelo fluxo antigo não possuem ticketNumber.
        // Em vez de tentar reaproveitar estados incompatíveis, iniciamos o novo fluxo limpo.
        if (ticket && !ticket.ticketNumber) {
            await ticketsColl.deleteOne({ _id: ticket._id });
            ticket = null;
        }

        // Mensagem enviada manualmente pelo escritório.
        if (isMe) {
            const jidMensagemNormalizado = normalizarJid(rawJid) || rawJid;
            if (
                botMessageIds.has(msgId) ||
                botPendingJids.has(jidMensagemNormalizado) ||
                panelMessageIds.has(msgId) ||
                panelPendingJids.has(jidMensagemNormalizado)
            ) return;

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
            await registrarMensagemManualWhatsAppChat(ticket, msg).catch(err => {
                console.warn('[Chat] Falha ao registrar mensagem manual do WhatsApp:', err?.message || err);
            });
            return;
        }

        // PRIORIDADE OPERACIONAL: pedidos claros de encerramento são tratados antes de
        // horário de funcionamento, triagem, cadastro, pausa do bot e qualquer chamada ao Gemini.
        // Isso evita que o cliente precise repetir "encerrar atendimento" várias vezes.
        if (texto && clienteQuerEncerrar(texto)) {
            if (ticket) {
                // Registra a última mensagem do cliente antes de remover o ticket ativo.
                await registrarMensagemClienteChat(ticket, msg).catch(err => {
                    console.warn('[Chat] Falha ao registrar mensagem de encerramento:', err?.message || err);
                });
                await encerrarTicketPorCliente(ticket, rawJid, texto);
            } else {
                // Não cria um novo ticket apenas porque o cliente repetiu um pedido de encerramento
                // depois de o atendimento anterior já ter sido fechado.
                await sendBotMsg(rawJid, {
                    text: 'Seu atendimento já está encerrado no momento. Se precisar de algo novo, é só enviar uma mensagem e iniciaremos um novo atendimento.'
                }).catch(err => console.warn('[Bot] Falha ao confirmar ausência de ticket ativo:', err?.message || err));
            }
            return;
        }

        // JANELA PÓS-ENCERRAMENTO: uma cortesia enviada logo após o fechamento
        // ("obrigado", "obg", "vlw", "ok", "brigado", inclusive pequenos erros)
        // pertence à conversa que acabou e NÃO deve abrir outro ticket.
        // Se houver conteúdo novo real, a mensagem segue normalmente e um novo atendimento é criado.
        if (!ticket && texto && !isMedia) {
            const analisePosEncerramento = analisarCortesiaPosEncerramento(texto);
            if (analisePosEncerramento.cortesia) {
                const historicoEncerrado = await buscarEncerramentoRecenteDoContato(contato);
                if (historicoEncerrado) {
                    const agoraPosEncerramento = Date.now();
                    const ultimaResposta = Number(historicoEncerrado.ultimaCortesiaPosEncerramentoRespondidaEm || 0);

                    // Guarda a interação no histórico do atendimento encerrado para auditoria,
                    // sem ressuscitar ticket e sem misturar com um atendimento novo.
                    await ticketHistoryColl.updateOne(
                        { _id: historicoEncerrado._id },
                        {
                            $set: {
                                ultimaCortesiaPosEncerramento: String(texto).slice(0, 500),
                                ultimaCortesiaPosEncerramentoEm: agoraPosEncerramento,
                                updatedAt: agoraPosEncerramento
                            }
                        }
                    ).catch(err => console.warn('[Pós-encerramento] Falha ao registrar cortesia:', err?.message || err));

                    // Evita uma sequência robótica de respostas se o cliente mandar "ok", "obg", "vlw" em seguida.
                    if (!ultimaResposta || (agoraPosEncerramento - ultimaResposta) >= POS_ENCERRAMENTO_SILENCIO_REPETICAO_MS) {
                        const enviada = await sendBotMsg(rawJid, {
                            text: respostaCortesiaPosEncerramento(historicoEncerrado, analisePosEncerramento)
                        }).catch(err => {
                            console.warn('[Pós-encerramento] Falha ao responder cortesia:', err?.message || err);
                            return false;
                        });
                        if (enviada) {
                            await ticketHistoryColl.updateOne(
                                { _id: historicoEncerrado._id },
                                { $set: { ultimaCortesiaPosEncerramentoRespondidaEm: agoraPosEncerramento, updatedAt: agoraPosEncerramento } }
                            ).catch(() => {});
                        }
                    }

                    console.log(`[Pós-encerramento] Cortesia absorvida sem novo ticket (${historicoEncerrado.ticketNumber || historicoEncerrado._id}): ${analisePosEncerramento.valorNormalizado}`);
                    return;
                }
            }
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

        // Registra a mensagem do cliente uma única vez quando já existe ticket.
        // Chamadas adicionais abaixo são seguras por causa do índice único messageId.
        if (ticket) {
            registrarMensagemClienteChat(ticket, msg).catch(err => {
                console.warn('[Chat] Falha ao registrar mensagem recebida:', err?.message || err);
            });
        }

        // Se já existe um ticket válido, qualquer PDF/imagem/áudio/vídeo/documento
        // recebido do cliente é analisado em paralelo pelo Gemini. A rotina é
        // idempotente pelo messageId e não altera o estado da triagem.
        let analiseArquivoDisparada = false;
        const dispararAnaliseArquivo = (ticketAtual) => {
            if (analiseArquivoDisparada || !ticketAtual) return;
            // Nunca analisa arquivo enviado pelo advogado/escritório.
            if (msg?.key?.fromMe || !extrairMidiaAnalisavel(msg)) return;
            analiseArquivoDisparada = true;
            iniciarAnaliseArquivoSemBloquearFluxo(ticketAtual, msg);
        };

        dispararAnaliseArquivo(ticket);

        const situacaoHorario = await verificarHorarioFuncionamento();
        const atendimentoHumanoJaAtivo = ticket?.status === 'em_atendimento_humano';
        const jaAguardandoEspecialista = ticket?.status === 'aguardando_especialista';
        const cadastroJaEmAndamento = !!(
            ticket?.aguardandoCadastroCliente ||
            ticket?.aguardandoNomeCadastro ||
            ticket?.aguardandoCPFCadastro ||
            ticket?.aguardandoWhatsappCadastro
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
                    paused: false,
                    notificarPainel: true
                });
            }

            registrarMensagemClienteChat(ticket, msg).catch(err => {
                console.warn('[Chat] Falha ao registrar primeira mensagem fora do horário:', err?.message || err);
            });
            dispararAnaliseArquivo(ticket);

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

        if (['ENCERRAR', 'CORTESIA', 'SEM_BASE', 'ATENDIMENTO_HUMANO'].includes(analiseIAPrevia?.acao)) {
            await responderInterrupcaoIA(ticket, rawJid, analiseIAPrevia, texto);
            return;
        }

        // Mesmo se um humano tiver intervido, respostas de cadastro em andamento continuam sendo processadas.
        const emFluxoCadastro = !!(
            ticket?.aguardandoCadastroCliente ||
            ticket?.aguardandoNomeCadastro ||
            ticket?.aguardandoCPFCadastro ||
            ticket?.aguardandoWhatsappCadastro
        );

        if (ticket?.paused && !emFluxoCadastro) {
            if (Date.now() < (ticket.until || 0)) {
                if (
                    ticket.status !== 'em_atendimento_humano' &&
                    analiseIAPrevia?.acao === 'RESPONDER_BASE'
                ) {
                    await responderInterrupcaoIA(ticket, rawJid, analiseIAPrevia, texto);
                    return;
                }

                // Enquanto aguarda a equipe, recebemos e registramos a mensagem normalmente,
                // mas não enviamos confirmação automática para o cliente.
                await confirmarMensagemAguardandoEspecialista(ticket, rawJid, texto);

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
                paused: false,
                notificarPainel: true
            });

            registrarMensagemClienteChat(ticket, msg).catch(err => {
                console.warn('[Chat] Falha ao registrar primeira mensagem do ticket:', err?.message || err);
            });
            dispararAnaliseArquivo(ticket);

            // Mesmo quando o primeiro contato já pede um humano, o ticket precisa passar
            // pelo fluxo de direcionamento. Registramos a intenção, mas não pulamos menu/triagem.
            const pedidoHumanoInicial = detectarPedidoAtendimentoHumano(texto);
            if (pedidoHumanoInicial.solicitado) {
                const agoraPedido = Date.now();
                await Promise.allSettled([
                    ticketsColl.updateOne(
                        { _id: ticket._id },
                        { $set: { solicitouAtendimentoHumanoEm: agoraPedido, pedidoAtendimentoUrgente: pedidoHumanoInicial.urgente === true, pedidoHumanoAguardandoConclusaoFluxo: true, lastActivity: agoraPedido } }
                    ),
                    atualizarHistorico(ticket.ticketNumber, {
                        solicitouAtendimentoHumanoEm: agoraPedido,
                        pedidoAtendimentoUrgente: pedidoHumanoInicial.urgente === true,
                        pedidoHumanoAguardandoConclusaoFluxo: true,
                        mensagemPedidoHumano: String(texto || '').trim().slice(0, 1200)
                    })
                ]);
            }

            const recepcaoBase = await mensagemRecepcao(cliente, ticket.ticketNumber, texto);
            const recepcaoTexto = pedidoHumanoInicial.solicitado
                ? `Entendi. Para direcionar você ao profissional adequado, preciso primeiro que siga o fluxo abaixo.\n\n${recepcaoBase}`
                : recepcaoBase;
            const recepcaoEnviada = await sendBotMsg(rawJid, { text: recepcaoTexto });

            // A recepção já contém a saudação do atendimento. Marcamos isso no ticket
            // para que nenhuma rotina posterior trate uma etapa do fluxo como nova abertura.
            if (recepcaoEnviada) {
                const agoraRecepcao = Date.now();
                await Promise.allSettled([
                    ticketsColl.updateOne(
                        { _id: ticket._id },
                        { $set: { saudacaoAutomaticaRespondidaEm: agoraRecepcao } }
                    ),
                    atualizarHistorico(ticket.ticketNumber, {
                        saudacaoAutomaticaRespondidaEm: agoraRecepcao
                    })
                ]);
                ticket.saudacaoAutomaticaRespondidaEm = agoraRecepcao;
            }

            console.log(`[Ticket ${ticket.ticketNumber}] Novo atendimento aberto${cliente ? ` para ${cliente.nome}` : ''}.`);
            return;
        }

        // Atualiza os identificadores observados no ticket ativo. Isso ajuda a ligar PN e LID do mesmo contato.
        // Metadados de identidade não fazem parte do caminho crítico da resposta.
        // Persistimos em paralelo; os updates de estado abaixo continuam sendo aguardados.
        ticketsColl.updateOne(
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
        ).catch(err => {
            console.warn('[Performance] Falha ao atualizar identificadores em segundo plano:', err?.message || err);
        });

        // Se a mensagem atual era uma dúvida respondível pela base, responde agora e mantém
        // exatamente o mesmo passo do fluxo para a próxima mensagem do cliente.
        if (analiseIAPrevia?.acao === 'RESPONDER_BASE') {
            await responderInterrupcaoIA(ticket, rawJid, analiseIAPrevia, texto);
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
                        aguardandoCadastroCliente: !ticket.clienteCadastrado,
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
                    `Certo. As informações ficaram registradas no ticket *${ticket.ticketNumber}*. Nossa equipe poderá consultá-las no próximo período de atendimento.`,
                    { mensagemCliente: texto, tipo: 'encaminhamento_fora_horario' }
                );
                return;
            }

            const confirmacaoForaHorario = await gerarRespostaHumanizadaIA({
                tipo: 'relato_fora_horario_recebido_antes_cadastro',
                mensagemCliente: texto,
                ticket,
                mensagemBase: `Certo. Deixei as informações do seu caso registradas no ticket *${ticket.ticketNumber}*.`
            });

            ticket.aguardandoCadastroCliente = true;
            await sendBotMsg(rawJid, {
                text: `${confirmacaoForaHorario}\n\n${PERGUNTA_CADASTRO_CLIENTE}`
            });

            atualizarHistorico(ticket.ticketNumber, {
                status: 'aguardando_cadastro',
                triagemForaHorarioConcluidaEm: agora
            }).catch(err => console.warn('[Histórico] Falha ao registrar triagem fora do horário:', err?.message || err));
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
                            aguardandoAnexoPerguntaFluxo: false,
                            perguntaAguardandoAnexoId: null,
                            respostaAguardandoAnexo: null,
                            perguntasFluxo,
                            indicePerguntaFluxo: 0,
                            respostasFluxo: [],
                            tentativasInvalidasPerguntaFluxo: 0,
                            lastActivity: agora
                        }
                    }
                );

                atualizarHistorico(ticket.ticketNumber, {
                    area,
                    menuOptionId: opcaoSelecionada._id,
                    menuOptionTitle: opcaoSelecionada.titulo,
                    menuOptionEmoji: opcaoSelecionada.emoji || '',
                    status: 'aguardando_pergunta_fluxo',
                    perguntasTriagem: perguntasFluxo.map(({ id, texto, respostasAceitas, exigirAnexoSeSim, ordem }) => ({
                        id,
                        texto,
                        respostasAceitas: respostasAceitas || [],
                        exigirAnexoSeSim: exigirAnexoSeSim === true,
                        ordem
                    })),
                    respostasTriagem: []
                }).catch(err => console.warn('[Histórico] Falha ao registrar seleção de menu:', err?.message || err));

                const primeiraPergunta = formatarPerguntaParaEnvio(perguntasFluxo[0]);
                await sendBotMsg(rawJid, {
                    text: respostaArea ? `${respostaArea}\n\n${primeiraPergunta}` : primeiraPergunta
                });
                return;
            }

            // Compatibilidade: opções antigas, sem perguntas configuradas. Primeiro
            // gravamos o estado que receberá a próxima resposta; só então enviamos o prompt.
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

            atualizarHistorico(ticket.ticketNumber, {
                area,
                menuOptionId: opcaoSelecionada._id,
                menuOptionTitle: opcaoSelecionada.titulo,
                menuOptionEmoji: opcaoSelecionada.emoji || '',
                status: 'aguardando_detalhes'
            }).catch(err => console.warn('[Histórico] Falha ao registrar etapa de detalhes:', err?.message || err));

            if (respostaArea) {
                await sendBotMsg(rawJid, { text: respostaArea });
            } else {
                await sendBotMsg(rawJid, {
                    text: `Conte brevemente o que aconteceu no seu caso. Pode responder por texto ou áudio.`
                });
            }
            return;
        }

        // 2) TRIAGEM SEQUENCIAL - uma pergunta por vez
        if (ticket.aguardandoPerguntaFluxo) {
            const perguntas = Array.isArray(ticket.perguntasFluxo) ? ticket.perguntasFluxo : [];
            const indiceAtual = Number.isInteger(ticket.indicePerguntaFluxo) ? ticket.indicePerguntaFluxo : 0;
            const perguntaAtual = perguntas[indiceAtual];

            // Proteção contra tickets inconsistentes.
            if (!perguntaAtual) {
                await concluirTriagemEAvancar(ticket, rawJid, texto);
                return;
            }

            const temImagem = !!conteudoEntrada.imageMessage;
            const temDocumento = !!conteudoEntrada.documentMessage;
            const temAnexoValido = temImagem || temDocumento;
            const exigeAnexoSeSim = perguntaExigeAnexoSeSim(perguntaAtual);
            const aguardandoAnexoDaPerguntaAtual = exigeAnexoSeSim &&
                ticket.aguardandoAnexoPerguntaFluxo === true &&
                String(ticket.perguntaAguardandoAnexoId || '') === String(perguntaAtual.id || '');

            if (!texto && !isMedia) {
                await sendBotMsg(rawJid, {
                    text: aguardandoAnexoDaPerguntaAtual
                        ? mensagemSolicitarAnexoPergunta(perguntaAtual)
                        : `Para continuar, responda à pergunta abaixo:\n\n${formatarPerguntaParaEnvio(perguntaAtual)}`
                });
                return;
            }

            let respostaTextoEfetiva = texto;
            let respostaVeioDeAnexoPendente = false;

            // Estado intermediário: o cliente já respondeu "Sim" e agora PRECISA
            // enviar imagem/documento. Áudio, vídeo ou novo texto não liberam a etapa,
            // exceto "Não", que significa que ele não possui o arquivo.
            if (aguardandoAnexoDaPerguntaAtual) {
                if (respostaEhNao(texto)) {
                    respostaTextoEfetiva = 'Não';
                } else if (temAnexoValido) {
                    respostaTextoEfetiva = String(ticket.respostaAguardandoAnexo || 'Sim').trim() || 'Sim';
                    respostaVeioDeAnexoPendente = true;
                } else {
                    await sendBotMsg(rawJid, { text: mensagemSolicitarAnexoPergunta(perguntaAtual) });
                    await ticketsColl.updateOne(
                        { _id: ticket._id },
                        { $set: { lastActivity: Date.now() } }
                    );
                    return;
                }
            } else if (exigeAnexoSeSim && temAnexoValido && !texto) {
                // O cliente pode pular a palavra "Sim" e já mandar o arquivo.
                respostaTextoEfetiva = 'Sim';
            }

            const tentativasInvalidasAtuais = Number.isInteger(ticket.tentativasInvalidasPerguntaFluxo)
                ? ticket.tentativasInvalidasPerguntaFluxo
                : 0;

            // Para perguntas do tipo Sim/Não com anexo, "Sim" e "Não" têm semântica
            // própria. Nas demais respostas, preservamos a validação exata já existente.
            let validacaoResposta;
            if (exigeAnexoSeSim && (respostaEhSim(respostaTextoEfetiva) || respostaEhNao(respostaTextoEfetiva))) {
                validacaoResposta = { valida: true };
            } else if (exigeAnexoSeSim && temAnexoValido && respostaVeioDeAnexoPendente) {
                validacaoResposta = { valida: true };
            } else {
                validacaoResposta = validarRespostaDaPergunta(
                    perguntaAtual,
                    respostaTextoEfetiva,
                    isMedia,
                    { mostrarOpcoes: false }
                );
            }

            if (!validacaoResposta.valida) {
                const novaTentativaInvalida = tentativasInvalidasAtuais + 1;
                const mostrarOpcoes = novaTentativaInvalida >= EXIBIR_OPCOES_APOS_TENTATIVAS_INVALIDAS;

                if (mostrarOpcoes) {
                    validacaoResposta = validarRespostaDaPergunta(
                        perguntaAtual,
                        respostaTextoEfetiva,
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

            // Regra solicitada: "Sim" SEM imagem/documento não conclui a pergunta.
            // Persistimos o estado antes de pedir o arquivo para suportar respostas rápidas.
            if (exigeAnexoSeSim && respostaEhSim(respostaTextoEfetiva) && !temAnexoValido && !respostaVeioDeAnexoPendente) {
                const agoraAguardandoAnexo = Date.now();
                await ticketsColl.updateOne(
                    { _id: ticket._id },
                    {
                        $set: {
                            aguardandoAnexoPerguntaFluxo: true,
                            perguntaAguardandoAnexoId: String(perguntaAtual.id || ''),
                            respostaAguardandoAnexo: String(respostaTextoEfetiva || 'Sim').trim() || 'Sim',
                            tentativasInvalidasPerguntaFluxo: 0,
                            lastActivity: agoraAguardandoAnexo
                        }
                    }
                );

                ticket.aguardandoAnexoPerguntaFluxo = true;
                ticket.perguntaAguardandoAnexoId = String(perguntaAtual.id || '');
                ticket.respostaAguardandoAnexo = String(respostaTextoEfetiva || 'Sim').trim() || 'Sim';
                ticket.tentativasInvalidasPerguntaFluxo = 0;

                await sendBotMsg(rawJid, { text: mensagemSolicitarAnexoPergunta(perguntaAtual) });
                return;
            }

            let tipoResposta = 'texto';
            if (conteudoEntrada.audioMessage) tipoResposta = 'audio';
            else if (conteudoEntrada.imageMessage) tipoResposta = 'imagem';
            else if (conteudoEntrada.videoMessage) tipoResposta = 'video';
            else if (conteudoEntrada.documentMessage) tipoResposta = 'documento';

            let respostaParaRegistro = respostaTextoEfetiva || `[${tipoResposta} recebido]`;
            if (exigeAnexoSeSim && temAnexoValido && respostaEhSim(respostaTextoEfetiva)) {
                respostaParaRegistro = `${respostaTextoEfetiva || 'Sim'} — [${tipoResposta} recebido]`;
            }

            const respostaRegistrada = {
                perguntaId: perguntaAtual.id,
                pergunta: perguntaAtual.texto,
                respostasAceitas: Array.isArray(perguntaAtual.respostasAceitas) ? perguntaAtual.respostasAceitas : [],
                exigirAnexoSeSim: exigeAnexoSeSim,
                resposta: respostaParaRegistro,
                tipo: tipoResposta,
                respondidaEm: Date.now()
            };

            const respostasAtualizadas = [
                ...(Array.isArray(ticket.respostasFluxo) ? ticket.respostasFluxo : []),
                respostaRegistrada
            ];
            const proximoIndice = indiceAtual + 1;
            const temProximaPergunta = proximoIndice < perguntas.length;

            const agoraEtapaTriagem = Date.now();
            const statusEtapaTriagem = temProximaPergunta
                ? 'aguardando_pergunta_fluxo'
                : (ticket.clienteCadastrado ? 'aguardando_especialista' : 'aguardando_cadastro');

            await ticketsColl.updateOne(
                { _id: ticket._id },
                {
                    $set: {
                        respostasFluxo: respostasAtualizadas,
                        indicePerguntaFluxo: proximoIndice,
                        aguardandoPerguntaFluxo: temProximaPergunta,
                        aguardandoAnexoPerguntaFluxo: false,
                        perguntaAguardandoAnexoId: null,
                        respostaAguardandoAnexo: null,
                        tentativasInvalidasPerguntaFluxo: 0,
                        status: statusEtapaTriagem,
                        lastActivity: agoraEtapaTriagem
                    }
                }
            );

            const triagemAtualizada = progressoTriagemTicket(
                { ...ticket, perguntasFluxo: perguntas, status: statusEtapaTriagem },
                respostasAtualizadas
            );
            io.emit('ticket_triage_updated', {
                ticketNumber: ticket.ticketNumber,
                triagem: triagemAtualizada,
                status: statusEtapaTriagem,
                lastActivity: agoraEtapaTriagem,
                perguntaAtual: temProximaPergunta ? String(perguntas[proximoIndice]?.texto || '') : null
            });

            atualizarHistorico(ticket.ticketNumber, {
                respostasTriagem: respostasAtualizadas,
                triagemPerguntaAtual: proximoIndice,
                triagemTotalPerguntas: perguntas.length,
                ...(temProximaPergunta ? {} : { triagemConcluidaEm: Date.now() })
            }).catch(err => console.warn('[Histórico] Falha ao registrar etapa da triagem:', err?.message || err));

            if (temProximaPergunta) {
                await sendBotMsg(rawJid, { text: formatarPerguntaParaEnvio(perguntas[proximoIndice]) });
                return;
            }

            ticket.respostasFluxo = respostasAtualizadas;
            ticket.indicePerguntaFluxo = proximoIndice;
            ticket.tentativasInvalidasPerguntaFluxo = 0;
            ticket.aguardandoPerguntaFluxo = false;
            ticket.aguardandoAnexoPerguntaFluxo = false;
            ticket.perguntaAguardandoAnexoId = null;
            ticket.respostaAguardandoAnexo = null;
            await concluirTriagemEAvancar(ticket, rawJid, respostaTextoEfetiva || texto);
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
                        aguardandoCadastroCliente: !ticket.clienteCadastrado,
                        status: ticket.clienteCadastrado ? 'aguardando_especialista' : 'aguardando_cadastro',
                        lastActivity: Date.now()
                    }
                }
            );

            if (ticket.clienteCadastrado) {
                await encaminharParaEspecialista(
                    ticket,
                    rawJid,
                    `Certo. Registrei seu relato no ticket *${ticket.ticketNumber}*. Seu atendimento continua por aqui.`,
                    { mensagemCliente: texto, tipo: 'relato_recebido_cliente_cadastrado' }
                );
                return;
            }

            const confirmacaoRelato = await gerarRespostaHumanizadaIA({
                tipo: 'relato_recebido_antes_cadastro',
                mensagemCliente: texto,
                ticket,
                mensagemBase: `Certo. Registrei seu relato no ticket *${ticket.ticketNumber}*.`
            });

            ticket.aguardandoCadastroCliente = true;
            await sendBotMsg(rawJid, {
                text: `${confirmacaoRelato}\n\n${PERGUNTA_CADASTRO_CLIENTE}`
            });

            atualizarHistorico(ticket.ticketNumber, {
                status: 'aguardando_cadastro'
            }).catch(err => console.warn('[Histórico] Falha ao registrar cadastro opcional:', err?.message || err));
            return;
        }

        // 3) CADASTRO OPCIONAL
        if (ticket.aguardandoCadastroCliente) {
            if (respostaNegativa(texto)) {
                await atualizarHistorico(ticket.ticketNumber, { cadastroRecusado: true });
                await encaminharParaEspecialista(
                    ticket,
                    rawJid,
                    `Sem problema. O cadastro é opcional e seu atendimento continua normalmente por aqui.`,
                    { mensagemCliente: texto, tipo: 'cadastro_opcional_recusado' }
                );
                return;
            }

            if (!respostaPositiva(texto)) {
                await sendBotMsg(rawJid, {
                    text: `Para eu seguir, escolha uma das opções abaixo:\n\n1️⃣ Sim\n2️⃣ Não`
                });
                return;
            }

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

            await sendBotMsg(rawJid, {
                text: `Certo. Para fazer o cadastro, me informe seu *nome e sobrenome*:`
            });
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

            await ticketsColl.updateOne(
                { _id: ticket._id },
                {
                    $set: {
                        nomeCadastroTemp: nomeInfo,
                        aguardandoNomeCadastro: false,
                        aguardandoCPFCadastro: true,
                        aguardandoWhatsappCadastro: false,
                        lastActivity: Date.now()
                    }
                }
            );

            await sendBotMsg(rawJid, {
                text: `Obrigado, ${nomeInfo.nome}. Agora digite seu *CPF* com 11 números:`
            });
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

                await sendBotMsg(rawJid, {
                    text: `Precisamos confirmar seu nome. Informe novamente seu *nome e sobrenome*:`
                });
                return;
            }

            // Primeiro tenta capturar o número automaticamente do próprio WhatsApp.
            const identidadeWhatsApp = await resolverNumeroWhatsAppCadastro(ticket, contato, rawJid);

            // O WhatsApp/Baileys pode entregar apenas um @lid, sem o PN real. Nesse
            // cenário não gravamos "-" nem um LID como telefone: pedimos confirmação.
            if (!identidadeWhatsApp.numeroPrincipal) {
                await ticketsColl.updateOne(
                    { _id: ticket._id },
                    {
                        $set: {
                            cpfCadastroTemp: cpfLimpo,
                            aguardandoCPFCadastro: false,
                            aguardandoWhatsappCadastro: true,
                            status: 'aguardando_whatsapp_cadastro',
                            lastActivity: Date.now()
                        }
                    }
                );

                await sendBotMsg(rawJid, {
                    text: `Para concluir o cadastro, confirme o *número deste WhatsApp com DDD*.\n\nExemplo: 19 99999-9999`
                });
                return;
            }

            const resultadoCadastro = await salvarCadastroCliente(
                ticket,
                contato,
                rawJid,
                nomeInfo,
                cpfLimpo,
                identidadeWhatsApp.numeroPrincipal
            );

            if (!resultadoCadastro.salvo) {
                throw new Error('Não foi possível identificar o WhatsApp para concluir o cadastro.');
            }

            const mensagemCadastroConcluido = await gerarRespostaHumanizadaIA({
                tipo: 'cadastro_concluido_e_encaminhamento',
                mensagemCliente: texto,
                ticket,
                nomeCliente: nomeInfo.nome,
                mensagemBase: `Cadastro concluído, ${nomeInfo.nome}. Nos próximos contatos, conseguiremos localizar seus dados automaticamente. Seu atendimento continua por aqui.`
            });

            ticket.clienteCadastrado = true;
            ticket.clienteNome = nomeInfo.nomeCompleto;
            ticket.cpf = cpfLimpo;
            ticket.numeroReal = resultadoCadastro.numeroPrincipal;

            await encaminharParaEspecialista(ticket, rawJid);
            await sendBotMsg(rawJid, { text: mensagemCadastroConcluido });
            return;
        }

        // 6) CONFIRMAÇÃO DO WHATSAPP - usada somente quando o Baileys não fornece o PN real
        if (ticket.aguardandoWhatsappCadastro) {
            const numeroInformado = normalizarNumeroDigitadoCliente(texto);
            if (!numeroInformado) {
                await sendBotMsg(rawJid, {
                    text: `Número inválido. Informe o *WhatsApp com DDD*. Exemplo: 19 99999-9999.`
                });
                return;
            }

            const cpfLimpo = String(ticket.cpfCadastroTemp || '').replace(/\D/g, '');
            const nomeInfo = ticket.nomeCadastroTemp;

            if (!validarCPF(cpfLimpo) || !nomeInfo?.nome || !nomeInfo?.sobrenome) {
                await ticketsColl.updateOne(
                    { _id: ticket._id },
                    {
                        $set: {
                            aguardandoNomeCadastro: true,
                            aguardandoCPFCadastro: false,
                            aguardandoWhatsappCadastro: false,
                            cpfCadastroTemp: null,
                            lastActivity: Date.now()
                        }
                    }
                );
                await sendBotMsg(rawJid, {
                    text: `Precisamos reiniciar a identificação do cadastro. Informe seu *nome e sobrenome*:`
                });
                return;
            }

            const resultadoCadastro = await salvarCadastroCliente(
                ticket,
                contato,
                rawJid,
                nomeInfo,
                cpfLimpo,
                numeroInformado
            );

            if (!resultadoCadastro.salvo) {
                await sendBotMsg(rawJid, {
                    text: `Não consegui registrar esse número. Informe novamente o *WhatsApp com DDD*.`
                });
                return;
            }

            const mensagemCadastroConcluido = await gerarRespostaHumanizadaIA({
                tipo: 'cadastro_concluido_e_encaminhamento',
                mensagemCliente: texto,
                ticket,
                nomeCliente: nomeInfo.nome,
                mensagemBase: `Cadastro concluído, ${nomeInfo.nome}. Nos próximos contatos, conseguiremos localizar seus dados automaticamente. Seu atendimento continua por aqui.`
            });

            ticket.clienteCadastrado = true;
            ticket.clienteNome = nomeInfo.nomeCompleto;
            ticket.cpf = cpfLimpo;
            ticket.numeroReal = resultadoCadastro.numeroPrincipal;

            await encaminharParaEspecialista(ticket, rawJid);
            await sendBotMsg(rawJid, { text: mensagemCadastroConcluido });
            return;
        }

        // Estado de segurança: se o ticket existir mas não estiver em nenhum passo válido,
        // mantém a conversa simples e não cria um segundo ticket por engano.
        console.warn(`[Ticket ${ticket.ticketNumber}] Estado não reconhecido. Reiniciando menu do mesmo ticket.`);
        const menuTextoSeguranca = await gerarMenuTexto();
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
                    aguardandoWhatsappCadastro: false,
                    lastActivity: Date.now()
                }
            }
        );
        await sendBotMsg(rawJid, {
            text: `Vamos continuar pelo ticket *${ticket.ticketNumber}*. Escolha uma opção:

${menuTextoSeguranca}`
        });
    } catch (err) {
        console.error('Erro interno no atendimento:', err);
    } finally {
        if (typeof liberarFilaContato === 'function') liberarFilaContato();
        liberarPayloadEntrada(fingerprintEntrada);
        concluirMensagemProcessada(msgId);

        const duracao = Date.now() - inicioProcessamentoMensagem;
        if (duracao >= 800) {
            console.warn(`[Performance] Mensagem ${msgId} de ${chaveFila} levou ${duracao}ms para ser processada.`);
        }
    }
}

// IMPORTANTE: messages.upsert pode trazer MAIS DE UMA mensagem no mesmo evento.
// A versão anterior lia apenas messages[0], então uma mensagem válida podia ser
// simplesmente descartada e o usuário só obtinha resposta quando digitava novamente.
socketAtual.ev.on('messages.upsert', (m = {}) => {
    const lote = Array.isArray(m.messages) ? m.messages : [];
    if (!lote.length) return;

    if (lote.length > 1) {
        console.log(`[WhatsApp] Upsert ${m.type || 'desconhecido'} recebido com ${lote.length} mensagens; processando todas.`);
    }

    Promise.allSettled(
        lote.map(msg => processarMensagemUpsert(msg, m.type || 'notify'))
    ).then(resultados => {
        for (const resultado of resultados) {
            if (resultado.status === 'rejected') {
                console.error('[WhatsApp] Falha não tratada ao processar mensagem do lote:', resultado.reason);
            }
        }
    });
});

        // Atualiza o cadastro quando o Baileys informar um novo mapeamento LID <-> número.
        // O fluxo principal não depende deste evento; ele é apenas uma camada extra de persistência.
        socketAtual.ev.on('lid-mapping.update', async ({ lid, pn }) => {
            try {
                const lidNormalizado = normalizarJid(lid);
                const pnNormalizado = normalizarJid(pn);
                const numero = numeroDePnJid(pnNormalizado);
                const ids = [lidNormalizado, pnNormalizado, numero].filter(Boolean);

                if (!lidNormalizado || !numero) return;
                const agora = Date.now();
                lidPnRuntimeCache.set(lidNormalizado, {
                    numero,
                    pnJid: pnNormalizado || `${numero}@s.whatsapp.net`,
                    salvoEm: agora
                });

                // Importante: o evento pode chegar ANTES de o usuário aceitar virar
                // cliente. Por isso atualizamos também ticket ativo e histórico, e não
                // apenas client_registry.
                if (ticketsColl) {
                    await ticketsColl.updateMany(
                        {
                            $or: [
                                { _id: lidNormalizado },
                                { lastRawJid: lidNormalizado },
                                { identificadores: lidNormalizado }
                            ]
                        },
                        {
                            $set: { numeroReal: numero, lastActivity: agora },
                            $addToSet: {
                                identificadores: { $each: ids },
                                whatsappNumbers: numero
                            }
                        }
                    );
                }

                if (ticketHistoryColl) {
                    await ticketHistoryColl.updateMany(
                        {
                            $or: [
                                { lastRawJid: lidNormalizado },
                                { identificadores: lidNormalizado }
                            ]
                        },
                        {
                            $set: { numeroReal: numero, updatedAt: agora },
                            $addToSet: {
                                identificadores: { $each: ids },
                                whatsappNumbers: numero
                            }
                        }
                    );
                }

                if (clientsColl) {
                    await clientsColl.updateMany(
                        {
                            $or: [
                                { lastRawJid: lidNormalizado },
                                { identificadores: lidNormalizado }
                            ]
                        },
                        {
                            $set: {
                                numeroReal: numero,
                                whatsapp: numero,
                                updatedAt: agora
                            },
                            $addToSet: {
                                identificadores: { $each: ids },
                                whatsappNumbers: numero
                            }
                        }
                    );
                }

                console.log(`[LID] Mapeamento persistido: ${lidNormalizado} -> ${numero}.`);
            } catch (err) {
                console.warn('[LID] Falha ao persistir mapeamento:', err?.message || err);
            }
        });
        socketAtual.ev.on('connection.update', async (update) => {
            const { connection, lastDisconnect, qr } = update;
            if (qr) { lastQr = qr; io.emit('qr', qr); }
            
            // Eventos de um socket antigo são ignorados. Isso é essencial: um
            // 'close' atrasado do socket anterior não pode criar outra conexão em paralelo.
            if (sock !== socketAtual) return;

            if (connection === 'open') {
                lastQr = null;
                whatsappConnectionOpenedAt = Date.now();
                const userNumber = socketAtual.user.id.split(':')[0];
                let ppUrl = null;
                try { ppUrl = await socketAtual.profilePictureUrl(socketAtual.user.id, 'image'); } catch (e) { ppUrl = null; }

                currentUser = { number: userNumber, name: 'Azevedo e Juvencio', pic: ppUrl };
                io.emit('connected', currentUser);
                console.log(`[WhatsApp] Socket único conectado pela instância ${BAILEYS_INSTANCE_ID}.`);
            }
                        
            if (connection === 'close') {
                whatsappConnectionOpenedAt = 0;
                const statusCode = (lastDisconnect?.error instanceof Boom)?.output?.statusCode;
                const shouldReconnect = statusCode !== DisconnectReason.loggedOut;
                if (shouldReconnect) {
                    agendarReconexaoWhatsapp();
                } else {
                    currentUser = null;
                    io.emit('disconnected');
                    await liberarLeaseBaileys();
                }
            }
        });

    } catch (err) { 
        console.error("Erro crítico:", err);
        agendarReconexaoWhatsapp(5000);
    }
}

async function useMongoDBAuthState(collection) {
    // Chaves Signal precisam estar realmente persistidas antes de keys.set() resolver.
    // A versão anterior disparava replaceOne/deleteOne sem await, abrindo condição
    // de corrida nas próprias chaves usadas para criptografar as mensagens.
    const enfileirarEscrita = (trabalho) => {
        const operacao = baileysAuthWriteQueue.then(trabalho, trabalho);
        baileysAuthWriteQueue = operacao.catch(() => {});
        return operacao;
    };

    const serializar = (data) => JSON.parse(JSON.stringify(data, BufferJSON.replacer));

    const writeData = async (data, id) => {
        await collection.replaceOne({ _id: id }, serializar(data), { upsert: true });
    };

    const removeData = async (id) => {
        await collection.deleteOne({ _id: id });
    };

    const readData = async (id) => {
        await baileysAuthWriteQueue.catch(() => {});
        const data = await collection.findOne({ _id: id });
        return data ? JSON.parse(JSON.stringify(data), BufferJSON.reviver) : null;
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
                set: async (data) => enfileirarEscrita(async () => {
                    const tarefas = [];
                    for (const type in data) {
                        for (const id in data[type]) {
                            const value = data[type][id];
                            tarefas.push(
                                value !== null && value !== undefined
                                    ? writeData(value, `${type}-${id}`)
                                    : removeData(`${type}-${id}`)
                            );
                        }
                    }
                    await Promise.all(tarefas);
                })
            }
        },
        saveCreds: () => enfileirarEscrita(() => writeData(creds, 'creds'))
    };
}

app.get('/login', (req, res) => {
    if (req.session?.loggedIn && req.session?.panelUser) return res.redirect('/');
    res.sendFile(path.join(__dirname, 'login.html'));
});

app.post('/login', async (req, res) => {
    const userInput = String(req.body?.user || '').trim();
    const pass = String(req.body?.pass || '');
    const userLower = normalizarUsuarioLogin(userInput);
    const querJson = req.xhr || String(req.headers.accept || '').includes('application/json') || String(req.headers['x-requested-with'] || '').toLowerCase() === 'xmlhttprequest';

    const responderErro = (status, erro, codigo) => {
        if (querJson) return res.status(status).json({ ok: false, erro, codigo });
        const mapa = { LOGIN_REQUIRED: 'required', LOGIN_INVALID: 'credentials', LOGIN_SESSION: 'session' };
        return res.redirect(`/login?error=${encodeURIComponent(mapa[codigo] || 'session')}`);
    };

    try {
        if (!userLower || !pass) {
            return responderErro(400, 'Informe usuário e senha.', 'LOGIN_REQUIRED');
        }

        const conta = await userLoginColl.findOne({
            $or: [{ user: userInput }, { userLower }]
        });

        // Mensagem deliberadamente genérica: não revela se o usuário existe ou está inativo.
        if (!conta || conta.ativo === false || !validarSenhaPainel(pass, conta)) {
            return responderErro(401, 'Usuário ou senha inválidos.', 'LOGIN_INVALID');
        }

        await migrarSenhaLegadaSeNecessario(conta, pass);
        const ultimoAcessoEm = Date.now();
        await userLoginColl.updateOne(
            { _id: conta._id },
            { $set: { lastAccessAt: ultimoAcessoEm } }
        );
        conta.lastAccessAt = ultimoAcessoEm;

        const painelUser = sessaoPublicaDaConta(conta);
        req.session.loggedIn = true;
        req.session.panelUser = painelUser;
        req.session.userId = painelUser.id;

        req.session.save(err => {
            if (err) {
                console.error('[Login] Falha ao persistir sessão:', err);
                return responderErro(500, 'Não foi possível iniciar sua sessão. Tente novamente.', 'LOGIN_SESSION');
            }
            if (querJson) return res.json({ ok: true, redirect: '/', user: painelUser });
            return res.redirect('/');
        });
    } catch (e) {
        console.error('[Login] Erro:', e);
        return responderErro(500, 'Não foi possível processar o acesso neste momento. Tente novamente.', 'LOGIN_SESSION');
    }
});

app.get('/', (req, res) => {
    if (!req.session?.loggedIn || !req.session?.panelUser) return res.redirect('/login');
    res.sendFile(path.join(__dirname, 'index.html'));
});

app.get('/logout-panel', (req, res) => {
    req.session.destroy(() => { res.redirect('/login'); });
});

app.get('/api/me', exigirLogin, (req, res) => {
    res.json({ user: req.session.panelUser });
});

// Perfil pessoal: o próprio usuário pode atualizar somente seus dados de apresentação.
// Função, permissões e status continuam exclusivos da gestão administrativa de usuários.
app.put('/api/me/profile', exigirLogin, async (req, res) => {
    try {
        const filtro = filtroUsuarioSessao(req);
        if (!filtro) return res.status(400).json({ erro: 'Usuário da sessão não identificado.' });
        const existente = await userLoginColl.findOne(filtro);
        if (!existente) return res.status(404).json({ erro: 'Usuário não encontrado.' });

        const nome = String(req.body?.nome ?? existente.nome ?? '').trim().slice(0, 180);
        if (nome.length < 3) return res.status(400).json({ erro: 'Informe seu nome completo.' });
        const assinaturaInformada = String(req.body?.assinatura ?? '').trim().slice(0, 180);
        const assinatura = assinaturaInformada || assinaturaPadraoUsuario(nome);
        const email = String(req.body?.email ?? '').trim().slice(0, 240);
        const oab = String(req.body?.oab ?? '').trim().slice(0, 80);
        const celularInformado = String(req.body?.celular ?? existente.celular ?? '').trim();
        const celular = normalizarCelularUsuario(celularInformado);
        if (celularInformado && !celular) return res.status(400).json({ erro: 'Informe um celular válido com DDD.' });
        const currentPassword = String(req.body?.currentPassword || '');
        const newPassword = String(req.body?.newPassword || '');

        const update = {
            $set: { nome, assinatura, email, oab, celular, updatedAt: Date.now() }
        };

        if (newPassword) {
            if (newPassword.length < 6) return res.status(400).json({ erro: 'A nova senha deve possuir ao menos 6 caracteres.' });
            if (!currentPassword) return res.status(400).json({ erro: 'Informe sua senha atual para definir uma nova senha.' });
            if (!validarSenhaPainel(currentPassword, existente)) return res.status(403).json({ erro: 'A senha atual informada não confere.' });
            const cred = hashSenhaPainel(newPassword);
            update.$set.passwordHash = cred.hash;
            update.$set.passwordSalt = cred.salt;
            update.$unset = { pass: '' };
        }

        await userLoginColl.updateOne({ _id: existente._id }, update);
        const salvo = await userLoginColl.findOne({ _id: existente._id }, { projection: { pass: 0, passwordHash: 0, passwordSalt: 0 } });
        req.session.panelUser = sessaoPublicaDaConta(salvo);
        io.emit('panel_users_updated', { action: 'profile_updated', id: String(existente._id) });
        return res.json({ ok: true, user: req.session.panelUser });
    } catch (err) {
        console.error('[Meu perfil] Erro ao atualizar:', err);
        return res.status(500).json({ erro: 'Não foi possível atualizar seu perfil.' });
    }
});

app.put('/api/me/preferences', exigirLogin, async (req, res) => {
    try {
        const filtro = filtroUsuarioSessao(req);
        if (!filtro) return res.status(400).json({ erro: 'Usuário da sessão não identificado.' });
        const theme = String(req.body?.theme || '').toLowerCase();
        if (!['light', 'dark'].includes(theme)) return res.status(400).json({ erro: 'Tema inválido.' });
        const resultado = await userLoginColl.findOneAndUpdate(
            filtro,
            { $set: { theme, updatedAt: Date.now() } },
            { returnDocument: 'after', projection: { pass: 0, passwordHash: 0, passwordSalt: 0 } }
        );
        const salvo = resultado?.value || resultado;
        if (!salvo?._id) return res.status(404).json({ erro: 'Usuário não encontrado.' });
        req.session.panelUser = sessaoPublicaDaConta(salvo);
        return res.json({ ok: true, user: req.session.panelUser });
    } catch (err) {
        console.error('[Preferências] Erro ao atualizar tema:', err);
        return res.status(500).json({ erro: 'Não foi possível salvar a preferência visual.' });
    }
});

// -----------------------------------------------------------------------------
// TEXTOS RÁPIDOS PESSOAIS
// -----------------------------------------------------------------------------
const QUICK_TEXT_MAX_ITEMS = 80;
const QUICK_TEXT_MAX_SHORTCUT = 32;
const QUICK_TEXT_MAX_TITLE = 90;
const QUICK_TEXT_MAX_BODY = 5000;

function normalizarAtalhoTextoRapido(valor = '') {
    return String(valor || '')
        .trim()
        .replace(/^\/+/, '')
        .toLowerCase()
        .replace(/[^a-z0-9_-]/g, '')
        .slice(0, QUICK_TEXT_MAX_SHORTCUT);
}

function normalizarTextoRapidoEntrada(body = {}) {
    const shortcut = normalizarAtalhoTextoRapido(body.shortcut);
    const titulo = String(body.title || '').trim().slice(0, QUICK_TEXT_MAX_TITLE);
    const texto = String(body.text || '').trim().slice(0, QUICK_TEXT_MAX_BODY);

    if (shortcut.length < 2) {
        const erro = new Error('O atalho deve possuir ao menos 2 caracteres. Exemplo: /daniel.');
        erro.status = 400;
        throw erro;
    }
    if (!texto) {
        const erro = new Error('Informe o texto que será inserido pelo atalho.');
        erro.status = 400;
        throw erro;
    }

    return { shortcut, title: titulo, text: texto };
}

function filtroUsuarioSessao(req) {
    const id = String(req?.session?.panelUser?.id || '').trim();
    if (ObjectId.isValid(id)) return { _id: new ObjectId(id) };
    const user = String(req?.session?.panelUser?.user || '').trim();
    return user ? { user } : null;
}

function serializarTextoRapido(item = {}) {
    return {
        id: String(item.id || item._id || ''),
        shortcut: String(item.shortcut || ''),
        title: String(item.title || ''),
        text: String(item.text || ''),
        createdAt: Number(item.createdAt || 0) || null,
        updatedAt: Number(item.updatedAt || 0) || null
    };
}

app.get('/api/me/quick-texts', exigirLogin, async (req, res) => {
    try {
        const filtro = filtroUsuarioSessao(req);
        if (!filtro) return res.status(400).json({ erro: 'Usuário da sessão não identificado.' });
        const conta = await userLoginColl.findOne(filtro, { projection: { quickTexts: 1 } });
        const items = Array.isArray(conta?.quickTexts) ? conta.quickTexts : [];
        return res.json({ items: items.map(serializarTextoRapido).sort((a, b) => a.shortcut.localeCompare(b.shortcut, 'pt-BR')) });
    } catch (err) {
        console.error('[Textos rápidos] Erro ao listar:', err);
        return res.status(500).json({ erro: 'Não foi possível carregar seus textos rápidos.' });
    }
});

app.post('/api/me/quick-texts', exigirLogin, async (req, res) => {
    try {
        const filtro = filtroUsuarioSessao(req);
        if (!filtro) return res.status(400).json({ erro: 'Usuário da sessão não identificado.' });
        const dados = normalizarTextoRapidoEntrada(req.body || {});
        const conta = await userLoginColl.findOne(filtro, { projection: { quickTexts: 1 } });
        const atuais = Array.isArray(conta?.quickTexts) ? conta.quickTexts : [];
        if (atuais.length >= QUICK_TEXT_MAX_ITEMS) return res.status(400).json({ erro: `Cada usuário pode cadastrar até ${QUICK_TEXT_MAX_ITEMS} textos rápidos.` });
        if (atuais.some(item => String(item.shortcut || '').toLowerCase() === dados.shortcut)) {
            return res.status(409).json({ erro: `O atalho /${dados.shortcut} já está cadastrado.` });
        }
        const agora = Date.now();
        const item = { id: new ObjectId().toString(), ...dados, createdAt: agora, updatedAt: agora };
        await userLoginColl.updateOne(filtro, { $push: { quickTexts: item }, $set: { updatedAt: agora } });
        return res.status(201).json({ item: serializarTextoRapido(item) });
    } catch (err) {
        console.error('[Textos rápidos] Erro ao criar:', err);
        return res.status(err?.status || 500).json({ erro: err?.message || 'Não foi possível cadastrar o texto rápido.' });
    }
});

app.put('/api/me/quick-texts/:id', exigirLogin, async (req, res) => {
    try {
        const filtro = filtroUsuarioSessao(req);
        if (!filtro) return res.status(400).json({ erro: 'Usuário da sessão não identificado.' });
        const id = String(req.params.id || '').trim();
        const dados = normalizarTextoRapidoEntrada(req.body || {});
        const conta = await userLoginColl.findOne(filtro, { projection: { quickTexts: 1 } });
        const atuais = Array.isArray(conta?.quickTexts) ? conta.quickTexts : [];
        const existente = atuais.find(item => String(item.id || '') === id);
        if (!existente) return res.status(404).json({ erro: 'Texto rápido não encontrado.' });
        if (atuais.some(item => String(item.id || '') !== id && String(item.shortcut || '').toLowerCase() === dados.shortcut)) {
            return res.status(409).json({ erro: `O atalho /${dados.shortcut} já está cadastrado.` });
        }
        const agora = Date.now();
        const atualizado = { ...existente, ...dados, updatedAt: agora };
        await userLoginColl.updateOne(
            { ...filtro, 'quickTexts.id': id },
            { $set: { 'quickTexts.$': atualizado, updatedAt: agora } }
        );
        return res.json({ item: serializarTextoRapido(atualizado) });
    } catch (err) {
        console.error('[Textos rápidos] Erro ao atualizar:', err);
        return res.status(err?.status || 500).json({ erro: err?.message || 'Não foi possível atualizar o texto rápido.' });
    }
});

app.delete('/api/me/quick-texts/:id', exigirLogin, async (req, res) => {
    try {
        const filtro = filtroUsuarioSessao(req);
        if (!filtro) return res.status(400).json({ erro: 'Usuário da sessão não identificado.' });
        const id = String(req.params.id || '').trim();
        const resultado = await userLoginColl.updateOne(filtro, { $pull: { quickTexts: { id } }, $set: { updatedAt: Date.now() } });
        if (!resultado.matchedCount) return res.status(404).json({ erro: 'Usuário não encontrado.' });
        return res.json({ ok: true });
    } catch (err) {
        console.error('[Textos rápidos] Erro ao excluir:', err);
        return res.status(500).json({ erro: 'Não foi possível excluir o texto rápido.' });
    }
});

// Lista pública interna de profissionais ativos para campos como "advogado responsável".
// Não expõe login, senha, e-mail ou permissões.
app.get('/api/lawyers', exigirLogin, async (req, res) => {
    try {
        const profissionais = await userLoginColl.find(
            { ativo: { $ne: false } },
            { projection: { nome: 1, assinatura: 1, role: 1, oab: 1 } }
        ).sort({ nome: 1 }).toArray();
        res.json({
            lawyers: profissionais.map(item => ({
                id: String(item._id),
                nome: String(item.nome || '').trim(),
                assinatura: String(item.assinatura || assinaturaPadraoUsuario(item.nome || '')).trim(),
                oab: String(item.oab || '').trim(),
                role: normalizarPapelUsuario(item.role)
            })).filter(item => item.nome)
        });
    } catch (err) {
        res.status(500).json({ erro: 'Não foi possível carregar a lista de profissionais.' });
    }
});

// Usuários ativos elegíveis para receber transferência de um atendimento.
// Endpoint separado da gestão de usuários: não expõe e-mail, login, OAB ou permissões.
app.get('/api/chat/users', exigirPermissao('chat'), async (req, res) => {
    try {
        const usuarios = await userLoginColl.find(
            { ativo: { $ne: false } },
            { projection: { nome: 1, assinatura: 1, role: 1, permissions: 1 } }
        ).sort({ nome: 1 }).toArray();

        const elegiveis = usuarios.filter(item => {
            const role = normalizarPapelUsuario(item.role);
            if (role === 'admin') return true;
            const permissoes = normalizarPermissoesUsuario(item);
            return permissoes.includes('chat');
        });

        res.json({
            users: elegiveis.map(item => ({
                id: String(item._id),
                nome: String(item.nome || '').trim(),
                assinatura: String(item.assinatura || assinaturaPadraoUsuario(item.nome || '')).trim(),
                role: normalizarPapelUsuario(item.role)
            })).filter(item => item.id && item.nome)
        });
    } catch (err) {
        console.error('[Chat] Erro ao listar usuários para transferência:', err);
        res.status(500).json({ erro: 'Não foi possível carregar os usuários disponíveis.' });
    }
});

// Proteção por módulo. O administrador ignora a lista de permissões; advogados
// comuns recebem por padrão apenas tickets, clientes e chat.
app.use('/api/admin/crm-params', exigirPermissao('crm_params'));
app.use('/api/admin/ticket-params', exigirPermissao('ticket_params'));
app.use('/api/business-hours', exigirPermissao('business_hours'));
app.use('/api/triage', exigirPermissao('menu'));
app.use('/api/menu-options', exigirPermissao('menu'));
app.use('/api/crm', exigirPermissao('crm'));
app.use('/api/clients', exigirPermissao('clients'));
app.use('/api/knowledgeColl', exigirPermissao('ia'));
app.use('/api/knowledgeWebSources', exigirPermissao('ia'));
app.use('/api/users', exigirPermissao('users'));
app.use('/api/tickets', exigirPermissao('tickets'));

app.get('/logout-whatsapp', exigirPermissao('whatsapp'), async (req, res) => {
    try {
        // Encerra primeiro no WhatsApp e só depois remove o estado criptográfico
        // do MongoDB. Assim um creds.update disparado pelo logout não recria uma
        // sessão parcial depois da limpeza.
        if (sock) {
            try { await sock.logout(); } catch (err) {
                console.warn('[WhatsApp] Logout remoto falhou; limpando sessão local:', err?.message || err);
            }
        }
        await authColl.deleteMany({});
        if (baileysSentMessagesColl) await baileysSentMessagesColl.deleteMany({});
        await liberarLeaseBaileys();
        outboundJidChains.clear();
        baileysMsgRetryCounterCache.flushAll();
        baileysSentMessageCache.clear();
        baileysDeviceRefreshAt.clear();
        lidPnRuntimeCache.clear();
        whatsappConnectionOpenedAt = 0;
        currentUser = null; lastQr = null;
        io.emit('disconnected');
        res.sendStatus(200);
    } catch (err) {
        console.error('[WhatsApp] Erro ao desconectar:', err);
        res.status(500).send("Erro");
    }
});


async function enviarBoasVindasNovoAdvogado(conta = {}) {
    const celular = normalizarCelularUsuario(conta.celular || '');
    if (normalizarPapelUsuario(conta.role) !== 'advogado') {
        return { enviado: false, motivo: 'perfil_nao_advogado' };
    }
    if (conta.ativo === false) return { enviado: false, motivo: 'usuario_inativo' };
    if (!celular) return { enviado: false, motivo: 'sem_celular' };
    if (!sock?.user) return { enviado: false, motivo: 'whatsapp_desconectado' };

    const pnJid = normalizarJid(`${celular}@s.whatsapp.net`) || `${celular}@s.whatsapp.net`;
    let jidDestino = pnJid;

    // Se a sessão já conhecer o LID deste número, preferimos o mesmo addressing mode
    // usado pelo WhatsApp Multi-Device. Caso contrário, o PN é um fallback válido.
    if (sock?.signalRepository?.lidMapping?.getLIDForPN) {
        try {
            const lid = normalizarJid(await sock.signalRepository.lidMapping.getLIDForPN(pnJid));
            if (lid?.endsWith('@lid')) jidDestino = lid;
        } catch (err) {
            console.warn(`[Usuários] Não foi possível resolver LID para boas-vindas de ${celular}:`, err?.message || err);
        }
    }

    const nomeExibicao = String(conta.assinatura || conta.nome || conta.user || 'novo usuário').trim();
    const login = String(conta.user || '').trim();
    const texto = `Olá, *${nomeExibicao}*! 👋

Seu acesso ao painel interno da *Azevedo & Juvêncio* foi criado com sucesso.${login ? `

Usuário: *${login}*` : ''}

Por segurança, sua senha não é enviada pelo WhatsApp. Utilize os dados fornecidos pelo administrador para realizar o acesso.

Seja bem-vindo(a) à equipe.`;

    try {
        const sent = await sendBotMsg(jidDestino, { text: texto });
        if (!sent?.key?.id) return { enviado: false, motivo: 'falha_envio' };
        return { enviado: true, motivo: null };
    } catch (err) {
        console.warn(`[Usuários] Falha ao enviar boas-vindas para ${celular}:`, err?.message || err);
        return { enviado: false, motivo: 'falha_envio' };
    }
}

// -----------------------------------------------------------------------------
// GESTÃO DE USUÁRIOS DO PAINEL - somente administradores
// -----------------------------------------------------------------------------
function normalizarDadosUsuarioPainel(body = {}, existente = null) {
    const user = normalizarUsuarioLogin(body.user ?? existente?.user ?? '');
    const nome = String(body.nome ?? existente?.nome ?? '').trim().slice(0, 180);
    const role = normalizarPapelUsuario(body.role ?? existente?.role ?? 'advogado');
    const permissions = role === 'admin'
        ? [...PERMISSOES_PAINEL]
        : [...new Set((Array.isArray(body.permissions) ? body.permissions : (existente?.permissions || PERMISSOES_ADVOGADO_PADRAO))
            .map(String).filter(item => PERMISSOES_PAINEL.includes(item)))];
    const assinatura = String(body.assinatura ?? existente?.assinatura ?? assinaturaPadraoUsuario(nome)).trim().slice(0, 180);
    return {
        user,
        userLower: user,
        nome,
        assinatura: assinatura || assinaturaPadraoUsuario(nome),
        email: String(body.email ?? existente?.email ?? '').trim().slice(0, 240),
        oab: String(body.oab ?? existente?.oab ?? '').trim().slice(0, 80),
        celular: normalizarCelularUsuario(body.celular ?? existente?.celular ?? ''),
        role,
        permissions,
        ativo: body.ativo !== undefined ? body.ativo !== false : existente?.ativo !== false
    };
}

app.get('/api/users', async (req, res) => {
    try {
        const usuarios = await userLoginColl.find({}, {
            projection: { pass: 0, passwordHash: 0, passwordSalt: 0 }
        }).sort({ updatedAt: -1, createdAt: -1, nome: 1, user: 1 }).toArray();
        res.json({
            usuarios: usuarios.map(item => ({ ...sessaoPublicaDaConta(item), ativo: item.ativo !== false, createdAt: item.createdAt || null, updatedAt: item.updatedAt || null, lastAccessAt: Number(item.lastAccessAt || 0) || null })),
            permissionsAvailable: PERMISSOES_PAINEL,
            defaultLawyerPermissions: PERMISSOES_ADVOGADO_PADRAO
        });
    } catch (err) {
        console.error('[Usuários] Erro ao listar:', err);
        res.status(500).json({ erro: 'Não foi possível carregar os usuários.' });
    }
});

app.post('/api/users', async (req, res) => {
    try {
        const dados = normalizarDadosUsuarioPainel(req.body || {});
        const senha = String(req.body?.password || '');
        const celularInformado = String(req.body?.celular || '').trim();
        if (celularInformado && !dados.celular) return res.status(400).json({ erro: 'Informe um celular válido com DDD.' });
        if (!dados.user || dados.user.length < 3) return res.status(400).json({ erro: 'O usuário deve possuir ao menos 3 caracteres.' });
        if (!dados.nome || dados.nome.length < 3) return res.status(400).json({ erro: 'Informe o nome do usuário.' });
        if (senha.length < 6) return res.status(400).json({ erro: 'A senha deve possuir ao menos 6 caracteres.' });
        const duplicado = await userLoginColl.findOne({ $or: [{ userLower: dados.userLower }, { user: dados.user }] });
        if (duplicado) return res.status(409).json({ erro: 'Este nome de usuário já está em uso.' });

        const cred = hashSenhaPainel(senha);
        const agora = Date.now();
        const documento = {
            ...dados,
            passwordHash: cred.hash,
            passwordSalt: cred.salt,
            createdAt: agora,
            updatedAt: agora,
            createdBy: usuarioDaSessao(req)?.id || null
        };
        const result = await userLoginColl.insertOne(documento);
        const salvo = { ...documento, _id: result.insertedId };
        delete salvo.passwordHash;
        delete salvo.passwordSalt;
        io.emit('panel_users_updated', { action: 'created', id: String(result.insertedId) });

        // O cadastro não depende do WhatsApp. A mensagem é uma cortesia pós-cadastro:
        // somente advogado ativo + celular válido + conexão disponível recebem boas-vindas.
        const boasVindas = await enviarBoasVindasNovoAdvogado(salvo);
        res.status(201).json({
            ok: true,
            user: { ...sessaoPublicaDaConta(salvo), ativo: salvo.ativo !== false },
            boasVindas
        });
    } catch (err) {
        console.error('[Usuários] Erro ao criar:', err);
        res.status(500).json({ erro: 'Não foi possível criar o usuário.' });
    }
});

app.put('/api/users/:id', async (req, res) => {
    try {
        let id;
        try { id = new ObjectId(req.params.id); } catch (_) { id = req.params.id; }
        const existente = await userLoginColl.findOne({ _id: id });
        if (!existente) return res.status(404).json({ erro: 'Usuário não encontrado.' });
        const dados = normalizarDadosUsuarioPainel(req.body || {}, existente);
        const celularInformado = String(req.body?.celular ?? existente.celular ?? '').trim();
        if (celularInformado && !dados.celular) return res.status(400).json({ erro: 'Informe um celular válido com DDD.' });
        if (!dados.user || dados.user.length < 3 || !dados.nome) return res.status(400).json({ erro: 'Usuário e nome são obrigatórios.' });

        const duplicado = await userLoginColl.findOne({
            _id: { $ne: existente._id },
            $or: [{ userLower: dados.userLower }, { user: dados.user }]
        });
        if (duplicado) return res.status(409).json({ erro: 'Este nome de usuário já está em uso.' });

        // Não permite retirar o último administrador ativo do sistema.
        if (normalizarPapelUsuario(existente.role) === 'admin' && existente.ativo !== false && (dados.role !== 'admin' || dados.ativo === false)) {
            const adminsAtivos = await userLoginColl.countDocuments({ role: 'admin', ativo: { $ne: false } });
            if (adminsAtivos <= 1) return res.status(409).json({ erro: 'É necessário manter ao menos um administrador ativo.' });
        }

        const update = { $set: { ...dados, updatedAt: Date.now() } };
        const senha = String(req.body?.password || '');
        if (senha) {
            if (senha.length < 6) return res.status(400).json({ erro: 'A nova senha deve possuir ao menos 6 caracteres.' });
            const cred = hashSenhaPainel(senha);
            update.$set.passwordHash = cred.hash;
            update.$set.passwordSalt = cred.salt;
            update.$unset = { pass: '' };
        }
        await userLoginColl.updateOne({ _id: existente._id }, update);
        const salvo = await userLoginColl.findOne({ _id: existente._id }, { projection: { pass: 0, passwordHash: 0, passwordSalt: 0 } });

        // Se o próprio usuário editou sua conta (admin), atualiza imediatamente a sessão.
        if (String(req.session.panelUser?.id || '') === String(existente._id)) {
            req.session.panelUser = sessaoPublicaDaConta(salvo);
        }
        io.emit('panel_users_updated', { action: 'updated', id: String(existente._id) });
        res.json({ ok: true, user: { ...sessaoPublicaDaConta(salvo), ativo: salvo.ativo !== false } });
    } catch (err) {
        console.error('[Usuários] Erro ao atualizar:', err);
        res.status(500).json({ erro: 'Não foi possível atualizar o usuário.' });
    }
});

app.delete('/api/users/:id', async (req, res) => {
    try {
        let id;
        try { id = new ObjectId(req.params.id); } catch (_) { id = req.params.id; }
        const existente = await userLoginColl.findOne({ _id: id });
        if (!existente) return res.status(404).json({ erro: 'Usuário não encontrado.' });
        if (String(req.session.panelUser?.id || '') === String(existente._id)) {
            return res.status(409).json({ erro: 'Você não pode excluir o usuário da sua própria sessão.' });
        }
        if (normalizarPapelUsuario(existente.role) === 'admin' && existente.ativo !== false) {
            const adminsAtivos = await userLoginColl.countDocuments({ role: 'admin', ativo: { $ne: false } });
            if (adminsAtivos <= 1) return res.status(409).json({ erro: 'É necessário manter ao menos um administrador ativo.' });
        }
        await userLoginColl.deleteOne({ _id: existente._id });
        io.emit('panel_users_updated', { action: 'deleted', id: String(existente._id) });
        res.json({ ok: true });
    } catch (err) {
        console.error('[Usuários] Erro ao excluir:', err);
        res.status(500).json({ erro: 'Não foi possível excluir o usuário.' });
    }
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
        cliente.whatsapp,
        cliente.whatsappNumbers,
        cliente.identificadores,
        cliente.lastRawJid
    );

    const cpf = String(cliente.cpf || '').replace(/\D/g, '');
    const clienteId = cliente._id !== null && cliente._id !== undefined ? String(cliente._id) : null;
    const ticketNumbers = Array.isArray(cliente.ticketNumbers) ? cliente.ticketNumbers.filter(Boolean) : [];
    const registrosAuxiliares = [];

    if (!numero && ticketsColl) {
        const filtros = [];
        if (clienteId) filtros.push({ clienteId });
        if (cpf) filtros.push({ cpf });
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
        if (clienteId) filtros.push({ clienteId });
        if (cpf) filtros.push({ cpf });
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
    if (numero && cliente?._id !== undefined && cliente?._id !== null && clientsColl) {
        const pnJid = `${numero}@s.whatsapp.net`;
        await clientsColl.updateOne(
            { _id: cliente._id },
            {
                $set: {
                    numeroReal: numero,
                    whatsapp: numero,
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

// -----------------------------------------------------------------------------
// CRM DE LEADS
// Baseado na planilha CRM_Azevedo_Juvencio.xlsx. O MongoDB é a fonte de verdade;
// os valores de receita são calculados no backend para manter o painel consistente.
// -----------------------------------------------------------------------------
const CRM_PARAMETROS_PADRAO = {
    status: [
        { id:'novo-lead', nome:'Novo lead', tipo:'aberto' },
        { id:'contato-feito', nome:'Contato feito', tipo:'aberto' },
        { id:'reuniao-agendada', nome:'Reunião agendada', tipo:'aberto' },
        { id:'reuniao-realizada', nome:'Reunião realizada', tipo:'aberto' },
        { id:'proposta-enviada', nome:'Proposta enviada', tipo:'proposta' },
        { id:'negociando', nome:'Negociando', tipo:'proposta' },
        { id:'contrato-assinado', nome:'Contrato assinado', tipo:'ganho' },
        { id:'em-andamento', nome:'Em andamento', tipo:'ganho' },
        { id:'aguardando-cliente', nome:'Aguardando cliente', tipo:'aberto' },
        { id:'encerrado-ganho', nome:'Encerrado - ganho', tipo:'ganho' },
        { id:'encerrado-perdido', nome:'Encerrado - perdido', tipo:'perdido' }
    ],
    modelosCobranca: [
        { id:'consulta', nome:'Consulta', calculo:'consulta' },
        { id:'fixo', nome:'Fixo', calculo:'fixo' },
        { id:'parcelado', nome:'Parcelado', calculo:'parcelado' },
        { id:'exito', nome:'Êxito', calculo:'exito' },
        { id:'misto', nome:'Misto', calculo:'misto' }
    ],
    motivosPerda: [
        { id:'sem-resposta', nome:'Sem resposta' },
        { id:'sem-orcamento', nome:'Sem orçamento' },
        { id:'fechou-com-outro', nome:'Fechou com outro' },
        { id:'nao-perfil', nome:'Não é o perfil do caso' },
        { id:'outro', nome:'Outro' }
    ],
    origensAnuncio: [
        { id:'meta-ads', nome:'Meta Ads' }, { id:'instagram-ads', nome:'Instagram Ads' },
        { id:'facebook-ads', nome:'Facebook Ads' }, { id:'google-ads', nome:'Google Ads' },
        { id:'tiktok-ads', nome:'TikTok Ads' }, { id:'youtube-ads', nome:'YouTube Ads' },
        { id:'linkedin-ads', nome:'LinkedIn Ads' }, { id:'outro-anuncio', nome:'Outro anúncio' }
    ]
};
const TICKET_PARAMETROS_PADRAO = { status: [] };
let crmParametrosCache = JSON.parse(JSON.stringify(CRM_PARAMETROS_PADRAO));
let ticketParametrosCache = JSON.parse(JSON.stringify(TICKET_PARAMETROS_PADRAO));

function slugParametro(valor='item') {
    const base=String(valor||'item').normalize('NFD').replace(/[\u0300-\u036f]/g,'').toLowerCase().replace(/[^a-z0-9]+/g,'-').replace(/^-+|-+$/g,'').slice(0,54)||'item';
    return `${base}-${crypto.randomBytes(3).toString('hex')}`;
}
function limparCorHex(valor, fallback='#667085') { const v=String(valor||'').trim(); return /^#[0-9a-f]{6}$/i.test(v)?v:fallback; }
function normalizarListaParametros(lista=[], tipo='simples') {
    const vistos=new Set();
    return (Array.isArray(lista)?lista:[]).map((item,indice)=>{
        const nome=String(item?.nome||item?.label||'').trim().slice(0,120); if(!nome)return null;
        let id=String(item?.id||'').trim().slice(0,80)||slugParametro(nome); if(vistos.has(id))id=slugParametro(nome); vistos.add(id);
        const base={id,nome,ordem:Number.isFinite(Number(item?.ordem))?Number(item.ordem):indice,ativo:item?.ativo!==false};
        if(tipo==='status-crm') base.tipo=['aberto','proposta','ganho','perdido'].includes(item?.tipo)?item.tipo:'aberto';
        if(tipo==='modelo') base.calculo=['consulta','fixo','parcelado','exito','misto','nenhum'].includes(item?.calculo)?item.calculo:'nenhum';
        if(tipo==='status-ticket') base.cor=limparCorHex(item?.cor,'#667085');
        return base;
    }).filter(Boolean).sort((a,b)=>a.ordem-b.ordem).map((x,i)=>({...x,ordem:i}));
}
function normalizarParametrosCRM(doc={}) { return {
    status:normalizarListaParametros(doc.status||CRM_PARAMETROS_PADRAO.status,'status-crm'),
    modelosCobranca:normalizarListaParametros(doc.modelosCobranca||CRM_PARAMETROS_PADRAO.modelosCobranca,'modelo'),
    motivosPerda:normalizarListaParametros(doc.motivosPerda||CRM_PARAMETROS_PADRAO.motivosPerda),
    origensAnuncio:normalizarListaParametros(doc.origensAnuncio||CRM_PARAMETROS_PADRAO.origensAnuncio)
}; }
function normalizarParametrosTickets(doc={}) { return { status:normalizarListaParametros(doc.status||[],'status-ticket') }; }
async function garantirParametrosAdministrativos() {
    if(!settingsColl)return;
    const agora=Date.now();
    await Promise.all([
        settingsColl.updateOne({_id:'crm_parameters'},{$setOnInsert:{...CRM_PARAMETROS_PADRAO,createdAt:agora},$set:{updatedAt:agora}},{upsert:true}),
        settingsColl.updateOne({_id:'ticket_parameters'},{$setOnInsert:{...TICKET_PARAMETROS_PADRAO,createdAt:agora},$set:{updatedAt:agora}},{upsert:true})
    ]);
    const [crm,tickets]=await Promise.all([settingsColl.findOne({_id:'crm_parameters'}),settingsColl.findOne({_id:'ticket_parameters'})]);
    crmParametrosCache=normalizarParametrosCRM(crm||{}); ticketParametrosCache=normalizarParametrosTickets(tickets||{});
}
function nomesCRM(chave){return (crmParametrosCache?.[chave]||[]).filter(x=>x.ativo!==false).map(x=>x.nome);}
function infoStatusCRM(nome){return (crmParametrosCache.status||[]).find(x=>x.nome===String(nome||''))||null;}
function statusCRMGanho(nome){return infoStatusCRM(nome)?.tipo==='ganho';}
function statusCRMPerdido(nome){return infoStatusCRM(nome)?.tipo==='perdido';}
function statusCRMFechado(nome){return ['ganho','perdido'].includes(infoStatusCRM(nome)?.tipo);}
function statusCRMProposta(nome){return infoStatusCRM(nome)?.tipo==='proposta';}
function nomeStatusCRMInicial(){return crmParametrosCache.status.find(x=>x.id==='novo-lead'&&x.ativo!==false)?.nome || nomesCRM('status')[0] || 'Novo lead';}
function origemPadraoCRM(){return crmParametrosCache.origensAnuncio.find(x=>x.id==='meta-ads'&&x.ativo!==false)?.nome || nomesCRM('origensAnuncio')[0] || 'Meta Ads';}
function calculoModeloCRM(nome){return (crmParametrosCache.modelosCobranca||[]).find(x=>x.nome===String(nome||''))?.calculo||'nenhum';}
function statusTicketPorId(id){return (ticketParametrosCache.status||[]).find(x=>x.id===String(id||'')&&x.ativo!==false)||null;}
function statusTicketsAtivos(){return (ticketParametrosCache.status||[]).filter(x=>x.ativo!==false).map(({id,nome,cor,ordem})=>({id,nome,cor,ordem}));}


function origemCRMDeAnuncioValida(origem = '') {
    return nomesCRM('origensAnuncio').includes(String(origem || '').trim());
}

function leadCRMDeAnuncio(lead = {}) {
    // Campos técnicos novos garantem a separação entre mídia paga e atendimento orgânico.
    // A checagem da origem textual mantém compatibilidade com leads de anúncio já criados
    // pela primeira versão do CRM, antes da inclusão de origemTipo/origemTecnica.
    if (lead?.origemTipo === 'anuncio' || lead?.origemTecnica === 'lead_anuncio') return true;
    return origemCRMDeAnuncioValida(lead?.origem);
}

function dataHojeCRM() {
    const partes = new Intl.DateTimeFormat('en-CA', {
        timeZone: BUSINESS_HOURS_TIMEZONE,
        year: 'numeric',
        month: '2-digit',
        day: '2-digit'
    }).formatToParts(new Date());
    const mapa = Object.fromEntries(partes.map(p => [p.type, p.value]));
    return `${mapa.year}-${mapa.month}-${mapa.day}`;
}

function dataTimestampParaCRM(valor) {
    const numero = Number(valor);
    if (!Number.isFinite(numero) || numero <= 0) return dataHojeCRM();
    const partes = new Intl.DateTimeFormat('en-CA', {
        timeZone: BUSINESS_HOURS_TIMEZONE,
        year: 'numeric',
        month: '2-digit',
        day: '2-digit'
    }).formatToParts(new Date(numero));
    const mapa = Object.fromEntries(partes.map(p => [p.type, p.value]));
    return `${mapa.year}-${mapa.month}-${mapa.day}`;
}

function dataCRMValida(valor) {
    const texto = String(valor || '').trim();
    return /^\d{4}-\d{2}-\d{2}$/.test(texto) ? texto : null;
}

function textoCRM(valor, max = 2000) {
    return String(valor ?? '').trim().slice(0, max);
}

function numeroCRM(valor, { inteiro = false, minimo = 0, maximo = Number.MAX_SAFE_INTEGER } = {}) {
    if (valor === '' || valor === null || valor === undefined) return null;
    const numero = Number(String(valor).replace(',', '.'));
    if (!Number.isFinite(numero)) return null;
    const ajustado = inteiro ? Math.trunc(numero) : numero;
    return Math.min(maximo, Math.max(minimo, ajustado));
}

function percentualExitoFormularioCRM(valor) {
    const numero = numeroCRM(valor, { minimo: 0, maximo: 100 });
    if (numero === null) return null;
    return numero / 100;
}

function valorPayloadCRM(body, campo, existente) {
    return Object.prototype.hasOwnProperty.call(body || {}, campo)
        ? body[campo]
        : existente?.[campo];
}

function calcularReceitaCRM(dados = {}) {
    const valorPotencial = Number(dados.valorPotencial || 0);
    const entrada = Number(dados.entrada || 0);
    const parcelasQtd = Number(dados.parcelasQtd || 0);
    const valorParcela = Number(dados.valorParcela || 0);
    const percentualExito = Number(dados.percentualExito || 0);
    const modelo = dados.modeloCobranca || '';
    const tipoCalculo = calculoModeloCRM(modelo);

    let receitaContratoPrevista = null;
    if (tipoCalculo === 'consulta') receitaContratoPrevista = entrada;
    else if (tipoCalculo === 'fixo') receitaContratoPrevista = valorPotencial;
    else if (tipoCalculo === 'parcelado' || tipoCalculo === 'misto') receitaContratoPrevista = entrada + (parcelasQtd * valorParcela);

    let exitoPrevisto = null;
    if (tipoCalculo === 'exito' || tipoCalculo === 'misto') exitoPrevisto = valorPotencial * percentualExito;

    const componentes = [receitaContratoPrevista, exitoPrevisto].filter(v => v !== null && Number.isFinite(v));
    const receitaTotalPrevista = componentes.length ? componentes.reduce((soma, valor) => soma + valor, 0) : null;

    return {
        receitaContratoPrevista,
        exitoPrevisto,
        receitaTotalPrevista
    };
}

function normalizarLeadCRM(body = {}, existente = {}) {
    const statusInicial=nomeStatusCRMInicial();
    const statusRecebido = textoCRM(body.status ?? existente.status ?? statusInicial, 80);
    const status = nomesCRM('status').includes(statusRecebido) ? statusRecebido : statusInicial;
    const modeloRecebido = textoCRM(body.modeloCobranca ?? existente.modeloCobranca ?? '', 80);
    const modeloCobranca = nomesCRM('modelosCobranca').includes(modeloRecebido) ? modeloRecebido : '';
    const percentualExito = Object.prototype.hasOwnProperty.call(body || {}, 'percentualExito')
        ? percentualExitoFormularioCRM(body.percentualExito)
        : (existente.percentualExito ?? null);

    const dados = {
        dataEntrada: dataCRMValida(body.dataEntrada) || existente.dataEntrada || dataHojeCRM(),
        origem: textoCRM(body.origem ?? existente.origem ?? '', 120),
        cliente: textoCRM(body.cliente ?? existente.cliente ?? '', 240),
        telefone: textoCRM(body.telefone ?? existente.telefone ?? '', 40),
        email: textoCRM(body.email ?? existente.email ?? '', 240),
        cidadeUf: textoCRM(body.cidadeUf ?? existente.cidadeUf ?? '', 160),
        area: textoCRM(body.area ?? existente.area ?? '', 160),
        assuntoResumo: textoCRM(body.assuntoResumo ?? existente.assuntoResumo ?? '', 6000),
        valorPotencial: numeroCRM(valorPayloadCRM(body, 'valorPotencial', existente), { minimo: 0, maximo: 1_000_000_000 }),
        modeloCobranca,
        entrada: numeroCRM(valorPayloadCRM(body, 'entrada', existente), { minimo: 0, maximo: 1_000_000_000 }),
        parcelasQtd: numeroCRM(valorPayloadCRM(body, 'parcelasQtd', existente), { inteiro: true, minimo: 0, maximo: 360 }),
        valorParcela: numeroCRM(valorPayloadCRM(body, 'valorParcela', existente), { minimo: 0, maximo: 1_000_000_000 }),
        percentualExito,
        status,
        proximaAcao: textoCRM(body.proximaAcao ?? existente.proximaAcao ?? '', 1000),
        dataProximaAcao: dataCRMValida(body.dataProximaAcao) || null,
        responsavel: textoCRM(body.responsavel ?? existente.responsavel ?? '', 120),
        pastaDrive: textoCRM(body.pastaDrive ?? existente.pastaDrive ?? '', 1000),
        observacoes: textoCRM(body.observacoes ?? existente.observacoes ?? '', 6000),
        dataFechamento: Object.prototype.hasOwnProperty.call(body || {}, 'dataFechamento')
            ? dataCRMValida(body.dataFechamento)
            : (existente.dataFechamento || null),
        motivoPerda: textoCRM(body.motivoPerda ?? existente.motivoPerda ?? '', 240)
    };

    if (!statusCRMPerdido(status)) dados.motivoPerda = '';
    if (statusCRMFechado(status) && !dados.dataFechamento) {
        dados.dataFechamento = dataHojeCRM();
    }

    return { ...dados, ...calcularReceitaCRM(dados) };
}

async function gerarNumeroCRM() {
    const resultado = await countersColl.findOneAndUpdate(
        { _id: 'crm_sequence' },
        { $inc: { seq: 1 }, $setOnInsert: { createdAt: Date.now() } },
        { upsert: true, returnDocument: 'after' }
    );
    const doc = resultado?.value || resultado;
    if (!doc?.seq) throw new Error('Não foi possível gerar a sequência do CRM.');
    return `CRM-${String(doc.seq).padStart(6, '0')}`;
}

function serializarLeadCRM(lead = {}) {
    return {
        id: lead._id ? String(lead._id) : null,
        crmNumber: lead.crmNumber || null,
        ticketNumber: lead.ticketNumber || null,
        dataEntrada: lead.dataEntrada || null,
        origem: lead.origem || '',
        origemTipo: lead.origemTipo || (leadCRMDeAnuncio(lead) ? 'anuncio' : ''),
        origemTecnica: lead.origemTecnica || '',
        cliente: lead.cliente || '',
        telefone: lead.telefone || '',
        email: lead.email || '',
        cidadeUf: lead.cidadeUf || '',
        area: lead.area || '',
        assuntoResumo: lead.assuntoResumo || '',
        valorPotencial: lead.valorPotencial ?? null,
        modeloCobranca: lead.modeloCobranca || '',
        entrada: lead.entrada ?? null,
        parcelasQtd: lead.parcelasQtd ?? null,
        valorParcela: lead.valorParcela ?? null,
        percentualExito: lead.percentualExito ?? null,
        status: lead.status || 'Novo lead',
        proximaAcao: lead.proximaAcao || '',
        dataProximaAcao: lead.dataProximaAcao || null,
        responsavel: lead.responsavel || '',
        pastaDrive: lead.pastaDrive || '',
        observacoes: lead.observacoes || '',
        dataFechamento: lead.dataFechamento || null,
        motivoPerda: lead.motivoPerda || '',
        receitaContratoPrevista: lead.receitaContratoPrevista ?? null,
        exitoPrevisto: lead.exitoPrevisto ?? null,
        receitaTotalPrevista: lead.receitaTotalPrevista ?? null,
        createdAt: lead.createdAt || null,
        updatedAt: lead.updatedAt || null
    };
}

function resumoCRM(leads = []) {
    const hoje = dataHojeCRM();
    const dataHoje = new Date(`${hoje}T12:00:00`);
    const seteDias = new Date(dataHoje);
    seteDias.setDate(seteDias.getDate() + 7);
    const seteDiasStr = `${seteDias.getFullYear()}-${String(seteDias.getMonth() + 1).padStart(2, '0')}-${String(seteDias.getDate()).padStart(2, '0')}`;
    const prefixoMes = hoje.slice(0, 7);

    const ganhos = leads.filter(lead => statusCRMGanho(lead.status));
    // Depois de contrato assinado o registro continua consultável no CRM, mas sai da
    // fila comercial de follow-up. Isso evita tratar cliente já convertido como lead atrasado.
    const abertos = leads.filter(lead => !statusCRMFechado(lead.status));
    const followupsAtrasados = abertos.filter(lead => lead.dataProximaAcao && lead.dataProximaAcao < hoje).length;
    const acoesHoje = abertos.filter(lead => lead.dataProximaAcao === hoje).length;
    const proximos7Dias = abertos.filter(lead => lead.dataProximaAcao && lead.dataProximaAcao > hoje && lead.dataProximaAcao <= seteDiasStr).length;
    const semProximaAcao = abertos.filter(lead => !lead.dataProximaAcao || !lead.proximaAcao).length;
    const propostasAbertas = abertos.filter(lead => statusCRMProposta(lead.status)).length;
    const contratosMes = ganhos.filter(lead => String(lead.dataFechamento || '').startsWith(prefixoMes)).length;
    const receitaFechada = ganhos.reduce((soma, lead) => soma + Number(lead.receitaTotalPrevista || 0), 0);
    const receitaAberta = leads
        .filter(lead => !statusCRMFechado(lead.status))
        .reduce((soma, lead) => soma + Number(lead.receitaTotalPrevista || 0), 0);

    return {
        total: leads.length,
        abertos: abertos.length,
        followupsAtrasados,
        acoesHoje,
        proximos7Dias,
        semProximaAcao,
        propostasAbertas,
        contratosMes,
        taxaConversao: leads.length ? ganhos.length / leads.length : 0,
        receitaFechada,
        receitaAberta
    };
}

function montarResumoTicketParaCRM(ticket = {}, historico = {}) {
    const respostas = Array.isArray(ticket.respostasFluxo) && ticket.respostasFluxo.length
        ? ticket.respostasFluxo
        : (Array.isArray(historico.respostasTriagem) ? historico.respostasTriagem : []);

    const linhas = respostas
        .map(item => {
            const pergunta = textoCRM(item?.pergunta, 500);
            const resposta = textoCRM(item?.resposta, 1200);
            if (!pergunta && !resposta) return '';
            return pergunta ? `${pergunta}: ${resposta || 'sem resposta textual'}` : resposta;
        })
        .filter(Boolean);

    if (historico.ultimoRelatoForaHorario) {
        linhas.push(`Relato: ${textoCRM(historico.ultimoRelatoForaHorario, 1800)}`);
    }

    if (!linhas.length) {
        const area = ticket.area || ticket.menuOptionTitle || 'Atendimento pelo WhatsApp';
        linhas.push(`Lead originado do ticket ${ticket.ticketNumber || ''} — ${area}.`);
    }

    return textoCRM(linhas.join('\n'), 6000);
}

// Cria ou atualiza o registro comercial correspondente a um ticket de anúncio.
// Esta é a única rotina usada tanto pela criação automática quanto pelo botão/endpoint
// do painel, evitando lógicas diferentes e duplicidade de leads.
async function sincronizarLeadCRMDoTicket(ticketOuNumero, { emitirEvento = true } = {}) {
    if (!crmLeadsColl || !ticketsColl) return { ok: false, motivo: 'crm_indisponivel' };

    let ticket = ticketOuNumero && typeof ticketOuNumero === 'object'
        ? ticketOuNumero
        : null;

    const ticketNumberInformado = typeof ticketOuNumero === 'string'
        ? textoCRM(ticketOuNumero, 80)
        : textoCRM(ticket?.ticketNumber, 80);

    if (!ticket && ticketNumberInformado) {
        ticket = await ticketsColl.findOne({ ticketNumber: ticketNumberInformado });
    }

    if (!ticket?.ticketNumber) return { ok: false, motivo: 'ticket_nao_encontrado' };
    if (ticket.origem !== 'lead_anuncio') return { ok: false, motivo: 'nao_e_lead_anuncio' };

    const ticketNumber = textoCRM(ticket.ticketNumber, 80);
    const historico = ticketHistoryColl
        ? (await ticketHistoryColl.findOne({ _id: ticketNumber })) || {}
        : {};

    const existente = await crmLeadsColl.findOne({ ticketNumber });
    const agora = Date.now();
    const telefoneTicket = whatsappDoTicket(ticket) || '';
    const clienteTicket = textoCRM(ticket.clienteNome || '', 240);
    const areaTicket = textoCRM(ticket.area || ticket.menuOptionTitle || '', 160);
    const resumoTicket = montarResumoTicketParaCRM(ticket, historico);

    if (existente) {
        const atualizacao = {
            origemTipo: 'anuncio',
            origemTecnica: 'lead_anuncio',
            ultimaSincronizacaoTicketEm: agora,
            updatedAt: agora
        };

        // Dados do próprio ticket podem amadurecer depois da abertura (nome, área e
        // respostas da triagem). Atualizamos somente esses campos operacionais e
        // preservamos status, valores, responsável, próxima ação e demais dados comerciais.
        if (clienteTicket) atualizacao.cliente = clienteTicket;
        if (telefoneTicket) atualizacao.telefone = telefoneTicket;
        if (areaTicket) atualizacao.area = areaTicket;
        if (resumoTicket) atualizacao.assuntoResumo = resumoTicket;

        await crmLeadsColl.updateOne({ _id: existente._id }, { $set: atualizacao });
        const atualizado = { ...existente, ...atualizacao };

        if (ticketHistoryColl) {
            await atualizarHistorico(ticketNumber, {
                crmLeadId: String(existente._id),
                crmNumber: existente.crmNumber || null,
                crmAutomatico: true,
                crmSincronizadoEm: agora
            });
        }

        if (emitirEvento) {
            io.emit('crm_updated', {
                action: 'synced_from_ticket',
                id: String(existente._id),
                ticketNumber
            });
        }

        return { ok: true, created: false, lead: atualizado };
    }

    const base = normalizarLeadCRM({
        dataEntrada: dataTimestampParaCRM(ticket.createdAt),
        // O detector atual identifica mensagens provenientes de campanhas Meta/Facebook/Instagram.
        // O campo continua editável no CRM caso o advogado queira especificar a plataforma.
        origem: origemPadraoCRM(),
        cliente: clienteTicket || `Lead ${ticketNumber}`,
        telefone: telefoneTicket,
        area: areaTicket,
        assuntoResumo: resumoTicket,
        status: nomeStatusCRMInicial(),
        proximaAcao: 'Realizar primeiro contato / avaliar contratação',
        dataProximaAcao: dataHojeCRM(),
        observacoes: `Criado automaticamente a partir do ticket ${ticketNumber}. Origem técnica: lead_anuncio.`
    });

    const doc = {
        ...base,
        origemTipo: 'anuncio',
        origemTecnica: 'lead_anuncio',
        crmNumber: await gerarNumeroCRM(),
        ticketNumber,
        ultimaSincronizacaoTicketEm: agora,
        createdAt: agora,
        updatedAt: agora
    };

    try {
        const resultado = await crmLeadsColl.insertOne(doc);
        const salvo = { ...doc, _id: resultado.insertedId };

        if (ticketHistoryColl) {
            await atualizarHistorico(ticketNumber, {
                crmLeadId: String(resultado.insertedId),
                crmNumber: doc.crmNumber,
                crmAutomatico: true,
                crmCriadoEm: agora,
                crmSincronizadoEm: agora
            });
        }

        if (emitirEvento) {
            io.emit('crm_updated', {
                action: 'created_from_ticket_auto',
                id: String(resultado.insertedId),
                ticketNumber
            });
        }

        console.log(`[CRM ${doc.crmNumber}] Lead criado automaticamente a partir do ticket ${ticketNumber}.`);
        return { ok: true, created: true, lead: salvo };
    } catch (err) {
        // O índice único por ticketNumber garante idempotência caso duas mensagens/eventos
        // tentem criar o mesmo lead simultaneamente.
        if (err?.code === 11000) {
            const duplicado = await crmLeadsColl.findOne({ ticketNumber });
            if (duplicado) return { ok: true, created: false, lead: duplicado };
        }
        throw err;
    }
}

// Recuperação automática para tickets de anúncio que já estavam ativos antes desta
// correção. Sempre que o CRM é carregado, tickets de anúncio e seus leads são reconciliados.
async function reconciliarTicketsAnuncioNoCRM() {
    if (!crmLeadsColl || !ticketsColl) return { processados: 0, criados: 0 };

    const tickets = await ticketsColl.find({ origem: 'lead_anuncio' }).limit(1000).toArray();
    if (!tickets.length) return { processados: 0, criados: 0 };

    let criados = 0;
    for (const ticket of tickets) {
        try {
            const resultado = await sincronizarLeadCRMDoTicket(ticket, { emitirEvento: false });
            if (resultado?.created) criados += 1;
        } catch (err) {
            console.error(`[CRM] Falha ao reconciliar ticket ${ticket.ticketNumber || ticket._id}:`, err?.message || err);
        }
    }

    if (criados) io.emit('crm_updated', { action: 'reconciled', created: criados });
    return { processados: tickets.length, criados };
}


// Evita varrer os tickets de anúncio a cada atualização automática do painel.
// O fluxo normal já cria o CRM no nascimento do lead; esta rotina fica apenas
// como recuperação de consistência e roda, no máximo, uma vez a cada 5 minutos.
const CRM_RECONCILE_TTL_MS = 5 * 60 * 1000;
let crmReconcileLastAt = 0;
let crmReconcilePromise = null;

function reconciliarTicketsAnuncioNoCRMComThrottle() {
    const agora = Date.now();
    if (crmReconcilePromise) return crmReconcilePromise;
    if (agora - crmReconcileLastAt < CRM_RECONCILE_TTL_MS) return Promise.resolve(null);

    crmReconcileLastAt = agora;
    crmReconcilePromise = reconciliarTicketsAnuncioNoCRM()
        .catch(err => {
            console.error('[CRM] Falha na reconciliação periódica:', err?.message || err);
            return null;
        })
        .finally(() => {
            crmReconcilePromise = null;
        });

    return crmReconcilePromise;
}

// Painel operacional de tickets ativos.
// A classificação abaixo separa o que depende da equipe do que ainda depende do cliente.
const TICKET_STATUS_LABELS = {
    aguardando_opcao: 'Aguardando opção do cliente',
    aguardando_pergunta_fluxo: 'Triagem em andamento',
    aguardando_detalhes: 'Aguardando relato do cliente',
    aguardando_detalhes_fora_horario: 'Aguardando relato fora do horário',
    aguardando_cadastro: 'Aguardando decisão de cadastro',
    aguardando_whatsapp_cadastro: 'Aguardando WhatsApp do cliente',
    aguardando_especialista: 'Aguardando especialista',
    em_atendimento_humano: 'Em atendimento humano'
};

function classificarPendenciaTicket(ticket = {}) {
    const status = String(ticket.status || '').trim();

    if (status === 'aguardando_especialista') {
        return {
            tipo: 'advogado',
            label: 'Pendente da equipe',
            ordem: 1,
            statusLabel: TICKET_STATUS_LABELS[status]
        };
    }

    if (status === 'em_atendimento_humano') {
        return {
            tipo: 'atendimento',
            label: 'Em atendimento',
            ordem: 2,
            statusLabel: TICKET_STATUS_LABELS[status]
        };
    }

    const estadosCliente = new Set([
        'aguardando_opcao',
        'aguardando_pergunta_fluxo',
        'aguardando_detalhes',
        'aguardando_detalhes_fora_horario',
        'aguardando_cadastro',
        'aguardando_whatsapp_cadastro'
    ]);

    if (estadosCliente.has(status)) {
        return {
            tipo: 'cliente',
            label: 'Aguardando cliente',
            ordem: 3,
            statusLabel: TICKET_STATUS_LABELS[status] || 'Aguardando cliente'
        };
    }

    return {
        tipo: 'outro',
        label: 'Revisar estado',
        ordem: 4,
        statusLabel: TICKET_STATUS_LABELS[status] || status || 'Estado não informado'
    };
}

function progressoTriagemTicket(ticket = {}, respostas = []) {
    const perguntas = Array.isArray(ticket.perguntasFluxo) ? ticket.perguntasFluxo : [];
    const total = perguntas.length;
    const respondidas = Math.min(
        total || Number.MAX_SAFE_INTEGER,
        Array.isArray(respostas) ? respostas.length : 0
    );

    if (!total) {
        return {
            total: 0,
            respondidas: 0,
            percentual: ticket.status === 'aguardando_especialista' || ticket.status === 'em_atendimento_humano' ? 100 : 0,
            possuiFluxo: false
        };
    }

    return {
        total,
        respondidas,
        percentual: Math.round((respondidas / total) * 100),
        possuiFluxo: true
    };
}

function dadosTriagemTicket(ticket = {}, historico = {}) {
    const perguntas = Array.isArray(ticket?.perguntasFluxo) && ticket.perguntasFluxo.length
        ? ticket.perguntasFluxo
        : (Array.isArray(historico?.perguntasTriagem) ? historico.perguntasTriagem : []);
    const respostas = Array.isArray(ticket?.respostasFluxo) && ticket.respostasFluxo.length
        ? ticket.respostasFluxo
        : (Array.isArray(historico?.respostasTriagem) ? historico.respostasTriagem : []);
    return {
        ticket: { ...ticket, perguntasFluxo: perguntas },
        respostas
    };
}

function whatsappDoTicket(ticket = {}) {
    return extrairNumeroWhatsAppDeFontes(
        ticket.numeroReal,
        ticket.whatsappNumbers,
        ticket.identificadores,
        ticket.lastRawJid
    );
}

function pesoStatusDocumentoIA(status = '') {
    return ({ concluida: 7, erro: 6, nao_suportado: 6, processando_ia: 5, baixando: 4, na_fila: 3, analisando: 2 }[status] || 1);
}

function normalizarDocumentoIAPersistido(doc = {}) {
    if (!doc || typeof doc !== 'object') return doc || {};
    const resumoAtual = String(doc.resumoExecutivo || '').trim();
    const pareceJsonBruto = resumoAtual.startsWith('{') || resumoAtual.startsWith('```') || /[\"]tipoDocumento[\"]\s*:/.test(resumoAtual);
    if (!pareceJsonBruto) return doc;

    const parsed = extrairJsonIA(resumoAtual);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return doc;

    const normalizado = normalizarAnaliseDocumentoIA(parsed, '');
    const temEstrutura = !!(
        parsed.tipoDocumento || parsed.resumoExecutivo || parsed.pontosRelevantes || parsed.partesPessoas ||
        parsed.datasValores || parsed.obrigacoesPrazos || parsed.alertasAdvogado || parsed.informacoesNaoIdentificadas
    );
    if (!temEstrutura) return doc;

    return {
        ...doc,
        tipoDocumento: normalizado.tipoDocumento || doc.tipoDocumento || 'Não identificado',
        resumoExecutivo: normalizado.resumoExecutivo || doc.resumoExecutivo || null,
        partesPessoas: normalizado.partesPessoas.length ? normalizado.partesPessoas : (Array.isArray(doc.partesPessoas) ? doc.partesPessoas : []),
        pontosRelevantes: normalizado.pontosRelevantes.length ? normalizado.pontosRelevantes : (Array.isArray(doc.pontosRelevantes) ? doc.pontosRelevantes : []),
        datasValores: normalizado.datasValores.length ? normalizado.datasValores : (Array.isArray(doc.datasValores) ? doc.datasValores : []),
        obrigacoesPrazos: normalizado.obrigacoesPrazos.length ? normalizado.obrigacoesPrazos : (Array.isArray(doc.obrigacoesPrazos) ? doc.obrigacoesPrazos : []),
        alertasAdvogado: normalizado.alertasAdvogado.length ? normalizado.alertasAdvogado : (Array.isArray(doc.alertasAdvogado) ? doc.alertasAdvogado : []),
        informacoesNaoIdentificadas: normalizado.informacoesNaoIdentificadas.length ? normalizado.informacoesNaoIdentificadas : (Array.isArray(doc.informacoesNaoIdentificadas) ? doc.informacoesNaoIdentificadas : [])
    };
}

function mesclarDocumentosIATicket(ticket = {}, historico = {}, { detalhado = true } = {}) {
    const docsAtivos = Array.isArray(ticket.documentosIA) ? ticket.documentosIA : [];
    const docsHistorico = Array.isArray(historico.documentosIA) ? historico.documentosIA : [];
    const porMensagem = new Map();

    [...docsAtivos, ...docsHistorico].forEach(doc => {
        const chave = String(doc?.messageId || doc?.id || '');
        if (!chave) return;
        const anterior = porMensagem.get(chave);
        if (!anterior || pesoStatusDocumentoIA(doc?.statusAnalise) >= pesoStatusDocumentoIA(anterior?.statusAnalise)) {
            porMensagem.set(chave, doc);
        }
    });

    return [...porMensagem.values()]
        .sort((a, b) => Number(b?.recebidoEm || 0) - Number(a?.recebidoEm || 0))
        .slice(0, DOCUMENT_AI_MAX_ITEMS)
        .map(doc => {
            const docExibicao = detalhado ? normalizarDocumentoIAPersistido(doc) : doc;
            if (!detalhado) {
                return {
                    messageId: docExibicao?.messageId || null,
                    statusAnalise: docExibicao?.statusAnalise || 'analisando'
                };
            }
            doc = docExibicao;

            return {
                id: doc?.id || null,
                messageId: doc?.messageId || null,
                nomeArquivo: doc?.nomeArquivo || 'arquivo',
                mimeType: doc?.mimeType || null,
                tipoMidia: doc?.tipoMidia || null,
                tamanhoBytes: numeroSeguroDeLong(doc?.tamanhoBytes),
                caption: doc?.caption || null,
                recebidoEm: doc?.recebidoEm || null,
                statusAnalise: doc?.statusAnalise || 'analisando',
                analisadoEm: doc?.analisadoEm || null,
                tipoDocumento: doc?.tipoDocumento || null,
                resumoExecutivo: doc?.resumoExecutivo || null,
                partesPessoas: Array.isArray(doc?.partesPessoas) ? doc.partesPessoas : [],
                pontosRelevantes: Array.isArray(doc?.pontosRelevantes) ? doc.pontosRelevantes : [],
                datasValores: Array.isArray(doc?.datasValores) ? doc.datasValores : [],
                obrigacoesPrazos: Array.isArray(doc?.obrigacoesPrazos) ? doc.obrigacoesPrazos : [],
                alertasAdvogado: Array.isArray(doc?.alertasAdvogado) ? doc.alertasAdvogado : [],
                informacoesNaoIdentificadas: Array.isArray(doc?.informacoesNaoIdentificadas) ? doc.informacoesNaoIdentificadas : [],
                erro: doc?.erro || null,
                erroCodigo: doc?.erroCodigo || null,
                erroTemporario: doc?.erroTemporario === true,
                tentativasGemini: Number(doc?.tentativasGemini || 0),
                modeloGemini: doc?.modeloGemini || null,
                tentativasManuais: Number(doc?.tentativasManuais || 0),
                reprocessadoEm: doc?.reprocessadoEm || null,
                podeReprocessar: doc?.statusAnalise === 'erro' && (
                    typeof doc?.podeReprocessar === 'boolean' ? doc.podeReprocessar : !!doc?.retryRef
                )
            };
        });
}

function resumoDocumentosIATicket(documentosIA = []) {
    const lista = Array.isArray(documentosIA) ? documentosIA : [];
    return {
        total: lista.length,
        concluidos: lista.filter(doc => doc.statusAnalise === 'concluida').length,
        processando: lista.filter(doc => ['analisando', 'na_fila', 'baixando', 'processando_ia'].includes(doc.statusAnalise)).length,
        comErro: lista.filter(doc => ['erro', 'nao_suportado'].includes(doc.statusAnalise)).length
    };
}


async function atualizarEstadoPosEnvioChat({ ticket, ticketNumber, advogado, acessoTicket, agora = Date.now() }) {
    try {
        const tresDiasEmMs = 3 * 24 * 60 * 60 * 1000;
        const responsavelId = acessoTicket?.responsavel?.id || ticket?.advogadoResponsavelId || advogado?.id || null;
        const responsavelNome = acessoTicket?.responsavel?.nome || ticket?.advogadoResponsavelNome || advogado?.nome || null;

        const tarefas = [
            ticketsColl.updateOne(
                { _id: ticket._id },
                {
                    $set: {
                        status: 'em_atendimento_humano',
                        paused: true,
                        until: agora + tresDiasEmMs,
                        lastActivity: agora,
                        intervencaoHumanaEm: agora
                    }
                }
            ),
            atualizarHistorico(ticketNumber, {
                status: 'em_atendimento_humano',
                advogadoResponsavelId: responsavelId,
                advogadoResponsavelNome: responsavelNome,
                ultimaMensagemPainelEm: agora,
                ultimoAdvogadoMensagemId: advogado?.id || null,
                ultimoAdvogadoMensagemNome: advogado?.nome || advogado?.assinatura || null,
                intervencaoHumanaEm: agora
            })
        ];

        if (ticket?.clienteId && clientsColl && responsavelNome) {
            tarefas.push(
                clientsColl.updateOne(
                    {
                        _id: ticket.clienteId,
                        $or: [
                            { advogadoResponsavel: { $exists: false } },
                            { advogadoResponsavel: null },
                            { advogadoResponsavel: '' }
                        ]
                    },
                    { $set: { advogadoResponsavel: responsavelNome, updatedAt: agora } }
                )
            );
        }

        await Promise.allSettled(tarefas);

        io.emit('ticket_activity_updated', {
            ticketNumber,
            direction: 'out',
            status: 'em_atendimento_humano',
            lastActivity: agora,
            advogadoResponsavelId: responsavelId,
            advogadoResponsavelNome: responsavelNome
        });
    } catch (err) {
        console.warn('[Chat] Falha ao atualizar estado pós-envio:', err?.message || err);
    }
}

// -----------------------------------------------------------------------------
// CHAT INTERNO DO TICKET
// -----------------------------------------------------------------------------
app.get('/api/tickets/:ticketNumber/chat', async (req, res) => {
    if (!usuarioPode(req, 'chat')) return res.status(403).json({ erro: 'Seu usuário não possui permissão para o chat.' });
    if (!ticketMessagesColl || !ticketsColl) return res.status(503).json({ erro: 'Chat ainda não está disponível.' });
    try {
        const ticketNumber = String(req.params.ticketNumber || '').trim();
        const [ticketAtivo, historicoChat] = await Promise.all([
            ticketsColl.findOne({ ticketNumber }),
            ticketHistoryColl ? ticketHistoryColl.findOne({ _id: ticketNumber }) : Promise.resolve(null)
        ]);
        const ticket = ticketAtivo || historicoChat;
        if (!ticket) return res.status(404).json({ erro: 'Atendimento não encontrado.' });
        const atendimentoAtivo = !!ticketAtivo;

        // A análise dos anexos fica persistida no ticket/histórico e é carregada junto
        // do chat. Atendimentos encerrados continuam consultáveis em modo somente leitura.
        const documentosIAChat = mesclarDocumentosIATicket(ticketAtivo || {}, historicoChat || {}, { detalhado: true });
        const documentoIAPorMensagem = new Map(
            documentosIAChat
                .filter(doc => doc?.messageId)
                .map(doc => [String(doc.messageId), doc])
        );

        const limite = Math.min(CHAT_LIST_LIMIT_MAX, Math.max(10, Number(req.query.limit || CHAT_LIST_LIMIT_DEFAULT)));
        const filtro = { ticketNumber };
        if (req.query.before) {
            const antes = new Date(Number(req.query.before));
            if (!Number.isNaN(antes.getTime())) filtro.createdAt = { $lt: antes };
        }
        const docsDesc = await ticketMessagesColl.find(filtro).sort({ createdAt: -1 }).limit(limite + 1).toArray();
        const hasMore = docsDesc.length > limite;
        const docs = docsDesc.slice(0, limite).reverse();
        // Marca como lido somente até a mensagem efetivamente carregada. Se uma nova
        // mensagem chegar entre a consulta e este update, ela continuará aparecendo
        // como não lida na lista do advogado.
        const lidoEm = docs.length
            ? Math.max(...docs.map(item => item.createdAt instanceof Date ? item.createdAt.getTime() : Number(item.createdAt || 0)).filter(Number.isFinite))
            : Date.now();
        if (atendimentoAtivo) {
            await marcarTicketChatComoLido(ticketNumber, req, lidoEm).catch(() => {});
        } else if (ticketHistoryColl) {
            const chaveLeitura = chaveLeituraChatUsuario(req);
            if (chaveLeitura) {
                await ticketHistoryColl.updateOne(
                    { _id: ticketNumber },
                    { $set: { [`chatLeituras.${chaveLeitura}`]: lidoEm } }
                ).catch(() => {});
            }
        }
        res.json({
            readAt: lidoEm,
            ticket: (() => {
                const classificacao = atendimentoAtivo ? classificarPendenciaTicket(ticket) : { statusLabel: 'Encerrado', tipo: 'encerrado', label: 'Encerrado' };
                const triagemBase = dadosTriagemTicket(ticket, historicoChat || {});
                const triagem = progressoTriagemTicket(triagemBase.ticket, triagemBase.respostas);
                return {
                    ticketNumber,
                    isActive: atendimentoAtivo,
                    isArchived: !atendimentoAtivo,
                    archivedAt: !atendimentoAtivo ? Number(historicoChat?.archivedAt || historicoChat?.closedAt || 0) || null : null,
                    clienteNome: ticket.clienteNome || null,
                    clienteCadastrado: ticket.clienteCadastrado === true || !!ticket.clienteId,
                    whatsapp: whatsappDoTicket(ticket),
                    area: ticket.area || ticket.menuOptionTitle || null,
                    status: ticket.status || null,
                    statusLabel: classificacao.statusLabel,
                    pendenciaTipo: classificacao.tipo,
                    pendenciaLabel: classificacao.label,
                    paused: ticket.paused === true,
                    createdAt: Number(ticket.createdAt || 0) || null,
                    lastActivity: Number(ticket.lastActivity || 0) || null,
                    triagem,
                    advogadoResponsavelId: ticket.advogadoResponsavelId || null,
                    advogadoResponsavelNome: ticket.advogadoResponsavelNome || null,
                    atendimentoAssumidoEm: ticket.atendimentoAssumidoEm || null,
                internalStatusId: ticket.internalStatusId || null,
                internalStatus: statusTicketPorId(ticket.internalStatusId)
                };
            })(),
            messages: docs.map(item => {
                const mensagem = serializarMensagemChat(item);
                return {
                    ...mensagem,
                    documentAI: documentoIAPorMensagem.get(String(item.messageId || '')) || null
                };
            }),
            documents: documentosIAChat,
            documentsSummary: resumoDocumentosIATicket(documentosIAChat),
            hasMore,
            retentionDays: CHAT_RETENTION_DAYS,
            maxMessagesPerTicket: CHAT_MAX_MESSAGES_PER_TICKET,
            unlimitedHistory: true
        });
    } catch (err) {
        console.error('[Chat] Erro ao carregar mensagens:', err);
        res.status(500).json({ erro: 'Não foi possível carregar o chat.' });
    }
});

// Perguntas e respostas da triagem carregadas somente quando o advogado solicita.
// Mantém a abertura inicial do chat leve e evita carregar conteúdo extenso sem necessidade.
app.get('/api/tickets/:ticketNumber/chat/triage', async (req, res) => {
    if (!usuarioPode(req, 'chat')) return res.status(403).json({ erro: 'Seu usuário não possui permissão para o chat.' });
    if (!ticketsColl) return res.status(503).json({ erro: 'Chat ainda não está disponível.' });

    try {
        const ticketNumber = String(req.params.ticketNumber || '').trim();
        const [ticket, historico] = await Promise.all([
            ticketsColl.findOne(
                { ticketNumber },
                { projection: { ticketNumber: 1, perguntasFluxo: 1, respostasFluxo: 1, indicePerguntaFluxo: 1, status: 1 } }
            ),
            ticketHistoryColl
                ? ticketHistoryColl.findOne(
                    { _id: ticketNumber },
                    { projection: { respostasTriagem: 1, perguntasTriagem: 1, triagemConcluidaEm: 1 } }
                )
                : Promise.resolve(null)
        ]);

        const ticketBase = ticket || historico;
        if (!ticketBase) return res.status(404).json({ erro: 'Atendimento não encontrado.' });

        const triagemBase = dadosTriagemTicket(ticketBase, historico || {});
        const respostas = triagemBase.respostas;
        const triagem = progressoTriagemTicket(triagemBase.ticket, respostas);

        res.json({
            ticketNumber,
            triagem,
            concluidaEm: historico?.triagemConcluidaEm || null,
            respostas: respostas.map(item => ({
                pergunta: String(item?.pergunta || '').trim(),
                resposta: String(item?.resposta || '').trim(),
                tipo: String(item?.tipo || 'texto').trim(),
                respondidaEm: item?.respondidaEm || null
            }))
        });
    } catch (err) {
        console.error('[Chat] Erro ao carregar triagem:', err);
        res.status(500).json({ erro: 'Não foi possível carregar as respostas da triagem.' });
    }
});

// Lista consolidada das análises de anexos do ticket para o painel lateral do chat.
// O binário continua fora do MongoDB; aqui retornamos somente metadados e os resumos
// estruturados já persistidos pela rotina do Gemini.
app.get('/api/tickets/:ticketNumber/chat/documents', async (req, res) => {
    if (!usuarioPode(req, 'chat')) return res.status(403).json({ erro: 'Seu usuário não possui permissão para o chat.' });
    if (!ticketsColl) return res.status(503).json({ erro: 'Chat ainda não está disponível.' });

    try {
        const ticketNumber = String(req.params.ticketNumber || '').trim();
        const [ticket, historico] = await Promise.all([
            ticketsColl.findOne(
                { ticketNumber },
                { projection: { ticketNumber: 1, documentosIA: 1 } }
            ),
            ticketHistoryColl
                ? ticketHistoryColl.findOne(
                    { _id: ticketNumber },
                    { projection: { documentosIA: 1 } }
                )
                : Promise.resolve(null)
        ]);

        if (!ticket && !historico) return res.status(404).json({ erro: 'Atendimento não encontrado.' });

        const documents = mesclarDocumentosIATicket(ticket || {}, historico || {}, { detalhado: true });
        return res.json({
            ticketNumber,
            documents,
            summary: resumoDocumentosIATicket(documents)
        });
    } catch (err) {
        console.error('[Chat] Erro ao carregar documentos analisados:', err);
        return res.status(500).json({ erro: 'Não foi possível carregar os documentos deste chat.' });
    }
});

// Proxy autenticado de anexos. O arquivo é baixado do WhatsApp somente quando necessário
// e mantido em cache efêmero; o binário não é salvo no MongoDB.
app.get('/api/tickets/:ticketNumber/chat/media/:messageId', async (req, res) => {
    if (!usuarioPode(req, 'chat')) return res.status(403).json({ erro: 'Seu usuário não possui permissão para o chat.' });
    if (!ticketMessagesColl || !ticketsColl) return res.status(503).json({ erro: 'Chat ainda não está disponível.' });
    if (!sock?.user) return res.status(503).json({ erro: 'O WhatsApp do escritório não está conectado.' });
    try {
        const ticketNumber = String(req.params.ticketNumber || '').trim();
        const messageId = String(req.params.messageId || '').trim();
        const doc = await ticketMessagesColl.findOne(
            { ticketNumber, messageId },
            { projection: { messageId: 1, direction: 1, tipo: 1, fileName: 1, mimeType: 1, mediaRef: 1 } }
        );
        if (!doc) return res.status(404).json({ erro: 'Anexo não encontrado no histórico.' });

        const chaveCache = `${ticketNumber}:${messageId}`;
        const cache = obterMidiaCacheChat(chaveCache);
        if (cache) return enviarBufferMidiaChat(req, res, cache.buffer, cache.mimeType, cache.fileName, req.query.download === '1');

        let mediaRef = doc.mediaRef || null;
        if (!mediaRef) {
            const [ticket, historico] = await Promise.all([
                ticketsColl.findOne(
                    { ticketNumber, 'documentosIA.messageId': messageId },
                    { projection: { documentosIA: { $elemMatch: { messageId } } } }
                ),
                ticketHistoryColl ? ticketHistoryColl.findOne(
                    { _id: ticketNumber, 'documentosIA.messageId': messageId },
                    { projection: { documentosIA: { $elemMatch: { messageId } } } }
                ) : Promise.resolve(null)
            ]);
            const retryRef = ticket?.documentosIA?.[0]?.retryRef || historico?.documentosIA?.[0]?.retryRef || null;
            if (retryRef) {
                try {
                    const dadosAntigos = JSON.parse(String(retryRef), BufferJSON.reviver);
                    const mapaTipo = { imagem: 'image', video: 'video', audio: 'audio', documento: 'document' };
                    mediaRef = JSON.stringify({
                        tipo: mapaTipo[dadosAntigos?.tipo] || dadosAntigos?.tipo,
                        remoteJid: dadosAntigos?.remoteJid || null,
                        remoteJidAlt: dadosAntigos?.remoteJidAlt || null,
                        payload: dadosAntigos?.payload || null
                    }, BufferJSON.replacer);
                } catch (_) {}
            }
        }
        if (!mediaRef) return res.status(404).json({ erro: 'Este anexo antigo não possui referência para visualização.' });

        const waMsg = reconstruirMensagemMidiaChat(mediaRef, messageId, doc.direction || 'in');
        if (!waMsg) return res.status(410).json({ erro: 'A referência deste anexo não está mais disponível.' });
        const buffer = await downloadMediaMessage(waMsg, 'buffer', {}, {
            logger: P({ level: 'silent' }),
            reuploadRequest: sock?.updateMediaMessage ? sock.updateMediaMessage.bind(sock) : undefined
        });
        if (!Buffer.isBuffer(buffer) || !buffer.length) return res.status(410).json({ erro: 'O WhatsApp não disponibilizou mais este anexo.' });

        const mediaInfo = extrairMidiaChat(waMsg);
        const mimeType = doc.mimeType || mediaInfo?.mimeType || 'application/octet-stream';
        const fileName = doc.fileName || mediaInfo?.nomeArquivo || 'arquivo';
        salvarMidiaCacheChat(chaveCache, buffer, mimeType, fileName);
        return enviarBufferMidiaChat(req, res, buffer, mimeType, fileName, req.query.download === '1');
    } catch (err) {
        console.warn('[Chat] Falha ao carregar anexo:', err?.message || err);
        return res.status(500).json({ erro: 'Não foi possível carregar este anexo do WhatsApp.' });
    }
});

// Endpoint de assunção EXPLÍCITA. Abrir o chat não chama esta rota.
// Se já houver outro responsável, a confirmação explícita transfere o atendimento
// de forma atômica para o advogado conectado.
app.post('/api/tickets/:ticketNumber/claim', async (req, res) => {
    if (!usuarioPode(req, 'chat')) return res.status(403).json({ erro: 'Seu usuário não possui permissão para atender tickets.' });

    try {
        const advogado = identidadeAdvogadoSessao(req);
        const resultado = await assumirTicketParaAdvogado(req.params.ticketNumber, advogado, { emitirEvento: true });
        if (!resultado.ok) {
            return res.status(resultado.status || 409).json({
                erro: resultado.erro || 'Não foi possível assumir este atendimento.',
                responsavel: resultado.responsavel || null
            });
        }

        const classificacao = classificarPendenciaTicket(resultado.ticket || {});
        res.json({
            ok: true,
            alreadyOwned: resultado.alreadyOwned === true,
            transferred: resultado.transferred === true,
            responsavelAnterior: resultado.responsavelAnterior || null,
            responsavel: resultado.responsavel,
            ticket: {
                ticketNumber: resultado.ticket?.ticketNumber || String(req.params.ticketNumber || ''),
                status: resultado.ticket?.status || null,
                paused: resultado.ticket?.paused === true,
                statusLabel: classificacao.statusLabel,
                pendenciaTipo: classificacao.tipo,
                pendenciaLabel: classificacao.label,
                advogadoResponsavelId: resultado.responsavel?.id || advogado.id,
                advogadoResponsavelNome: resultado.responsavel?.nome || advogado.nome,
                atendimentoAssumidoEm: resultado.ticket?.atendimentoAssumidoEm || Date.now()
            }
        });
    } catch (err) {
        console.error('[Tickets] Erro ao assumir atendimento:', err);
        res.status(500).json({ erro: 'Não foi possível assumir o atendimento.' });
    }
});


// Marca o chat como lido apenas para o usuário conectado.
app.post('/api/tickets/:ticketNumber/chat/read', async (req, res) => {
    if (!usuarioPode(req, 'chat')) return res.status(403).json({ erro: 'Seu usuário não possui permissão para o chat.' });
    try {
        const lidoEm = Date.now();
        const ok = await marcarTicketChatComoLido(req.params.ticketNumber, req, lidoEm);
        if (!ok) return res.status(404).json({ erro: 'Ticket ativo não encontrado.' });
        return res.json({ ok: true, readAt: lidoEm });
    } catch (err) {
        console.error('[Chat] Erro ao marcar leitura:', err);
        return res.status(500).json({ erro: 'Não foi possível registrar a leitura.' });
    }
});

// Transfere explicitamente o atendimento para outro usuário ativo do sistema.
app.post('/api/tickets/:ticketNumber/transfer', async (req, res) => {
    if (!usuarioPode(req, 'chat')) return res.status(403).json({ erro: 'Seu usuário não possui permissão para transferir atendimentos.' });
    try {
        const targetUserId = String(req.body?.userId || '').trim();
        if (!ObjectId.isValid(targetUserId)) return res.status(400).json({ erro: 'Selecione um usuário válido para a transferência.' });

        const contaDestino = await userLoginColl.findOne(
            { _id: new ObjectId(targetUserId), ativo: { $ne: false } },
            { projection: { nome: 1, assinatura: 1, role: 1, permissions: 1 } }
        );
        if (!contaDestino) return res.status(404).json({ erro: 'O usuário selecionado não está disponível.' });

        const roleDestino = normalizarPapelUsuario(contaDestino.role);
        const permissoesDestino = normalizarPermissoesUsuario(contaDestino);
        if (roleDestino !== 'admin' && !permissoesDestino.includes('chat')) {
            return res.status(400).json({ erro: 'O usuário selecionado não possui acesso ao chat.' });
        }

        const destino = {
            id: String(contaDestino._id),
            nome: String(contaDestino.nome || 'Advogado(a)').trim(),
            assinatura: String(contaDestino.assinatura || assinaturaPadraoUsuario(contaDestino.nome || '')).trim()
        };

        const resultado = await assumirTicketParaAdvogado(req.params.ticketNumber, destino, { emitirEvento: true, permitirTransferencia: true });
        if (!resultado.ok) {
            return res.status(resultado.status || 409).json({ erro: resultado.erro || 'Não foi possível transferir o atendimento.' });
        }

        const transferidoPor = identidadeAdvogadoSessao(req);
        const agora = Date.now();
        await Promise.allSettled([
            ticketsColl.updateOne(
                { ticketNumber: String(req.params.ticketNumber || '').trim() },
                { $set: { transferidoPorUsuarioId: transferidoPor.id || null, transferidoPorUsuarioNome: transferidoPor.nome || null, transferenciaSolicitadaEm: agora } }
            ),
            atualizarHistorico(req.params.ticketNumber, {
                transferidoPorUsuarioId: transferidoPor.id || null,
                transferidoPorUsuarioNome: transferidoPor.nome || null,
                transferenciaSolicitadaEm: agora
            })
        ]);

        const classificacao = classificarPendenciaTicket(resultado.ticket || {});
        return res.json({
            ok: true,
            responsavel: resultado.responsavel,
            responsavelAnterior: resultado.responsavelAnterior || null,
            ticket: {
                ticketNumber: resultado.ticket?.ticketNumber || String(req.params.ticketNumber || ''),
                status: resultado.ticket?.status || null,
                paused: resultado.ticket?.paused === true,
                statusLabel: classificacao.statusLabel,
                pendenciaTipo: classificacao.tipo,
                pendenciaLabel: classificacao.label,
                advogadoResponsavelId: resultado.responsavel?.id || destino.id,
                advogadoResponsavelNome: resultado.responsavel?.nome || destino.nome,
                atendimentoAssumidoEm: resultado.ticket?.atendimentoAssumidoEm || agora
            }
        });
    } catch (err) {
        console.error('[Chat] Erro ao transferir atendimento:', err);
        return res.status(500).json({ erro: 'Não foi possível transferir o atendimento.' });
    }
});

// Encerramento/arquivamento manual pelo painel. O ticket sai de active_tickets,
// permanece registrado em ticket_history e continua disponível na Central de
// Atendimentos como histórico somente leitura (a interface exibe os últimos 6 meses).
app.post('/api/tickets/:ticketNumber/archive', async (req, res) => {
    if (!usuarioPode(req, 'tickets')) return res.status(403).json({ erro: 'Seu usuário não possui permissão para encerrar tickets.' });
    if (!ticketsColl || !ticketHistoryColl) return res.status(503).json({ erro: 'Banco de dados ainda não está disponível.' });

    try {
        const ticketNumber = String(req.params.ticketNumber || '').trim();
        if (!ticketNumber) return res.status(400).json({ erro: 'Ticket inválido.' });

        const ticket = await ticketsColl.findOne(
            { ticketNumber },
            {
                projection: {
                    _id: 1,
                    ticketNumber: 1,
                    status: 1,
                    numeroReal: 1,
                    whatsappNumbers: 1,
                    identificadores: 1,
                    lastRawJid: 1,
                    advogadoResponsavelId: 1,
                    advogadoResponsavelNome: 1
                }
            }
        );
        if (!ticket) return res.status(404).json({ erro: 'Ticket ativo não encontrado.' });

        const usuario = identidadeAdvogadoSessao(req);
        const agora = Date.now();

        // O encerramento só é confirmado depois que o cliente recebe o aviso.
        // Isso evita arquivar silenciosamente um atendimento caso o WhatsApp esteja
        // desconectado ou o destinatário não possa ser resolvido.
        if (!sock?.user) {
            return res.status(503).json({
                erro: 'O WhatsApp do escritório está desconectado. Reconecte-o antes de encerrar o ticket para que o cliente seja avisado.'
            });
        }

        const avisoEncerramentoEnviado = await enviarAvisoEncerramentoAoCliente(ticket, usuario);
        if (!avisoEncerramentoEnviado) {
            return res.status(502).json({
                erro: 'Não foi possível avisar o cliente sobre o encerramento. O ticket não foi arquivado; tente novamente.'
            });
        }

        await atualizarHistorico(ticketNumber, {
            status: 'encerrado_painel',
            closedAt: agora,
            archivedAt: agora,
            encerradoPeloPainel: true,
            encerradoPorUsuarioId: usuario.id || null,
            encerradoPorUsuarioNome: usuario.nome || usuario.assinatura || null,
            statusAnteriorAoEncerramento: ticket.status || null,
            advogadoResponsavelId: ticket.advogadoResponsavelId || null,
            advogadoResponsavelNome: ticket.advogadoResponsavelNome || null,
            avisoEncerramentoClienteEnviado: true,
            avisoEncerramentoClienteEnviadoEm: agora
        });

        const removido = await ticketsColl.deleteOne({ _id: ticket._id, ticketNumber });
        if (!removido.deletedCount) {
            return res.status(409).json({ erro: 'O ticket já foi alterado ou encerrado por outro usuário.' });
        }

        io.emit('ticket_archived', {
            ticketNumber,
            archivedAt: agora,
            archivedById: usuario.id || null,
            archivedByName: usuario.nome || usuario.assinatura || null
        });

        return res.json({
            ok: true,
            ticketNumber,
            archivedAt: agora,
            avisoClienteEnviado: true
        });
    } catch (err) {
        console.error('[Tickets] Erro ao encerrar ticket pelo painel:', err);
        return res.status(500).json({ erro: 'Não foi possível encerrar o ticket.' });
    }
});

app.post('/api/tickets/:ticketNumber/chat/messages', async (req, res) => {
    if (!usuarioPode(req, 'chat')) return res.status(403).json({ erro: 'Seu usuário não possui permissão para o chat.' });
    if (!sock?.user) return res.status(503).json({ erro: 'O WhatsApp do escritório não está conectado.' });
    try {
        const ticketNumber = String(req.params.ticketNumber || '').trim();
        const texto = limitarTextoChat(req.body?.text || '', CHAT_MAX_TEXT_CHARS);
        const replyToMessageId = limitarTextoChat(req.body?.replyToMessageId || '', 180);
        if (!texto) return res.status(400).json({ erro: 'Digite uma mensagem para enviar.' });

        const advogado = identidadeAdvogadoSessao(req);
        const acessoTicket = await garantirTicketDoAdvogado(ticketNumber, advogado);
        if (!acessoTicket.ok) {
            return res.status(acessoTicket.status || 409).json({
                erro: acessoTicket.erro || 'Este ticket está sendo atendido por outro advogado.',
                codigo: acessoTicket.codigo || null,
                responsavel: acessoTicket.responsavel || null
            });
        }
        const ticket = acessoTicket.ticket;
        const jid = await destinoWhatsAppTicket(ticket);
        if (!jid) return res.status(409).json({ erro: 'Não foi possível identificar o WhatsApp deste ticket.' });

        const textoWhatsApp = `${assinaturaNegritoWhatsApp(advogado)}: ${texto}`;
        const { quoted, snapshot: replyTo } = await prepararQuotedMessageChat(ticketNumber, jid, replyToMessageId);
        const jidNormalizadoPainel = normalizarJid(jid) || jid;
        panelPendingJids.add(jidNormalizadoPainel);
        setTimeout(() => panelPendingJids.delete(jidNormalizadoPainel), 5000);
        let sent;
        try {
            sent = await enviarMensagemBaileys(jid, { text: textoWhatsApp }, quoted ? { quoted } : {});
        } finally {
            setTimeout(() => panelPendingJids.delete(jidNormalizadoPainel), 2500);
        }
        const messageId = String(sent?.key?.id || `panel_${Date.now()}_${crypto.randomBytes(4).toString('hex')}`);
        if (sent?.key?.id) {
            panelMessageIds.add(sent.key.id);
            setTimeout(() => panelMessageIds.delete(sent.key.id), 2 * 60 * 1000);
        }

        // A automação só é interrompida depois que o WhatsApp confirma o envio real.
        const agora = Date.now();
        await atualizarEstadoPosEnvioChat({ ticket, ticketNumber, advogado, acessoTicket, agora });

        const registrada = await registrarMensagemChat({
            ticketNumber,
            messageId,
            direction: 'out',
            source: 'painel',
            tipo: 'text',
            texto,
            senderId: advogado.id,
            senderName: advogado.assinatura,
            replyTo,
            createdAt: agora
        });

        res.status(201).json({ ok: true, message: registrada });
    } catch (err) {
        console.error('[Chat] Erro ao enviar mensagem:', err);
        res.status(Number(err?.statusCode || 500)).json({ erro: err?.message || 'Não foi possível enviar a mensagem.' });
    }
});

app.put('/api/tickets/:ticketNumber/chat/messages/:messageId', async (req, res) => {
    if (!usuarioPode(req, 'chat')) return res.status(403).json({ erro: 'Seu usuário não possui permissão para o chat.' });
    if (!sock?.user) return res.status(503).json({ erro: 'O WhatsApp do escritório não está conectado.' });
    if (!ticketMessagesColl) return res.status(503).json({ erro: 'Histórico do chat ainda não está disponível.' });

    try {
        const ticketNumber = String(req.params.ticketNumber || '').trim();
        const messageId = String(req.params.messageId || '').trim();
        const texto = limitarTextoChat(req.body?.text || '', CHAT_MAX_TEXT_CHARS);
        if (!ticketNumber || !messageId) return res.status(400).json({ erro: 'Mensagem inválida para edição.' });
        if (!texto) return res.status(400).json({ erro: 'A mensagem editada não pode ficar vazia.' });

        const advogado = identidadeAdvogadoSessao(req);
        const acessoTicket = await garantirTicketDoAdvogado(ticketNumber, advogado);
        if (!acessoTicket.ok) {
            return res.status(acessoTicket.status || 409).json({
                erro: acessoTicket.erro || 'Este ticket está sendo atendido por outro advogado.',
                codigo: acessoTicket.codigo || null,
                responsavel: acessoTicket.responsavel || null
            });
        }

        const original = await ticketMessagesColl.findOne({ ticketNumber, messageId });
        if (!original) return res.status(404).json({ erro: 'Mensagem original não encontrada no histórico.' });
        if (original.direction !== 'out' || original.source !== 'painel' || original.tipo !== 'text') {
            return res.status(409).json({ erro: 'Somente mensagens de texto enviadas pelo painel podem ser editadas.' });
        }

        if (original.senderId && advogado.id && String(original.senderId) !== String(advogado.id)) {
            return res.status(403).json({ erro: 'Somente o advogado que enviou a mensagem pode editá-la.' });
        }

        const criadaEm = original.createdAt instanceof Date ? original.createdAt.getTime() : Number(original.createdAt || 0);
        if (!criadaEm || Date.now() - criadaEm > CHAT_EDIT_WINDOW_MS) {
            return res.status(409).json({ erro: 'O prazo de 15 minutos para editar esta mensagem já terminou.' });
        }
        if (String(original.texto || '') === texto) {
            return res.json({ ok: true, message: serializarMensagemChat(original) });
        }

        const ticket = acessoTicket.ticket;
        const jid = await destinoWhatsAppTicket(ticket);
        if (!jid) return res.status(409).json({ erro: 'Não foi possível identificar o WhatsApp deste ticket.' });

        const textoWhatsApp = `${assinaturaNegritoWhatsApp(advogado)}: ${texto}`;
        const editKey = { remoteJid: jid, id: messageId, fromMe: true };
        await enviarMensagemBaileys(jid, { text: textoWhatsApp, edit: editKey });

        const agora = new Date();
        await ticketMessagesColl.updateOne(
            { _id: original._id },
            {
                $set: {
                    texto,
                    editedAt: agora,
                    editedById: advogado.id ? String(advogado.id).slice(0, 120) : null,
                    editedByName: limitarTextoChat(advogado.assinatura || advogado.nome || '', 180)
                },
                $inc: { editCount: 1 }
            }
        );
        const atualizado = await ticketMessagesColl.findOne({ _id: original._id });
        const serializada = serializarMensagemChat(atualizado || { ...original, texto, editedAt: agora, editCount: Number(original.editCount || 0) + 1 });
        io.emit('ticket_chat_message_edited', { ticketNumber, message: serializada });
        return res.json({ ok: true, message: serializada });
    } catch (err) {
        console.error('[Chat] Erro ao editar mensagem:', err);
        return res.status(Number(err?.statusCode || 500)).json({ erro: err?.message || 'Não foi possível editar a mensagem.' });
    }
});


// -----------------------------------------------------------------------------
// NORMALIZAÇÃO DE ÁUDIO DO CHAT PARA WHATSAPP
// -----------------------------------------------------------------------------
// MediaRecorder varia por navegador: Chrome/Android costuma produzir WebM/Opus e
// Safari/iOS pode produzir MP4/AAC. Mensagem de voz (PTT) é muito mais confiável no
// WhatsApp quando enviada como OGG/Opus. A conversão é feita por pipe, sem gravar o
// áudio do cliente em disco. Não há shell/interpolação de parâmetros.
const CHAT_AUDIO_TRANSCODE_TIMEOUT_MS = Math.max(8000, Number(process.env.CHAT_AUDIO_TRANSCODE_TIMEOUT_MS || 30000));
const CHAT_AUDIO_TRANSCODE_MAX_OUTPUT_BYTES = 20 * 1024 * 1024;

function caminhoFfmpegChat() {
    if (String(process.env.FFMPEG_PATH || '').trim()) return String(process.env.FFMPEG_PATH).trim();
    try {
        // Opcional: se o projeto já tiver ffmpeg-static instalado, aproveitamos.
        const estatico = require('ffmpeg-static');
        if (estatico) return estatico;
    } catch (_) {}
    return 'ffmpeg';
}

function converterAudioChatParaOggOpus(buffer) {
    return new Promise((resolve, reject) => {
        if (!Buffer.isBuffer(buffer) || !buffer.length) return reject(new Error('Áudio vazio ou inválido.'));

        const args = [
            '-nostdin', '-hide_banner', '-loglevel', 'error',
            '-i', 'pipe:0',
            '-vn', '-map_metadata', '-1',
            '-ac', '1', '-ar', '48000',
            '-c:a', 'libopus', '-b:a', '32k', '-vbr', 'on', '-application', 'voip',
            '-f', 'ogg', 'pipe:1'
        ];

        let processo;
        try {
            processo = spawn(caminhoFfmpegChat(), args, { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
        } catch (err) {
            return reject(err);
        }

        const saida = [];
        const erros = [];
        let total = 0;
        let finalizado = false;

        const concluirErro = (err) => {
            if (finalizado) return;
            finalizado = true;
            try { processo.kill('SIGKILL'); } catch (_) {}
            reject(err);
        };

        const timer = setTimeout(() => {
            concluirErro(new Error('A conversão do áudio excedeu o tempo limite.'));
        }, CHAT_AUDIO_TRANSCODE_TIMEOUT_MS);
        timer.unref?.();

        processo.stdout.on('data', chunk => {
            total += chunk.length;
            if (total > CHAT_AUDIO_TRANSCODE_MAX_OUTPUT_BYTES) {
                concluirErro(new Error('O áudio convertido excedeu o limite permitido.'));
                return;
            }
            saida.push(chunk);
        });
        processo.stderr.on('data', chunk => {
            if (erros.reduce((n, b) => n + b.length, 0) < 12_000) erros.push(chunk);
        });
        processo.on('error', err => {
            clearTimeout(timer);
            concluirErro(err);
        });
        processo.on('close', code => {
            clearTimeout(timer);
            if (finalizado) return;
            finalizado = true;
            if (code !== 0 || !saida.length) {
                const detalhe = Buffer.concat(erros).toString('utf8').trim().slice(0, 700);
                return reject(new Error(detalhe || `FFmpeg finalizou com código ${code}.`));
            }
            resolve(Buffer.concat(saida));
        });

        processo.stdin.on('error', err => {
            if (!['EPIPE', 'ERR_STREAM_DESTROYED'].includes(err?.code)) concluirErro(err);
        });
        processo.stdin.end(buffer);
    });
}

async function prepararAudioChatParaWhatsapp(buffer, mimeOriginal = '', { voz = false } = {}) {
    const mimeBruto = String(mimeOriginal || '').trim().toLowerCase();
    const mimeBase = mimeBruto.split(';')[0].trim();
    const precisaNormalizar = voz || ['audio/webm', 'audio/wav', 'audio/x-wav', 'audio/opus'].includes(mimeBase);

    if (!precisaNormalizar) {
        return { buffer, mimeType: mimeBase || 'audio/mpeg', ptt: false, convertido: false };
    }

    try {
        const convertido = await converterAudioChatParaOggOpus(buffer);
        return {
            buffer: convertido,
            mimeType: 'audio/ogg; codecs=opus',
            ptt: voz === true,
            convertido: true
        };
    } catch (err) {
        console.warn(`[Chat][Áudio] Não foi possível normalizar ${mimeBruto || 'áudio'} para OGG/Opus:`, err?.message || err);

        // OGG já recebido pode seguir como PTT mesmo quando o transcoder estiver
        // indisponível. Nos demais formatos, preservamos o arquivo como áudio comum
        // em vez de descartar a mensagem silenciosamente.
        if (mimeBase === 'audio/ogg') {
            return { buffer, mimeType: 'audio/ogg; codecs=opus', ptt: voz === true, convertido: false };
        }
        return { buffer, mimeType: mimeBase || 'audio/mpeg', ptt: false, convertido: false, fallback: true };
    }
}


app.post(
    '/api/tickets/:ticketNumber/chat/files',
    express.raw({ type: 'application/octet-stream', limit: CHAT_MAX_UPLOAD_BYTES }),
    async (req, res) => {
        if (!usuarioPode(req, 'chat')) return res.status(403).json({ erro: 'Seu usuário não possui permissão para o chat.' });
        if (!sock?.user) return res.status(503).json({ erro: 'O WhatsApp do escritório não está conectado.' });
        try {
            const ticketNumber = String(req.params.ticketNumber || '').trim();
            if (!Buffer.isBuffer(req.body) || !req.body.length) return res.status(400).json({ erro: 'Arquivo vazio ou inválido.' });
            if (req.body.length > CHAT_MAX_UPLOAD_BYTES) return res.status(413).json({ erro: 'Arquivo acima do limite de 15 MB do chat.' });

            const advogado = identidadeAdvogadoSessao(req);
            const acessoTicket = await garantirTicketDoAdvogado(ticketNumber, advogado);
            if (!acessoTicket.ok) {
                return res.status(acessoTicket.status || 409).json({
                    erro: acessoTicket.erro || 'Este ticket está sendo atendido por outro advogado.',
                    codigo: acessoTicket.codigo || null,
                    responsavel: acessoTicket.responsavel || null
                });
            }
            const ticket = acessoTicket.ticket;
            const jid = await destinoWhatsAppTicket(ticket);
            if (!jid) return res.status(409).json({ erro: 'Não foi possível identificar o WhatsApp deste ticket.' });

            const nomeArquivo = limitarTextoChat(req.query.name || 'arquivo', 240);
            // Preserva codec/container informados pelo MediaRecorder (ex.: audio/webm;codecs=opus).
            // O MIME base ainda é usado para classificação da mídia.
            const mimeInformadoBruto = limitarTextoChat(req.query.mimeType || 'application/octet-stream', 160).toLowerCase().trim();
            const mimeInformado = mimeInformadoBruto.split(';')[0].trim();
            let mimeType = (!mimeInformado || mimeInformado === 'application/octet-stream' ? mimePorExtensao(nomeArquivo) : mimeInformado) || 'application/octet-stream';
            const legenda = limitarTextoChat(req.query.caption || '', CHAT_MAX_CAPTION_CHARS);
            const replyToMessageId = limitarTextoChat(req.query.replyToMessageId || '', 180);
            const gravacaoVoz = String(req.query.voice || '') === '1';
            const captionAssinada = legenda ? `${assinaturaNegritoWhatsApp(advogado)}: ${legenda}` : `${assinaturaNegritoWhatsApp(advogado)}:`;
            const { quoted, snapshot: replyTo } = await prepararQuotedMessageChat(ticketNumber, jid, replyToMessageId);
            const jidNormalizadoPainel = normalizarJid(jid) || jid;
            panelPendingJids.add(jidNormalizadoPainel);
            setTimeout(() => panelPendingJids.delete(jidNormalizadoPainel), 5000);
            let payload;
            let tipo = 'document';
            if (mimeType.startsWith('image/')) {
                tipo = 'image'; payload = { image: req.body, mimetype: mimeType, caption: captionAssinada };
            } else if (mimeType.startsWith('video/')) {
                tipo = 'video'; payload = { video: req.body, mimetype: mimeType, caption: captionAssinada };
            } else if (mimeType.startsWith('audio/')) {
                tipo = 'audio';
                const audioPreparado = await prepararAudioChatParaWhatsapp(
                    req.body,
                    mimeInformadoBruto || mimeType,
                    { voz: gravacaoVoz }
                );
                mimeType = audioPreparado.mimeType;
                payload = {
                    audio: audioPreparado.buffer,
                    mimetype: audioPreparado.mimeType,
                    ptt: audioPreparado.ptt === true
                };
                if (gravacaoVoz && audioPreparado.fallback) {
                    console.warn(`[Chat][Áudio] Ticket ${ticketNumber}: gravação enviada como áudio comum porque OGG/Opus não pôde ser gerado.`);
                }
            } else {
                payload = { document: req.body, mimetype: mimeType, fileName: nomeArquivo, caption: captionAssinada };
            }

            // Áudio não aceita legenda no WhatsApp. Envia a identificação em uma
            // mensagem curta imediatamente antes, sem salvar binário no MongoDB.
            if (tipo === 'audio' && !gravacaoVoz) {
                const intro = await enviarMensagemBaileys(jid, { text: legenda ? `${assinaturaNegritoWhatsApp(advogado)}: ${legenda}` : `${assinaturaNegritoWhatsApp(advogado)}:` }, quoted ? { quoted } : {});
                if (intro?.key?.id) {
                    panelMessageIds.add(intro.key.id);
                    setTimeout(() => panelMessageIds.delete(intro.key.id), 2 * 60 * 1000);
                    await registrarMensagemChat({
                        ticketNumber, messageId: intro.key.id, direction: 'out', source: 'painel', tipo: 'text',
                        texto: legenda || 'Áudio enviado.', senderId: advogado.id, senderName: advogado.assinatura, createdAt: Date.now()
                    });
                }
            }

            let sent;
            try {
                sent = await enviarMensagemBaileys(jid, payload, quoted ? { quoted } : {});
            } finally {
                setTimeout(() => panelPendingJids.delete(jidNormalizadoPainel), 2500);
            }
            const messageId = String(sent?.key?.id || `panel_file_${Date.now()}_${crypto.randomBytes(4).toString('hex')}`);
            if (sent?.key?.id) {
                panelMessageIds.add(sent.key.id);
                setTimeout(() => panelMessageIds.delete(sent.key.id), 2 * 60 * 1000);
            }
            const mediaRefEnviada = sent ? criarReferenciaMidiaChat(sent) : null;
            // Arquivo enviado pelo advogado também é uma intervenção humana real.
            const agora = Date.now();
            await atualizarEstadoPosEnvioChat({ ticket, ticketNumber, advogado, acessoTicket, agora });

            const registrada = await registrarMensagemChat({
                ticketNumber,
                messageId,
                direction: 'out',
                source: 'painel',
                tipo,
                texto: tipo === 'audio' ? '' : legenda,
                fileName: nomeArquivo,
                mimeType,
                fileSize: tipo === 'audio' && Buffer.isBuffer(payload?.audio) ? payload.audio.length : req.body.length,
                mediaRef: mediaRefEnviada,
                senderId: advogado.id,
                senderName: advogado.assinatura,
                replyTo,
                createdAt: agora
            });

            res.status(201).json({ ok: true, message: registrada });
        } catch (err) {
            console.error('[Chat] Erro ao enviar arquivo:', err);
            const status = err?.type === 'entity.too.large' ? 413 : 500;
            res.status(status).json({ erro: status === 413 ? 'Arquivo acima do limite de 15 MB do chat.' : (err?.message || 'Não foi possível enviar o arquivo.') });
        }
    }
);



async function obterUrlFotoPerfilWhatsApp(ticket = {}) {
    if (!sock?.user || typeof sock.profilePictureUrl !== 'function') return null;

    const numero = whatsappDoTicket(ticket);
    const candidatos = [];
    if (numero) candidatos.push(normalizarJid(`${numero}@s.whatsapp.net`));
    [ticket.lastRawJid, ...(Array.isArray(ticket.identificadores) ? ticket.identificadores : [])]
        .map(valor => normalizarJid(String(valor || '')))
        .filter(Boolean)
        .forEach(jid => { if (!candidatos.includes(jid)) candidatos.push(jid); });

    for (const jid of candidatos.filter(Boolean)) {
        const cache = whatsappProfilePhotoCache.get(jid);
        if (cache) {
            const ttl = cache.url ? WHATSAPP_PROFILE_PHOTO_CACHE_TTL_MS : WHATSAPP_PROFILE_PHOTO_NEGATIVE_TTL_MS;
            if ((Date.now() - Number(cache.savedAt || 0)) < ttl) return cache.url || null;
            whatsappProfilePhotoCache.delete(jid);
        }

        try {
            const url = await sock.profilePictureUrl(jid, 'image');
            if (url) {
                whatsappProfilePhotoCache.set(jid, { url, savedAt: Date.now() });
                return url;
            }
        } catch (_) {
            whatsappProfilePhotoCache.set(jid, { url: null, savedAt: Date.now() });
        }
    }
    return null;
}

// Foto do contato usada na Central de Atendimentos. O navegador recebe apenas um
// redirecionamento temporário para a mídia do WhatsApp; nenhuma foto é persistida.
app.get('/api/tickets/:ticketNumber/profile-photo', async (req, res) => {
    if (!req.session.loggedIn) return res.status(401).end();
    if (!usuarioPode(req, 'tickets') && !usuarioPode(req, 'chat')) return res.status(403).end();
    if (!ticketsColl) return res.status(503).end();

    try {
        const ticketNumber = String(req.params.ticketNumber || '').trim();
        const projection = { numeroReal:1, whatsappNumbers:1, identificadores:1, lastRawJid:1 };
        const ativo = await ticketsColl.findOne({ ticketNumber }, { projection });
        const ticket = ativo || (ticketHistoryColl ? await ticketHistoryColl.findOne({ _id: ticketNumber }, { projection }) : null);
        if (!ticket) return res.status(404).end();

        const url = await obterUrlFotoPerfilWhatsApp(ticket);
        if (!url) return res.status(404).end();
        res.setHeader('Cache-Control', 'private, max-age=900');
        return res.redirect(302, url);
    } catch (err) {
        console.warn('[Atendimentos] Não foi possível obter foto do perfil:', err?.message || err);
        return res.status(404).end();
    }
});

// Visão unificada da Central de Atendimentos.
// `active_tickets` continua sendo a fonte operacional do bot. Quando solicitado,
// a interface também recebe atendimentos encerrados nos últimos 6 meses a partir
// de `ticket_history`, sem reativá-los nem permitir novos envios.
app.get('/api/tickets/conversations', async (req, res) => {
    if (!req.session.loggedIn) return res.status(401).json({ erro: 'Acesso negado' });
    if (!usuarioPode(req, 'tickets')) return res.status(403).json({ erro: 'Seu usuário não possui permissão para os atendimentos.' });
    if (!ticketsColl) return res.status(503).json({ erro: 'Banco de dados ainda não está disponível.' });

    try {
        const incluirEncerrados = String(req.query.includeArchived || '') === '1';
        const agora = Date.now();
        const inicioHistorico = new Date(agora);
        inicioHistorico.setMonth(inicioHistorico.getMonth() - 6);
        const inicioHistoricoMs = inicioHistorico.getTime();
        const chaveLeitura = chaveLeituraChatUsuario(req);

        const ativos = await ticketsColl.find({}, {
            projection: {
                ticketNumber: 1, status: 1, clienteId: 1, clienteNome: 1, clienteCadastrado: 1, cpf: 1, numeroReal: 1,
                whatsappNumbers: 1, identificadores: 1, area: 1, menuOptionTitle: 1,
                menuOptionEmoji: 1, createdAt: 1, lastActivity: 1, lastInboundChatAt: 1,
                chatLeituras: 1, advogadoResponsavelId: 1, advogadoResponsavelNome: 1,
                atendimentoAssumidoEm: 1, internalStatusId: 1, paused: 1, origem: 1
            }
        }).toArray();

        const conversasAtivas = ativos.map(ticket => {
            const classificacao = classificarPendenciaTicket(ticket);
            const ultimaMensagemClienteEm = Number(ticket.lastInboundChatAt || 0) || null;
            const chatLidoEm = timestampLeituraChatTicket(ticket, chaveLeitura);
            const temMensagemNaoLida = !!ultimaMensagemClienteEm && ultimaMensagemClienteEm > chatLidoEm;
            return {
                ticketNumber: ticket.ticketNumber || null,
                clienteNome: ticket.clienteNome || null,
                clienteCadastrado: ticket.clienteCadastrado === true || !!ticket.clienteId,
                cpf: ticket.cpf || null,
                whatsapp: whatsappDoTicket(ticket),
                area: ticket.area || ticket.menuOptionTitle || null,
                menuOptionTitle: ticket.menuOptionTitle || null,
                menuOptionEmoji: ticket.menuOptionEmoji || '',
                status: ticket.status || null,
                statusLabel: classificacao.statusLabel,
                pendenciaTipo: classificacao.tipo,
                pendenciaLabel: classificacao.label,
                createdAt: Number(ticket.createdAt || 0) || null,
                lastActivity: Number(ticket.lastActivity || ticket.createdAt || 0) || null,
                advogadoResponsavelId: ticket.advogadoResponsavelId || null,
                advogadoResponsavelNome: ticket.advogadoResponsavelNome || null,
                atendimentoAssumidoEm: ticket.atendimentoAssumidoEm || null,
                internalStatusId: ticket.internalStatusId || null,
                internalStatus: statusTicketPorId(ticket.internalStatusId),
                origem: ticket.origem || 'organico',
                ultimaMensagemClienteEm,
                chatLidoEm: chatLidoEm || null,
                temMensagemNaoLida,
                isActive: true,
                isArchived: false,
                archivedAt: null
            };
        });

        let conversasEncerradas = [];
        if (incluirEncerrados && ticketHistoryColl) {
            const historicos = await ticketHistoryColl.find({
                $and: [
                    { _id: { $nin: conversasAtivas.map(item => item.ticketNumber).filter(Boolean) } },
                    {
                        $or: [
                            { archivedAt: { $gte: inicioHistoricoMs } },
                            { closedAt: { $gte: inicioHistoricoMs } },
                            { updatedAt: { $gte: inicioHistoricoMs }, status: { $regex: /^encerrado/i } }
                        ]
                    }
                ]
            }, {
                projection: {
                    ticketNumber: 1, status: 1, clienteId: 1, clienteNome: 1, clienteCadastrado: 1, cpf: 1, numeroReal: 1,
                    whatsappNumbers: 1, identificadores: 1, area: 1, menuOptionTitle: 1,
                    menuOptionEmoji: 1, createdAt: 1, lastActivity: 1, updatedAt: 1,
                    archivedAt: 1, closedAt: 1, advogadoResponsavelId: 1,
                    advogadoResponsavelNome: 1, atendimentoAssumidoEm: 1,
                    internalStatusId: 1, origem: 1
                }
            }).sort({ archivedAt: -1, closedAt: -1, updatedAt: -1 }).limit(3000).toArray();

            conversasEncerradas = historicos.map(item => {
                const ticketNumber = String(item.ticketNumber || item._id || '');
                const encerradoEm = Number(item.archivedAt || item.closedAt || item.updatedAt || item.lastActivity || item.createdAt || 0) || null;
                return {
                    ticketNumber,
                    clienteNome: item.clienteNome || null,
                    clienteCadastrado: item.clienteCadastrado === true || !!item.clienteId,
                    cpf: item.cpf || null,
                    whatsapp: whatsappDoTicket(item),
                    area: item.area || item.menuOptionTitle || null,
                    menuOptionTitle: item.menuOptionTitle || null,
                    menuOptionEmoji: item.menuOptionEmoji || '',
                    status: item.status || 'encerrado',
                    statusLabel: 'Encerrado',
                    pendenciaTipo: 'encerrado',
                    pendenciaLabel: 'Encerrado',
                    createdAt: Number(item.createdAt || 0) || null,
                    lastActivity: encerradoEm,
                    advogadoResponsavelId: item.advogadoResponsavelId || null,
                    advogadoResponsavelNome: item.advogadoResponsavelNome || null,
                    atendimentoAssumidoEm: item.atendimentoAssumidoEm || null,
                    internalStatusId: item.internalStatusId || null,
                    internalStatus: statusTicketPorId(item.internalStatusId),
                    origem: item.origem || 'organico',
                    ultimaMensagemClienteEm: null,
                    chatLidoEm: null,
                    temMensagemNaoLida: false,
                    isActive: false,
                    isArchived: true,
                    archivedAt: encerradoEm
                };
            }).filter(item => item.ticketNumber);
        }

        const conversations = [...conversasAtivas, ...conversasEncerradas]
            .sort((a, b) => Number(b.lastActivity || 0) - Number(a.lastActivity || 0));

        return res.json({
            generatedAt: agora,
            historyMonths: 6,
            includeArchived: incluirEncerrados,
            resumo: {
                ativos: conversasAtivas.length,
                mensagensNaoLidas: conversasAtivas.filter(item => item.temMensagemNaoLida).length,
                encerradosExibidos: conversasEncerradas.length,
                exibidos: conversations.length
            },
            ticketStatusOptions: statusTicketsAtivos(),
            conversations
        });
    } catch (err) {
        console.error('[Atendimentos] Erro ao carregar central de conversas:', err);
        return res.status(500).json({ erro: 'Não foi possível carregar os atendimentos.' });
    }
});

// Resumo leve de mensagens não lidas para o menu lateral.
// Não depende de o usuário abrir a tela de Tickets: o frontend consulta este
// endpoint ao iniciar, ao reconectar o Socket.IO e quando chega nova mensagem.
app.get('/api/tickets/unread-summary', async (req, res) => {
    if (!req.session.loggedIn) return res.status(401).json({ erro: 'Acesso negado' });
    if (!usuarioPode(req, 'tickets')) return res.status(403).json({ erro: 'Seu usuário não possui permissão para os tickets.' });
    if (!ticketsColl) return res.status(503).json({ erro: 'Banco de dados ainda não está disponível.' });

    try {
        const chaveLeitura = chaveLeituraChatUsuario(req);
        if (!chaveLeitura) return res.json({ ticketsNaoLidos: 0, generatedAt: Date.now() });

        const inicioRastreamento = Number(chatUnreadTrackingStartedAt || 0);
        const candidatos = await ticketsColl.find(
            { lastInboundChatAt: { $gt: inicioRastreamento } },
            { projection: { lastInboundChatAt: 1, chatLeituras: 1 } }
        ).toArray();

        let ticketsNaoLidos = 0;
        for (const ticket of candidatos) {
            const ultimaEntrada = Number(ticket.lastInboundChatAt || 0);
            if (!ultimaEntrada) continue;
            const lidoEm = timestampLeituraChatTicket(ticket, chaveLeitura);
            if (ultimaEntrada > lidoEm) ticketsNaoLidos += 1;
        }

        return res.json({ ticketsNaoLidos, generatedAt: Date.now() });
    } catch (err) {
        console.error('[Tickets] Erro ao carregar resumo de não lidos:', err);
        return res.status(500).json({ erro: 'Não foi possível consultar as mensagens não lidas.' });
    }
});

app.get('/api/tickets/active', async (req, res) => {
    if (!req.session.loggedIn) return res.status(401).send('Acesso negado');
    if (!ticketsColl) return res.status(503).json({ erro: 'Banco de dados ainda não está disponível.' });

    try {
        const tickets = await ticketsColl.find(
            {},
            {
                projection: {
                    id: 1,
                    ticketNumber: 1,
                    status: 1,
                    origem: 1,
                    clienteId: 1,
                    clienteNome: 1,
                    cpf: 1,
                    clienteCadastrado: 1,
                    numeroReal: 1,
                    whatsappNumbers: 1,
                    identificadores: 1,
                    lastRawJid: 1,
                    area: 1,
                    menuOptionId: 1,
                    menuOptionTitle: 1,
                    menuOptionEmoji: 1,
                    'perguntasFluxo.texto': 1,
                    indicePerguntaFluxo: 1,
                    'respostasFluxo.perguntaId': 1,
                    foraHorario: 1,
                    paused: 1,
                    until: 1,
                    lastActivity: 1,
                    createdAt: 1,
                    'documentosIA.messageId': 1,
                    'documentosIA.statusAnalise': 1,
                    'documentosIA.recebidoEm': 1,
                    advogadoResponsavelId: 1,
                    advogadoResponsavelNome: 1,
                    atendimentoAssumidoEm: 1,
                    internalStatusId: 1,
                    lastInboundChatAt: 1,
                    chatLeituras: 1
                }
            }
        ).toArray();

        // Garante também no painel de tickets que todo ticket classificado como
        // lead_anuncio já possua seu registro correspondente no CRM. Isso recupera
        // automaticamente tickets criados antes desta correção.
        if (crmLeadsColl && tickets.some(ticket => ticket.origem === 'lead_anuncio')) {
            reconciliarTicketsAnuncioNoCRMComThrottle();
        }

        const ticketNumbers = tickets.map(ticket => ticket.ticketNumber).filter(Boolean);
        // As duas consultas auxiliares são independentes; executá-las em paralelo
        // reduz a latência perceptível da tela de Tickets Ativos.
        const ticketsSemCursorEntrada = tickets
            .filter(ticket => !Number(ticket.lastInboundChatAt || 0))
            .map(ticket => ticket.ticketNumber)
            .filter(Boolean);

        const [historicos, leadsCRMRelacionadosBrutos, ultimasEntradasLegadas] = await Promise.all([
            ticketHistoryColl && ticketNumbers.length
                ? ticketHistoryColl.find(
                    { _id: { $in: ticketNumbers } },
                    {
                        projection: {
                            ticketNumber: 1,
                            'respostasTriagem.perguntaId': 1,
                            triagemConcluidaEm: 1,
                            'documentosIA.messageId': 1,
                            'documentosIA.statusAnalise': 1,
                            'documentosIA.recebidoEm': 1
                        }
                    }
                ).toArray()
                : Promise.resolve([]),
            crmLeadsColl && ticketNumbers.length
                ? crmLeadsColl.find(
                    { ticketNumber: { $in: ticketNumbers } },
                    { projection: { _id: 1, crmNumber: 1, ticketNumber: 1, status: 1, origem: 1, origemTipo: 1, origemTecnica: 1 } }
                ).toArray()
                : Promise.resolve([]),
            ticketMessagesColl && ticketsSemCursorEntrada.length
                ? ticketMessagesColl.aggregate([
                    { $match: { ticketNumber: { $in: ticketsSemCursorEntrada }, direction: 'in' } },
                    { $sort: { createdAt: -1 } },
                    { $group: { _id: '$ticketNumber', lastInboundChatAt: { $first: '$createdAt' } } }
                ]).toArray()
                : Promise.resolve([])
        ]);

        const ultimaEntradaLegadaPorTicket = new Map(
            (ultimasEntradasLegadas || []).map(item => [String(item._id), item.lastInboundChatAt instanceof Date ? item.lastInboundChatAt.getTime() : Number(item.lastInboundChatAt || 0)])
        );

        const historicoPorTicket = new Map(
            historicos.map(item => [String(item.ticketNumber || item._id), item])
        );

        const leadsCRMRelacionados = leadsCRMRelacionadosBrutos.filter(leadCRMDeAnuncio);
        const crmPorTicket = new Map(
            leadsCRMRelacionados.map(lead => [String(lead.ticketNumber), {
                id: String(lead._id),
                crmNumber: lead.crmNumber || null,
                status: lead.status || null
            }])
        );

        const agora = Date.now();
        const duasHorasMs = 2 * 60 * 60 * 1000;

        const itens = tickets.map(ticket => {
            const historico = historicoPorTicket.get(String(ticket.ticketNumber)) || {};
            const classificacao = classificarPendenciaTicket(ticket);
            const triagemBase = dadosTriagemTicket(ticket, historico || {});
            const respostas = triagemBase.respostas;
            const triagem = progressoTriagemTicket(triagemBase.ticket, respostas);
            const ultimaAtividade = Number(ticket.lastActivity || ticket.createdAt || 0) || null;
            const criadoEm = Number(ticket.createdAt || 0) || null;
            const idadeUltimaAtividadeMs = ultimaAtividade ? Math.max(0, agora - ultimaAtividade) : null;
            const perguntaAtual = perguntaAtualDoTicket(ticket);

            // A listagem usa somente status/metadados mínimos dos documentos.
            // O conteúdo completo (resumo, partes, alertas etc.) é carregado apenas
            // quando o advogado abre os detalhes daquele ticket.
            const documentosIA = mesclarDocumentosIATicket(ticket, historico, { detalhado: false });
            const chaveLeitura = chaveLeituraChatUsuario(req);
            const ultimaMensagemClienteEm = Number(ticket.lastInboundChatAt || 0) || ultimaEntradaLegadaPorTicket.get(String(ticket.ticketNumber)) || null;
            const chatLidoEm = timestampLeituraChatTicket(ticket, chaveLeitura);
            const temMensagemNaoLida = !!ultimaMensagemClienteEm && ultimaMensagemClienteEm > chatLidoEm;

            return {
                id: ticket.id || null,
                ticketNumber: ticket.ticketNumber || null,
                status: ticket.status || null,
                statusLabel: classificacao.statusLabel,
                pendenciaTipo: classificacao.tipo,
                pendenciaLabel: classificacao.label,
                pendenciaOrdem: classificacao.ordem,
                pendenteHaMaisDe2h: classificacao.tipo === 'advogado' && idadeUltimaAtividadeMs !== null && idadeUltimaAtividadeMs >= duasHorasMs,
                origem: ticket.origem || 'organico',
                clienteNome: ticket.clienteNome || null,
                clienteCadastrado: ticket.clienteCadastrado === true || !!ticket.clienteId,
                cpf: ticket.cpf || null,
                whatsapp: whatsappDoTicket(ticket),
                area: ticket.area || null,
                menuOptionTitle: ticket.menuOptionTitle || null,
                menuOptionEmoji: ticket.menuOptionEmoji || '',
                foraHorario: ticket.foraHorario === true,
                paused: ticket.paused === true,
                until: ticket.until || null,
                createdAt: criadoEm,
                lastActivity: ultimaAtividade,
                idadeUltimaAtividadeMs,
                triagem,
                perguntaAtual: perguntaAtual?.texto || null,
                // Campos pesados de respostas/documentos ficam fora da listagem.
                // O endpoint de detalhe carrega essas informações sob demanda.
                respostasTriagem: [],
                relatoForaHorario: null,
                relatoForaHorarioPossuiMidia: false,
                triagemConcluidaEm: historico.triagemConcluidaEm || null,
                crm: crmPorTicket.get(String(ticket.ticketNumber)) || null,
                documentosIA: [],
                advogadoResponsavelId: ticket.advogadoResponsavelId || null,
                advogadoResponsavelNome: ticket.advogadoResponsavelNome || null,
                atendimentoAssumidoEm: ticket.atendimentoAssumidoEm || null,
                internalStatusId: ticket.internalStatusId || null,
                internalStatus: statusTicketPorId(ticket.internalStatusId),
                ultimaMensagemClienteEm,
                chatLidoEm: chatLidoEm || null,
                temMensagemNaoLida,
                documentosResumo: resumoDocumentosIATicket(documentosIA)
            };
        });

        itens.sort((a, b) => {
            if (a.pendenciaOrdem !== b.pendenciaOrdem) return a.pendenciaOrdem - b.pendenciaOrdem;

            // Na fila pendente da equipe, os mais antigos aparecem primeiro.
            if (a.pendenciaTipo === 'advogado') {
                return Number(a.lastActivity || 0) - Number(b.lastActivity || 0);
            }

            return Number(b.lastActivity || 0) - Number(a.lastActivity || 0);
        });

        const resumo = {
            total: itens.length,
            pendentesEquipe: itens.filter(item => item.pendenciaTipo === 'advogado').length,
            emAtendimento: itens.filter(item => item.pendenciaTipo === 'atendimento').length,
            aguardandoCliente: itens.filter(item => item.pendenciaTipo === 'cliente').length,
            pendentesMaisDe2h: itens.filter(item => item.pendenteHaMaisDe2h).length,
            mensagensNaoLidas: itens.filter(item => item.temMensagemNaoLida).length
        };

        res.json({
            generatedAt: agora,
            resumo,
            ticketStatusOptions: statusTicketsAtivos(),
            tickets: itens
        });
    } catch (err) {
        console.error('[Tickets] Erro ao carregar painel de tickets ativos:', err);
        res.status(500).json({ erro: 'Não foi possível carregar os tickets ativos.' });
    }
});

// Detalhe completo sob demanda. A listagem de tickets permanece leve e somente
// este endpoint carrega respostas extensas e resumos de documentos do Gemini.
app.get('/api/tickets/:ticketNumber/detail', async (req, res) => {
    if (!usuarioPode(req, 'tickets')) return res.status(403).json({ erro: 'Seu usuário não possui permissão para visualizar tickets.' });
    if (!ticketsColl) return res.status(503).json({ erro: 'Banco de dados ainda não está disponível.' });

    try {
        const ticketNumber = String(req.params.ticketNumber || '').trim();
        const ticket = await ticketsColl.findOne({ ticketNumber });
        if (!ticket) return res.status(404).json({ erro: 'Ticket ativo não encontrado.' });

        const historico = ticketHistoryColl
            ? (await ticketHistoryColl.findOne(
                { _id: ticketNumber },
                {
                    projection: {
                        ticketNumber: 1,
                        respostasTriagem: 1,
                        perguntasTriagem: 1,
                        ultimoRelatoForaHorario: 1,
                        ultimoRelatoForaHorarioPossuiMidia: 1,
                        triagemConcluidaEm: 1,
                        cadastroRealizado: 1,
                        cadastroRecusado: 1,
                        fluxoForaHorarioIniciadoEm: 1,
                        documentosIA: 1
                    }
                }
            )) || {}
            : {};

        let crm = null;
        if (crmLeadsColl && ticket.origem === 'lead_anuncio') {
            const lead = await crmLeadsColl.findOne(
                { ticketNumber },
                { projection: { _id: 1, crmNumber: 1, status: 1, origem: 1, origemTipo: 1, origemTecnica: 1 } }
            );
            if (lead && leadCRMDeAnuncio(lead)) {
                crm = { id: String(lead._id), crmNumber: lead.crmNumber || null, status: lead.status || null };
            }
        }

        const classificacao = classificarPendenciaTicket(ticket);
        const respostas = Array.isArray(ticket.respostasFluxo) && ticket.respostasFluxo.length
            ? ticket.respostasFluxo
            : (Array.isArray(historico.respostasTriagem) ? historico.respostasTriagem : []);
        const triagem = progressoTriagemTicket(ticket, respostas);
        const agora = Date.now();
        const duasHorasMs = 2 * 60 * 60 * 1000;
        const ultimaAtividade = Number(ticket.lastActivity || ticket.createdAt || 0) || null;
        const criadoEm = Number(ticket.createdAt || 0) || null;
        const idadeUltimaAtividadeMs = ultimaAtividade ? Math.max(0, agora - ultimaAtividade) : null;
        const perguntaAtual = perguntaAtualDoTicket(ticket);
        const documentosIA = mesclarDocumentosIATicket(ticket, historico, { detalhado: true });

        res.json({
            ticket: {
                id: ticket.id || null,
                ticketNumber: ticket.ticketNumber || null,
                status: ticket.status || null,
                statusLabel: classificacao.statusLabel,
                pendenciaTipo: classificacao.tipo,
                pendenciaLabel: classificacao.label,
                pendenciaOrdem: classificacao.ordem,
                pendenteHaMaisDe2h: classificacao.tipo === 'advogado' && idadeUltimaAtividadeMs !== null && idadeUltimaAtividadeMs >= duasHorasMs,
                origem: ticket.origem || 'organico',
                clienteNome: ticket.clienteNome || null,
                clienteCadastrado: ticket.clienteCadastrado === true || !!ticket.clienteId,
                cpf: ticket.cpf || null,
                whatsapp: whatsappDoTicket(ticket),
                area: ticket.area || null,
                menuOptionTitle: ticket.menuOptionTitle || null,
                menuOptionEmoji: ticket.menuOptionEmoji || '',
                foraHorario: ticket.foraHorario === true,
                paused: ticket.paused === true,
                until: ticket.until || null,
                createdAt: criadoEm,
                lastActivity: ultimaAtividade,
                idadeUltimaAtividadeMs,
                triagem,
                perguntaAtual: perguntaAtual?.texto || null,
                respostasTriagem: respostas.map(item => ({
                    pergunta: String(item?.pergunta || '').trim(),
                    resposta: String(item?.resposta || '').trim(),
                    tipo: String(item?.tipo || 'texto').trim(),
                    respondidaEm: item?.respondidaEm || null
                })),
                relatoForaHorario: historico.ultimoRelatoForaHorario || null,
                relatoForaHorarioPossuiMidia: historico.ultimoRelatoForaHorarioPossuiMidia === true,
                triagemConcluidaEm: historico.triagemConcluidaEm || null,
                crm,
                documentosIA,
                documentosResumo: resumoDocumentosIATicket(documentosIA),
                advogadoResponsavelId: ticket.advogadoResponsavelId || null,
                advogadoResponsavelNome: ticket.advogadoResponsavelNome || null,
                atendimentoAssumidoEm: ticket.atendimentoAssumidoEm || null,
                internalStatusId: ticket.internalStatusId || null,
                internalStatus: statusTicketPorId(ticket.internalStatusId)
            }
        });
    } catch (err) {
        console.error('[Tickets] Erro ao carregar detalhe do ticket:', err);
        res.status(500).json({ erro: 'Não foi possível carregar os detalhes do ticket.' });
    }
});

// Reprocessamento manual de documento com falha. Não salvamos o binário no banco:
// usamos apenas uma referência leve da mídia original para tentar baixá-la novamente.
app.post('/api/tickets/:ticketNumber/documents/:messageId/retry', async (req, res) => {
    if (!req.session.loggedIn) return res.status(401).send('Acesso negado');
    if (!ticketsColl) return res.status(503).json({ erro: 'Banco de dados ainda não está disponível.' });

    try {
        const ticketNumber = String(req.params.ticketNumber || '').trim();
        const messageId = String(req.params.messageId || '').trim();
        if (!ticketNumber || !messageId) {
            return res.status(400).json({ erro: 'Ticket ou documento inválido.' });
        }

        const ticket = await ticketsColl.findOne({ ticketNumber });
        if (!ticket) return res.status(404).json({ erro: 'Ticket ativo não encontrado.' });

        const documento = (Array.isArray(ticket.documentosIA) ? ticket.documentosIA : [])
            .find(doc => String(doc?.messageId || '') === messageId);

        if (!documento) return res.status(404).json({ erro: 'Documento não encontrado neste ticket.' });
        if (documento.statusAnalise === 'nao_suportado') {
            return res.status(400).json({ erro: 'Este tipo de arquivo não é suportado pela leitura automática.' });
        }
        if (documento.statusAnalise !== 'erro') {
            return res.status(409).json({ erro: 'Este documento não está com falha de análise.' });
        }
        if (!documento.retryRef) {
            return res.status(409).json({
                erro: 'Este documento foi recebido antes da função de reprocessamento e não possui referência de mídia salva. Solicite o reenvio do arquivo pelo cliente.'
            });
        }

        const msgRetry = reconstruirMensagemRetryDocumentoIA(documento.retryRef, messageId);
        if (!msgRetry) {
            return res.status(409).json({
                erro: 'Não foi possível reconstruir a referência deste arquivo. Solicite o reenvio pelo cliente.'
            });
        }

        const agora = Date.now();

        // Lock atômico: impede clique duplo de colocar o mesmo documento duas vezes na fila.
        const lock = await ticketsColl.updateOne(
            {
                _id: ticket._id,
                documentosIA: { $elemMatch: { messageId, statusAnalise: 'erro' } }
            },
            {
                $set: {
                    'documentosIA.$.statusAnalise': 'na_fila',
                    'documentosIA.$.erro': null,
                    'documentosIA.$.erroCodigo': null,
                    'documentosIA.$.erroTemporario': null,
                    'documentosIA.$.analisadoEm': null,
                    'documentosIA.$.reprocessadoEm': agora
                },
                $inc: { 'documentosIA.$.tentativasManuais': 1 }
            }
        );

        if (!lock.modifiedCount) {
            return res.status(409).json({ erro: 'Este documento já está sendo reprocessado.' });
        }

        if (ticketHistoryColl) {
            await ticketHistoryColl.updateOne(
                { _id: ticket.ticketNumber, 'documentosIA.messageId': messageId },
                {
                    $set: {
                        'documentosIA.$.statusAnalise': 'na_fila',
                        'documentosIA.$.erro': null,
                        'documentosIA.$.erroCodigo': null,
                        'documentosIA.$.erroTemporario': null,
                        'documentosIA.$.analisadoEm': null,
                        'documentosIA.$.reprocessadoEm': agora,
                        updatedAt: agora
                    },
                    $inc: { 'documentosIA.$.tentativasManuais': 1 }
                }
            );
        }

        io.emit('ticket_document_ai_updated', {
            ticketNumber: ticket.ticketNumber,
            messageId,
            status: 'na_fila'
        });

        // Responde ao painel imediatamente; a análise continua sem bloquear a requisição HTTP.
        iniciarAnaliseArquivoSemBloquearFluxo(ticket, msgRetry, { reprocessar: true });

        return res.status(202).json({
            ok: true,
            status: 'na_fila',
            mensagem: 'Nova leitura adicionada à fila.'
        });
    } catch (err) {
        console.error('[Documentos IA] Erro ao solicitar reprocessamento:', err?.message || err);
        return res.status(500).json({ erro: 'Não foi possível solicitar uma nova leitura deste documento.' });
    }
});


// -----------------------------------------------------------------------------
// PARÂMETROS ADMINISTRATIVOS - CRM E TICKETS
// -----------------------------------------------------------------------------
function serializarParametrosCRM() { return JSON.parse(JSON.stringify(crmParametrosCache)); }
function serializarParametrosTickets() { return JSON.parse(JSON.stringify(ticketParametrosCache)); }

app.get('/api/admin/crm-params', async (req,res)=>{
    try { res.json({ parametros:serializarParametrosCRM() }); }
    catch(err){ console.error('[CRM Params] Erro:',err); res.status(500).json({erro:'Não foi possível carregar os parâmetros do CRM.'}); }
});
app.put('/api/admin/crm-params', async (req,res)=>{
    try {
        if(!settingsColl)return res.status(503).json({erro:'Configurações ainda não estão disponíveis.'});
        const anterior=serializarParametrosCRM();
        const novo=normalizarParametrosCRM(req.body||{});
        for (const chave of ['status','modelosCobranca','motivosPerda','origensAnuncio']) {
            const nomes=(novo[chave]||[]).map(x=>x.nome.toLocaleLowerCase('pt-BR'));
            if(new Set(nomes).size!==nomes.length)return res.status(400).json({erro:'Não é permitido cadastrar nomes duplicados no mesmo grupo de parâmetros.'});
        }
        if(!novo.status.length)return res.status(400).json({erro:'Mantenha ao menos um status do CRM.'});
        if(!novo.origensAnuncio.length)return res.status(400).json({erro:'Mantenha ao menos uma origem de anúncio.'});
        // Renomes preservam os registros já existentes, usando o ID estável do parâmetro.
        const migracoes=[];
        for(const chave of ['status','modelosCobranca','motivosPerda','origensAnuncio']){
            const campo={status:'status',modelosCobranca:'modeloCobranca',motivosPerda:'motivoPerda',origensAnuncio:'origem'}[chave];
            const antigos=new Map((anterior[chave]||[]).map(x=>[x.id,x.nome]));
            for(const item of novo[chave]||[]){ const old=antigos.get(item.id); if(old&&old!==item.nome)migracoes.push(crmLeadsColl.updateMany({[campo]:old},{$set:{[campo]:item.nome,updatedAt:Date.now()}})); }
        }
        await Promise.all(migracoes);
        await settingsColl.updateOne({_id:'crm_parameters'},{$set:{...novo,updatedAt:Date.now()}},{upsert:true});
        crmParametrosCache=novo;
        io.emit('crm_parameters_updated',{updatedAt:Date.now()});
        res.json({ok:true,parametros:serializarParametrosCRM()});
    } catch(err){ console.error('[CRM Params] Erro ao salvar:',err); res.status(500).json({erro:'Não foi possível salvar os parâmetros do CRM.'}); }
});

app.get('/api/admin/ticket-params', async (req,res)=>{
    try { res.json({ parametros:serializarParametrosTickets() }); }
    catch(err){ console.error('[Ticket Params] Erro:',err); res.status(500).json({erro:'Não foi possível carregar os parâmetros de tickets.'}); }
});
app.put('/api/admin/ticket-params', async (req,res)=>{
    try {
        if(!settingsColl)return res.status(503).json({erro:'Configurações ainda não estão disponíveis.'});
        const anterior=serializarParametrosTickets();
        const novo=normalizarParametrosTickets(req.body||{});
        const nomes=novo.status.map(x=>x.nome.toLocaleLowerCase('pt-BR'));
        if(new Set(nomes).size!==nomes.length)return res.status(400).json({erro:'Não é permitido cadastrar status com nomes duplicados.'});
        const idsNovos=new Set(novo.status.map(x=>x.id));
        const removidos=(anterior.status||[]).map(x=>x.id).filter(id=>!idsNovos.has(id));
        if(removidos.length && ticketsColl) await ticketsColl.updateMany({internalStatusId:{$in:removidos}},{$unset:{internalStatusId:''},$set:{updatedAt:Date.now()}});
        await settingsColl.updateOne({_id:'ticket_parameters'},{$set:{...novo,updatedAt:Date.now()}},{upsert:true});
        ticketParametrosCache=novo;
        io.emit('ticket_parameters_updated',{status:statusTicketsAtivos(),updatedAt:Date.now()});
        res.json({ok:true,parametros:serializarParametrosTickets()});
    } catch(err){ console.error('[Ticket Params] Erro ao salvar:',err); res.status(500).json({erro:'Não foi possível salvar os parâmetros de tickets.'}); }
});

app.put('/api/tickets/:ticketNumber/internal-status', async (req,res)=>{
    try {
        const ticketNumber=String(req.params.ticketNumber||'').trim();
        const solicitado=String(req.body?.statusId||'').trim();
        if(solicitado && !statusTicketPorId(solicitado))return res.status(400).json({erro:'Status interno inválido ou inativo.'});
        const update=solicitado?{$set:{internalStatusId:solicitado,updatedAt:Date.now()}}:{$unset:{internalStatusId:''},$set:{updatedAt:Date.now()}};
        const result=await ticketsColl.findOneAndUpdate({ticketNumber},update,{returnDocument:'after'});
        const ticket=result?.value||result;
        if(!ticket)return res.status(404).json({erro:'Ticket ativo não encontrado.'});
        const payload={ticketNumber,internalStatusId:ticket.internalStatusId||null,internalStatus:statusTicketPorId(ticket.internalStatusId)};
        io.emit('ticket_internal_status_updated',payload);
        res.json({ok:true,...payload});
    } catch(err){console.error('[Tickets] Erro status interno:',err);res.status(500).json({erro:'Não foi possível atualizar o status interno.'});}
});

// CRM - lista, indicadores e opções de preenchimento.
app.get('/api/crm/leads', async (req, res) => {
    if (!req.session.loggedIn) return res.status(401).send('Acesso negado');
    if (!crmLeadsColl) return res.status(503).json({ erro: 'CRM ainda não está disponível.' });

    try {
        // PERFORMANCE: a reconciliação de tickets antigos é uma rotina de consistência,
        // não deve bloquear a abertura do CRM. O fluxo normal já cria/sincroniza o lead
        // quando o ticket nasce; esta verificação fica em segundo plano e no máximo uma
        // vez a cada 5 minutos.
        reconciliarTicketsAnuncioNoCRMComThrottle();

        // Compatibilidade com o CRM legado: registros criados antes dos campos técnicos
        // `origemTipo`/`origemTecnica` podem deixar de aparecer se a lista de origens for
        // alterada posteriormente. Como `crm_leads` é uma coleção exclusivamente comercial,
        // carregamos a janela recente e excluímos apenas registros explicitamente marcados
        // como orgânicos. Assim nenhum lead histórico válido desaparece da tela.
        const leadsBrutos = await crmLeadsColl
            .find({})
            .sort({ updatedAt: -1, createdAt: -1 })
            .limit(3000)
            .toArray();
        const leads = leadsBrutos.filter(lead => {
            if (lead?.origemTipo === 'organico' || lead?.origemTecnica === 'organico') return false;
            if (leadCRMDeAnuncio(lead)) return true;
            // Leads legados que já possuem número CRM/ticket foram efetivamente cadastrados
            // na base comercial e devem continuar visíveis mesmo que a origem textual tenha
            // sido renomeada nos parâmetros.
            return !!(lead?.crmNumber || lead?.ticketNumber);
        });
        res.json({
            generatedAt: Date.now(),
            resumo: resumoCRM(leads),
            options: {
                status: nomesCRM('status'),
                statusMeta: (crmParametrosCache.status||[]).filter(x=>x.ativo!==false).map(({id,nome,tipo,ordem})=>({id,nome,tipo,ordem})),
                modelosCobranca: nomesCRM('modelosCobranca'),
                modelosCobrancaMeta: (crmParametrosCache.modelosCobranca||[]).filter(x=>x.ativo!==false).map(({id,nome,calculo,ordem})=>({id,nome,calculo,ordem})),
                motivosPerda: nomesCRM('motivosPerda'),
                origensAnuncio: nomesCRM('origensAnuncio')
            },
            leads: leads.map(serializarLeadCRM)
        });
    } catch (err) {
        console.error('[CRM] Erro ao carregar leads:', err);
        res.status(500).json({ erro: 'Não foi possível carregar o CRM.' });
    }
});

app.post('/api/crm/leads', async (req, res) => {
    if (!req.session.loggedIn) return res.status(401).send('Acesso negado');
    if (!crmLeadsColl) return res.status(503).json({ erro: 'CRM ainda não está disponível.' });

    try {
        const dados = normalizarLeadCRM(req.body || {});
        if (!dados.cliente) return res.status(400).json({ erro: 'Informe o nome do cliente/lead.' });
        if (!origemCRMDeAnuncioValida(dados.origem)) {
            return res.status(400).json({ erro: 'O CRM aceita somente leads originados de anúncios/mídia paga.' });
        }

        const agora = Date.now();
        const doc = {
            ...dados,
            origemTipo: 'anuncio',
            origemTecnica: 'manual_anuncio',
            crmNumber: await gerarNumeroCRM(),
            createdAt: agora,
            updatedAt: agora
        };
        const resultado = await crmLeadsColl.insertOne(doc);
        const salvo = { ...doc, _id: resultado.insertedId };
        io.emit('crm_updated', { action: 'created', id: String(resultado.insertedId) });
        res.status(201).json({ ok: true, lead: serializarLeadCRM(salvo) });
    } catch (err) {
        console.error('[CRM] Erro ao criar lead:', err);
        res.status(500).json({ erro: 'Não foi possível criar o lead.' });
    }
});

app.post('/api/crm/leads/from-ticket/:ticketNumber', async (req, res) => {
    if (!req.session.loggedIn) return res.status(401).send('Acesso negado');
    if (!crmLeadsColl || !ticketsColl) return res.status(503).json({ erro: 'CRM ainda não está disponível.' });

    try {
        const ticketNumber = textoCRM(req.params.ticketNumber, 80);
        const ticket = await ticketsColl.findOne({ ticketNumber });
        if (!ticket) return res.status(404).json({ erro: 'Ticket ativo não encontrado.' });
        if (ticket.origem !== 'lead_anuncio') {
            return res.status(400).json({ erro: 'Somente tickets originados de anúncio podem ser adicionados ao CRM.' });
        }

        // O botão agora funciona como criação/sincronização idempotente. Normalmente o lead
        // já terá sido criado automaticamente no momento em que o ticket nasceu.
        const resultado = await sincronizarLeadCRMDoTicket(ticket);
        if (!resultado?.ok || !resultado?.lead) {
            return res.status(500).json({ erro: 'Não foi possível sincronizar o ticket com o CRM.' });
        }

        res.status(resultado.created ? 201 : 200).json({
            ok: true,
            created: !!resultado.created,
            lead: serializarLeadCRM(resultado.lead)
        });
    } catch (err) {
        console.error('[CRM] Erro ao sincronizar lead a partir do ticket:', err);
        res.status(500).json({ erro: 'Não foi possível sincronizar o ticket com o CRM.' });
    }
});

app.put('/api/crm/leads/:id', async (req, res) => {
    if (!req.session.loggedIn) return res.status(401).send('Acesso negado');
    if (!crmLeadsColl) return res.status(503).json({ erro: 'CRM ainda não está disponível.' });

    try {
        const id = String(req.params.id || '').trim();
        if (!ObjectId.isValid(id)) return res.status(400).json({ erro: 'Lead inválido.' });
        const existente = await crmLeadsColl.findOne({ _id: new ObjectId(id) });
        if (!existente) return res.status(404).json({ erro: 'Lead não encontrado.' });

        if (!leadCRMDeAnuncio(existente)) {
            return res.status(403).json({ erro: 'Este registro não pertence ao CRM de leads de anúncios.' });
        }

        const dados = normalizarLeadCRM(req.body || {}, existente);
        if (!dados.cliente) return res.status(400).json({ erro: 'Informe o nome do cliente/lead.' });
        if (!origemCRMDeAnuncioValida(dados.origem)) {
            return res.status(400).json({ erro: 'O CRM aceita somente origens de anúncios/mídia paga.' });
        }

        await crmLeadsColl.updateOne(
            { _id: existente._id },
            { $set: { ...dados, origemTipo: 'anuncio', updatedAt: Date.now() } }
        );
        const atualizado = await crmLeadsColl.findOne({ _id: existente._id });
        io.emit('crm_updated', { action: 'updated', id });
        res.json({ ok: true, lead: serializarLeadCRM(atualizado) });
    } catch (err) {
        console.error('[CRM] Erro ao atualizar lead:', err);
        res.status(500).json({ erro: 'Não foi possível atualizar o lead.' });
    }
});

app.delete('/api/crm/leads/:id', async (req, res) => {
    if (!req.session.loggedIn) return res.status(401).send('Acesso negado');
    if (!crmLeadsColl) return res.status(503).json({ erro: 'CRM ainda não está disponível.' });

    try {
        const id = String(req.params.id || '').trim();
        if (!ObjectId.isValid(id)) return res.status(400).json({ erro: 'Lead inválido.' });
        const resultado = await crmLeadsColl.deleteOne({ _id: new ObjectId(id) });
        if (!resultado.deletedCount) return res.status(404).json({ erro: 'Lead não encontrado.' });
        io.emit('crm_updated', { action: 'deleted', id });
        res.json({ ok: true });
    } catch (err) {
        console.error('[CRM] Erro ao excluir lead:', err);
        res.status(500).json({ erro: 'Não foi possível excluir o lead.' });
    }
});

// -----------------------------------------------------------------------------
// CLIENTES E CONTATOS DO WHATSAPP
// -----------------------------------------------------------------------------
// O cadastro manual é sempre vinculado a um número de WhatsApp. Nome, CPF e os
// demais dados são opcionais. A lista de não cadastrados usa apenas metadados de
// tickets ativos e do histórico recente: não baixa mensagens, documentos ou mídias.
const CLIENTS_HISTORY_CONTACT_LIMIT = 1500;
const CLIENTS_MAX_OBSERVACOES = 6000;

function textoClientePainel(valor, max = 500) {
    return String(valor ?? '').trim().slice(0, max);
}

function valorEditavelCliente(body, chave, existente, padrao = '') {
    return Object.prototype.hasOwnProperty.call(body || {}, chave)
        ? body[chave]
        : (existente?.[chave] ?? padrao);
}

function cpfClientePainel(valor = '') {
    const cpf = String(valor || '').replace(/\D/g, '');
    if (!cpf) return null;
    if (!validarCPF(cpf)) {
        const erro = new Error('CPF inválido. Corrija o número ou deixe o campo em branco.');
        erro.statusCode = 400;
        throw erro;
    }
    return cpf;
}

function emailClientePainel(valor = '') {
    const email = textoClientePainel(valor, 240).toLowerCase();
    if (!email) return null;
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
        const erro = new Error('E-mail inválido.');
        erro.statusCode = 400;
        throw erro;
    }
    return email;
}

function nomePartesCliente(nomeCompleto = '') {
    const completo = textoClientePainel(nomeCompleto, 240).replace(/\s+/g, ' ');
    if (!completo) return { nomeCompleto: null, nome: null, sobrenome: null };
    const partes = completo.split(' ').filter(Boolean);
    return {
        nomeCompleto: completo,
        nome: partes[0] || completo,
        sobrenome: partes.length > 1 ? partes.slice(1).join(' ') : null
    };
}

function normalizarEnderecoCliente(endereco = {}) {
    const obj = endereco && typeof endereco === 'object' ? endereco : {};
    return {
        cep: String(obj.cep || '').replace(/\D/g, '').slice(0, 8) || null,
        logradouro: textoClientePainel(obj.logradouro, 300) || null,
        numero: textoClientePainel(obj.numero, 40) || null,
        complemento: textoClientePainel(obj.complemento, 180) || null,
        bairro: textoClientePainel(obj.bairro, 180) || null,
        cidade: textoClientePainel(obj.cidade, 180) || null,
        uf: textoClientePainel(obj.uf, 2).toUpperCase() || null
    };
}

function normalizarCadastroClientePainel(body = {}, existente = null) {
    const numeroBruto = valorEditavelCliente(body, 'whatsapp', existente, existente?.numeroReal || existente?.whatsapp || '');
    const numero = normalizarNumeroDigitadoCliente(numeroBruto);
    if (!numero) {
        const erro = new Error('Informe um número de WhatsApp válido com DDD.');
        erro.statusCode = 400;
        throw erro;
    }

    const nomePartes = nomePartesCliente(valorEditavelCliente(body, 'nomeCompleto', existente, existente?.nomeCompleto || ''));
    const cpf = cpfClientePainel(valorEditavelCliente(body, 'cpf', existente, existente?.cpf || ''));
    const enderecoEntrada = Object.prototype.hasOwnProperty.call(body || {}, 'endereco')
        ? body.endereco
        : (existente?.endereco || {});

    return {
        ...nomePartes,
        cpf,
        rg: textoClientePainel(valorEditavelCliente(body, 'rg', existente), 40) || null,
        email: emailClientePainel(valorEditavelCliente(body, 'email', existente)),
        dataNascimento: textoClientePainel(valorEditavelCliente(body, 'dataNascimento', existente), 10) || null,
        estadoCivil: textoClientePainel(valorEditavelCliente(body, 'estadoCivil', existente), 80) || null,
        profissao: textoClientePainel(valorEditavelCliente(body, 'profissao', existente), 160) || null,
        numeroReal: numero,
        whatsapp: numero,
        advogadoResponsavel: textoClientePainel(valorEditavelCliente(body, 'advogadoResponsavel', existente), 120) || null,
        endereco: normalizarEnderecoCliente(enderecoEntrada),
        observacoes: textoClientePainel(valorEditavelCliente(body, 'observacoes', existente), CLIENTS_MAX_OBSERVACOES) || null
    };
}

function filtrosDocumentoPorWhatsApp(numero, identificadoresExtras = []) {
    const pnJid = numero ? `${numero}@s.whatsapp.net` : null;
    const identificadores = [...new Set([
        pnJid,
        ...(Array.isArray(identificadoresExtras) ? identificadoresExtras : [])
    ].filter(Boolean))];

    const filtros = [];
    if (numero) {
        filtros.push({ numeroReal: numero });
        filtros.push({ whatsappNumbers: numero });
    }
    if (identificadores.length) {
        filtros.push({ identificadores: { $in: identificadores } });
        filtros.push({ lastRawJid: { $in: identificadores } });
    }
    return filtros;
}

function clienteIdParaResposta(cliente) {
    return cliente?._id !== undefined && cliente?._id !== null ? String(cliente._id) : '';
}

async function buscarClientePorIdPainel(id = '') {
    const bruto = String(id || '').trim();
    if (!bruto) return null;
    const cpf = bruto.replace(/\D/g, '');
    const filtros = [{ _id: bruto }];
    if (cpf.length === 11) filtros.push({ cpf });
    return clientsColl.findOne({ $or: filtros });
}

async function buscarDadosContatoPorNumero(numero, sourceTicketNumber = null) {
    const filtros = filtrosDocumentoPorWhatsApp(numero);
    if (sourceTicketNumber) filtros.push({ ticketNumber: textoClientePainel(sourceTicketNumber, 80) });
    if (!filtros.length) {
        return { identificadores: [], whatsappNumbers: [numero], ticketNumbers: [], lastSeenAt: null };
    }

    const projection = {
        ticketNumber: 1,
        identificadores: 1,
        whatsappNumbers: 1,
        numeroReal: 1,
        lastRawJid: 1,
        lastActivity: 1,
        createdAt: 1,
        updatedAt: 1
    };

    const [ativos, historicos] = await Promise.all([
        ticketsColl ? ticketsColl.find({ $or: filtros }, { projection }).limit(100).toArray() : [],
        ticketHistoryColl ? ticketHistoryColl.find({ $or: filtros }, { projection }).sort({ updatedAt: -1 }).limit(100).toArray() : []
    ]);

    const todos = [...ativos, ...historicos];
    const identificadores = new Set([`${numero}@s.whatsapp.net`]);
    const numeros = new Set([numero]);
    const ticketNumbers = new Set();
    let lastSeenAt = null;

    for (const registro of todos) {
        if (registro.ticketNumber) ticketNumbers.add(String(registro.ticketNumber));
        for (const id of Array.isArray(registro.identificadores) ? registro.identificadores : []) {
            if (id) identificadores.add(String(id));
        }
        if (registro.lastRawJid) identificadores.add(String(registro.lastRawJid));
        for (const n of Array.isArray(registro.whatsappNumbers) ? registro.whatsappNumbers : []) {
            const normalizado = normalizarNumeroWhatsApp(n);
            if (normalizado) numeros.add(normalizado);
        }
        const real = normalizarNumeroWhatsApp(registro.numeroReal);
        if (real) numeros.add(real);
        const data = Number(registro.lastActivity || registro.updatedAt || registro.createdAt || 0) || 0;
        if (data && (!lastSeenAt || data > lastSeenAt)) lastSeenAt = data;
    }

    return {
        identificadores: [...identificadores],
        whatsappNumbers: [...numeros],
        ticketNumbers: [...ticketNumbers],
        lastSeenAt
    };
}

async function vincularClienteAosTickets(cliente) {
    if (!cliente) return;
    const numero = normalizarNumeroWhatsApp(cliente.numeroReal || cliente.whatsapp);
    const identificadores = Array.isArray(cliente.identificadores) ? cliente.identificadores : [];
    const filtros = filtrosDocumentoPorWhatsApp(numero, identificadores);
    if (!filtros.length) return;

    const clienteId = clienteIdParaResposta(cliente);
    const sets = {
        clienteId,
        clienteCadastrado: true,
        numeroReal: numero || cliente.numeroReal || null,
        updatedAt: Date.now()
    };
    if (cliente.nomeCompleto) sets.clienteNome = cliente.nomeCompleto;
    if (cliente.cpf) sets.cpf = cliente.cpf;
    if (cliente.advogadoResponsavel) sets.advogadoResponsavel = cliente.advogadoResponsavel;

    const tarefas = [];
    if (ticketsColl) tarefas.push(ticketsColl.updateMany({ $or: filtros }, { $set: sets }));
    if (ticketHistoryColl) tarefas.push(ticketHistoryColl.updateMany({ $or: filtros }, { $set: sets }));
    await Promise.allSettled(tarefas);
}

async function listarContatosNaoCadastrados(clientes = []) {
    const numerosCadastrados = new Set();
    const idsCadastrados = new Set();

    for (const cliente of clientes) {
        const numero = normalizarNumeroWhatsApp(cliente.whatsapp || cliente.numeroReal || cliente.whatsappNumbers?.[0]);
        if (numero) numerosCadastrados.add(numero);
        for (const n of Array.isArray(cliente.whatsappNumbers) ? cliente.whatsappNumbers : []) {
            const normalizado = normalizarNumeroWhatsApp(n);
            if (normalizado) numerosCadastrados.add(normalizado);
        }
        for (const id of Array.isArray(cliente.identificadores) ? cliente.identificadores : []) {
            if (id) idsCadastrados.add(String(id));
        }
        if (cliente.lastRawJid) idsCadastrados.add(String(cliente.lastRawJid));
    }

    const projection = {
        ticketNumber: 1,
        clienteNome: 1,
        cpf: 1,
        numeroReal: 1,
        whatsappNumbers: 1,
        identificadores: 1,
        lastRawJid: 1,
        area: 1,
        createdAt: 1,
        lastActivity: 1,
        updatedAt: 1
    };

    const [ativos, historicos] = await Promise.all([
        ticketsColl ? ticketsColl.find({}, { projection }).sort({ lastActivity: -1 }).toArray() : [],
        ticketHistoryColl ? ticketHistoryColl.find({}, { projection }).sort({ updatedAt: -1 }).limit(CLIENTS_HISTORY_CONTACT_LIMIT).toArray() : []
    ]);

    const porNumero = new Map();
    for (const registro of [...ativos, ...historicos]) {
        const numero = whatsappDoTicket(registro);
        if (!numero || numerosCadastrados.has(numero)) continue;

        const idsRegistro = [
            ...(Array.isArray(registro.identificadores) ? registro.identificadores : []),
            registro.lastRawJid
        ].filter(Boolean).map(String);
        if (idsRegistro.some(id => idsCadastrados.has(id))) continue;

        const dataContato = Number(registro.lastActivity || registro.updatedAt || registro.createdAt || 0) || 0;
        const atual = porNumero.get(numero);
        if (!atual) {
            porNumero.set(numero, {
                id: `unregistered_${numero}`,
                cadastrado: false,
                origemCadastro: 'whatsapp_nao_cadastrado',
                nomeCompleto: registro.clienteNome || null,
                cpf: registro.cpf || null,
                whatsapp: numero,
                numeroReal: numero,
                advogadoResponsavel: null,
                areaUltimoAtendimento: registro.area || null,
                ultimoTicket: registro.ticketNumber || null,
                ticketNumbers: registro.ticketNumber ? [registro.ticketNumber] : [],
                lastSeenAt: dataContato || null
            });
        } else {
            if (registro.ticketNumber && !atual.ticketNumbers.includes(registro.ticketNumber)) {
                atual.ticketNumbers.push(registro.ticketNumber);
            }
            if (dataContato > Number(atual.lastSeenAt || 0)) {
                atual.lastSeenAt = dataContato;
                atual.ultimoTicket = registro.ticketNumber || atual.ultimoTicket;
                atual.areaUltimoAtendimento = registro.area || atual.areaUltimoAtendimento;
                if (!atual.nomeCompleto && registro.clienteNome) atual.nomeCompleto = registro.clienteNome;
                if (!atual.cpf && registro.cpf) atual.cpf = registro.cpf;
            }
        }
    }

    return [...porNumero.values()]
        .sort((a, b) => Number(b.lastSeenAt || 0) - Number(a.lastSeenAt || 0));
}

function projecaoClientePainel() {
    return {
        cpf: 1,
        nome: 1,
        sobrenome: 1,
        nomeCompleto: 1,
        rg: 1,
        email: 1,
        dataNascimento: 1,
        estadoCivil: 1,
        profissao: 1,
        numeroReal: 1,
        whatsapp: 1,
        whatsappNumbers: 1,
        identificadores: 1,
        lastRawJid: 1,
        ticketNumbers: 1,
        endereco: 1,
        advogadoResponsavel: 1,
        observacoes: 1,
        cadastroManual: 1,
        origemCadastro: 1,
        ativo: 1,
        createdAt: 1,
        updatedAt: 1,
        lastSeenAt: 1
    };
}

// Lista os cadastros e também os números que já falaram com o escritório, mas
// ainda não possuem registro em client_registry.
app.get('/api/clients', async (req, res) => {
    if (!req.session.loggedIn) return res.status(401).send('Acesso negado');
    if (!clientsColl) return res.status(503).json({ erro: 'Banco de dados ainda não está disponível.' });

    try {
        const clientes = await clientsColl.find(
            { ativo: { $ne: false } },
            { projection: projecaoClientePainel() }
        ).sort({ updatedAt: -1, lastSeenAt: -1, createdAt: -1 }).toArray();

        const clientesComWhatsApp = await Promise.all(
            clientes.map(async cliente => ({
                ...cliente,
                id: clienteIdParaResposta(cliente),
                cadastrado: true,
                whatsapp: await resolverWhatsAppCliente(cliente)
            }))
        );

        const naoCadastrados = await listarContatosNaoCadastrados(clientesComWhatsApp);
        res.json({
            clientes: clientesComWhatsApp,
            naoCadastrados,
            resumo: {
                cadastrados: clientesComWhatsApp.length,
                naoCadastrados: naoCadastrados.length,
                total: clientesComWhatsApp.length + naoCadastrados.length
            }
        });
    } catch (err) {
        console.error('[Clientes] Erro ao carregar clientes:', err);
        res.status(500).json({ erro: 'Não foi possível carregar clientes e contatos.' });
    }
});

// Cadastro manual a partir de um número já visto ou de um número digitado pelo advogado.
app.post('/api/clients/manual', async (req, res) => {
    if (!req.session.loggedIn) return res.status(401).send('Acesso negado');
    if (!clientsColl) return res.status(503).json({ erro: 'Banco de dados ainda não está disponível.' });

    try {
        const dados = normalizarCadastroClientePainel(req.body || {});
        const numero = dados.numeroReal;
        const filtrosNumero = filtrosDocumentoPorWhatsApp(numero);
        const existenteNumero = filtrosNumero.length ? await clientsColl.findOne({ $or: filtrosNumero }) : null;
        if (existenteNumero) {
            return res.status(409).json({ erro: 'Este WhatsApp já está vinculado a um cliente cadastrado.' });
        }

        if (dados.cpf) {
            const existenteCPF = await clientsColl.findOne({ cpf: dados.cpf });
            if (existenteCPF) return res.status(409).json({ erro: 'Este CPF já está vinculado a outro cliente cadastrado.' });
        }

        const origem = await buscarDadosContatoPorNumero(numero, req.body?.sourceTicketNumber || null);
        const agora = Date.now();
        const documento = {
            _id: `cli_${new ObjectId().toString()}`,
            ...dados,
            cadastroManual: true,
            origemCadastro: 'painel_manual',
            ativo: true,
            identificadores: origem.identificadores,
            whatsappNumbers: origem.whatsappNumbers,
            ticketNumbers: origem.ticketNumbers,
            lastRawJid: origem.identificadores.find(id => String(id).includes('@')) || `${numero}@s.whatsapp.net`,
            createdAt: agora,
            updatedAt: agora,
            lastSeenAt: origem.lastSeenAt || agora
        };
        // O índice de CPF é unique+sparse. Campo ausente é permitido em vários
        // clientes; cpf:null não é seguro em versões/configurações antigas do MongoDB.
        if (!documento.cpf) delete documento.cpf;

        await clientsColl.insertOne(documento);
        await vincularClienteAosTickets(documento);
        io.emit('clients_updated', { action: 'created', id: String(documento._id) });

        res.status(201).json({
            ok: true,
            cliente: { ...documento, id: String(documento._id), cadastrado: true, whatsapp: numero }
        });
    } catch (err) {
        console.error('[Clientes] Erro ao cadastrar cliente manualmente:', err);
        res.status(err.statusCode || (err?.code === 11000 ? 409 : 500)).json({
            erro: err?.code === 11000 ? 'CPF ou identificador já vinculado a outro cadastro.' : (err.message || 'Não foi possível cadastrar o cliente.')
        });
    }
});

// Atualiza dados cadastrais. Todos os campos, exceto WhatsApp, podem ser esvaziados.
app.put('/api/clients/:id', async (req, res) => {
    if (!req.session.loggedIn) return res.status(401).send('Acesso negado');
    if (!clientsColl) return res.status(503).json({ erro: 'Banco de dados ainda não está disponível.' });

    try {
        const existente = await buscarClientePorIdPainel(req.params.id);
        if (!existente) return res.status(404).json({ erro: 'Cliente não encontrado.' });

        const dados = normalizarCadastroClientePainel(req.body || {}, existente);
        const filtrosNumero = filtrosDocumentoPorWhatsApp(dados.numeroReal);
        if (filtrosNumero.length) {
            const duplicadoNumero = await clientsColl.findOne({
                $and: [{ _id: { $ne: existente._id } }, { $or: filtrosNumero }]
            });
            if (duplicadoNumero) return res.status(409).json({ erro: 'Este WhatsApp já está vinculado a outro cliente cadastrado.' });
        }

        if (dados.cpf) {
            const duplicadoCPF = await clientsColl.findOne({ cpf: dados.cpf, _id: { $ne: existente._id } });
            if (duplicadoCPF) return res.status(409).json({ erro: 'Este CPF já está vinculado a outro cliente cadastrado.' });
        }

        const origem = await buscarDadosContatoPorNumero(dados.numeroReal, req.body?.sourceTicketNumber || null);
        const agora = Date.now();
        const sets = {
            ...dados,
            cadastroManual: existente.cadastroManual === true || existente.origemCadastro === 'painel_manual',
            origemCadastro: existente.origemCadastro || 'whatsapp',
            ativo: true,
            updatedAt: agora
        };
        const update = {
            $set: sets,
            $addToSet: {
                identificadores: { $each: origem.identificadores },
                whatsappNumbers: { $each: origem.whatsappNumbers },
                ticketNumbers: { $each: origem.ticketNumbers }
            }
        };
        if (!dados.cpf) {
            delete sets.cpf;
            update.$unset = { cpf: '' };
        }

        await clientsColl.updateOne({ _id: existente._id }, update);
        const atualizado = await clientsColl.findOne({ _id: existente._id }, { projection: projecaoClientePainel() });
        await vincularClienteAosTickets(atualizado);
        io.emit('clients_updated', { action: 'updated', id: String(existente._id) });

        res.json({
            ok: true,
            cliente: { ...atualizado, id: String(atualizado._id), cadastrado: true, whatsapp: await resolverWhatsAppCliente(atualizado) }
        });
    } catch (err) {
        console.error('[Clientes] Erro ao atualizar cliente:', err);
        res.status(err.statusCode || (err?.code === 11000 ? 409 : 500)).json({
            erro: err?.code === 11000 ? 'CPF ou identificador já vinculado a outro cadastro.' : (err.message || 'Não foi possível atualizar o cliente.')
        });
    }
});

// Exclui o cadastro, preservando o histórico dos atendimentos.
app.delete('/api/clients/:id', async (req, res) => {
    if (!req.session.loggedIn) return res.status(401).send('Acesso negado');
    if (!clientsColl) return res.status(503).json({ erro: 'Banco de dados ainda não está disponível.' });

    try {
        const existente = await buscarClientePorIdPainel(req.params.id);
        if (!existente) return res.status(404).json({ erro: 'Cliente não encontrado.' });

        const result = await clientsColl.deleteOne({ _id: existente._id });
        if (!result.deletedCount) return res.status(404).json({ erro: 'Cliente não encontrado.' });

        if (ticketsColl) {
            const filtros = [{ clienteId: String(existente._id) }];
            if (existente.cpf) filtros.push({ cpf: existente.cpf });
            const numero = normalizarNumeroWhatsApp(existente.numeroReal || existente.whatsapp);
            if (numero) filtros.push(...filtrosDocumentoPorWhatsApp(numero, existente.identificadores || []));

            await ticketsColl.updateMany(
                { $or: filtros },
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

        io.emit('clients_updated', { action: 'deleted', id: String(existente._id) });
        res.json({ ok: true });
    } catch (err) {
        console.error('[Clientes] Erro ao remover cliente:', err);
        res.status(500).json({ erro: 'Não foi possível remover o cliente.' });
    }
});

app.get('/api/knowledgeColl', async (req, res) => {
    if (!req.session.loggedIn) return res.status(401).send('Acesso negado');
    try {
        const data = await knowledgeColl.find({}).sort({ updatedAt: -1, createdAt: -1 }).toArray();
        res.json(data);
    } catch (err) {
        console.error('[IA] Erro ao listar base:', err);
        res.status(500).json({ erro: 'Não foi possível carregar a base de conhecimento.' });
    }
});

function normalizarPalavrasChaveKnowledge(valor) {
    const lista = Array.isArray(valor) ? valor : String(valor || '').split(',');
    return [...new Set(lista.map(item => String(item || '').trim()).filter(Boolean))].slice(0, 30);
}
function normalizarVariacoesKnowledge(valor) {
    const lista = Array.isArray(valor) ? valor : String(valor || '').split(/\n|;/);
    return [...new Set(lista.map(item => String(item || '').trim()).filter(Boolean))].slice(0, 20);
}
function documentoKnowledgeDoBody(body = {}, existente = null) {
    return {
        pergunta: String(body.pergunta ?? existente?.pergunta ?? '').trim().slice(0, 500),
        resposta: String(body.resposta ?? existente?.resposta ?? '').trim().slice(0, 5000),
        palavrasChave: normalizarPalavrasChaveKnowledge(body.palavrasChave ?? existente?.palavrasChave ?? []),
        variacoesPergunta: normalizarVariacoesKnowledge(body.variacoesPergunta ?? existente?.variacoesPergunta ?? []),
        prioridade: Math.max(1, Math.min(5, Number(body.prioridade ?? existente?.prioridade ?? 3) || 3)),
        ativo: body.ativo !== undefined ? body.ativo !== false : existente?.ativo !== false
    };
}

app.post('/api/knowledgeColl/suggest', async (req, res) => {
    if (!req.session.loggedIn) return res.status(401).send('Acesso negado');
    if (!geminiModel) return res.status(503).json({ erro: 'A IA não está disponível no momento.' });
    try {
        const pergunta = String(req.body?.pergunta || '').trim().slice(0, 500);
        const resposta = String(req.body?.resposta || '').trim().slice(0, 5000);
        const palavrasChave = normalizarPalavrasChaveKnowledge(req.body?.palavrasChave || []);
        const modo = String(req.body?.modo || 'melhorar') === 'regenerar' ? 'regenerar' : 'melhorar';
        if (!pergunta) return res.status(400).json({ erro: 'Informe o título/pergunta principal.' });
        if (!resposta) return res.status(400).json({ erro: 'Insira primeiro o texto da resposta aprovada para a IA revisar.' });

        const prompt = `Você é um revisor de uma BASE DE CONHECIMENTO de atendimento jurídico por WhatsApp.

TÍTULO/PERGUNTA PRINCIPAL:
${JSON.stringify(pergunta)}

TEXTO FORNECIDO PELO USUÁRIO:
${JSON.stringify(resposta)}

PALAVRAS-CHAVE ATUAIS:
${JSON.stringify(palavrasChave)}

MODO: ${modo}

Crie uma sugestão de resposta padrão mais clara, humana, acolhedora e profissional, adequada a WhatsApp. A sugestão será APENAS uma proposta: um usuário humano decidirá se aprova.

Retorne SOMENTE JSON válido:
{
  "respostaSugerida":"...",
  "palavrasChaveSugeridas":["..."],
  "variacoesPergunta":["..."],
  "validacao":"APROVAVEL|REVISAR",
  "observacao":"..."
}

REGRAS OBRIGATÓRIAS:
1. Use EXCLUSIVAMENTE os fatos presentes no texto fornecido. Não acrescente lei, prazo, valor, promessa, nome, área de atuação ou qualquer fato não informado.
2. Preserve ressalvas, condições e limites do texto original.
3. Se o texto original contiver afirmação ambígua, arriscada ou incompleta, não invente a solução: marque validacao=REVISAR e explique brevemente em observacao.
4. A resposta deve soar natural e humana, sem linguagem de robô e sem dizer que é uma IA.
5. Prefira 1 a 3 parágrafos curtos. Não prometa resultado jurídico.
6. Em modo regenerar, produza uma redação diferente da versão anterior, sem mudar o conteúdo factual.
7. Gere de 6 a 15 palavras/expressões de busca realmente úteis, incluindo sinônimos naturais.
8. Gere de 6 a 12 formas diferentes pelas quais um cliente real poderia fazer a mesma pergunta, inclusive linguagem informal, abreviações e pequenos erros comuns de digitação.
9. As variações servem apenas para localizar este conhecimento; não devem inventar assuntos novos.`;

        const result = await geminiModel.generateContent(prompt);
        const parsed = extrairJsonIA((await result.response).text());
        const sugestao = String(parsed?.respostaSugerida || '').trim().slice(0, 5000);
        if (!sugestao) throw new Error('A IA não retornou uma sugestão válida.');
        res.json({
            respostaSugerida: sugestao,
            palavrasChaveSugeridas: normalizarPalavrasChaveKnowledge(parsed?.palavrasChaveSugeridas || []),
            variacoesPergunta: normalizarVariacoesKnowledge(parsed?.variacoesPergunta || []),
            validacao: String(parsed?.validacao || 'APROVAVEL').toUpperCase() === 'REVISAR' ? 'REVISAR' : 'APROVAVEL',
            observacao: String(parsed?.observacao || '').trim().slice(0, 600)
        });
    } catch (err) {
        console.error('[IA] Erro ao sugerir melhoria da base:', err);
        res.status(500).json({ erro: err?.message || 'Não foi possível gerar a sugestão.' });
    }
});

function normalizarUrlsFonteWebKnowledge(valor, existente = null) {
    let entradas = [];
    if (Array.isArray(valor)) entradas = valor;
    else if (typeof valor === 'string') entradas = valor.split(/\r?\n|,/g);
    else if (Array.isArray(existente?.urls) && existente.urls.length) entradas = existente.urls;
    else if (existente?.url) entradas = [existente.url];
    return [...new Set(entradas.map(v => String(v || '').trim()).filter(Boolean))].slice(0, KNOWLEDGE_WEB_MAX_PAGES);
}

function documentoFonteWebKnowledge(body = {}, existente = null) {
    const urls = normalizarUrlsFonteWebKnowledge(body.urls ?? body.url, existente);
    return {
        nome: String(body.nome ?? existente?.nome ?? '').trim().slice(0, 140),
        urls,
        url: String(urls[0] || '').trim().slice(0, 1800),
        maxPages: urls.length || 1,
        ativo: body.ativo !== undefined ? body.ativo !== false : existente?.ativo !== false
    };
}

app.get('/api/knowledgeWebSources', async (req, res) => {
    if (!req.session.loggedIn) return res.status(401).send('Acesso negado');
    if (!knowledgeWebSourcesColl) return res.json([]);
    try {
        const data = await knowledgeWebSourcesColl.find({}).sort({ updatedAt: -1, createdAt: -1 }).toArray();
        res.json(data.map(item => {
            if (Number(item.discoveryVersion || 0) >= KNOWLEDGE_WEB_DISCOVERY_VERSION) return item;
            return {
                ...item,
                webSummary: item.lastSyncAt ? 'Esta fonte precisa ser revisada e sincronizada novamente usando apenas as páginas informadas manualmente.' : (item.webSummary || ''),
                webPagesAnalysis: [],
                knowledgeSuggestions: [],
                suggestionsStatus: item.lastSyncAt ? 'requer_ressincronizacao' : item.suggestionsStatus
            };
        }));
    } catch (err) {
        res.status(500).json({ erro: 'Não foi possível carregar as fontes do site.' });
    }
});

app.post('/api/knowledgeWebSources', async (req, res) => {
    if (!req.session.loggedIn) return res.status(401).send('Acesso negado');
    try {
        const doc = documentoFonteWebKnowledge(req.body || {});
        if (!doc.nome || !doc.urls.length) return res.status(400).json({ erro: 'Informe um nome e ao menos uma página pública.' });
        const urlsValidadas = [];
        for (const valor of doc.urls) urlsValidadas.push((await validarUrlPublicaKnowledgeWeb(valor)).toString());
        doc.urls = [...new Set(urlsValidadas)];
        doc.url = doc.urls[0];
        doc.maxPages = doc.urls.length;
        const agora = Date.now();
        const result = await knowledgeWebSourcesColl.insertOne({ ...doc, pageCount: 0, lastSyncStatus: 'nunca', webSummary: '', webPagesAnalysis: [], knowledgeSuggestions: [], principalUrls: [], discoveryVersion: 0, ignoredPageCount: 0, suggestionsStatus: 'nunca', suggestionsGeneratedAt: null, suggestionsError: '', createdAt: agora, updatedAt: agora });
        invalidarCacheKnowledgeWeb();
        res.status(201).json({ ok: true, id: String(result.insertedId) });
    } catch (err) {
        if (err?.code === 11000) return res.status(409).json({ erro: 'Este site já está cadastrado como fonte.' });
        res.status(400).json({ erro: err?.message || 'Não foi possível cadastrar a fonte.' });
    }
});

app.put('/api/knowledgeWebSources/:id', async (req, res) => {
    if (!req.session.loggedIn) return res.status(401).send('Acesso negado');
    try {
        const id = new ObjectId(String(req.params.id || ''));
        const existente = await knowledgeWebSourcesColl.findOne({ _id: id });
        if (!existente) return res.status(404).json({ erro: 'Fonte não encontrada.' });
        const doc = documentoFonteWebKnowledge(req.body || {}, existente);
        if (!doc.nome || !doc.urls.length) return res.status(400).json({ erro: 'Informe um nome e ao menos uma página pública.' });
        const urlsValidadas = [];
        for (const valor of doc.urls) urlsValidadas.push((await validarUrlPublicaKnowledgeWeb(valor)).toString());
        doc.urls = [...new Set(urlsValidadas)];
        doc.url = doc.urls[0];
        doc.maxPages = doc.urls.length;
        const urlsExistentes = normalizarUrlsFonteWebKnowledge(existente?.urls || existente?.url);
        const mudouUrl = JSON.stringify(doc.urls) !== JSON.stringify(urlsExistentes);
        await knowledgeWebSourcesColl.updateOne({ _id: id }, { $set: { ...doc, ...(mudouUrl ? { pageCount: 0, ignoredPageCount: 0, discoveryVersion: 0, principalUrls: [], lastSyncStatus: 'nunca', lastSyncAt: null, lastError: '', webSummary: '', webPagesAnalysis: [], knowledgeSuggestions: [], suggestionsStatus: 'nunca', suggestionsGeneratedAt: null, suggestionsError: '' } : {}), updatedAt: Date.now() } });
        if (mudouUrl) await knowledgeWebPagesColl.deleteMany({ sourceId: id });
        invalidarCacheKnowledgeWeb();
        res.json({ ok: true });
    } catch (err) {
        if (err?.code === 11000) return res.status(409).json({ erro: 'Este site já está cadastrado como fonte.' });
        res.status(400).json({ erro: err?.message || 'Não foi possível editar a fonte.' });
    }
});

app.delete('/api/knowledgeWebSources/:id', async (req, res) => {
    if (!req.session.loggedIn) return res.status(401).send('Acesso negado');
    try {
        const id = new ObjectId(String(req.params.id || ''));
        const [sourceResult] = await Promise.all([
            knowledgeWebSourcesColl.deleteOne({ _id: id }),
            knowledgeWebPagesColl.deleteMany({ sourceId: id })
        ]);
        if (!sourceResult.deletedCount) return res.status(404).json({ erro: 'Fonte não encontrada.' });
        invalidarCacheKnowledgeWeb();
        res.json({ ok: true });
    } catch (err) {
        res.status(400).json({ erro: 'Não foi possível excluir a fonte.' });
    }
});

app.post('/api/knowledgeWebSources/:id/sync', async (req, res) => {
    if (!req.session.loggedIn) return res.status(401).send('Acesso negado');
    let id;
    try {
        id = new ObjectId(String(req.params.id || ''));
        const source = await knowledgeWebSourcesColl.findOne({ _id: id });
        if (!source) return res.status(404).json({ erro: 'Fonte não encontrada.' });
        await knowledgeWebSourcesColl.updateOne({ _id: id }, { $set: { lastSyncStatus: 'sincronizando', updatedAt: Date.now() } });
        const resultado = await sincronizarFonteKnowledgeWeb(source);
        let sugestoesResultado = null;
        let sugestoesErro = '';
        if (geminiModel) {
            try {
                sugestoesResultado = await gerarSugestoesKnowledgeWeb(source);
            } catch (erroSugestoes) {
                sugestoesErro = String(erroSugestoes?.message || erroSugestoes).slice(0, 1000);
                await knowledgeWebSourcesColl.updateOne(
                    { _id: id },
                    { $set: { suggestionsStatus: 'erro', suggestionsError: sugestoesErro, updatedAt: Date.now() } }
                ).catch(() => {});
            }
        }
        io.emit('knowledge_web_updated', { sourceId: String(id), pageCount: resultado.pageCount, ignoredPageCount: resultado.ignoredPageCount || 0, suggestionsCount: sugestoesResultado?.suggestionsCount || 0, syncedAt: Date.now() });
        res.json({ ok: true, ...resultado, suggestionsCount: sugestoesResultado?.suggestionsCount || 0, suggestionsError: sugestoesErro || null });
    } catch (err) {
        if (id && knowledgeWebSourcesColl) {
            await knowledgeWebSourcesColl.updateOne({ _id: id }, { $set: { lastSyncStatus: 'erro', lastError: String(err?.message || err).slice(0, 1000), updatedAt: Date.now() } }).catch(() => {});
        }
        res.status(400).json({ erro: err?.message || 'Não foi possível sincronizar o site.' });
    }
});

app.post('/api/knowledgeWebSources/:id/generate-suggestions', async (req, res) => {
    if (!req.session.loggedIn) return res.status(401).send('Acesso negado');
    try {
        const id = new ObjectId(String(req.params.id || ''));
        const source = await knowledgeWebSourcesColl.findOne({ _id: id });
        if (!source) return res.status(404).json({ erro: 'Fonte não encontrada.' });
        await knowledgeWebSourcesColl.updateOne({ _id: id }, { $set: { suggestionsStatus: 'gerando', suggestionsError: '', updatedAt: Date.now() } });
        const resultado = await gerarSugestoesKnowledgeWeb(source);
        io.emit('knowledge_web_updated', { sourceId: String(id), suggestionsCount: resultado.suggestionsCount, suggestionsGeneratedAt: resultado.generatedAt });
        res.json({ ok: true, ...resultado });
    } catch (err) {
        const idRaw = String(req.params.id || '');
        if (ObjectId.isValid(idRaw)) {
            await knowledgeWebSourcesColl.updateOne(
                { _id: new ObjectId(idRaw) },
                { $set: { suggestionsStatus: 'erro', suggestionsError: String(err?.message || err).slice(0, 1000), updatedAt: Date.now() } }
            ).catch(() => {});
        }
        res.status(400).json({ erro: err?.message || 'Não foi possível gerar sugestões do site.' });
    }
});

app.post('/api/knowledgeWebSources/:id/suggestions/:suggestionId/status', async (req, res) => {
    if (!req.session.loggedIn) return res.status(401).send('Acesso negado');
    try {
        const id = new ObjectId(String(req.params.id || ''));
        const suggestionId = String(req.params.suggestionId || '').trim();
        const status = ['pendente', 'adicionado', 'ignorado'].includes(String(req.body?.status || '')) ? String(req.body.status) : 'pendente';
        const result = await knowledgeWebSourcesColl.updateOne(
            { _id: id, 'knowledgeSuggestions.id': suggestionId },
            { $set: { 'knowledgeSuggestions.$.status': status, 'knowledgeSuggestions.$.statusUpdatedAt': Date.now(), updatedAt: Date.now() } }
        );
        if (!result.matchedCount) return res.status(404).json({ erro: 'Sugestão não encontrada.' });
        io.emit('knowledge_web_updated', { sourceId: String(id), suggestionId, status });
        res.json({ ok: true });
    } catch (err) {
        res.status(400).json({ erro: 'Não foi possível atualizar a sugestão.' });
    }
});

app.get('/api/knowledgeColl/gaps', async (req, res) => {
    if (!req.session.loggedIn) return res.status(401).send('Acesso negado');
    if (!knowledgeGapsColl) return res.json([]);
    try {
        const items = await knowledgeGapsColl.find({ resolvido: { $ne: true } })
            .sort({ ocorrencias: -1, lastSeenAt: -1 })
            .limit(30)
            .toArray();
        res.json(items);
    } catch (err) {
        res.status(500).json({ erro: 'Não foi possível carregar as dúvidas para ensinar.' });
    }
});

app.post('/api/knowledgeColl/gaps/:id/link', async (req, res) => {
    if (!req.session.loggedIn) return res.status(401).send('Acesso negado');
    if (!knowledgeGapsColl || !knowledgeColl) return res.status(503).json({ erro: 'Base de conhecimento indisponível.' });
    try {
        const gapId = new ObjectId(String(req.params.id || ''));
        const knowledgeId = new ObjectId(String(req.body?.knowledgeId || ''));
        const [gap, knowledge] = await Promise.all([
            knowledgeGapsColl.findOne({ _id: gapId, resolvido: { $ne: true } }),
            knowledgeColl.findOne({ _id: knowledgeId, ativo: { $ne: false } })
        ]);
        if (!gap) return res.status(404).json({ erro: 'Dúvida pendente não encontrada.' });
        if (!knowledge) return res.status(404).json({ erro: 'Conhecimento ativo não encontrado.' });

        const perguntaOriginal = String(gap.textoExemplo || '').trim().slice(0, 500);
        if (!perguntaOriginal) return res.status(400).json({ erro: 'A dúvida não possui texto para vincular.' });
        const palavraChave = perguntaOriginal.replace(/[?!.,;:]+$/g, '').trim();
        const palavrasChave = normalizarPalavrasChaveKnowledge([
            palavraChave,
            ...(Array.isArray(knowledge.palavrasChave) ? knowledge.palavrasChave : [])
        ]);
        const variacoesPergunta = normalizarVariacoesKnowledge([
            perguntaOriginal,
            ...(Array.isArray(knowledge.variacoesPergunta) ? knowledge.variacoesPergunta : [])
        ]);
        const agora = Date.now();

        await Promise.all([
            knowledgeColl.updateOne(
                { _id: knowledgeId },
                { $set: { palavrasChave, variacoesPergunta, updatedAt: agora } }
            ),
            knowledgeGapsColl.updateOne(
                { _id: gapId },
                { $set: {
                    resolvido: true,
                    resolvidoEm: agora,
                    resolvidoTipo: 'vinculado',
                    knowledgeId,
                    knowledgePergunta: knowledge.pergunta || '',
                    updatedAt: agora
                } }
            )
        ]);
        invalidarCacheKnowledge();
        io.emit('knowledge_updated', { action: 'gap_linked', knowledgeId: String(knowledgeId), gapId: String(gapId) });
        res.json({ ok: true, palavraChave, conhecimento: { id: String(knowledgeId), pergunta: knowledge.pergunta || '' } });
    } catch (err) {
        console.error('[IA] Erro ao vincular dúvida a conhecimento:', err);
        res.status(400).json({ erro: 'Não foi possível vincular esta dúvida ao conhecimento.' });
    }
});

app.post('/api/knowledgeColl/gaps/:id/ignore', async (req, res) => {
    if (!req.session.loggedIn) return res.status(401).send('Acesso negado');
    if (!knowledgeGapsColl) return res.json({ ok: true });
    try {
        const idRaw = String(req.params.id || '').trim();
        if (!ObjectId.isValid(idRaw)) return res.status(400).json({ erro: 'Dúvida inválida.' });
        const id = new ObjectId(idRaw);
        const agora = Date.now();
        const result = await knowledgeGapsColl.updateOne(
            { _id: id, resolvido: { $ne: true } },
            { $set: {
                resolvido: true,
                ignorado: true,
                resolvidoTipo: 'ignorado',
                resolvidoEm: agora,
                ignoradoEm: agora,
                updatedAt: agora
            } }
        );
        if (!result.matchedCount) return res.status(404).json({ erro: 'Dúvida pendente não encontrada.' });
        io.emit('knowledge_updated', { action: 'gap_ignored', gapId: idRaw });
        return res.json({ ok: true });
    } catch (err) {
        console.error('[IA] Erro ao ignorar dúvida:', err);
        return res.status(400).json({ erro: 'Não foi possível ignorar esta dúvida.' });
    }
});

app.post('/api/knowledgeColl/gaps/:id/resolve', async (req, res) => {
    if (!req.session.loggedIn) return res.status(401).send('Acesso negado');
    if (!knowledgeGapsColl) return res.json({ ok: true });
    try {
        const id = new ObjectId(String(req.params.id || ''));
        await knowledgeGapsColl.updateOne({ _id: id }, { $set: { resolvido: true, resolvidoEm: Date.now(), updatedAt: Date.now() } });
        res.json({ ok: true });
    } catch (err) {
        res.status(400).json({ erro: 'Não foi possível concluir esta dúvida.' });
    }
});

app.post('/api/knowledgeColl', async (req, res) => {
    if (!req.session.loggedIn) return res.status(401).send('Acesso negado');
    try {
        const doc = documentoKnowledgeDoBody(req.body || {});
        if (!doc.pergunta || !doc.resposta) return res.status(400).json({ erro: 'Informe título/pergunta e resposta.' });
        const duplicado = await knowledgeColl.findOne({ pergunta: { $regex: `^${doc.pergunta.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`, $options: 'i' } });
        if (duplicado) return res.status(409).json({ erro: 'Já existe um conhecimento com este título/pergunta. Edite o item existente.' });
        const agora = Date.now();
        const result = await knowledgeColl.insertOne({ ...doc, createdAt: agora, updatedAt: agora });
        invalidarCacheKnowledge();
        res.status(201).json({ ok: true, id: String(result.insertedId) });
    } catch (err) {
        console.error('[IA] Erro ao criar conhecimento:', err);
        res.status(500).json({ erro: 'Não foi possível salvar o conhecimento.' });
    }
});

app.put('/api/knowledgeColl/:id', async (req, res) => {
    if (!req.session.loggedIn) return res.status(401).send('Acesso negado');
    try {
        const id = new ObjectId(String(req.params.id || ''));
        const existente = await knowledgeColl.findOne({ _id: id });
        if (!existente) return res.status(404).json({ erro: 'Conhecimento não encontrado.' });
        const doc = documentoKnowledgeDoBody(req.body || {}, existente);
        if (!doc.pergunta || !doc.resposta) return res.status(400).json({ erro: 'Informe título/pergunta e resposta.' });
        const regexPergunta = new RegExp(`^${doc.pergunta.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`, 'i');
        const duplicado = await knowledgeColl.findOne({ _id: { $ne: id }, pergunta: regexPergunta });
        if (duplicado) return res.status(409).json({ erro: 'Já existe outro conhecimento com este título/pergunta.' });
        await knowledgeColl.updateOne({ _id: id }, { $set: { ...doc, updatedAt: Date.now() } });
        invalidarCacheKnowledge();
        res.json({ ok: true });
    } catch (err) {
        console.error('[IA] Erro ao editar conhecimento:', err);
        res.status(400).json({ erro: 'Não foi possível editar o conhecimento.' });
    }
});

app.delete('/api/knowledgeColl/:id', async (req, res) => {
    if (!req.session.loggedIn) return res.status(401).send('Acesso negado');
    try {
        const result = await knowledgeColl.deleteOne({ _id: new ObjectId(String(req.params.id || '')) });
        if (!result.deletedCount) return res.status(404).json({ erro: 'Conhecimento não encontrado.' });
        invalidarCacheKnowledge();
        res.json({ ok: true });
    } catch (err) {
        console.error('[IA] Erro ao excluir conhecimento:', err);
        res.status(400).json({ erro: 'Não foi possível excluir o conhecimento.' });
    }
});

setInterval(async () => {
    try {
        const host = process.env.RENDER_EXTERNAL_HOSTNAME || `localhost:${port}`;
        const protocol = host.includes('localhost') ? 'http' : 'https';
        await axios.get(`${protocol}://${host}/`);
    } catch (e) {}
}, 5 * 60 * 1000);

io.use((socket, next) => {
    const sessao = socket.request?.session;
    if (sessao?.loggedIn && sessao?.panelUser) return next();
    next(new Error('unauthorized'));
});

io.on('connection', (socket) => {
    const painelUser = socket.request?.session?.panelUser || null;
    if (painelUser) socket.emit('panel_user', painelUser);
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