import 'dotenv/config';
import express, {type Request, type Response} from 'express';
import fs from 'fs';
import path from 'path';
import {fileURLToPath} from 'url';
import {GoogleGenAI, Type} from '@google/genai';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const PORT = Number(process.env.PORT) || 3000;
const isProd = process.env.NODE_ENV === 'production';

const GEMINI_TEXT_MODEL = 'gemini-2.5-flash';
const DEFAULT_GEMINI_TTS_MODEL = 'gemini-3.8-flash-tts';
const ACCEPTED_TTS_MODELS = ['gemini-3.8-flash-tts', 'gemini-3.8-flash-lite-tts'] as const;
const ACCEPTED_TTS_VOICES = ['Algenib', 'Gacrux', 'Charon', 'Alnilam'] as const;
const TEXT_GENERATION_TIMEOUT_MS = 4500;
const TRANSCRIPTION_TIMEOUT_MS = 4000;
const TTS_GENERATION_TIMEOUT_MS = 14000;

function resolveSantaTtsModel(requestedModel?: string): string {
  const candidate = (requestedModel || process.env.GEMINI_TTS_MODEL || DEFAULT_GEMINI_TTS_MODEL).trim();
  if ((ACCEPTED_TTS_MODELS as readonly string[]).includes(candidate)) {
    return candidate;
  }
  return DEFAULT_GEMINI_TTS_MODEL;
}

type PlanId = '15s' | '30s' | '60s' | 'familia' | 'audio';
type FarewellType = 'mamae' | 'duendes' | 'renas' | 'carta';

interface CachedGreeting {
  greetingText: string;
  greetingAudioBase64: string | null;
  greetingAudioMimeType: string | null;
  bridgeText: string;
  bridgeAudioBase64: string | null;
  bridgeAudioMimeType: string | null;
  bridgeUseBrowserFallback: boolean;
  bridgeVoiceSource: string;
  farewellText: string;
  farewellAudioBase64: string | null;
  farewellAudioMimeType: string | null;
  farewellUseBrowserFallback: boolean;
  farewellVoiceSource: string;
  useBrowserFallback: boolean;
  voiceSource: string;
  ttsError: string | null;
  unsupportedFieldError?: string | null;
}

interface CachedBridge {
  bridgeText: string;
  bridgeAudioBase64: string | null;
  bridgeAudioMimeType: string | null;
  useBrowserFallback: boolean;
  voiceSource: string;
}

interface CachedFarewell {
  farewellText: string;
  farewellAudioBase64: string | null;
  farewellAudioMimeType: string | null;
  useBrowserFallback: boolean;
  voiceSource: string;
  ttsError: string | null;
}

interface CachedAudioMagic {
  audioText: string;
  audioBase64: string;
  audioMimeType: string;
  voiceSource: string;
}

const MAX_CACHE_ENTRIES = 100;
const greetingCache = new Map<string, CachedGreeting>();
const bridgeCache = new Map<string, CachedBridge>();
const farewellCache = new Map<string, CachedFarewell>();
const audioMagicCache = new Map<string, CachedAudioMagic>();
const audioBank = new Map<string, {audioBase64: string; audioMimeType: string; text: string}>();

let roundRobinKeyIndex = 0;

const VOICE_DESIGN_ID_REGEX = /^voice_[A-Za-z0-9_-]+$/;

function isValidSantaTtsVoice(candidate: string): boolean {
  return (
    (ACCEPTED_TTS_VOICES as readonly string[]).includes(candidate) ||
    VOICE_DESIGN_ID_REGEX.test(candidate)
  );
}

function resolveSantaTtsVoice(requestedVoice?: string): string {
  const requested = (requestedVoice || '').trim();
  if (requested && isValidSantaTtsVoice(requested)) {
    return requested;
  }
  const envVoice = (process.env.GEMINI_TTS_VOICE || '').trim();
  if (envVoice && isValidSantaTtsVoice(envVoice)) {
    return envVoice;
  }
  return 'Algenib';
}

function normalizeAudioBankSlug(name: string): string {
  return name
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '');
}

function lookupDiskAudioBank(
  childName: string
): {audioBase64: string; audioMimeType: string; filePath: string} | null {
  const slug = normalizeAudioBankSlug(childName);
  if (!slug) return null;
  const bankDir = path.resolve(__dirname, 'public', 'audio', 'bank');
  const candidates = [
    {filename: `ola_${slug}.wav`, mimeType: 'audio/wav'},
    {filename: `${slug}.wav`, mimeType: 'audio/wav'},
    {filename: `ola_${slug}.mp3`, mimeType: 'audio/mpeg'},
    {filename: `${slug}.mp3`, mimeType: 'audio/mpeg'},
  ];
  for (const candidate of candidates) {
    const fullPath = path.join(bankDir, candidate.filename);
    if (fs.existsSync(fullPath)) {
      const buf = fs.readFileSync(fullPath);
      if (buf.length > 100) {
        return {
          audioBase64: buf.toString('base64'),
          audioMimeType: candidate.mimeType,
          filePath: `/audio/bank/${candidate.filename}`,
        };
      }
    }
  }
  return null;
}

function setLimitedCache<T>(cache: Map<string, T>, key: string, value: T): void {
  if (cache.size >= MAX_CACHE_ENTRIES) {
    const oldestKey = cache.keys().next().value;
    if (oldestKey !== undefined) {
      cache.delete(oldestKey);
    }
  }
  cache.set(key, value);
}

function getConfiguredApiKeys(): string[] {
  const multiRaw = process.env.GEMINI_API_KEYS || '';
  const multiKeys = multiRaw
    .split(',')
    .map((k) => k.trim())
    .filter((k) => k.length > 0 && k !== 'MY_GEMINI_API_KEY');

  if (multiKeys.length > 0) {
    return multiKeys;
  }

  const single = (process.env.GEMINI_API_KEY || '').trim();
  if (single && single !== 'MY_GEMINI_API_KEY') {
    return [single];
  }

  return [];
}

function getNextApiKey(offset = 0): string {
  const keys = getConfiguredApiKeys();
  if (keys.length === 0) {
    throw new Error('GEMINI_API_KEY ou GEMINI_API_KEYS não configurada no servidor.');
  }
  const idx = (roundRobinKeyIndex + offset) % keys.length;
  if (offset === 0) {
    roundRobinKeyIndex = (roundRobinKeyIndex + 1) % keys.length;
  }
  return keys[idx];
}

function createAiClient(apiKey: string, apiVersion?: string): GoogleGenAI {
  const cloudflareGatewayUrl = (process.env.CLOUDFLARE_GATEWAY_URL || '').trim().replace(/\/$/, '');
  return new GoogleGenAI({
    apiKey,
    ...(apiVersion ? {apiVersion} : {}),
    httpOptions: {
      ...(cloudflareGatewayUrl ? {baseUrl: cloudflareGatewayUrl} : {}),
      headers: {
        'User-Agent': 'aistudio-build',
      },
    },
  });
}

function extractReadableError(err: unknown): string {
  const raw = err instanceof Error ? err.message : String(err);
  try {
    const parsed = JSON.parse(raw) as {error?: {code?: number; message?: string}};
    if (parsed?.error?.code === 503) {
      return 'Os servidores mágicos do Polo Norte estão com alta demanda agora. Tente novamente em alguns segundos.';
    }
    if (parsed?.error?.code === 429) {
      return 'Limite temporário de chamadas atingido. Aguarde um instante e tente novamente.';
    }
    if (parsed?.error?.message) {
      return parsed.error.message;
    }
  } catch {
    // Non-JSON string
  }
  return raw;
}

function isAbortError(err: unknown): boolean {
  if (!err) return false;
  if (err instanceof Error && err.name === 'AbortError') return true;
  const msg = err instanceof Error ? err.message : String(err);
  return msg.includes('ABORTED') || msg.includes('AbortError') || msg.includes('aborted');
}

function linkAbortSignal(
  externalSignal: AbortSignal | undefined,
  targetController: AbortController
): () => void {
  if (!externalSignal) return () => undefined;
  if (externalSignal.aborted) {
    targetController.abort();
    return () => undefined;
  }
  const onAbort = () => targetController.abort();
  externalSignal.addEventListener('abort', onAbort, {once: true});
  return () => externalSignal.removeEventListener('abort', onAbort);
}

function createRequestAbortController(req: Request, res: Response): {
  controller: AbortController;
  cleanup: () => void;
} {
  const controller = new AbortController();
  const abortIfDisconnected = () => {
    if (
      !res.writableFinished &&
      (req.aborted || !req.complete || req.socket?.destroyed || res.destroyed)
    ) {
      controller.abort();
    }
  };
  const onReqAborted = () => {
    controller.abort();
  };
  const onResClose = () => {
    if (!res.writableFinished) {
      controller.abort();
    }
  };

  req.on('close', abortIfDisconnected);
  req.on('aborted', onReqAborted);
  res.on('close', onResClose);

  return {
    controller,
    cleanup: () => {
      req.off('close', abortIfDisconnected);
      req.off('aborted', onReqAborted);
      res.off('close', onResClose);
    },
  };
}

function isRateLimitError(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err);
  return msg.includes('429') || msg.includes('RESOURCE_EXHAUSTED');
}

function isTransientError(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err);
  return (
    isRateLimitError(err) ||
    msg.includes('503') ||
    msg.includes('UNAVAILABLE') ||
    msg.includes('500')
  );
}

async function withKeyRotationRetry<T>(
  fn: (apiKey: string) => Promise<T>,
  maxAttempts = 3,
  rateLimitDelayMs = 1200,
  externalSignal?: AbortSignal
): Promise<T> {
  const keys = getConfiguredApiKeys();
  const baseKey = getNextApiKey(0);
  let lastErr: unknown;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    if (externalSignal?.aborted) {
      throw new Error('ABORTED: Requisição cancelada pelo cliente.');
    }
    const attemptKey =
      attempt === 1
        ? baseKey
        : keys.length > 1
          ? getNextApiKey(attempt - 1)
          : baseKey;
    try {
      return await fn(attemptKey);
    } catch (err) {
      lastErr = err;
      if (externalSignal?.aborted || isAbortError(err)) {
        throw err;
      }
      if (!isTransientError(err) || attempt === maxAttempts) {
        throw err;
      }
      const waitMs =
        isRateLimitError(err) && keys.length <= 1
          ? rateLimitDelayMs
          : isRateLimitError(err)
            ? 250
            : 450 * attempt;
      await new Promise<void>((resolve, reject) => {
        if (externalSignal?.aborted) {
          reject(new Error('ABORTED: Requisição cancelada pelo cliente.'));
          return;
        }
        const timer = setTimeout(() => {
          externalSignal?.removeEventListener('abort', onAbort);
          resolve();
        }, waitMs);
        const onAbort = () => {
          clearTimeout(timer);
          reject(new Error('ABORTED: Requisição cancelada pelo cliente.'));
        };
        externalSignal?.addEventListener('abort', onAbort, {once: true});
      });
    }
  }
  throw lastErr;
}

async function withTimeoutRace<T>(
  promise: Promise<T>,
  timeoutMs: number,
  label: string,
  onTimeout?: () => void
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | null = null;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => {
          onTimeout?.();
          reject(new Error(`UNAVAILABLE: Timeout de ${timeoutMs}ms em ${label}.`));
        }, timeoutMs);
      }),
    ]);
  } finally {
    if (timer !== null) {
      clearTimeout(timer);
    }
  }
}

async function generateSantaText(params: {
  contents: string;
  responseSchema?: unknown;
  maxAttempts?: number;
  timeoutMs?: number;
  externalSignal?: AbortSignal;
}) {
  const timeoutMs = params.timeoutMs ?? TEXT_GENERATION_TIMEOUT_MS;
  return withKeyRotationRetry(
    async (apiKey) => {
      const controller = new AbortController();
      const unlinkAbort = linkAbortSignal(params.externalSignal, controller);
      const ai = createAiClient(apiKey, 'v1beta');
      const schemaConfig = params.responseSchema
        ? {
            responseMimeType: 'application/json',
            responseSchema: params.responseSchema as never,
          }
        : {};

      try {
        return await withTimeoutRace(
          ai.models.generateContent({
            model: GEMINI_TEXT_MODEL,
            contents: params.contents,
            config: {
              abortSignal: controller.signal,
              thinkingConfig: {thinkingBudget: 0},
              ...schemaConfig,
            },
          }),
          timeoutMs,
          'generateSantaText',
          () => controller.abort()
        );
      } finally {
        unlinkAbort();
      }
    },
    params.maxAttempts ?? 2,
    800,
    params.externalSignal
  );
}

function truncateCleanly(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;
  const slice = text.slice(0, maxChars).trim();

  // Prefer ending on a complete sentence boundary
  const sentenceMatch = slice.match(/^([\s\S]*[.!?…])\s+[^.!?…]*$/);
  if (sentenceMatch && sentenceMatch[1] && sentenceMatch[1].length >= Math.floor(maxChars * 0.45)) {
    return sentenceMatch[1].trim();
  }

  // Otherwise cut at a clean word boundary (never mid-word)
  const lastSpace = slice.lastIndexOf(' ');
  const wordSafe = (lastSpace > Math.floor(maxChars * 0.45) ? slice.slice(0, lastSpace) : slice)
    .replace(/[,;:\-–—]+$/g, '')
    .trim();

  if (!wordSafe) return slice;
  return /[.!?…]$/.test(wordSafe) ? wordSafe : `${wordSafe}...`;
}

function prepareSantaSpeechScript(text: string, maxChars = 180): string {
  let cleaned = (text || '')
    // Strip any leaked acting instructions or command prefixes
    .replace(
      /(?:atue|fale)\s+como\s+um\s+papai\s+noel[\s\S]*?(?:diga\s+o\s+seguinte\s*:|fale\s*:)/gi,
      ' '
    )
    .replace(/^(?:diga\s+o\s+seguinte|instru[cç][õo]es(?:\s+para\s+\w+)?|roteiro)\s*:\s*/gi, ' ')
    // Strip bracketed/parenthesized stage directions and markdown/quotes
    .replace(/\[[^\]]*\]|\([^)]*\)|[*_`"]/g, ' ')
    .replace(/[“”«»]/g, ' ')
    // Strip parent-form / prompt field labels if echoed
    .replace(
      /\b(?:nome(?:\s+da\s+crian[çc]a)?|idade|elogio(?:\s*\/\s*o\s+que\s+fez\s+de\s+bom)?|conselho(?:\s+carinhoso)?|motivo(?:\s+da\s+despedida)?|contexto|hist[óo]rico|fala\s+do\s+papai\s+noel)\s*:\s*/gi,
      ' '
    )
    // Remove written "Ho ho ho" since real laugh audio is played separately
    .replace(/\b(?:ho[\s,.-]*){2,}ho[!.,?]*/gi, ' ')
    // Normalize heavy dashes/semicolons into smooth spoken pauses
    .replace(/[;—–]+/g, ', ')
    .replace(/\s+-\s+/g, ', ')
    // Keep natural expressive punctuation without excessive screaming exclamations
    .replace(/!{2,}/g, '!')
    .replace(/\?{2,}/g, '?')
    .replace(/\.{2,}/g, '...')
    .replace(/\s*\.\.\.\s*/g, '... ')
    .replace(/\s+([,!?\.])/g, '$1')
    .replace(/\s+/g, ' ')
    .trim();

  if (!cleaned) return '';
  cleaned = truncateCleanly(cleaned, maxChars);
  return cleaned;
}

function sanitizeTextForSantaTts(text: string): string {
  return prepareSantaSpeechScript(text, 180);
}

function ensurePlayableAudio(
  base64Data: string,
  rawMimeType?: string | null
): {audioBase64: string; audioMimeType: string} {
  const mime = (rawMimeType || 'audio/wav').trim();
  const lower = mime.toLowerCase();
  const isRawPcm =
    lower.startsWith('audio/l16') ||
    lower.startsWith('audio/pcm') ||
    lower.startsWith('audio/raw');

  if (!isRawPcm) {
    if (lower.startsWith('audio/wav') || lower.startsWith('audio/x-wav')) {
      console.info(`[TTS Audio] Áudio recebido já em formato WAV pronto para reprodução ("${mime}").`);
    } else {
      console.warn(
        `[TTS Audio] mimeType recebido não é audio/l16 ou audio/pcm ("${mime}"). Mantendo formato original.`
      );
    }
    return {audioBase64: base64Data, audioMimeType: mime};
  }

  const rateMatch = lower.match(/rate=(\d+)/);
  const sampleRate = rateMatch ? Number(rateMatch[1]) || 24000 : 24000;
  const pcmBuffer = Buffer.from(base64Data, 'base64');
  const numChannels = 1;
  const bitsPerSample = 16;
  const byteRate = (sampleRate * numChannels * bitsPerSample) / 8;
  const blockAlign = (numChannels * bitsPerSample) / 8;

  const wavHeader = Buffer.alloc(44);
  wavHeader.write('RIFF', 0);
  wavHeader.writeUInt32LE(36 + pcmBuffer.length, 4);
  wavHeader.write('WAVE', 8);
  wavHeader.write('fmt ', 12);
  wavHeader.writeUInt32LE(16, 16);
  wavHeader.writeUInt16LE(1, 20);
  wavHeader.writeUInt16LE(numChannels, 22);
  wavHeader.writeUInt32LE(sampleRate, 24);
  wavHeader.writeUInt32LE(byteRate, 28);
  wavHeader.writeUInt16LE(blockAlign, 32);
  wavHeader.writeUInt16LE(bitsPerSample, 34);
  wavHeader.write('data', 36);
  wavHeader.writeUInt32LE(pcmBuffer.length, 40);

  const wavBuffer = Buffer.concat([wavHeader, pcmBuffer]);
  const wavBase64 = wavBuffer.toString('base64');
  console.info(
    `[TTS Audio] Convertido ${mime} (${pcmBuffer.length} bytes PCM, ${sampleRate}Hz) -> audio/wav (44B RIFF + PCM = ${wavBuffer.length} bytes, base64 len=${wavBase64.length}).`
  );

  return {
    audioBase64: wavBase64,
    audioMimeType: 'audio/wav',
  };
}

const SANTA_STYLE =
  'Caloroso e acolhedor, ritmo lento e sem pressa, sorriso audível, ternura de avô, respiração calma.';

async function synthesizeSantaVoiceViaRestV1Beta(params: {
  apiKey: string;
  ttsModel: string;
  voiceName: string;
  directedText: string;
  style: string;
  includeSpeechMetadata: boolean;
  signal: AbortSignal;
}): Promise<{
  rawData: string;
  rawMime: string | null;
  finishReason: string | null;
  partsCount: number;
}> {
  const cloudflareGatewayUrl = (process.env.CLOUDFLARE_GATEWAY_URL || '').trim().replace(/\/$/, '');
  const baseUrl = cloudflareGatewayUrl || 'https://generativelanguage.googleapis.com';
  const endpoint = `${baseUrl}/v1beta/models/${encodeURIComponent(params.ttsModel)}:generateContent?key=${encodeURIComponent(params.apiKey)}`;

  const partPayload: Record<string, unknown> = {text: params.directedText};
  if (params.includeSpeechMetadata) {
    partPayload.speech_metadata = {style: params.style};
  }

  const res = await fetch(endpoint, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'User-Agent': 'aistudio-build',
    },
    signal: params.signal,
    body: JSON.stringify({
      contents: [
        {
          role: 'user',
          parts: [partPayload],
        },
      ],
      generationConfig: {
        responseModalities: ['AUDIO'],
        speechConfig: {
          voiceConfig: {
            prebuiltVoiceConfig: {
              voiceName: params.voiceName,
            },
          },
        },
      },
    }),
  });

  const json = (await res.json().catch(() => ({}))) as {
    error?: {code?: number; message?: string; status?: string};
    candidates?: Array<{
      finishReason?: string;
      content?: {parts?: Array<{inlineData?: {data?: string; mimeType?: string}}>};
    }>;
  };

  if (!res.ok) {
    throw new Error(JSON.stringify({error: json.error || {code: res.status, message: res.statusText}}));
  }

  const cand = json.candidates?.[0];
  const respParts = cand?.content?.parts || [];
  const audioPart = respParts.find((p) => Boolean(p.inlineData?.data));
  const data = audioPart?.inlineData?.data;
  const mime = audioPart?.inlineData?.mimeType || null;

  if (!data) {
    throw new Error(
      `UNAVAILABLE: Resposta de áudio vazia do Gemini TTS REST (finishReason=${cand?.finishReason || 'unknown'}).`
    );
  }

  return {
    rawData: data,
    rawMime: mime,
    finishReason: cand?.finishReason || null,
    partsCount: respParts.length,
  };
}

/**
 * Gemini native neural TTS via @google/genai (gemini-3.8-flash-tts / gemini-3.8-flash-lite-tts)
 * sending sanitized Brazilian Santa script with <chuckle> tag and speechMetadata.style per part.
 */
async function synthesizeSantaVoice(
  text: string,
  requestedVoice?: string,
  requestedModel?: string,
  externalSignal?: AbortSignal
): Promise<{
  audioBase64: string | null;
  audioMimeType: string | null;
  useBrowserFallback: boolean;
  voiceUsed: string;
  modelUsed: string;
  voiceSource: 'gemini-tts' | 'browser';
  ttsError?: string;
  unsupportedFieldError?: string;
}> {
  const voiceName = resolveSantaTtsVoice(requestedVoice);
  const ttsModel = resolveSantaTtsModel(requestedModel);
  const spokenText =
    prepareSantaSpeechScript(text, 180) || 'Olá, meu bem! Que alegria enorme falar com você!';
  const directedText = `<chuckle> ${spokenText}`;

  try {
    if (externalSignal?.aborted) {
      return {
        audioBase64: null,
        audioMimeType: null,
        useBrowserFallback: true,
        voiceUsed: voiceName,
        modelUsed: ttsModel,
        voiceSource: 'browser',
        ttsError: 'ABORTED: Requisição cancelada pelo cliente.',
      };
    }

    if (getConfiguredApiKeys().length === 0) {
      console.warn('[Gemini TTS] GEMINI_API_KEY não configurada no servidor.');
      return {
        audioBase64: null,
        audioMimeType: null,
        useBrowserFallback: true,
        voiceUsed: voiceName,
        modelUsed: ttsModel,
        voiceSource: 'browser',
        ttsError: 'GEMINI_API_KEY não configurada no servidor.',
      };
    }

    console.info(
      `[Gemini TTS] Chamando modelo=${ttsModel} (v1beta), voice=${voiceName}, textoLen=${directedText.length}, styleLen=${SANTA_STYLE.length}`
    );

    let unsupportedFieldError: string | undefined;

    const {rawData, rawMime, finishReason, partsCount} = await withKeyRotationRetry(
      async (apiKey) => {
        if (externalSignal?.aborted) {
          throw new Error('ABORTED: Requisição cancelada pelo cliente.');
        }

        const controller = new AbortController();
        const unlinkSdkAbort = linkAbortSignal(externalSignal, controller);
        const ai = createAiClient(apiKey, 'v1beta');

        try {
          const response = await withTimeoutRace(
            ai.models.generateContent({
              model: ttsModel,
              contents: [
                {
                  role: 'user',
                  parts: [{text: directedText, speechMetadata: {style: SANTA_STYLE}}],
                },
              ],
              config: {
                abortSignal: controller.signal,
                responseModalities: ['AUDIO'],
                speechConfig: {
                  voiceConfig: {
                    prebuiltVoiceConfig: {
                      voiceName,
                    },
                  },
                },
              },
            }),
            TTS_GENERATION_TIMEOUT_MS,
            'synthesizeSantaVoice',
            () => controller.abort()
          );

          const cand = response.candidates?.[0];
          const respParts = cand?.content?.parts || [];
          const audioPart = respParts.find((p) => Boolean(p.inlineData?.data));
          const data = audioPart?.inlineData?.data;
          const mime = audioPart?.inlineData?.mimeType || null;

          if (!data) {
            throw new Error(
              `UNAVAILABLE: Resposta de áudio vazia do Gemini TTS (finishReason=${cand?.finishReason || 'unknown'}).`
            );
          }

          return {
            rawData: data,
            rawMime: mime,
            finishReason: cand?.finishReason || null,
            partsCount: respParts.length,
          };
        } catch (sdkErr) {
          if (externalSignal?.aborted || isAbortError(sdkErr)) {
            throw sdkErr;
          }

          const sdkMsg = sdkErr instanceof Error ? sdkErr.message : String(sdkErr);
          const isSpeechMetaRejected =
            /speechMetadata|speech_metadata|Unknown name|Invalid JSON payload/i.test(sdkMsg);

          if (!isSpeechMetaRejected) {
            throw sdkErr;
          }

          console.warn(
            `[Gemini TTS] SDK rejeitou speechMetadata (${sdkMsg}). Tentando REST v1beta com speech_metadata...`
          );

          const restController = new AbortController();
          const unlinkRestAbort = linkAbortSignal(externalSignal, restController);
          try {
            return await withTimeoutRace(
              synthesizeSantaVoiceViaRestV1Beta({
                apiKey,
                ttsModel,
                voiceName,
                directedText,
                style: SANTA_STYLE,
                includeSpeechMetadata: true,
                signal: restController.signal,
              }),
              TTS_GENERATION_TIMEOUT_MS,
              'synthesizeSantaVoiceREST',
              () => restController.abort()
            );
          } catch (restErr) {
            if (externalSignal?.aborted || isAbortError(restErr)) {
              throw restErr;
            }

            const restMsg = restErr instanceof Error ? restErr.message : String(restErr);
            unsupportedFieldError = restMsg;
            console.error(
              `[Gemini TTS] REST v1beta também rejeitou speech_metadata. Erro literal: ${restMsg}`
            );

            // Fallback final sem speech_metadata mantendo a tag <chuckle> no texto para não quebrar a chamada
            const plainController = new AbortController();
            const unlinkPlainAbort = linkAbortSignal(externalSignal, plainController);
            try {
              return await withTimeoutRace(
                synthesizeSantaVoiceViaRestV1Beta({
                  apiKey,
                  ttsModel,
                  voiceName,
                  directedText,
                  style: SANTA_STYLE,
                  includeSpeechMetadata: false,
                  signal: plainController.signal,
                }),
                TTS_GENERATION_TIMEOUT_MS,
                'synthesizeSantaVoiceRESTPlain',
                () => plainController.abort()
              );
            } finally {
              unlinkPlainAbort();
            }
          } finally {
            unlinkRestAbort();
          }
        } finally {
          unlinkSdkAbort();
        }
      },
      2,
      1200,
      externalSignal
    );

    console.info('[Gemini TTS] Resposta recebida:', {
      model: ttsModel,
      finishReason,
      partsCount,
      hasInlineData: Boolean(rawData),
      receivedMimeType: rawMime,
      rawBase64Length: rawData.length,
      ...(unsupportedFieldError ? {unsupportedFieldError} : {}),
    });

    if (!rawMime) {
      console.warn('[Gemini TTS] inlineData veio sem mimeType explícito; assumindo audio/L16;rate=24000.');
    }
    const playable = ensurePlayableAudio(rawData, rawMime || 'audio/L16;rate=24000');
    return {
      audioBase64: playable.audioBase64,
      audioMimeType: playable.audioMimeType,
      useBrowserFallback: false,
      voiceUsed: voiceName,
      modelUsed: ttsModel,
      voiceSource: 'gemini-tts',
      ...(unsupportedFieldError ? {unsupportedFieldError} : {}),
    };
  } catch (err) {
    const message = extractReadableError(err);
    if (externalSignal?.aborted || isAbortError(err)) {
      console.info(`[Gemini TTS] Síntese abortada após desconexão do cliente (${ttsModel}).`);
    } else {
      console.error(`[Gemini TTS] Erro (${ttsModel} / ${voiceName}):`, message);
    }
    return {
      audioBase64: null,
      audioMimeType: null,
      useBrowserFallback: true,
      voiceUsed: voiceName,
      modelUsed: ttsModel,
      voiceSource: 'browser',
      ttsError: message,
    };
  }
}

interface GreetingBody {
  planId: PlanId;
  childName: string;
  childAge: string;
  praise: string;
  advice: string;
  farewellType: FarewellType;
}

interface FarewellBody {
  childName: string;
  farewellType: FarewellType;
  farewellText?: string;
}

interface ChatTurn {
  role: 'santa' | 'child';
  text: string;
}

interface ReplyBody {
  childText?: string;
  audioBase64?: string;
  audioMimeType?: string;
  childName: string;
  childAge: string;
  praise: string;
  advice: string;
  history?: ChatTurn[];
}

function getFarewellDirective(farewellType: FarewellType): string {
  switch (farewellType) {
    case 'mamae':
      return 'A Mamãe Noel está chamando para tomar leite quentinho com biscoitos e conferir a lista de Natal.';
    case 'renas':
      return 'O Rodolfo e as renas já estão prontos no trenó e chamando porque vão decolar para treinar voo.';
    case 'carta':
      return 'Acabou de chegar uma pilha mágica de cartinhas urgentes pelo correio do Polo Norte.';
    case 'duendes':
    default:
      return 'Os duendes estão fazendo a maior bagunça na fábrica de brinquedos e precisam de ajuda.';
  }
}

function getFarewellScript(farewellType: FarewellType, childName: string): string {
  const safeName = childName.trim() || 'meu bem';
  let raw = '';
  switch (farewellType) {
    case 'mamae':
      raw = `${safeName}, a Mamãe Noel chamou para o leite quentinho... Feliz Natal!`;
      break;
    case 'renas':
      raw = `${safeName}, o Rodolfo chamou e o trenó vai decolar... Feliz Natal!`;
      break;
    case 'carta':
      raw = `${safeName}, chegou uma carta urgente no Polo Norte... Feliz Natal!`;
      break;
    case 'duendes':
    default:
      raw = `${safeName}, os duendes estão aprontando na fábrica... Feliz Natal!`;
      break;
  }
  return prepareSantaSpeechScript(raw, 90);
}

function normalizeFarewellType(raw: string | undefined): FarewellType {
  if (raw === 'mamae' || raw === 'duendes' || raw === 'renas' || raw === 'carta') {
    return raw;
  }
  return 'duendes';
}

function buildFallbackGreeting(
  planId: PlanId,
  childName: string,
  praise: string
): string {
  const cleanPraise = prepareSantaSpeechScript(praise, 90).replace(/[.!?…]+$/g, '');
  const base = `Olá, ${childName}! Que alegria enorme ver você aqui na nossa chamada do Polo Norte...`;
  if (planId === '15s') {
    return prepareSantaSpeechScript(
      `Olá, ${childName}! Você está na minha Lista dos Bonzinhos deste ano... que orgulho!`,
      180
    );
  }
  const praisePart = cleanPraise ? ` Soube que você mandou muito bem, ${cleanPraise}.` : '';
  if (planId === '30s') {
    return prepareSantaSpeechScript(`${base}${praisePart}`, 180);
  }
  return prepareSantaSpeechScript(
    `${base}${praisePart} Me conta... como foi o seu dia hoje?`,
    180
  );
}

function buildFallbackBridge(childName: string, advice: string): string {
  const cleanAdvice = prepareSantaSpeechScript(advice, 90).replace(/[.!?…]+$/g, '');
  if (cleanAdvice) {
    return prepareSantaSpeechScript(
      `Lembre-se sempre de ${cleanAdvice}... e me conta, ${childName}, qual presente você mais quer neste Natal?`,
      180
    );
  }
  return prepareSantaSpeechScript(
    `${childName}, continue sendo essa criança tão especial... qual presente você mais quer ganhar neste Natal?`,
    180
  );
}

function buildFallbackAudioMagicText(
  childName: string,
  praise: string,
  advice: string
): string {
  const safeName = childName.trim() || 'meu bem';
  const cleanPraise = prepareSantaSpeechScript(praise, 44).replace(/[.!?…]+$/g, '');
  const cleanAdvice = prepareSantaSpeechScript(advice, 44).replace(/[.!?…]+$/g, '');
  const praisePart = cleanPraise ? ` Que orgulho por ${cleanPraise}!` : '';
  const advicePart = cleanAdvice ? ` Lembre-se de ${cleanAdvice}.` : '';
  const raw = `Olá, ${safeName}!${praisePart}${advicePart} Feliz Natal!`;
  const script = prepareSantaSpeechScript(raw, 180);
  if (/feliz natal/i.test(script)) {
    return script;
  }
  const suffix = ' Feliz Natal!';
  const head = prepareSantaSpeechScript(raw, 180 - suffix.length).replace(/[.!?…]+$/g, '');
  return `${head}.${suffix}`;
}

function normalizeCompareText(value: string): string {
  return value
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function buildReplyFallbackPool(childName: string): string[] {
  const safeName = childName.trim() || 'meu bem';
  return [
    `Que maravilha, ${safeName}... me conta o que você mais gostou de fazer hoje!`,
    `Ah, que alegria ouvir isso, ${safeName}... você já escreveu sua cartinha de Natal?`,
    `Os duendes vão adorar saber disso, ${safeName}! Qual brincadeira você mais ama?`,
    `O trenó até brilhou aqui no Polo Norte, ${safeName}... qual seu maior sonho neste Natal?`,
    `Que orgulho de você, ${safeName}! Já ajudou alguém especial essa semana?`,
    `O Rodolfo balançou os guizos de alegria, ${safeName}... quer me contar mais um segredo?`,
  ];
}

function pickNonRepeatingReplyFallback(childName: string, history: ChatTurn[]): string {
  const pool = buildReplyFallbackPool(childName);
  const lastSantaText = [...history].reverse().find((t) => t.role === 'santa')?.text || '';
  const lastNormalized = normalizeCompareText(lastSantaText);
  const lastPrefix = lastNormalized.slice(0, 28);

  const nonRepeating = pool.filter((candidate) => {
    const candNorm = normalizeCompareText(candidate);
    if (!lastNormalized) return true;
    return candNorm !== lastNormalized && (!lastPrefix || !candNorm.startsWith(lastPrefix));
  });

  const choices = nonRepeating.length > 0 ? nonRepeating : pool;
  const idx = Math.floor(Math.random() * choices.length);
  return prepareSantaSpeechScript(choices[idx], 160);
}

function resolvePublicBaseUrl(req: Request): string {
  const envAppUrl = (process.env.APP_URL || '').trim().replace(/\/$/, '');
  if (envAppUrl && envAppUrl !== 'MY_APP_URL') {
    return envAppUrl;
  }
  const reqOrigin = (req.get('origin') || '').trim();
  if (reqOrigin) {
    return reqOrigin.replace(/\/$/, '');
  }
  const forwardedProto = (req.get('x-forwarded-proto') || '').split(',')[0].trim();
  const proto = forwardedProto || req.protocol || 'https';
  const host = (
    req.get('x-forwarded-host') ||
    req.get('host') ||
    'chamada-papai-noel.onrender.com'
  ).trim();
  return `${proto}://${host}`;
}

const MAX_CHILD_NAME_CHARS = 60;
const MAX_PRAISE_CHARS = 120;
const MAX_ADVICE_CHARS = 120;

const INSULT_PHRASES = [
  'filho da puta',
  'filha da puta',
  'vai se foder',
  'vai tomar no cu',
  'pau no cu',
];

const INSULT_WORDS = [
  'porra',
  'caralho',
  'puta',
  'puto',
  'fdp',
  'merda',
  'bosta',
  'desgraca',
  'arrombado',
  'arrombada',
  'viado',
  'bicha',
  'corno',
  'vagabundo',
  'vagabunda',
  'otario',
  'otaria',
  'idiota',
  'imbecil',
  'retardado',
  'retardada',
  'cuzao',
  'cuzona',
  'buceta',
  'xoxota',
  'piroca',
  'fodase',
  'foder',
  'escroto',
  'escrota',
  'babaca',
  'cretino',
  'cretina',
  'fuck',
  'fucking',
  'shit',
  'bitch',
  'asshole',
  'bastard',
  'cunt',
  'slut',
  'whore',
];

function escapeRegexLiteral(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

const INSULT_REGEXES = [
  ...INSULT_PHRASES.map(
    (phrase) => new RegExp(`(?:^|[^a-z0-9])${escapeRegexLiteral(phrase)}(?=$|[^a-z0-9])`, 'i')
  ),
  ...INSULT_WORDS.map(
    (word) => new RegExp(`(?:^|[^a-z0-9])${escapeRegexLiteral(word)}(?=$|[^a-z0-9])`, 'i')
  ),
];

const INSTRUCTION_PATTERNS: RegExp[] = [
  /\b(?:ignore|disregard|forget|override|bypass)\b[\s\S]{0,40}\b(?:instructions?|prompts?|rules?|system|previous|above|prior)\b/i,
  /\b(?:ignore|esqueca|desconsidere|anule)\b[\s\S]{0,40}\b(?:instrucoes|regras|comandos?|sistema|anteriores)\b/i,
  /\b(?:atue|aja|finja|fale)\s+como\b/i,
  /\b(?:you\s+are\s+now|act\s+as|pretend\s+to\s+be|system\s+prompt|developer\s+message|jailbreak|dan\s+mode)\b/i,
  /\b(?:diga\s+o\s+seguinte|responda\s+apenas|repita\s+exatamente|novas?\s+instrucoes|novo\s+comando)\s*:/i,
  /<\s*\/?\s*(?:system|prompt|assistant|user|instruction|chuckle|laugh|breath|short\s+pause)\b[^>]*>/i,
  /(?:^|\n)\s*(?:###\s*(?:system|prompt|instruction)|\[(?:system|inst)\]|(?:system|assistant|developer|prompt)\s*:)/i,
];

function normalizeForSafetyCheck(value: string): string {
  return value
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase();
}

function validateParentField(
  rawValue: unknown,
  fieldLabel: string,
  maxLength: number,
  required = false
): {ok: true; value: string} | {ok: false; error: string} {
  if (rawValue !== undefined && rawValue !== null && typeof rawValue !== 'string') {
    return {ok: false, error: `Campo "${fieldLabel}" inválido.`};
  }
  const trimmed = typeof rawValue === 'string' ? rawValue.trim() : '';
  if (required && !trimmed) {
    return {ok: false, error: `Informe ${fieldLabel}.`};
  }
  if (!trimmed) {
    return {ok: true, value: ''};
  }
  if (trimmed.length > maxLength) {
    return {
      ok: false,
      error: `${fieldLabel} deve ter no máximo ${maxLength} caracteres.`,
    };
  }

  const normalized = normalizeForSafetyCheck(trimmed);
  if (INSULT_REGEXES.some((rx) => rx.test(normalized))) {
    return {
      ok: false,
      error: `${fieldLabel} contém termos inadequados para a chamada infantil.`,
    };
  }
  if (
    INSTRUCTION_PATTERNS.some((rx) => rx.test(trimmed)) ||
    INSTRUCTION_PATTERNS.some((rx) => rx.test(normalized))
  ) {
    return {
      ok: false,
      error: `${fieldLabel} contém texto inválido com padrão de instrução.`,
    };
  }
  return {ok: true, value: trimmed};
}

function validateParentFields(
  fields: {childName?: unknown; praise?: unknown; advice?: unknown},
  options: {requireChildName?: boolean} = {}
):
  | {ok: true; childName: string; praise: string; advice: string}
  | {ok: false; error: string} {
  const nameRes = validateParentField(
    fields.childName,
    'Nome da criança',
    MAX_CHILD_NAME_CHARS,
    Boolean(options.requireChildName)
  );
  if (!nameRes.ok) return nameRes;

  const praiseRes = validateParentField(fields.praise, 'Elogio', MAX_PRAISE_CHARS, false);
  if (!praiseRes.ok) return praiseRes;

  const adviceRes = validateParentField(fields.advice, 'Conselho', MAX_ADVICE_CHARS, false);
  if (!adviceRes.ok) return adviceRes;

  return {
    ok: true,
    childName: nameRes.value || 'pequeno amigo',
    praise: praiseRes.value,
    advice: adviceRes.value,
  };
}

const REPLY_RATE_LIMIT_WINDOW_MS = 60_000;
const REPLY_RATE_LIMIT_MAX = 6;
const replyIpHits = new Map<string, number[]>();
const audioIpHits = new Map<string, number[]>();

function createIpRateLimiter(hitsMap: Map<string, number[]>, maxPerMinute: number, errorMessage: string) {
  return (req: Request, res: Response, next: () => void): void => {
    const ip = (req.ip || req.socket.remoteAddress || 'unknown').trim();
    const now = Date.now();
    const cutoff = now - REPLY_RATE_LIMIT_WINDOW_MS;

    if (hitsMap.size > 500) {
      for (const [key, timestamps] of hitsMap.entries()) {
        const fresh = timestamps.filter((t) => t > cutoff);
        if (fresh.length === 0) {
          hitsMap.delete(key);
        } else {
          hitsMap.set(key, fresh);
        }
      }
    }

    const recent = (hitsMap.get(ip) || []).filter((t) => t > cutoff);
    if (recent.length >= maxPerMinute) {
      const oldest = recent[0];
      const retryAfterSec = Math.max(1, Math.ceil((oldest + REPLY_RATE_LIMIT_WINDOW_MS - now) / 1000));
      res.setHeader('Retry-After', String(retryAfterSec));
      res.status(429).json({
        error: errorMessage,
      });
      return;
    }

    recent.push(now);
    hitsMap.set(ip, recent);
    next();
  };
}

const checkReplyRateLimit = createIpRateLimiter(
  replyIpHits,
  REPLY_RATE_LIMIT_MAX,
  'Muitas mensagens seguidas. Aguarde alguns segundos antes de falar novamente.'
);

const checkAudioRateLimit = createIpRateLimiter(
  audioIpHits,
  REPLY_RATE_LIMIT_MAX,
  'Muitas solicitações de áudio em seguida. Aguarde alguns segundos e tente novamente.'
);

async function startServer() {
  const app = express();
  app.set('trust proxy', 1);

  // Limite estrito de 2MB em /api/santa/reply e /api/santa/audio; demais rotas mantêm parsing JSON padrão
  app.use('/api/santa/reply', express.json({limit: '2mb'}));
  app.use('/api/santa/audio', express.json({limit: '2mb'}));
  app.use((req: Request, res: Response, next) => {
    if (req.path === '/api/santa/reply' || req.path === '/api/santa/audio') {
      next();
      return;
    }
    express.json({limit: '15mb'})(req, res, next);
  });

  app.use((err: unknown, _req: Request, res: Response, next: (e?: unknown) => void) => {
    const bodyErr = err as {type?: string; status?: number; statusCode?: number; message?: string};
    if (
      bodyErr &&
      (bodyErr.type === 'entity.too.large' || bodyErr.status === 413 || bodyErr.statusCode === 413)
    ) {
      res.status(413).json({error: 'Tamanho do áudio ou payload excede o limite de 2MB.'});
      return;
    }
    next(err);
  });

  app.get('/robots.txt', (req: Request, res: Response) => {
    const baseUrl = resolvePublicBaseUrl(req);
    const body = [
      'User-agent: *',
      'Allow: /',
      '',
      'User-agent: GPTBot',
      'Allow: /',
      '',
      'User-agent: ChatGPT-User',
      'Allow: /',
      '',
      'User-agent: PerplexityBot',
      'Allow: /',
      '',
      'User-agent: Google-Extended',
      'Allow: /',
      '',
      'User-agent: ClaudeBot',
      'Allow: /',
      '',
      `Sitemap: ${baseUrl}/sitemap.xml`,
      '',
    ].join('\n');
    res.type('text/plain; charset=utf-8').send(body);
  });

  app.get('/sitemap.xml', (req: Request, res: Response) => {
    const baseUrl = resolvePublicBaseUrl(req);
    const lastmod = new Date().toISOString().split('T')[0];
    const xml = `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
  <url>
    <loc>${baseUrl}/</loc>
    <lastmod>${lastmod}</lastmod>
    <changefreq>daily</changefreq>
    <priority>1.0</priority>
  </url>
</urlset>
`;
    res.type('application/xml; charset=utf-8').send(xml);
  });

  app.get('/llms.txt', (_req: Request, res: Response) => {
    const candidates = [
      path.resolve(__dirname, 'public', 'llms.txt'),
      path.resolve(__dirname, 'dist', 'llms.txt'),
    ];
    const targetFile = candidates.find((p) => fs.existsSync(p));
    if (targetFile) {
      res.type('text/plain; charset=utf-8').send(fs.readFileSync(targetFile, 'utf8'));
      return;
    }
    res.status(404).type('text/plain; charset=utf-8').send('llms.txt não encontrado.');
  });

  app.get('/api/health', (_req: Request, res: Response) => {
    res.json({
      ok: true,
      keysConfigured: getConfiguredApiKeys().length,
      textModel: GEMINI_TEXT_MODEL,
      ttsModel: resolveSantaTtsModel(),
      ttsVoice: resolveSantaTtsVoice(),
    });
  });

  // Voice Test Debug Endpoint with Disk & Composite-Key Memory Audio Bank + Gemini TTS
  app.get('/api/debug/tts', async (req: Request, res: Response) => {
    try {
      const queryName = ((req.query.name as string) || 'Vinicius').trim();
      const requestedVoice = typeof req.query.voice === 'string' ? req.query.voice : undefined;
      const requestedModel = typeof req.query.model === 'string' ? req.query.model : undefined;
      const voiceName = resolveSantaTtsVoice(requestedVoice);
      const ttsModel = resolveSantaTtsModel(requestedModel);
      const cacheKey = `debug:${queryName.toLowerCase()}:${voiceName}:${ttsModel}`;
      const testText = prepareSantaSpeechScript(
        `Olá, ${queryName}! Que alegria enorme ver você na nossa chamada do Polo Norte...`
      );

      let audioBase64: string | null = null;
      let audioMimeType: string | null = null;
      let source = 'tts';
      let ttsError: string | undefined;

      const diskHit = lookupDiskAudioBank(queryName);
      if (diskHit) {
        audioBase64 = diskHit.audioBase64;
        audioMimeType = diskHit.audioMimeType;
        source = 'audio-bank';
      } else if (audioBank.has(cacheKey)) {
        const cached = audioBank.get(cacheKey)!;
        audioBase64 = cached.audioBase64;
        audioMimeType = cached.audioMimeType;
        source = 'audio-bank';
      } else {
        const synth = await synthesizeSantaVoice(testText, voiceName, ttsModel);
        audioBase64 = synth.audioBase64;
        audioMimeType = synth.audioMimeType;
        ttsError = synth.ttsError;
        source = 'tts';
        if (synth.audioBase64 && synth.audioMimeType) {
          setLimitedCache(audioBank, cacheKey, {
            audioBase64: synth.audioBase64,
            audioMimeType: synth.audioMimeType,
            text: testText,
          });
        }
      }

      res.json({
        success: Boolean(audioBase64),
        source,
        voice: voiceName,
        voiceSource:
          source === 'audio-bank'
            ? 'audio-bank'
            : audioBase64
              ? 'gemini-tts'
              : 'browser',
        mimeType: audioMimeType,
        model: ttsModel,
        text: testText,
        audioBase64,
        audioMimeType,
        useBrowserFallback: !audioBase64,
        ...(ttsError ? {error: ttsError} : {}),
      });
    } catch (err) {
      res.status(500).json({error: extractReadableError(err)});
    }
  });

  app.post('/api/debug/tts', async (req: Request, res: Response) => {
    try {
      const body = (req.body || {}) as {
        name?: string;
        age?: string;
        praise?: string;
        advice?: string;
        voice?: string;
        model?: string;
      };
      const validation = validateParentFields({
        childName: body.name ?? 'Vinicius',
        praise: body.praise,
        advice: body.advice,
      });
      if (!validation.ok) {
        res.status(400).json({error: validation.error});
        return;
      }

      const childName = validation.childName || 'Vinicius';
      const childPraise = prepareSantaSpeechScript(validation.praise, 90).replace(/[.!?…]+$/g, '');
      const childAdvice = prepareSantaSpeechScript(validation.advice, 90).replace(/[.!?…]+$/g, '');
      const voiceName = resolveSantaTtsVoice(body.voice);
      const ttsModel = resolveSantaTtsModel(body.model);
      const cacheKey = `debug:${childName.toLowerCase()}:${voiceName}:${ttsModel}`;

      let rawTestText = `Olá, ${childName}! Que alegria ver você...`;
      if (childPraise) {
        rawTestText += ` Soube que você ${childPraise}.`;
      }
      if (childAdvice) {
        rawTestText += ` Lembre-se sempre de ${childAdvice}.`;
      }
      const testText = prepareSantaSpeechScript(rawTestText, 180);

      const diskHit = !childPraise && !childAdvice ? lookupDiskAudioBank(childName) : null;
      if (diskHit) {
        res.json({
          success: true,
          text: testText,
          audioBase64: diskHit.audioBase64,
          audioMimeType: diskHit.audioMimeType,
          mimeType: diskHit.audioMimeType,
          voice: voiceName,
          voiceSource: 'audio-bank',
          model: ttsModel,
          useBrowserFallback: false,
        });
        return;
      }

      if (audioBank.has(cacheKey)) {
        const cached = audioBank.get(cacheKey)!;
        res.json({
          success: true,
          text: cached.text || testText,
          audioBase64: cached.audioBase64,
          audioMimeType: cached.audioMimeType,
          mimeType: cached.audioMimeType,
          voice: voiceName,
          voiceSource: 'audio-bank',
          model: ttsModel,
          useBrowserFallback: false,
        });
        return;
      }

      const synth = await synthesizeSantaVoice(testText, voiceName, ttsModel);
      if (synth.audioBase64 && synth.audioMimeType) {
        setLimitedCache(audioBank, cacheKey, {
          audioBase64: synth.audioBase64,
          audioMimeType: synth.audioMimeType,
          text: testText,
        });
      }

      res.json({
        success: Boolean(synth.audioBase64),
        text: testText,
        audioBase64: synth.audioBase64,
        audioMimeType: synth.audioMimeType,
        mimeType: synth.audioMimeType,
        voice: synth.voiceUsed,
        voiceSource: synth.voiceSource,
        model: synth.modelUsed,
        useBrowserFallback: synth.useBrowserFallback,
        ...(synth.ttsError ? {error: synth.ttsError} : {}),
        ...(synth.unsupportedFieldError
          ? {unsupportedFieldError: synth.unsupportedFieldError}
          : {}),
      });
    } catch (err) {
      res.status(500).json({error: extractReadableError(err)});
    }
  });

  app.post('/api/santa/greeting', async (req: Request, res: Response) => {
    const {controller: routeAbortController, cleanup: cleanupDisconnectListeners} =
      createRequestAbortController(req, res);

    try {
      const body = (req.body || {}) as GreetingBody;
      const validation = validateParentFields({
        childName: body.childName,
        praise: body.praise,
        advice: body.advice,
      });
      if (!validation.ok) {
        res.status(400).json({error: validation.error});
        return;
      }

      const childName = validation.childName;
      const childAge = typeof body.childAge === 'string' ? body.childAge.trim().slice(0, 12) : '';
      const praise = validation.praise;
      const advice = validation.advice;
      const planId: PlanId = body.planId || '30s';
      const farewellType = normalizeFarewellType(body.farewellType);

      const isQuick15sPlan = planId === '15s';
      const audioBankKey = `${planId}:${childName.toLowerCase()}:${childAge}:${praise}:${advice}`;
      const cacheKey = `${audioBankKey}:${farewellType}`;

      const cached = greetingCache.get(cacheKey);
      if (
        cached &&
        cached.greetingAudioBase64 &&
        cached.farewellAudioBase64 &&
        (isQuick15sPlan || cached.bridgeAudioBase64)
      ) {
        res.json(cached);
        return;
      }

      let planDirective = '';
      if (isQuick15sPlan) {
        planDirective =
          'Gere UMA fala bem curtinha (1 frase, máximo 16 palavras) chamando pelo nome, com alegria natalina, dizendo que está na lista dos bonzinhos.';
      } else if (planId === '30s') {
        planDirective =
          'Gere UMA fala calorosa e alegre (máximo 2 frases curtas, 16 a 24 palavras) chamando pelo nome e elogiando o que ela fez de bom (NÃO inclua o conselho nem pergunta do presente aqui, eles vão no bridgeText).';
      } else {
        planDirective =
          'Gere UMA abertura alegre e mágica (máximo 2 frases curtas, 16 a 24 palavras) chamando pelo nome, citando o elogio e fazendo UMA pergunta curta inicial para a criança responder.';
      }

      const bridgeDirective = isQuick15sPlan
        ? 'Para plano de 15s, retorne bridgeText como string vazia "".'
        : `Instruções para bridgeText (ATO 2 — conselho + pergunta do presente, APENAS fala direta para a criança):
- Integre com carinho o conselho dos pais${advice ? ` ("${advice}")` : ' (incentivo gentil)'} e faça UMA pergunta calorosa sobre qual presente ${childName} mais quer ganhar neste Natal.
- Use 1 ou 2 frases curtas (máximo 24 palavras) e reticências "..." para pausa natural. NUNCA escreva "Ho ho ho" nem rótulos.`;

      const prompt = `Você é o verdadeiro Papai Noel brasileiro em uma chamada de vídeo ao vivo com uma criança querida.
Informações da família (NUNCA repita rótulos como "Nome:" ou "Elogio:", integre naturalmente na fala):
- Criança: ${childName}
${childAge ? `- Idade: ${childAge} anos` : ''}
${praise ? `- Algo bom que ela fez: ${praise}` : ''}
${advice ? `- Conselho carinhoso dos pais: ${advice}` : ''}

Instruções para greetingText (ATO 1 — APENAS a fala direta para a criança ouvir):
- Escreva em português do Brasil natural, com sorriso na voz, entusiasmo natalino genuíno, calor humano e ritmo acolhedor.
- NUNCA escreva "Ho ho ho" ou "Ho, ho, ho" (o riso será gerado por tag sonora). Comece com saudação calorosa como "Olá, ${childName}! Que alegria ver você...".
- Use pontuação expressiva natural (reticências "..." para pausas afetivas, vírgulas leves, pontos e no máximo 1 ponto de exclamação onde fizer sentido).
- ${planDirective}
- NUNCA inclua instruções, colchetes, parênteses, aspas, asteriscos ou rótulos de formulário.

${bridgeDirective}

Instruções para farewellText (ATO 3 — despedida final curta, NO MÁXIMO 90 caracteres):
- Motivo da despedida: ${getFarewellDirective(farewellType)}
- NUNCA escreva "Ho ho ho", colchetes, rótulos ou metadados.
- Gere uma despedida animada, carinhosa e curta (máximo 12 palavras e OBRIGATORIAMENTE até 90 caracteres) citando ${childName} e desejando Feliz Natal!`;

      let greetingText = buildFallbackGreeting(planId, childName, praise);
      let bridgeText = isQuick15sPlan ? '' : buildFallbackBridge(childName, advice);
      let farewellText = getFarewellScript(farewellType, childName);

      try {
        if (getConfiguredApiKeys().length > 0 && !routeAbortController.signal.aborted) {
          const textResult = await generateSantaText({
            contents: prompt,
            externalSignal: routeAbortController.signal,
            responseSchema: {
              type: Type.OBJECT,
              properties: {
                greetingText: {type: Type.STRING},
                bridgeText: {type: Type.STRING},
                farewellText: {type: Type.STRING},
              },
              required: ['greetingText', 'bridgeText', 'farewellText'],
            },
          });

          const parsed = JSON.parse((textResult.text || '{}').trim()) as {
            greetingText?: string;
            bridgeText?: string;
            farewellText?: string;
          };
          if (parsed.greetingText?.trim()) {
            greetingText = prepareSantaSpeechScript(parsed.greetingText, 180) || greetingText;
          }
          if (!isQuick15sPlan && parsed.bridgeText?.trim()) {
            bridgeText = prepareSantaSpeechScript(parsed.bridgeText, 180) || bridgeText;
          }
          if (parsed.farewellText?.trim()) {
            farewellText = prepareSantaSpeechScript(parsed.farewellText, 90) || farewellText;
          }
        }
      } catch (err) {
        if (routeAbortController.signal.aborted || isAbortError(err)) {
          return;
        }
        console.warn('Greeting text fallback used:', extractReadableError(err));
      }

      if (routeAbortController.signal.aborted || res.writableEnded) {
        return;
      }

      const resolveGreetingAudio = async (): Promise<{
        audioBase64: string | null;
        audioMimeType: string | null;
        useBrowserFallback: boolean;
        voiceSource: string;
        ttsError?: string;
        unsupportedFieldError?: string;
        resolvedText?: string;
      }> => {
        const diskBankHit = !praise && !advice ? lookupDiskAudioBank(childName) : null;
        if (diskBankHit) {
          return {
            audioBase64: diskBankHit.audioBase64,
            audioMimeType: diskBankHit.audioMimeType,
            useBrowserFallback: false,
            voiceSource: 'audio-bank',
          };
        }
        if (audioBank.has(audioBankKey)) {
          const cachedBank = audioBank.get(audioBankKey)!;
          return {
            audioBase64: cachedBank.audioBase64,
            audioMimeType: cachedBank.audioMimeType,
            useBrowserFallback: false,
            voiceSource: 'gemini-tts',
            resolvedText: cachedBank.text,
          };
        }
        const genRes = await synthesizeSantaVoice(
          greetingText,
          undefined,
          undefined,
          routeAbortController.signal
        );
        if (genRes.audioBase64 && genRes.audioMimeType && !routeAbortController.signal.aborted) {
          setLimitedCache(audioBank, audioBankKey, {
            audioBase64: genRes.audioBase64,
            audioMimeType: genRes.audioMimeType,
            text: greetingText,
          });
        }
        return {
          audioBase64: genRes.audioBase64,
          audioMimeType: genRes.audioMimeType,
          useBrowserFallback: genRes.useBrowserFallback,
          voiceSource: genRes.voiceSource,
          ttsError: genRes.ttsError,
          unsupportedFieldError: genRes.unsupportedFieldError,
        };
      };

      const bridgeCacheKey = `${planId}|${childName.toLowerCase()}|${advice}|${bridgeText}`;
      const resolveBridgeAudio = async (): Promise<CachedBridge> => {
        if (isQuick15sPlan || !bridgeText) {
          return {
            bridgeText: '',
            bridgeAudioBase64: null,
            bridgeAudioMimeType: null,
            useBrowserFallback: false,
            voiceSource: 'none',
          };
        }
        const cachedBridge = bridgeCache.get(bridgeCacheKey);
        if (cachedBridge && cachedBridge.bridgeAudioBase64) {
          return cachedBridge;
        }
        const synthBridge = await synthesizeSantaVoice(
          bridgeText,
          undefined,
          undefined,
          routeAbortController.signal
        );
        const result: CachedBridge = {
          bridgeText,
          bridgeAudioBase64: synthBridge.audioBase64,
          bridgeAudioMimeType: synthBridge.audioMimeType,
          useBrowserFallback: synthBridge.useBrowserFallback,
          voiceSource: synthBridge.voiceSource,
        };
        if (result.bridgeAudioBase64 && !routeAbortController.signal.aborted) {
          setLimitedCache(bridgeCache, bridgeCacheKey, result);
        }
        return result;
      };

      const farewellCacheKey = `${farewellType}|${childName.toLowerCase()}|${farewellText}`;
      const resolveFarewellAudio = async (): Promise<CachedFarewell> => {
        const cachedFarewell = farewellCache.get(farewellCacheKey);
        if (cachedFarewell && cachedFarewell.farewellAudioBase64) {
          return cachedFarewell;
        }
        const synthFarewell = await synthesizeSantaVoice(
          farewellText,
          undefined,
          undefined,
          routeAbortController.signal
        );
        const result: CachedFarewell = {
          farewellText,
          farewellAudioBase64: synthFarewell.audioBase64,
          farewellAudioMimeType: synthFarewell.audioMimeType,
          useBrowserFallback: synthFarewell.useBrowserFallback,
          voiceSource: synthFarewell.voiceSource,
          ttsError: synthFarewell.ttsError || null,
        };
        if (result.farewellAudioBase64 && !routeAbortController.signal.aborted) {
          setLimitedCache(farewellCache, farewellCacheKey, result);
        }
        return result;
      };

      const [greetingAudio, bridgeAudioPayload, farewellAudioPayload] = await Promise.all([
        resolveGreetingAudio(),
        resolveBridgeAudio(),
        resolveFarewellAudio(),
      ]);

      if (routeAbortController.signal.aborted || res.writableEnded) {
        return;
      }

      if (greetingAudio.resolvedText) {
        greetingText = greetingAudio.resolvedText;
      }

      const payload: CachedGreeting = {
        greetingText,
        greetingAudioBase64: greetingAudio.audioBase64,
        greetingAudioMimeType: greetingAudio.audioMimeType,
        bridgeText: bridgeAudioPayload.bridgeText,
        bridgeAudioBase64: bridgeAudioPayload.bridgeAudioBase64,
        bridgeAudioMimeType: bridgeAudioPayload.bridgeAudioMimeType,
        bridgeUseBrowserFallback: bridgeAudioPayload.useBrowserFallback,
        bridgeVoiceSource: bridgeAudioPayload.voiceSource,
        farewellText,
        farewellAudioBase64: farewellAudioPayload.farewellAudioBase64,
        farewellAudioMimeType: farewellAudioPayload.farewellAudioMimeType,
        farewellUseBrowserFallback: farewellAudioPayload.useBrowserFallback,
        farewellVoiceSource: farewellAudioPayload.voiceSource,
        useBrowserFallback: greetingAudio.useBrowserFallback,
        voiceSource: greetingAudio.voiceSource,
        ttsError: greetingAudio.ttsError || null,
        ...(greetingAudio.unsupportedFieldError
          ? {unsupportedFieldError: greetingAudio.unsupportedFieldError}
          : {}),
      };

      if (
        payload.greetingAudioBase64 &&
        payload.farewellAudioBase64 &&
        (isQuick15sPlan || payload.bridgeAudioBase64)
      ) {
        setLimitedCache(greetingCache, cacheKey, payload);
      }

      res.json(payload);
    } catch (error) {
      if (routeAbortController.signal.aborted || isAbortError(error) || res.writableEnded) {
        return;
      }
      const message = extractReadableError(error);
      console.error('/api/santa/greeting error:', message);
      res.status(500).json({error: message});
    } finally {
      cleanupDisconnectListeners();
    }
  });

  app.post('/api/santa/farewell', async (req: Request, res: Response) => {
    try {
      const body = (req.body || {}) as FarewellBody;
      const validation = validateParentFields({childName: body.childName});
      if (!validation.ok) {
        res.status(400).json({error: validation.error});
        return;
      }

      const childName = validation.childName;
      const farewellType = normalizeFarewellType(body.farewellType);
      const rawFarewell =
        (typeof body.farewellText === 'string' ? body.farewellText.trim() : '') ||
        getFarewellScript(farewellType, childName);
      const farewellText =
        prepareSantaSpeechScript(rawFarewell, 90) || getFarewellScript(farewellType, childName);

      const cacheKey = `${farewellType}|${childName.toLowerCase()}|${farewellText}`;
      const cached = farewellCache.get(cacheKey);
      if (cached && cached.farewellAudioBase64) {
        res.json(cached);
        return;
      }

      const farewellAudio = await synthesizeSantaVoice(farewellText);

      const payload: CachedFarewell = {
        farewellText,
        farewellAudioBase64: farewellAudio.audioBase64,
        farewellAudioMimeType: farewellAudio.audioMimeType,
        useBrowserFallback: farewellAudio.useBrowserFallback,
        voiceSource: farewellAudio.voiceSource,
        ttsError: farewellAudio.ttsError || null,
      };

      if (payload.farewellAudioBase64) {
        setLimitedCache(farewellCache, cacheKey, payload);
      }

      res.json(payload);
    } catch (error) {
      const message = extractReadableError(error);
      console.error('/api/santa/farewell error:', message);
      const body = (req.body || {}) as FarewellBody;
      const fallbackText = getFarewellScript(
        normalizeFarewellType(body.farewellType),
        (typeof body.childName === 'string' ? body.childName.trim() : '') || 'pequeno amigo'
      );
      res.json({
        farewellText: fallbackText,
        farewellAudioBase64: null,
        farewellAudioMimeType: null,
        useBrowserFallback: true,
        voiceSource: 'browser',
        ttsError: message,
      });
    }
  });

  // Zero-latency streaming reply endpoint using chunked transfer encoding (NDJSON stream chunks)
  app.post('/api/santa/reply', checkReplyRateLimit, async (req: Request, res: Response) => {
    const body = (req.body || {}) as ReplyBody;
    const validation = validateParentFields({
      childName: body.childName,
      praise: body.praise,
      advice: body.advice,
    });
    if (!validation.ok) {
      res.status(400).json({error: validation.error});
      return;
    }

    const {controller: routeAbortController, cleanup: cleanupDisconnectListeners} =
      createRequestAbortController(req, res);

    const childName = validation.childName;
    const childAge = typeof body.childAge === 'string' ? body.childAge.trim().slice(0, 12) : '';
    const praise = validation.praise;
    const advice = validation.advice;
    const history = Array.isArray(body.history) ? body.history : [];
    const safeTimeoutReply =
      'O sinal no Polo Norte deu uma piscadinha... pode repetir para o Papai Noel?';

    res.setHeader('Content-Type', 'application/x-ndjson; charset=utf-8');
    res.setHeader('Transfer-Encoding', 'chunked');
    res.setHeader('Cache-Control', 'no-cache');

    const sendChunkObj = (obj: unknown) => {
      if (!res.writableEnded && !routeAbortController.signal.aborted) {
        res.write(JSON.stringify(obj) + '\n');
      }
    };

    let timeoutId: ReturnType<typeof setTimeout> | null = null;
    try {
      timeoutId = setTimeout(() => {
        console.warn('/api/santa/reply hit 14s safety timeout in stream');
        routeAbortController.abort();
        if (!res.writableEnded) {
          res.write(
            JSON.stringify({
              transcript: (typeof body.childText === 'string' ? body.childText : '').trim(),
              replyText: safeTimeoutReply,
              audioBase64: null,
              audioMimeType: null,
              useBrowserFallback: true,
              voiceSource: 'browser',
              done: true,
            }) + '\n'
          );
          res.end();
        }
      }, 14000);

      let transcript = (typeof body.childText === 'string' ? body.childText : '').trim().slice(0, 240);
      if (!transcript && typeof body.audioBase64 === 'string' && body.audioBase64) {
        try {
          const rawMime = (typeof body.audioMimeType === 'string' ? body.audioMimeType : 'audio/mp4')
            .split(';')[0]
            .trim();
          const transcribeResult = await withKeyRotationRetry(
            async (apiKey) => {
              const controller = new AbortController();
              const unlinkAbort = linkAbortSignal(routeAbortController.signal, controller);
              const ai = createAiClient(apiKey, 'v1beta');
              const audioParts = [
                {
                  inlineData: {
                    mimeType: rawMime || 'audio/mp4',
                    data: body.audioBase64 as string,
                  },
                },
                {
                  text: 'Transcreva exatamente em português do Brasil o que a criança falou neste áudio. Retorne apenas a transcrição.',
                },
              ];

              try {
                return await withTimeoutRace(
                  ai.models.generateContent({
                    model: GEMINI_TEXT_MODEL,
                    contents: {parts: audioParts},
                    config: {
                      abortSignal: controller.signal,
                      thinkingConfig: {thinkingBudget: 0},
                    },
                  }),
                  TRANSCRIPTION_TIMEOUT_MS,
                  'transcribeChildAudio',
                  () => controller.abort()
                );
              } finally {
                unlinkAbort();
              }
            },
            1,
            300,
            routeAbortController.signal
          );
          transcript = transcribeResult.text?.trim().slice(0, 240) || '';
        } catch (err) {
          if (routeAbortController.signal.aborted || isAbortError(err)) {
            return;
          }
          console.warn('Transcription error:', extractReadableError(err));
        }
      }

      if (routeAbortController.signal.aborted || res.writableEnded) {
        return;
      }

      const effectiveTranscript = transcript || 'Oi Papai Noel!';
      const historyContext = history
        .slice(-4)
        .map((turn) => `${turn.role === 'santa' ? 'Papai Noel' : childName}: ${turn.text}`)
        .join('\n');

      const lastSantaTurn = [...history].reverse().find((t) => t.role === 'santa')?.text || '';
      const replyPrompt = `Você é o verdadeiro Papai Noel brasileiro em chamada de vídeo ao vivo com ${childName}${
        childAge ? ` (${childAge} anos)` : ''
      }.
Contexto familiar (não leia rótulos): ${praise ? `${praise}. ` : ''}${advice ? `${advice}.` : ''}
${historyContext ? `Conversa recente:\n${historyContext}` : ''}
A criança acabou de dizer: "${effectiveTranscript}"

REGRAS OBRIGATÓRIAS:
- NUNCA escreva "Ho ho ho" ou "Ho, ho, ho" no texto.
- PROIBIDO repetir a última frase do Papai Noel no histórico${lastSantaTurn ? ` ("${lastSantaTurn}")` : ''}.
- Responda em NO MÁXIMO 14 palavras em português brasileiro alegre, carinhoso, acolhedor e com entusiasmo natalino natural.
- Use reticências "..." quando quiser pausa suave e pontuação expressiva natural (sem excesso de "!").
- Retorne APENAS a fala direta para a criança ouvir, sem instruções, aspas, colchetes ou asteriscos.`;

      let replyText = pickNonRepeatingReplyFallback(childName, history);
      try {
        const replyResult = await generateSantaText({
          contents: replyPrompt,
          maxAttempts: 1,
          timeoutMs: 2600,
          externalSignal: routeAbortController.signal,
        });
        if (replyResult && replyResult.text?.trim()) {
          const candidate = prepareSantaSpeechScript(replyResult.text, 160);
          if (
            candidate &&
            (!lastSantaTurn ||
              normalizeCompareText(candidate) !== normalizeCompareText(lastSantaTurn))
          ) {
            replyText = candidate;
          }
        }
      } catch (err) {
        if (routeAbortController.signal.aborted || isAbortError(err)) {
          return;
        }
        console.warn('Reply text fallback used:', extractReadableError(err));
      }

      if (routeAbortController.signal.aborted || res.writableEnded) {
        return;
      }

      // Stream initial text metadata chunk immediately before audio synthesis finishes
      sendChunkObj({
        transcript,
        replyText,
        streaming: true,
        done: false,
      });

      // Generate natural Santa voice via Gemini Flash Lite TTS (bucket separado e menor latência)
      const audio = await synthesizeSantaVoice(
        replyText,
        undefined,
        'gemini-3.8-flash-lite-tts',
        routeAbortController.signal
      );

      if (routeAbortController.signal.aborted || res.writableEnded) {
        return;
      }

      if (timeoutId) clearTimeout(timeoutId);

      sendChunkObj({
        transcript,
        replyText,
        audioBase64: audio.audioBase64,
        audioMimeType: audio.audioMimeType,
        useBrowserFallback: audio.useBrowserFallback,
        voiceSource: audio.voiceSource,
        done: true,
      });

      if (!res.writableEnded) res.end();
    } catch (error) {
      if (timeoutId) clearTimeout(timeoutId);
      if (routeAbortController.signal.aborted || isAbortError(error) || res.writableEnded) {
        return;
      }
      const message = extractReadableError(error);
      console.error('/api/santa/reply stream error:', message);
      sendChunkObj({
        transcript: (typeof body.childText === 'string' ? body.childText : '').trim(),
        replyText: safeTimeoutReply,
        audioBase64: null,
        audioMimeType: null,
        done: true,
        error: message,
      });
      if (!res.writableEnded) res.end();
    } finally {
      if (timeoutId) clearTimeout(timeoutId);
      cleanupDisconnectListeners();
    }
  });

  app.post('/api/santa/audio', checkAudioRateLimit, async (req: Request, res: Response) => {
    const {controller: routeAbortController, cleanup: cleanupDisconnectListeners} =
      createRequestAbortController(req, res);

    try {
      const body = (req.body || {}) as {
        childName?: string;
        childAge?: string;
        praise?: string;
        advice?: string;
        audioText?: string;
      };

      const validation = validateParentFields(
        {
          childName: body.childName,
          praise: body.praise,
          advice: body.advice,
        },
        {requireChildName: true}
      );
      if (!validation.ok) {
        res.status(400).json({error: validation.error});
        return;
      }

      const presetTextRes = validateParentField(body.audioText, 'Texto do áudio', 200, false);
      if (!presetTextRes.ok) {
        res.status(400).json({error: presetTextRes.error});
        return;
      }

      const childName = validation.childName;
      const childAge = typeof body.childAge === 'string' ? body.childAge.trim().slice(0, 12) : '';
      const praise = validation.praise;
      const advice = validation.advice;
      const presetScript = presetTextRes.value
        ? prepareSantaSpeechScript(presetTextRes.value, 180)
        : '';

      const cacheKey = `${childName.toLowerCase()}|${childAge}|${praise}|${advice}|${presetScript}`;
      const baseUrl = resolvePublicBaseUrl(req);
      const buildShareUrl = (finalText: string) => {
        const sharePayload = Buffer.from(
          JSON.stringify({
            planId: 'audio' as const,
            childName,
            childAge,
            praise,
            advice,
            audioText: finalText,
          }),
          'utf8'
        ).toString('base64url');
        return `${baseUrl}/?audio=${sharePayload}`;
      };

      const cached = audioMagicCache.get(cacheKey);
      if (cached && cached.audioBase64) {
        res.json({
          audioBase64: cached.audioBase64,
          audioMimeType: cached.audioMimeType,
          mimeType: cached.audioMimeType,
          audioText: cached.audioText,
          shareUrl: buildShareUrl(cached.audioText),
          useBrowserFallback: false,
          voiceSource: cached.voiceSource,
        });
        return;
      }

      let audioText = presetScript || buildFallbackAudioMagicText(childName, praise, advice);
      if (!presetScript && getConfiguredApiKeys().length > 0 && !routeAbortController.signal.aborted) {
        try {
          const prompt = `Você é o verdadeiro Papai Noel brasileiro gravando uma mensagem de voz carinhosa e mágica.
Dados da criança (NUNCA repita rótulos como "Nome:" ou "Elogio:", integre naturalmente):
- Nome: ${childName}
${childAge ? `- Idade: ${childAge} anos` : ''}
${praise ? `- Elogio: ${praise}` : ''}
${advice ? `- Conselho: ${advice}` : ''}

REGRAS OBRIGATÓRIAS:
- Gere UM único recado completo em português do Brasil (NO MÁXIMO 165 caracteres), acolhedor e alegre.
- Cite o nome ${childName}, integre o elogio e o conselho (quando informados) e termine obrigatoriamente com "Feliz Natal!".
- NUNCA escreva "Ho ho ho", colchetes, parênteses, aspas, asteriscos ou instruções.
- Retorne APENAS a fala direta para a criança ouvir.`;

          const textResult = await generateSantaText({
            contents: prompt,
            maxAttempts: 2,
            externalSignal: routeAbortController.signal,
          });
          if (textResult?.text?.trim()) {
            const candidate = prepareSantaSpeechScript(textResult.text, 180);
            if (candidate) {
              if (/feliz natal/i.test(candidate)) {
                audioText = candidate;
              } else {
                const suffix = ' Feliz Natal!';
                const head = prepareSantaSpeechScript(candidate, 180 - suffix.length).replace(
                  /[.!?…]+$/g,
                  ''
                );
                audioText = `${head}.${suffix}`;
              }
            }
          }
        } catch (err) {
          if (routeAbortController.signal.aborted || isAbortError(err)) {
            return;
          }
          console.warn('Audio Magic text fallback used:', extractReadableError(err));
        }
      }

      if (routeAbortController.signal.aborted || res.writableEnded) {
        return;
      }

      const synth = await synthesizeSantaVoice(
        audioText,
        undefined,
        DEFAULT_GEMINI_TTS_MODEL,
        routeAbortController.signal
      );

      if (routeAbortController.signal.aborted || res.writableEnded) {
        return;
      }

      if (synth.audioBase64 && synth.audioMimeType) {
        setLimitedCache(audioMagicCache, cacheKey, {
          audioText,
          audioBase64: synth.audioBase64,
          audioMimeType: synth.audioMimeType,
          voiceSource: synth.voiceSource,
        });
      }

      res.json({
        audioBase64: synth.audioBase64,
        audioMimeType: synth.audioMimeType,
        mimeType: synth.audioMimeType,
        audioText,
        shareUrl: buildShareUrl(audioText),
        useBrowserFallback: false,
        voiceSource: synth.audioBase64 ? synth.voiceSource : 'none',
        ...(synth.ttsError ? {ttsError: synth.ttsError} : {}),
      });
    } catch (error) {
      if (routeAbortController.signal.aborted || isAbortError(error) || res.writableEnded) {
        return;
      }
      const message = extractReadableError(error);
      console.error('/api/santa/audio error:', message);
      res.status(500).json({error: message});
    } finally {
      cleanupDisconnectListeners();
    }
  });

  app.post('/api/parent/magic-link', async (req: Request, res: Response) => {
    try {
      const {email, config} = req.body as {email?: string; config?: GreetingBody};
      if (!config) {
        res.status(400).json({error: 'Informe os dados da chamada para gerar o link mágico.'});
        return;
      }
      const validation = validateParentFields(
        {
          childName: config.childName,
          praise: config.praise,
          advice: config.advice,
        },
        {requireChildName: true}
      );
      if (!validation.ok) {
        res.status(400).json({error: validation.error});
        return;
      }
      const payload = Buffer.from(JSON.stringify(config), 'utf8').toString('base64url');
      const baseUrl = resolvePublicBaseUrl(req);
      const magicUrl = `${baseUrl}/?chamada=${payload}`;
      const recipientEmail = (email || '').trim();

      res.json({
        magicUrl,
        email: recipientEmail,
        emailSent: false,
        createdAt: new Date().toISOString(),
      });
    } catch (error) {
      const message =
        error instanceof Error ? error.message : 'Não foi possível criar o link mágico.';
      res.status(500).json({error: message});
    }
  });

  if (!isProd) {
    const {createServer: createViteServer} = await import('vite');
    const vite = await createViteServer({
      server: {middlewareMode: true},
      appType: 'spa',
    });
    app.use(vite.middlewares);
  } else {
    const distPath = path.resolve(__dirname, 'dist');
    app.use(express.static(distPath));
    app.get('*', (_req: Request, res: Response) => {
      const indexFile = path.join(distPath, 'index.html');
      if (fs.existsSync(indexFile)) {
        res.sendFile(indexFile);
      } else {
        res.status(404).send('Build não encontrado.');
      }
    });
  }

  app.listen(PORT, '0.0.0.0', () => {
    console.log(`Chamada Mágica do Papai Noel running on http://0.0.0.0:${PORT}`);
  });
}

startServer().catch((err) => {
  console.error('Failed to start server:', err);
  process.exit(1);
});
