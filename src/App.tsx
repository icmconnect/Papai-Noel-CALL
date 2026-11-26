import React, {useCallback, useEffect, useRef, useState} from 'react';
import {
  CheckCircle2,
  ChevronDown,
  Copy,
  CreditCard,
  Crown,
  ExternalLink,
  FolderHeart,
  Gift,
  Home,
  Loader2,
  Lock,
  RotateCcw,
  Share2,
  Sparkles,
  UserCheck,
  X,
} from 'lucide-react';
import {AdminScreen} from './components/AdminScreen';
import {AudioMagicScreen} from './components/AudioMagicScreen';
import {DebugPanel} from './components/DebugPanel';
import {HomeScreen} from './components/HomeScreen';
import {IncomingCallScreen} from './components/IncomingCallScreen';
import {OfflineIndicator} from './components/OfflineIndicator';
import {ParentPanel} from './components/ParentPanel';
import {SnowfallBackground} from './components/SnowfallBackground';
import {VideoCallScreen} from './components/VideoCallScreen';
import {
  AppScreen,
  AsaasPlanLinks,
  CallConfig,
  DebugStatusResponse,
  FarewellType,
  PLANS,
  ParentProfileStats,
  PlanId,
  PreparedAudioMagic,
  PreparedCallMedia,
  SavedMagicItem,
} from './types';
import {playSantaAudio, stopCurrentSantaVoice, unlockAudioContext} from './utils/audioEngine';

const DEFAULT_CONFIG: CallConfig = {
  planId: 'familia',
  childName: '',
  childAge: '',
  praise: '',
  advice: '',
  farewellType: 'duendes',
  parentEmail: '',
};

const DEFAULT_ASAAS_LINKS: AsaasPlanLinks = {
  '15s': null,
  '30s': null,
  '60s': null,
  familia: null,
  audio: null,
};

const PENDING_CHECKOUT_KEY = 'santa_pending_checkout';
const REF_STORAGE_KEY = 'santa_ref_id';
const SAVED_MAGICS_KEY = 'santa_my_magics';

function isSafeHttpUrl(url: string | null | undefined): url is string {
  if (!url) return false;
  try {
    const parsed = new URL(url);
    return parsed.protocol === 'https:' || parsed.protocol === 'http:';
  } catch {
    return false;
  }
}

function appendRefQuery(url: string, refId?: string | null): string {
  if (!url || !refId) return url;
  try {
    const parsed = new URL(url);
    if (!parsed.searchParams.get('ref')) {
      parsed.searchParams.set('ref', refId);
    }
    return parsed.toString();
  } catch {
    return url;
  }
}

function decodeBase64UrlJson<T>(raw: string): T | null {
  try {
    const base64 = raw.replace(/-/g, '+').replace(/_/g, '/');
    const pad = base64.length % 4 ? '='.repeat(4 - (base64.length % 4)) : '';
    const json = decodeURIComponent(
      Array.prototype.map
        .call(
          window.atob(base64 + pad),
          (c: string) => '%' + ('00' + c.charCodeAt(0).toString(16)).slice(-2)
        )
        .join('')
    );
    return JSON.parse(json) as T;
  } catch {
    return null;
  }
}

function decodeMagicConfigFromUrl(): {
  config: CallConfig;
  token: string | null;
  isDebugUrl: boolean;
} | null {
  if (typeof window === 'undefined') return null;
  const params = new URLSearchParams(window.location.search);
  const raw = params.get('chamada');
  if (!raw) return null;

  const token = (params.get('token') || '').trim() || null;

  if (raw === 'true') {
    const validPlans: PlanId[] = ['15s', '30s', '60s', 'familia', 'audio'];
    const requestedPlanRaw = (params.get('plano') || '').trim() as PlanId;
    const requestedPlan = validPlans.includes(requestedPlanRaw) ? requestedPlanRaw : null;

    let pendingConfig: Partial<CallConfig> = {};
    try {
      const rawPending = sessionStorage.getItem(PENDING_CHECKOUT_KEY);
      if (rawPending) {
        const parsedPending = JSON.parse(rawPending) as {config?: Partial<CallConfig>};
        if (parsedPending?.config) {
          pendingConfig = parsedPending.config;
        }
      }
    } catch {
      // Ignore storage errors
    }

    return {
      config: {
        ...DEFAULT_CONFIG,
        ...pendingConfig,
        planId: requestedPlan || pendingConfig.planId || 'familia',
        childName: (pendingConfig.childName || '').trim() || 'Teste Debug',
      },
      token,
      isDebugUrl: true,
    };
  }

  const parsed = decodeBase64UrlJson<Partial<CallConfig> & {token?: string}>(raw);
  if (!parsed?.childName) return null;
  return {
    config: {
      ...DEFAULT_CONFIG,
      ...parsed,
    },
    token: token || (parsed.token || '').trim() || null,
    isDebugUrl: false,
  };
}

function decodeAudioMagicFromUrl(): {
  config: CallConfig;
  audioText?: string;
  token: string | null;
} | null {
  if (typeof window === 'undefined') return null;
  const params = new URLSearchParams(window.location.search);
  const raw = params.get('audio');
  if (!raw) return null;

  const parsed = decodeBase64UrlJson<Partial<CallConfig> & {audioText?: string; token?: string}>(
    raw
  );
  if (!parsed?.childName) return null;
  const token = (params.get('token') || parsed.token || '').trim() || null;
  return {
    config: {
      ...DEFAULT_CONFIG,
      ...parsed,
      planId: 'audio',
    },
    audioText: typeof parsed.audioText === 'string' ? parsed.audioText : undefined,
    token,
  };
}

const HOME_FAQ_ITEMS: Array<{question: string; answer: string}> = [
  {
    question: 'Como funciona a ligação de vídeo do Papai Noel personalizada?',
    answer:
      'Os pais entram na Área dos Pais protegida por uma conta matemática simples, escolhem o plano e informam o nome da criança, idade, elogios da semana e um conselho carinhoso. Em poucos segundos o celular toca como uma videochamada real e o Papai Noel conversa chamando a criança pelo nome.',
  },
  {
    question: 'O que é o plano Áudio Mágico de R$ 4,90 e qual a diferença para a chamada de vídeo?',
    answer:
      'O Áudio Mágico (R$ 4,90) gera apenas uma mensagem de voz personalizada do Papai Noel com o nome, elogio e conselho da criança, entregue por link para ouvir quando quiser, baixar e enviar no WhatsApp, sem chamada de vídeo. Já os planos a partir de R$ 9,90 fazem a ligação de vídeo completa na tela.',
  },
  {
    question: 'Funciona no iPhone (Safari) e no Android (Chrome) sem baixar aplicativo?',
    answer:
      'Sim. Tudo funciona direto no navegador (Safari no iPhone e Chrome no Android) sem precisar instalar aplicativo pela App Store ou Google Play, com desbloqueio de áudio ao atender e botão Segurar para Falar compatível com iOS.',
  },
  {
    question: 'Quais são todos os planos disponíveis?',
    answer:
      'Você pode escolher entre o Áudio Mágico (R$ 4,90, só voz por link), Chamada Rápida de 15s (R$ 9,90), Chamada Especial de 30s (R$ 19,90), Conversa Mágica interativa de 60s (R$ 29,90) e o Passe Família Ilimitado (R$ 39,90) para ligar para filhos, primos e sobrinhos até o Natal.',
  },
  {
    question: 'Posso compartilhar o áudio ou a chamada para abrir em outro celular?',
    answer:
      'Sim. No Áudio Mágico você recebe um link pronto para compartilhar no WhatsApp ou baixar o arquivo. Nos planos de vídeo, o Painel dos Pais gera um Link Mágico para abrir a chamada personalizada em qualquer outro aparelho.',
  },
];

function getFarewellSummaryText(farewellType: FarewellType): string {
  switch (farewellType) {
    case 'mamae':
      return 'a Mamãe Noel chamou para tomar leite quentinho e conferir a lista de Natal.';
    case 'renas':
      return 'o Rodolfo chamou porque as renas estão prontas no trenó para treinar voo.';
    case 'carta':
      return 'chegou uma pilha mágica de cartinhas urgentes no correio do Polo Norte.';
    case 'duendes':
    default:
      return 'os duendes estavam fazendo bagunça na fábrica de brinquedos!';
  }
}

export default function App() {
  const isAdminRoute = typeof window !== 'undefined' && window.location.pathname === '/admin';
  const isDebugRoute = typeof window !== 'undefined' && window.location.pathname === '/debug-call';
  const isDebugTtsRoute = typeof window !== 'undefined' && window.location.pathname === '/debug-tts';

  if (isAdminRoute) {
    const initialAdminToken =
      typeof window !== 'undefined'
        ? new URLSearchParams(window.location.search).get('token')
        : null;
    return (
      <div className="min-h-[100dvh] bg-[#0B0C10] text-[#F7F4EC] relative overflow-x-hidden">
        <SnowfallBackground />
        <OfflineIndicator />
        <AdminScreen
          initialToken={initialAdminToken}
          onBackHome={() => {
            window.location.assign('/');
          }}
        />
      </div>
    );
  }

  const [debugName, setDebugName] = useState('Vinicius');
  const [debugTtsLoading, setDebugTtsLoading] = useState(false);
  const [debugTtsResult, setDebugTtsResult] = useState<{
    success?: boolean;
    source?: string;
    text?: string;
    audioBase64?: string;
    audioMimeType?: string;
    useBrowserFallback?: boolean;
    ttsError?: string;
  } | null>(null);

  if (isDebugTtsRoute) {
    const handleTestTts = async () => {
      setDebugTtsLoading(true);
      setDebugTtsResult(null);
      try {
        const res = await fetch(`/api/debug/tts?name=${encodeURIComponent(debugName || 'Vinicius')}`);
        const data = await res.json();
        setDebugTtsResult(data);
        if (data.audioBase64) {
          playSantaAudio({
            audioBase64: data.audioBase64,
            audioMimeType: data.audioMimeType,
            fallbackText: data.text || '',
            useBrowserFallback: false,
            disableBrowserFallback: true,
          });
        }
      } catch (err) {
        setDebugTtsResult({ttsError: err instanceof Error ? err.message : 'Erro ao testar TTS'});
      } finally {
        setDebugTtsLoading(false);
      }
    };

    return (
      <div className="min-h-[100dvh] bg-[#0B0C10] text-[#F7F4EC] flex items-center justify-center p-6">
        <div className="w-full max-w-md rounded-3xl border border-[#D4AF37]/40 bg-[#13151C] p-8 text-center space-y-6 shadow-2xl">
          <h1
            className="text-2xl font-bold text-[#F5D97E]"
            style={{fontFamily: 'var(--font-display)'}}
          >
            Banco de Áudio & Diagnóstico
          </h1>
          <p className="text-sm text-[#C7C2B6] leading-relaxed">
            Digite um nome para testar o Audio Bank (latência ~0ms) ou a geração por IA (TTS).
          </p>
          <div className="text-left space-y-1.5">
            <label htmlFor="debug-name-input" className="text-xs text-[#D4AF37] font-medium">
              Nome da Criança / Teste
            </label>
            <input
              id="debug-name-input"
              type="text"
              value={debugName}
              onChange={(e) => setDebugName(e.target.value)}
              placeholder="Ex: Vinicius, Maria..."
              className="w-full min-h-[46px] px-4 rounded-xl bg-[#0B0C10] border border-white/15 text-sm text-white focus:outline-none focus:border-[#D4AF37]"
            />
          </div>
          <button
            type="button"
            onClick={handleTestTts}
            disabled={debugTtsLoading}
            className="w-full min-h-[52px] rounded-xl bg-gradient-to-r from-[#D4AF37] to-[#F3E5AB] text-[#0B0C10] font-bold text-base hover:brightness-105 transition-all cursor-pointer disabled:opacity-60 flex items-center justify-center gap-2 shadow-[0_8px_24px_rgba(212,175,55,0.3)]"
          >
            {debugTtsLoading ? 'Consultando Polo Norte...' : 'Testar Voz do Papai Noel'}
          </button>
          {debugTtsResult && (
            <div className="rounded-xl bg-[#0B0C10] p-4 text-left text-xs space-y-2 border border-white/10">
              <p className="text-emerald-400 font-semibold flex items-center justify-between">
                <span>Sucesso: {String(Boolean(debugTtsResult.success))}</span>
                <span
                  className={`px-2 py-0.5 rounded text-[10px] font-bold uppercase ${
                    debugTtsResult.source === 'audio-bank'
                      ? 'bg-emerald-500/20 text-emerald-300 border border-emerald-500/30'
                      : 'bg-amber-500/20 text-amber-300 border border-amber-500/30'
                  }`}
                >
                  Origem:{' '}
                  {debugTtsResult.source === 'audio-bank' ? 'Audio Bank (Instantâneo)' : 'TTS (IA)'}
                </span>
              </p>
              <p className="text-[#C7C2B6]">Texto: &ldquo;{debugTtsResult.text}&rdquo;</p>
              {debugTtsResult.ttsError && (
                <p className="text-red-400">Erro: {debugTtsResult.ttsError}</p>
              )}
            </div>
          )}
        </div>
      </div>
    );
  }

  const [initialState] = useState(() => {
    const params =
      typeof window !== 'undefined' ? new URLSearchParams(window.location.search) : null;
    const urlRef = params?.get('ref')?.trim() || '';
    let storedRef = '';
    if (typeof window !== 'undefined') {
      if (urlRef) {
        try {
          sessionStorage.setItem(REF_STORAGE_KEY, urlRef);
        } catch {
          // Ignore
        }
        storedRef = urlRef;
      } else {
        try {
          storedRef = sessionStorage.getItem(REF_STORAGE_KEY) || '';
        } catch {
          storedRef = '';
        }
      }
    }

    const pagamentoOk = params?.get('pagamento') === 'ok' && Boolean(params?.get('id'));
    const pagamentoId = params?.get('id')?.trim() || '';

    const audioFromUrl = decodeAudioMagicFromUrl();
    if (audioFromUrl) {
      return {
        config: audioFromUrl.config,
        isAudioLink: true,
        isVideoLink: false,
        isDebugUrl: false,
        initialAudioText: audioFromUrl.audioText,
        linkToken: audioFromUrl.token,
        referrerId: storedRef || null,
        pagamentoOk,
        pagamentoId,
      };
    }

    const fromUrl = decodeMagicConfigFromUrl();
    if (fromUrl) {
      return {
        config: fromUrl.config,
        isAudioLink: false,
        isVideoLink: true,
        isDebugUrl: fromUrl.isDebugUrl,
        initialAudioText: undefined as string | undefined,
        linkToken: fromUrl.token,
        referrerId: storedRef || null,
        pagamentoOk,
        pagamentoId,
      };
    }

    // Restore pending config when returning from Asaas checkout
    let restoredConfig = DEFAULT_CONFIG;
    if (typeof window !== 'undefined' && pagamentoOk) {
      try {
        const rawPending = sessionStorage.getItem(PENDING_CHECKOUT_KEY);
        if (rawPending) {
          const parsedPending = JSON.parse(rawPending) as {
            config?: Partial<CallConfig>;
            ref?: string;
          };
          if (parsedPending?.config) {
            restoredConfig = {...DEFAULT_CONFIG, ...parsedPending.config};
          }
          if (!storedRef && parsedPending?.ref) {
            storedRef = parsedPending.ref;
          }
        }
      } catch {
        // Ignore parse errors
      }
    }

    return {
      config: restoredConfig,
      isAudioLink: false,
      isVideoLink: false,
      isDebugUrl: false,
      initialAudioText: undefined as string | undefined,
      linkToken: null as string | null,
      referrerId: storedRef || null,
      pagamentoOk,
      pagamentoId,
    };
  });

  const [config, setConfig] = useState<CallConfig>(initialState.config);
  const [hasCustomConfig, setHasCustomConfig] = useState<boolean>(false);
  const [screen, setScreen] = useState<AppScreen>(isDebugRoute ? 'call' : 'home');
  const [countdownSeconds, setCountdownSeconds] = useState<number>(10);
  const [preparedMedia, setPreparedMedia] = useState<PreparedCallMedia | null>(null);
  const [isPreparingCall, setIsPreparingCall] = useState<boolean>(false);
  const [prepareError, setPrepareError] = useState<string | null>(null);
  const [audioMagicMedia, setAudioMagicMedia] = useState<PreparedAudioMagic | null>(null);
  const [isGeneratingAudioMagic, setIsGeneratingAudioMagic] = useState<boolean>(false);
  const [audioMagicError, setAudioMagicError] = useState<string | null>(null);
  const [frontCameraStream, setFrontCameraStream] = useState<MediaStream | null>(null);

  // Payment, Token, Parent Profile & Referrals state
  const [asaasLinks, setAsaasLinks] = useState<AsaasPlanLinks>(DEFAULT_ASAAS_LINKS);
  const [publicAppUrl, setPublicAppUrl] = useState<string>(() =>
    typeof window !== 'undefined' ? window.location.origin : ''
  );
  const [entitlementToken, setEntitlementToken] = useState<string | null>(null);
  const [paidPlanId, setPaidPlanId] = useState<PlanId | null>(null);
  const [referrerId] = useState<string | null>(initialState.referrerId);
  const [isConfirmingPayment, setIsConfirmingPayment] = useState<boolean>(
    initialState.pagamentoOk || initialState.isAudioLink || initialState.isVideoLink
  );
  const [paymentConfirmError, setPaymentConfirmError] = useState<string | null>(null);
  const [checkoutGate, setCheckoutGate] = useState<{
    config: CallConfig;
    sourceType: 'audio' | 'video';
    reason: string;
  } | null>(null);
  const [debugStatus, setDebugStatus] = useState<DebugStatusResponse | null>(null);
  const [debugModeActive, setDebugModeActive] = useState<boolean>(false);
  const [isTogglingDebug, setIsTogglingDebug] = useState<boolean>(false);
  const [debugError, setDebugError] = useState<string | null>(null);

  const [parentProfile, setParentProfile] = useState<ParentProfileStats | null>(null);
  const [showPostPayRegister, setShowPostPayRegister] = useState<boolean>(false);
  const [regName, setRegName] = useState('');
  const [regPhone, setRegPhone] = useState('');
  const [regEmail, setRegEmail] = useState(initialState.config.parentEmail || '');
  const [isRegisteringParent, setIsRegisteringParent] = useState(false);
  const [regError, setRegError] = useState<string | null>(null);

  const [savedMagics, setSavedMagics] = useState<SavedMagicItem[]>(() => {
    if (typeof window === 'undefined') return [];
    try {
      const raw = localStorage.getItem(SAVED_MAGICS_KEY);
      const parsed = raw ? (JSON.parse(raw) as SavedMagicItem[]) : [];
      return Array.isArray(parsed) ? parsed : [];
    } catch {
      return [];
    }
  });
  const [isRedeemingCredit, setIsRedeemingCredit] = useState(false);
  const [redeemError, setRedeemError] = useState<string | null>(null);
  const [copiedRefLink, setCopiedRefLink] = useState(false);

  const helloVideoRef = useRef<HTMLVideoElement | null>(null);
  const listeningVideoRef = useRef<HTMLVideoElement | null>(null);
  const talkingVideoRef = useRef<HTMLVideoElement | null>(null);
  const goodbyeVideoRef = useRef<HTMLVideoElement | null>(null);
  const countdownTimerRef = useRef<number | null>(null);
  const screenRef = useRef<AppScreen>(screen);
  const prepareRequestIdRef = useRef<number>(0);
  const audioRequestIdRef = useRef<number>(0);
  const audioMagicPresetTextRef = useRef<string | undefined>(initialState.initialAudioText);
  const entitlementTokenRef = useRef<string | null>(entitlementToken);

  useEffect(() => {
    screenRef.current = screen;
  }, [screen]);

  useEffect(() => {
    entitlementTokenRef.current = entitlementToken;
  }, [entitlementToken]);

  const handleConfigChange = (next: CallConfig) => {
    setConfig(next);
  };

  const appendSavedMagic = useCallback(
    (item: SavedMagicItem) => {
      setSavedMagics((prev) => {
        const next = [item, ...prev.filter((m) => m.shareUrl !== item.shareUrl)].slice(0, 30);
        try {
          localStorage.setItem(SAVED_MAGICS_KEY, JSON.stringify(next));
        } catch {
          // Ignore storage quota
        }
        return next;
      });

      const activeToken = item.token || entitlementTokenRef.current;
      if (parentProfile && activeToken) {
        void fetch('/api/parents/save-magic', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${activeToken}`,
          },
          body: JSON.stringify({
            type: item.type,
            childName: item.childName,
            planId: item.planId,
            shareUrl: item.shareUrl,
            token: activeToken,
          }),
        })
          .then((r) => (r.ok ? r.json() : null))
          .then((data) => {
            if (data?.parent) setParentProfile(data.parent as ParentProfileStats);
          })
          .catch(() => undefined);
      }
    },
    [parentProfile]
  );

  const stopCameraStream = useCallback(() => {
    setFrontCameraStream((prev) => {
      if (prev) {
        prev.getTracks().forEach((t) => t.stop());
      }
      return null;
    });
  }, []);

  const requestFrontCameraStream = useCallback(async () => {
    if (typeof navigator === 'undefined' || !navigator.mediaDevices?.getUserMedia) {
      setFrontCameraStream(null);
      return;
    }
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        video: {facingMode: 'user'},
        audio: false,
      });
      if (screenRef.current !== 'call') {
        stream.getTracks().forEach((t) => t.stop());
        return;
      }
      setFrontCameraStream((prev) => {
        if (prev && prev !== stream) {
          prev.getTracks().forEach((t) => t.stop());
        }
        return stream;
      });
    } catch {
      setFrontCameraStream((prev) => {
        if (prev) {
          prev.getTracks().forEach((t) => t.stop());
        }
        return null;
      });
    }
  }, []);

  const prepareGreetingFromServer = useCallback(
    async (targetConfig: CallConfig, overrideToken?: string | null) => {
      const activeToken = overrideToken ?? entitlementTokenRef.current;
      if (!activeToken) {
        setCheckoutGate({
          config: targetConfig,
          sourceType: 'video',
          reason: 'Pagamento necessário para liberar esta ligação personalizada.',
        });
        return null;
      }

      const requestId = ++prepareRequestIdRef.current;
      setIsPreparingCall(true);
      setPrepareError(null);
      setPreparedMedia(null);

      try {
        const res = await fetch('/api/santa/greeting', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${activeToken}`,
          },
          body: JSON.stringify({
            ...targetConfig,
            token: activeToken,
          }),
        });
        const data = await res.json();
        if (!res.ok) {
          if (res.status === 402 || data.requiresCheckout) {
            setCheckoutGate({
              config: targetConfig,
              sourceType: 'video',
              reason: data.error || 'Pagamento necessário para iniciar a chamada.',
            });
          }
          throw new Error(data.error || 'Erro ao preparar a fala do Papai Noel.');
        }
        if (requestId !== prepareRequestIdRef.current) {
          return null;
        }
        setPreparedMedia(data as PreparedCallMedia);
        return data as PreparedCallMedia;
      } catch (err) {
        if (requestId !== prepareRequestIdRef.current) {
          return null;
        }
        const msg =
          err instanceof Error ? err.message : 'Não foi possível conectar ao Polo Norte.';
        setPrepareError(msg);
        return null;
      } finally {
        if (requestId === prepareRequestIdRef.current) {
          setIsPreparingCall(false);
        }
      }
    },
    []
  );

  const generateAudioMagicFromServer = useCallback(
    async (
      targetConfig: CallConfig,
      presetAudioText?: string,
      overrideToken?: string | null,
      options?: {silent?: boolean}
    ) => {
      const activeToken = overrideToken ?? entitlementTokenRef.current;
      if (!activeToken) {
        setCheckoutGate({
          config: targetConfig,
          sourceType: 'audio',
          reason: 'Pagamento necessário para gerar e ouvir o Áudio Mágico.',
        });
        return null;
      }

      const requestId = ++audioRequestIdRef.current;
      if (!options?.silent) {
        setIsGeneratingAudioMagic(true);
        setAudioMagicError(null);
        setAudioMagicMedia(null);
      }

      try {
        const res = await fetch('/api/santa/audio', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${activeToken}`,
          },
          body: JSON.stringify({
            childName: targetConfig.childName,
            childAge: targetConfig.childAge,
            praise: targetConfig.praise,
            advice: targetConfig.advice,
            token: activeToken,
            ...(parentProfile?.parentId ? {ref: parentProfile.parentId} : {}),
            ...(presetAudioText ? {audioText: presetAudioText} : {}),
          }),
        });
        const data = (await res.json()) as PreparedAudioMagic & {
          error?: string;
          requiresCheckout?: boolean;
        };
        if (!res.ok) {
          if (res.status === 402 || data.requiresCheckout) {
            setCheckoutGate({
              config: targetConfig,
              sourceType: 'audio',
              reason: data.error || 'Pagamento necessário para acessar o Áudio Mágico.',
            });
          }
          throw new Error(data.error || 'Erro ao gerar o Áudio Mágico do Papai Noel.');
        }
        if (requestId !== audioRequestIdRef.current) {
          return null;
        }
        setAudioMagicError(null);
        setAudioMagicMedia(data);
        if (data.audioBase64 && data.shareUrl) {
          appendSavedMagic({
            id: `aud_${Date.now()}`,
            type: 'audio',
            childName: targetConfig.childName || 'Criança',
            planId: 'audio',
            shareUrl: appendRefQuery(data.shareUrl, parentProfile?.parentId),
            token: activeToken,
            createdAt: new Date().toISOString(),
          });
        }
        return data;
      } catch (err) {
        if (requestId !== audioRequestIdRef.current) {
          return null;
        }
        const msg =
          err instanceof Error ? err.message : 'Não foi possível gerar o Áudio Mágico agora.';
        setAudioMagicError(msg);
        return null;
      } finally {
        if (requestId === audioRequestIdRef.current && !options?.silent) {
          setIsGeneratingAudioMagic(false);
        }
      }
    },
    [appendSavedMagic, parentProfile?.parentId]
  );

  // Bootstrap: load Asaas links + APP_URL, restore parent session, verify payment callback or link token
  useEffect(() => {
    void fetch('/api/pay/config')
      .then((r) => (r.ok ? r.json() : null))
      .then((data: {appUrl?: string; links?: AsaasPlanLinks} | null) => {
        if (data?.links) setAsaasLinks(data.links);
        if (data?.appUrl) setPublicAppUrl(data.appUrl);
      })
      .catch(() => undefined);

    void fetch('/api/debug/status')
      .then((r) => (r.ok ? r.json() : null))
      .then((data: DebugStatusResponse | null) => {
        if (data) setDebugStatus(data);
      })
      .catch(() => undefined);

    void fetch('/api/parents/me')
      .then((r) => (r.ok ? r.json() : null))
      .then((data: {parent?: ParentProfileStats; magics?: SavedMagicItem[]} | null) => {
        if (data?.parent) {
          setParentProfile(data.parent);
        }
        if (Array.isArray(data?.magics) && data.magics.length > 0) {
          setSavedMagics((prev) => {
            const combined = [...data.magics!, ...prev];
            const dedup: SavedMagicItem[] = [];
            const seen = new Set<string>();
            for (const m of combined) {
              if (!seen.has(m.shareUrl)) {
                seen.add(m.shareUrl);
                dedup.push(m);
              }
            }
            return dedup.slice(0, 30);
          });
        }
      })
      .catch(() => undefined);

    const bootstrapTokenOrPayment = async () => {
      // 1) Asaas checkout return: ?pagamento=ok&id=<paymentId>
      if (initialState.pagamentoOk && initialState.pagamentoId) {
        setIsConfirmingPayment(true);
        setPaymentConfirmError(null);
        try {
          const res = await fetch('/api/pay/confirm', {
            method: 'POST',
            headers: {'Content-Type': 'application/json'},
            body: JSON.stringify({
              paymentId: initialState.pagamentoId,
              planId: initialState.config.planId,
              ref: initialState.referrerId || undefined,
            }),
          });
          const data = (await res.json()) as {
            paid?: boolean;
            token?: string;
            planId?: PlanId;
            error?: string;
          };
          if (!res.ok || !data.paid || !data.token || !data.planId) {
            throw new Error(data.error || 'Não foi possível confirmar o pagamento no Asaas.');
          }
          setEntitlementToken(data.token);
          entitlementTokenRef.current = data.token;
          setPaidPlanId(data.planId);
          setConfig((prev) => ({...prev, planId: data.planId!}));
          setShowPostPayRegister(true);
          screenRef.current = 'parent';
          setScreen('parent');
          try {
            window.history.replaceState({}, '', window.location.pathname);
          } catch {
            // Ignore history restriction
          }
        } catch (err) {
          setPaymentConfirmError(
            err instanceof Error ? err.message : 'Pagamento ainda não confirmado.'
          );
        } finally {
          setIsConfirmingPayment(false);
        }
        return;
      }

      // 2) Magic Link (/?chamada=...) or Audio Link (/?audio=...): MUST have valid HMAC token
      if (initialState.isAudioLink || initialState.isVideoLink) {
        setIsConfirmingPayment(true);
        const targetType = initialState.isAudioLink ? 'audio' : 'video';
        if (!initialState.linkToken) {
          setCheckoutGate({
            config: initialState.config,
            sourceType: targetType,
            reason: 'Este link ainda não possui confirmação de pagamento válida.',
          });
          setIsConfirmingPayment(false);
          return;
        }

        try {
          const res = await fetch('/api/pay/validate-token', {
            method: 'POST',
            headers: {'Content-Type': 'application/json'},
            body: JSON.stringify({
              token: initialState.linkToken,
              planId: initialState.config.planId,
            }),
          });
          const data = (await res.json()) as {
            valid?: boolean;
            planId?: PlanId;
            debug?: boolean;
            childName?: string;
            error?: string;
          };
          if (!res.ok || !data.valid || !data.planId) {
            setCheckoutGate({
              config: initialState.config,
              sourceType: targetType,
              reason: data.error || 'Token expirado ou inválido. Conclua o pagamento para liberar.',
            });
            return;
          }

          setEntitlementToken(initialState.linkToken);
          entitlementTokenRef.current = initialState.linkToken;
          setPaidPlanId(data.planId);
          if (data.debug) {
            setDebugModeActive(true);
          }

          if (initialState.isAudioLink || (initialState.isDebugUrl && initialState.config.planId === 'audio')) {
            screenRef.current = 'audio-magic';
            setScreen('audio-magic');
            void generateAudioMagicFromServer(
              initialState.config,
              initialState.initialAudioText,
              initialState.linkToken
            );
          } else if (initialState.isDebugUrl) {
            setHasCustomConfig(true);
            void prepareGreetingFromServer(initialState.config, initialState.linkToken);
            screenRef.current = 'incoming';
            setScreen('incoming');
          } else {
            setHasCustomConfig(true);
          }
        } catch {
          setCheckoutGate({
            config: initialState.config,
            sourceType: targetType,
            reason: 'Não foi possível validar o token deste link agora.',
          });
        } finally {
          setIsConfirmingPayment(false);
        }
      }
    };

    void bootstrapTokenOrPayment();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const handleToggleDebugMode = useCallback(async (enable: boolean) => {
    setDebugError(null);
    if (!enable) {
      setDebugModeActive(false);
      setEntitlementToken(null);
      entitlementTokenRef.current = null;
      setPaidPlanId(null);
      return;
    }

    setIsTogglingDebug(true);
    try {
      const res = await fetch('/api/debug/unlock-all-plans', {
        method: 'POST',
        headers: {'Content-Type': 'application/json'},
      });
      const data = (await res.json()) as {
        ok?: boolean;
        token?: string;
        planId?: PlanId;
        childName?: string;
        error?: string;
      };
      if (!res.ok || !data.token) {
        throw new Error(data.error || 'Não foi possível ativar o Modo Debug Global.');
      }

      setEntitlementToken(data.token);
      entitlementTokenRef.current = data.token;
      setPaidPlanId(data.planId || 'familia');
      setDebugModeActive(true);
      setPaymentConfirmError(null);
      setCheckoutGate(null);
      setConfig((prev) => ({
        ...prev,
        childName: prev.childName.trim() ? prev.childName : data.childName || 'Teste Debug',
      }));
    } catch (err) {
      setDebugError(
        err instanceof Error ? err.message : 'Erro ao ativar Modo Debug Global.'
      );
    } finally {
      setIsTogglingDebug(false);
    }
  }, []);

  const handleSubmitParentRegistration = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!entitlementToken) {
      setRegError('Pagamento confirmado necessário para registrar.');
      return;
    }
    setRegError(null);
    setIsRegisteringParent(true);
    try {
      const res = await fetch('/api/parents/register', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${entitlementToken}`,
        },
        body: JSON.stringify({
          name: regName,
          phone: regPhone,
          email: regEmail,
          token: entitlementToken,
        }),
      });
      const data = (await res.json()) as {parent?: ParentProfileStats; error?: string};
      if (!res.ok || !data.parent) {
        throw new Error(data.error || 'Erro ao salvar cadastro.');
      }
      setParentProfile(data.parent);
      setConfig((prev) => ({...prev, parentEmail: data.parent!.email || prev.parentEmail}));
      setShowPostPayRegister(false);
    } catch (err) {
      setRegError(err instanceof Error ? err.message : 'Erro ao salvar cadastro.');
    } finally {
      setIsRegisteringParent(false);
    }
  };

  const handleRedeemFreeCredit = async () => {
    setRedeemError(null);
    setIsRedeemingCredit(true);
    try {
      const res = await fetch('/api/parents/redeem-credit', {
        method: 'POST',
        headers: {'Content-Type': 'application/json'},
      });
      const data = (await res.json()) as {
        token?: string;
        planId?: PlanId;
        parent?: ParentProfileStats;
        error?: string;
      };
      if (!res.ok || !data.token || !data.planId) {
        throw new Error(data.error || 'Não foi possível resgatar o crédito grátis.');
      }
      if (data.parent) setParentProfile(data.parent);
      setEntitlementToken(data.token);
      entitlementTokenRef.current = data.token;
      setPaidPlanId(data.planId);
      setConfig((prev) => ({...prev, planId: data.planId!}));
      screenRef.current = 'parent';
      setScreen('parent');
    } catch (err) {
      setRedeemError(err instanceof Error ? err.message : 'Erro ao resgatar crédito grátis.');
    } finally {
      setIsRedeemingCredit(false);
    }
  };

  const handleGenerateAudioMagicFromParent = () => {
    if (!entitlementToken) {
      setCheckoutGate({
        config,
        sourceType: 'audio',
        reason: 'Conclua o pagamento do Áudio Mágico antes de gerar.',
      });
      return;
    }
    setHasCustomConfig(true);
    setPrepareError(null);
    audioMagicPresetTextRef.current = undefined;
    screenRef.current = 'audio-magic';
    setScreen('audio-magic');
    void generateAudioMagicFromServer(config);
  };

  const handleStartDirectFromHome = () => {
    if (!entitlementToken) {
      setCheckoutGate({
        config,
        sourceType: config.planId === 'audio' ? 'audio' : 'video',
        reason: 'Conclua o pagamento do plano para liberar a chamada.',
      });
      return;
    }
    if (config.planId === 'audio') {
      handleGenerateAudioMagicFromParent();
      return;
    }
    void prepareGreetingFromServer(config);
    screenRef.current = 'incoming';
    setScreen('incoming');
  };

  const handleStartCountdownFromParent = () => {
    if (!entitlementToken) {
      setCheckoutGate({
        config,
        sourceType: config.planId === 'audio' ? 'audio' : 'video',
        reason: 'Conclua o pagamento do plano antes de iniciar a ligação.',
      });
      return;
    }
    if (config.planId === 'audio') {
      handleGenerateAudioMagicFromParent();
      return;
    }
    setHasCustomConfig(true);
    setPrepareError(null);
    setPreparedMedia(null);
    setCountdownSeconds(10);
    screenRef.current = 'countdown';
    setScreen('countdown');

    void prepareGreetingFromServer(config);

    if (countdownTimerRef.current !== null) {
      window.clearInterval(countdownTimerRef.current);
    }

    const deadlineMs = Date.now() + 10000;
    countdownTimerRef.current = window.setInterval(() => {
      const remainingMs = Math.max(0, deadlineMs - Date.now());
      const remainingSec = Math.ceil(remainingMs / 1000);
      setCountdownSeconds(remainingSec);

      if (remainingMs <= 0) {
        if (countdownTimerRef.current !== null) {
          window.clearInterval(countdownTimerRef.current);
          countdownTimerRef.current = null;
        }
        screenRef.current = 'incoming';
        setScreen('incoming');
      }
    }, 100);
  };

  const handleCancelCountdown = () => {
    if (countdownTimerRef.current !== null) {
      window.clearInterval(countdownTimerRef.current);
      countdownTimerRef.current = null;
    }
    setScreen('parent');
  };

  const handleAcceptIncomingCall = () => {
    unlockAudioContext();

    [
      helloVideoRef.current,
      listeningVideoRef.current,
      talkingVideoRef.current,
      goodbyeVideoRef.current,
    ].forEach((videoEl) => {
      if (videoEl) {
        videoEl.muted = true;
        videoEl.playsInline = true;
        videoEl.play().catch(() => undefined);
      }
    });

    screenRef.current = 'call';
    setScreen('call');

    void requestFrontCameraStream();
  };

  const handleDeclineIncomingCall = () => {
    screenRef.current = 'home';
    stopCurrentSantaVoice();
    stopCameraStream();
    setScreen('home');
  };

  const handleCallEnded = useCallback(() => {
    screenRef.current = 'ended';
    stopCurrentSantaVoice();
    stopCameraStream();
    setScreen('ended');
  }, [stopCameraStream]);

  const handleUpgradeToFamilyPass = () => {
    setConfig((prev) => ({...prev, planId: 'familia'}));
    setPrepareError(null);
    setScreen('parent');
  };

  useEffect(() => {
    return () => {
      if (countdownTimerRef.current !== null) {
        window.clearInterval(countdownTimerRef.current);
      }
      stopCameraStream();
    };
  }, [stopCameraStream]);

  const isCallStageMounted =
    Boolean(entitlementToken) &&
    config.planId !== 'audio' &&
    (screen === 'incoming' || screen === 'call');
  const shareOrigin =
    publicAppUrl || (typeof window !== 'undefined' ? window.location.origin : '');
  const shareUrl = appendRefQuery(shareOrigin, parentProfile?.parentId);
  const shareDomainLabel = (() => {
    try {
      return new URL(shareUrl).hostname;
    } catch {
      return typeof window !== 'undefined' ? window.location.hostname : 'Polo Norte';
    }
  })();
  const whatsappMessage = encodeURIComponent(
    `Olha que emocionante! Acabamos de fazer uma chamada de vídeo ao vivo com o Papai Noel falando o nome da nossa criança em ${shareDomainLabel}! Vale muito a pena testar com os pequenos: ${shareUrl}`
  );
  const whatsappHref = `https://wa.me/?text=${whatsappMessage}`;

  const referralShareUrl = parentProfile
    ? appendRefQuery(shareOrigin, parentProfile.parentId)
    : shareOrigin;
  const referralWhatsappHref = `https://wa.me/?text=${encodeURIComponent(
    `Crie uma ligação de vídeo ou Áudio Mágico personalizado do Papai Noel para as crianças em ${shareDomainLabel}: ${referralShareUrl}`
  )}`;

  const checkoutPlan =
    PLANS.find((p) => p.id === checkoutGate?.config.planId) || PLANS[3];
  const checkoutAsaasUrl = checkoutGate ? asaasLinks[checkoutGate.config.planId] : null;

  const canUseDebugMode = import.meta.env.DEV || Boolean(debugStatus?.debugActive);

  return (
    <div className="min-h-[100dvh] bg-[#0B0C10] text-[#F7F4EC] relative overflow-x-hidden">
      <SnowfallBackground />
      <OfflineIndicator />

      {debugModeActive && (
        <div
          role="status"
          className="fixed top-2 left-1/2 -translate-x-1/2 z-[60] pointer-events-none px-3.5 py-1 rounded-full bg-red-600/95 border border-red-300 text-white text-[11px] font-extrabold uppercase tracking-wider shadow-[0_4px_18px_rgba(220,38,38,0.6)]"
        >
          MODO DEBUG ATIVO
        </div>
      )}

      {!isCallStageMounted && config.planId !== 'audio' && (
        <div
          aria-hidden="true"
          className="fixed w-px h-px opacity-0 pointer-events-none overflow-hidden -z-10"
        >
          <video src="/videos/santa-hello.mp4" preload="auto" muted playsInline />
          <video src="/videos/santa-listening.mp4" preload="auto" muted playsInline />
          <video src="/videos/santa-talking.mp4" preload="auto" muted playsInline />
          <video src="/videos/santa-goodbye.mp4" preload="auto" muted playsInline />
        </div>
      )}

      {/* Payment Verification / Token Validation Overlay */}
      {isConfirmingPayment && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/80 backdrop-blur-md p-4">
          <div className="w-full max-w-sm rounded-3xl border border-[#D4AF37]/40 bg-[#13151C] p-6 text-center space-y-4 shadow-2xl">
            <Loader2 className="w-8 h-8 animate-spin text-[#D4AF37] mx-auto" aria-hidden="true" />
            <p className="text-sm font-medium text-[#F5D97E]">
              Validando confirmação mágica de pagamento...
            </p>
          </div>
        </div>
      )}

      {/* Payment Error Notice */}
      {paymentConfirmError && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/80 backdrop-blur-md p-4">
          <div className="w-full max-w-md rounded-3xl border border-amber-400/45 bg-[#13151C] p-6 space-y-4 text-center shadow-2xl">
            <Lock className="w-8 h-8 text-[#D4AF37] mx-auto" aria-hidden="true" />
            <h2
              className="text-xl font-semibold text-[#F7F4EC]"
              style={{fontFamily: 'var(--font-display)'}}
            >
              Confirmação de Pagamento Pendente
            </h2>
            <p className="text-sm text-[#C7C2B6] leading-relaxed">{paymentConfirmError}</p>
            <div className="flex flex-col sm:flex-row gap-2.5">
              <button
                type="button"
                onClick={() => {
                  setPaymentConfirmError(null);
                  setScreen('parent');
                }}
                className="flex-1 min-h-[46px] px-4 rounded-xl bg-[#D4AF37] text-[#0B0C10] font-bold text-sm cursor-pointer hover:bg-[#E5C454]"
              >
                Ir para Área dos Pais
              </button>
              <button
                type="button"
                onClick={() => setPaymentConfirmError(null)}
                className="flex-1 min-h-[46px] px-4 rounded-xl border border-white/15 text-sm text-[#E5E7EB] cursor-pointer hover:bg-white/5"
              >
                Fechar
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Checkout Gate Card when Link has NO valid HMAC token */}
      {checkoutGate && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/85 backdrop-blur-md p-4"
          role="dialog"
          aria-modal="true"
          aria-labelledby="checkout-gate-title"
        >
          <div className="w-full max-w-md rounded-3xl border-2 border-[#D4AF37]/60 bg-[#13151C] p-6 sm:p-7 space-y-5 shadow-2xl text-center">
            <div className="w-14 h-14 mx-auto rounded-full bg-[#D4AF37]/15 border border-[#D4AF37]/50 flex items-center justify-center text-[#F5D97E]">
              <CreditCard className="w-7 h-7" aria-hidden="true" />
            </div>

            <div className="space-y-2">
              <h2
                id="checkout-gate-title"
                className="text-xl sm:text-2xl font-semibold text-[#F7F4EC]"
                style={{fontFamily: 'var(--font-display)'}}
              >
                Libere a Magia para {checkoutGate.config.childName || 'Sua Criança'}
              </h2>
              <p className="text-sm text-[#C7C2B6] leading-relaxed">{checkoutGate.reason}</p>
            </div>

            <div className="rounded-2xl border border-white/10 bg-[#0B0C10] p-4 flex items-center justify-between text-left">
              <div>
                <p className="text-sm font-semibold text-[#F7F4EC]">{checkoutPlan.title}</p>
                <p className="text-xs text-[#A8A396]">{checkoutPlan.summary}</p>
              </div>
              <span className="text-lg font-bold text-[#F5D97E] tabular-nums shrink-0">
                {checkoutPlan.priceLabel}
              </span>
            </div>

            <div className="space-y-2.5">
              {isSafeHttpUrl(checkoutAsaasUrl) ? (
                <a
                  href={checkoutAsaasUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                  onClick={() => {
                    try {
                      sessionStorage.setItem(
                        PENDING_CHECKOUT_KEY,
                        JSON.stringify({
                          config: checkoutGate.config,
                          ref: referrerId || undefined,
                          savedAt: Date.now(),
                        })
                      );
                    } catch {
                      // Ignore
                    }
                  }}
                  className="w-full min-h-[50px] px-5 rounded-xl bg-[#D4AF37] text-[#0B0C10] font-bold text-sm flex items-center justify-center gap-2 hover:bg-[#E5C454]"
                >
                  <span>Selecionar plano · Pagar {checkoutPlan.priceLabel}</span>
                  <ExternalLink className="w-4 h-4" aria-hidden="true" />
                </a>
              ) : (
                <button
                  type="button"
                  onClick={() => {
                    setConfig(checkoutGate.config);
                    setCheckoutGate(null);
                    setScreen('parent');
                  }}
                  className="w-full min-h-[50px] px-5 rounded-xl bg-[#D4AF37] text-[#0B0C10] font-bold text-sm flex items-center justify-center gap-2 hover:bg-[#E5C454] cursor-pointer"
                >
                  <CreditCard className="w-4 h-4" aria-hidden="true" />
                  <span>Escolher Plano e Pagar</span>
                </button>
              )}

              <button
                type="button"
                onClick={() => {
                  setCheckoutGate(null);
                  setScreen('home');
                }}
                className="w-full min-h-[42px] px-4 rounded-xl border border-white/15 text-xs font-medium text-[#D1D5DB] hover:bg-white/5 cursor-pointer"
              >
                Voltar ao Início
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Post-Payment Quick Parent Registration Modal */}
      {showPostPayRegister && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/80 backdrop-blur-md p-4"
          role="dialog"
          aria-modal="true"
          aria-labelledby="postpay-register-title"
        >
          <form
            onSubmit={handleSubmitParentRegistration}
            className="w-full max-w-md rounded-3xl border border-[#D4AF37]/45 bg-[#13151C] p-6 sm:p-7 space-y-4 shadow-2xl"
          >
            <div className="flex items-start justify-between gap-3">
              <div className="space-y-1">
                <span className="inline-flex items-center gap-1.5 text-[11px] font-bold uppercase tracking-wider text-emerald-300">
                  <CheckCircle2 className="w-3.5 h-3.5" aria-hidden="true" />
                  Pagamento Confirmado
                </span>
                <h2
                  id="postpay-register-title"
                  className="text-xl font-semibold text-[#F7F4EC]"
                  style={{fontFamily: 'var(--font-display)'}}
                >
                  Cadastro Rápido do Responsável
                </h2>
              </div>
              <button
                type="button"
                onClick={() => setShowPostPayRegister(false)}
                aria-label="Fechar cadastro"
                className="p-2 rounded-lg text-[#9CA3AF] hover:text-white hover:bg-white/5 cursor-pointer"
              >
                <X className="w-4 h-4" />
              </button>
            </div>

            <p className="text-xs sm:text-sm text-[#C7C2B6] leading-relaxed">
              Salve seus dados para liberar seu link de indicação (5 amigos = 1 chamada grátis) e
              acessar suas magias depois.
            </p>

            {regError && (
              <div className="rounded-xl border border-red-400/40 bg-red-950/60 px-3.5 py-2.5 text-xs text-red-100">
                {regError}
              </div>
            )}

            <div className="space-y-3">
              <div className="space-y-1">
                <label htmlFor="reg-name" className="block text-xs font-medium text-[#E5E0D4]">
                  Seu nome
                </label>
                <input
                  id="reg-name"
                  type="text"
                  required
                  value={regName}
                  onChange={(e) => setRegName(e.target.value)}
                  placeholder="Ex: Ana Paula"
                  className="w-full min-h-[44px] px-3.5 rounded-xl bg-[#0B0C10] border border-white/15 text-sm text-white focus:outline-none focus:border-[#D4AF37]"
                />
              </div>

              <div className="space-y-1">
                <label htmlFor="reg-phone" className="block text-xs font-medium text-[#E5E0D4]">
                  Telefone / WhatsApp
                </label>
                <input
                  id="reg-phone"
                  type="tel"
                  required
                  value={regPhone}
                  onChange={(e) => setRegPhone(e.target.value)}
                  placeholder="(11) 99999-9999"
                  className="w-full min-h-[44px] px-3.5 rounded-xl bg-[#0B0C10] border border-white/15 text-sm text-white focus:outline-none focus:border-[#D4AF37]"
                />
              </div>

              <div className="space-y-1">
                <label htmlFor="reg-email" className="block text-xs font-medium text-[#E5E0D4]">
                  E-mail
                </label>
                <input
                  id="reg-email"
                  type="email"
                  required
                  value={regEmail}
                  onChange={(e) => setRegEmail(e.target.value)}
                  placeholder="voce@exemplo.com"
                  className="w-full min-h-[44px] px-3.5 rounded-xl bg-[#0B0C10] border border-white/15 text-sm text-white focus:outline-none focus:border-[#D4AF37]"
                />
              </div>
            </div>

            <div className="flex flex-col sm:flex-row gap-2.5 pt-1">
              <button
                type="submit"
                disabled={isRegisteringParent}
                className="flex-1 min-h-[46px] px-4 rounded-xl bg-[#D4AF37] text-[#0B0C10] font-bold text-sm flex items-center justify-center gap-2 hover:bg-[#E5C454] cursor-pointer disabled:opacity-60"
              >
                {isRegisteringParent ? (
                  <>
                    <Loader2 className="w-4 h-4 animate-spin" aria-hidden="true" />
                    <span>Salvando...</span>
                  </>
                ) : (
                  <>
                    <UserCheck className="w-4 h-4" aria-hidden="true" />
                    <span>Salvar e Continuar</span>
                  </>
                )}
              </button>
              <button
                type="button"
                onClick={() => setShowPostPayRegister(false)}
                className="min-h-[46px] px-4 rounded-xl border border-white/15 text-xs font-medium text-[#D1D5DB] hover:bg-white/5 cursor-pointer"
              >
                Depois
              </button>
            </div>
          </form>
        </div>
      )}

      {screen === 'home' && (
        <>
          <HomeScreen
            config={config}
            hasCustomConfig={hasCustomConfig}
            onUnlockParent={() => {
              setPrepareError(null);
              setScreen('parent');
            }}
            onOpenDebugPanel={() => {
              setPrepareError(null);
              setScreen('debug-panel');
            }}
            onStartPreparedCall={handleStartDirectFromHome}
            isPreparingCall={isPreparingCall}
            prepareError={prepareError}
          />

          {/* Quick "Minhas magias" & Referral Bar on Home */}
          <section className="relative z-10 w-full max-w-6xl mx-auto px-4 sm:px-8 pt-2 pb-4">
            <div className="rounded-2xl border border-[#D4AF37]/30 bg-[#13151C]/90 backdrop-blur-md px-5 py-4 flex flex-col sm:flex-row items-center justify-between gap-3">
              <div className="flex items-center gap-3 text-center sm:text-left">
                <FolderHeart className="w-5 h-5 text-[#D4AF37] shrink-0" aria-hidden="true" />
                <div>
                  <p className="text-sm font-semibold text-[#F7F4EC]">
                    Minhas magias &amp; Indicações
                  </p>
                  <p className="text-xs text-[#A8A396]">
                    {parentProfile
                      ? `${parentProfile.conversions} indicações pagas · ${parentProfile.availableCredits} crédito(s) grátis`
                      : 'Indique 5 famílias e ganhe 1 chamada grátis de 60s'}
                  </p>
                </div>
              </div>
              <button
                type="button"
                onClick={() => setScreen('my-magics')}
                className="min-h-[42px] px-5 rounded-xl border border-[#D4AF37]/50 bg-[#1B1E28] text-xs sm:text-sm font-semibold text-[#F5D97E] hover:bg-[#242836] transition-colors cursor-pointer shrink-0"
              >
                Abrir Minhas magias
              </button>
            </div>
          </section>

          <section
            aria-labelledby="faq-home-heading"
            className="relative z-10 w-full max-w-6xl mx-auto px-4 sm:px-8 pt-4 pb-14"
          >
            <div className="rounded-3xl border border-white/10 bg-[#13151C]/90 backdrop-blur-md p-6 sm:p-8 space-y-5 shadow-2xl">
              <div className="space-y-1">
                <h2
                  id="faq-home-heading"
                  className="text-xl sm:text-2xl font-semibold text-[#F7F4EC]"
                  style={{fontFamily: 'var(--font-display)'}}
                >
                  Perguntas Frequentes
                </h2>
                <p className="text-xs sm:text-sm text-[#A8A396]">
                  Tire suas dúvidas sobre a ligação de vídeo do Papai Noel personalizada e o Áudio
                  Mágico.
                </p>
              </div>

              <div className="divide-y divide-white/10">
                {HOME_FAQ_ITEMS.map((item) => (
                  <details key={item.question} className="group py-3.5">
                    <summary className="list-none flex items-center justify-between gap-4 cursor-pointer text-sm sm:text-base font-semibold text-[#F7F4EC] hover:text-[#F5D97E] transition-colors">
                      <span>{item.question}</span>
                      <ChevronDown
                        className="w-4 h-4 text-[#D4AF37] shrink-0 transition-transform duration-200 group-open:rotate-180"
                        aria-hidden="true"
                      />
                    </summary>
                    <p className="mt-2.5 text-xs sm:text-sm text-[#C7C2B6] leading-relaxed pr-6">
                      {item.answer}
                    </p>
                  </details>
                ))}
              </div>
            </div>
          </section>
        </>
      )}

      {screen === 'my-magics' && (
        <div className="relative z-10 min-h-[100dvh] px-4 sm:px-8 py-6">
          <div className="max-w-3xl mx-auto space-y-6">
            <header className="flex items-center justify-between">
              <button
                type="button"
                onClick={() => setScreen('home')}
                className="min-h-[44px] px-3 -ml-2 rounded-xl flex items-center gap-2 text-sm font-medium text-[#D1D5DB] hover:text-white hover:bg-white/5 cursor-pointer"
              >
                <Home className="w-4 h-4" aria-hidden="true" />
                <span>Início</span>
              </button>
              <h1
                className="text-xl font-semibold text-[#F5D97E]"
                style={{fontFamily: 'var(--font-display)'}}
              >
                Minhas magias
              </h1>
              <button
                type="button"
                onClick={() => setScreen('parent')}
                className="min-h-[40px] px-3.5 rounded-xl bg-[#D4AF37] text-[#0B0C10] text-xs font-bold cursor-pointer hover:bg-[#E5C454]"
              >
                Nova Magia
              </button>
            </header>

            {/* Referral & Free Call Credit Card */}
            <section className="rounded-3xl border border-[#D4AF37]/45 bg-[#13151C]/95 p-6 space-y-5 shadow-2xl">
              <div className="flex items-start justify-between gap-4">
                <div className="space-y-1">
                  <span className="inline-flex items-center gap-1.5 text-xs font-bold uppercase tracking-wider text-[#D4AF37]">
                    <Gift className="w-4 h-4" aria-hidden="true" />
                    Indique e Ganhe · 5 = 1 Chamada Grátis
                  </span>
                  <h2
                    className="text-xl font-semibold text-[#F7F4EC]"
                    style={{fontFamily: 'var(--font-display)'}}
                  >
                    {parentProfile
                      ? `Olá, ${parentProfile.name}!`
                      : 'Seu Painel de Créditos e Indicações'}
                  </h2>
                </div>
                {parentProfile && (
                  <span className="px-3 py-1 rounded-lg bg-[#D4AF37]/15 border border-[#D4AF37]/40 text-xs font-bold text-[#F5D97E] tabular-nums shrink-0">
                    {parentProfile.availableCredits} crédito(s)
                  </span>
                )}
              </div>

              {parentProfile ? (
                <>
                  <div className="grid grid-cols-1 sm:grid-cols-3 gap-3 text-center">
                    <div className="rounded-2xl bg-[#0B0C10] border border-white/10 p-3.5">
                      <p className="text-2xl font-bold text-[#F7F4EC] tabular-nums">
                        {parentProfile.conversions}
                      </p>
                      <p className="text-xs text-[#A8A396]">Indicações pagas</p>
                    </div>
                    <div className="rounded-2xl bg-[#0B0C10] border border-white/10 p-3.5">
                      <p className="text-2xl font-bold text-emerald-400 tabular-nums">
                        {parentProfile.availableCredits}
                      </p>
                      <p className="text-xs text-[#A8A396]">Créditos de chamada grátis</p>
                    </div>
                    <div className="rounded-2xl bg-[#0B0C10] border border-white/10 p-3.5">
                      <p className="text-2xl font-bold text-[#F5D97E] tabular-nums">
                        {parentProfile.neededForNextCredit}
                      </p>
                      <p className="text-xs text-[#A8A396]">Faltam para próximo crédito</p>
                    </div>
                  </div>

                  {/* Progress Bar */}
                  <div className="space-y-1.5">
                    <div className="flex justify-between text-xs text-[#C7C2B6]">
                      <span>Progresso para chamada grátis</span>
                      <span className="tabular-nums font-semibold">
                        {parentProfile.conversions % 5 === 0 && parentProfile.conversions > 0
                          ? 5
                          : parentProfile.conversions % 5}
                        /5
                      </span>
                    </div>
                    <div className="h-2.5 rounded-full bg-[#0B0C10] overflow-hidden border border-white/10">
                      <div
                        className="h-full bg-gradient-to-r from-[#D4AF37] to-emerald-400 transition-all"
                        style={{
                          width: `${
                            parentProfile.conversions > 0 && parentProfile.conversions % 5 === 0
                              ? 100
                              : (parentProfile.conversions % 5) * 20
                          }%`,
                        }}
                      />
                    </div>
                  </div>

                  {redeemError && <p className="text-xs text-red-400">{redeemError}</p>}

                  {parentProfile.availableCredits > 0 && (
                    <button
                      type="button"
                      onClick={() => void handleRedeemFreeCredit()}
                      disabled={isRedeemingCredit}
                      className="w-full min-h-[48px] px-5 rounded-xl bg-emerald-500 text-[#0B0C10] font-bold text-sm flex items-center justify-center gap-2 hover:bg-emerald-400 cursor-pointer disabled:opacity-60"
                    >
                      {isRedeemingCredit ? (
                        <Loader2 className="w-4 h-4 animate-spin" aria-hidden="true" />
                      ) : (
                        <Sparkles className="w-4 h-4" aria-hidden="true" />
                      )}
                      <span>Resgatar 1 Chamada Grátis (60s) Agora</span>
                    </button>
                  )}

                  <div className="rounded-2xl bg-[#0B0C10] border border-white/10 p-4 space-y-3">
                    <p className="text-xs font-semibold text-[#F5D97E]">
                      Seu link de indicação (?ref={parentProfile.parentId}):
                    </p>
                    <div className="flex flex-col sm:flex-row gap-2">
                      <input
                        type="text"
                        readOnly
                        value={referralShareUrl}
                        aria-label="Link de indicação"
                        className="flex-1 min-h-[42px] px-3 rounded-lg bg-[#13151C] border border-white/10 text-xs font-mono text-[#E5E7EB]"
                      />
                      <button
                        type="button"
                        onClick={() => {
                          void navigator.clipboard.writeText(referralShareUrl).then(() => {
                            setCopiedRefLink(true);
                            window.setTimeout(() => setCopiedRefLink(false), 2200);
                          });
                        }}
                        className="min-h-[42px] px-4 rounded-lg bg-[#D4AF37] text-[#0B0C10] text-xs font-bold flex items-center justify-center gap-1.5 cursor-pointer"
                      >
                        <Copy className="w-3.5 h-3.5" aria-hidden="true" />
                        <span>{copiedRefLink ? 'Copiado!' : 'Copiar'}</span>
                      </button>
                      <a
                        href={referralWhatsappHref}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="min-h-[42px] px-4 rounded-lg bg-emerald-600 text-white text-xs font-bold flex items-center justify-center gap-1.5 hover:bg-emerald-500"
                      >
                        <Share2 className="w-3.5 h-3.5" aria-hidden="true" />
                        <span>WhatsApp</span>
                      </a>
                    </div>
                  </div>
                </>
              ) : (
                <div className="rounded-2xl bg-[#0B0C10]/85 border border-white/10 p-4 space-y-3">
                  <p className="text-sm text-[#C7C2B6] leading-relaxed">
                    Após adquirir qualquer plano (a partir de R$ 4,90), preencha seu cadastro rápido
                    para gerar seu código exclusivo de indicação. A cada 5 amigos que comprarem pelo
                    seu link, você ganha 1 chamada grátis de 60s!
                  </p>
                  {entitlementToken ? (
                    <button
                      type="button"
                      onClick={() => setShowPostPayRegister(true)}
                      className="min-h-[44px] px-5 rounded-xl bg-[#D4AF37] text-[#0B0C10] font-bold text-xs cursor-pointer hover:bg-[#E5C454]"
                    >
                      Completar Meu Cadastro Agora
                    </button>
                  ) : (
                    <button
                      type="button"
                      onClick={() => setScreen('parent')}
                      className="min-h-[44px] px-5 rounded-xl bg-[#D4AF37] text-[#0B0C10] font-bold text-xs cursor-pointer hover:bg-[#E5C454]"
                    >
                      Escolher um Plano
                    </button>
                  )}
                </div>
              )}
            </section>

            {/* Saved Magics List */}
            <section className="rounded-3xl border border-white/10 bg-[#13151C]/95 p-6 space-y-4">
              <h2
                className="text-lg font-semibold text-[#F7F4EC]"
                style={{fontFamily: 'var(--font-display)'}}
              >
                Magias Salvas neste Dispositivo ({savedMagics.length})
              </h2>
              {savedMagics.length === 0 ? (
                <p className="text-sm text-[#A8A396]">
                  Nenhuma magia gerada ainda. Ao criar um Áudio Mágico ou Link Mágico de Chamada,
                  ele aparecerá aqui para você abrir ou compartilhar quando quiser.
                </p>
              ) : (
                <div className="space-y-3">
                  {savedMagics.map((magic) => {
                    const finalMagicUrl = appendRefQuery(magic.shareUrl, parentProfile?.parentId);
                    return (
                      <div
                        key={magic.id}
                        className="rounded-2xl border border-white/10 bg-[#0B0C10] p-4 flex flex-col sm:flex-row sm:items-center justify-between gap-3"
                      >
                        <div className="space-y-1 min-w-0">
                          <div className="flex items-center gap-2">
                            <span className="text-xs font-bold uppercase px-2 py-0.5 rounded bg-[#D4AF37]/20 text-[#F5D97E]">
                              {magic.type === 'audio' ? 'Áudio Mágico' : `Vídeo (${magic.planId})`}
                            </span>
                            <span className="text-sm font-semibold text-[#F7F4EC] truncate">
                              Para {magic.childName}
                            </span>
                          </div>
                          <p className="text-[11px] text-[#8D887C]">
                            Criado em {new Date(magic.createdAt).toLocaleString('pt-BR')}
                          </p>
                        </div>

                        <div className="flex flex-wrap items-center gap-2 shrink-0">
                          <a
                            href={finalMagicUrl}
                            className="min-h-[38px] px-3.5 rounded-lg bg-[#D4AF37] text-[#0B0C10] text-xs font-bold flex items-center gap-1.5 hover:bg-[#E5C454]"
                          >
                            <span>Abrir</span>
                            <ExternalLink className="w-3.5 h-3.5" aria-hidden="true" />
                          </a>
                          <a
                            href={`https://wa.me/?text=${encodeURIComponent(
                              `Olha a magia do Papai Noel para ${magic.childName} em ${shareDomainLabel}: ${finalMagicUrl}`
                            )}`}
                            target="_blank"
                            rel="noopener noreferrer"
                            className="min-h-[38px] px-3.5 rounded-lg bg-emerald-600 text-white text-xs font-semibold flex items-center gap-1.5 hover:bg-emerald-500"
                          >
                            <Share2 className="w-3.5 h-3.5" aria-hidden="true" />
                            <span>WhatsApp</span>
                          </a>
                        </div>
                      </div>
                    );
                  })}
                </div>
              )}
            </section>
          </div>
        </div>
      )}

      {screen === 'debug-panel' && (
        <DebugPanel
          onBack={() => {
            stopCurrentSantaVoice();
            setScreen('home');
          }}
        />
      )}

      {screen === 'parent' && (
        <ParentPanel
          config={config}
          onChange={handleConfigChange}
          onBack={() => setScreen('home')}
          onStartCountdown={handleStartCountdownFromParent}
          onGenerateAudioMagic={handleGenerateAudioMagicFromParent}
          isGeneratingAudio={isGeneratingAudioMagic}
          error={prepareError}
          asaasLinks={asaasLinks}
          entitlementToken={entitlementToken}
          paidPlanId={paidPlanId}
          parentId={parentProfile?.parentId}
          referrerId={referrerId}
          onOpenMyMagics={() => setScreen('my-magics')}
          onMagicLinkCreated={appendSavedMagic}
          canUseDebugMode={canUseDebugMode}
          debugModeActive={debugModeActive}
          isTogglingDebug={isTogglingDebug}
          debugMissingEnvVars={debugStatus?.missingEnvVars || []}
          debugError={debugError}
          onToggleDebugMode={(enable) => {
            void handleToggleDebugMode(enable);
          }}
        />
      )}

      {screen === 'audio-magic' && (
        <AudioMagicScreen
          config={config}
          audioMedia={audioMagicMedia}
          isLoading={isGeneratingAudioMagic}
          error={audioMagicError}
          publicAppUrl={publicAppUrl}
          parentId={parentProfile?.parentId}
          onRetry={() => {
            void generateAudioMagicFromServer(config, audioMagicPresetTextRef.current);
          }}
          onSilentRetry={() => {
            void generateAudioMagicFromServer(config, audioMagicPresetTextRef.current, undefined, {
              silent: true,
            });
          }}
          onUpgradeToVideoCall={() => {
            setConfig((prev) => ({...prev, planId: '15s'}));
            setPrepareError(null);
            screenRef.current = 'parent';
            setScreen('parent');
          }}
          onOpenMyMagics={() => {
            screenRef.current = 'my-magics';
            setScreen('my-magics');
          }}
          onBackHome={() => {
            screenRef.current = 'home';
            setScreen('home');
          }}
        />
      )}

      {screen === 'countdown' && (
        <div className="fixed inset-0 z-40 flex flex-col items-center justify-center px-6 text-center bg-[#0B0C10]/95 backdrop-blur-md">
          <div className="w-full max-w-sm rounded-3xl border border-[#D4AF37]/35 bg-[#13151C] p-8 space-y-6 shadow-2xl">
            <p className="text-xs font-medium tracking-widest uppercase text-[#D4AF37]">
              Entregue o celular para {config.childName}
            </p>
            <div
              className="text-7xl font-semibold text-[#F5D97E] tabular-nums"
              style={{fontFamily: 'var(--font-mono)'}}
            >
              {countdownSeconds}s
            </div>
            <p className="text-sm text-[#C7C2B6] leading-relaxed">
              {isPreparingCall
                ? 'O Papai Noel está lendo a cartinha e preparando a ligação...'
                : 'Tudo pronto! O telefone vai tocar em instantes.'}
            </p>
            <button
              type="button"
              onClick={handleCancelCountdown}
              className="w-full min-h-[46px] rounded-xl border border-white/15 text-sm font-medium text-[#D1D5DB] hover:bg-white/5 cursor-pointer"
            >
              Cancelar
            </button>
          </div>
        </div>
      )}

      {isCallStageMounted && (
        <VideoCallScreen
          config={config}
          preparedMedia={preparedMedia}
          entitlementToken={entitlementToken}
          isCallActive={screen === 'call'}
          isPreparingCall={isPreparingCall}
          prepareError={prepareError}
          onRetryGreeting={() => {
            void prepareGreetingFromServer(config);
          }}
          onRequestCameraStream={requestFrontCameraStream}
          helloVideoRef={helloVideoRef}
          listeningVideoRef={listeningVideoRef}
          talkingVideoRef={talkingVideoRef}
          goodbyeVideoRef={goodbyeVideoRef}
          frontCameraStream={frontCameraStream}
          onCallEnded={handleCallEnded}
        />
      )}

      {screen === 'incoming' && (
        <IncomingCallScreen
          config={config}
          isPrepared={!!preparedMedia}
          onAccept={handleAcceptIncomingCall}
          onDecline={handleDeclineIncomingCall}
        />
      )}

      {screen === 'ended' && (
        <div className="relative z-20 min-h-[100dvh] flex items-center justify-center px-5 py-8">
          <div className="w-full max-w-md rounded-3xl border border-[#D4AF37]/35 bg-[#13151C]/95 backdrop-blur-xl p-7 sm:p-8 text-center space-y-6 shadow-2xl">
            <div className="w-16 h-16 mx-auto rounded-full bg-emerald-500/15 border border-emerald-400/40 flex items-center justify-center text-emerald-300">
              <CheckCircle2 className="w-8 h-8" aria-hidden="true" />
            </div>

            <div className="space-y-2">
              <h2
                className="text-2xl sm:text-3xl font-semibold text-[#F7F4EC]"
                style={{fontFamily: 'var(--font-display)'}}
              >
                Feliz Natal, {config.childName || 'pequeno amigo'}!
              </h2>
              <p className="text-sm text-[#C7C2B6] leading-relaxed">
                O Papai Noel desligou porque {getFarewellSummaryText(config.farewellType)}
              </p>
            </div>

            {config.planId !== 'familia' ? (
              <div className="rounded-2xl border border-[#D4AF37]/45 bg-gradient-to-br from-[#241D0F] via-[#191B24] to-[#13151C] p-5 text-left space-y-3.5 shadow-lg">
                <div className="flex items-center gap-2 text-xs font-bold uppercase tracking-wider text-[#F5D97E]">
                  <Crown className="w-4 h-4 text-[#D4AF37] shrink-0" aria-hidden="true" />
                  <span>Oferta Especial Passe Família</span>
                </div>
                <p className="text-sm text-[#EFE9D8] leading-relaxed">
                  Quer ligar novamente ou chamar outro irmão/primo? Libere o{' '}
                  <strong className="text-[#F5D97E]">Passe Família Ilimitado</strong> com desconto
                  agora!
                </p>
                <button
                  type="button"
                  onClick={handleUpgradeToFamilyPass}
                  className="w-full min-h-[48px] px-4 rounded-xl bg-gradient-to-r from-[#D4AF37] to-[#F0CE69] text-[#0B0C10] font-bold text-sm flex items-center justify-center gap-2 hover:brightness-105 active:scale-[0.98] transition-all cursor-pointer"
                >
                  <Crown className="w-4 h-4" aria-hidden="true" />
                  <span>Liberar Passe Família Ilimitado</span>
                </button>
              </div>
            ) : (
              <div className="rounded-2xl border border-[#D4AF37]/30 bg-[#191B24]/80 p-4 text-left space-y-1.5">
                <div className="flex items-center gap-2 text-xs font-semibold uppercase tracking-wider text-[#F5D97E]">
                  <Crown className="w-4 h-4 text-[#D4AF37] shrink-0" aria-hidden="true" />
                  <span>Passe Família Ilimitado Ativo</span>
                </div>
                <p className="text-xs text-[#C7C2B6] leading-relaxed">
                  Você pode personalizar novas ligações para outros irmãos, primos e sobrinhos
                  quantas vezes quiser até o Natal.
                </p>
              </div>
            )}

            <a
              href={whatsappHref}
              target="_blank"
              rel="noopener noreferrer"
              className="w-full min-h-[50px] px-5 rounded-xl bg-emerald-600 hover:bg-emerald-500 active:scale-[0.98] text-white font-semibold text-sm flex items-center justify-center gap-2.5 shadow-[0_10px_28px_rgba(16,185,129,0.3)] transition-all"
            >
              <Share2 className="w-4 h-4" aria-hidden="true" />
              <span>Compartilhar Magia no WhatsApp</span>
            </a>

            <div className="flex flex-col sm:flex-row gap-3">
              <button
                type="button"
                onClick={handleStartDirectFromHome}
                className="flex-1 min-h-[48px] px-5 rounded-xl bg-[#D4AF37] text-[#0B0C10] font-semibold text-sm flex items-center justify-center gap-2 hover:bg-[#E5C454] cursor-pointer"
              >
                <RotateCcw className="w-4 h-4" aria-hidden="true" />
                <span>Ligar Novamente</span>
              </button>
              <button
                type="button"
                onClick={() => setScreen('home')}
                className="flex-1 min-h-[48px] px-5 rounded-xl border border-white/15 text-sm font-medium text-[#E5E7EB] flex items-center justify-center gap-2 hover:bg-white/5 cursor-pointer"
              >
                <Home className="w-4 h-4" aria-hidden="true" />
                <span>Início</span>
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
