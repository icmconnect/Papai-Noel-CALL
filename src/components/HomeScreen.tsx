import React, {useEffect, useRef, useState} from 'react';
import {
  BookOpenCheck,
  Loader2,
  Lock,
  PhoneCall,
  Settings,
  ShieldCheck,
  Sparkles,
  Star,
  Video,
  X,
} from 'lucide-react';
import {CallConfig, PLANS} from '../types';
import {playMagicBellsSound} from '../utils/audioEngine';
import {PWAInstallButton} from './PWAInstallButton';

interface HomeScreenProps {
  config: CallConfig;
  hasCustomConfig: boolean;
  onUnlockParent: () => void;
  onOpenDebugPanel: () => void;
  onStartPreparedCall: () => void;
  isPreparingCall: boolean;
  prepareError: string | null;
}

interface MathChallenge {
  a: number;
  b: number;
  op: '+' | '×';
  answer: number;
}

function createMathChallenge(): MathChallenge {
  const useMult = Math.random() > 0.4;
  if (useMult) {
    const a = Math.floor(Math.random() * 5) + 5;
    const b = Math.floor(Math.random() * 5) + 4;
    return {a, b, op: '×', answer: a * b};
  }
  const a = Math.floor(Math.random() * 14) + 7;
  const b = Math.floor(Math.random() * 11) + 5;
  return {a, b, op: '+', answer: a + b};
}

export const HomeScreen: React.FC<HomeScreenProps> = ({
  config,
  hasCustomConfig,
  onUnlockParent,
  onOpenDebugPanel,
  onStartPreparedCall,
  isPreparingCall,
  prepareError,
}) => {
  const [challenge, setChallenge] = useState<MathChallenge | null>(null);
  const [mathInput, setMathInput] = useState('');
  const [mathError, setMathError] = useState(false);

  const [listState, setListState] = useState<'idle' | 'checking' | 'confirmed'>('idle');
  const listTimerRef = useRef<number | null>(null);

  useEffect(() => {
    return () => {
      if (listTimerRef.current !== null) {
        window.clearTimeout(listTimerRef.current);
      }
    };
  }, []);

  const handleOpenParentGate = () => {
    setMathInput('');
    setMathError(false);
    setChallenge(createMathChallenge());
  };

  const handleCheckNiceList = () => {
    if (listState === 'checking') return;
    // Play magical Christmas sleigh bells synchronously inside user gesture
    playMagicBellsSound();

    if (listTimerRef.current !== null) {
      window.clearTimeout(listTimerRef.current);
    }
    setListState('checking');
    listTimerRef.current = window.setTimeout(() => {
      setListState('confirmed');
    }, 1600);
  };

  const handleSubmitMath = (e: React.FormEvent) => {
    e.preventDefault();
    if (!challenge) return;
    const parsed = Number(mathInput.trim());
    if (parsed === challenge.answer) {
      setChallenge(null);
      onUnlockParent();
    } else {
      setMathError(true);
    }
  };

  const selectedPlan = PLANS.find((p) => p.id === config.planId) || PLANS[3];
  const hasChildPersonalized = hasCustomConfig && Boolean(config.childName.trim());
  const displayName = config.childName.trim() || 'Pequeno Amigo';

  return (
    <div className="relative min-h-[100dvh] flex flex-col justify-between">
      {/* Live Cinematic Background Video + Blur + Contrast Scrim */}
      <div className="fixed inset-0 z-0 overflow-hidden pointer-events-none" aria-hidden="true">
        <video
          src="/videos/santa-listening.mp4"
          poster="/santa-avatar.png"
          autoPlay
          loop
          muted
          playsInline
          preload="auto"
          className="w-full h-full object-cover scale-105 blur-[3px] opacity-35"
        />
        <div className="absolute inset-0 bg-gradient-to-b from-[#0B0C10]/85 via-[#0B0C10]/65 to-[#0B0C10]/95" />
        <div className="absolute inset-0 bg-[radial-gradient(circle_at_70%_35%,rgba(212,175,55,0.14),transparent_55%)]" />
      </div>

      {/* Top Bar */}
      <header className="relative z-10 w-full max-w-6xl mx-auto px-4 sm:px-8 pt-safe py-3 sm:py-5 flex items-center justify-between gap-3">
        <div className="flex items-center gap-2.5 min-w-0">
          <div className="w-9 h-9 sm:w-10 sm:h-10 rounded-full overflow-hidden border-2 border-[#D4AF37] shadow-[0_0_16px_rgba(212,175,55,0.35)] bg-[#0B0C10] shrink-0">
            <img
              src="/santa-avatar.png"
              alt="Papai Noel"
              className="w-full h-full object-cover"
            />
          </div>
          <span
            className="text-sm sm:text-xl font-semibold tracking-tight text-[#F7F4EC] truncate"
            style={{fontFamily: 'var(--font-display)'}}
          >
            Portal Mágico do Polo Norte
          </span>
        </div>
        <div className="shrink-0 flex items-center gap-2.5">
          <PWAInstallButton />
          <button
            type="button"
            onClick={onOpenDebugPanel}
            aria-label="Abrir painel de diagnóstico de voz"
            title="Testar Voz do Papai Noel (Debug)"
            className="w-10 h-10 rounded-xl border border-[#D4AF37]/30 bg-[#13151C]/85 backdrop-blur-md text-[#D4AF37] hover:text-[#F5D97E] hover:border-[#D4AF37] hover:bg-[#1B1E28] flex items-center justify-center transition-colors cursor-pointer shadow-md"
          >
            <Settings className="w-4 h-4" aria-hidden="true" />
          </button>
        </div>
      </header>

      {/* Main Hero Canvas */}
      <main className="relative z-10 w-full max-w-6xl mx-auto px-4 sm:px-8 py-2 sm:py-8 flex-1 flex items-center">
        <div className="w-full grid grid-cols-1 lg:grid-cols-12 gap-4 sm:gap-8 lg:gap-12 items-center">
          {/* Featured Live Avatar Column (Glassmorphism card + realistic photo with golden ring) */}
          <div className="lg:col-span-5 lg:order-2 flex flex-col items-center">
            <div className="w-full max-w-md rounded-2xl sm:rounded-3xl border border-white/10 bg-white/5 backdrop-blur-md p-5 sm:p-8 shadow-[0_24px_64px_rgba(0,0,0,0.6)] flex flex-col items-center text-center">
              {/* Pulsing "AO VIVO DO POLO NORTE" Badge */}
              <div className="inline-flex items-center gap-2 px-3.5 py-1 rounded-full bg-red-600/20 border border-red-400/50 text-[11px] sm:text-xs font-semibold tracking-wider text-red-100 shadow-[0_0_20px_rgba(220,38,38,0.28)]">
                <span className="w-2 h-2 sm:w-2.5 sm:h-2.5 rounded-full bg-red-500 animate-pulse" />
                <span>AO VIVO DO POLO NORTE</span>
              </div>

              {/* Glowing Golden Circular Avatar */}
              <div className="relative mt-4 mb-3 sm:mt-6 sm:mb-5">
                <span
                  className="absolute -inset-2 sm:-inset-3 rounded-full border-2 border-[#D4AF37]/60 animate-ring-pulse pointer-events-none"
                  aria-hidden="true"
                />
                <span
                  className="absolute -inset-4 sm:-inset-6 rounded-full border border-[#D4AF37]/25 animate-ring-pulse pointer-events-none"
                  style={{animationDelay: '0.55s'}}
                  aria-hidden="true"
                />
                <div className="w-24 h-24 sm:w-44 sm:h-44 rounded-full overflow-hidden ring-2 ring-[#D4AF37] shadow-[0_0_30px_rgba(212,175,55,0.4)] relative z-10 bg-[#0B0C10]">
                  <img
                    src="/santa-avatar.png"
                    alt="Papai Noel ao vivo do Polo Norte"
                    className="w-full h-full object-cover"
                  />
                </div>
              </div>

              <h2
                className="text-lg sm:text-2xl font-semibold text-[#F7F4EC]"
                style={{fontFamily: 'var(--font-display)'}}
              >
                Papai Noel
              </h2>
              <p className="text-xs sm:text-sm text-[#D4AF37] mt-0.5">
                Oficina Central · Cabana do Natal
              </p>

              <div className="w-full mt-3 pt-3 sm:mt-5 sm:pt-5 border-t border-white/10 space-y-1.5 sm:space-y-2.5 text-xs sm:text-sm text-[#D7D2C5]">
                {hasChildPersonalized ? (
                  <>
                    <div className="flex items-center justify-between gap-3">
                      <span className="text-[#9CA3AF]">Criança convidada</span>
                      <span className="font-semibold text-[#F7F4EC] truncate">
                        {config.childName}
                      </span>
                    </div>
                    <div className="flex items-center justify-between gap-3">
                      <span className="text-[#9CA3AF]">Plano selecionado</span>
                      <span className="font-medium text-[#F5D97E] tabular-nums">
                        {selectedPlan.title} ({selectedPlan.durationSeconds}s)
                      </span>
                    </div>
                  </>
                ) : (
                  <>
                    <div className="flex items-center justify-between gap-3">
                      <span className="text-[#9CA3AF]">Chamada de vídeo</span>
                      <span className="font-medium text-[#F7F4EC]">Personalizada pelo nome</span>
                    </div>
                    <div className="flex items-center justify-between gap-3">
                      <span className="text-[#9CA3AF]">Planos mágicos</span>
                      <span className="font-medium text-[#F5D97E] tabular-nums">
                        A partir de R$ 9,90
                      </span>
                    </div>
                  </>
                )}
              </div>
            </div>
          </div>

          {/* Left Story & Actions Column */}
          <div className="lg:col-span-7 lg:order-1 space-y-3.5 sm:space-y-6 text-center lg:text-left">
            <h1
              className="text-2xl sm:text-4xl lg:text-5xl font-semibold leading-[1.12] tracking-tight text-[#F7F4EC]"
              style={{fontFamily: 'var(--font-display)', textWrap: 'balance'}}
            >
              {hasChildPersonalized
                ? `O Papai Noel está pronto para conversar com ${config.childName}!`
                : 'A magia de receber uma chamada ao vivo do Papai Noel.'}
            </h1>

            <p className="text-sm sm:text-lg text-[#D5D0C3] leading-relaxed max-w-2xl mx-auto lg:mx-0">
              {hasChildPersonalized
                ? `Tudo pronto no Polo Norte! O Papai Noel já pegou a cartinha de ${config.childName} e vai chamar em vídeo agora.`
                : 'Videochamada realista em português, chamando seu filho pelo nome, com elogios da semana, conselhos carinhosos e conversa interativa ao vivo.'}
            </p>

            {prepareError && (
              <div
                role="alert"
                className="rounded-xl border border-red-400/40 bg-red-950/60 px-4 py-3 text-sm text-red-200 max-w-xl mx-auto lg:mx-0"
              >
                {prepareError}
              </div>
            )}

            {/* Primary Kid Button + Parent Setup CTA */}
            <div className="pt-0.5 flex flex-col sm:flex-row items-stretch sm:items-center justify-center lg:justify-start gap-2.5 sm:gap-3.5">
              {hasChildPersonalized && (
                <button
                  type="button"
                  onClick={onStartPreparedCall}
                  disabled={isPreparingCall}
                  className="min-h-[50px] sm:min-h-[56px] px-6 sm:px-7 py-3 rounded-2xl bg-emerald-500 text-[#0B0C10] font-bold text-sm sm:text-base flex items-center justify-center gap-2.5 shadow-[0_12px_36px_rgba(16,185,129,0.35)] hover:bg-emerald-400 active:scale-[0.98] transition-all cursor-pointer disabled:opacity-60 disabled:cursor-wait"
                >
                  <Video className="w-5 h-5" aria-hidden="true" />
                  <span>
                    {isPreparingCall
                      ? 'Conectando ao Polo Norte...'
                      : `Atender Chamada de ${config.childName}`}
                  </span>
                </button>
              )}

              <button
                type="button"
                onClick={handleCheckNiceList}
                disabled={listState === 'checking'}
                className="min-h-[48px] sm:min-h-[56px] px-5 sm:px-7 py-3 rounded-2xl bg-gradient-to-r from-[#D4AF37] to-[#F3E5AB] text-[#0B0C10] font-bold text-sm sm:text-base flex items-center justify-center gap-2.5 shadow-[0_12px_36px_rgba(212,175,55,0.34)] hover:brightness-105 active:scale-[0.98] transition-all cursor-pointer"
              >
                {listState === 'checking' ? (
                  <>
                    <Loader2 className="w-5 h-5 animate-spin" aria-hidden="true" />
                    <span>Consultando Grande Livro...</span>
                  </>
                ) : (
                  <>
                    <BookOpenCheck className="w-5 h-5" aria-hidden="true" />
                    <span>Verificar Meu Nome na Lista do Papai Noel</span>
                  </>
                )}
              </button>

              <button
                type="button"
                onClick={handleOpenParentGate}
                className="min-h-[48px] sm:min-h-[56px] px-5 sm:px-6 py-3 rounded-2xl border border-[#D4AF37]/50 bg-[#13151C]/90 backdrop-blur-md text-[#F5D97E] font-semibold text-sm sm:text-base flex items-center justify-center gap-2.5 hover:bg-[#1D202B] hover:border-[#D4AF37] active:scale-[0.98] transition-all cursor-pointer"
              >
                <PhoneCall className="w-5 h-5" aria-hidden="true" />
                <span>Personalizar Ligação Mágica (Pais)</span>
              </button>
            </div>

            {/* Magical Sleigh-Bell Checking Box */}
            {listState === 'checking' && (
              <div
                role="status"
                className="rounded-2xl border border-[#D4AF37]/40 bg-[#13151C]/90 backdrop-blur-md p-4 max-w-xl mx-auto lg:mx-0 flex items-center gap-3.5 animate-pulse"
              >
                <Sparkles className="w-5 h-5 text-[#F5D97E] shrink-0" aria-hidden="true" />
                <p className="text-sm text-[#EFE9D8] text-left">
                  {hasChildPersonalized ? (
                    <>
                      Abrindo o Grande Livro Dourado para procurar{' '}
                      <strong className="text-white">{config.childName}</strong>...
                    </>
                  ) : (
                    'Os duendes estão abrindo o Grande Livro Dourado do Polo Norte...'
                  )}
                </p>
              </div>
            )}

            {/* Discreet Social Proof */}
            <div className="pt-2 flex flex-wrap items-center justify-center lg:justify-start gap-2 text-xs sm:text-sm text-[#D7D2C5]/90">
              <Star className="w-4 h-4 text-[#F5D97E] fill-[#F5D97E] shrink-0" aria-hidden="true" />
              <span className="tabular-nums">
                +12.400 crianças já conversaram com o Papai Noel este ano
              </span>
              <span aria-hidden="true" className="text-[#D4AF37]">
                ·
              </span>
              <span className="font-semibold text-[#F5D97E] tabular-nums">Avaliação 4.9★</span>
            </div>
          </div>
        </div>
      </main>

      {/* Footer with "Área dos Pais" Button */}
      <footer className="relative z-10 w-full max-w-6xl mx-auto px-5 sm:px-8 pb-safe py-5 border-t border-white/10 flex flex-col sm:flex-row items-center justify-between gap-4">
        <p className="text-xs text-[#A39E91] text-center sm:text-left">
          Chamada Mágica do Papai Noel · Compatível com iPhone Safari e Android Chrome
        </p>

        <button
          type="button"
          onClick={handleOpenParentGate}
          className="min-h-[46px] px-5 py-2.5 rounded-xl border border-[#D4AF37]/40 bg-[#13151C]/90 text-sm font-medium text-[#E8DFC8] hover:border-[#D4AF37] hover:bg-[#1B1E28] transition-colors flex items-center gap-2.5 cursor-pointer"
        >
          <Lock className="w-4 h-4 text-[#D4AF37]" aria-hidden="true" />
          <span className="whitespace-nowrap">Área dos Pais</span>
        </button>
      </footer>

      {/* Cinematic "Nice List" Confirmed Modal (O Momento Uau) */}
      {listState === 'confirmed' && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 backdrop-blur-md p-4 animate-in fade-in duration-300"
          role="dialog"
          aria-modal="true"
          aria-labelledby="nice-list-modal-title"
        >
          <div className="w-full max-w-md rounded-3xl bg-gradient-to-b from-[#1A1A1A] to-[#0B0C10] border-2 border-[#D4AF37] p-6 sm:p-8 shadow-[0_0_50px_rgba(212,175,55,0.3)] relative animate-in fade-in zoom-in duration-300 text-center space-y-6">
            {/* Circular Close Button */}
            <button
              type="button"
              onClick={() => setListState('idle')}
              aria-label="Fechar modal"
              className="absolute top-4 right-4 w-10 h-10 rounded-full bg-white/10 hover:bg-white/20 border border-white/15 flex items-center justify-center text-[#F7F4EC] transition-colors cursor-pointer"
            >
              <X className="w-5 h-5" />
            </button>

            {/* Giant Gold Verification Shield Badge with Pulse */}
            <div className="flex justify-center pt-2">
              <div className="w-20 h-20 sm:w-24 sm:h-24 rounded-full bg-[#D4AF37]/20 border-2 border-[#D4AF37] flex items-center justify-center text-[#F5D97E] shadow-[0_0_35px_rgba(212,175,55,0.5)] animate-pulse">
                <ShieldCheck className="w-10 h-10 sm:w-12 sm:h-12" aria-hidden="true" />
              </div>
            </div>

            {/* Personalized Confirmation Text */}
            <div className="space-y-2">
              <h3
                id="nice-list-modal-title"
                className="text-2xl sm:text-3xl font-bold text-[#F7F4EC]"
                style={{fontFamily: 'var(--font-display)'}}
              >
                Parabéns, {displayName}!
              </h3>
              <p className="text-sm sm:text-base text-[#D5D0C3] leading-relaxed">
                Você está oficialmente na Lista dos Bonzinhos do Papai Noel!
              </p>
            </div>

            {/* Small Elegant Workshop Seal */}
            <div className="pt-1 pb-1">
              <span className="inline-block px-4 py-1.5 rounded-full bg-[#D4AF37]/10 border border-[#D4AF37]/40 text-xs tracking-wider uppercase text-[#F5D97E] font-medium" style={{fontFamily: 'var(--font-sans)'}}>
                Verificado na Oficina do Polo Norte
              </span>
            </div>

            {/* Primary Action Button */}
            <button
              type="button"
              onClick={() => setListState('idle')}
              className="w-full min-h-[52px] rounded-2xl bg-gradient-to-r from-[#D4AF37] to-[#F3E5AB] text-[#0B0C10] font-bold text-base hover:brightness-105 active:scale-[0.98] transition-all shadow-[0_8px_24px_rgba(212,175,55,0.35)] cursor-pointer"
            >
              Continuar a Magia
            </button>
          </div>
        </div>
      )}

      {/* Simple Math Challenge Gate Modal */}
      {challenge && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/80 backdrop-blur-sm p-4 animate-in fade-in duration-200"
          role="dialog"
          aria-modal="true"
          aria-labelledby="math-gate-title"
        >
          <form
            onSubmit={handleSubmitMath}
            className="w-full max-w-sm rounded-3xl border border-[#D4AF37]/35 bg-[#13151C] p-6 shadow-2xl space-y-5 animate-in fade-in zoom-in duration-200"
          >
            <div className="flex items-start justify-between gap-4">
              <div className="flex items-center gap-2.5">
                <ShieldCheck className="w-5 h-5 text-[#D4AF37]" aria-hidden="true" />
                <h3
                  id="math-gate-title"
                  className="text-lg font-semibold text-[#F7F4EC]"
                  style={{fontFamily: 'var(--font-display)'}}
                >
                  Acesso Exclusivo dos Pais
                </h3>
              </div>
              <button
                type="button"
                onClick={() => setChallenge(null)}
                aria-label="Cancelar"
                className="min-w-[40px] min-h-[40px] flex items-center justify-center rounded-lg text-[#9CA3AF] hover:text-white hover:bg-white/5 cursor-pointer"
              >
                <X className="w-5 h-5" />
              </button>
            </div>

            <p className="text-sm text-[#C7C2B6]">
              Resolva esta conta simples para abrir as configurações da chamada:
            </p>

            <div className="rounded-2xl bg-[#0B0C10] border border-white/10 py-4 text-center">
              <span
                className="text-3xl font-semibold text-[#F5D97E] tabular-nums"
                style={{fontFamily: 'var(--font-mono)'}}
              >
                {challenge.a} {challenge.op} {challenge.b} = ?
              </span>
            </div>

            <div>
              <label htmlFor="math-answer" className="sr-only">
                Resultado
              </label>
              <input
                id="math-answer"
                type="number"
                inputMode="numeric"
                autoFocus
                required
                value={mathInput}
                onChange={(e) => {
                  setMathInput(e.target.value);
                  setMathError(false);
                }}
                placeholder="Digite a resposta"
                className="w-full min-h-[48px] px-4 rounded-xl bg-[#0B0C10] border border-white/15 text-center text-lg font-semibold text-white focus:outline-none focus:border-[#D4AF37]"
              />
              {mathError && (
                <p className="mt-2 text-xs text-red-400 text-center">
                  Resposta incorreta. Tente novamente.
                </p>
              )}
            </div>

            <button
              type="submit"
              className="w-full min-h-[48px] rounded-xl bg-[#D4AF37] text-[#0B0C10] font-semibold text-sm hover:bg-[#E5C454] transition-colors cursor-pointer"
            >
              Entrar na Área dos Pais
            </button>
          </form>
        </div>
      )}
    </div>
  );
};
