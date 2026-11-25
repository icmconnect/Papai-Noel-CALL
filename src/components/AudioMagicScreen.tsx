import React, {useEffect, useState} from 'react';
import {
  AlertTriangle,
  ArrowLeft,
  Check,
  Copy,
  Download,
  Loader2,
  Play,
  RotateCcw,
  Share2,
  Sparkles,
  Square,
  Video,
} from 'lucide-react';
import {CallConfig, PreparedAudioMagic} from '../types';
import {playSantaAudio, stopCurrentSantaVoice, unlockAudioContext} from '../utils/audioEngine';

interface AudioMagicScreenProps {
  config: CallConfig;
  audioMedia: PreparedAudioMagic | null;
  isLoading: boolean;
  error: string | null;
  onRetry: () => void;
  onUpgradeToVideoCall: () => void;
  onBackHome: () => void;
}

function slugifyFilename(name: string): string {
  const slug = (name || 'crianca')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return slug || 'crianca';
}

function resolveFileExtension(mimeType: string | null | undefined): string {
  const lower = (mimeType || '').toLowerCase();
  if (lower.includes('mpeg') || lower.includes('mp3')) return 'mp3';
  if (lower.includes('ogg')) return 'ogg';
  if (lower.includes('mp4') || lower.includes('m4a')) return 'm4a';
  return 'wav';
}

export const AudioMagicScreen: React.FC<AudioMagicScreenProps> = ({
  config,
  audioMedia,
  isLoading,
  error,
  onRetry,
  onUpgradeToVideoCall,
  onBackHome,
}) => {
  const [isPlaying, setIsPlaying] = useState(false);
  const [copiedLink, setCopiedLink] = useState(false);

  useEffect(() => {
    return () => {
      stopCurrentSantaVoice();
    };
  }, []);

  const audioBase64 = audioMedia?.audioBase64 || null;
  const audioMimeType = audioMedia?.audioMimeType || audioMedia?.mimeType || 'audio/wav';
  const audioText = audioMedia?.audioText || '';
  const shareUrl =
    audioMedia?.shareUrl || (typeof window !== 'undefined' ? window.location.href : '');

  const downloadDataUri = audioBase64
    ? `data:${audioMimeType};base64,${audioBase64}`
    : undefined;
  const downloadFilename = `audio-papai-noel-${slugifyFilename(config.childName)}.${resolveFileExtension(audioMimeType)}`;

  const whatsappText = encodeURIComponent(
    `Olha que emocionante! O Papai Noel gravou um Áudio Mágico exclusivo para ${
      config.childName || 'nossa criança'
    }! Ouça aqui: ${shareUrl}`
  );
  const whatsappHref = `https://wa.me/?text=${whatsappText}`;

  const handleTogglePlay = async () => {
    if (!audioBase64) return;
    if (isPlaying) {
      stopCurrentSantaVoice();
      setIsPlaying(false);
      return;
    }

    unlockAudioContext();
    await playSantaAudio({
      audioBase64,
      audioMimeType,
      fallbackText: '',
      useBrowserFallback: false,
      disableBrowserFallback: true,
      onStart: () => {
        setIsPlaying(true);
      },
      onEnd: () => {
        setIsPlaying(false);
      },
    });
  };

  const handleCopyShareUrl = async () => {
    if (!shareUrl) return;
    try {
      await navigator.clipboard.writeText(shareUrl);
      setCopiedLink(true);
      window.setTimeout(() => setCopiedLink(false), 2400);
    } catch {
      // Clipboard fallback ignored
    }
  };

  const handleUpsellClick = () => {
    stopCurrentSantaVoice();
    setIsPlaying(false);
    onUpgradeToVideoCall();
  };

  const hasAudioError = !isLoading && (Boolean(error) || (audioMedia !== null && !audioBase64));
  const resolvedErrorMessage =
    error ||
    audioMedia?.ttsError ||
    'Não foi possível gerar o Áudio Mágico do Papai Noel agora. Tente novamente.';

  return (
    <div className="relative z-10 min-h-[100dvh] flex flex-col justify-between px-4 sm:px-6 py-6">
      <header className="w-full max-w-lg mx-auto flex items-center justify-between">
        <button
          type="button"
          onClick={() => {
            stopCurrentSantaVoice();
            setIsPlaying(false);
            onBackHome();
          }}
          className="min-h-[44px] px-3 -ml-2 rounded-xl flex items-center gap-2 text-sm font-medium text-[#D1D5DB] hover:text-white hover:bg-white/5 transition-colors cursor-pointer"
        >
          <ArrowLeft className="w-4 h-4" aria-hidden="true" />
          <span>Início</span>
        </button>
        <span className="inline-flex items-center gap-1.5 text-[11px] font-bold tracking-wider uppercase text-[#0B0C10] bg-[#D4AF37] px-2.5 py-1 rounded-md">
          <Sparkles className="w-3 h-3" aria-hidden="true" />
          Áudio Mágico
        </span>
      </header>

      <main className="w-full max-w-lg mx-auto my-auto py-6 space-y-5">
        <div className="rounded-3xl border border-[#D4AF37]/40 bg-[#13151C]/95 backdrop-blur-xl p-6 sm:p-8 shadow-2xl text-center space-y-6">
          {/* Santa Artwork */}
          <div className="relative w-32 h-32 mx-auto">
            <span
              className={`absolute -inset-2.5 rounded-full border-2 border-[#D4AF37]/50 pointer-events-none ${
                isPlaying ? 'animate-ping' : ''
              }`}
              aria-hidden="true"
            />
            <div className="w-32 h-32 rounded-full overflow-hidden ring-2 ring-[#D4AF37] shadow-[0_0_32px_rgba(212,175,55,0.4)] bg-[#0B0C10] relative z-10">
              <img
                src="/santa-avatar.png"
                alt="Papai Noel"
                className="w-full h-full object-cover"
              />
            </div>
          </div>

          <div className="space-y-1.5">
            <p className="text-xs font-semibold uppercase tracking-widest text-[#D4AF37]">
              Mensagem de Voz do Polo Norte
            </p>
            <h1
              className="text-2xl sm:text-3xl font-semibold text-[#F7F4EC]"
              style={{fontFamily: 'var(--font-display)'}}
            >
              Para {config.childName || 'Você'}
            </h1>
          </div>

          {isLoading && (
            <div
              role="status"
              className="rounded-2xl border border-[#D4AF37]/35 bg-[#0B0C10]/80 px-4 py-5 flex flex-col items-center gap-3"
            >
              <Loader2 className="w-6 h-6 animate-spin text-[#D4AF37]" aria-hidden="true" />
              <span className="text-sm font-medium text-[#F5D97E]">
                Preparando seu áudio mágico…
              </span>
            </div>
          )}

          {hasAudioError && (
            <div
              role="alert"
              className="rounded-2xl border border-amber-400/40 bg-amber-950/30 p-5 space-y-3 text-center"
            >
              <div className="w-10 h-10 mx-auto rounded-full bg-amber-500/15 border border-amber-400/40 flex items-center justify-center text-[#F5D97E]">
                <AlertTriangle className="w-5 h-5" aria-hidden="true" />
              </div>
              <p className="text-sm text-[#EFE9D8] leading-relaxed">{resolvedErrorMessage}</p>
              <button
                type="button"
                onClick={onRetry}
                className="w-full min-h-[46px] px-4 rounded-xl bg-[#D4AF37] text-[#0B0C10] font-bold text-sm flex items-center justify-center gap-2 hover:bg-[#E5C454] cursor-pointer"
              >
                <RotateCcw className="w-4 h-4" aria-hidden="true" />
                <span>Tentar novamente</span>
              </button>
            </div>
          )}

          {!isLoading && !hasAudioError && audioBase64 && (
            <>
              {audioText && (
                <blockquote className="rounded-2xl border border-white/10 bg-[#0B0C10]/85 px-4 py-3.5 text-sm text-[#EFE9D8] leading-relaxed italic">
                  “{audioText}”
                </blockquote>
              )}

              {/* Primary Player Controls: Ouvir + Baixar + Compartilhar WhatsApp */}
              <div className="space-y-3">
                <button
                  type="button"
                  onClick={handleTogglePlay}
                  className="w-full min-h-[54px] px-6 rounded-2xl bg-gradient-to-r from-[#D4AF37] to-[#F3E5AB] text-[#0B0C10] font-bold text-base flex items-center justify-center gap-2.5 shadow-[0_10px_28px_rgba(212,175,55,0.35)] hover:brightness-105 active:scale-[0.98] transition-all cursor-pointer"
                >
                  {isPlaying ? (
                    <>
                      <Square className="w-4 h-4 fill-current" aria-hidden="true" />
                      <span>Parar Áudio</span>
                    </>
                  ) : (
                    <>
                      <Play className="w-5 h-5 fill-current" aria-hidden="true" />
                      <span>Ouvir</span>
                    </>
                  )}
                </button>

                <div className="grid grid-cols-1 sm:grid-cols-2 gap-2.5">
                  <a
                    href={downloadDataUri}
                    download={downloadFilename}
                    className="min-h-[48px] px-4 rounded-xl border border-[#D4AF37]/45 bg-[#191B24] hover:bg-[#222531] text-sm font-semibold text-[#F5D97E] flex items-center justify-center gap-2 transition-colors"
                  >
                    <Download className="w-4 h-4" aria-hidden="true" />
                    <span>Baixar</span>
                  </a>

                  <a
                    href={whatsappHref}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="min-h-[48px] px-4 rounded-xl bg-emerald-600 hover:bg-emerald-500 text-white font-semibold text-sm flex items-center justify-center gap-2 shadow-[0_8px_20px_rgba(16,185,129,0.28)] transition-colors"
                  >
                    <Share2 className="w-4 h-4" aria-hidden="true" />
                    <span>Compartilhar no WhatsApp</span>
                  </a>
                </div>

                {shareUrl && (
                  <button
                    type="button"
                    onClick={handleCopyShareUrl}
                    className="w-full min-h-[42px] px-4 rounded-xl border border-white/15 text-xs font-medium text-[#D1D5DB] hover:bg-white/5 flex items-center justify-center gap-2 cursor-pointer"
                  >
                    {copiedLink ? (
                      <>
                        <Check className="w-3.5 h-3.5 text-emerald-400" aria-hidden="true" />
                        <span>Link copiado!</span>
                      </>
                    ) : (
                      <>
                        <Copy className="w-3.5 h-3.5" aria-hidden="true" />
                        <span>Copiar link do áudio</span>
                      </>
                    )}
                  </button>
                )}
              </div>
            </>
          )}
        </div>

        {/* Upsell Card: Transformar em chamada de vídeo por +R$ 5 */}
        <div className="rounded-2xl border border-[#D4AF37]/45 bg-gradient-to-br from-[#231D0F] via-[#171922] to-[#13151C] p-5 space-y-3.5 shadow-xl">
          <div className="flex items-center gap-2 text-xs font-bold uppercase tracking-wider text-[#F5D97E]">
            <Video className="w-4 h-4 text-[#D4AF37] shrink-0" aria-hidden="true" />
            <span>Oferta Especial</span>
          </div>
          <div className="space-y-1">
            <h2
              className="text-lg font-semibold text-[#F7F4EC]"
              style={{fontFamily: 'var(--font-display)'}}
            >
              Transformar em chamada de vídeo por +R$ 5
            </h2>
            <p className="text-xs sm:text-sm text-[#C7C2B6] leading-relaxed">
              Leve a magia para a tela inteira com o Papai Noel ligando ao vivo para{' '}
              <strong className="text-white">{config.childName || 'sua criança'}</strong> com os
              dados já preenchidos!
            </p>
          </div>
          <button
            type="button"
            onClick={handleUpsellClick}
            className="w-full min-h-[48px] px-5 rounded-xl bg-[#D4AF37] text-[#0B0C10] font-bold text-sm flex items-center justify-center gap-2 hover:bg-[#E5C454] active:scale-[0.98] transition-all cursor-pointer"
          >
            <Video className="w-4 h-4" aria-hidden="true" />
            <span>Transformar em chamada de vídeo por +R$ 5</span>
          </button>
        </div>
      </main>

      <footer className="w-full max-w-lg mx-auto text-center text-[11px] text-[#8D887C]">
        Áudio Mágico do Papai Noel · Compatível com iPhone Safari e Android Chrome
      </footer>
    </div>
  );
};
