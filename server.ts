import 'dotenv/config';
import crypto from 'crypto';
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

const EPHEMERAL_FALLBACK_SECRET = crypto.randomBytes(32).toString('hex');
function getHmacSecret(): string {
  const envSecret = (process.env.SECRET || '').trim();
  return envSecret || EPHEMERAL_FALLBACK_SECRET;
}

interface EntitlementPayload {
  pid: string;
  plan: PlanId;
  iat: number;
  exp: number;
  ref?: string;
}

interface PaidPaymentRecord {
  paymentId: string;
  planId: PlanId;
  status: string;
  value?: number;
  customerEmail?: string;
  customerName?: string;
  ref?: string;
  verifiedAt: string;
  source: 'webhook' | 'api' | 'both';
  token: string;
}

interface SavedMagicRecord {
  id: string;
  type: 'audio' | 'video';
  childName: string;
  planId: PlanId;
  shareUrl: string;
  token: string;
  createdAt: string;
}

interface ParentAccount {
  parentId: string;
  name: string;
  phone: string;
  email: string;
  createdAt: string;
  updatedAt: string;
  creditsRedeemed: number;
  magics: SavedMagicRecord[];
}

interface DigestEntry {
  parentId: string;
  name: string;
  phone: string;
  email: string;
  planId?: string;
  paymentId?: string;
  registeredAt: string;
}

const paidPayments = new Map<string, PaidPaymentRecord>();
const parentsMap = new Map<string, ParentAccount>();
const parentEmailIndex = new Map<string, string>();
const creditedPaymentsByRef = new Map<string, Set<string>>();
const pendingDigestEntries: DigestEntry[] = [];
let digestTimerStarted = false;

function getAsaasApiBaseUrl(): string {
  const custom = (process.env.ASAAS_API_URL || '').trim().replace(/\/$/, '');
  if (custom && /^https?:\/\//i.test(custom)) {
    return custom;
  }
  const envMode = (process.env.ASAAS_ENV || '').trim().toLowerCase();
  if (envMode === 'sandbox') {
    return 'https://api-sandbox.asaas.com/v3';
  }
  return 'https://api.asaas.com/v3';
}

function getAsaasPlanLinks(): Record<PlanId, string | null> {
  const sanitize = (raw?: string): string | null => {
    const val = (raw || '').trim();
    if (!val) return null;
    try {
      const parsed = new URL(val);
      return parsed.protocol === 'https:' || parsed.protocol === 'http:' ? parsed.toString() : null;
    } catch {
      return null;
    }
  };
  return {
    '15s': sanitize(process.env.ASAAS_LINK_15S),
    '30s': sanitize(process.env.ASAAS_LINK_30S),
    '60s': sanitize(process.env.ASAAS_LINK_60S),
    familia: sanitize(process.env.ASAAS_LINK_FAMILIA),
    audio: sanitize(process.env.ASAAS_LINK_AUDIO),
  };
}

function timingSafeStringEqual(a: string, b: string): boolean {
  const bufA = Buffer.from(a, 'utf8');
  const bufB = Buffer.from(b, 'utf8');
  if (bufA.length !== bufB.length) return false;
  return crypto.timingSafeEqual(bufA, bufB);
}

function signEntitlementToken(payload: EntitlementPayload): string {
  const encoded = Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url');
  const sig = crypto.createHmac('sha256', getHmacSecret()).update(encoded).digest('base64url');
  return `${encoded}.${sig}`;
}

function isPlanAuthorizedByToken(tokenPlan: PlanId, requiredPlan?: PlanId): boolean {
  if (!requiredPlan) return true;
  if (tokenPlan === requiredPlan) return true;
  if (requiredPlan === 'audio') return tokenPlan === 'audio';
  if (tokenPlan === 'familia') return true;
  if (tokenPlan === '60s') return requiredPlan === '15s' || requiredPlan === '30s' || requiredPlan === '60s';
  if (tokenPlan === '30s') return requiredPlan === '15s' || requiredPlan === '30s';
  return false;
}

function verifyEntitlementToken(
  token: string | undefined | null,
  requiredPlan?: PlanId
): EntitlementPayload | null {
  if (!token || typeof token !== 'string') return null;
  const trimmed = token.trim();
  const dotIdx = trimmed.indexOf('.');
  if (dotIdx <= 0 || dotIdx === trimmed.length - 1) return null;

  const encoded = trimmed.slice(0, dotIdx);
  const sig = trimmed.slice(dotIdx + 1);
  const expectedSig = crypto
    .createHmac('sha256', getHmacSecret())
    .update(encoded)
    .digest('base64url');

  if (!timingSafeStringEqual(sig, expectedSig)) {
    return null;
  }

  try {
    const parsed = JSON.parse(Buffer.from(encoded, 'base64url').toString('utf8')) as Partial<EntitlementPayload>;
    if (
      !parsed ||
      typeof parsed.pid !== 'string' ||
      !parsed.pid ||
      typeof parsed.plan !== 'string' ||
      typeof parsed.exp !== 'number' ||
      parsed.exp <= Date.now()
    ) {
      return null;
    }
    const validPlans: PlanId[] = ['15s', '30s', '60s', 'familia', 'audio'];
    if (!validPlans.includes(parsed.plan as PlanId)) {
      return null;
    }
    if (!isPlanAuthorizedByToken(parsed.plan as PlanId, requiredPlan)) {
      return null;
    }
    return parsed as EntitlementPayload;
  } catch {
    return null;
  }
}

function extractEntitlementTokenFromReq(req: Request): string | null {
  const bodyToken =
    req.body && typeof (req.body as {token?: unknown}).token === 'string'
      ? (req.body as {token: string}).token.trim()
      : '';
  if (bodyToken) return bodyToken;

  const headerToken = (req.get('x-entitlement-token') || '').trim();
  if (headerToken) return headerToken;

  const authHeader = (req.get('authorization') || '').trim();
  if (/^Bearer\s+/i.test(authHeader)) {
    return authHeader.replace(/^Bearer\s+/i, '').trim();
  }
  return null;
}

function signParentSessionCookie(parentId: string): string {
  const exp = Date.now() + 60 * 24 * 60 * 60 * 1000;
  const payload = Buffer.from(JSON.stringify({parentId, exp}), 'utf8').toString('base64url');
  const sig = crypto
    .createHmac('sha256', getHmacSecret())
    .update(`parent:${payload}`)
    .digest('base64url');
  return `${payload}.${sig}`;
}

function verifyParentSessionCookie(raw: string | undefined | null): string | null {
  if (!raw || typeof raw !== 'string') return null;
  const dotIdx = raw.indexOf('.');
  if (dotIdx <= 0 || dotIdx === raw.length - 1) return null;
  const payload = raw.slice(0, dotIdx);
  const sig = raw.slice(dotIdx + 1);
  const expected = crypto
    .createHmac('sha256', getHmacSecret())
    .update(`parent:${payload}`)
    .digest('base64url');
  if (!timingSafeStringEqual(sig, expected)) return null;
  try {
    const parsed = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as {
      parentId?: string;
      exp?: number;
    };
    if (!parsed.parentId || typeof parsed.exp !== 'number' || parsed.exp <= Date.now()) {
      return null;
    }
    return parsed.parentId;
  } catch {
    return null;
  }
}

function parseCookies(req: Request): Record<string, string> {
  const header = req.headers.cookie || '';
  const result: Record<string, string> = {};
  for (const part of header.split(';')) {
    const eqIdx = part.indexOf('=');
    if (eqIdx <= 0) continue;
    const key = part.slice(0, eqIdx).trim();
    const val = part.slice(eqIdx + 1).trim();
    if (key) {
      try {
        result[key] = decodeURIComponent(val);
      } catch {
        result[key] = val;
      }
    }
  }
  return result;
}

function inferPlanIdFromPayment(params: {
  requestedPlanId?: unknown;
  externalReference?: unknown;
  description?: unknown;
  value?: unknown;
}): PlanId {
  const validPlans: PlanId[] = ['15s', '30s', '60s', 'familia', 'audio'];
  if (typeof params.requestedPlanId === 'string' && validPlans.includes(params.requestedPlanId as PlanId)) {
    return params.requestedPlanId as PlanId;
  }
  const refStr = typeof params.externalReference === 'string' ? params.externalReference.toLowerCase() : '';
  const descStr = typeof params.description === 'string' ? params.description.toLowerCase() : '';
  for (const candidate of validPlans) {
    if (refStr.includes(`plan:${candidate}`) || refStr === candidate || descStr.includes(candidate)) {
      return candidate;
    }
  }
  if (descStr.includes('áudio mágico') || descStr.includes('audio magico')) return 'audio';
  if (descStr.includes('família') || descStr.includes('familia')) return 'familia';
  const numVal = typeof params.value === 'number' ? params.value : Number(params.value);
  if (Number.isFinite(numVal) && numVal > 0) {
    if (numVal <= 5.5) return 'audio';
    if (numVal <= 12) return '15s';
    if (numVal <= 22) return '30s';
    if (numVal <= 32) return '60s';
    return 'familia';
  }
  return '30s';
}

function extractRefFromExternalReference(externalReference?: unknown): string | undefined {
  if (typeof externalReference !== 'string') return undefined;
  const match = externalReference.match(/(?:^|\|)ref:(pai_[a-zA-Z0-9_-]{6,32})(?:\||$)/i);
  if (match && match[1]) return match[1];
  const bare = externalReference.trim();
  return /^pai_[a-zA-Z0-9_-]{6,32}$/.test(bare) ? bare : undefined;
}

function sanitizeRefId(raw?: unknown): string | undefined {
  if (typeof raw !== 'string') return undefined;
  const trimmed = raw.trim();
  return /^pai_[a-zA-Z0-9_-]{6,32}$/.test(trimmed) ? trimmed : undefined;
}

function recordReferralConversion(refParentId: string | undefined, paymentId: string): void {
  if (!refParentId || !paymentId) return;
  const set = creditedPaymentsByRef.get(refParentId) || new Set<string>();
  set.add(paymentId);
  creditedPaymentsByRef.set(refParentId, set);
}

function buildParentStats(account: ParentAccount) {
  const conversions = creditedPaymentsByRef.get(account.parentId)?.size || 0;
  const creditsEarned = Math.floor(conversions / 5);
  const availableCredits = Math.max(0, creditsEarned - account.creditsRedeemed);
  const remainder = conversions % 5;
  const neededForNextCredit = remainder === 0 && conversions > 0 ? 5 : 5 - remainder;
  return {
    parentId: account.parentId,
    name: account.name,
    phone: account.phone,
    email: account.email,
    conversions,
    creditsEarned,
    creditsRedeemed: account.creditsRedeemed,
    availableCredits,
    neededForNextCredit,
  };
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

async function sendDailyDigestViaResend(): Promise<{sent: boolean; count: number; reason?: string}> {
  if (pendingDigestEntries.length === 0) {
    return {sent: false, count: 0, reason: 'Nenhum novo registro pendente.'};
  }
  const apiKey = (process.env.RESEND_API_KEY || '').trim();
  const ownerEmail = (process.env.OWNER_EMAIL || '').trim();
  const fromEmail =
    (process.env.RESEND_FROM_EMAIL || '').trim() || 'Chamada Papai Noel <onboarding@resend.dev>';

  if (!apiKey || !ownerEmail) {
    return {
      sent: false,
      count: pendingDigestEntries.length,
      reason: 'RESEND_API_KEY ou OWNER_EMAIL não configurado.',
    };
  }

  const batch = pendingDigestEntries.splice(0, pendingDigestEntries.length);
  const rowsHtml = batch
    .map(
      (item) =>
        `<tr>
          <td style="padding:8px;border:1px solid #ddd;">${escapeHtml(item.name)}</td>
          <td style="padding:8px;border:1px solid #ddd;">${escapeHtml(item.phone)}</td>
          <td style="padding:8px;border:1px solid #ddd;">${escapeHtml(item.email)}</td>
          <td style="padding:8px;border:1px solid #ddd;">${escapeHtml(item.planId || '-')}</td>
          <td style="padding:8px;border:1px solid #ddd;">${escapeHtml(item.parentId)}</td>
          <td style="padding:8px;border:1px solid #ddd;">${escapeHtml(item.registeredAt)}</td>
        </tr>`
    )
    .join('');

  const html = `
    <div style="font-family:sans-serif;color:#111;">
      <h2>Resumo Diário de Pais Cadastrados (${batch.length})</h2>
      <table style="border-collapse:collapse;width:100%;font-size:14px;">
        <thead>
          <tr style="background:#f5f5f5;">
            <th style="padding:8px;border:1px solid #ddd;text-align:left;">Nome</th>
            <th style="padding:8px;border:1px solid #ddd;text-align:left;">Telefone</th>
            <th style="padding:8px;border:1px solid #ddd;text-align:left;">E-mail</th>
            <th style="padding:8px;border:1px solid #ddd;text-align:left;">Plano</th>
            <th style="padding:8px;border:1px solid #ddd;text-align:left;">ID Pai</th>
            <th style="padding:8px;border:1px solid #ddd;text-align:left;">Data</th>
          </tr>
        </thead>
        <tbody>${rowsHtml}</tbody>
      </table>
    </div>
  `;

  try {
    const res = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        from: fromEmail,
        to: [ownerEmail],
        subject: `[Chamada Papai Noel] Digest Diário: ${batch.length} novo(s) pai(s)`,
        html,
      }),
    });
    if (!res.ok) {
      pendingDigestEntries.unshift(...batch);
      return {sent: false, count: batch.length, reason: `Resend HTTP ${res.status}`};
    }
    return {sent: true, count: batch.length};
  } catch (err) {
    pendingDigestEntries.unshift(...batch);
    return {
      sent: false,
      count: batch.length,
      reason: err instanceof Error ? err.message : 'Erro ao enviar digest.',
    };
  }
}

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

const TOP_BOY_NAMES = [
  'Miguel',
  'Arthur',
  'Gael',
  'Théo',
  'Heitor',
  'Ravi',
  'Davi',
  'Bernardo',
  'Noah',
  'Gabriel',
  'Samuel',
  'Pedro',
  'Anthony',
  'Isaac',
  'Benício',
  'Benjamin',
  'Matheus',
  'Lucas',
  'Joaquim',
  'Nicolas',
  'Lucca',
  'Lorenzo',
  'Henrique',
  'João',
  'Rafael',
  'Murilo',
  'Levi',
  'Guilherme',
  'Vicente',
  'Felipe',
  'Bryan',
  'Matteo',
  'Bento',
  'Gustavo',
  'Pietro',
  'Leonardo',
  'Eduardo',
  'Daniel',
  'Enzo',
  'Cauã',
  'Caio',
  'Kauan',
  'César',
  'Rodrigo',
  'Tiago',
  'Bruno',
  'Vitor',
  'Vinícius',
  'André',
  'Otávio',
  'Augusto',
  'Emanuel',
  'Thomas',
  'Yuri',
  'Danilo',
  'Igor',
  'Alexandre',
  'Fernando',
  'Marcelo',
  'Francisco',
] as const;

const TOP_GIRL_NAMES = [
  'Helena',
  'Alice',
  'Laura',
  'Maria',
  'Sophia',
  'Manuela',
  'Maitê',
  'Liz',
  'Cecília',
  'Isabella',
  'Luísa',
  'Eloá',
  'Heloísa',
  'Júlia',
  'Ayla',
  'Beatriz',
  'Antonella',
  'Maya',
  'Valentina',
  'Melissa',
  'Lívia',
  'Giovanna',
  'Elisa',
  'Clara',
  'Lorena',
  'Esther',
  'Isadora',
  'Sarah',
  'Mariana',
  'Yasmin',
  'Catarina',
  'Lavínia',
  'Alícia',
  'Lara',
  'Olívia',
  'Marina',
  'Rebeca',
  'Agatha',
  'Letícia',
  'Gabriela',
  'Nicole',
  'Bianca',
  'Ana',
  'Isabel',
  'Rafaela',
  'Carolina',
  'Vitória',
  'Milena',
  'Pietra',
  'Luna',
  'Aurora',
  'Stella',
  'Bárbara',
  'Amanda',
  'Bruna',
  'Camila',
  'Fernanda',
  'Juliana',
  'Larissa',
  'Natália',
] as const;

function normalizeAudioBankSlug(name: string): string {
  return name
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '');
}

const TOP_NAMES: readonly string[] = (() => {
  const seenSlugs = new Set<string>();
  const unique: string[] = [];
  for (const rawName of [...TOP_BOY_NAMES, ...TOP_GIRL_NAMES]) {
    const clean = rawName.trim();
    const slug = normalizeAudioBankSlug(clean);
    if (!clean || !slug || seenSlugs.has(slug)) continue;
    seenSlugs.add(slug);
    unique.push(clean);
  }
  return unique;
})();

function getAudioBankDirectory(): string {
  return path.resolve(__dirname, 'public', 'audio', 'bank');
}

function listAudioBankFiles(): Array<{
  filename: string;
  sizeBytes: number;
  updatedAt: string;
  url: string;
}> {
  const bankDir = getAudioBankDirectory();
  if (!fs.existsSync(bankDir)) return [];
  const entries = fs.readdirSync(bankDir);
  const files: Array<{filename: string; sizeBytes: number; updatedAt: string; url: string}> = [];
  for (const entry of entries) {
    if (!/\.(wav|mp3)$/i.test(entry)) continue;
    const safeName = path.basename(entry);
    const fullPath = path.resolve(bankDir, safeName);
    if (!fullPath.startsWith(bankDir + path.sep)) continue;
    try {
      const stat = fs.statSync(fullPath);
      if (!stat.isFile()) continue;
      files.push({
        filename: safeName,
        sizeBytes: stat.size,
        updatedAt: stat.mtime.toISOString(),
        url: `/audio/bank/${encodeURIComponent(safeName)}`,
      });
    } catch {
      // Ignore unreadable entry
    }
  }
  return files.sort((a, b) => a.filename.localeCompare(b.filename));
}

function requireAdminToken(req: Request, res: Response): boolean {
  const expectedToken = (process.env.ADMIN_TOKEN || '').trim();
  const providedToken = (req.get('x-admin-token') || '').trim();
  if (!expectedToken || !providedToken || !timingSafeStringEqual(providedToken, expectedToken)) {
    res.status(401).json({error: 'Token de administrador ausente ou inválido.'});
    return false;
  }
  return true;
}

async function abortableSleep(ms: number, signal?: AbortSignal): Promise<void> {
  if (ms <= 0) return;
  if (signal?.aborted) {
    throw new Error('ABORTED: Requisição cancelada pelo cliente.');
  }
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(new Error('ABORTED: Requisição cancelada pelo cliente.'));
    };
    signal?.addEventListener('abort', onAbort, {once: true});
  });
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
  const reqHost = (req.get('x-forwarded-host') || req.get('host') || '').split(',')[0].trim();
  const envAppUrl = (process.env.APP_URL || '').trim().replace(/\/$/, '');
  if (envAppUrl && envAppUrl !== 'MY_APP_URL' && /^https?:\/\//i.test(envAppUrl)) {
    return envAppUrl;
  }
  const reqOrigin = (req.get('origin') || '').trim();
  if (reqOrigin && /^https?:\/\//i.test(reqOrigin)) {
    return reqOrigin.replace(/\/$/, '');
  }
  const forwardedProto = (req.get('x-forwarded-proto') || '').split(',')[0].trim();
  const proto = forwardedProto || req.protocol || 'https';
  const host = reqHost || 'localhost:3000';
  return `${proto}://${host}`;
}

function applyAppUrlToHtml(html: string, baseUrl: string): string {
  return html
    .replace(/https:\/\/chamada-papai-noel\.onrender\.com/g, baseUrl)
    .replace(/content="\/santa-avatar\.png"/g, `content="${baseUrl}/santa-avatar.png"`)
    .replace(/"image":\s*"\/santa-avatar\.png"/g, `"image": "${baseUrl}/santa-avatar.png"`);
}

function applyAppUrlToLlmsTxt(txt: string, baseUrl: string): string {
  return txt
    .replace(/https:\/\/chamada-papai-noel\.onrender\.com/g, baseUrl)
    .replace(/:\s*\/\n/g, `: ${baseUrl}/\n`)
    .replace(/:\s*\/sitemap\.xml/g, `: ${baseUrl}/sitemap.xml`)
    .replace(/:\s*\/robots\.txt/g, `: ${baseUrl}/robots.txt`)
    .replace(/\bem\s+\/\s*$/gm, `em ${baseUrl}/`);
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

  if (!digestTimerStarted) {
    digestTimerStarted = true;
    setInterval(() => {
      void sendDailyDigestViaResend();
    }, 24 * 60 * 60 * 1000).unref();
  }

  // Webhook Asaas captura rawBody para validação HMAC-SHA256 / asaas-access-token
  app.use(
    '/api/pay/asaas',
    express.json({
      limit: '1mb',
      verify: (req, _res, buf) => {
        (req as Request & {rawBody?: Buffer}).rawBody = buf;
      },
    })
  );

  // Limite estrito de 2MB em /api/santa/reply e /api/santa/audio; demais rotas mantêm parsing JSON padrão
  app.use('/api/santa/reply', express.json({limit: '2mb'}));
  app.use('/api/santa/audio', express.json({limit: '2mb'}));
  app.use((req: Request, res: Response, next) => {
    if (
      req.path === '/api/santa/reply' ||
      req.path === '/api/santa/audio' ||
      req.path === '/api/pay/asaas'
    ) {
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

  app.get('/llms.txt', (req: Request, res: Response) => {
    const baseUrl = resolvePublicBaseUrl(req);
    const candidates = [
      path.resolve(__dirname, 'public', 'llms.txt'),
      path.resolve(__dirname, 'dist', 'llms.txt'),
    ];
    const targetFile = candidates.find((p) => fs.existsSync(p));
    if (targetFile) {
      const content = applyAppUrlToLlmsTxt(fs.readFileSync(targetFile, 'utf8'), baseUrl);
      res.type('text/plain; charset=utf-8').send(content);
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

  app.get('/api/pay/config', (req: Request, res: Response) => {
    res.json({
      appUrl: resolvePublicBaseUrl(req),
      links: getAsaasPlanLinks(),
    });
  });

  app.post('/api/pay/validate-token', (req: Request, res: Response) => {
    const body = (req.body || {}) as {token?: string; planId?: PlanId};
    const token = typeof body.token === 'string' ? body.token : extractEntitlementTokenFromReq(req);
    const validPayload = verifyEntitlementToken(token, body.planId);
    if (!validPayload) {
      res.status(402).json({valid: false, error: 'Token de acesso ausente ou inválido.'});
      return;
    }
    res.json({
      valid: true,
      pid: validPayload.pid,
      planId: validPayload.plan,
      exp: validPayload.exp,
      ref: validPayload.ref,
    });
  });

  app.post('/api/pay/asaas', (req: Request, res: Response) => {
    const webhookSecret = (process.env.ASAAS_WEBHOOK_TOKEN || '').trim();
    const envSecret = (process.env.SECRET || '').trim();
    const authSecret = webhookSecret || envSecret;

    if (!authSecret) {
      res.status(503).json({error: 'ASAAS_WEBHOOK_TOKEN ou SECRET não configurado no servidor.'});
      return;
    }

    const accessTokenHeader = (req.get('asaas-access-token') || '').trim();
    const sigHeaderRaw = (
      req.get('x-asaas-signature') ||
      req.get('asaas-signature') ||
      ''
    ).trim();

    let signatureValid = false;
    if (accessTokenHeader && timingSafeStringEqual(accessTokenHeader, authSecret)) {
      signatureValid = true;
    } else if (sigHeaderRaw) {
      const rawBody =
        (req as Request & {rawBody?: Buffer}).rawBody ||
        Buffer.from(JSON.stringify(req.body || {}), 'utf8');
      const normalizedSig = sigHeaderRaw.replace(/^sha256=/i, '');
      const expectedHex = crypto.createHmac('sha256', authSecret).update(rawBody).digest('hex');
      const expectedBase64 = crypto
        .createHmac('sha256', authSecret)
        .update(rawBody)
        .digest('base64');
      if (
        timingSafeStringEqual(normalizedSig.toLowerCase(), expectedHex.toLowerCase()) ||
        timingSafeStringEqual(normalizedSig, expectedBase64)
      ) {
        signatureValid = true;
      }
    }

    if (!signatureValid) {
      res.status(401).json({error: 'Assinatura do webhook Asaas inválida.'});
      return;
    }

    interface AsaasWebhookPayment {
      id?: string;
      status?: string;
      value?: number;
      description?: string;
      externalReference?: string;
      customerEmail?: string;
      customerName?: string;
    }

    const body = (req.body || {}) as AsaasWebhookPayment & {
      event?: string;
      payment?: AsaasWebhookPayment;
    };

    const payment: AsaasWebhookPayment = body.payment || body;
    const paymentId = typeof payment.id === 'string' ? payment.id.trim() : '';
    const event = (body.event || '').toUpperCase();
    const status = (payment.status || '').toUpperCase();

    const isPaidEvent =
      event === 'PAYMENT_CONFIRMED' ||
      event === 'PAYMENT_RECEIVED' ||
      event === 'PAYMENT_RECEIVED_IN_CASH' ||
      status === 'CONFIRMED' ||
      status === 'RECEIVED' ||
      status === 'RECEIVED_IN_CASH' ||
      status === 'PAID';

    if (!paymentId || !/^[A-Za-z0-9_-]{3,80}$/.test(paymentId)) {
      res.status(400).json({error: 'payment.id inválido no payload Asaas.'});
      return;
    }

    if (!isPaidEvent) {
      res.json({ok: true, received: true, paid: false, paymentId, status});
      return;
    }

    const existing = paidPayments.get(paymentId);
    const planId =
      existing?.planId ||
      inferPlanIdFromPayment({
        externalReference: payment.externalReference,
        description: payment.description,
        value: payment.value,
      });
    const ref = existing?.ref || extractRefFromExternalReference(payment.externalReference);
    const token =
      existing?.token ||
      signEntitlementToken({
        pid: paymentId,
        plan: planId,
        iat: Date.now(),
        exp: Date.now() + 30 * 24 * 60 * 60 * 1000,
        ...(ref ? {ref} : {}),
      });

    paidPayments.set(paymentId, {
      paymentId,
      planId,
      status: status || 'CONFIRMED',
      value: typeof payment.value === 'number' ? payment.value : existing?.value,
      customerEmail: payment.customerEmail || existing?.customerEmail,
      customerName: payment.customerName || existing?.customerName,
      ref,
      verifiedAt: new Date().toISOString(),
      source: existing?.source === 'api' ? 'both' : existing?.source || 'webhook',
      token,
    });

    if (ref) {
      recordReferralConversion(ref, paymentId);
    }

    res.json({ok: true, received: true, paid: true, paymentId, planId, token});
  });

  app.post('/api/pay/confirm', async (req: Request, res: Response) => {
    try {
      const body = (req.body || {}) as {paymentId?: string; planId?: PlanId; ref?: string};
      const paymentId = typeof body.paymentId === 'string' ? body.paymentId.trim() : '';
      if (!paymentId || !/^[A-Za-z0-9_-]{3,80}$/.test(paymentId)) {
        res.status(400).json({paid: false, error: 'ID do pagamento inválido.'});
        return;
      }

      const webhookRecord = paidPayments.get(paymentId);
      const asaasApiKey = (process.env.ASAAS_API_KEY || '').trim();
      const incomingRef = sanitizeRefId(body.ref);

      let apiConfirmed = false;
      let apiPaymentData: {
        status?: string;
        value?: number;
        description?: string;
        externalReference?: string;
      } | null = null;

      if (asaasApiKey) {
        const apiRes = await fetch(
          `${getAsaasApiBaseUrl()}/payments/${encodeURIComponent(paymentId)}`,
          {
            method: 'GET',
            headers: {
              access_token: asaasApiKey,
              'User-Agent': 'aistudio-build',
            },
          }
        );
        if (apiRes.ok) {
          apiPaymentData = (await apiRes.json()) as {
            status?: string;
            value?: number;
            description?: string;
            externalReference?: string;
          };
          const apiStatus = (apiPaymentData.status || '').toUpperCase();
          apiConfirmed =
            apiStatus === 'RECEIVED' ||
            apiStatus === 'CONFIRMED' ||
            apiStatus === 'RECEIVED_IN_CASH' ||
            apiStatus === 'PAID';
        }
      }

      const isConfirmed = apiConfirmed || Boolean(webhookRecord);
      if (!isConfirmed) {
        res.status(402).json({
          paid: false,
          error: asaasApiKey
            ? 'Pagamento ainda não confirmado na API do Asaas.'
            : 'Pagamento não localizado via webhook Asaas.',
        });
        return;
      }

      const finalPlanId =
        webhookRecord?.planId ||
        inferPlanIdFromPayment({
          requestedPlanId: body.planId,
          externalReference: apiPaymentData?.externalReference,
          description: apiPaymentData?.description,
          value: apiPaymentData?.value,
        });

      const finalRef =
        webhookRecord?.ref ||
        extractRefFromExternalReference(apiPaymentData?.externalReference) ||
        incomingRef;

      const token =
        webhookRecord?.token ||
        signEntitlementToken({
          pid: paymentId,
          plan: finalPlanId,
          iat: Date.now(),
          exp: Date.now() + 30 * 24 * 60 * 60 * 1000,
          ...(finalRef ? {ref: finalRef} : {}),
        });

      const source: PaidPaymentRecord['source'] =
        apiConfirmed && webhookRecord ? 'both' : apiConfirmed ? 'api' : 'webhook';

      paidPayments.set(paymentId, {
        paymentId,
        planId: finalPlanId,
        status: apiPaymentData?.status || webhookRecord?.status || 'CONFIRMED',
        value: apiPaymentData?.value ?? webhookRecord?.value,
        ref: finalRef,
        verifiedAt: new Date().toISOString(),
        source,
        token,
      });

      if (finalRef) {
        recordReferralConversion(finalRef, paymentId);
      }

      res.json({
        paid: true,
        doubleConfirmed: apiConfirmed || source === 'webhook' || source === 'both',
        source,
        paymentId,
        planId: finalPlanId,
        token,
        ...(finalRef ? {ref: finalRef} : {}),
      });
    } catch (err) {
      res.status(500).json({paid: false, error: extractReadableError(err)});
    }
  });

  app.post('/api/parents/register', (req: Request, res: Response) => {
    const token = extractEntitlementTokenFromReq(req);
    const entitlement = verifyEntitlementToken(token);
    if (!entitlement) {
      res.status(402).json({error: 'Pagamento confirmado necessário para concluir o cadastro.'});
      return;
    }

    const body = (req.body || {}) as {
      name?: string;
      phone?: string;
      email?: string;
      planId?: string;
    };

    const name = typeof body.name === 'string' ? body.name.trim() : '';
    const phone = typeof body.phone === 'string' ? body.phone.trim() : '';
    const email = typeof body.email === 'string' ? body.email.trim().toLowerCase() : '';

    if (name.length < 2 || name.length > 80) {
      res.status(400).json({error: 'Informe seu nome completo (2 a 80 caracteres).'});
      return;
    }
    const phoneDigits = phone.replace(/\D/g, '');
    if (phoneDigits.length < 8 || phone.length > 30) {
      res.status(400).json({error: 'Informe um telefone/WhatsApp válido com DDD.'});
      return;
    }
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || email.length > 120) {
      res.status(400).json({error: 'Informe um e-mail válido.'});
      return;
    }

    const existingId = parentEmailIndex.get(email);
    const nowIso = new Date().toISOString();
    let account: ParentAccount;
    if (existingId && parentsMap.has(existingId)) {
      account = parentsMap.get(existingId)!;
      account.name = name;
      account.phone = phone;
      account.updatedAt = nowIso;
    } else {
      const parentId = `pai_${crypto.randomBytes(5).toString('hex')}`;
      account = {
        parentId,
        name,
        phone,
        email,
        createdAt: nowIso,
        updatedAt: nowIso,
        creditsRedeemed: 0,
        magics: [],
      };
      parentsMap.set(parentId, account);
      parentEmailIndex.set(email, parentId);
    }

    pendingDigestEntries.push({
      parentId: account.parentId,
      name: account.name,
      phone: account.phone,
      email: account.email,
      planId: entitlement.plan,
      paymentId: entitlement.pid,
      registeredAt: nowIso,
    });

    if (pendingDigestEntries.length >= 25) {
      void sendDailyDigestViaResend();
    }

    const cookieVal = signParentSessionCookie(account.parentId);
    res.cookie('santa_parent_session', cookieVal, {
      httpOnly: true,
      secure: true,
      sameSite: 'none',
      partitioned: true,
      maxAge: 60 * 24 * 60 * 60 * 1000,
    });

    res.json({
      parent: buildParentStats(account),
      magics: account.magics,
    });
  });

  app.get('/api/parents/me', (req: Request, res: Response) => {
    const cookies = parseCookies(req);
    const cookieParentId = verifyParentSessionCookie(cookies.santa_parent_session);
    if (!cookieParentId || !parentsMap.has(cookieParentId)) {
      res.status(404).json({error: 'Sessão de responsável não encontrada.'});
      return;
    }
    const account = parentsMap.get(cookieParentId)!;
    res.json({
      parent: buildParentStats(account),
      magics: account.magics,
    });
  });

  app.post('/api/parents/save-magic', (req: Request, res: Response) => {
    const cookies = parseCookies(req);
    const cookieParentId = verifyParentSessionCookie(cookies.santa_parent_session);
    const token = extractEntitlementTokenFromReq(req);
    const entitlement = verifyEntitlementToken(token);
    if (!cookieParentId || !parentsMap.has(cookieParentId) || !entitlement) {
      res.status(401).json({error: 'Cadastro do responsável e pagamento válidos obrigatórios.'});
      return;
    }

    const body = (req.body || {}) as {
      type?: 'audio' | 'video';
      childName?: string;
      planId?: PlanId;
      shareUrl?: string;
    };
    const shareUrl = typeof body.shareUrl === 'string' ? body.shareUrl.trim() : '';
    if (!shareUrl || !/^https?:\/\//i.test(shareUrl)) {
      res.status(400).json({error: 'URL da magia inválida.'});
      return;
    }

    const account = parentsMap.get(cookieParentId)!;
    const item: SavedMagicRecord = {
      id: `mag_${crypto.randomBytes(4).toString('hex')}`,
      type: body.type === 'audio' ? 'audio' : 'video',
      childName: (body.childName || 'Criança').trim().slice(0, 60),
      planId: entitlement.plan,
      shareUrl,
      token: token!,
      createdAt: new Date().toISOString(),
    };
    account.magics = [item, ...account.magics.filter((m) => m.shareUrl !== shareUrl)].slice(0, 50);

    res.json({
      parent: buildParentStats(account),
      magics: account.magics,
    });
  });

  app.post('/api/parents/redeem-credit', (req: Request, res: Response) => {
    const cookies = parseCookies(req);
    const cookieParentId = verifyParentSessionCookie(cookies.santa_parent_session);
    if (!cookieParentId || !parentsMap.has(cookieParentId)) {
      res.status(401).json({error: 'Faça seu cadastro pós-pagamento para resgatar créditos.'});
      return;
    }

    const account = parentsMap.get(cookieParentId)!;
    const stats = buildParentStats(account);
    if (stats.availableCredits < 1) {
      res.status(400).json({
        error: `Faltam ${stats.neededForNextCredit} indicações pagas para liberar uma chamada grátis.`,
      });
      return;
    }

    account.creditsRedeemed += 1;
    const creditPid = `credit_${crypto.randomBytes(6).toString('hex')}`;
    const token = signEntitlementToken({
      pid: creditPid,
      plan: '60s',
      iat: Date.now(),
      exp: Date.now() + 30 * 24 * 60 * 60 * 1000,
      ref: account.parentId,
    });

    res.json({
      token,
      planId: '60s',
      parent: buildParentStats(account),
    });
  });

  app.post('/api/admin/send-digest', async (req: Request, res: Response) => {
    const authHeader = (req.get('authorization') || '').trim();
    const bearer = authHeader.replace(/^Bearer\s+/i, '').trim();
    const envSecret = (process.env.SECRET || '').trim();
    if (!envSecret || !bearer || !timingSafeStringEqual(bearer, envSecret)) {
      res.status(401).json({error: 'Não autorizado.'});
      return;
    }
    const result = await sendDailyDigestViaResend();
    res.json(result);
  });

  app.get('/api/admin/bank/list', (req: Request, res: Response) => {
    if (!requireAdminToken(req, res)) return;
    const files = listAudioBankFiles();
    res.json({
      files,
      total: files.length,
    });
  });

  app.post('/api/admin/bank/generate', async (req: Request, res: Response) => {
    if (!requireAdminToken(req, res)) return;

    const {controller: routeAbortController, cleanup: cleanupDisconnectListeners} =
      createRequestAbortController(req, res);

    try {
      const body = (req.body || {}) as {overwrite?: boolean};
      const overwrite = Boolean(body.overwrite);
      const bankDir = getAudioBankDirectory();
      fs.mkdirSync(bankDir, {recursive: true});

      const genericClips: Array<{filename: string; text: string}> = [
        {
          filename: 'ola_generico.wav',
          text: prepareSantaSpeechScript(
            'Olá! Que alegria enorme ver você aqui na nossa chamada mágica do Polo Norte!',
            180
          ),
        },
        {
          filename: 'ponte_generica.wav',
          text: prepareSantaSpeechScript(
            'Continue sendo uma criança tão especial... qual presente você mais quer ganhar neste Natal?',
            180
          ),
        },
        {
          filename: 'despedida_mamae.wav',
          text: prepareSantaSpeechScript(
            'A Mamãe Noel está me chamando para tomar leite quentinho! Um beijo e Feliz Natal!',
            180
          ),
        },
        {
          filename: 'despedida_duendes.wav',
          text: prepareSantaSpeechScript(
            'Os duendes estão fazendo a maior bagunça na fábrica! Um abraço e Feliz Natal!',
            180
          ),
        },
        {
          filename: 'despedida_renas.wav',
          text: prepareSantaSpeechScript(
            'O Rodolfo e as renas já estão prontos no trenó para decolar! Feliz Natal!',
            180
          ),
        },
        {
          filename: 'despedida_carta.wav',
          text: prepareSantaSpeechScript(
            'Chegou uma pilha mágica de cartinhas urgentes no Polo Norte! Feliz Natal!',
            180
          ),
        },
      ];

      const nameClips: Array<{filename: string; text: string}> = TOP_NAMES.map((name) => {
        const slug = normalizeAudioBankSlug(name);
        return {
          filename: `ola_${slug}.wav`,
          text: prepareSantaSpeechScript(
            `Olá, ${name}! Que alegria enorme ver você aqui na nossa chamada do Polo Norte...`,
            180
          ),
        };
      });

      const allClips = [...genericClips, ...nameClips];
      let gerados = 0;
      let pulados = 0;
      let falhas = 0;
      const failures: Array<{filename: string; reason: string}> = [];
      let didSynthesizeBefore = false;

      for (const clip of allClips) {
        if (routeAbortController.signal.aborted || res.writableEnded) {
          break;
        }

        const safeFilename = path.basename(clip.filename);
        const targetPath = path.resolve(bankDir, safeFilename);
        if (!targetPath.startsWith(bankDir + path.sep)) {
          falhas += 1;
          failures.push({filename: clip.filename, reason: 'Caminho inválido.'});
          continue;
        }

        if (!overwrite && fs.existsSync(targetPath)) {
          try {
            const stat = fs.statSync(targetPath);
            if (stat.isFile() && stat.size > 500) {
              pulados += 1;
              continue;
            }
          } catch {
            // Re-generate unreadable file
          }
        }

        if (didSynthesizeBefore) {
          try {
            await abortableSleep(300, routeAbortController.signal);
          } catch {
            break;
          }
        }
        didSynthesizeBefore = true;

        const synth = await synthesizeSantaVoice(
          clip.text,
          undefined,
          DEFAULT_GEMINI_TTS_MODEL,
          routeAbortController.signal
        );

        if (routeAbortController.signal.aborted) {
          break;
        }

        if (!synth.audioBase64) {
          falhas += 1;
          failures.push({
            filename: safeFilename,
            reason: synth.ttsError || 'Falha na síntese TTS.',
          });
          continue;
        }

        try {
          const buf = Buffer.from(synth.audioBase64, 'base64');
          fs.writeFileSync(targetPath, buf);
          gerados += 1;
        } catch (writeErr) {
          falhas += 1;
          failures.push({
            filename: safeFilename,
            reason: writeErr instanceof Error ? writeErr.message : 'Erro ao gravar arquivo WAV.',
          });
        }
      }

      if (routeAbortController.signal.aborted || res.writableEnded) {
        return;
      }

      const files = listAudioBankFiles();
      res.json({
        gerados,
        pulados,
        falhas,
        totalSolicitados: allClips.length,
        custoEstimadoBRL: Number((gerados * 0.012).toFixed(3)),
        files,
        failures,
      });
    } catch (err) {
      if (routeAbortController.signal.aborted || isAbortError(err) || res.writableEnded) {
        return;
      }
      res.status(500).json({error: extractReadableError(err)});
    } finally {
      cleanupDisconnectListeners();
    }
  });

  app.get('/api/admin/overview', async (req: Request, res: Response) => {
    if (!requireAdminToken(req, res)) return;

    const paymentMap = new Map<
      string,
      {
        paymentId: string;
        planId: string;
        status: string;
        value?: number;
        customerName?: string;
        customerEmail?: string;
        ref?: string;
        verifiedAt?: string;
        source: 'asaas-api' | 'webhook' | 'api' | 'both';
      }
    >();

    for (const local of paidPayments.values()) {
      paymentMap.set(local.paymentId, {
        paymentId: local.paymentId,
        planId: local.planId,
        status: local.status,
        value: local.value,
        customerName: local.customerName,
        customerEmail: local.customerEmail,
        ref: local.ref,
        verifiedAt: local.verifiedAt,
        source: local.source,
      });
    }

    const asaasApiKey = (process.env.ASAAS_API_KEY || '').trim();
    let asaasError: string | null = null;

    if (asaasApiKey) {
      const abortCtrl = new AbortController();
      const timeout = setTimeout(() => abortCtrl.abort(), 5000);
      try {
        const asaasRes = await fetch(`${getAsaasApiBaseUrl()}/payments?limit=50`, {
          method: 'GET',
          headers: {
            access_token: asaasApiKey,
            'User-Agent': 'aistudio-build',
          },
          signal: abortCtrl.signal,
        });
        if (!asaasRes.ok) {
          asaasError = `HTTP ${asaasRes.status}`;
        } else {
          const json = (await asaasRes.json()) as {
            data?: Array<{
              id?: string;
              status?: string;
              value?: number;
              description?: string;
              externalReference?: string;
              dateCreated?: string;
              paymentDate?: string;
            }>;
          };
          for (const item of json.data || []) {
            const id = typeof item.id === 'string' ? item.id.trim() : '';
            if (!id) continue;
            const existing = paymentMap.get(id);
            const inferredPlan = inferPlanIdFromPayment({
              externalReference: item.externalReference,
              description: item.description,
              value: item.value,
            });
            const extractedRef = extractRefFromExternalReference(item.externalReference);
            paymentMap.set(id, {
              paymentId: id,
              planId: existing?.planId || inferredPlan,
              status: item.status || existing?.status || 'UNKNOWN',
              value: typeof item.value === 'number' ? item.value : existing?.value,
              customerName: existing?.customerName,
              customerEmail: existing?.customerEmail,
              ref: existing?.ref || extractedRef,
              verifiedAt: existing?.verifiedAt || item.paymentDate || item.dateCreated,
              source: existing ? existing.source : 'asaas-api',
            });
          }
        }
      } catch (err) {
        asaasError = extractReadableError(err);
      } finally {
        clearTimeout(timeout);
      }
    }

    const parents = Array.from(parentsMap.values()).map((account) => ({
      ...buildParentStats(account),
      createdAt: account.createdAt,
      updatedAt: account.updatedAt,
      magicsCount: account.magics.length,
    }));

    const referralRefs = new Set<string>([
      ...Array.from(creditedPaymentsByRef.keys()),
      ...Array.from(parentsMap.keys()),
    ]);

    const referrals = Array.from(referralRefs)
      .map((refCode) => {
        const paymentIds = Array.from(creditedPaymentsByRef.get(refCode) || []);
        const conversions = paymentIds.length;
        const account = parentsMap.get(refCode);
        const creditsEarned = Math.floor(conversions / 5);
        const creditsRedeemed = account?.creditsRedeemed || 0;
        const availableCredits = Math.max(0, creditsEarned - creditsRedeemed);
        return {
          ref: refCode,
          parentName: account?.name,
          parentEmail: account?.email,
          conversions,
          creditsEarned,
          creditsRedeemed,
          availableCredits,
          paymentIds,
        };
      })
      .filter((row) => row.conversions > 0 || row.creditsRedeemed > 0);

    res.json({
      generatedAt: new Date().toISOString(),
      asaasConfigured: Boolean(asaasApiKey),
      asaasError,
      payments: Array.from(paymentMap.values()),
      parents,
      referrals,
      bankFiles: listAudioBankFiles(),
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
      const body = (req.body || {}) as GreetingBody & {token?: string};
      const requestedPlan: PlanId = body.planId || '30s';
      const entitlement = verifyEntitlementToken(
        extractEntitlementTokenFromReq(req),
        requestedPlan
      );
      if (!entitlement) {
        res.status(402).json({
          requiresCheckout: true,
          error: 'Pagamento confirmado necessário para iniciar esta ligação.',
        });
        return;
      }

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
      const planId: PlanId = requestedPlan;
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
      const body = (req.body || {}) as FarewellBody & {token?: string};
      const entitlement = verifyEntitlementToken(extractEntitlementTokenFromReq(req));
      if (!entitlement || entitlement.plan === 'audio') {
        res.status(402).json({requiresCheckout: true, error: 'Token de chamada inválido ou ausente.'});
        return;
      }
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
    const entitlement = verifyEntitlementToken(extractEntitlementTokenFromReq(req));
    if (!entitlement || entitlement.plan === 'audio') {
      res.status(402).json({requiresCheckout: true, error: 'Token de chamada inválido ou ausente.'});
      return;
    }

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
      const token = extractEntitlementTokenFromReq(req);
      const entitlement = verifyEntitlementToken(token, 'audio');
      if (!entitlement) {
        res.status(402).json({
          requiresCheckout: true,
          error: 'Pagamento confirmado necessário para gerar o Áudio Mágico.',
        });
        return;
      }

      const body = (req.body || {}) as {
        childName?: string;
        childAge?: string;
        praise?: string;
        advice?: string;
        audioText?: string;
        ref?: string;
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
      const refId = sanitizeRefId(body.ref);

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
        const params = new URLSearchParams();
        params.set('audio', sharePayload);
        if (token) params.set('token', token);
        if (refId) params.set('ref', refId);
        return `${baseUrl}/?${params.toString()}`;
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

      const isQuotaError = Boolean(
        synth.ttsError && /429|RESOURCE_EXHAUSTED|limite|cota/i.test(synth.ttsError)
      );

      res.json({
        audioBase64: synth.audioBase64,
        audioMimeType: synth.audioMimeType,
        mimeType: synth.audioMimeType,
        audioText,
        shareUrl: buildShareUrl(audioText),
        useBrowserFallback: false,
        voiceSource: synth.audioBase64 ? synth.voiceSource : 'none',
        isQuotaError,
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
      const {email, config, ref} = req.body as {
        email?: string;
        config?: GreetingBody;
        ref?: string;
      };
      if (!config) {
        res.status(400).json({error: 'Informe os dados da chamada para gerar o link mágico.'});
        return;
      }
      const token = extractEntitlementTokenFromReq(req);
      const entitlement = verifyEntitlementToken(token, config.planId || '30s');
      if (!entitlement) {
        res.status(402).json({
          requiresCheckout: true,
          error: 'Pagamento confirmado necessário para gerar Link Mágico.',
        });
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
      const params = new URLSearchParams();
      params.set('chamada', payload);
      if (token) params.set('token', token);
      const validRef = sanitizeRefId(ref);
      if (validRef) params.set('ref', validRef);

      const magicUrl = `${baseUrl}/?${params.toString()}`;
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

  app.use('/audio/bank', express.static(getAudioBankDirectory()));

  if (!isProd) {
    const {createServer: createViteServer} = await import('vite');
    const vite = await createViteServer({
      server: {middlewareMode: true},
      appType: 'custom',
    });
    app.use(vite.middlewares);
    app.use('*', async (req: Request, res: Response, next) => {
      if (
        req.method !== 'GET' ||
        req.originalUrl.startsWith('/api/') ||
        !req.headers.accept?.includes('text/html')
      ) {
        next();
        return;
      }
      try {
        const indexPath = path.resolve(__dirname, 'index.html');
        const template = fs.readFileSync(indexPath, 'utf-8');
        const transformed = await vite.transformIndexHtml(req.originalUrl, template);
        const baseUrl = resolvePublicBaseUrl(req);
        res
          .status(200)
          .set({'Content-Type': 'text/html; charset=utf-8'})
          .end(applyAppUrlToHtml(transformed, baseUrl));
      } catch (err) {
        next(err);
      }
    });
  } else {
    const distPath = path.resolve(__dirname, 'dist');
    app.use(express.static(distPath, {index: false}));
    app.get('*', (req: Request, res: Response) => {
      const indexFile = path.join(distPath, 'index.html');
      if (fs.existsSync(indexFile)) {
        const baseUrl = resolvePublicBaseUrl(req);
        const html = applyAppUrlToHtml(fs.readFileSync(indexFile, 'utf8'), baseUrl);
        res.type('text/html; charset=utf-8').send(html);
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
