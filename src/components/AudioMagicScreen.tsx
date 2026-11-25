import React, {useEffect, useMemo, useRef, useState} from 'react';
import {
  AlertTriangle,
  ArrowLeft,
  Check,
  Clock,
  Copy,
  Download,
  FolderHeart,
  Image as ImageIcon,
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
  publicAppUrl?: string;
  parentId?: string | null;
  onRetry: () => void;
  onSilentRetry?: () => void;
  onUpgradeToVideoCall: () => void;
  onOpenMyMagics?: () => void;
  onBackHome: () => void;
}

const MAX_AUTO_RETRIES = 3;
const AUTO_RETRY_INTERVAL_MS = 20000;

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

function appendRefParam(url: string, parentId?: string | null): string {
  if (!url || !parentId) return url;
  try {
    const parsed = new URL(url);
    if (!parsed.searchParams.get('ref')) {
      parsed.searchParams.set('ref', parentId);
    }
    return parsed.toString();
  } catch {
    return url;
  }
}

function extractDomainLabel(url: string): string {
  try {
    return new URL(url).hostname;
  } catch {
    return typeof window !== 'undefined' ? window.location.hostname : 'Polo Norte';
  }
}

function base64ToUint8Array(base64: string): Uint8Array {
  const binStr = window.atob(base64);
  const len = binStr.length;
  const bytes = new Uint8Array(len);
  for (let i = 0; i < len; i++) {
    bytes[i] = binStr.charCodeAt(i);
  }
  return bytes;
}

function triggerAnchorDownload(href: string, filename: string): void {
  const link = document.createElement('a');
  link.href = href;
  link.download = filename;
  link.rel = 'noopener noreferrer';
  link.style.display = 'none';
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
}

async function generateSantaCardPngBlob(childName: string, domainLabel: string): Promise<Blob | null> {
  if (typeof document === 'undefined') return null;
  const width = 1080;
  const height = 1350;
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d');
  if (!ctx) return null;

  // Festive dark midnight background gradient
  const bg = ctx.createLinearGradient(0, 0, 0, height);
  bg.addColorStop(0, '#0B0C10');
  bg.addColorStop(0.55, '#151824');
  bg.addColorStop(1, '#0D0F16');
  ctx.fillStyle = bg;
  ctx.fillRect(0, 0, width, height);

  // Subtle warm radial glow behind Santa
  const glow = ctx.createRadialGradient(width / 2, 420, 40, width / 2, 420, 440);
  glow.addColorStop(0, 'rgba(212, 175, 55, 0.28)');
  glow.addColorStop(1, 'rgba(212, 175, 55, 0)');
  ctx.fillStyle = glow;
  ctx.fillRect(0, 0, width, height);

  // Decorative snow / gold stars
  for (let i = 0; i < 42; i++) {
    const x = ((i * 197 + 73) % (width - 120)) + 60;
    const y = ((i * 313 + 91) % (height - 140)) + 70;
    const r = (i % 3) + 1.5;
    ctx.fillStyle = i % 4 === 0 ? 'rgba(245, 217, 126, 0.55)' : 'rgba(247, 244, 236, 0.28)';
    ctx.beginPath();
    ctx.arc(x, y, r, 0, Math.PI * 2);
    ctx.fill();
  }

  // Outer & inner golden borders
  ctx.strokeStyle = 'rgba(212, 175, 55, 0.75)';
  ctx.lineWidth = 6;
  ctx.strokeRect(42, 42, width - 84, height - 84);
  ctx.strokeStyle = 'rgba(212, 175, 55, 0.28)';
  ctx.lineWidth = 2;
  ctx.strokeRect(62, 62, width - 124, height - 124);

  // Top header text
  ctx.textAlign = 'center';
  ctx.fillStyle = '#D4AF37';
  ctx.font = 'bold 28px "Plus Jakarta Sans", system-ui, sans-serif';
  ctx.fillText('MENSAGEM MÁGICA DO POLO NORTE', width / 2, 148);

  // Santa Avatar inside golden ring
  const avatarX = width / 2;
  const avatarY = 420;
  const avatarRadius = 210;

  try {
    const img = await new Promise<HTMLImageElement>((resolve, reject) => {
      const image = new Image();
      image.crossOrigin = 'anonymous';
      image.onload = () => resolve(image);
      image.onerror = () => reject(new Error('Falha ao carregar imagem'));
      image.src = '/santa-avatar.png';
    });

    ctx.save();
    ctx.beginPath();
    ctx.arc(avatarX, avatarY, avatarRadius, 0, Math.PI * 2);
    ctx.closePath();
    ctx.clip();

    const scale = Math.max((avatarRadius * 2) / img.width, (avatarRadius * 2) / img.height);
    const drawW = img.width * scale;
    const drawH = img.height * scale;
    ctx.drawImage(img, avatarX - drawW / 2, avatarY - drawH / 2, drawW, drawH);
    ctx.restore();
  } catch {
    ctx.fillStyle = '#1D202B';
    ctx.beginPath();
    ctx.arc(avatarX, avatarY, avatarRadius, 0, Math.PI * 2);
    ctx.fill();
  }

  ctx.strokeStyle = '#D4AF37';
  ctx.lineWidth = 10;
  ctx.beginPath();
  ctx.arc(avatarX, avatarY, avatarRadius + 4, 0, Math.PI * 2);
  ctx.stroke();

  // "Para {nome}" Title
  const safeName = (childName || 'Você').trim().slice(0, 32);
  ctx.fillStyle = '#F7F4EC';
  ctx.font = 'bold 74px Georgia, "Fraunces", serif';
  ctx.fillText(`Para ${safeName}`, width / 2, 760);

  // Festive subtitle
  ctx.fillStyle = '#F5D97E';
  ctx.font = '600 36px Georgia, "Fraunces", serif';
  ctx.fillText('Áudio Especial do Papai Noel · Feliz Natal!', width / 2, 845);

  // Divider line
  ctx.strokeStyle = 'rgba(212, 175, 55, 0.45)';
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.moveTo(220, 930);
  ctx.lineTo(width - 220, 930);
  ctx.stroke();

  // Quote hint
  ctx.fillStyle = '#C7C2B6';
  ctx.font = '400 30px "Plus Jakarta Sans", system-ui, sans-serif';
  ctx.fillText('Guarde este recado mágico para ouvir sempre que quiser.', width / 2, 1010);

  // Domain pill at bottom
  const pillW = Math.min(820, Math.max(460, domainLabel.length * 20 + 120));
  const pillH = 74;
  const pillX = (width - pillW) / 2;
  const pillY = 1140;
  ctx.fillStyle = 'rgba(212, 175, 55, 0.14)';
  ctx.strokeStyle = 'rgba(212, 175, 55, 0.65)';
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.roundRect(pillX, pillY, pillW, pillH, 18);
  ctx.fill();
  ctx.stroke();

  ctx.fillStyle = '#F5D97E';
  ctx.font = 'bold 28px "JetBrains Mono", monospace';
  ctx.fillText(domainLabel, width / 2, pillY + 47);

  return await new Promise<Blob | null>((resolve) => {
    canvas.toBlob((blob) => resolve(blob), 'image/png');
  });
}

export const AudioMagicScreen: React.FC<AudioMagicScreenProps> = ({
  config,
  audioMedia,
  isLoading,
  error,
  publicAppUrl,
  parentId,
  onRetry,
  onSilentRetry,
  onUpgradeToVideoCall,
  onOpenMyMagics,
  onBackHome,
}) => {
  const [isPlaying, setIsPlaying] = useState(false);
  const [copiedLink, setCopiedLink] = useState(false);
  const [autoRetryCount, setAutoRetryCount] = useState(0);
  const [autoRetrySecondsLeft, setAutoRetrySecondsLeft] = useState<number | null>(null);
  const [isPackaging, setIsPackaging] = useState(false);
  const [packageReady, setPackageReady] = useState(false);
  const [cardPngUrl, setCardPngUrl] = useState<string | null>(null);
  const [cardPngBlob, setCardPngBlob] = useState<Blob | null>(null);
  const [audioBlobUrl, setAudioBlobUrl] = useState<string | null>(null);
  const [audioBlob, setAudioBlob] = useState<Blob | null>(null);
  const [canNativeFileShare, setCanNativeFileShare] = useState(false);

  const autoRetryTimerRef = useRef<number | null>(null);
  const autoRetryTickRef = useRef<number | null>(null);

  useEffect(() => {
    return () => {
      stopCurrentSantaVoice();
      if (autoRetryTimerRef.current !== null) window.clearTimeout(autoRetryTimerRef.current);
      if (autoRetryTickRef.current !== null) window.clearInterval(autoRetryTickRef.current);
    };
  }, []);

  const audioBase64 = audioMedia?.audioBase64 || null;
  const audioMimeType = audioMedia?.audioMimeType || audioMedia?.mimeType || 'audio/wav';
  const audioText = audioMedia?.audioText || '';
  const rawShareUrl =
    audioMedia?.shareUrl ||
    publicAppUrl ||
    (typeof window !== 'undefined' ? window.location.href : '');
  const shareUrl = useMemo(
    () => appendRefParam(rawShareUrl, parentId),
    [parentId, rawShareUrl]
  );
  const domainLabel = useMemo(
    () => extractDomainLabel(publicAppUrl || shareUrl),
    [publicAppUrl, shareUrl]
  );

  const fileSlug = slugifyFilename(config.childName);
  const audioFilename = `audio-papai-noel-${fileSlug}.${resolveFileExtension(audioMimeType)}`;
  const cardFilename = `cartela-papai-noel-${fileSlug}.png`;

  const hasAudioError = !isLoading && (Boolean(error) || (audioMedia !== null && !audioBase64));
  const isQuotaError = Boolean(
    audioMedia?.isQuotaError ||
      /429|RESOURCE_EXHAUSTED|limite|cota/i.test(error || audioMedia?.ttsError || '')
  );
  const resolvedErrorMessage =
    error ||
    audioMedia?.ttsError ||
    'Não foi possível gerar o Áudio Mágico do Papai Noel agora. Tente novamente.';

  // Build Blob URLs for audio + Canvas PNG card as soon as audioBase64 arrives (iOS Safari + Android Chrome safe)
  useEffect(() => {
    if (!audioBase64) {
      setAudioBlob(null);
      setAudioBlobUrl(null);
      setCardPngBlob(null);
      setCardPngUrl(null);
      return;
    }

    let revoked = false;
    let localAudioUrl: string | null = null;
    let localCardUrl: string | null = null;

    try {
      const bytes = base64ToUint8Array(audioBase64);
      const aBlob = new Blob([bytes.buffer as ArrayBuffer], {type: audioMimeType});
      localAudioUrl = URL.createObjectURL(aBlob);
      setAudioBlob(aBlob);
      setAudioBlobUrl(localAudioUrl);
    } catch {
      setAudioBlob(null);
      setAudioBlobUrl(null);
    }

    void generateSantaCardPngBlob(config.childName, domainLabel).then((pngBlob) => {
      if (revoked || !pngBlob) return;
      localCardUrl = URL.createObjectURL(pngBlob);
      setCardPngBlob(pngBlob);
      setCardPngUrl(localCardUrl);
    });

    return () => {
      revoked = true;
      if (localAudioUrl) URL.revokeObjectURL(localAudioUrl);
      if (localCardUrl) URL.revokeObjectURL(localCardUrl);
    };
  }, [audioBase64, audioMimeType, config.childName, domainLabel]);

  useEffect(() => {
    if (!audioBlob || !cardPngBlob || typeof navigator === 'undefined') {
      setCanNativeFileShare(false);
      return;
    }
    try {
      const nav = navigator as Navigator & {canShare?: (data?: ShareData) => boolean};
      if (typeof nav.share === 'function' && typeof nav.canShare === 'function') {
        const files = [
          new File([audioBlob], audioFilename, {type: audioMimeType}),
          new File([cardPngBlob], cardFilename, {type: 'image/png'}),
        ];
        setCanNativeFileShare(nav.canShare({files}));
      } else {
        setCanNativeFileShare(false);
      }
    } catch {
      setCanNativeFileShare(false);
    }
  }, [audioBlob, audioFilename, audioMimeType, cardFilename, cardPngBlob]);

  // Silent auto-retry every 20s (max 3 attempts) when audio fails / hits quota
  useEffect(() => {
    if (autoRetryTimerRef.current !== null) {
      window.clearTimeout(autoRetryTimerRef.current);
      autoRetryTimerRef.current = null;
    }
    if (autoRetryTickRef.current !== null) {
      window.clearInterval(autoRetryTickRef.current);
      autoRetryTickRef.current = null;
    }

    if (audioBase64) {
      setAutoRetryCount(0);
      setAutoRetrySecondsLeft(null);
      return;
    }

    if (!hasAudioError || autoRetryCount >= MAX_AUTO_RETRIES) {
      setAutoRetrySecondsLeft(null);
      return;
    }

    const deadlineMs = Date.now() + AUTO_RETRY_INTERVAL_MS;
    setAutoRetrySecondsLeft(Math.ceil(AUTO_RETRY_INTERVAL_MS / 1000));

    autoRetryTickRef.current = window.setInterval(() => {
      const left = Math.max(0, Math.ceil((deadlineMs - Date.now()) / 1000));
      setAutoRetrySecondsLeft(left);
    }, 1000);

    autoRetryTimerRef.current = window.setTimeout(() => {
      autoRetryTimerRef.current = null;
      if (autoRetryTickRef.current !== null) {
        window.clearInterval(autoRetryTickRef.current);
        autoRetryTickRef.current = null;
      }
      setAutoRetrySecondsLeft(null);
      setAutoRetryCount((c) => c + 1);
      if (onSilentRetry) {
        onSilentRetry();
      } else {
        onRetry();
      }
    }, AUTO_RETRY_INTERVAL_MS);

    return () => {
      if (autoRetryTimerRef.current !== null) {
        window.clearTimeout(autoRetryTimerRef.current);
        autoRetryTimerRef.current = null;
      }
      if (autoRetryTickRef.current !== null) {
        window.clearInterval(autoRetryTickRef.current);
        autoRetryTickRef.current = null;
      }
    };
  }, [audioBase64, autoRetryCount, hasAudioError, onRetry, onSilentRetry]);

  const whatsappText = encodeURIComponent(
    `Olha que emocionante! O Papai Noel gravou um Áudio Mágico exclusivo para ${
      config.childName || 'nossa criança'
    } no ${domainLabel}! Ouça aqui: ${shareUrl}`
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

  const handleDownloadPackage = async () => {
    if (!audioBase64) return;
    setIsPackaging(true);
    try {
      let currentAudioUrl = audioBlobUrl;
      if (!currentAudioUrl) {
        const bytes = base64ToUint8Array(audioBase64);
        const blob = new Blob([bytes.buffer as ArrayBuffer], {type: audioMimeType});
        currentAudioUrl = URL.createObjectURL(blob);
        setAudioBlob(blob);
        setAudioBlobUrl(currentAudioUrl);
      }

      // 1. Trigger audio download immediately inside user tap (works on iOS Safari & Android Chrome)
      triggerAnchorDownload(currentAudioUrl, audioFilename);

      // 2. Ensure PNG card is generated and trigger second download
      let currentCardUrl = cardPngUrl;
      if (!currentCardUrl) {
        const pngBlob = await generateSantaCardPngBlob(config.childName, domainLabel);
        if (pngBlob) {
          currentCardUrl = URL.createObjectURL(pngBlob);
          setCardPngBlob(pngBlob);
          setCardPngUrl(currentCardUrl);
        }
      }

      setPackageReady(true);

      if (currentCardUrl) {
        const targetUrl = currentCardUrl;
        window.setTimeout(() => {
          triggerAnchorDownload(targetUrl, cardFilename);
        }, 420);
      }
    } finally {
      setIsPackaging(false);
    }
  };

  const handleNativeSharePackage = async () => {
    if (!audioBlob || !cardPngBlob) return;
    try {
      const files = [
        new File([audioBlob], audioFilename, {type: audioMimeType}),
        new File([cardPngBlob], cardFilename, {type: 'image/png'}),
      ];
      await navigator.share({
        title: `Áudio Mágico do Papai Noel para ${config.childName || 'Você'}`,
        text: `Recado do Papai Noel em ${domainLabel}`,
        files,
      });
    } catch {
      // User dismissed share sheet
    }
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

  return (
    <div className="relative z-10 min-h-[100dvh] flex flex-col justify-between px-4 sm:px-6 py-6">
      <header className="w-full max-w-lg mx-auto flex items-center justify-between gap-2">
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

        <div className="flex items-center gap-2">
          {onOpenMyMagics && (
            <button
              type="button"
              onClick={() => {
                stopCurrentSantaVoice();
                setIsPlaying(false);
                onOpenMyMagics();
              }}
              className="min-h-[38px] px-3 rounded-xl border border-[#D4AF37]/40 bg-[#13151C] text-xs font-semibold text-[#F5D97E] hover:bg-[#1C1F2B] flex items-center gap-1.5 cursor-pointer"
            >
              <FolderHeart className="w-3.5 h-3.5" aria-hidden="true" />
              <span>Minhas magias</span>
            </button>
          )}
          <span className="inline-flex items-center gap-1.5 text-[11px] font-bold tracking-wider uppercase text-[#0B0C10] bg-[#D4AF37] px-2.5 py-1 rounded-md">
            <Sparkles className="w-3 h-3" aria-hidden="true" />
            Áudio Mágico
          </span>
        </div>
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

              <div className="rounded-xl border border-[#D4AF37]/35 bg-[#0B0C10]/70 px-3.5 py-2.5 text-xs text-[#F5D97E] space-y-1">
                <p className="font-semibold flex items-center justify-center gap-1.5">
                  <Clock className="w-3.5 h-3.5 shrink-0" aria-hidden="true" />
                  <span>Seu link continua válido; o áudio fica pronto em até 2 min.</span>
                </p>
                {autoRetryCount < MAX_AUTO_RETRIES && autoRetrySecondsLeft !== null ? (
                  <p className="text-[#C7C2B6]">
                    Tentativa automática {autoRetryCount + 1}/{MAX_AUTO_RETRIES} em{' '}
                    {autoRetrySecondsLeft}s...
                  </p>
                ) : (
                  <p className="text-[#C7C2B6]">
                    {isQuotaError
                      ? 'Fila momentânea no Polo Norte. Clique abaixo para tentar novamente.'
                      : 'Clique abaixo para gerar novamente.'}
                  </p>
                )}
              </div>

              <button
                type="button"
                onClick={() => {
                  setAutoRetryCount(0);
                  onRetry();
                }}
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

              {/* Primary Player Controls: Ouvir + Baixar Pacote (Áudio + Cartela PNG) + WhatsApp */}
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
                  <button
                    type="button"
                    onClick={() => void handleDownloadPackage()}
                    disabled={isPackaging}
                    className="min-h-[48px] px-4 rounded-xl border border-[#D4AF37]/45 bg-[#191B24] hover:bg-[#222531] text-sm font-semibold text-[#F5D97E] flex items-center justify-center gap-2 transition-colors cursor-pointer disabled:opacity-60"
                  >
                    {isPackaging ? (
                      <Loader2 className="w-4 h-4 animate-spin" aria-hidden="true" />
                    ) : (
                      <Download className="w-4 h-4" aria-hidden="true" />
                    )}
                    <span>Baixar Pacote</span>
                  </button>

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

                {(packageReady || cardPngUrl) && (
                  <div className="rounded-2xl border border-[#D4AF37]/30 bg-[#0B0C10]/90 p-3.5 space-y-3 text-left">
                    <div className="flex items-center gap-3">
                      {cardPngUrl && (
                        <img
                          src={cardPngUrl}
                          alt={`Cartela PNG para ${config.childName || 'Você'}`}
                          className="w-14 h-18 rounded-lg object-cover border border-[#D4AF37]/50 shrink-0"
                        />
                      )}
                      <div className="min-w-0 flex-1 space-y-1">
                        <p className="text-xs font-semibold text-[#F5D97E]">
                          Pacote pronto (Áudio + Cartela PNG)
                        </p>
                        <p className="text-[11px] text-[#A8A396] leading-snug">
                          No iPhone Safari ou Android Chrome, toque para salvar separadamente se o
                          navegador bloquear downloads simultâneos:
                        </p>
                      </div>
                    </div>

                    <div className="flex flex-wrap gap-2">
                      {audioBlobUrl && (
                        <a
                          href={audioBlobUrl}
                          download={audioFilename}
                          className="flex-1 min-w-[130px] min-h-[40px] px-3 rounded-lg border border-white/15 bg-[#161923] hover:bg-[#1E2230] text-xs font-semibold text-[#F7F4EC] flex items-center justify-center gap-1.5"
                        >
                          <Download className="w-3.5 h-3.5 text-[#D4AF37]" aria-hidden="true" />
                          <span>Salvar Áudio</span>
                        </a>
                      )}
                      {cardPngUrl && (
                        <a
                          href={cardPngUrl}
                          download={cardFilename}
                          className="flex-1 min-w-[130px] min-h-[40px] px-3 rounded-lg border border-[#D4AF37]/40 bg-[#1B1810] hover:bg-[#262114] text-xs font-semibold text-[#F5D97E] flex items-center justify-center gap-1.5"
                        >
                          <ImageIcon className="w-3.5 h-3.5" aria-hidden="true" />
                          <span>Salvar Cartela PNG</span>
                        </a>
                      )}
                      {canNativeFileShare && (
                        <button
                          type="button"
                          onClick={() => void handleNativeSharePackage()}
                          className="w-full min-h-[40px] px-3 rounded-lg bg-[#D4AF37] text-[#0B0C10] text-xs font-bold flex items-center justify-center gap-1.5 cursor-pointer hover:bg-[#E5C454]"
                        >
                          <Share2 className="w-3.5 h-3.5" aria-hidden="true" />
                          <span>Salvar / Enviar Pacote (iOS e Android)</span>
                        </button>
                      )}
                    </div>
                  </div>
                )}

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
        Áudio Mágico do Papai Noel · {domainLabel} · Compatível com iPhone Safari e Android Chrome
      </footer>
    </div>
  );
};
