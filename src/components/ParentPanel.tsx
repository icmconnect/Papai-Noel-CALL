import React, {useEffect, useState} from 'react';
import {ArrowLeft, Check, Copy, Loader2, Mail, PhoneCall, Send, Sparkles, Volume2} from 'lucide-react';
import {CallConfig, FAREWELL_OPTIONS, PLANS, PlanId} from '../types';

interface ParentPanelProps {
  config: CallConfig;
  onChange: (next: CallConfig) => void;
  onBack: () => void;
  onStartCountdown: () => void;
  onGenerateAudioMagic?: () => void;
  isGeneratingAudio?: boolean;
  error: string | null;
}

export const ParentPanel: React.FC<ParentPanelProps> = ({
  config,
  onChange,
  onBack,
  onStartCountdown,
  onGenerateAudioMagic,
  isGeneratingAudio = false,
  error,
}) => {
  const [magicLink, setMagicLink] = useState<string | null>(null);
  const [isSendingLink, setIsSendingLink] = useState(false);
  const [linkError, setLinkError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);
  const [ctaCountdown, setCtaCountdown] = useState<number>(10);

  useEffect(() => {
    setCtaCountdown(10);
    const deadlineMs = Date.now() + 10000;
    const timer = window.setInterval(() => {
      const remaining = Math.max(0, Math.ceil((deadlineMs - Date.now()) / 1000));
      setCtaCountdown(remaining);
      if (remaining <= 0) {
        window.clearInterval(timer);
      }
    }, 250);
    return () => {
      window.clearInterval(timer);
    };
  }, []);

  const updateField = <K extends keyof CallConfig>(key: K, value: CallConfig[K]) => {
    onChange({...config, [key]: value});
  };

  const handleGenerateMagicLink = async () => {
    setLinkError(null);
    if (!config.childName.trim()) {
      setLinkError('Preencha o nome da criança antes de gerar o link mágico.');
      return;
    }

    setIsSendingLink(true);
    try {
      const res = await fetch('/api/parent/magic-link', {
        method: 'POST',
        headers: {'Content-Type': 'application/json'},
        body: JSON.stringify({
          email: config.parentEmail,
          config,
        }),
      });
      const data = await res.json();
      if (!res.ok) {
        throw new Error(data.error || 'Erro ao gerar link mágico.');
      }
      setMagicLink(data.magicUrl);
    } catch (err) {
      setLinkError(err instanceof Error ? err.message : 'Erro ao gerar link mágico.');
    } finally {
      setIsSendingLink(false);
    }
  };

  const handleCopyLink = async () => {
    if (!magicLink) return;
    try {
      await navigator.clipboard.writeText(magicLink);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 2500);
    } catch {
      // Clipboard fallback ignored
    }
  };

  const handleStartCall = (e: React.FormEvent) => {
    e.preventDefault();
    if (!config.childName.trim()) {
      setFormError('Por favor, informe o nome da criança para o Papai Noel chamar.');
      return;
    }
    setFormError(null);
    if (config.planId === 'audio' && onGenerateAudioMagic) {
      onGenerateAudioMagic();
      return;
    }
    onStartCountdown();
  };

  const selectedPlan = PLANS.find((p) => p.id === config.planId) || PLANS[3];
  const isAudioPlan = selectedPlan.id === 'audio';
  const farewellSeconds = selectedPlan.durationSeconds <= 15 ? 3 : 6;

  return (
    <div className="relative z-10 min-h-[100dvh] pb-28">
      {/* Header */}
      <header className="sticky top-0 z-30 bg-[#0B0C10]/90 backdrop-blur-md border-b border-white/10">
        <div className="max-w-5xl mx-auto px-4 sm:px-8 h-16 flex items-center justify-between gap-4">
          <button
            type="button"
            onClick={onBack}
            className="min-h-[44px] px-3 -ml-2 rounded-xl flex items-center gap-2 text-sm font-medium text-[#D1D5DB] hover:text-white hover:bg-white/5 transition-colors cursor-pointer"
          >
            <ArrowLeft className="w-4 h-4" aria-hidden="true" />
            <span>Voltar</span>
          </button>
          <h1
            className="text-base sm:text-lg font-semibold text-[#F5D97E] truncate"
            style={{fontFamily: 'var(--font-display)'}}
          >
            Área dos Pais · Personalizar Chamada
          </h1>
          <div className="w-16" aria-hidden="true" />
        </div>
      </header>

      <form onSubmit={handleStartCall} className="max-w-5xl mx-auto px-4 sm:px-8 py-8 space-y-10">
        {(error || formError) && (
          <div
            role="alert"
            className="rounded-2xl border border-red-400/40 bg-red-950/60 px-5 py-4 text-sm text-red-100"
          >
            {formError || error}
          </div>
        )}

        {/* Section 1: 4 Planos com Ancoragem (Passe Família Ilimitado) */}
        <section aria-labelledby="planos-heading" className="space-y-4">
          <div>
            <h2
              id="planos-heading"
              className="text-xl sm:text-2xl font-semibold text-[#F7F4EC]"
              style={{fontFamily: 'var(--font-display)'}}
            >
              1. Escolha o Plano da Ligação
            </h2>
            <p className="text-sm text-[#A8A396] mt-1">
              Selecione a experiência ideal para sua família. O cronômetro segue o plano escolhido.
            </p>
          </div>

          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            {PLANS.map((plan) => {
              const active = config.planId === plan.id;
              const isAnchoredBest = plan.id === 'familia';
              const isAudioIsca = plan.id === 'audio';
              return (
                <button
                  key={plan.id}
                  type="button"
                  onClick={() => updateField('planId', plan.id as PlanId)}
                  aria-pressed={active}
                  className={`text-left rounded-2xl p-5 border transition-all cursor-pointer flex flex-col justify-between gap-4 relative ${
                    isAnchoredBest
                      ? active
                        ? 'border-[#D4AF37] bg-gradient-to-br from-[#231D0F] via-[#191B24] to-[#13151C] shadow-[0_0_0_2px_rgba(212,175,55,0.55)]'
                        : 'border-[#D4AF37]/60 bg-gradient-to-br from-[#1C1810] to-[#13151C] hover:border-[#D4AF37]'
                      : isAudioIsca
                        ? active
                          ? 'border-emerald-400 bg-gradient-to-br from-[#0F231C] via-[#191B24] to-[#13151C] shadow-[0_0_0_2px_rgba(52,211,153,0.45)] md:col-span-2'
                          : 'border-emerald-500/45 bg-gradient-to-br from-[#0E1B16] to-[#13151C] hover:border-emerald-400 md:col-span-2'
                        : active
                          ? 'border-[#D4AF37] bg-[#191B24] shadow-[0_0_0_1px_rgba(212,175,55,0.4)]'
                          : 'border-white/10 bg-[#13151C] hover:border-white/25'
                  }`}
                >
                  <div className="space-y-2.5">
                    {(isAnchoredBest || isAudioIsca) && plan.badge && (
                      <div className="flex flex-wrap items-center justify-between gap-2 pb-1">
                        <span
                          className={`inline-flex items-center gap-1.5 text-[11px] font-bold tracking-wider uppercase px-2.5 py-1 rounded-md ${
                            isAudioIsca
                              ? 'text-[#0B0C10] bg-emerald-400'
                              : 'text-[#0B0C10] bg-[#D4AF37]'
                          }`}
                        >
                          <Sparkles className="w-3 h-3" aria-hidden="true" />
                          {plan.badge}
                        </span>
                        {plan.topTag && (
                          <span
                            className={`text-[11px] font-semibold tracking-wider uppercase ${
                              isAudioIsca ? 'text-emerald-300' : 'text-[#F5D97E]'
                            }`}
                          >
                            {plan.topTag}
                          </span>
                        )}
                      </div>
                    )}

                    <div className="flex items-baseline justify-between gap-2">
                      <span className="text-base sm:text-lg font-semibold text-[#F7F4EC]">
                        {plan.title}{' '}
                        <span className="text-sm font-normal text-[#B5AFA2]">
                          (
                          {plan.id === 'familia'
                            ? '60s por chamada'
                            : plan.id === 'audio'
                              ? 'Só Áudio'
                              : `${plan.durationSeconds}s`}
                          )
                        </span>
                      </span>
                      <span className="text-lg font-bold text-[#F5D97E] tabular-nums shrink-0">
                        {plan.priceLabel}
                      </span>
                    </div>

                    <p className="text-sm text-[#C7C2B6] leading-relaxed">{plan.summary}</p>

                    {plan.highlightNote && (
                      <p className="text-xs sm:text-sm text-[#F5D97E] leading-relaxed bg-[#D4AF37]/10 border border-[#D4AF37]/25 rounded-xl p-3">
                        {plan.highlightNote}
                      </p>
                    )}
                  </div>

                  <div className="flex items-center justify-between pt-2 border-t border-white/8 text-xs">
                    <span className={active ? 'text-[#F5D97E] font-semibold' : 'text-[#8D887C]'}>
                      {active ? 'Plano selecionado' : 'Selecionar plano'}
                    </span>
                    {active && <Check className="w-4 h-4 text-[#D4AF37]" aria-hidden="true" />}
                  </div>
                </button>
              );
            })}
          </div>
        </section>

        {/* Section 2: Dados da Criança */}
        <section aria-labelledby="crianca-heading" className="space-y-5">
          <div>
            <h2
              id="crianca-heading"
              className="text-xl sm:text-2xl font-semibold text-[#F7F4EC]"
              style={{fontFamily: 'var(--font-display)'}}
            >
              2. Detalhes para o Papai Noel
            </h2>
            <p className="text-sm text-[#A8A396] mt-1">
              O Gemini cria as falas personalizadas em português e a voz do Papai Noel na hora.
            </p>
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
            <div className="sm:col-span-2 space-y-2">
              <label htmlFor="childName" className="block text-sm font-medium text-[#E5E0D4]">
                Nome da criança
              </label>
              <input
                id="childName"
                type="text"
                required
                value={config.childName}
                onChange={(e) => updateField('childName', e.target.value)}
                placeholder="Ex: Sofia, Lucas, Helena..."
                className="w-full min-h-[48px] px-4 rounded-xl bg-[#13151C] border border-white/15 text-base text-white placeholder:text-[#6B7280] focus:outline-none focus:border-[#D4AF37]"
              />
            </div>

            <div className="space-y-2">
              <label htmlFor="childAge" className="block text-sm font-medium text-[#E5E0D4]">
                Idade
              </label>
              <input
                id="childAge"
                type="number"
                min={1}
                max={14}
                inputMode="numeric"
                value={config.childAge}
                onChange={(e) => updateField('childAge', e.target.value)}
                placeholder="Ex: 6"
                className="w-full min-h-[48px] px-4 rounded-xl bg-[#13151C] border border-white/15 text-base text-white placeholder:text-[#6B7280] focus:outline-none focus:border-[#D4AF37]"
              />
            </div>
          </div>

          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <div className="space-y-2">
              <label htmlFor="praise" className="block text-sm font-medium text-[#E5E0D4]">
                Elogio / O que fez de bom na semana
              </label>
              <textarea
                id="praise"
                rows={3}
                value={config.praise}
                onChange={(e) => updateField('praise', e.target.value)}
                placeholder="Ex: Guardou todos os brinquedos, ajudou o irmãozinho e comeu os legumes."
                className="w-full p-4 rounded-xl bg-[#13151C] border border-white/15 text-sm text-white placeholder:text-[#6B7280] focus:outline-none focus:border-[#D4AF37] resize-none"
              />
            </div>

            <div className="space-y-2">
              <label htmlFor="advice" className="block text-sm font-medium text-[#E5E0D4]">
                Conselho carinhoso
              </label>
              <textarea
                id="advice"
                rows={3}
                value={config.advice}
                onChange={(e) => updateField('advice', e.target.value)}
                placeholder="Ex: Escovar bem os dentes antes de dormir e obedecer na hora do banho."
                className="w-full p-4 rounded-xl bg-[#13151C] border border-white/15 text-sm text-white placeholder:text-[#6B7280] focus:outline-none focus:border-[#D4AF37] resize-none"
              />
            </div>
          </div>
        </section>

        {/* Section 3: 4 Opções Criativas de Despedida (apenas planos de chamada de vídeo) */}
        {!isAudioPlan && (
          <section aria-labelledby="despedida-heading" className="space-y-4">
          <div>
            <h2
              id="despedida-heading"
              className="text-xl sm:text-2xl font-semibold text-[#F7F4EC]"
              style={{fontFamily: 'var(--font-display)'}}
            >
              3. Despedida Mágica Automática (Últimos {farewellSeconds} segundos)
            </h2>
            <p className="text-sm text-[#A8A396] mt-1">
              Escolha o motivo que o Papai Noel vai falar nos {farewellSeconds} segundos finais antes de desligar:
            </p>
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            {FAREWELL_OPTIONS.map((option) => {
              const active = config.farewellType === option.id;
              return (
                <button
                  key={option.id}
                  type="button"
                  onClick={() => updateField('farewellType', option.id)}
                  aria-pressed={active}
                  className={`text-left rounded-2xl p-5 border transition-all cursor-pointer flex items-start justify-between gap-4 ${
                    active
                      ? 'border-[#D4AF37] bg-[#191B24]'
                      : 'border-white/10 bg-[#13151C] hover:border-white/25'
                  }`}
                >
                  <div className="space-y-1">
                    <span className="block text-base font-semibold text-[#F7F4EC]">
                      {option.title}
                    </span>
                    <span className="block text-sm text-[#B5AFA2] leading-relaxed">
                      {option.desc}
                    </span>
                  </div>
                  <span
                    className={`mt-1 w-5 h-5 rounded-full border flex items-center justify-center shrink-0 ${
                      active ? 'border-[#D4AF37] bg-[#D4AF37] text-[#0B0C10]' : 'border-white/30'
                    }`}
                  >
                    {active && <Check className="w-3.5 h-3.5" strokeWidth={3} />}
                  </span>
                </button>
              );
            })}
            </div>
          </section>
        )}

        {/* Section 4: E-mail & Link Mágico (apenas planos de chamada de vídeo) */}
        {!isAudioPlan && (
          <section
            aria-labelledby="email-heading"
            className="rounded-2xl border border-white/10 bg-[#13151C] p-5 sm:p-6 space-y-4"
          >
            <div>
              <h2
                id="email-heading"
                className="text-lg font-semibold text-[#F7F4EC]"
                style={{fontFamily: 'var(--font-display)'}}
              >
                4. E-mail para Envio do Link Mágico
              </h2>
              <p className="text-sm text-[#A8A396] mt-1">
                Gere um link pronto para abrir a chamada personalizada em outro celular ou guardar por
                e-mail.
              </p>
            </div>

            <div className="flex flex-col sm:flex-row gap-3">
              <div className="relative flex-1">
                <Mail
                  className="w-4 h-4 text-[#9CA3AF] absolute left-4 top-1/2 -translate-y-1/2 pointer-events-none"
                  aria-hidden="true"
                />
                <input
                  type="email"
                  value={config.parentEmail}
                  onChange={(e) => updateField('parentEmail', e.target.value)}
                  placeholder="seuemail@exemplo.com"
                  className="w-full min-h-[48px] pl-11 pr-4 rounded-xl bg-[#0B0C10] border border-white/15 text-sm text-white placeholder:text-[#6B7280] focus:outline-none focus:border-[#D4AF37]"
                />
              </div>

              <button
                type="button"
                onClick={handleGenerateMagicLink}
                disabled={isSendingLink}
                className="min-h-[48px] px-5 rounded-xl border border-[#D4AF37]/50 bg-[#1B1E28] text-sm font-semibold text-[#F5D97E] hover:bg-[#242836] transition-colors flex items-center justify-center gap-2 whitespace-nowrap cursor-pointer disabled:opacity-60"
              >
                <Send className="w-4 h-4" aria-hidden="true" />
                <span>{isSendingLink ? 'Gerando...' : 'Gerar Link Mágico'}</span>
              </button>
            </div>

            {linkError && <p className="text-xs text-red-400">{linkError}</p>}

            {magicLink && (
              <div className="rounded-xl bg-[#0B0C10] border border-[#D4AF37]/30 p-4 space-y-3">
                <p className="text-xs text-[#D4AF37] font-medium">
                  Link mágico criado com sucesso
                  {config.parentEmail ? ` para ${config.parentEmail}` : ''}:
                </p>
                <div className="flex flex-col sm:flex-row items-stretch sm:items-center gap-2">
                  <input
                    type="text"
                    readOnly
                    value={magicLink}
                    aria-label="URL do link mágico"
                    className="flex-1 min-h-[42px] px-3 rounded-lg bg-[#13151C] border border-white/10 text-xs text-[#E5E7EB] font-mono"
                  />
                  <button
                    type="button"
                    onClick={handleCopyLink}
                    className="min-h-[42px] px-4 rounded-lg bg-[#D4AF37] text-[#0B0C10] text-xs font-semibold flex items-center justify-center gap-1.5 hover:bg-[#E5C454] cursor-pointer whitespace-nowrap"
                  >
                    {copied ? <Check className="w-3.5 h-3.5" /> : <Copy className="w-3.5 h-3.5" />}
                    <span>{copied ? 'Copiado!' : 'Copiar Link'}</span>
                  </button>
                  {config.parentEmail && (
                    <a
                      href={`mailto:${encodeURIComponent(config.parentEmail)}?subject=${encodeURIComponent(
                        `Chamada Mágica do Papai Noel para ${config.childName}`
                      )}&body=${encodeURIComponent(
                        `Abra este link mágico no celular para receber a ligação do Papai Noel para ${config.childName}:\n\n${magicLink}`
                      )}`}
                      className="min-h-[42px] px-4 rounded-lg border border-white/20 text-xs font-medium text-white flex items-center justify-center gap-1.5 hover:bg-white/10 whitespace-nowrap"
                    >
                      <Mail className="w-3.5 h-3.5" />
                      <span>Abrir E-mail</span>
                    </a>
                  )}
                </div>
              </div>
            )}
          </section>
        )}

        {/* Sticky Bottom Action Bar */}
        <div className="fixed bottom-0 left-0 right-0 z-30 bg-gradient-to-t from-[#0B0C10] via-[#0B0C10]/95 to-transparent pt-6 pb-safe px-4 sm:px-8">
          <div className="max-w-5xl mx-auto flex flex-col sm:flex-row items-center justify-between gap-3 rounded-2xl border border-[#D4AF37]/30 bg-[#13151C] p-3 sm:p-4 shadow-2xl">
            <div className="hidden sm:block text-sm">
              <span className="text-[#F7F4EC] font-semibold">
                {selectedPlan.title} (
                {isAudioPlan ? 'Só Áudio' : `${selectedPlan.durationSeconds}s`})
              </span>
              <span className="text-[#9CA3AF] mx-2">·</span>
              <span className="text-[#F5D97E] font-semibold tabular-nums">
                {selectedPlan.priceLabel}
              </span>
            </div>
            {isAudioPlan ? (
              <button
                type="submit"
                disabled={isGeneratingAudio}
                className="w-full sm:w-auto min-h-[52px] px-7 rounded-xl bg-emerald-500 text-[#0B0C10] font-bold text-base flex items-center justify-center gap-2.5 shadow-lg hover:bg-emerald-400 active:scale-[0.98] transition-all cursor-pointer disabled:opacity-60 disabled:cursor-wait"
              >
                {isGeneratingAudio ? (
                  <>
                    <Loader2 className="w-5 h-5 animate-spin" aria-hidden="true" />
                    <span>Gerando Áudio Mágico...</span>
                  </>
                ) : (
                  <>
                    <Volume2 className="w-5 h-5" aria-hidden="true" />
                    <span>Gerar Áudio Mágico</span>
                  </>
                )}
              </button>
            ) : (
              <button
                type="submit"
                disabled={ctaCountdown > 0}
                className="w-full sm:w-auto min-h-[52px] px-7 rounded-xl bg-[#D4AF37] text-[#0B0C10] font-bold text-base flex items-center justify-center gap-2.5 shadow-lg hover:bg-[#E5C454] active:scale-[0.98] transition-all cursor-pointer disabled:opacity-55 disabled:cursor-not-allowed disabled:hover:bg-[#D4AF37] tabular-nums"
              >
                <PhoneCall className="w-5 h-5" aria-hidden="true" />
                <span>
                  {ctaCountdown > 0
                    ? `Iniciar Ligação em ${ctaCountdown}s`
                    : 'Iniciar Ligação Agora'}
                </span>
              </button>
            )}
          </div>
        </div>
      </form>
    </div>
  );
};
