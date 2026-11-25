// Mobile-safe AudioContext + HTMLAudio fallback engine for iOS Safari & Android Chrome

let sharedAudioCtx: AudioContext | null = null;
let activeSourceNode: AudioBufferSourceNode | null = null;
let activeNodeCleanup: (() => void) | null = null;
let activeHtmlAudio: HTMLAudioElement | null = null;
let activeTimerId: number | null = null;
let activeAnimFrameId: number | null = null;
let ringtoneTimer: number | null = null;
let activePlaybackGeneration = 0;

export interface PlaySantaAudioResult {
  playedSource: 'audiocontext' | 'htmlaudio' | 'browser' | 'none';
  error?: string;
}

function getAudioContextClass(): typeof AudioContext | undefined {
  const win = window as unknown as {
    AudioContext?: typeof AudioContext;
    webkitAudioContext?: typeof AudioContext;
  };
  return win.AudioContext || win.webkitAudioContext;
}

export function getOrCreateAudioContext(): AudioContext | null {
  if (typeof window === 'undefined') return null;
  if (!sharedAudioCtx) {
    const Ctx = getAudioContextClass();
    if (!Ctx) return null;
    sharedAudioCtx = new Ctx();
  }
  return sharedAudioCtx;
}

/**
 * Calculates normalized speech energy strictly inside the human vocal band (300 Hz - 3400 Hz).
 */
function computeSpeechBandVolume(
  analyser: AnalyserNode,
  freqData: Uint8Array<ArrayBuffer>,
  sampleRate: number
): number {
  analyser.getByteFrequencyData(freqData);
  const binHz = sampleRate / analyser.fftSize;
  if (!Number.isFinite(binHz) || binHz <= 0) return 0;

  const minBin = Math.max(0, Math.floor(300 / binHz));
  const maxBin = Math.min(freqData.length - 1, Math.ceil(3400 / binHz));
  if (maxBin < minBin) return 0;

  let sum = 0;
  let count = 0;
  for (let i = minBin; i <= maxBin; i++) {
    sum += freqData[i];
    count += 1;
  }
  return count > 0 ? sum / count / 255 : 0;
}

/**
 * MUST be invoked synchronously inside the "Atender" button click handler.
 * Resumes the AudioContext and plays a 1-sample silent buffer to unlock
 * future asynchronous audio playback on iOS Safari & Android Chrome.
 */
export function unlockAudioContext(): AudioContext | null {
  const ctx = getOrCreateAudioContext();
  if (!ctx) return null;

  if (ctx.state === 'suspended') {
    ctx.resume().catch(() => undefined);
  }

  try {
    const buffer = ctx.createBuffer(1, 1, 22050);
    const source = ctx.createBufferSource();
    source.buffer = buffer;
    source.connect(ctx.destination);
    source.start(0);
  } catch {
    // Ignore if already unlocked
  }

  return ctx;
}

/**
 * Plays sparkling Christmas sleigh-bell chimes when checking the Nice List.
 * Must be triggered from a user gesture so iOS/Android allows AudioContext playback.
 */
export function playMagicBellsSound(): void {
  const ctx = unlockAudioContext();
  if (!ctx) return;

  const scheduleNotes = () => {
    const now = ctx.currentTime;
    const notes = [
      {freq: 659.25, delay: 0, duration: 0.5},
      {freq: 783.99, delay: 0.11, duration: 0.5},
      {freq: 1046.5, delay: 0.22, duration: 0.65},
      {freq: 1318.51, delay: 0.34, duration: 0.75},
      {freq: 1567.98, delay: 0.48, duration: 1.0},
    ];

    notes.forEach(({freq, delay, duration}) => {
      try {
        const osc = ctx.createOscillator();
        const harmonic = ctx.createOscillator();
        const gain = ctx.createGain();

        osc.type = 'sine';
        osc.frequency.setValueAtTime(freq, now + delay);

        harmonic.type = 'triangle';
        harmonic.frequency.setValueAtTime(freq * 2, now + delay);

        gain.gain.setValueAtTime(0.0001, now + delay);
        gain.gain.exponentialRampToValueAtTime(0.11, now + delay + 0.02);
        gain.gain.exponentialRampToValueAtTime(0.0001, now + delay + duration);

        osc.connect(gain);
        harmonic.connect(gain);
        gain.connect(ctx.destination);

        osc.start(now + delay);
        harmonic.start(now + delay);
        osc.stop(now + delay + duration + 0.05);
        harmonic.stop(now + delay + duration + 0.05);
      } catch {
        // Ignore scheduling error
      }
    });
  };

  if (ctx.state === 'suspended') {
    ctx.resume().then(scheduleNotes).catch(() => undefined);
  } else {
    scheduleNotes();
  }
}

export function stopCurrentSantaVoice(): void {
  activePlaybackGeneration += 1;

  if (activeAnimFrameId !== null) {
    window.cancelAnimationFrame(activeAnimFrameId);
    activeAnimFrameId = null;
  }

  if (activeTimerId !== null) {
    window.clearTimeout(activeTimerId);
    activeTimerId = null;
  }

  if (activeSourceNode) {
    try {
      activeSourceNode.onended = null;
      activeSourceNode.stop();
    } catch {
      // Ignore already stopped source
    }
    activeSourceNode = null;
  }

  if (activeNodeCleanup) {
    try {
      activeNodeCleanup();
    } catch {
      // Ignore node disconnect errors
    }
    activeNodeCleanup = null;
  }

  if (activeHtmlAudio) {
    try {
      activeHtmlAudio.onended = null;
      activeHtmlAudio.onerror = null;
      activeHtmlAudio.pause();
      activeHtmlAudio.src = '';
    } catch {
      // Ignore already stopped HTMLAudio
    }
    activeHtmlAudio = null;
  }

  if (typeof window !== 'undefined' && 'speechSynthesis' in window) {
    try {
      window.speechSynthesis.cancel();
    } catch {
      // Ignore speechSynthesis cancel errors
    }
  }
}

function base64ToArrayBuffer(base64: string): ArrayBuffer {
  const sanitized = base64.replace(/[\r\n\s]/g, '').replace(/-/g, '+').replace(/_/g, '/');
  const pad = sanitized.length % 4 ? '='.repeat(4 - (sanitized.length % 4)) : '';
  const binary = window.atob(sanitized + pad);
  const len = binary.length;
  const bytes = new Uint8Array(len);
  for (let i = 0; i < len; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes.buffer;
}

function arrayBufferToBase64(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer);
  let binary = '';
  const chunkSize = 0x8000;
  for (let i = 0; i < bytes.length; i += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunkSize));
  }
  return window.btoa(binary);
}

function wrapL16PcmToWav(
  pcmBuffer: ArrayBuffer,
  audioMimeType?: string | null
): {buffer: ArrayBuffer; mimeType: string; wrapped: boolean} {
  const lower = (audioMimeType || '').toLowerCase();
  if (
    !lower.startsWith('audio/l16') &&
    !lower.startsWith('audio/pcm') &&
    !lower.startsWith('audio/raw')
  ) {
    return {buffer: pcmBuffer, mimeType: audioMimeType || 'audio/wav', wrapped: false};
  }

  const rateMatch = lower.match(/rate=(\d+)/);
  const sampleRate = rateMatch ? Number(rateMatch[1]) || 24000 : 24000;
  const pcmLen = pcmBuffer.byteLength;
  const wavBuffer = new ArrayBuffer(44 + pcmLen);
  const view = new DataView(wavBuffer);
  const writeStr = (offset: number, str: string) => {
    for (let i = 0; i < str.length; i++) {
      view.setUint8(offset + i, str.charCodeAt(i));
    }
  };

  writeStr(0, 'RIFF');
  view.setUint32(4, 36 + pcmLen, true);
  writeStr(8, 'WAVE');
  writeStr(12, 'fmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  writeStr(36, 'data');
  view.setUint32(40, pcmLen, true);
  new Uint8Array(wavBuffer, 44).set(new Uint8Array(pcmBuffer));

  return {buffer: wavBuffer, mimeType: 'audio/wav', wrapped: true};
}

function pickBestPortugueseVoice(): SpeechSynthesisVoice | null {
  if (typeof window === 'undefined' || !('speechSynthesis' in window)) return null;
  const voices = window.speechSynthesis.getVoices();
  if (!voices.length) return null;

  const ptVoices = voices.filter(
    (v) => v.lang.toLowerCase().startsWith('pt-br') || v.lang.toLowerCase().startsWith('pt')
  );
  if (!ptVoices.length) return null;

  const preferredMale = ptVoices.find((v) =>
    /antonio|daniel|felipe|tiago|ricardo|google|microsoft/i.test(v.name)
  );
  return preferredMale || ptVoices[0];
}

function speakWithBrowserFallback({
  text,
  reason,
  onStart,
  onEnd,
}: {
  text: string;
  reason: string;
  onStart?: () => void;
  onEnd?: () => void;
}): void {
  console.warn(
    `[AudioEngine] FALLBACK speechSynthesis ACIONADO (${reason}). Voz do sistema será usada em vez do Gemini TTS.`
  );

  let finished = false;
  const completeOnce = () => {
    if (finished) return;
    finished = true;
    if (activeTimerId !== null) {
      window.clearTimeout(activeTimerId);
      activeTimerId = null;
    }
    onEnd?.();
  };

  const estimatedMs = Math.min(9000, Math.max(2600, text.length * 65));

  if (typeof window !== 'undefined' && 'speechSynthesis' in window && text.trim()) {
    try {
      window.speechSynthesis.cancel();
      const utterance = new SpeechSynthesisUtterance(text);
      utterance.lang = 'pt-BR';
      utterance.pitch = 0.78;
      utterance.rate = 0.94;
      utterance.volume = 1;

      const voice = pickBestPortugueseVoice();
      if (voice) {
        utterance.voice = voice;
      }

      utterance.onend = () => completeOnce();
      utterance.onerror = () => completeOnce();

      onStart?.();
      window.speechSynthesis.speak(utterance);

      // Safety cap in case mobile Safari misses speechSynthesis onend
      activeTimerId = window.setTimeout(completeOnce, estimatedMs + 2500);
      return;
    } catch {
      // Fall through to timed animation state
    }
  }

  onStart?.();
  activeTimerId = window.setTimeout(completeOnce, estimatedMs);
}

async function playWithHtmlAudioElement({
  generationId,
  audioBase64,
  audioMimeType,
  onStart,
  onEnd,
  onAudioVolume,
}: {
  generationId: number;
  audioBase64: string;
  audioMimeType?: string | null;
  onStart?: () => void;
  onEnd?: () => void;
  onAudioVolume?: (volume: number) => void;
}): Promise<boolean> {
  let mediaSource: MediaElementAudioSourceNode | null = null;
  let analyser: AnalyserNode | null = null;

  const disconnectHtmlNodes = () => {
    try {
      mediaSource?.disconnect();
      analyser?.disconnect();
    } catch {
      // Ignore disconnect errors on cleanup
    }
    mediaSource = null;
    analyser = null;
  };

  try {
    if (generationId !== activePlaybackGeneration) return false;

    const safeMime = (audioMimeType || 'audio/wav').split(';')[0].trim() || 'audio/wav';
    const audio = new Audio(`data:${safeMime};base64,${audioBase64}`);
    audio.preload = 'auto';
    activeHtmlAudio = audio;

    let started = false;
    let ended = false;
    let analyserConnected = false;

    const cleanupAnim = () => {
      if (activeAnimFrameId !== null) {
        window.cancelAnimationFrame(activeAnimFrameId);
        activeAnimFrameId = null;
      }
      onAudioVolume?.(0);
    };

    const finishOnce = () => {
      if (ended) return;
      ended = true;
      cleanupAnim();
      disconnectHtmlNodes();
      if (activeNodeCleanup === disconnectHtmlNodes) {
        activeNodeCleanup = null;
      }
      audio.onended = null;
      audio.onerror = null;
      if (activeHtmlAudio === audio) {
        activeHtmlAudio = null;
      }
      if (generationId === activePlaybackGeneration) {
        onEnd?.();
      }
    };

    audio.onended = finishOnce;
    audio.onerror = finishOnce;

    await new Promise<void>((resolve, reject) => {
      const onCanPlay = () => {
        audio.removeEventListener('canplay', onCanPlay);
        audio.removeEventListener('error', onErr);
        resolve();
      };
      const onErr = () => {
        audio.removeEventListener('canplay', onCanPlay);
        audio.removeEventListener('error', onErr);
        reject(new Error(`HTMLAudio canplay error for ${safeMime}`));
      };
      if (audio.readyState >= 3) {
        resolve();
      } else {
        audio.addEventListener('canplay', onCanPlay, {once: true});
        audio.addEventListener('error', onErr, {once: true});
      }
    });

    if (generationId !== activePlaybackGeneration) {
      audio.onended = null;
      audio.onerror = null;
      audio.pause();
      audio.src = '';
      if (activeHtmlAudio === audio) {
        activeHtmlAudio = null;
      }
      return false;
    }

    if (onAudioVolume) {
      const ctx = getOrCreateAudioContext();
      if (ctx) {
        try {
          if (ctx.state === 'suspended') {
            await ctx.resume();
          }
          if (generationId !== activePlaybackGeneration) {
            audio.onended = null;
            audio.onerror = null;
            audio.pause();
            audio.src = '';
            if (activeHtmlAudio === audio) {
              activeHtmlAudio = null;
            }
            return false;
          }
          mediaSource = ctx.createMediaElementSource(audio);
          analyser = ctx.createAnalyser();
          analyser.fftSize = 256;
          mediaSource.connect(analyser);
          analyser.connect(ctx.destination);
          activeNodeCleanup = disconnectHtmlNodes;
          analyserConnected = true;

          const activeAnalyser = analyser;
          const data = new Uint8Array(activeAnalyser.frequencyBinCount);
          const checkVolume = () => {
            if (
              ended ||
              activeHtmlAudio !== audio ||
              generationId !== activePlaybackGeneration
            ) {
              return;
            }
            onAudioVolume(computeSpeechBandVolume(activeAnalyser, data, ctx.sampleRate));
            activeAnimFrameId = window.requestAnimationFrame(checkVolume);
          };
          activeAnimFrameId = window.requestAnimationFrame(checkVolume);
        } catch {
          disconnectHtmlNodes();
          analyserConnected = false;
        }
      }
    }

    await audio.play();
    if (generationId !== activePlaybackGeneration) {
      audio.onended = null;
      audio.onerror = null;
      audio.pause();
      audio.src = '';
      cleanupAnim();
      disconnectHtmlNodes();
      if (activeHtmlAudio === audio) {
        activeHtmlAudio = null;
      }
      return false;
    }

    started = true;
    onStart?.();
    console.info(`[AudioEngine] Reproduzindo áudio real via HTMLAudioElement (${safeMime}).`);

    if (onAudioVolume && !analyserConnected) {
      const pulseFallback = () => {
        if (
          ended ||
          activeHtmlAudio !== audio ||
          audio.paused ||
          generationId !== activePlaybackGeneration
        ) {
          return;
        }
        onAudioVolume(0.12);
        activeAnimFrameId = window.requestAnimationFrame(pulseFallback);
      };
      activeAnimFrameId = window.requestAnimationFrame(pulseFallback);
    }

    return started;
  } catch (err) {
    disconnectHtmlNodes();
    if (activeNodeCleanup === disconnectHtmlNodes) {
      activeNodeCleanup = null;
    }
    if (activeHtmlAudio) {
      activeHtmlAudio.onended = null;
      activeHtmlAudio.onerror = null;
      activeHtmlAudio = null;
    }
    console.warn('[AudioEngine] Falha ao tocar via HTMLAudioElement:', err);
    return false;
  }
}

export async function playSantaAudio({
  audioBase64,
  audioMimeType,
  fallbackText,
  useBrowserFallback,
  disableBrowserFallback,
  onStart,
  onEnd,
  onAudioVolume,
  onError,
}: {
  audioBase64: string | null;
  audioMimeType?: string | null;
  fallbackText: string;
  useBrowserFallback?: boolean;
  disableBrowserFallback?: boolean;
  onStart?: () => void;
  onEnd?: () => void;
  onAudioVolume?: (volume: number) => void;
  onError?: (message: string) => void;
}): Promise<PlaySantaAudioResult> {
  stopCurrentSantaVoice();
  const generationId = activePlaybackGeneration;

  let startedNotified = false;
  const notifyStartOnce = () => {
    if (!startedNotified) {
      startedNotified = true;
      onStart?.();
    }
  };

  let decodeFailureReason = '';

  if (audioBase64) {
    try {
      const rawBuffer = base64ToArrayBuffer(audioBase64);
      const normalized = wrapL16PcmToWav(rawBuffer, audioMimeType);
      const normalizedBase64 = normalized.wrapped
        ? arrayBufferToBase64(normalized.buffer)
        : audioBase64;
      const normalizedMime = normalized.mimeType;

      console.info(
        `[AudioEngine] Recebido audioBase64 (len=${audioBase64.length}, mimeType="${audioMimeType || 'desconhecido'}", normalizado="${normalizedMime}", bytes=${normalized.buffer.byteLength}).`
      );

      // (a) Tentar tocar via AudioContext (decodificando o ArrayBuffer)
      const ctx = getOrCreateAudioContext();
      if (ctx) {
        try {
          if (ctx.state === 'suspended') {
            await ctx.resume();
          }
          const decoded = await ctx.decodeAudioData(normalized.buffer.slice(0));
          if (generationId !== activePlaybackGeneration) {
            return {playedSource: 'none'};
          }

          const source = ctx.createBufferSource();
          source.buffer = decoded;

          // (1) Corte subsônico limpo (highpass 80Hz)
          const highPassFilter = ctx.createBiquadFilter();
          highPassFilter.type = 'highpass';
          highPassFilter.frequency.value = 80;

          // (2) Corpo acolhedor nos graves sem embolar (lowshelf 190Hz, +3.5dB)
          const lowShelfFilter = ctx.createBiquadFilter();
          lowShelfFilter.type = 'lowshelf';
          lowShelfFilter.frequency.value = 190;
          lowShelfFilter.gain.value = 3.5;

          // (3) Clareza e calor humano na dicção (peaking 3000Hz, +2.5dB, Q = 1)
          const presenceFilter = ctx.createBiquadFilter();
          presenceFilter.type = 'peaking';
          presenceFilter.frequency.value = 3000;
          presenceFilter.Q.value = 1;
          presenceFilter.gain.value = 2.5;

          // (4) Suavização suave acima da voz (lowpass 15500Hz)
          const lowPassFilter = ctx.createBiquadFilter();
          lowPassFilter.type = 'lowpass';
          lowPassFilter.frequency.value = 15500;

          // (5) AnalyserNode para banda vocal (300Hz - 3400Hz)
          const analyser = ctx.createAnalyser();
          analyser.fftSize = 256;

          // (6) Compressor/Limiter para evitar clipping em alto-falantes de celular
          const compressor = ctx.createDynamicsCompressor();
          compressor.threshold.value = -18;
          compressor.knee.value = 20;
          compressor.ratio.value = 4;
          compressor.attack.value = 0.004;
          compressor.release.value = 0.18;

          // (7) Ganho final seco (sem ConvolverNode / wetGain)
          const dryGain = ctx.createGain();
          dryGain.gain.value = 1.0;

          // Grafo final: source -> highpass -> lowshelf -> presence -> lowpass -> analyser -> compressor -> dryGain -> destination
          source.connect(highPassFilter);
          highPassFilter.connect(lowShelfFilter);
          lowShelfFilter.connect(presenceFilter);
          presenceFilter.connect(lowPassFilter);
          lowPassFilter.connect(analyser);
          analyser.connect(compressor);
          compressor.connect(dryGain);
          dryGain.connect(ctx.destination);

          let disconnectSpeechNodes: (() => void) | null = null;
          try {
            source.onended = () => {
              if (activeAnimFrameId !== null) {
                window.cancelAnimationFrame(activeAnimFrameId);
                activeAnimFrameId = null;
              }
              if (activeSourceNode === source) {
                activeSourceNode = null;
              }
              if (activeNodeCleanup === disconnectSpeechNodes) {
                activeNodeCleanup = null;
              }
              disconnectSpeechNodes?.();
              onAudioVolume?.(0);
              if (generationId === activePlaybackGeneration) {
                onEnd?.();
              }
            };

            disconnectSpeechNodes = () => {
              try {
                source.disconnect();
                highPassFilter.disconnect();
                lowShelfFilter.disconnect();
                presenceFilter.disconnect();
                lowPassFilter.disconnect();
                analyser.disconnect();
                compressor.disconnect();
                dryGain.disconnect();
              } catch {
                // Ignore disconnect errors on cleanup
              }
            };

            activeSourceNode = source;
            activeNodeCleanup = disconnectSpeechNodes;

            const freqData = new Uint8Array(analyser.frequencyBinCount);
            const checkVolume = () => {
              if (activeSourceNode !== source || generationId !== activePlaybackGeneration) return;
              onAudioVolume?.(computeSpeechBandVolume(analyser, freqData, ctx.sampleRate));
              activeAnimFrameId = window.requestAnimationFrame(checkVolume);
            };

            notifyStartOnce();
            source.start(0);
            console.info(
              `[AudioEngine] Reproduzindo áudio neural via AudioContext DSP (HP 80Hz -> LS 190Hz/+3.5dB -> PK 3kHz/+2.5dB -> LP 15.5kHz -> Compressor -18dB/4:1 -> dryGain, duration=${decoded.duration.toFixed(2)}s).`
            );
            if (onAudioVolume) {
              activeAnimFrameId = window.requestAnimationFrame(checkVolume);
            }
            return {playedSource: 'audiocontext'};
          } catch (startErr) {
            if (activeSourceNode === source) {
              activeSourceNode = null;
            }
            if (activeNodeCleanup === disconnectSpeechNodes) {
              activeNodeCleanup = null;
            }
            disconnectSpeechNodes?.();
            throw startErr;
          }
        } catch (err) {
          decodeFailureReason =
            err instanceof Error ? err.message : 'AudioContext.decodeAudioData falhou';
          console.warn(
            '[AudioEngine] AudioContext.decodeAudioData falhou, tentando HTMLAudioElement:',
            err
          );
        }
      } else {
        decodeFailureReason = 'AudioContext indisponível neste navegador';
      }

      if (generationId !== activePlaybackGeneration) {
        return {playedSource: 'none'};
      }

      // (b) Se falhar, tentar via HTMLAudioElement (data URI)
      const htmlPlayed = await playWithHtmlAudioElement({
        generationId,
        audioBase64: normalizedBase64,
        audioMimeType: normalizedMime,
        onStart: notifyStartOnce,
        onEnd,
        onAudioVolume,
      });
      if (htmlPlayed) {
        return {playedSource: 'htmlaudio'};
      }
      decodeFailureReason = decodeFailureReason || 'HTMLAudioElement falhou';
    } catch (err) {
      decodeFailureReason =
        err instanceof Error ? err.message : 'Falha ao converter base64 em ArrayBuffer';
      console.warn('[AudioEngine] Erro ao processar audioBase64:', err);
    }
  } else {
    decodeFailureReason = 'Backend não retornou audioBase64';
  }

  if (generationId !== activePlaybackGeneration) {
    return {playedSource: 'none'};
  }

  if (disableBrowserFallback) {
    const errMsg = `Áudio Gemini TTS não reproduzido (${decodeFailureReason}). Fallback de navegador bloqueado pelo modo estrito.`;
    console.warn(`[AudioEngine] ${errMsg}`);
    onError?.(errMsg);
    onEnd?.();
    return {playedSource: 'none', error: errMsg};
  }

  // (c) ÚLTIMO RECURSO: speechSynthesis
  if (useBrowserFallback || fallbackText) {
    speakWithBrowserFallback({
      text: fallbackText,
      reason: decodeFailureReason || 'useBrowserFallback=true',
      onStart: notifyStartOnce,
      onEnd,
    });
    return {playedSource: 'browser', error: decodeFailureReason || undefined};
  }

  notifyStartOnce();
  const estimatedMs = Math.min(7000, Math.max(2500, fallbackText.length * 55));
  activeTimerId = window.setTimeout(() => {
    activeTimerId = null;
    onEnd?.();
  }, estimatedMs);
  return {playedSource: 'none'};
}

export function startIncomingRingtone(): void {
  stopIncomingRingtone();
  const ctx = getOrCreateAudioContext();
  if (!ctx) return;

  const playChime = () => {
    if (ctx.state !== 'running') return;
    const notes = [659.25, 783.99, 1046.5];
    const now = ctx.currentTime;
    notes.forEach((freq, idx) => {
      try {
        const osc = ctx.createOscillator();
        const gain = ctx.createGain();
        osc.type = 'sine';
        osc.frequency.setValueAtTime(freq, now + idx * 0.14);
        gain.gain.setValueAtTime(0.0001, now + idx * 0.14);
        gain.gain.exponentialRampToValueAtTime(0.08, now + idx * 0.14 + 0.03);
        gain.gain.exponentialRampToValueAtTime(0.0001, now + idx * 0.14 + 0.45);
        osc.connect(gain);
        gain.connect(ctx.destination);
        osc.start(now + idx * 0.14);
        osc.stop(now + idx * 0.14 + 0.48);
      } catch {
        // Ignore audio scheduling errors
      }
    });
  };

  if (ctx.state === 'running') {
    playChime();
  }
  ringtoneTimer = window.setInterval(playChime, 2400);
}

export function stopIncomingRingtone(): void {
  if (ringtoneTimer !== null) {
    window.clearInterval(ringtoneTimer);
    ringtoneTimer = null;
  }
}
