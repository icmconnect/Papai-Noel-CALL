import React, {useCallback, useEffect, useState} from 'react';
import {
  AlertTriangle,
  ArrowLeft,
  Database,
  ExternalLink,
  FileAudio,
  KeyRound,
  Loader2,
  Mic2,
  RefreshCw,
  ShieldAlert,
  Sparkles,
  Volume2,
  VolumeX,
} from 'lucide-react';
import {AudioBankFileItem, BankGenerateSummary} from '../types';
import {playSantaAudio, stopCurrentSantaVoice, unlockAudioContext} from '../utils/audioEngine';

interface DebugPanelProps {
  onBack: () => void;
}

const VOICE_OPTIONS = [
  {id: 'Algenib', label: 'Algenib · Voz idosa e rouca (Padrão)'},
  {id: 'Gacrux', label: 'Gacrux · Voz madura e calorosa'},
  {id: 'Charon', label: 'Charon · Voz grave e pausada'},
  {id: 'Alnilam', label: 'Alnilam · Voz firme e acolhedora'},
] as const;

const VOICE_DESIGN_ID_REGEX = /^voice_[A-Za-z0-9_-]+$/;

interface DebugTtsResponse {
  success?: boolean;
  text?: string;
  audioBase64?: string | null;
  audioMimeType?: string | null;
  mimeType?: string | null;
  voiceSource?: string;
  voice?: string;
  model?: string;
  useBrowserFallback?: boolean;
  error?: string;
}

export const DebugPanel: React.FC<DebugPanelProps> = ({onBack}) => {
  const [name, setName] = useState('Vinicius');
  const [age, setAge] = useState('12');
  const [praise, setPraise] = useState('tomou banho sem reclamar seu fedido');
  const [advice, setAdvice] = useState('Tem que tomar mais banhos e lavar o suvaco porquinho.');
  const [voice, setVoice] = useState<string>('Algenib');
  const [voiceDesignId, setVoiceDesignId] = useState<string | null>(null);
  const [forceGeminiOnly, setForceGeminiOnly] = useState<boolean>(true);

  const [isGenerating, setIsGenerating] = useState(false);
  const [isPlaying, setIsPlaying] = useState(false);
  const [playedEngine, setPlayedEngine] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<DebugTtsResponse | null>(null);

  // Banco de Vozes (Admin Dev Tooling)
  const [adminToken, setAdminToken] = useState<string>(() => {
    if (typeof window === 'undefined') return '';
    try {
      return sessionStorage.getItem('santa_admin_token') || '';
    } catch {
      return '';
    }
  });
  const [overwriteBank, setOverwriteBank] = useState(false);
  const [bankFiles, setBankFiles] = useState<AudioBankFileItem[]>([]);
  const [isLoadingBankList, setIsLoadingBankList] = useState(false);
  const [isGeneratingBank, setIsGeneratingBank] = useState(false);
  const [bankError, setBankError] = useState<string | null>(null);
  const [bankSummary, setBankSummary] = useState<BankGenerateSummary | null>(null);

  useEffect(() => {
    let active = true;
    fetch('/api/health')
      .then((res) => (res.ok ? res.json() : null))
      .then((data: {ttsVoice?: string} | null) => {
        if (!active || !data?.ttsVoice) return;
        const candidate = data.ttsVoice.trim();
        if (VOICE_DESIGN_ID_REGEX.test(candidate)) {
          setVoiceDesignId(candidate);
        }
      })
      .catch(() => undefined);
    return () => {
      active = false;
    };
  }, []);

  const handleTestVoice = async (e: React.FormEvent) => {
    e.preventDefault();
    if (isGenerating) return;

    unlockAudioContext();
    stopCurrentSantaVoice();
    setIsPlaying(false);
    setPlayedEngine(null);
    setError(null);
    setIsGenerating(true);

    try {
      const res = await fetch('/api/debug/tts', {
        method: 'POST',
        headers: {'Content-Type': 'application/json'},
        body: JSON.stringify({
          name: name.trim() || 'Vinicius',
          age: age.trim(),
          praise: praise.trim(),
          advice: advice.trim(),
          voice,
        }),
      });

      const data = (await res.json()) as DebugTtsResponse;
      if (!res.ok) {
        throw new Error(data.error || 'Erro ao gerar áudio no servidor.');
      }

      setResult(data);

      if (forceGeminiOnly && !data.audioBase64) {
        setError(
          data.error ||
            'O backend não retornou áudio WAV do Gemini TTS (fallback do navegador bloqueado).'
        );
        return;
      }

      if (data.error && !data.audioBase64) {
        setError(data.error);
      }

      const playRes = await playSantaAudio({
        audioBase64: data.audioBase64 || null,
        audioMimeType: data.mimeType || data.audioMimeType || null,
        fallbackText: data.text || '',
        useBrowserFallback: forceGeminiOnly ? false : Boolean(data.useBrowserFallback),
        disableBrowserFallback: forceGeminiOnly,
        onStart: () => setIsPlaying(true),
        onEnd: () => setIsPlaying(false),
        onError: (msg) => setError(msg),
      });

      setPlayedEngine(playRes.playedSource);
      if (playRes.error && forceGeminiOnly) {
        setError(playRes.error);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Falha ao testar a voz do Papai Noel.');
      setIsPlaying(false);
    } finally {
      setIsGenerating(false);
    }
  };

  const handleStopAudio = () => {
    stopCurrentSantaVoice();
    setIsPlaying(false);
  };

  const handleBack = () => {
    stopCurrentSantaVoice();
    setIsPlaying(false);
    onBack();
  };

  const handleLoadBankList = useCallback(async () => {
    const token = adminToken.trim();
    if (!token) {
      setBankError('Informe o token de administrador (ADMIN_TOKEN) para consultar o banco.');
      return;
    }
    setBankError(null);
    setIsLoadingBankList(true);
    try {
      const res = await fetch('/api/admin/bank/list', {
        method: 'GET',
        headers: {
          'x-admin-token': token,
        },
      });
      const data = (await res.json()) as {files?: AudioBankFileItem[]; error?: string};
      if (!res.ok) {
        throw new Error(data.error || `Erro HTTP ${res.status}`);
      }
      setBankFiles(Array.isArray(data.files) ? data.files : []);
    } catch (err) {
      setBankError(err instanceof Error ? err.message : 'Erro ao listar arquivos do banco.');
    } finally {
      setIsLoadingBankList(false);
    }
  }, [adminToken]);

  const handleGenerateBank = async () => {
    const token = adminToken.trim();
    if (!token) {
      setBankError('Informe o token de administrador (ADMIN_TOKEN) antes de gerar o banco.');
      return;
    }
    if (isGeneratingBank) return;
    setBankError(null);
    setIsGeneratingBank(true);
    try {
      const res = await fetch('/api/admin/bank/generate', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-admin-token': token,
        },
        body: JSON.stringify({overwrite: overwriteBank}),
      });
      const data = (await res.json()) as BankGenerateSummary & {error?: string};
      if (!res.ok) {
        throw new Error(data.error || `Erro HTTP ${res.status}`);
      }
      setBankSummary(data);
      if (Array.isArray(data.files)) {
        setBankFiles(data.files);
      }
    } catch (err) {
      setBankError(err instanceof Error ? err.message : 'Falha ao gerar Banco de Vozes.');
    } finally {
      setIsGeneratingBank(false);
    }
  };

  const resolvedVoiceSource =
    playedEngine === 'browser'
      ? 'browser'
      : result?.voiceSource || (result?.audioBase64 ? 'gemini-tts' : 'browser');

  return (
    <div className="relative z-10 min-h-[100dvh] pb-16">
      {/* Sticky Luxury Header */}
      <header className="sticky top-0 z-30 bg-[#0B0C10]/90 backdrop-blur-md border-b border-white/10">
        <div className="max-w-4xl mx-auto px-4 sm:px-8 h-16 flex items-center justify-between gap-4">
          <button
            type="button"
            onClick={handleBack}
            className="min-h-[44px] px-3 -ml-2 rounded-xl flex items-center gap-2 text-sm font-medium text-[#D1D5DB] hover:text-white hover:bg-white/5 transition-colors cursor-pointer"
          >
            <ArrowLeft className="w-4 h-4" aria-hidden="true" />
            <span>Voltar</span>
          </button>

          <h1
            className="text-base sm:text-lg font-semibold text-[#F5D97E] truncate"
            style={{fontFamily: 'var(--font-display)'}}
          >
            Estúdio de Voz · Debug Papai Noel
          </h1>

          <div className="w-16" aria-hidden="true" />
        </div>
      </header>

      <main className="max-w-4xl mx-auto px-4 sm:px-8 py-8 space-y-8">
        <div className="rounded-3xl border border-[#D4AF37]/30 bg-gradient-to-b from-[#161822] to-[#101218] p-6 sm:p-8 shadow-[0_24px_64px_rgba(0,0,0,0.65)] space-y-6">
          <div className="flex flex-wrap items-start justify-between gap-4 border-b border-white/10 pb-5">
            <div className="space-y-1">
              <div className="inline-flex items-center gap-2 px-3 py-1 rounded-full bg-[#D4AF37]/15 border border-[#D4AF37]/40 text-xs font-semibold text-[#F5D97E]">
                <Sparkles className="w-3.5 h-3.5" aria-hidden="true" />
                <span>Diagnóstico Gemini TTS & PCM WAV</span>
              </div>
              <h2
                className="text-xl sm:text-2xl font-semibold text-[#F7F4EC] pt-1"
                style={{fontFamily: 'var(--font-display)'}}
              >
                Simulador Rápido de Voz & Roteiro
              </h2>
              <p className="text-sm text-[#A8A396]">
                Teste entonação, pausas, mimeType WAV e confirme se a voz veio do Gemini ou do navegador.
              </p>
            </div>

            {isPlaying && (
              <button
                type="button"
                onClick={handleStopAudio}
                className="min-h-[42px] px-4 rounded-xl border border-red-400/40 bg-red-950/50 text-xs font-semibold text-red-200 hover:bg-red-900/60 flex items-center gap-2 cursor-pointer"
              >
                <VolumeX className="w-4 h-4" aria-hidden="true" />
                <span>Parar Áudio</span>
              </button>
            )}
          </div>

          {error && (
            <div
              role="alert"
              className="rounded-2xl border border-red-400/50 bg-red-950/70 px-4 py-3.5 text-sm text-red-100 flex items-start gap-3"
            >
              <AlertTriangle className="w-5 h-5 text-red-400 shrink-0 mt-0.5" aria-hidden="true" />
              <span>{error}</span>
            </div>
          )}

          <form onSubmit={handleTestVoice} className="space-y-5">
            <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
              <div className="sm:col-span-2 space-y-2">
                <label htmlFor="debug-child-name" className="block text-sm font-medium text-[#E5E0D4]">
                  Nome da criança
                </label>
                <input
                  id="debug-child-name"
                  type="text"
                  required
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  placeholder="Ex: Vinicius"
                  className="w-full min-h-[48px] px-4 rounded-xl bg-[#0B0C10] border border-white/15 text-base text-white placeholder:text-[#6B7280] focus:outline-none focus:border-[#D4AF37]"
                />
              </div>

              <div className="space-y-2">
                <label htmlFor="debug-child-age" className="block text-sm font-medium text-[#E5E0D4]">
                  Idade
                </label>
                <input
                  id="debug-child-age"
                  type="number"
                  min={1}
                  max={16}
                  inputMode="numeric"
                  value={age}
                  onChange={(e) => setAge(e.target.value)}
                  placeholder="12"
                  className="w-full min-h-[48px] px-4 rounded-xl bg-[#0B0C10] border border-white/15 text-base text-white placeholder:text-[#6B7280] focus:outline-none focus:border-[#D4AF37]"
                />
              </div>
            </div>

            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              <div className="space-y-2">
                <label htmlFor="debug-praise" className="block text-sm font-medium text-[#E5E0D4]">
                  Elogio
                </label>
                <textarea
                  id="debug-praise"
                  rows={3}
                  value={praise}
                  onChange={(e) => setPraise(e.target.value)}
                  className="w-full p-4 rounded-xl bg-[#0B0C10] border border-white/15 text-sm text-white placeholder:text-[#6B7280] focus:outline-none focus:border-[#D4AF37] resize-none"
                />
              </div>

              <div className="space-y-2">
                <label htmlFor="debug-advice" className="block text-sm font-medium text-[#E5E0D4]">
                  Conselho
                </label>
                <textarea
                  id="debug-advice"
                  rows={3}
                  value={advice}
                  onChange={(e) => setAdvice(e.target.value)}
                  className="w-full p-4 rounded-xl bg-[#0B0C10] border border-white/15 text-sm text-white placeholder:text-[#6B7280] focus:outline-none focus:border-[#D4AF37] resize-none"
                />
              </div>
            </div>

            <div className="space-y-2">
              <label htmlFor="debug-voice-select" className="block text-sm font-medium text-[#E5E0D4]">
                Voz do Papai Noel (Gemini TTS)
              </label>
              <select
                id="debug-voice-select"
                value={voice}
                onChange={(e) => setVoice(e.target.value)}
                className="w-full min-h-[48px] px-4 rounded-xl bg-[#0B0C10] border border-[#D4AF37]/40 text-sm sm:text-base text-[#F5D97E] font-medium focus:outline-none focus:border-[#D4AF37] cursor-pointer"
              >
                {VOICE_OPTIONS.map((opt) => (
                  <option key={opt.id} value={opt.id} className="bg-[#13151C] text-[#F7F4EC]">
                    {opt.label}
                  </option>
                ))}
                <option
                  value={voiceDesignId || '__voice_design_unconfigured__'}
                  disabled={!voiceDesignId}
                  className="bg-[#13151C] text-[#F7F4EC] disabled:text-[#6B7280]"
                >
                  {voiceDesignId
                    ? 'Papai Noel (Voice Design)'
                    : 'Papai Noel (Voice Design · configure GEMINI_TTS_VOICE=voice_...)'}
                </option>
              </select>
            </div>

            {/* Strict No-Browser-Fallback Checkbox */}
            <label
              htmlFor="force-gemini-checkbox"
              className="flex items-start gap-3 rounded-2xl border border-[#D4AF37]/30 bg-[#0B0C10]/80 p-4 cursor-pointer hover:border-[#D4AF37]/60 transition-colors"
            >
              <input
                id="force-gemini-checkbox"
                type="checkbox"
                checked={forceGeminiOnly}
                onChange={(e) => setForceGeminiOnly(e.target.checked)}
                className="mt-1 h-4 w-4 accent-[#D4AF37] rounded cursor-pointer"
              />
              <div className="space-y-0.5">
                <span className="text-sm font-semibold text-[#F5D97E] flex items-center gap-1.5">
                  <ShieldAlert className="w-4 h-4 text-[#D4AF37]" aria-hidden="true" />
                  <span>Forçar Gemini TTS (sem fallback de navegador)</span>
                </span>
                <p className="text-xs text-[#9CA3AF]">
                  Reproduz apenas o WAV retornado pelo servidor. Se falhar, exibe o erro real em vez de tocar a voz robótica do navegador.
                </p>
              </div>
            </label>

            <div className="pt-2 flex flex-col sm:flex-row gap-3">
              <button
                type="submit"
                disabled={isGenerating}
                className="flex-1 min-h-[56px] px-6 rounded-2xl bg-gradient-to-r from-[#D4AF37] to-[#F3E5AB] text-[#0B0C10] font-bold text-base flex items-center justify-center gap-2.5 shadow-[0_12px_36px_rgba(212,175,55,0.34)] hover:brightness-105 active:scale-[0.98] transition-all cursor-pointer disabled:opacity-60 disabled:cursor-wait"
              >
                {isGenerating ? (
                  <>
                    <Loader2 className="w-5 h-5 animate-spin" aria-hidden="true" />
                    <span>Gerando áudio...</span>
                  </>
                ) : (
                  <>
                    <Volume2 className="w-5 h-5" aria-hidden="true" />
                    <span>Testar Voz do Papai Noel</span>
                  </>
                )}
              </button>

              <button
                type="button"
                onClick={handleBack}
                className="sm:w-40 min-h-[56px] px-6 rounded-2xl border border-white/15 bg-[#13151C] text-[#E5E0D4] font-semibold text-base hover:bg-white/5 transition-colors cursor-pointer"
              >
                Voltar
              </button>
            </div>
          </form>
        </div>

        {/* Exact Generated Text & VoiceSource Telemetry Preview Card */}
        {result && (
          <section
            aria-label="Resultado do teste de voz"
            className="rounded-3xl border border-[#D4AF37]/35 bg-[#13151C]/95 p-6 space-y-4 shadow-xl"
          >
            <div className="flex flex-wrap items-center justify-between gap-2 border-b border-white/10 pb-3">
              <div className="flex items-center gap-2 text-sm font-semibold text-[#F5D97E]">
                <Mic2 className="w-4 h-4 text-[#D4AF37]" aria-hidden="true" />
                <span>Texto Exato Enviado para Voz</span>
              </div>
              <div className="flex flex-wrap items-center gap-2">
                <span
                  className={`px-3 py-1 rounded-full text-xs font-bold border ${
                    resolvedVoiceSource === 'gemini-tts' || resolvedVoiceSource === 'audio-bank'
                      ? 'bg-emerald-500/15 border-emerald-400/40 text-emerald-300'
                      : 'bg-red-500/15 border-red-400/40 text-red-300'
                  }`}
                >
                  voiceSource: {resolvedVoiceSource}
                </span>
                <span className="px-3 py-1 rounded-full bg-[#D4AF37]/15 border border-[#D4AF37]/35 text-xs font-semibold text-[#F5D97E]">
                  {result.voice || voice}
                </span>
              </div>
            </div>

            <blockquote className="rounded-2xl bg-[#0B0C10] border border-white/10 p-4 text-sm sm:text-base text-[#F7F4EC] leading-relaxed">
              “{result.text}”
            </blockquote>

            <div className="flex flex-wrap items-center justify-between gap-2 text-xs text-[#A8A396]">
              <span>
                mimeType:{' '}
                <strong className="text-[#F5D97E]">
                  {result.mimeType || result.audioMimeType || 'nenhum'}
                </strong>
                {playedEngine ? ` · Player: ${playedEngine}` : ''}
              </span>
              {isPlaying && (
                <span className="inline-flex items-center gap-1.5 text-emerald-300 font-medium">
                  <span className="w-2 h-2 rounded-full bg-emerald-400 animate-pulse" />
                  Reproduzindo agora...
                </span>
              )}
            </div>
          </section>
        )}

        {/* Banco de Vozes Section */}
        <section
          aria-label="Banco de Vozes"
          className="rounded-3xl border border-[#D4AF37]/30 bg-gradient-to-b from-[#161822] to-[#101218] p-6 sm:p-8 shadow-[0_24px_64px_rgba(0,0,0,0.65)] space-y-6"
        >
          <div className="flex flex-wrap items-start justify-between gap-4 border-b border-white/10 pb-5">
            <div className="space-y-1">
              <div className="inline-flex items-center gap-2 px-3 py-1 rounded-full bg-[#D4AF37]/15 border border-[#D4AF37]/40 text-xs font-semibold text-[#F5D97E]">
                <Database className="w-3.5 h-3.5" aria-hidden="true" />
                <span>Pré-geração em Disco · public/audio/bank</span>
              </div>
              <h2
                className="text-xl sm:text-2xl font-semibold text-[#F7F4EC] pt-1"
                style={{fontFamily: 'var(--font-display)'}}
              >
                Banco de Vozes
              </h2>
              <p className="text-sm text-[#A8A396]">
                Gera saudações em WAV para os 120 nomes mais comuns do Brasil (IBGE) + 6 clipes
                genéricos de chamada, com intervalo de 300ms entre sínteses.
              </p>
            </div>
          </div>

          <div className="rounded-2xl border border-amber-400/35 bg-amber-950/35 p-4 flex flex-col sm:flex-row sm:items-center justify-between gap-3">
            <div className="space-y-1">
              <p className="text-xs font-bold uppercase tracking-wider text-amber-300">
                Atenção de Cota & Faturamento Google Cloud
              </p>
              <p className="text-xs text-amber-100/90 leading-relaxed">
                Para gerar ~126 áudios sem esbarrar no limite gratuito (3 RPM / 10 RPD),{' '}
                <strong className="text-white">ative cartão + alerta de R$20</strong> antes de rodar em lote.
              </p>
            </div>
            <a
              href="https://console.cloud.google.com/billing"
              target="_blank"
              rel="noopener noreferrer"
              className="shrink-0 min-h-[40px] px-4 rounded-xl bg-amber-400 text-[#0B0C10] text-xs font-bold inline-flex items-center gap-1.5 hover:bg-amber-300 transition-colors"
            >
              <span>console.cloud.google.com/billing</span>
              <ExternalLink className="w-3.5 h-3.5" aria-hidden="true" />
            </a>
          </div>

          {bankError && (
            <div
              role="alert"
              className="rounded-2xl border border-red-400/50 bg-red-950/70 px-4 py-3 text-sm text-red-100 flex items-start gap-2.5"
            >
              <AlertTriangle className="w-4 h-4 text-red-400 shrink-0 mt-0.5" aria-hidden="true" />
              <span>{bankError}</span>
            </div>
          )}

          <div className="space-y-4">
            <div className="space-y-2">
              <label htmlFor="debug-admin-token" className="block text-sm font-medium text-[#E5E0D4]">
                Token Admin (`x-admin-token` / `ADMIN_TOKEN`)
              </label>
              <div className="relative">
                <KeyRound
                  className="w-4 h-4 text-[#A8A396] absolute left-3.5 top-1/2 -translate-y-1/2"
                  aria-hidden="true"
                />
                <input
                  id="debug-admin-token"
                  type="password"
                  value={adminToken}
                  onChange={(e) => {
                    const nextVal = e.target.value;
                    setAdminToken(nextVal);
                    try {
                      if (nextVal.trim()) {
                        sessionStorage.setItem('santa_admin_token', nextVal.trim());
                      } else {
                        sessionStorage.removeItem('santa_admin_token');
                      }
                    } catch {
                      // Ignore storage restrictions
                    }
                  }}
                  placeholder="Cole o ADMIN_TOKEN configurado no servidor"
                  autoComplete="off"
                  className="w-full min-h-[48px] pl-10 pr-4 rounded-xl bg-[#0B0C10] border border-white/15 text-sm text-white placeholder:text-[#6B7280] focus:outline-none focus:border-[#D4AF37]"
                />
              </div>
            </div>

            <label
              htmlFor="debug-bank-overwrite"
              className="flex items-center gap-2.5 text-xs text-[#C7C2B6] cursor-pointer"
            >
              <input
                id="debug-bank-overwrite"
                type="checkbox"
                checked={overwriteBank}
                onChange={(e) => setOverwriteBank(e.target.checked)}
                className="h-4 w-4 accent-[#D4AF37] rounded cursor-pointer"
              />
              <span>Sobrescrever arquivos WAV já existentes no disco</span>
            </label>

            <div className="flex flex-col sm:flex-row gap-3">
              <button
                type="button"
                onClick={handleGenerateBank}
                disabled={isGeneratingBank}
                className="flex-1 min-h-[50px] px-5 rounded-xl bg-gradient-to-r from-[#D4AF37] to-[#F3E5AB] text-[#0B0C10] font-bold text-sm flex items-center justify-center gap-2 hover:brightness-105 transition-all cursor-pointer disabled:opacity-60 disabled:cursor-wait"
              >
                {isGeneratingBank ? (
                  <>
                    <Loader2 className="w-4 h-4 animate-spin" aria-hidden="true" />
                    <span>Gerando banco de vozes...</span>
                  </>
                ) : (
                  <>
                    <Database className="w-4 h-4" aria-hidden="true" />
                    <span>Gerar banco (dev)</span>
                  </>
                )}
              </button>

              <button
                type="button"
                onClick={handleLoadBankList}
                disabled={isLoadingBankList}
                className="sm:w-48 min-h-[50px] px-5 rounded-xl border border-white/15 bg-[#0B0C10] text-sm font-semibold text-[#E5E0D4] flex items-center justify-center gap-2 hover:bg-white/5 cursor-pointer disabled:opacity-60"
              >
                {isLoadingBankList ? (
                  <Loader2 className="w-4 h-4 animate-spin" aria-hidden="true" />
                ) : (
                  <RefreshCw className="w-4 h-4" aria-hidden="true" />
                )}
                <span>Listar arquivos</span>
              </button>
            </div>
          </div>

          {bankSummary && (
            <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 pt-1">
              <div className="rounded-2xl border border-emerald-500/30 bg-emerald-950/30 p-3.5">
                <p className="text-[11px] uppercase tracking-wider text-emerald-300">Gerados</p>
                <p className="text-xl font-bold text-white tabular-nums">{bankSummary.gerados}</p>
              </div>
              <div className="rounded-2xl border border-white/10 bg-[#0B0C10] p-3.5">
                <p className="text-[11px] uppercase tracking-wider text-[#A8A396]">Já existentes</p>
                <p className="text-xl font-bold text-white tabular-nums">{bankSummary.pulados}</p>
              </div>
              <div className="rounded-2xl border border-red-500/30 bg-red-950/30 p-3.5">
                <p className="text-[11px] uppercase tracking-wider text-red-300">Falhas</p>
                <p className="text-xl font-bold text-white tabular-nums">{bankSummary.falhas}</p>
              </div>
              <div className="rounded-2xl border border-[#D4AF37]/35 bg-[#D4AF37]/10 p-3.5">
                <p className="text-[11px] uppercase tracking-wider text-[#F5D97E]">Custo estimado</p>
                <p className="text-xl font-bold text-[#F5D97E] tabular-nums">
                  R$ {bankSummary.custoEstimadoBRL.toFixed(3).replace('.', ',')}
                </p>
              </div>
            </div>
          )}

          {bankSummary && bankSummary.failures.length > 0 && (
            <div className="rounded-2xl border border-red-400/30 bg-red-950/25 p-4 space-y-1.5">
              <p className="text-xs font-semibold text-red-300">
                Falhas registradas ({bankSummary.failures.length}):
              </p>
              <ul className="max-h-32 overflow-y-auto text-xs text-red-200/90 space-y-1">
                {bankSummary.failures.map((f) => (
                  <li key={f.filename}>
                    <span className="font-mono">{f.filename}</span>: {f.reason}
                  </li>
                ))}
              </ul>
            </div>
          )}

          <div className="space-y-2.5">
            <div className="flex items-center justify-between text-xs text-[#A8A396]">
              <span className="font-semibold text-[#E5E0D4] flex items-center gap-1.5">
                <FileAudio className="w-4 h-4 text-[#D4AF37]" aria-hidden="true" />
                <span>Arquivos no banco ({bankFiles.length})</span>
              </span>
              <span>
                Estimativa lote completo (126 áudios):{' '}
                <strong className="text-[#F5D97E]">R$ {(126 * 0.012).toFixed(2).replace('.', ',')}</strong>
              </span>
            </div>

            {bankFiles.length === 0 ? (
              <p className="rounded-2xl border border-white/10 bg-[#0B0C10] p-4 text-xs text-[#8D887C]">
                Nenhum arquivo listado ainda. Informe o token admin e clique em &ldquo;Listar
                arquivos&rdquo; ou &ldquo;Gerar banco (dev)&rdquo;.
              </p>
            ) : (
              <div className="max-h-64 overflow-y-auto rounded-2xl border border-white/10 bg-[#0B0C10] divide-y divide-white/5">
                {bankFiles.map((file) => (
                  <div
                    key={file.filename}
                    className="px-4 py-2.5 flex items-center justify-between gap-3 text-xs"
                  >
                    <span className="font-mono text-[#F7F4EC] truncate">{file.filename}</span>
                    <div className="flex items-center gap-3 shrink-0 text-[#9CA3AF]">
                      <span className="tabular-nums">{(file.sizeBytes / 1024).toFixed(1)} KB</span>
                      <a
                        href={file.url}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="text-[#F5D97E] hover:underline"
                      >
                        Ouvir
                      </a>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>
        </section>
      </main>
    </div>
  );
};
