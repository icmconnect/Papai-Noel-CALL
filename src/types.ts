export type PlanId = '15s' | '30s' | '60s' | 'familia' | 'audio';
export type FarewellType = 'mamae' | 'duendes' | 'renas' | 'carta';
export type AppScreen =
  | 'home'
  | 'parent'
  | 'debug-panel'
  | 'countdown'
  | 'incoming'
  | 'call'
  | 'ended'
  | 'audio-magic'
  | 'my-magics';
export type SantaVideoState = 'hello' | 'listening' | 'talking' | 'goodbye';

export interface PlanOption {
  id: PlanId;
  title: string;
  durationSeconds: number;
  priceLabel: string;
  summary: string;
  interactive: boolean;
  highlightNote?: string;
  badge?: string;
  topTag?: string;
}

export const PLANS: PlanOption[] = [
  {
    id: '15s',
    title: 'Chamada Rápida',
    durationSeconds: 15,
    priceLabel: 'R$ 9,90',
    summary: '1 ligação rápida com nome + despedida.',
    interactive: false,
  },
  {
    id: '30s',
    title: 'Chamada Especial',
    durationSeconds: 30,
    priceLabel: 'R$ 19,90',
    summary: '1 ligação com elogio e conselho personalizados.',
    interactive: false,
  },
  {
    id: '60s',
    title: 'Conversa Mágica',
    durationSeconds: 60,
    priceLabel: 'R$ 29,90',
    summary: '1 conversa completa ao vivo com o Papai Noel.',
    interactive: true,
  },
  {
    id: 'familia',
    title: 'Passe Família Ilimitado',
    durationSeconds: 60,
    priceLabel: 'R$ 39,90',
    summary: '60s por chamada · Chamadas ilimitadas até o Natal.',
    interactive: true,
    badge: 'MELHOR ESCOLHA',
    topTag: 'MAIS VANTAJOSO',
    highlightNote:
      'Por apenas R$ 10 a mais, faça chamadas ILIMITADAS para todos os filhos, primos e sobrinhos até o Natal e repita a ligação quantas vezes quiser!',
  },
  {
    id: 'audio',
    title: 'Áudio Mágico',
    durationSeconds: 0,
    priceLabel: 'R$ 4,90',
    summary: 'Mensagem de voz do Papai Noel por link, para guardar e ouvir quando quiser.',
    interactive: false,
    badge: 'ISCA',
    topTag: 'SÓ ÁUDIO · SEM CHAMADA',
  },
];

export interface FarewellOption {
  id: FarewellType;
  title: string;
  desc: string;
}

export const FAREWELL_OPTIONS: FarewellOption[] = [
  {
    id: 'mamae',
    title: 'Mamãe Noel chamando',
    desc: 'Chamando para tomar leite quentinho e conferir a lista de Natal.',
  },
  {
    id: 'duendes',
    title: 'Duendes fazendo bagunça',
    desc: 'Os duendes aprontaram na fábrica de brinquedos e o Papai Noel precisa ajudar.',
  },
  {
    id: 'renas',
    title: 'Renas prontas no trenó',
    desc: 'O Rodolfo está chamando porque o trenó vai decolar para treinar voo.',
  },
  {
    id: 'carta',
    title: 'Carta urgente chegando',
    desc: 'Chegou uma pilha mágica de cartinhas pelo correio do Polo Norte.',
  },
];

export interface CallConfig {
  planId: PlanId;
  childName: string;
  childAge: string;
  praise: string;
  advice: string;
  farewellType: FarewellType;
  parentEmail: string;
}

export interface PreparedCallMedia {
  greetingText: string;
  greetingAudioBase64: string | null;
  greetingAudioMimeType: string | null;
  farewellText: string;
  useBrowserFallback?: boolean;
  voiceSource?: string;
  ttsError?: string | null;
}

export interface PreparedAudioMagic {
  audioText: string;
  audioBase64: string | null;
  audioMimeType: string | null;
  mimeType?: string | null;
  shareUrl: string;
  useBrowserFallback?: boolean;
  voiceSource?: string;
  ttsError?: string | null;
  isQuotaError?: boolean;
}

export interface ChatTurn {
  role: 'santa' | 'child';
  text: string;
}

export type AsaasPlanLinks = Record<PlanId, string | null>;

export interface ParentProfileStats {
  parentId: string;
  name: string;
  phone: string;
  email: string;
  conversions: number;
  creditsEarned: number;
  creditsRedeemed: number;
  availableCredits: number;
  neededForNextCredit: number;
}

export interface SavedMagicItem {
  id: string;
  type: 'audio' | 'video';
  childName: string;
  planId: PlanId;
  shareUrl: string;
  token: string;
  createdAt: string;
}

export interface AudioBankFileItem {
  filename: string;
  sizeBytes: number;
  updatedAt: string;
  url: string;
}

export interface BankGenerateSummary {
  gerados: number;
  pulados: number;
  falhas: number;
  totalSolicitados: number;
  custoEstimadoBRL: number;
  files: AudioBankFileItem[];
  failures: Array<{filename: string; reason: string}>;
}

export interface AdminPaymentRow {
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

export interface AdminParentRow extends ParentProfileStats {
  createdAt: string;
  updatedAt: string;
  magicsCount: number;
}

export interface AdminReferralRow {
  ref: string;
  parentName?: string;
  parentEmail?: string;
  conversions: number;
  creditsEarned: number;
  creditsRedeemed: number;
  availableCredits: number;
  paymentIds: string[];
}

export interface AdminOverviewResponse {
  generatedAt: string;
  asaasConfigured: boolean;
  asaasError?: string | null;
  payments: AdminPaymentRow[];
  parents: AdminParentRow[];
  referrals: AdminReferralRow[];
  bankFiles: AudioBankFileItem[];
}

export interface DebugStatusResponse {
  debugActive: boolean;
  environment: string;
  missingEnvVars: string[];
  configured: Record<string, boolean>;
}

