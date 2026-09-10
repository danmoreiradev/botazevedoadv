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

const { GoogleGenerativeAI } = require('@google/generative-ai');
let genAI = null;
let geminiModel = null;
let apiKeysColl;

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
const DOCUMENT_AI_GEMINI_MAX_ATTEMPTS = 3;
const DOCUMENT_AI_RETRY_BASE_DELAY_MS = 1200;
const DOCUMENT_AI_RETRY_REF_MAX_CHARS = 150_000;

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
    const match = texto.match(/\[(429|500|502|503|504)\b/i) || texto.match(/\b(429|500|502|503|504)\b/);
    return match ? Number(match[1]) : null;
}

function erroDocumentoIATemporario(err) {
    const status = statusHttpErroDocumentoIA(err);
    if ([429, 500, 502, 503, 504].includes(status)) return true;

    return /(high demand|service unavailable|temporar|resource exhausted|rate limit|too many requests|overload|fetch failed|econnreset|etimedout|socket hang up)/i
        .test(String(err?.message || err || ''));
}

function erroDocumentoIADownloadIrrecuperavel(err) {
    return /(media.*not found|arquivo.*não.*encontr|message.*not found|mídia.*expir|media.*expired|404)/i
        .test(String(err?.message || err || ''));
}

function descreverErroDocumentoIA(err, { temRetryRef = false } = {}) {
    const status = statusHttpErroDocumentoIA(err);
    const texto = String(err?.message || err || '');
    const temporario = erroDocumentoIATemporario(err);
    const downloadIrrecuperavel = erroDocumentoIADownloadIrrecuperavel(err);

    if (status === 503 || /high demand|service unavailable|overload/i.test(texto)) {
        return {
            codigo: 'GEMINI_SOBRECARREGADO',
            temporario: true,
            podeReprocessar: !!temRetryRef,
            mensagem: 'A IA está temporariamente sobrecarregada. O sistema já realizou novas tentativas automáticas. Tente gerar a leitura novamente em alguns instantes.'
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
    let ultimoErro = null;
    let tentativasExecutadas = 0;

    for (let tentativa = 1; tentativa <= DOCUMENT_AI_GEMINI_MAX_ATTEMPTS; tentativa++) {
        tentativasExecutadas = tentativa;
        try {
            const resultado = await geminiModel.generateContent(partesEntrada);
            return { resultado, tentativas: tentativa };
        } catch (err) {
            ultimoErro = err;
            const deveTentarNovamente = erroDocumentoIATemporario(err) && tentativa < DOCUMENT_AI_GEMINI_MAX_ATTEMPTS;
            if (!deveTentarNovamente) break;

            const atraso = (DOCUMENT_AI_RETRY_BASE_DELAY_MS * (2 ** (tentativa - 1))) + Math.floor(Math.random() * 350);
            console.warn(`[Documentos IA] Gemini indisponível na tentativa ${tentativa}/${DOCUMENT_AI_GEMINI_MAX_ATTEMPTS}. Nova tentativa em ${atraso}ms.`);
            await esperarDocumentoIA(atraso);
        }
    }

    try {
        ultimoErro.documentAITentativas = tentativasExecutadas;
    } catch (_) {}
    throw ultimoErro || new Error('Falha desconhecida ao consultar o Gemini.');
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

            const { resultado, tentativas } = await gerarConteudoDocumentoComRetry(partesEntrada);
            const resposta = await resultado.response;
            const textoResposta = String(resposta.text() || '').trim();
            const parsed = extrairJsonIA(textoResposta);
            const analise = normalizarAnaliseDocumentoIA(parsed, textoResposta);

            await atualizarDocumentoIA(ticket, messageId, {
                ...analise,
                statusAnalise: 'concluida',
                analisadoEm: Date.now(),
                tentativasGemini: tentativas,
                erro: null,
                erroCodigo: null,
                erroTemporario: null
            });

            console.log(`[Ticket ${ticket.ticketNumber}] Arquivo ${media.nomeArquivo} analisado pelo Gemini em ${tentativas} tentativa(s).`);
        } catch (err) {
            console.error(`[Ticket ${ticket.ticketNumber}] Falha na análise de arquivo com Gemini:`, err?.message || err);
            const erroTratado = descreverErroDocumentoIA(err, { temRetryRef: !!retryRef });

            await atualizarDocumentoIA(ticket, messageId, {
                statusAnalise: 'erro',
                erro: erroTratado.mensagem,
                erroCodigo: erroTratado.codigo,
                erroTemporario: erroTratado.temporario,
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
app.set('trust proxy', 1);

app.use(express.json());
app.use(express.urlencoded({ extended: true }));
const MongoDBStore = require('connect-mongodb-session')(session);

const store = new MongoDBStore({
  uri: process.env.MONGODB_URI,
  collection: 'sessions'
});

const sessionMiddleware = session({
    secret: process.env.SESSION_SECRET || 'azevedo-secret-key',
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
const botMessageIds = new Set();
const panelMessageIds = new Set();
const panelPendingJids = new Set();
const processing = new Set();

let ticketsColl, authColl, knowledgeColl, userLoginColl, clientsColl, ticketHistoryColl, countersColl, menuOptionsColl, settingsColl, crmLeadsColl, ticketMessagesColl;

// -----------------------------------------------------------------------------
// USUÁRIOS, PERMISSÕES E CHAT DO PAINEL
// -----------------------------------------------------------------------------
const PERMISSOES_PAINEL = [
    'tickets', 'clients', 'chat', 'crm', 'whatsapp', 'ia', 'menu', 'business_hours', 'users'
];
const PERMISSOES_ADVOGADO_PADRAO = ['tickets', 'clients', 'chat'];

// O MongoDB gratuito é protegido de duas formas: retenção temporal e limite por ticket.
// Somente texto e metadados são persistidos. Arquivos, imagens, áudios e vídeos NÃO
// são armazenados na coleção de chat.
const CHAT_RETENTION_DAYS = 60;
const CHAT_MAX_MESSAGES_PER_TICKET = 500;
const CHAT_TRIM_TRIGGER = 540;
const CHAT_LIST_LIMIT_DEFAULT = 60;
const CHAT_LIST_LIMIT_MAX = 100;
const CHAT_MAX_TEXT_CHARS = 12000;
const CHAT_MAX_CAPTION_CHARS = 2000;
const CHAT_MAX_UPLOAD_BYTES = 15 * 1024 * 1024;
const chatLastTrimAt = new Map();

// Cache efêmero de mensagens enviadas pelo Baileys. Não ocupa MongoDB e permite
// que a biblioteca recupere a mensagem original caso o WhatsApp solicite retry.
const BAILEYS_SENT_CACHE_TTL_MS = 15 * 60 * 1000;
const BAILEYS_SENT_CACHE_MAX = 500;
const baileysSentMessageCache = new Map();

function guardarMensagemEnviadaBaileys(sent) {
    const id = String(sent?.key?.id || '').trim();
    if (!id || !sent?.message) return;

    baileysSentMessageCache.set(id, { message: sent.message, savedAt: Date.now() });

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

function obterMensagemEnviadaBaileys(key = {}) {
    const id = String(key?.id || '').trim();
    if (!id) return undefined;
    const item = baileysSentMessageCache.get(id);
    if (!item) return undefined;
    if ((Date.now() - Number(item.savedAt || 0)) > BAILEYS_SENT_CACHE_TTL_MS) {
        baileysSentMessageCache.delete(id);
        return undefined;
    }
    return item.message;
}

async function enviarMensagemBaileys(jid, content, options = {}) {
    if (!sock?.user) throw new Error('WhatsApp não conectado.');

    // Em versões 6.x do Baileys, a lista de dispositivos do destinatário pode
    // ficar desatualizada e provocar mensagens que chegam como "Aguardando mensagem".
    // Forçamos uma consulta fresca dos dispositivos em cada envio. Como o volume
    // do escritório é pequeno/moderado, o custo adicional é preferível à falha
    // intermitente de criptografia. O chamador ainda pode sobrescrever a opção.
    const sendOptions = {
        useUserDevicesCache: false,
        ...options
    };

    const sent = await sock.sendMessage(jid, content, sendOptions);
    guardarMensagemEnviadaBaileys(sent);
    return sent;
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
        senderId: doc.senderId || null,
        senderName: doc.senderName || null,
        createdAt: doc.createdAt instanceof Date ? doc.createdAt.getTime() : Number(doc.createdAt || Date.now())
    };
}

async function apararHistoricoChatSeNecessario(ticketNumber) {
    if (!ticketMessagesColl || !ticketNumber) return;
    const agora = Date.now();
    const ultima = chatLastTrimAt.get(ticketNumber) || 0;
    if (agora - ultima < 60 * 60 * 1000) return;
    chatLastTrimAt.set(ticketNumber, agora);

    setImmediate(async () => {
        try {
            const total = await ticketMessagesColl.countDocuments({ ticketNumber });
            if (total <= CHAT_TRIM_TRIGGER) return;
            const excedentes = await ticketMessagesColl.find(
                { ticketNumber },
                { projection: { _id: 1 } }
            ).sort({ createdAt: -1 }).skip(CHAT_MAX_MESSAGES_PER_TICKET).toArray();
            if (excedentes.length) {
                await ticketMessagesColl.deleteMany({ _id: { $in: excedentes.map(item => item._id) } });
            }
        } catch (err) {
            console.warn('[Chat] Não foi possível aparar histórico do ticket:', err?.message || err);
        }
    });
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
        senderId: documento.senderId ? String(documento.senderId).slice(0, 120) : null,
        senderName: documento.senderName ? limitarTextoChat(documento.senderName, 180) : null,
        createdAt: documento.createdAt instanceof Date ? documento.createdAt : new Date(Number(documento.createdAt || Date.now()))
    };

    if (!registro.texto) delete registro.texto;
    if (!registro.fileName) delete registro.fileName;
    if (!registro.mimeType) delete registro.mimeType;
    if (!registro.fileSize) delete registro.fileSize;
    if (!registro.senderId) delete registro.senderId;
    if (!registro.senderName) delete registro.senderName;

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
        fileSize: media?.tamanhoDeclarado || null
    };
}

async function registrarMensagemClienteChat(ticket, msg) {
    if (!ticket?.ticketNumber || !msg?.key?.id || msg?.key?.fromMe) return;
    const dados = dadosMensagemChatWhatsApp(msg);
    if (!dados.texto && dados.tipo === 'text') return;
    await registrarMensagemChat({
        ticketNumber: ticket.ticketNumber,
        messageId: msg.key.id,
        direction: 'in',
        source: 'cliente',
        ...dados,
        createdAt: Date.now()
    });
    io.emit('ticket_activity_updated', { ticketNumber: ticket.ticketNumber, direction: 'in' });
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
    // Para envio 1:1, priorizamos SEMPRE o PN real (@s.whatsapp.net).
    // Evitamos envio direto para @lid, que pode produzir o placeholder
    // "Aguardando mensagem. Essa ação pode levar alguns instantes." no destinatário.
    const numero = whatsappDoTicket(ticket);
    if (numero) return `${numero}@s.whatsapp.net`;

    const candidatos = [
        ticket.lastRawJid,
        ...(Array.isArray(ticket.identificadores) ? ticket.identificadores : [])
    ].map(normalizarJid).filter(Boolean);

    const pnDireto = candidatos.find(jid => String(jid).endsWith('@s.whatsapp.net'));
    if (pnDireto) return pnDireto;

    if (sock?.signalRepository?.lidMapping?.getPNForLID) {
        for (const lid of candidatos.filter(jid => String(jid).endsWith('@lid'))) {
            try {
                const pn = await sock.signalRepository.lidMapping.getPNForLID(lid);
                const numeroResolvido = normalizarNumeroWhatsApp(pn);
                if (numeroResolvido) {
                    const pnJid = `${numeroResolvido}@s.whatsapp.net`;
                    if (ticket?._id && ticketsColl) {
                        await ticketsColl.updateOne(
                            { _id: ticket._id },
                            {
                                $set: { numeroReal: numeroResolvido, lastActivity: Date.now() },
                                $addToSet: { whatsappNumbers: numeroResolvido, identificadores: pnJid }
                            }
                        ).catch(() => {});
                    }
                    return pnJid;
                }
            } catch (err) {
                console.warn(`[Chat] Não foi possível resolver LID ${lid} para PN:`, err?.message || err);
            }
        }
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
    try {
        const sent = await enviarMensagemBaileys(jid, content);
        const id = sent?.key?.id;

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
    if (lidsObservados.length && pnsObservados.length && sock?.signalRepository?.lidMapping?.storeLIDPNMappings) {
        try {
            await sock.signalRepository.lidMapping.storeLIDPNMappings(
                lidsObservados.flatMap(lid => pnsObservados.map(pn => ({ lid, pn })))
            );
        } catch (err) {
            console.warn('[LID] Não foi possível persistir o par LID/PN observado:', err?.message || err);
        }
    }

    // Tenta resolver qualquer LID observado na mensagem para o PN real.
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

async function mensagemRecepcao(cliente, ticketNumber) {
    const menuTexto = await gerarMenuTexto();

    if (cliente) {
        const nomeSaudacao = primeiroNome(cliente.nome || cliente.nomeCompleto || '');
        return `Olá${nomeSaudacao ? `, ${nomeSaudacao}` : ''}! Seja bem-vindo de volta à *Azevedo & Juvencio Advogados*. 👋

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

    await registrarTicketHistorico(ticket);

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
                aguardandoWhatsappCadastro: false,
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
        crmLeadsColl = db.collection('crm_leads');
        ticketMessagesColl = db.collection('ticket_messages');

        // Cria as opções atuais e o horário padrão somente se ainda não existirem.
        await garantirMenuPadrao();
        await garantirHorarioFuncionamentoPadrao();

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
            ticketsColl.createIndex({ status: 1, lastActivity: 1 }),
            ticketsColl.createIndex({ area: 1, lastActivity: 1 }),
            ticketsColl.createIndex({ 'documentosIA.messageId': 1 }),
            ticketHistoryColl.createIndex({ 'documentosIA.messageId': 1 }),
            menuOptionsColl.createIndex({ ordem: 1 }),
            crmLeadsColl.createIndex({ crmNumber: 1 }, { unique: true, sparse: true }),
            crmLeadsColl.createIndex({ ticketNumber: 1 }, { unique: true, sparse: true }),
            crmLeadsColl.createIndex({ status: 1, dataProximaAcao: 1 }),
            crmLeadsColl.createIndex({ responsavel: 1, status: 1 }),
            crmLeadsColl.createIndex({ origemTipo: 1, status: 1 }),
            crmLeadsColl.createIndex({ updatedAt: -1 }),
            userLoginColl.createIndex({ userLower: 1 }),
            userLoginColl.createIndex({ role: 1, ativo: 1 }),
            ticketMessagesColl.createIndex({ ticketNumber: 1, createdAt: -1 }),
            ticketMessagesColl.createIndex({ ticketNumber: 1, messageId: 1 }, { unique: true }),
            ticketMessagesColl.createIndex({ createdAt: 1 }, { expireAfterSeconds: CHAT_RETENTION_DAYS * 24 * 60 * 60 })
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

        const baileysLogger = P({ level: 'silent' });
        const authStateSeguro = {
            creds: state.creds,
            keys: typeof makeCacheableSignalKeyStore === 'function'
                ? makeCacheableSignalKeyStore(state.keys, baileysLogger)
                : state.keys
        };

        sock = makeWASocket({
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
            enableAutoSessionRecreation: true,
            getMessage: async (key) => obterMensagemEnviadaBaileys(key)
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
    const isMedia = !!extrairMidiaAnalisavel(msg);

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
            const jidMensagemNormalizado = normalizarJid(rawJid) || rawJid;
            if (botMessageIds.has(msgId) || panelMessageIds.has(msgId) || panelPendingJids.has(jidMensagemNormalizado)) return;

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
            await registrarMensagemClienteChat(ticket, msg).catch(err => {
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

            await registrarMensagemClienteChat(ticket, msg).catch(err => {
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

        if (analiseIAPrevia?.acao === 'ENCERRAR') {
            await responderInterrupcaoIA(ticket, rawJid, analiseIAPrevia);
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
                paused: false,
                notificarPainel: true
            });

            await registrarMensagemClienteChat(ticket, msg).catch(err => {
                console.warn('[Chat] Falha ao registrar primeira mensagem do ticket:', err?.message || err);
            });
            dispararAnaliseArquivo(ticket);

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
                        aguardandoWhatsappCadastro: false,
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

            await sendBotMsg(rawJid, {
                text: `✅ Cadastro realizado, ${nomeInfo.nome}! Nos próximos atendimentos vamos reconhecer você automaticamente.\n\nSeu ticket *${ticket.ticketNumber}* foi encaminhado para nossa equipe. Um especialista dará continuidade ao atendimento.`
            });

            ticket.clienteCadastrado = true;
            ticket.clienteNome = nomeInfo.nomeCompleto;
            ticket.cpf = cpfLimpo;
            ticket.numeroReal = resultadoCadastro.numeroPrincipal;

            await encaminharParaEspecialista(ticket, rawJid);
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
                await sendBotMsg(rawJid, {
                    text: `Precisamos reiniciar a identificação do cadastro. Informe seu *nome e sobrenome*:`
                });
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

            await sendBotMsg(rawJid, {
                text: `✅ Cadastro realizado, ${nomeInfo.nome}! Nos próximos atendimentos vamos reconhecer você automaticamente.\n\nSeu ticket *${ticket.ticketNumber}* foi encaminhado para nossa equipe. Um especialista dará continuidade ao atendimento.`
            });

            ticket.clienteCadastrado = true;
            ticket.clienteNome = nomeInfo.nomeCompleto;
            ticket.cpf = cpfLimpo;
            ticket.numeroReal = resultadoCadastro.numeroPrincipal;

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
                    aguardandoWhatsappCadastro: false,
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

                if (!lidNormalizado || !numero) return;
                const agora = Date.now();

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
    // Chaves Signal precisam estar realmente persistidas antes de keys.set() resolver.
    // A versão anterior disparava replaceOne/deleteOne sem await, abrindo condição
    // de corrida nas próprias chaves usadas para criptografar as mensagens.
    let filaEscrita = Promise.resolve();

    const enfileirarEscrita = (trabalho) => {
        const operacao = filaEscrita.then(trabalho, trabalho);
        filaEscrita = operacao.catch(() => {});
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
        await filaEscrita.catch(() => {});
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
    try {
        if (!userLower || !pass) {
            return res.send("<script>alert('Informe usuário e senha.'); window.location='/login';</script>");
        }
        const conta = await userLoginColl.findOne({
            $or: [{ user: userInput }, { userLower }]
        });
        if (!conta || conta.ativo === false || !validarSenhaPainel(pass, conta)) {
            return res.send("<script>alert('Usuário ou senha inválidos.'); window.location='/login';</script>");
        }

        await migrarSenhaLegadaSeNecessario(conta, pass);
        const painelUser = sessaoPublicaDaConta(conta);
        req.session.loggedIn = true;
        req.session.panelUser = painelUser;
        req.session.userId = painelUser.id;
        req.session.save(err => {
            if (err) return res.status(500).send('Erro ao iniciar sessão.');
            res.redirect('/');
        });
    } catch (e) {
        console.error('[Login] Erro:', e);
        res.status(500).send('Erro');
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

// Proteção por módulo. O administrador ignora a lista de permissões; advogados
// comuns recebem por padrão apenas tickets, clientes e chat.
app.use('/api/business-hours', exigirPermissao('business_hours'));
app.use('/api/triage', exigirPermissao('menu'));
app.use('/api/menu-options', exigirPermissao('menu'));
app.use('/api/crm', exigirPermissao('crm'));
app.use('/api/clients', exigirPermissao('clients'));
app.use('/api/knowledgeColl', exigirPermissao('ia'));
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
        currentUser = null; lastQr = null;
        io.emit('disconnected');
        res.sendStatus(200);
    } catch (err) {
        console.error('[WhatsApp] Erro ao desconectar:', err);
        res.status(500).send("Erro");
    }
});


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
        role,
        permissions,
        ativo: body.ativo !== undefined ? body.ativo !== false : existente?.ativo !== false
    };
}

app.get('/api/users', async (req, res) => {
    try {
        const usuarios = await userLoginColl.find({}, {
            projection: { pass: 0, passwordHash: 0, passwordSalt: 0 }
        }).sort({ ativo: -1, role: 1, nome: 1, user: 1 }).toArray();
        res.json({
            usuarios: usuarios.map(item => ({ ...sessaoPublicaDaConta(item), ativo: item.ativo !== false, createdAt: item.createdAt || null, updatedAt: item.updatedAt || null })),
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
        res.status(201).json({ ok: true, user: { ...sessaoPublicaDaConta(salvo), ativo: salvo.ativo !== false } });
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
const CRM_STATUS = [
    'Novo lead',
    'Contato feito',
    'Reunião agendada',
    'Reunião realizada',
    'Proposta enviada',
    'Negociando',
    'Contrato assinado',
    'Em andamento',
    'Aguardando cliente',
    'Encerrado - ganho',
    'Encerrado - perdido'
];

const CRM_MODELOS_COBRANCA = ['Consulta', 'Fixo', 'Parcelado', 'Êxito', 'Misto'];
const CRM_MOTIVOS_PERDA = ['Sem resposta', 'Sem orçamento', 'Fechou com outro', 'Não é o perfil do caso', 'Outro'];
const CRM_ORIGENS_ANUNCIO = ['Meta Ads', 'Instagram Ads', 'Facebook Ads', 'Google Ads', 'TikTok Ads', 'YouTube Ads', 'LinkedIn Ads', 'Outro anúncio'];
const CRM_STATUS_ENCERRADOS = new Set(['Encerrado - ganho', 'Encerrado - perdido']);
const CRM_STATUS_GANHOS = new Set(['Contrato assinado', 'Em andamento', 'Encerrado - ganho']);

function origemCRMDeAnuncioValida(origem = '') {
    return CRM_ORIGENS_ANUNCIO.includes(String(origem || '').trim());
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

    let receitaContratoPrevista = null;
    if (modelo === 'Consulta') receitaContratoPrevista = entrada;
    else if (modelo === 'Fixo') receitaContratoPrevista = valorPotencial;
    else if (modelo === 'Parcelado' || modelo === 'Misto') receitaContratoPrevista = entrada + (parcelasQtd * valorParcela);

    let exitoPrevisto = null;
    if (modelo === 'Êxito' || modelo === 'Misto') exitoPrevisto = valorPotencial * percentualExito;

    const componentes = [receitaContratoPrevista, exitoPrevisto].filter(v => v !== null && Number.isFinite(v));
    const receitaTotalPrevista = componentes.length ? componentes.reduce((soma, valor) => soma + valor, 0) : null;

    return {
        receitaContratoPrevista,
        exitoPrevisto,
        receitaTotalPrevista
    };
}

function normalizarLeadCRM(body = {}, existente = {}) {
    const statusRecebido = textoCRM(body.status ?? existente.status ?? 'Novo lead', 80);
    const status = CRM_STATUS.includes(statusRecebido) ? statusRecebido : 'Novo lead';
    const modeloRecebido = textoCRM(body.modeloCobranca ?? existente.modeloCobranca ?? '', 80);
    const modeloCobranca = CRM_MODELOS_COBRANCA.includes(modeloRecebido) ? modeloRecebido : '';
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

    if (status !== 'Encerrado - perdido') dados.motivoPerda = '';
    if ((CRM_STATUS_GANHOS.has(status) || CRM_STATUS_ENCERRADOS.has(status)) && !dados.dataFechamento) {
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

    const ganhos = leads.filter(lead => CRM_STATUS_GANHOS.has(lead.status));
    // Depois de contrato assinado o registro continua consultável no CRM, mas sai da
    // fila comercial de follow-up. Isso evita tratar cliente já convertido como lead atrasado.
    const abertos = leads.filter(lead => !CRM_STATUS_GANHOS.has(lead.status) && lead.status !== 'Encerrado - perdido');
    const followupsAtrasados = abertos.filter(lead => lead.dataProximaAcao && lead.dataProximaAcao < hoje).length;
    const acoesHoje = abertos.filter(lead => lead.dataProximaAcao === hoje).length;
    const proximos7Dias = abertos.filter(lead => lead.dataProximaAcao && lead.dataProximaAcao > hoje && lead.dataProximaAcao <= seteDiasStr).length;
    const semProximaAcao = abertos.filter(lead => !lead.dataProximaAcao || !lead.proximaAcao).length;
    const propostasAbertas = abertos.filter(lead => ['Proposta enviada', 'Negociando'].includes(lead.status)).length;
    const contratosMes = ganhos.filter(lead => String(lead.dataFechamento || '').startsWith(prefixoMes)).length;
    const receitaFechada = ganhos.reduce((soma, lead) => soma + Number(lead.receitaTotalPrevista || 0), 0);
    const receitaAberta = leads
        .filter(lead => !CRM_STATUS_GANHOS.has(lead.status) && lead.status !== 'Encerrado - perdido')
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
        origem: 'Meta Ads',
        cliente: clienteTicket || `Lead ${ticketNumber}`,
        telefone: telefoneTicket,
        area: areaTicket,
        assuntoResumo: resumoTicket,
        status: 'Novo lead',
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

function whatsappDoTicket(ticket = {}) {
    return extrairNumeroWhatsAppDeFontes(
        ticket.numeroReal,
        ticket.whatsappNumbers,
        ticket.identificadores,
        ticket.lastRawJid
    );
}


// -----------------------------------------------------------------------------
// CHAT INTERNO DO TICKET
// -----------------------------------------------------------------------------
app.get('/api/tickets/:ticketNumber/chat', async (req, res) => {
    if (!usuarioPode(req, 'chat')) return res.status(403).json({ erro: 'Seu usuário não possui permissão para o chat.' });
    if (!ticketMessagesColl || !ticketsColl) return res.status(503).json({ erro: 'Chat ainda não está disponível.' });
    try {
        const ticketNumber = String(req.params.ticketNumber || '').trim();
        const ticket = await ticketsColl.findOne({ ticketNumber });
        if (!ticket) return res.status(404).json({ erro: 'Ticket ativo não encontrado.' });
        const limite = Math.min(CHAT_LIST_LIMIT_MAX, Math.max(10, Number(req.query.limit || CHAT_LIST_LIMIT_DEFAULT)));
        const filtro = { ticketNumber };
        if (req.query.before) {
            const antes = new Date(Number(req.query.before));
            if (!Number.isNaN(antes.getTime())) filtro.createdAt = { $lt: antes };
        }
        const docsDesc = await ticketMessagesColl.find(filtro).sort({ createdAt: -1 }).limit(limite + 1).toArray();
        const hasMore = docsDesc.length > limite;
        const docs = docsDesc.slice(0, limite).reverse();
        res.json({
            ticket: {
                ticketNumber,
                clienteNome: ticket.clienteNome || null,
                whatsapp: whatsappDoTicket(ticket),
                area: ticket.area || ticket.menuOptionTitle || null,
                advogadoResponsavelNome: ticket.advogadoResponsavelNome || null
            },
            messages: docs.map(serializarMensagemChat),
            hasMore,
            retentionDays: CHAT_RETENTION_DAYS,
            maxMessagesPerTicket: CHAT_MAX_MESSAGES_PER_TICKET
        });
    } catch (err) {
        console.error('[Chat] Erro ao carregar mensagens:', err);
        res.status(500).json({ erro: 'Não foi possível carregar o chat.' });
    }
});

app.post('/api/tickets/:ticketNumber/chat/messages', async (req, res) => {
    if (!usuarioPode(req, 'chat')) return res.status(403).json({ erro: 'Seu usuário não possui permissão para o chat.' });
    if (!sock?.user) return res.status(503).json({ erro: 'O WhatsApp do escritório não está conectado.' });
    try {
        const ticketNumber = String(req.params.ticketNumber || '').trim();
        const texto = limitarTextoChat(req.body?.text || '', CHAT_MAX_TEXT_CHARS);
        if (!texto) return res.status(400).json({ erro: 'Digite uma mensagem para enviar.' });
        const ticket = await ticketsColl.findOne({ ticketNumber });
        if (!ticket) return res.status(404).json({ erro: 'Ticket ativo não encontrado.' });
        const jid = await destinoWhatsAppTicket(ticket);
        if (!jid) return res.status(409).json({ erro: 'Não foi possível identificar o WhatsApp deste ticket.' });

        const advogado = identidadeAdvogadoSessao(req);
        const textoWhatsApp = `${advogado.assinatura}: ${texto}`;
        const jidNormalizadoPainel = normalizarJid(jid) || jid;
        panelPendingJids.add(jidNormalizadoPainel);
        setTimeout(() => panelPendingJids.delete(jidNormalizadoPainel), 5000);
        let sent;
        try {
            sent = await enviarMensagemBaileys(jid, { text: textoWhatsApp });
        } finally {
            setTimeout(() => panelPendingJids.delete(jidNormalizadoPainel), 2500);
        }
        const messageId = String(sent?.key?.id || `panel_${Date.now()}_${crypto.randomBytes(4).toString('hex')}`);
        if (sent?.key?.id) {
            panelMessageIds.add(sent.key.id);
            setTimeout(() => panelMessageIds.delete(sent.key.id), 2 * 60 * 1000);
        }

        const registrada = await registrarMensagemChat({
            ticketNumber,
            messageId,
            direction: 'out',
            source: 'painel',
            tipo: 'text',
            texto,
            senderId: advogado.id,
            senderName: advogado.assinatura,
            createdAt: Date.now()
        });

        const agora = Date.now();
        const tresDiasEmMs = 3 * 24 * 60 * 60 * 1000;
        const camposTicket = {
            status: 'em_atendimento_humano',
            paused: true,
            until: agora + tresDiasEmMs,
            lastActivity: agora,
            advogadoResponsavelId: advogado.id || null,
            advogadoResponsavelNome: advogado.nome || null
        };
        await ticketsColl.updateOne({ _id: ticket._id }, { $set: camposTicket });
        await atualizarHistorico(ticketNumber, {
            status: 'em_atendimento_humano',
            advogadoResponsavelId: advogado.id || null,
            advogadoResponsavelNome: advogado.nome || null,
            ultimaMensagemPainelEm: agora
        });
        if (ticket.clienteId && clientsColl) {
            await clientsColl.updateOne(
                { _id: ticket.clienteId, $or: [{ advogadoResponsavel: { $exists: false } }, { advogadoResponsavel: null }, { advogadoResponsavel: '' }] },
                { $set: { advogadoResponsavel: advogado.nome || advogado.assinatura, updatedAt: agora } }
            );
        }
        io.emit('ticket_activity_updated', { ticketNumber, direction: 'out', status: 'em_atendimento_humano' });
        res.status(201).json({ ok: true, message: registrada });
    } catch (err) {
        console.error('[Chat] Erro ao enviar mensagem:', err);
        res.status(500).json({ erro: err?.message || 'Não foi possível enviar a mensagem.' });
    }
});

app.post(
    '/api/tickets/:ticketNumber/chat/files',
    express.raw({ type: 'application/octet-stream', limit: CHAT_MAX_UPLOAD_BYTES }),
    async (req, res) => {
        if (!usuarioPode(req, 'chat')) return res.status(403).json({ erro: 'Seu usuário não possui permissão para o chat.' });
        if (!sock?.user) return res.status(503).json({ erro: 'O WhatsApp do escritório não está conectado.' });
        try {
            const ticketNumber = String(req.params.ticketNumber || '').trim();
            const ticket = await ticketsColl.findOne({ ticketNumber });
            if (!ticket) return res.status(404).json({ erro: 'Ticket ativo não encontrado.' });
            const jid = await destinoWhatsAppTicket(ticket);
            if (!jid) return res.status(409).json({ erro: 'Não foi possível identificar o WhatsApp deste ticket.' });
            if (!Buffer.isBuffer(req.body) || !req.body.length) return res.status(400).json({ erro: 'Arquivo vazio ou inválido.' });
            if (req.body.length > CHAT_MAX_UPLOAD_BYTES) return res.status(413).json({ erro: 'Arquivo acima do limite de 15 MB do chat.' });

            const nomeArquivo = limitarTextoChat(req.query.name || 'arquivo', 240);
            const mimeType = limitarTextoChat(req.query.mimeType || 'application/octet-stream', 120).toLowerCase();
            const legenda = limitarTextoChat(req.query.caption || '', CHAT_MAX_CAPTION_CHARS);
            const advogado = identidadeAdvogadoSessao(req);
            const captionAssinada = legenda ? `${advogado.assinatura}: ${legenda}` : `${advogado.assinatura}:`;
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
                tipo = 'audio'; payload = { audio: req.body, mimetype: mimeType, ptt: false };
            } else {
                payload = { document: req.body, mimetype: mimeType, fileName: nomeArquivo, caption: captionAssinada };
            }

            // Áudio não aceita legenda no WhatsApp. Envia a identificação em uma
            // mensagem curta imediatamente antes, sem salvar binário no MongoDB.
            if (tipo === 'audio') {
                const intro = await enviarMensagemBaileys(jid, { text: legenda ? `${advogado.assinatura}: ${legenda}` : `${advogado.assinatura}:` });
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
                sent = await enviarMensagemBaileys(jid, payload);
            } finally {
                setTimeout(() => panelPendingJids.delete(jidNormalizadoPainel), 2500);
            }
            const messageId = String(sent?.key?.id || `panel_file_${Date.now()}_${crypto.randomBytes(4).toString('hex')}`);
            if (sent?.key?.id) {
                panelMessageIds.add(sent.key.id);
                setTimeout(() => panelMessageIds.delete(sent.key.id), 2 * 60 * 1000);
            }
            const registrada = await registrarMensagemChat({
                ticketNumber,
                messageId,
                direction: 'out',
                source: 'painel',
                tipo,
                texto: tipo === 'audio' ? '' : legenda,
                fileName: nomeArquivo,
                mimeType,
                fileSize: req.body.length,
                senderId: advogado.id,
                senderName: advogado.assinatura,
                createdAt: Date.now()
            });

            const agora = Date.now();
            const tresDiasEmMs = 3 * 24 * 60 * 60 * 1000;
            await ticketsColl.updateOne({ _id: ticket._id }, { $set: {
                status: 'em_atendimento_humano', paused: true, until: agora + tresDiasEmMs, lastActivity: agora,
                advogadoResponsavelId: advogado.id || null, advogadoResponsavelNome: advogado.nome || null
            } });
            await atualizarHistorico(ticketNumber, {
                status: 'em_atendimento_humano', advogadoResponsavelId: advogado.id || null,
                advogadoResponsavelNome: advogado.nome || null, ultimaMensagemPainelEm: agora
            });
            io.emit('ticket_activity_updated', { ticketNumber, direction: 'out', status: 'em_atendimento_humano' });
            res.status(201).json({ ok: true, message: registrada });
        } catch (err) {
            console.error('[Chat] Erro ao enviar arquivo:', err);
            const status = err?.type === 'entity.too.large' ? 413 : 500;
            res.status(status).json({ erro: status === 413 ? 'Arquivo acima do limite de 15 MB do chat.' : (err?.message || 'Não foi possível enviar o arquivo.') });
        }
    }
);

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
                    perguntasFluxo: 1,
                    indicePerguntaFluxo: 1,
                    respostasFluxo: 1,
                    foraHorario: 1,
                    paused: 1,
                    until: 1,
                    lastActivity: 1,
                    createdAt: 1,
                    documentosIA: 1,
                    advogadoResponsavelId: 1,
                    advogadoResponsavelNome: 1
                }
            }
        ).toArray();

        // Garante também no painel de tickets que todo ticket classificado como
        // lead_anuncio já possua seu registro correspondente no CRM. Isso recupera
        // automaticamente tickets criados antes desta correção.
        if (crmLeadsColl && tickets.some(ticket => ticket.origem === 'lead_anuncio')) {
            await reconciliarTicketsAnuncioNoCRM();
        }

        const ticketNumbers = tickets.map(ticket => ticket.ticketNumber).filter(Boolean);
        const historicos = ticketHistoryColl && ticketNumbers.length
            ? await ticketHistoryColl.find(
                { _id: { $in: ticketNumbers } },
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
            ).toArray()
            : [];

        const historicoPorTicket = new Map(
            historicos.map(item => [String(item.ticketNumber || item._id), item])
        );

        const leadsCRMRelacionadosBrutos = crmLeadsColl && ticketNumbers.length
            ? await crmLeadsColl.find(
                { ticketNumber: { $in: ticketNumbers } },
                { projection: { _id: 1, crmNumber: 1, ticketNumber: 1, status: 1, origem: 1, origemTipo: 1, origemTecnica: 1 } }
            ).toArray()
            : [];
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
            const respostas = Array.isArray(ticket.respostasFluxo) && ticket.respostasFluxo.length
                ? ticket.respostasFluxo
                : (Array.isArray(historico.respostasTriagem) ? historico.respostasTriagem : []);
            const triagem = progressoTriagemTicket(ticket, respostas);
            const ultimaAtividade = Number(ticket.lastActivity || ticket.createdAt || 0) || null;
            const criadoEm = Number(ticket.createdAt || 0) || null;
            const idadeUltimaAtividadeMs = ultimaAtividade ? Math.max(0, agora - ultimaAtividade) : null;
            const perguntaAtual = perguntaAtualDoTicket(ticket);

            // A cópia do histórico pode ter sido atualizada depois da cópia ativa.
            // Mesclamos por messageId e damos preferência ao registro mais recente/concluído.
            const docsAtivos = Array.isArray(ticket.documentosIA) ? ticket.documentosIA : [];
            const docsHistorico = Array.isArray(historico.documentosIA) ? historico.documentosIA : [];
            const documentosPorMensagem = new Map();
            [...docsAtivos, ...docsHistorico].forEach(doc => {
                const chave = String(doc?.messageId || doc?.id || '');
                if (!chave) return;
                const anterior = documentosPorMensagem.get(chave);
                const peso = estado => ({ concluida: 7, erro: 6, nao_suportado: 6, processando_ia: 5, baixando: 4, na_fila: 3, analisando: 2 }[estado] || 1);
                if (!anterior || peso(doc?.statusAnalise) >= peso(anterior?.statusAnalise)) {
                    documentosPorMensagem.set(chave, doc);
                }
            });
            const documentosIA = [...documentosPorMensagem.values()]
                .sort((a, b) => Number(b?.recebidoEm || 0) - Number(a?.recebidoEm || 0))
                .slice(0, DOCUMENT_AI_MAX_ITEMS)
                .map(doc => ({
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
                    tentativasManuais: Number(doc?.tentativasManuais || 0),
                    reprocessadoEm: doc?.reprocessadoEm || null,
                    podeReprocessar: doc?.statusAnalise === 'erro' && !!doc?.retryRef
                }));

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
                cpf: ticket.cpf || null,
                clienteCadastrado: ticket.clienteCadastrado === true,
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
                crm: crmPorTicket.get(String(ticket.ticketNumber)) || null,
                documentosIA,
                advogadoResponsavelId: ticket.advogadoResponsavelId || null,
                advogadoResponsavelNome: ticket.advogadoResponsavelNome || null,
                documentosResumo: {
                    total: documentosIA.length,
                    concluidos: documentosIA.filter(doc => doc.statusAnalise === 'concluida').length,
                    processando: documentosIA.filter(doc => ['analisando', 'na_fila', 'baixando', 'processando_ia'].includes(doc.statusAnalise)).length,
                    comErro: documentosIA.filter(doc => ['erro', 'nao_suportado'].includes(doc.statusAnalise)).length
                }
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
            pendentesMaisDe2h: itens.filter(item => item.pendenteHaMaisDe2h).length
        };

        res.json({
            generatedAt: agora,
            resumo,
            tickets: itens
        });
    } catch (err) {
        console.error('[Tickets] Erro ao carregar painel de tickets ativos:', err);
        res.status(500).json({ erro: 'Não foi possível carregar os tickets ativos.' });
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

// CRM - lista, indicadores e opções de preenchimento.
app.get('/api/crm/leads', async (req, res) => {
    if (!req.session.loggedIn) return res.status(401).send('Acesso negado');
    if (!crmLeadsColl) return res.status(503).json({ erro: 'CRM ainda não está disponível.' });

    try {
        // Self-healing: se havia um ticket de anúncio ativo antes da criação automática
        // ser implementada, ele é criado/sincronizado no CRM ao abrir esta tela.
        await reconciliarTicketsAnuncioNoCRM();

        const leadsBrutos = await crmLeadsColl.find({}).sort({ updatedAt: -1 }).limit(3000).toArray();
        // O CRM é exclusivamente de leads originados de mídia paga/anúncios.
        // Registros orgânicos eventualmente criados por versões anteriores permanecem
        // preservados no MongoDB, mas não entram na listagem nem nas métricas comerciais.
        const leads = leadsBrutos.filter(leadCRMDeAnuncio);
        res.json({
            generatedAt: Date.now(),
            resumo: resumoCRM(leads),
            options: {
                status: CRM_STATUS,
                modelosCobranca: CRM_MODELOS_COBRANCA,
                motivosPerda: CRM_MOTIVOS_PERDA,
                origensAnuncio: CRM_ORIGENS_ANUNCIO
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
        ).sort({ nomeCompleto: 1, nome: 1, createdAt: -1 }).toArray();

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