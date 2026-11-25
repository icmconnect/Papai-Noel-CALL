import {useCallback, useEffect, useRef, useState} from 'react';
import {CheckCircle2, Crown, Home, RotateCcw, Share2} from 'lucide-react';
import {DebugPanel} from './components/DebugPanel';
import {HomeScreen} from './components/HomeScreen';
import {IncomingCallScreen} from './components/IncomingCallScreen';
import {OfflineIndicator} from './components/OfflineIndicator';
import {ParentPanel} from './components/ParentPanel';
import {SnowfallBackground} from './components/SnowfallBackground';
import {VideoCallScreen} from './components/VideoCallScreen';
import {AppScreen, CallConfig, FarewellType, PlanId, PreparedCallMedia} from './types';
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

function decodeMagicConfigFromUrl(): CallConfig | null {
  if (typeof window === 'undefined') return null;
  const params = new URLSearchParams(window.location.search);
  const raw = params.get('chamada');
  if (!raw) return null;

  try {
    const base64 = raw.replace(/-/g, '+').replace(/_/g, '/');
    const pad = base64.length % 4 ? '='.repeat(4 - (base64.length % 4)) : '';
    const json = decodeURIComponent(
      Array.prototype.map
        .call(window.atob(base64 + pad), (c: string) => '%' + ('00' + c.charCodeAt(0).toString(16)).slice(-2))
        .join('')
    );
    const parsed = JSON.parse(json) as Partial<CallConfig>;
    if (!parsed.childName) return null;
    return {
      ...DEFAULT_CONFIG,
      ...parsed,
    };
  } catch {
    return null;
  }
}

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
  const isDebugRoute = typeof window !== 'undefined' && window.location.pathname === '/debug-call';
  const isDebugTtsRoute = typeof window !== 'undefined' && window.location.pathname === '/debug-tts';

  const [debugName, setDebugName] = useState('Vinicius');
  const [debugTtsLoading, setDebugTtsLoading] = useState(false);
  const [debugTtsResult, setDebugTtsResult] = useState<{success?: boolean; source?: string; text?: string; audioBase64?: string; audioMimeType?: string; useBrowserFallback?: boolean; ttsError?: string} | null>(null);

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
          <h1 className="text-2xl font-bold text-[#F5D97E]" style={{fontFamily: 'var(--font-display)'}}>
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
                <span className={`px-2 py-0.5 rounded text-[10px] font-bold uppercase ${debugTtsResult.source === 'audio-bank' ? 'bg-emerald-500/20 text-emerald-300 border border-emerald-500/30' : 'bg-amber-500/20 text-amber-300 border border-amber-500/30'}`}>
                  Origem: {debugTtsResult.source === 'audio-bank' ? 'Audio Bank (Instantâneo)' : 'TTS (IA)'}
                </span>
              </p>
              <p className="text-[#C7C2B6]">Texto: "{debugTtsResult.text}"</p>
              {debugTtsResult.ttsError && <p className="text-red-400">Erro: {debugTtsResult.ttsError}</p>}
            </div>
          )}
        </div>
      </div>
    );
  }

  const [initialState] = useState(() => {
    if (isDebugRoute) {
      return {
        config: {
          ...DEFAULT_CONFIG,
          childName: 'Teste',
          childAge: '7',
          praise: 'Ajudou a arrumar os brinquedos',
          advice: 'Escovar os dentes sempre',
          planId: 'familia' as PlanId,
        },
        hasCustom: true,
      };
    }
    const fromUrl = decodeMagicConfigFromUrl();
    if (fromUrl) {
      return {config: fromUrl, hasCustom: true};
    }
    return {config: DEFAULT_CONFIG, hasCustom: false};
  });

  const [config, setConfig] = useState<CallConfig>(initialState.config);
  const [hasCustomConfig, setHasCustomConfig] = useState<boolean>(initialState.hasCustom);
  const [screen, setScreen] = useState<AppScreen>(isDebugRoute ? 'call' : 'home');
  const [countdownSeconds, setCountdownSeconds] = useState<number>(10);
  const [preparedMedia, setPreparedMedia] = useState<PreparedCallMedia | null>(null);
  const [isPreparingCall, setIsPreparingCall] = useState<boolean>(false);
  const [prepareError, setPrepareError] = useState<string | null>(null);
  const [frontCameraStream, setFrontCameraStream] = useState<MediaStream | null>(null);

  const helloVideoRef = useRef<HTMLVideoElement | null>(null);
  const listeningVideoRef = useRef<HTMLVideoElement | null>(null);
  const talkingVideoRef = useRef<HTMLVideoElement | null>(null);
  const goodbyeVideoRef = useRef<HTMLVideoElement | null>(null);
  const countdownTimerRef = useRef<number | null>(null);
  const screenRef = useRef<AppScreen>(screen);
  const prepareRequestIdRef = useRef<number>(0);

  useEffect(() => {
    screenRef.current = screen;
  }, [screen]);

  const handleConfigChange = (next: CallConfig) => {
    setConfig(next);
  };

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

  const prepareGreetingFromServer = useCallback(async (targetConfig: CallConfig) => {
    const requestId = ++prepareRequestIdRef.current;
    setIsPreparingCall(true);
    setPrepareError(null);
    setPreparedMedia(null);

    try {
      const res = await fetch('/api/santa/greeting', {
        method: 'POST',
        headers: {'Content-Type': 'application/json'},
        body: JSON.stringify(targetConfig),
      });
      const data = await res.json();
      if (!res.ok) {
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
  }, []);

  // Auto-prepare greeting on debug route mount
  useEffect(() => {
    if (isDebugRoute) {
      void prepareGreetingFromServer(config);
    }
  }, [config, isDebugRoute, prepareGreetingFromServer]);

  const handleStartDirectFromHome = () => {
    void prepareGreetingFromServer(config);
    setScreen('incoming');
  };

  const handleStartCountdownFromParent = () => {
    setHasCustomConfig(true);
    setPrepareError(null);
    setPreparedMedia(null);
    setCountdownSeconds(10);
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

  const isCallStageMounted = screen === 'incoming' || screen === 'call';
  const shareUrl = typeof window !== 'undefined' ? window.location.origin : '';
  const whatsappMessage = encodeURIComponent(
    `Olha que emocionante! Acabamos de fazer uma chamada de vídeo ao vivo com o Papai Noel falando o nome da nossa criança! Vale muito a pena testar com os pequenos: ${shareUrl}`
  );
  const whatsappHref = `https://wa.me/?text=${whatsappMessage}`;

  return (
    <div className="min-h-[100dvh] bg-[#0B0C10] text-[#F7F4EC] relative overflow-x-hidden">
      <SnowfallBackground />
      <OfflineIndicator />

      {!isCallStageMounted && (
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

      {screen === 'home' && (
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
          error={prepareError}
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
