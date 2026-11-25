import React, {useCallback, useEffect, useRef, useState} from 'react';
import {CameraOff, Loader2, Mic, PhoneOff} from 'lucide-react';
import {CallConfig, ChatTurn, PLANS, PreparedCallMedia, SantaVideoState} from '../types';
import {playSantaAudio, stopCurrentSantaVoice} from '../utils/audioEngine';

type CallPhase = 'waiting-greeting' | 'hello' | 'conversation' | 'farewell' | 'ending';

type PreparedCallMediaWithFarewell = PreparedCallMedia & {
  farewellAudioBase64?: string | null;
  farewellAudioMimeType?: string | null;
  farewellUseBrowserFallback?: boolean;
  farewellVoiceSource?: string;
};

// Limiares calibráveis para o gate com memória (EMA + histerese + hold de 400ms)
const SPEECH_EMA_PREV_WEIGHT = 0.7;
const SPEECH_EMA_CURR_WEIGHT = 0.3;
const SPEECH_ENTER_TALKING_THRESHOLD = 0.08;
const SPEECH_EXIT_LISTENING_THRESHOLD = 0.03;
const SPEECH_HOLD_MS = 400;

interface VideoCallScreenProps {
  config: CallConfig;
  preparedMedia: PreparedCallMedia | null;
  isCallActive: boolean;
  listeningVideoRef: React.RefObject<HTMLVideoElement | null>;
  talkingVideoRef: React.RefObject<HTMLVideoElement | null>;
  goodbyeVideoRef: React.RefObject<HTMLVideoElement | null>;
  frontCameraStream: MediaStream | null;
  onCallEnded: () => void;
}

interface SpeechRecognitionAlternativeLike {
  transcript: string;
}

interface SpeechRecognitionResultLike {
  0: SpeechRecognitionAlternativeLike;
  isFinal: boolean;
}

interface SpeechRecognitionEventLike {
  results: ArrayLike<SpeechRecognitionResultLike>;
}

interface SpeechRecognitionLike {
  lang: string;
  continuous: boolean;
  interimResults: boolean;
  onresult: ((e: SpeechRecognitionEventLike) => void) | null;
  onerror: ((e: {error?: string}) => void) | null;
  onend: (() => void) | null;
  start: () => void;
  stop: () => void;
  abort: () => void;
}

function getSpeechRecognitionCtor(): (new () => SpeechRecognitionLike) | null {
  if (typeof window === 'undefined') return null;
  const win = window as unknown as {
    SpeechRecognition?: new () => SpeechRecognitionLike;
    webkitSpeechRecognition?: new () => SpeechRecognitionLike;
  };
  return win.SpeechRecognition || win.webkitSpeechRecognition || null;
}

function pickSupportedRecorderMime(): string {
  if (typeof MediaRecorder === 'undefined') return '';
  const candidates = [
    'audio/mp4',
    'audio/webm;codecs=opus',
    'audio/webm',
    'audio/ogg;codecs=opus',
  ];
  for (const mime of candidates) {
    if (MediaRecorder.isTypeSupported(mime)) return mime;
  }
  return '';
}

function formatTimer(seconds: number): string {
  const clamped = Math.max(0, seconds);
  const mins = Math.floor(clamped / 60);
  const secs = clamped % 60;
  return `${String(mins).padStart(2, '0')}:${String(secs).padStart(2, '0')}`;
}

function getFallbackGreeting(childName: string): string {
  const name = childName.trim() || 'meu bem';
  return `Olá, ${name}... que alegria falar com você direto do Polo Norte!`;
}

function getFallbackFarewell(farewellType: CallConfig['farewellType'], childName: string): string {
  const name = childName.trim() || 'meu bem';
  switch (farewellType) {
    case 'mamae':
      return `${name}, a Mamãe Noel está me chamando para o leite quentinho... Feliz Natal!`;
    case 'renas':
      return `${name}, o Rodolfo está chamando porque o trenó vai decolar... Feliz Natal!`;
    case 'carta':
      return `${name}, chegou uma pilha mágica de cartas urgentes no Polo Norte... Feliz Natal!`;
    case 'duendes':
    default:
      return `${name}, os duendes estão fazendo bagunça na fábrica, preciso ir... Feliz Natal!`;
  }
}

export const VideoCallScreen: React.FC<VideoCallScreenProps> = ({
  config,
  preparedMedia,
  isCallActive,
  listeningVideoRef,
  talkingVideoRef,
  goodbyeVideoRef,
  frontCameraStream,
  onCallEnded,
}) => {
  const plan = PLANS.find((p) => p.id === config.planId) || PLANS[2];
  const farewellThresholdSeconds = config.planId === '15s' ? 3 : 6;

  const [callPhase, setCallPhase] = useState<CallPhase>('waiting-greeting');
  const [timeLeft, setTimeLeft] = useState<number>(plan.durationSeconds);
  const [videoState, setVideoState] = useState<SantaVideoState>('hello');
  const [isSpeechListening, setIsSpeechListening] = useState(false);
  const [isHoldingMic, setIsHoldingMic] = useState(false);
  const [isSendingReply, setIsSendingReply] = useState(false);

  const childCamRef = useRef<HTMLVideoElement | null>(null);
  const recognitionRef = useRef<SpeechRecognitionLike | null>(null);
  const recognitionModeRef = useRef<'auto' | 'hold' | null>(null);
  const speechApiFailedRef = useRef<boolean>(false);
  const holdTranscriptRef = useRef<string>('');
  const holdFlushedRef = useRef<boolean>(false);
  const holdStopTimeoutRef = useRef<number | null>(null);
  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const micStreamRef = useRef<MediaStream | null>(null);
  const recordedChunksRef = useRef<Blob[]>([]);
  const discardRecordingRef = useRef(false);

  const callPhaseRef = useRef<CallPhase>('waiting-greeting');
  const timelineStartedRef = useRef(false);
  const farewellTriggeredRef = useRef(false);
  const farewellAudioFinishedRef = useRef(false);
  const timerReachedZeroRef = useRef(false);
  const timeLeftRef = useRef<number>(plan.durationSeconds);
  const countdownIntervalRef = useRef<number | null>(null);
  const safetyEndTimeoutRef = useRef<number | null>(null);
  const helloTimeoutRef = useRef<number | null>(null);
  const greetingFallbackTimeoutRef = useRef<number | null>(null);
  const speechRestartTimeoutRef = useRef<number | null>(null);
  const replyAbortTimeoutRef = useRef<number | null>(null);
  const replyAbortControllerRef = useRef<AbortController | null>(null);
  const farewellAbortTimeoutRef = useRef<number | null>(null);
  const farewellAbortControllerRef = useRef<AbortController | null>(null);

  const isAudioPlayingRef = useRef(false);
  const speechEmaRef = useRef(0);
  const lastAboveThresholdAtRef = useRef(0);
  const isGateTalkingRef = useRef(false);

  const isHoldingMicRef = useRef(false);
  const isSendingReplyRef = useRef(false);
  const pendingMicReleaseRef = useRef(false);
  const greetingStartedRef = useRef(false);
  const callEndedCalledRef = useRef(false);
  const historyRef = useRef<ChatTurn[]>([]);
  const mountedRef = useRef(true);
  const preparedMediaRef = useRef<PreparedCallMediaWithFarewell | null>(
    preparedMedia as PreparedCallMediaWithFarewell | null
  );
  const startWebSpeechListeningRef = useRef<() => void>(() => undefined);

  useEffect(() => {
    preparedMediaRef.current = preparedMedia as PreparedCallMediaWithFarewell | null;
  }, [preparedMedia]);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  useEffect(() => {
    if (childCamRef.current && frontCameraStream) {
      childCamRef.current.srcObject = frontCameraStream;
      childCamRef.current.play().catch(() => undefined);
    }
  }, [frontCameraStream, isCallActive]);

  const resetSpeechGate = useCallback(() => {
    speechEmaRef.current = 0;
    lastAboveThresholdAtRef.current = 0;
    isGateTalkingRef.current = false;
  }, []);

  const stopSpeechRecognition = useCallback(() => {
    if (speechRestartTimeoutRef.current !== null) {
      window.clearTimeout(speechRestartTimeoutRef.current);
      speechRestartTimeoutRef.current = null;
    }
    if (holdStopTimeoutRef.current !== null) {
      window.clearTimeout(holdStopTimeoutRef.current);
      holdStopTimeoutRef.current = null;
    }
    recognitionModeRef.current = null;
    if (recognitionRef.current) {
      try {
        recognitionRef.current.onresult = null;
        recognitionRef.current.onerror = null;
        recognitionRef.current.onend = null;
        recognitionRef.current.abort();
      } catch {
        // Ignore
      }
      recognitionRef.current = null;
    }
    if (mountedRef.current) {
      setIsSpeechListening(false);
    }
  }, []);

  const stopMediaRecorderIfActive = useCallback((discard: boolean) => {
    discardRecordingRef.current = discard;
    isHoldingMicRef.current = false;
    pendingMicReleaseRef.current = false;
    if (mediaRecorderRef.current && mediaRecorderRef.current.state !== 'inactive') {
      try {
        mediaRecorderRef.current.stop();
      } catch {
        // Ignore
      }
    }
    if (mountedRef.current) {
      setIsHoldingMic(false);
    }
  }, []);

  const cleanupAllDevices = useCallback(() => {
    if (countdownIntervalRef.current !== null) {
      window.clearInterval(countdownIntervalRef.current);
      countdownIntervalRef.current = null;
    }
    if (safetyEndTimeoutRef.current !== null) {
      window.clearTimeout(safetyEndTimeoutRef.current);
      safetyEndTimeoutRef.current = null;
    }
    if (helloTimeoutRef.current !== null) {
      window.clearTimeout(helloTimeoutRef.current);
      helloTimeoutRef.current = null;
    }
    if (greetingFallbackTimeoutRef.current !== null) {
      window.clearTimeout(greetingFallbackTimeoutRef.current);
      greetingFallbackTimeoutRef.current = null;
    }
    if (speechRestartTimeoutRef.current !== null) {
      window.clearTimeout(speechRestartTimeoutRef.current);
      speechRestartTimeoutRef.current = null;
    }
    if (holdStopTimeoutRef.current !== null) {
      window.clearTimeout(holdStopTimeoutRef.current);
      holdStopTimeoutRef.current = null;
    }
    if (replyAbortTimeoutRef.current !== null) {
      window.clearTimeout(replyAbortTimeoutRef.current);
      replyAbortTimeoutRef.current = null;
    }
    if (replyAbortControllerRef.current) {
      try {
        replyAbortControllerRef.current.abort();
      } catch {
        // Ignore
      }
      replyAbortControllerRef.current = null;
    }
    if (farewellAbortTimeoutRef.current !== null) {
      window.clearTimeout(farewellAbortTimeoutRef.current);
      farewellAbortTimeoutRef.current = null;
    }
    if (farewellAbortControllerRef.current) {
      try {
        farewellAbortControllerRef.current.abort();
      } catch {
        // Ignore
      }
      farewellAbortControllerRef.current = null;
    }

    isAudioPlayingRef.current = false;
    resetSpeechGate();
    isSendingReplyRef.current = false;
    stopSpeechRecognition();
    stopMediaRecorderIfActive(true);
    stopCurrentSantaVoice();

    if (micStreamRef.current) {
      micStreamRef.current.getTracks().forEach((t) => t.stop());
      micStreamRef.current = null;
    }
  }, [resetSpeechGate, stopMediaRecorderIfActive, stopSpeechRecognition]);

  const finishCallSafely = useCallback(() => {
    if (callEndedCalledRef.current || !mountedRef.current) return;
    callEndedCalledRef.current = true;
    callPhaseRef.current = 'ending';
    setCallPhase('ending');
    cleanupAllDevices();
    onCallEnded();
  }, [cleanupAllDevices, onCallEnded]);

  const scheduleAutoSpeechListening = useCallback(() => {
    if (
      !plan.interactive ||
      farewellTriggeredRef.current ||
      callPhaseRef.current === 'farewell' ||
      callPhaseRef.current === 'ending' ||
      timeLeftRef.current <= farewellThresholdSeconds
    ) {
      return;
    }
    if (speechRestartTimeoutRef.current !== null) {
      window.clearTimeout(speechRestartTimeoutRef.current);
    }
    speechRestartTimeoutRef.current = window.setTimeout(() => {
      speechRestartTimeoutRef.current = null;
      if (
        mountedRef.current &&
        !farewellTriggeredRef.current &&
        callPhaseRef.current !== 'farewell' &&
        callPhaseRef.current !== 'ending' &&
        !isHoldingMicRef.current &&
        !isSendingReplyRef.current &&
        !isAudioPlayingRef.current &&
        timeLeftRef.current > farewellThresholdSeconds
      ) {
        startWebSpeechListeningRef.current();
      }
    }, 180);
  }, [farewellThresholdSeconds, plan.interactive]);

  useEffect(() => {
    if (talkingVideoRef.current) {
      talkingVideoRef.current.playbackRate = 1.05;
    }
  }, [isCallActive, talkingVideoRef, videoState]);

  /**
   * Gate com memória (EMA + histerese + hold de 400ms):
   * - EMA = EMA * 0.7 + vol * 0.3
   * - Entra em 'talking' se EMA > 0.08
   * - Só volta para 'listening' se EMA < 0.03 E o último valor > 0.08 foi há > 400ms
   */
  const syncConversationVideoByVolume = useCallback((vol: number) => {
    const now = performance.now();
    const ema =
      speechEmaRef.current * SPEECH_EMA_PREV_WEIGHT + vol * SPEECH_EMA_CURR_WEIGHT;
    speechEmaRef.current = ema;

    if (ema > SPEECH_ENTER_TALKING_THRESHOLD) {
      lastAboveThresholdAtRef.current = now;
      isGateTalkingRef.current = true;
    } else if (
      ema < SPEECH_EXIT_LISTENING_THRESHOLD &&
      now - lastAboveThresholdAtRef.current > SPEECH_HOLD_MS
    ) {
      isGateTalkingRef.current = false;
    }

    if (
      !mountedRef.current ||
      farewellTriggeredRef.current ||
      callPhaseRef.current !== 'conversation'
    ) {
      return;
    }

    setVideoState(isGateTalkingRef.current ? 'talking' : 'listening');
  }, []);

  const triggerFarewellPhase = useCallback(async () => {
    const currentPrepared = preparedMediaRef.current;
    const farewellText =
      currentPrepared?.farewellText || getFallbackFarewell(config.farewellType, config.childName);

    let farewellAudioBase64: string | null = currentPrepared?.farewellAudioBase64 ?? null;
    let farewellAudioMimeType: string | null = currentPrepared?.farewellAudioMimeType ?? null;
    let useBrowserFallback = currentPrepared?.farewellAudioBase64
      ? Boolean(currentPrepared.farewellUseBrowserFallback)
      : true;
    let farewellVoiceSource =
      currentPrepared?.farewellVoiceSource ||
      (farewellAudioBase64 ? 'gemini-tts-preloaded' : 'browser');

    // Somente aciona /api/santa/farewell como fallback se o áudio pré-carregado não estiver em preparedMedia
    if (!farewellAudioBase64) {
      const controller = new AbortController();
      farewellAbortControllerRef.current = controller;
      farewellAbortTimeoutRef.current = window.setTimeout(() => {
        controller.abort();
      }, 4500);

      try {
        const res = await fetch('/api/santa/farewell', {
          method: 'POST',
          headers: {'Content-Type': 'application/json'},
          signal: controller.signal,
          body: JSON.stringify({
            childName: config.childName,
            farewellType: config.farewellType,
            farewellText,
          }),
        });
        if (res.ok) {
          const data = (await res.json()) as {
            farewellAudioBase64?: string | null;
            farewellAudioMimeType?: string | null;
            useBrowserFallback?: boolean;
            voiceSource?: string;
          };
          farewellAudioBase64 = data.farewellAudioBase64 || null;
          farewellAudioMimeType = data.farewellAudioMimeType || null;
          useBrowserFallback = Boolean(data.useBrowserFallback) || !farewellAudioBase64;
          farewellVoiceSource =
            data.voiceSource || (farewellAudioBase64 ? 'gemini-tts' : 'browser');
        }
      } catch {
        useBrowserFallback = true;
      } finally {
        if (farewellAbortTimeoutRef.current !== null) {
          window.clearTimeout(farewellAbortTimeoutRef.current);
          farewellAbortTimeoutRef.current = null;
        }
        if (farewellAbortControllerRef.current === controller) {
          farewellAbortControllerRef.current = null;
        }
      }
    }

    console.info(
      `[VideoCallScreen] Farewell voiceSource: ${farewellVoiceSource} (mime=${farewellAudioMimeType || 'none'}, preloaded=${Boolean(currentPrepared?.farewellAudioBase64)})`
    );

    if (!mountedRef.current || callEndedCalledRef.current) return;

    await playSantaAudio({
      audioBase64: farewellAudioBase64,
      audioMimeType: farewellAudioMimeType,
      fallbackText: farewellText,
      useBrowserFallback,
      onStart: () => {
        isAudioPlayingRef.current = true;
      },
      onEnd: () => {
        isAudioPlayingRef.current = false;
        farewellAudioFinishedRef.current = true;
        if (timerReachedZeroRef.current) {
          finishCallSafely();
        }
      },
    });
  }, [config.childName, config.farewellType, finishCallSafely]);

  const beginCallTimeline = useCallback(() => {
    if (
      timelineStartedRef.current ||
      !mountedRef.current ||
      callEndedCalledRef.current ||
      farewellTriggeredRef.current
    ) {
      return;
    }
    timelineStartedRef.current = true;

    if (greetingFallbackTimeoutRef.current !== null) {
      window.clearTimeout(greetingFallbackTimeoutRef.current);
      greetingFallbackTimeoutRef.current = null;
    }

    if (helloTimeoutRef.current !== null) {
      window.clearTimeout(helloTimeoutRef.current);
      helloTimeoutRef.current = null;
    }

    // Fase 1: Saudação (3.5s) exibindo /videos/santa-talking.mp4 sincronizado com o início do áudio
    callPhaseRef.current = 'hello';
    setCallPhase('hello');
    setVideoState('hello');
    if (talkingVideoRef.current) {
      try {
        talkingVideoRef.current.playbackRate = 1.05;
        talkingVideoRef.current.currentTime = 0;
        talkingVideoRef.current.play().catch(() => undefined);
      } catch {
        // Ignore
      }
    }

    helloTimeoutRef.current = window.setTimeout(() => {
      helloTimeoutRef.current = null;
      if (
        !mountedRef.current ||
        farewellTriggeredRef.current ||
        callEndedCalledRef.current ||
        callPhaseRef.current === 'farewell' ||
        callPhaseRef.current === 'ending'
      ) {
        return;
      }
      // Fase 2: Conversa dinâmica via gate com memória (EMA + 400ms hold)
      callPhaseRef.current = 'conversation';
      setCallPhase('conversation');
      const shouldTalk = isAudioPlayingRef.current && isGateTalkingRef.current;
      setVideoState(shouldTalk ? 'talking' : 'listening');
    }, 3500);

    // Contagem regressiva do plano (15s, 30s, 60s) a partir do início do áudio da saudação
    if (countdownIntervalRef.current !== null) {
      window.clearInterval(countdownIntervalRef.current);
    }

    countdownIntervalRef.current = window.setInterval(() => {
      if (!mountedRef.current || callEndedCalledRef.current) return;

      setTimeLeft((prev) => {
        const next = Math.max(0, prev - 1);
        timeLeftRef.current = next;

        // Fase 3: Despedida em T-6s (ou T-3s para o plano de 15s)
        if (next <= farewellThresholdSeconds && !farewellTriggeredRef.current) {
          farewellTriggeredRef.current = true;
          callPhaseRef.current = 'farewell';
          setCallPhase('farewell');

          if (helloTimeoutRef.current !== null) {
            window.clearTimeout(helloTimeoutRef.current);
            helloTimeoutRef.current = null;
          }

          if (replyAbortControllerRef.current) {
            try {
              replyAbortControllerRef.current.abort();
            } catch {
              // Ignore
            }
            replyAbortControllerRef.current = null;
          }

          stopSpeechRecognition();
          stopMediaRecorderIfActive(true);
          stopCurrentSantaVoice();
          resetSpeechGate();

          setVideoState('goodbye');
          if (goodbyeVideoRef.current) {
            try {
              goodbyeVideoRef.current.currentTime = 0;
              goodbyeVideoRef.current.play().catch(() => undefined);
            } catch {
              // Ignore
            }
          }

          void triggerFarewellPhase();
        }

        // Fase 4: Encerramento ao chegar a zero -> aguarda onended da despedida ou timeout de segurança de 7s
        if (next === 0) {
          if (countdownIntervalRef.current !== null) {
            window.clearInterval(countdownIntervalRef.current);
            countdownIntervalRef.current = null;
          }
          timerReachedZeroRef.current = true;
          callPhaseRef.current = 'ending';
          setCallPhase('ending');

          if (farewellAudioFinishedRef.current) {
            finishCallSafely();
          } else {
            if (safetyEndTimeoutRef.current !== null) {
              window.clearTimeout(safetyEndTimeoutRef.current);
            }
            safetyEndTimeoutRef.current = window.setTimeout(() => {
              safetyEndTimeoutRef.current = null;
              farewellAudioFinishedRef.current = true;
              finishCallSafely();
            }, 7000);
          }

          return 0;
        }

        return next;
      });
    }, 1000);
  }, [
    farewellThresholdSeconds,
    finishCallSafely,
    goodbyeVideoRef,
    resetSpeechGate,
    stopMediaRecorderIfActive,
    stopSpeechRecognition,
    talkingVideoRef,
    triggerFarewellPhase,
  ]);

  const sendChildTurnToGemini = useCallback(
    async (payload: {childText?: string; audioBase64?: string; audioMimeType?: string}) => {
      const isCallInterrupted = () =>
        farewellTriggeredRef.current ||
        callPhaseRef.current === 'farewell' ||
        callPhaseRef.current === 'ending' ||
        !mountedRef.current ||
        callEndedCalledRef.current;

      if (isCallInterrupted() || isSendingReplyRef.current) {
        return;
      }
      isSendingReplyRef.current = true;
      setIsSendingReply(true);

      const controller = new AbortController();
      replyAbortControllerRef.current = controller;
      replyAbortTimeoutRef.current = window.setTimeout(() => controller.abort(), 7000);

      try {
        const res = await fetch('/api/santa/reply', {
          method: 'POST',
          headers: {'Content-Type': 'application/json'},
          signal: controller.signal,
          body: JSON.stringify({
            ...payload,
            childName: config.childName,
            childAge: config.childAge,
            praise: config.praise,
            advice: config.advice,
            history: historyRef.current,
          }),
        });
        if (!res.ok) {
          throw new Error('Erro ao responder.');
        }

        interface ReplyStreamChunk {
          transcript?: string;
          replyText?: string;
          audioBase64?: string | null;
          audioMimeType?: string | null;
          useBrowserFallback?: boolean;
          voiceSource?: string;
          done?: boolean;
          error?: string;
        }

        let finalData: ReplyStreamChunk = {};
        if (res.body) {
          const reader = res.body.getReader();
          const decoder = new TextDecoder();
          let buffer = '';
          while (true) {
            const {value, done} = await reader.read();
            if (done) break;
            if (isCallInterrupted()) {
              try {
                await reader.cancel();
              } catch {
                // Ignore
              }
              return;
            }
            buffer += decoder.decode(value, {stream: true});
            const lines = buffer.split('\n');
            buffer = lines.pop() ?? '';
            for (const line of lines) {
              const trimmed = line.trim();
              if (!trimmed) continue;
              try {
                const parsed = JSON.parse(trimmed) as ReplyStreamChunk;
                finalData = {...finalData, ...parsed};
              } catch {
                // Ignore partial JSON line
              }
            }
          }
          if (buffer.trim()) {
            try {
              const parsed = JSON.parse(buffer.trim()) as ReplyStreamChunk;
              finalData = {...finalData, ...parsed};
            } catch {
              // Ignore trailing incomplete line
            }
          }
        } else {
          const rawText = await res.text();
          for (const line of rawText.split('\n')) {
            const trimmed = line.trim();
            if (!trimmed) continue;
            try {
              finalData = {...finalData, ...(JSON.parse(trimmed) as ReplyStreamChunk)};
            } catch {
              // Ignore malformed line
            }
          }
        }

        // Trava de corrida: se já entrou em 'farewell' ou 'ending', NÃO pode chamar playSantaAudio
        if (isCallInterrupted()) {
          console.info('[VideoCallScreen] Reply atrasado ignorado porque chamada já entrou em farewell/ending.');
          return;
        }

        const replyText =
          finalData.replyText ||
          `Que maravilha, ${config.childName || 'pequeno amigo'}... me conte mais!`;

        if (finalData.transcript) {
          historyRef.current.push({role: 'child', text: finalData.transcript});
        }
        historyRef.current.push({role: 'santa', text: replyText});

        console.info(
          `[VideoCallScreen] Reply voiceSource: ${
            finalData.voiceSource || (finalData.audioBase64 ? 'gemini-tts' : 'browser')
          } (mime=${finalData.audioMimeType || 'none'})`
        );

        await playSantaAudio({
          audioBase64: finalData.audioBase64 || null,
          audioMimeType: finalData.audioMimeType || null,
          fallbackText: replyText,
          useBrowserFallback: Boolean(finalData.useBrowserFallback),
          onStart: () => {
            if (isCallInterrupted()) {
              return;
            }
            isAudioPlayingRef.current = true;
            lastAboveThresholdAtRef.current = performance.now();
            isGateTalkingRef.current = true;
            if (talkingVideoRef.current) {
              talkingVideoRef.current.playbackRate = 1.05;
            }
            if (mountedRef.current && callPhaseRef.current === 'conversation') {
              setVideoState('talking');
            }
          },
          onAudioVolume: syncConversationVideoByVolume,
          onEnd: () => {
            isAudioPlayingRef.current = false;
            resetSpeechGate();
            if (!isCallInterrupted()) {
              if (callPhaseRef.current === 'conversation') {
                setVideoState('listening');
              }
              scheduleAutoSpeechListening();
            }
          },
        });
      } catch {
        isAudioPlayingRef.current = false;
        resetSpeechGate();
        if (!isCallInterrupted()) {
          if (callPhaseRef.current === 'conversation') {
            setVideoState('listening');
          }
          scheduleAutoSpeechListening();
        }
      } finally {
        if (replyAbortTimeoutRef.current !== null) {
          window.clearTimeout(replyAbortTimeoutRef.current);
          replyAbortTimeoutRef.current = null;
        }
        if (replyAbortControllerRef.current === controller) {
          replyAbortControllerRef.current = null;
        }
        isSendingReplyRef.current = false;
        if (mountedRef.current) {
          setIsSendingReply(false);
        }
      }
    },
    [
      config.advice,
      config.childAge,
      config.childName,
      config.praise,
      resetSpeechGate,
      scheduleAutoSpeechListening,
      syncConversationVideoByVolume,
      talkingVideoRef,
    ]
  );

  const startWebSpeechListening = useCallback(() => {
    if (
      !plan.interactive ||
      speechApiFailedRef.current ||
      farewellTriggeredRef.current ||
      callPhaseRef.current === 'farewell' ||
      callPhaseRef.current === 'ending' ||
      isHoldingMicRef.current ||
      isSendingReplyRef.current ||
      isAudioPlayingRef.current ||
      timeLeftRef.current <= farewellThresholdSeconds
    ) {
      return;
    }
    const SpeechCtor = getSpeechRecognitionCtor();
    if (!SpeechCtor) return;

    stopSpeechRecognition();
    try {
      const recognition = new SpeechCtor();
      recognition.lang = 'pt-BR';
      recognition.continuous = false;
      recognition.interimResults = true;

      let finalTranscript = '';
      let latestTranscript = '';
      let blockedByPermission = false;

      recognition.onresult = (event) => {
        if (farewellTriggeredRef.current || recognitionModeRef.current !== 'auto') return;
        let combined = '';
        let hasFinal = false;
        for (let i = 0; i < event.results.length; i++) {
          const item = event.results[i];
          combined += item[0].transcript;
          if (item.isFinal) hasFinal = true;
        }
        latestTranscript = combined.trim();
        if (hasFinal) {
          finalTranscript = latestTranscript;
        }
      };

      recognition.onerror = (ev) => {
        setIsSpeechListening(false);
        const errCode = ev?.error || '';
        if (errCode === 'not-allowed' || errCode === 'service-not-allowed') {
          blockedByPermission = true;
          speechApiFailedRef.current = true;
        }
      };

      recognition.onend = () => {
        if (recognitionModeRef.current !== 'auto') return;
        recognitionModeRef.current = null;
        recognitionRef.current = null;
        setIsSpeechListening(false);

        const spokenText = (finalTranscript || latestTranscript).trim();
        if (
          spokenText &&
          !farewellTriggeredRef.current &&
          callPhaseRef.current !== 'farewell' &&
          callPhaseRef.current !== 'ending' &&
          !isHoldingMicRef.current &&
          !isSendingReplyRef.current
        ) {
          void sendChildTurnToGemini({childText: spokenText});
        } else if (!blockedByPermission && !speechApiFailedRef.current) {
          scheduleAutoSpeechListening();
        }
      };

      recognitionModeRef.current = 'auto';
      recognitionRef.current = recognition;
      recognition.start();
      setIsSpeechListening(true);
    } catch {
      recognitionModeRef.current = null;
      recognitionRef.current = null;
      setIsSpeechListening(false);
    }
  }, [
    farewellThresholdSeconds,
    plan.interactive,
    scheduleAutoSpeechListening,
    sendChildTurnToGemini,
    stopSpeechRecognition,
  ]);

  useEffect(() => {
    startWebSpeechListeningRef.current = startWebSpeechListening;
  }, [startWebSpeechListening]);

  // Reset da chamada quando isCallActive muda
  useEffect(() => {
    if (!isCallActive) {
      cleanupAllDevices();
      timelineStartedRef.current = false;
      greetingStartedRef.current = false;
      farewellTriggeredRef.current = false;
      farewellAudioFinishedRef.current = false;
      timerReachedZeroRef.current = false;
      callEndedCalledRef.current = false;
      timeLeftRef.current = plan.durationSeconds;
      callPhaseRef.current = 'waiting-greeting';
      setCallPhase('waiting-greeting');
      setTimeLeft(plan.durationSeconds);
      setVideoState('hello');
      return;
    }

    timelineStartedRef.current = false;
    greetingStartedRef.current = false;
    farewellTriggeredRef.current = false;
    farewellAudioFinishedRef.current = false;
    timerReachedZeroRef.current = false;
    callEndedCalledRef.current = false;
    timeLeftRef.current = plan.durationSeconds;
    callPhaseRef.current = 'waiting-greeting';
    setCallPhase('waiting-greeting');
    setTimeLeft(plan.durationSeconds);
    setVideoState('hello');

    if (talkingVideoRef.current) {
      try {
        talkingVideoRef.current.playbackRate = 1.05;
        talkingVideoRef.current.currentTime = 0;
        talkingVideoRef.current.play().catch(() => undefined);
      } catch {
        // Ignore
      }
    }

    // Proteção caso preparedMedia atrase ou falhe no carregamento inicial
    greetingFallbackTimeoutRef.current = window.setTimeout(() => {
      greetingFallbackTimeoutRef.current = null;
      if (!mountedRef.current || greetingStartedRef.current || farewellTriggeredRef.current) {
        return;
      }
      greetingStartedRef.current = true;
      const fallbackText = getFallbackGreeting(config.childName);
      historyRef.current = [{role: 'santa', text: fallbackText}];

      void playSantaAudio({
        audioBase64: null,
        audioMimeType: null,
        fallbackText,
        useBrowserFallback: true,
        onStart: () => {
          isAudioPlayingRef.current = true;
          lastAboveThresholdAtRef.current = performance.now();
          isGateTalkingRef.current = true;
          beginCallTimeline();
        },
        onAudioVolume: syncConversationVideoByVolume,
        onEnd: () => {
          isAudioPlayingRef.current = false;
          resetSpeechGate();
          if (
            !farewellTriggeredRef.current &&
            callPhaseRef.current !== 'farewell' &&
            callPhaseRef.current !== 'ending' &&
            mountedRef.current
          ) {
            if (callPhaseRef.current === 'conversation') {
              setVideoState('listening');
            }
            scheduleAutoSpeechListening();
          }
        },
      });
    }, 4000);

    return () => {
      cleanupAllDevices();
    };
  }, [
    beginCallTimeline,
    cleanupAllDevices,
    config.childName,
    isCallActive,
    plan.durationSeconds,
    resetSpeechGate,
    scheduleAutoSpeechListening,
    syncConversationVideoByVolume,
    talkingVideoRef,
  ]);

  // Inicia áudio da saudação quando preparedMedia estiver pronto e dispara a linha do tempo em onStart
  useEffect(() => {
    if (!isCallActive || !preparedMedia || greetingStartedRef.current || farewellTriggeredRef.current) {
      return;
    }

    if (greetingFallbackTimeoutRef.current !== null) {
      window.clearTimeout(greetingFallbackTimeoutRef.current);
      greetingFallbackTimeoutRef.current = null;
    }

    greetingStartedRef.current = true;
    historyRef.current = [{role: 'santa', text: preparedMedia.greetingText}];

    console.info(
      `[VideoCallScreen] Greeting voiceSource: ${
        preparedMedia.voiceSource ||
        (preparedMedia.greetingAudioBase64 ? 'gemini-tts' : 'browser')
      } (mime=${preparedMedia.greetingAudioMimeType || 'none'})`
    );

    void playSantaAudio({
      audioBase64: preparedMedia.greetingAudioBase64,
      audioMimeType: preparedMedia.greetingAudioMimeType,
      fallbackText: preparedMedia.greetingText,
      useBrowserFallback: Boolean(preparedMedia.useBrowserFallback),
      onStart: () => {
        isAudioPlayingRef.current = true;
        lastAboveThresholdAtRef.current = performance.now();
        isGateTalkingRef.current = true;
        beginCallTimeline();
      },
      onAudioVolume: syncConversationVideoByVolume,
      onEnd: () => {
        isAudioPlayingRef.current = false;
        resetSpeechGate();
        if (
          !farewellTriggeredRef.current &&
          callPhaseRef.current !== 'farewell' &&
          callPhaseRef.current !== 'ending' &&
          mountedRef.current
        ) {
          if (callPhaseRef.current === 'conversation') {
            setVideoState('listening');
          }
          scheduleAutoSpeechListening();
        }
      },
    });
  }, [
    beginCallTimeline,
    isCallActive,
    preparedMedia,
    resetSpeechGate,
    scheduleAutoSpeechListening,
    syncConversationVideoByVolume,
  ]);

  // Cleanup final no unmount do componente
  useEffect(() => {
    return () => {
      cleanupAllDevices();
    };
  }, [cleanupAllDevices]);

  const flushHoldSpeechTranscript = useCallback(() => {
    if (holdFlushedRef.current) return;
    holdFlushedRef.current = true;

    if (holdStopTimeoutRef.current !== null) {
      window.clearTimeout(holdStopTimeoutRef.current);
      holdStopTimeoutRef.current = null;
    }

    const transcript = holdTranscriptRef.current.trim();
    holdTranscriptRef.current = '';
    recognitionModeRef.current = null;
    recognitionRef.current = null;

    if (
      farewellTriggeredRef.current ||
      callPhaseRef.current === 'farewell' ||
      callPhaseRef.current === 'ending' ||
      !mountedRef.current
    ) {
      return;
    }

    if (transcript) {
      void sendChildTurnToGemini({childText: transcript});
    } else {
      scheduleAutoSpeechListening();
    }
  }, [scheduleAutoSpeechListening, sendChildTurnToGemini]);

  const startMediaRecorderHoldFallback = async () => {
    try {
      if (!micStreamRef.current) {
        micStreamRef.current = await navigator.mediaDevices.getUserMedia({
          audio: {
            echoCancellation: true,
            noiseSuppression: true,
          },
          video: false,
        });
      }

      if (pendingMicReleaseRef.current || farewellTriggeredRef.current || !mountedRef.current) {
        isHoldingMicRef.current = false;
        setIsHoldingMic(false);
        return;
      }

      const mimeType = pickSupportedRecorderMime();
      const recorder = mimeType
        ? new MediaRecorder(micStreamRef.current, {mimeType})
        : new MediaRecorder(micStreamRef.current);

      recordedChunksRef.current = [];
      discardRecordingRef.current = false;

      recorder.ondataavailable = (ev) => {
        if (ev.data && ev.data.size > 0) {
          recordedChunksRef.current.push(ev.data);
        }
      };

      recorder.onstop = () => {
        isHoldingMicRef.current = false;
        if (mountedRef.current) {
          setIsHoldingMic(false);
        }
        if (discardRecordingRef.current || farewellTriggeredRef.current) return;

        const blob = new Blob(recordedChunksRef.current, {
          type: recorder.mimeType || mimeType || 'audio/mp4',
        });
        if (blob.size < 400) {
          scheduleAutoSpeechListening();
          return;
        }

        const reader = new FileReader();
        reader.onloadend = () => {
          const result = typeof reader.result === 'string' ? reader.result : '';
          const base64 = result.split(',')[1] || '';
          if (base64) {
            void sendChildTurnToGemini({
              audioBase64: base64,
              audioMimeType: blob.type || 'audio/mp4',
            });
          } else {
            scheduleAutoSpeechListening();
          }
        };
        reader.onerror = () => {
          scheduleAutoSpeechListening();
        };
        reader.readAsDataURL(blob);
      };

      mediaRecorderRef.current = recorder;
      recorder.start();
    } catch {
      isHoldingMicRef.current = false;
      if (mountedRef.current) {
        setIsHoldingMic(false);
      }
      scheduleAutoSpeechListening();
    }
  };

  const startHoldRecording = async () => {
    if (
      farewellTriggeredRef.current ||
      callPhaseRef.current === 'farewell' ||
      callPhaseRef.current === 'ending' ||
      isSendingReplyRef.current ||
      isHoldingMicRef.current ||
      timeLeftRef.current <= farewellThresholdSeconds
    ) {
      return;
    }

    isHoldingMicRef.current = true;
    pendingMicReleaseRef.current = false;
    setIsHoldingMic(true);

    if (helloTimeoutRef.current !== null) {
      window.clearTimeout(helloTimeoutRef.current);
      helloTimeoutRef.current = null;
    }
    if (callPhaseRef.current === 'hello' || callPhaseRef.current === 'waiting-greeting') {
      callPhaseRef.current = 'conversation';
      setCallPhase('conversation');
    }

    stopSpeechRecognition();
    stopCurrentSantaVoice();
    isAudioPlayingRef.current = false;
    resetSpeechGate();
    setVideoState('listening');

    const SpeechCtor = getSpeechRecognitionCtor();
    if (SpeechCtor && !speechApiFailedRef.current) {
      try {
        holdTranscriptRef.current = '';
        holdFlushedRef.current = false;

        const recognition = new SpeechCtor();
        recognition.lang = 'pt-BR';
        recognition.continuous = true;
        recognition.interimResults = true;

        recognition.onresult = (event) => {
          if (farewellTriggeredRef.current) return;
          let combined = '';
          for (let i = 0; i < event.results.length; i++) {
            combined += event.results[i][0].transcript + ' ';
          }
          const cleaned = combined.trim();
          if (cleaned) {
            holdTranscriptRef.current = cleaned;
          }
        };

        recognition.onerror = (ev) => {
          const errCode = ev?.error || '';
          if (errCode === 'service-not-allowed' || errCode === 'not-allowed') {
            speechApiFailedRef.current = true;
          }
        };

        recognition.onend = () => {
          if (!isHoldingMicRef.current && recognitionModeRef.current === 'hold') {
            flushHoldSpeechTranscript();
          }
        };

        recognitionModeRef.current = 'hold';
        recognitionRef.current = recognition;
        recognition.start();

        if (pendingMicReleaseRef.current) {
          stopHoldRecording();
        }
        return;
      } catch {
        recognitionModeRef.current = null;
        recognitionRef.current = null;
        speechApiFailedRef.current = true;
      }
    }

    await startMediaRecorderHoldFallback();
  };

  const stopHoldRecording = () => {
    if (!isHoldingMicRef.current) {
      pendingMicReleaseRef.current = true;
      return;
    }

    pendingMicReleaseRef.current = true;
    isHoldingMicRef.current = false;
    setIsHoldingMic(false);

    if (recognitionModeRef.current === 'hold' && recognitionRef.current) {
      try {
        recognitionRef.current.stop();
      } catch {
        flushHoldSpeechTranscript();
        return;
      }
      if (holdStopTimeoutRef.current !== null) {
        window.clearTimeout(holdStopTimeoutRef.current);
      }
      holdStopTimeoutRef.current = window.setTimeout(() => {
        flushHoldSpeechTranscript();
      }, 220);
      return;
    }

    if (mediaRecorderRef.current && mediaRecorderRef.current.state === 'recording') {
      try {
        mediaRecorderRef.current.stop();
      } catch {
        // Ignore
      }
    }
  };

  const handlePointerMicDown = (e: React.PointerEvent) => {
    e.preventDefault();
    void startHoldRecording();
  };

  const handlePointerMicUp = (e: React.PointerEvent) => {
    e.preventDefault();
    stopHoldRecording();
  };

  const handleTouchMicStart = (e: React.TouchEvent) => {
    e.preventDefault();
    void startHoldRecording();
  };

  const handleTouchMicEnd = (e: React.TouchEvent) => {
    e.preventDefault();
    stopHoldRecording();
  };

  const handleHangUp = () => {
    finishCallSafely();
  };

  const isListeningBadge =
    videoState === 'listening' &&
    !isSendingReply &&
    callPhase !== 'farewell' &&
    callPhase !== 'ending' &&
    (isHoldingMic || isSpeechListening || (plan.interactive && timeLeft > farewellThresholdSeconds));

  const isTalkingVisualActive = videoState === 'talking' || videoState === 'hello';

  return (
    <div
      className={`fixed inset-0 h-[100dvh] z-20 flex items-center justify-center bg-[#0B0C10] ${
        isCallActive ? 'opacity-100 pointer-events-auto' : 'opacity-0 pointer-events-none'
      }`}
    >
      {/* 9:16 Video Call Stage with h-[100dvh] */}
      <div className="relative w-full h-[100dvh] md:h-[92dvh] md:max-h-[880px] md:w-auto md:aspect-[9/16] bg-[#13151C] md:rounded-3xl overflow-hidden md:border md:border-[#D4AF37]/30 md:shadow-2xl">
        {/* Realistic Santa Photo Poster/Fallback Backdrop */}
        <div className="absolute inset-0 z-0">
          <img
            src="/santa-avatar.png"
            alt="Papai Noel"
            className="w-full h-full object-cover scale-105"
          />
        </div>

        {/* Overlapping <video> Elements with object-cover scale-105 & smooth 300ms Opacity Crossfade */}
        <video
          ref={listeningVideoRef}
          src="/videos/santa-listening.mp4"
          poster="/santa-avatar.png"
          loop
          muted
          playsInline
          autoPlay
          preload="auto"
          className={`absolute inset-0 w-full h-full object-cover scale-105 pointer-events-none transition-opacity duration-300 ease-in-out ${
            videoState === 'listening' ? 'z-[12] opacity-100' : 'z-10 opacity-0'
          }`}
        />

        <video
          ref={talkingVideoRef}
          src="/videos/santa-talking.mp4"
          poster="/santa-avatar.png"
          loop
          muted
          playsInline
          autoPlay
          preload="auto"
          onLoadedMetadata={(e) => {
            e.currentTarget.playbackRate = 1.05;
          }}
          onPlay={(e) => {
            e.currentTarget.playbackRate = 1.05;
          }}
          className={`absolute inset-0 w-full h-full object-cover scale-105 pointer-events-none transition-opacity duration-300 ease-in-out ${
            isTalkingVisualActive ? 'z-[12] opacity-100' : 'z-10 opacity-0'
          }`}
        />

        <video
          ref={goodbyeVideoRef}
          src="/videos/santa-goodbye.mp4"
          poster="/santa-avatar.png"
          loop
          muted
          playsInline
          preload="auto"
          className={`absolute inset-0 w-full h-full object-cover scale-105 pointer-events-none transition-opacity duration-300 ease-in-out ${
            videoState === 'goodbye' ? 'z-[12] opacity-100' : 'z-10 opacity-0'
          }`}
        />

        {/* Top Scrim + Timer + Premium Golden-Framed Child Front Camera PiP */}
        <div className="absolute inset-x-0 top-0 z-20 pt-safe px-4 pt-4 pb-12 bg-gradient-to-b from-black/75 via-black/30 to-transparent flex items-start justify-between gap-3 pointer-events-none">
          <div className="space-y-1">
            <div className="flex items-center gap-2">
              <span
                className={`text-sm sm:text-base font-semibold tabular-nums px-2.5 py-1 rounded-lg bg-black/55 backdrop-blur-md border ${
                  timeLeft <= farewellThresholdSeconds
                    ? 'border-[#D4AF37]/70 text-[#F5D97E]'
                    : 'border-white/15 text-white'
                }`}
                style={{fontFamily: 'var(--font-mono)'}}
              >
                {formatTimer(timeLeft)}
              </span>
            </div>
            <p className="text-xs font-medium text-white/90 drop-shadow">
              Papai Noel · Polo Norte
            </p>
          </div>

          {/* Child Front Camera Picture-in-Picture with Golden Christmas Glow Frame */}
          <div className="w-24 h-32 sm:w-28 sm:h-36 rounded-2xl p-[2px] bg-gradient-to-br from-[#FCE8A6] via-[#D4AF37] to-[#8C6812] shadow-[0_0_26px_rgba(212,175,55,0.45)] ring-1 ring-[#F5D97E]/40 shrink-0 relative">
            <div className="w-full h-full rounded-[14px] overflow-hidden bg-[#13151C]/95 relative">
              {frontCameraStream ? (
                <video
                  ref={childCamRef}
                  autoPlay
                  muted
                  playsInline
                  className="w-full h-full object-cover scale-x-[-1]"
                />
              ) : (
                <div className="w-full h-full flex flex-col items-center justify-center gap-1.5 text-[#C7C2B6] p-2 text-center">
                  <CameraOff className="w-5 h-5 text-[#D4AF37]/80" aria-hidden="true" />
                  <span className="text-[11px] leading-tight">
                    {config.childName || 'Você'}
                  </span>
                </div>
              )}
              <div
                aria-hidden="true"
                className="absolute inset-0 pointer-events-none rounded-[14px] shadow-[inset_0_0_14px_rgba(212,175,55,0.28)]"
              />
            </div>
          </div>
        </div>

        {/* Clean Bottom Scrim + pb-[env(safe-area-inset-bottom)] so Mic & Hang Up never hide behind mobile bars */}
        <div className="absolute inset-x-0 bottom-0 z-20 px-5 pt-12 pb-[calc(1rem+env(safe-area-inset-bottom))] bg-gradient-to-t from-black/90 via-black/55 to-transparent flex flex-col items-center gap-3">
          {/* Discreet Live State Indicator Only */}
          <div className="min-h-[28px] flex items-center justify-center">
            {isTalkingVisualActive && (
              <span className="inline-flex items-center gap-2 px-3.5 py-1 rounded-full bg-black/60 backdrop-blur-md border border-[#D4AF37]/40 text-xs font-medium text-[#F5D97E]">
                Papai Noel falando...
              </span>
            )}

            {isSendingReply && (
              <span className="inline-flex items-center gap-2 px-3.5 py-1 rounded-full bg-black/60 backdrop-blur-md border border-white/15 text-xs font-medium text-[#E5E7EB]">
                <Loader2 className="w-3.5 h-3.5 animate-spin text-[#D4AF37]" aria-hidden="true" />
                <span>Papai Noel pensando...</span>
              </span>
            )}

            {isListeningBadge && (
              <span className="inline-flex items-center gap-2 px-3.5 py-1 rounded-full bg-black/60 backdrop-blur-md border border-emerald-400/40 text-xs font-medium text-emerald-200">
                <span className="w-2 h-2 rounded-full bg-emerald-400 animate-pulse" />
                <span>Ouvindo...</span>
              </span>
            )}
          </div>

          {/* Interactive 60s Hybrid Mic Controls */}
          {plan.interactive && timeLeft > farewellThresholdSeconds && (
            <div className="w-full max-w-xs flex flex-col items-center">
              <button
                type="button"
                onPointerDown={handlePointerMicDown}
                onPointerUp={handlePointerMicUp}
                onPointerCancel={handlePointerMicUp}
                onTouchStart={handleTouchMicStart}
                onTouchEnd={handleTouchMicEnd}
                onTouchCancel={handleTouchMicEnd}
                onContextMenu={(e) => e.preventDefault()}
                disabled={isSendingReply}
                className={`w-full min-h-[58px] px-6 rounded-2xl font-semibold text-base select-none touch-none flex items-center justify-center gap-3 transition-all shadow-lg cursor-pointer ${
                  isHoldingMic
                    ? 'bg-emerald-500 text-[#0B0C10] scale-[0.98] shadow-[0_0_28px_rgba(16,185,129,0.55)]'
                    : isSendingReply
                      ? 'bg-[#1D202A] text-[#D4AF37] border border-[#D4AF37]/40 cursor-wait'
                      : 'bg-[#D4AF37] text-[#0B0C10] hover:bg-[#E5C454]'
                }`}
              >
                {isSendingReply ? (
                  <>
                    <Loader2 className="w-5 h-5 animate-spin" aria-hidden="true" />
                    <span>Aguarde...</span>
                  </>
                ) : (
                  <>
                    <Mic className="w-5 h-5" aria-hidden="true" />
                    <span>{isHoldingMic ? 'Ouvindo você... Solte para enviar' : 'Segurar para Falar'}</span>
                  </>
                )}
              </button>
            </div>
          )}

          {/* Hang Up Button */}
          <button
            type="button"
            onClick={handleHangUp}
            aria-label="Encerrar chamada"
            className="w-14 h-14 rounded-full bg-red-600 hover:bg-red-500 active:scale-95 text-white flex items-center justify-center shadow-[0_8px_24px_rgba(220,38,38,0.45)] transition-transform cursor-pointer"
          >
            <PhoneOff className="w-6 h-6" aria-hidden="true" />
          </button>
        </div>
      </div>
    </div>
  );
};
