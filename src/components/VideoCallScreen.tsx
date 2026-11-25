import React, {useCallback, useEffect, useRef, useState} from 'react';
import {AlertTriangle, CameraOff, Loader2, Mic, PhoneOff, RotateCcw} from 'lucide-react';
import {CallConfig, ChatTurn, PLANS, PreparedCallMedia, SantaVideoState} from '../types';
import {playSantaAudio, stopCurrentSantaVoice} from '../utils/audioEngine';

type CallPhase = 'waiting-greeting' | 'hello' | 'conversation' | 'farewell' | 'ending';

type PreparedCallMediaWithActs = PreparedCallMedia & {
  bridgeText?: string;
  bridgeAudioBase64?: string | null;
  bridgeAudioMimeType?: string | null;
  bridgeUseBrowserFallback?: boolean;
  bridgeVoiceSource?: string;
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
const MIC_HOLD_MAX_MS = 10000;

function arrayBufferToBase64(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer);
  let binary = '';
  for (let i = 0; i < bytes.byteLength; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  return window.btoa(binary);
}

function normalizeAudioBankSlug(name: string): string {
  return name
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '');
}

async function fetchStaticBankClip(
  candidates: Array<{url: string; mimeType: string}>,
  signal?: AbortSignal
): Promise<{audioBase64: string; audioMimeType: string; url: string} | null> {
  for (const candidate of candidates) {
    if (signal?.aborted) return null;
    try {
      const res = await fetch(candidate.url, signal ? {signal} : undefined);
      const contentType = (res.headers.get('content-type') || '').toLowerCase();
      if (!res.ok || contentType.includes('text/html')) continue;
      const buf = await res.arrayBuffer();
      if (buf.byteLength < 500) continue;
      return {
        audioBase64: arrayBufferToBase64(buf),
        audioMimeType: candidate.mimeType,
        url: candidate.url,
      };
    } catch {
      if (signal?.aborted) return null;
    }
  }
  return null;
}

interface VideoCallScreenProps {
  config: CallConfig;
  preparedMedia: PreparedCallMedia | null;
  entitlementToken?: string | null;
  isCallActive: boolean;
  isPreparingCall?: boolean;
  prepareError?: string | null;
  onRetryGreeting?: () => void;
  onRequestCameraStream?: () => Promise<void> | void;
  helloVideoRef: React.RefObject<HTMLVideoElement | null>;
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

function getFallbackFarewell(farewellType: CallConfig['farewellType'], childName: string): string {
  const name = childName.trim() || 'meu bem';
  switch (farewellType) {
    case 'mamae':
      return `${name}, a Mamãe Noel chamou para o leite quentinho... Feliz Natal!`;
    case 'renas':
      return `${name}, o Rodolfo chamou e o trenó vai decolar... Feliz Natal!`;
    case 'carta':
      return `${name}, chegou uma carta urgente no Polo Norte... Feliz Natal!`;
    case 'duendes':
    default:
      return `${name}, os duendes estão aprontando na fábrica... Feliz Natal!`;
  }
}

export const VideoCallScreen: React.FC<VideoCallScreenProps> = ({
  config,
  preparedMedia,
  entitlementToken,
  isCallActive,
  isPreparingCall = false,
  prepareError = null,
  onRetryGreeting,
  onRequestCameraStream,
  helloVideoRef,
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
  const [helloVideoFailed, setHelloVideoFailed] = useState<boolean>(false);
  const helloVideoFailedRef = useRef<boolean>(false);
  const [isAudioPlaying, setIsAudioPlaying] = useState<boolean>(false);
  const [pipVideoState, setPipVideoState] = useState<'waiting' | 'playing' | 'ended'>('waiting');
  const [isPipTrackUnavailable, setIsPipTrackUnavailable] = useState<boolean>(true);
  const [greetingError, setGreetingError] = useState<string | null>(null);
  const [isBgRetryingGreeting, setIsBgRetryingGreeting] = useState<boolean>(false);
  const [retryNonce, setRetryNonce] = useState<number>(0);
  const [isSpeechListening, setIsSpeechListening] = useState(false);
  const [isHoldingMic, setIsHoldingMic] = useState(false);
  const [isSendingReply, setIsSendingReply] = useState(false);
  const [statusNotice, setStatusNotice] = useState<string | null>(null);

  const childCamRef = useRef<HTMLVideoElement | null>(null);
  const recognitionRef = useRef<SpeechRecognitionLike | null>(null);
  const recognitionModeRef = useRef<'auto' | 'hold' | null>(null);
  const speechApiFailedRef = useRef<boolean>(false);
  const holdTranscriptRef = useRef<string>('');
  const holdFlushedRef = useRef<boolean>(false);
  const holdStopTimeoutRef = useRef<number | null>(null);
  const holdMaxDurationTimeoutRef = useRef<number | null>(null);
  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const micStreamRef = useRef<MediaStream | null>(null);
  const recordedChunksRef = useRef<Blob[]>([]);
  const discardRecordingRef = useRef(false);

  const callPhaseRef = useRef<CallPhase>('waiting-greeting');
  const helloStartedRef = useRef(false);
  const greetingStartedRef = useRef(false);
  const bridgeTriggeredRef = useRef(false);
  const hasInteractiveTurnRef = useRef(false);
  const farewellTriggeredRef = useRef(false);
  const farewellAudioFinishedRef = useRef(false);
  const timerReachedZeroRef = useRef(false);
  const timeLeftRef = useRef<number>(plan.durationSeconds);

  const countdownIntervalRef = useRef<number | null>(null);
  const safetyEndTimeoutRef = useRef<number | null>(null);
  const helloTimeoutRef = useRef<number | null>(null);
  const greetingFallbackTimeoutRef = useRef<number | null>(null);
  const bgGreetingRetryTimeoutRef = useRef<number | null>(null);
  const bgRetryCountRef = useRef<number>(0);
  const genericGreetingAbortRef = useRef<AbortController | null>(null);
  const statusNoticeTimeoutRef = useRef<number | null>(null);
  const silentFarewellTimeoutRef = useRef<number | null>(null);
  const speechRestartTimeoutRef = useRef<number | null>(null);
  const replyAbortTimeoutRef = useRef<number | null>(null);
  const replyAbortControllerRef = useRef<AbortController | null>(null);
  const farewellAbortTimeoutRef = useRef<number | null>(null);
  const farewellAbortControllerRef = useRef<AbortController | null>(null);
  const stopHoldRecordingRef = useRef<() => void>(() => undefined);

  const isAudioPlayingRef = useRef(false);
  const speechEmaRef = useRef(0);
  const lastAboveThresholdAtRef = useRef(0);
  const isGateTalkingRef = useRef(false);

  const isHoldingMicRef = useRef(false);
  const isSendingReplyRef = useRef(false);
  const pendingMicReleaseRef = useRef(false);
  const callEndedCalledRef = useRef(false);
  const historyRef = useRef<ChatTurn[]>([]);
  const mountedRef = useRef(true);
  const preparedMediaRef = useRef<PreparedCallMediaWithActs | null>(
    preparedMedia as PreparedCallMediaWithActs | null
  );
  const prepareErrorRef = useRef<string | null>(prepareError ?? null);
  const callStartMsRef = useRef<number>(Date.now());
  const pausedElapsedMsRef = useRef<number>(0);
  const lastCameraRequestAtRef = useRef<number>(0);
  const startWebSpeechListeningRef = useRef<() => void>(() => undefined);

  useEffect(() => {
    preparedMediaRef.current = preparedMedia as PreparedCallMediaWithActs | null;
  }, [preparedMedia]);

  useEffect(() => {
    prepareErrorRef.current = prepareError ?? null;
  }, [prepareError]);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  const requestNewCameraStreamIfNeeded = useCallback(() => {
    if (
      !isCallActive ||
      callEndedCalledRef.current ||
      farewellTriggeredRef.current ||
      !onRequestCameraStream
    ) {
      return;
    }
    const now = Date.now();
    if (now - lastCameraRequestAtRef.current < 2500) {
      return;
    }
    lastCameraRequestAtRef.current = now;
    void onRequestCameraStream();
  }, [isCallActive, onRequestCameraStream]);

  // PIP local: monitora track ended/muted, re-attach + play ao reativar chamada e recuperação de stream morto
  useEffect(() => {
    const camEl = childCamRef.current;

    if (!isCallActive) {
      if (camEl) {
        camEl.srcObject = null;
      }
      setPipVideoState('waiting');
      setIsPipTrackUnavailable(true);
      return;
    }

    if (!frontCameraStream) {
      if (camEl) {
        camEl.srcObject = null;
      }
      setPipVideoState('ended');
      setIsPipTrackUnavailable(true);
      return;
    }

    const videoTrack = frontCameraStream.getVideoTracks()[0] || null;
    if (!videoTrack || videoTrack.readyState === 'ended') {
      setIsPipTrackUnavailable(true);
      setPipVideoState('ended');
      requestNewCameraStreamIfNeeded();
      return;
    }

    setIsPipTrackUnavailable(videoTrack.muted || !videoTrack.enabled);
    setPipVideoState('waiting');

    if (camEl) {
      camEl.srcObject = frontCameraStream;
      camEl.play().catch(() => undefined);
    }

    const handleTrackEnded = () => {
      if (!mountedRef.current) return;
      setIsPipTrackUnavailable(true);
      setPipVideoState('ended');
      requestNewCameraStreamIfNeeded();
    };

    const handleTrackMute = () => {
      if (!mountedRef.current) return;
      setIsPipTrackUnavailable(true);
    };

    const handleTrackUnmute = () => {
      if (!mountedRef.current) return;
      if (videoTrack.readyState === 'live' && videoTrack.enabled) {
        setIsPipTrackUnavailable(false);
        if (childCamRef.current) {
          childCamRef.current.play().catch(() => undefined);
        }
      }
    };

    videoTrack.addEventListener('ended', handleTrackEnded);
    videoTrack.addEventListener('mute', handleTrackMute);
    videoTrack.addEventListener('unmute', handleTrackUnmute);

    return () => {
      videoTrack.removeEventListener('ended', handleTrackEnded);
      videoTrack.removeEventListener('mute', handleTrackMute);
      videoTrack.removeEventListener('unmute', handleTrackUnmute);
    };
  }, [frontCameraStream, isCallActive, requestNewCameraStreamIfNeeded]);

  const showTemporaryNotice = useCallback((message: string, durationMs = 2400) => {
    if (!mountedRef.current) return;
    if (statusNoticeTimeoutRef.current !== null) {
      window.clearTimeout(statusNoticeTimeoutRef.current);
      statusNoticeTimeoutRef.current = null;
    }
    setStatusNotice(message);
    if (durationMs > 0) {
      statusNoticeTimeoutRef.current = window.setTimeout(() => {
        statusNoticeTimeoutRef.current = null;
        if (mountedRef.current) {
          setStatusNotice(null);
        }
      }, durationMs);
    }
  }, []);

  const clearStatusNotice = useCallback(() => {
    if (statusNoticeTimeoutRef.current !== null) {
      window.clearTimeout(statusNoticeTimeoutRef.current);
      statusNoticeTimeoutRef.current = null;
    }
    if (mountedRef.current) {
      setStatusNotice(null);
    }
  }, []);

  const setAudioPlayingState = useCallback((playing: boolean) => {
    isAudioPlayingRef.current = playing;
    if (mountedRef.current) {
      setIsAudioPlaying(playing);
    }
  }, []);

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
    if (holdMaxDurationTimeoutRef.current !== null) {
      window.clearTimeout(holdMaxDurationTimeoutRef.current);
      holdMaxDurationTimeoutRef.current = null;
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
    if (holdMaxDurationTimeoutRef.current !== null) {
      window.clearTimeout(holdMaxDurationTimeoutRef.current);
      holdMaxDurationTimeoutRef.current = null;
    }
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
    if (bgGreetingRetryTimeoutRef.current !== null) {
      window.clearTimeout(bgGreetingRetryTimeoutRef.current);
      bgGreetingRetryTimeoutRef.current = null;
    }
    if (statusNoticeTimeoutRef.current !== null) {
      window.clearTimeout(statusNoticeTimeoutRef.current);
      statusNoticeTimeoutRef.current = null;
    }
    if (silentFarewellTimeoutRef.current !== null) {
      window.clearTimeout(silentFarewellTimeoutRef.current);
      silentFarewellTimeoutRef.current = null;
    }
    if (genericGreetingAbortRef.current) {
      try {
        genericGreetingAbortRef.current.abort();
      } catch {
        // Ignore
      }
      genericGreetingAbortRef.current = null;
    }
    if (speechRestartTimeoutRef.current !== null) {
      window.clearTimeout(speechRestartTimeoutRef.current);
      speechRestartTimeoutRef.current = null;
    }
    if (holdStopTimeoutRef.current !== null) {
      window.clearTimeout(holdStopTimeoutRef.current);
      holdStopTimeoutRef.current = null;
    }
    if (holdMaxDurationTimeoutRef.current !== null) {
      window.clearTimeout(holdMaxDurationTimeoutRef.current);
      holdMaxDurationTimeoutRef.current = null;
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

    setAudioPlayingState(false);
    resetSpeechGate();
    isSendingReplyRef.current = false;
    stopSpeechRecognition();
    stopMediaRecorderIfActive(true);
    stopCurrentSantaVoice();

    if (micStreamRef.current) {
      micStreamRef.current.getTracks().forEach((t) => t.stop());
      micStreamRef.current = null;
    }
  }, [resetSpeechGate, setAudioPlayingState, stopMediaRecorderIfActive, stopSpeechRecognition]);

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

  const beginHelloPhase = useCallback(() => {
    if (
      helloStartedRef.current ||
      !mountedRef.current ||
      callEndedCalledRef.current ||
      farewellTriggeredRef.current
    ) {
      return;
    }
    helloStartedRef.current = true;

    if (helloTimeoutRef.current !== null) {
      window.clearTimeout(helloTimeoutRef.current);
      helloTimeoutRef.current = null;
    }

    callPhaseRef.current = 'hello';
    setCallPhase('hello');
    setVideoState('hello');

    if (helloVideoRef.current && !helloVideoFailedRef.current) {
      try {
        helloVideoRef.current.currentTime = 0;
        helloVideoRef.current.play().catch(() => {
          helloVideoFailedRef.current = true;
          setHelloVideoFailed(true);
        });
      } catch {
        helloVideoFailedRef.current = true;
        setHelloVideoFailed(true);
      }
    }

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
      callPhaseRef.current = 'conversation';
      setCallPhase('conversation');
      const shouldTalk = isAudioPlayingRef.current && isGateTalkingRef.current;
      setVideoState(shouldTalk ? 'talking' : 'listening');
    }, 3500);
  }, [helloVideoRef, talkingVideoRef]);

  const triggerBridgePhase = useCallback(async () => {
    if (
      bridgeTriggeredRef.current ||
      farewellTriggeredRef.current ||
      !mountedRef.current ||
      callEndedCalledRef.current ||
      config.planId === '15s'
    ) {
      return;
    }
    bridgeTriggeredRef.current = true;

    if (helloTimeoutRef.current !== null) {
      window.clearTimeout(helloTimeoutRef.current);
      helloTimeoutRef.current = null;
    }
    if (callPhaseRef.current === 'hello' || callPhaseRef.current === 'waiting-greeting') {
      callPhaseRef.current = 'conversation';
      setCallPhase('conversation');
    }

    const currentPrepared = preparedMediaRef.current;
    const bridgeText = (currentPrepared?.bridgeText || '').trim();
    let bridgeAudioBase64 = currentPrepared?.bridgeAudioBase64 ?? null;
    let bridgeAudioMimeType = currentPrepared?.bridgeAudioMimeType ?? null;

    if (!bridgeAudioBase64) {
      const bankFallback = await fetchStaticBankClip([
        {url: '/audio/bank/ponte_generica.wav', mimeType: 'audio/wav'},
        {url: '/audio/bank/ponte_generica.mp3', mimeType: 'audio/mpeg'},
      ]);
      if (bankFallback) {
        bridgeAudioBase64 = bankFallback.audioBase64;
        bridgeAudioMimeType = bankFallback.audioMimeType;
      }
    }

    if (farewellTriggeredRef.current || !mountedRef.current || callEndedCalledRef.current) {
      return;
    }

    if (bridgeText) {
      historyRef.current.push({role: 'santa', text: bridgeText});
    }

    if (!bridgeAudioBase64) {
      showTemporaryNotice('Sinal fraco no Polo Norte...', 2400);
      setVideoState('listening');
      scheduleAutoSpeechListening();
      return;
    }

    clearStatusNotice();
    await playSantaAudio({
      audioBase64: bridgeAudioBase64,
      audioMimeType: bridgeAudioMimeType,
      fallbackText: '',
      useBrowserFallback: false,
      disableBrowserFallback: true,
      onStart: () => {
        if (farewellTriggeredRef.current || !mountedRef.current) return;
        setAudioPlayingState(true);
        lastAboveThresholdAtRef.current = performance.now();
        isGateTalkingRef.current = true;
        if (callPhaseRef.current === 'conversation') {
          setVideoState('talking');
        }
      },
      onAudioVolume: syncConversationVideoByVolume,
      onEnd: () => {
        setAudioPlayingState(false);
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
    clearStatusNotice,
    config.planId,
    resetSpeechGate,
    scheduleAutoSpeechListening,
    setAudioPlayingState,
    showTemporaryNotice,
    syncConversationVideoByVolume,
  ]);

  const triggerFarewellPhase = useCallback(async () => {
    const currentPrepared = preparedMediaRef.current;
    const farewellText =
      currentPrepared?.farewellText || getFallbackFarewell(config.farewellType, config.childName);

    let farewellAudioBase64: string | null = currentPrepared?.farewellAudioBase64 ?? null;
    let farewellAudioMimeType: string | null = currentPrepared?.farewellAudioMimeType ?? null;
    let farewellVoiceSource =
      currentPrepared?.farewellVoiceSource ||
      (farewellAudioBase64 ? 'gemini-tts-preloaded' : 'none');

    // Fallback para /api/santa/farewell apenas se não veio pré-carregado
    if (!farewellAudioBase64) {
      const controller = new AbortController();
      farewellAbortControllerRef.current = controller;
      farewellAbortTimeoutRef.current = window.setTimeout(() => {
        controller.abort();
      }, 4500);

      try {
        const res = await fetch('/api/santa/farewell', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            ...(entitlementToken ? {Authorization: `Bearer ${entitlementToken}`} : {}),
          },
          signal: controller.signal,
          body: JSON.stringify({
            childName: config.childName,
            farewellType: config.farewellType,
            farewellText,
            ...(entitlementToken ? {token: entitlementToken} : {}),
          }),
        });
        if (res.ok) {
          const data = (await res.json()) as {
            farewellAudioBase64?: string | null;
            farewellAudioMimeType?: string | null;
            voiceSource?: string;
          };
          farewellAudioBase64 = data.farewellAudioBase64 || null;
          farewellAudioMimeType = data.farewellAudioMimeType || null;
          farewellVoiceSource =
            data.voiceSource || (farewellAudioBase64 ? 'gemini-tts' : 'none');
        }
      } catch {
        // Segue para banco estático ou silêncio
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

    // Sem-robô global: se ainda estiver sem áudio, tenta clipe estático do banco
    if (!farewellAudioBase64) {
      const bankFallback = await fetchStaticBankClip([
        {url: '/audio/bank/despedida_generica.wav', mimeType: 'audio/wav'},
        {url: '/audio/bank/despedida_generica.mp3', mimeType: 'audio/mpeg'},
      ]);
      if (bankFallback) {
        farewellAudioBase64 = bankFallback.audioBase64;
        farewellAudioMimeType = bankFallback.audioMimeType;
        farewellVoiceSource = 'audio-bank';
      }
    }

    console.info(
      `[VideoCallScreen] Farewell voiceSource: ${farewellVoiceSource} (mime=${farewellAudioMimeType || 'none'}, preloaded=${Boolean(currentPrepared?.farewellAudioBase64)})`
    );

    if (!mountedRef.current || callEndedCalledRef.current) return;

    // Se não houver áudio real nem clipe do banco, mantém silêncio + badge sem speechSynthesis
    if (!farewellAudioBase64) {
      showTemporaryNotice('Papai Noel se despedindo · Feliz Natal!', 0);
      if (silentFarewellTimeoutRef.current !== null) {
        window.clearTimeout(silentFarewellTimeoutRef.current);
      }
      silentFarewellTimeoutRef.current = window.setTimeout(() => {
        silentFarewellTimeoutRef.current = null;
        farewellAudioFinishedRef.current = true;
        if (timerReachedZeroRef.current) {
          finishCallSafely();
        }
      }, 2500);
      return;
    }

    clearStatusNotice();
    await playSantaAudio({
      audioBase64: farewellAudioBase64,
      audioMimeType: farewellAudioMimeType,
      fallbackText: '',
      useBrowserFallback: false,
      disableBrowserFallback: true,
      onStart: () => {
        setAudioPlayingState(true);
      },
      onEnd: () => {
        setAudioPlayingState(false);
        farewellAudioFinishedRef.current = true;
        if (timerReachedZeroRef.current) {
          finishCallSafely();
        }
      },
    });
  }, [
    clearStatusNotice,
    config.childName,
    config.farewellType,
    entitlementToken,
    finishCallSafely,
    setAudioPlayingState,
    showTemporaryNotice,
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
      hasInteractiveTurnRef.current = true;
      isSendingReplyRef.current = true;
      setIsSendingReply(true);

      const controller = new AbortController();
      replyAbortControllerRef.current = controller;
      replyAbortTimeoutRef.current = window.setTimeout(() => controller.abort(), 7000);

      try {
        const res = await fetch('/api/santa/reply', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            ...(entitlementToken ? {Authorization: `Bearer ${entitlementToken}`} : {}),
          },
          signal: controller.signal,
          body: JSON.stringify({
            ...payload,
            childName: config.childName,
            childAge: config.childAge,
            praise: config.praise,
            advice: config.advice,
            history: historyRef.current,
            ...(entitlementToken ? {token: entitlementToken} : {}),
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

        let replyAudioBase64 = finalData.audioBase64 || null;
        let replyAudioMimeType = finalData.audioMimeType || null;
        let replyVoiceSource =
          finalData.voiceSource || (replyAudioBase64 ? 'gemini-tts' : 'none');

        if (!replyAudioBase64) {
          const bankFallback = await fetchStaticBankClip([
            {url: '/audio/bank/resposta_generica.wav', mimeType: 'audio/wav'},
            {url: '/audio/bank/resposta_generica.mp3', mimeType: 'audio/mpeg'},
          ]);
          if (bankFallback) {
            replyAudioBase64 = bankFallback.audioBase64;
            replyAudioMimeType = bankFallback.audioMimeType;
            replyVoiceSource = 'audio-bank';
          }
        }

        if (isCallInterrupted()) return;

        console.info(
          `[VideoCallScreen] Reply voiceSource: ${replyVoiceSource} (mime=${replyAudioMimeType || 'none'})`
        );

        // Sem-robô global: se não houver áudio real nem clipe de banco, mantém silêncio + badge
        if (!replyAudioBase64) {
          showTemporaryNotice('Sinal fraco no Polo Norte...', 2400);
          if (callPhaseRef.current === 'conversation') {
            setVideoState('listening');
          }
          scheduleAutoSpeechListening();
          return;
        }

        clearStatusNotice();
        await playSantaAudio({
          audioBase64: replyAudioBase64,
          audioMimeType: replyAudioMimeType,
          fallbackText: '',
          useBrowserFallback: false,
          disableBrowserFallback: true,
          onStart: () => {
            if (isCallInterrupted()) {
              return;
            }
            setAudioPlayingState(true);
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
            setAudioPlayingState(false);
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
        setAudioPlayingState(false);
        resetSpeechGate();
        if (!isCallInterrupted()) {
          showTemporaryNotice('Sinal fraco no Polo Norte...', 2200);
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
      clearStatusNotice,
      config.advice,
      config.childAge,
      config.childName,
      config.praise,
      entitlementToken,
      resetSpeechGate,
      scheduleAutoSpeechListening,
      setAudioPlayingState,
      showTemporaryNotice,
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
        let combined = '';
        let hasFinal = false;
        for (let i = 0; i < event.results.length; i++) {
          const item = event.results[i];
          combined += item[0].transcript + ' ';
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

  const pauseWallClockTimer = useCallback(() => {
    if (countdownIntervalRef.current !== null) {
      pausedElapsedMsRef.current = Math.max(0, Date.now() - callStartMsRef.current);
      window.clearInterval(countdownIntervalRef.current);
      countdownIntervalRef.current = null;
    }
  }, []);

  const startWallClockTimer = useCallback(() => {
    pauseWallClockTimer();

    const durationMs = plan.durationSeconds * 1000;
    const callStartMs = callStartMsRef.current;
    const callEndMs = callStartMs + durationMs;

    countdownIntervalRef.current = window.setInterval(() => {
      if (!mountedRef.current || callEndedCalledRef.current) return;

      const now = Date.now();
      const elapsedMs = now - callStartMs;
      const remainingSeconds = Math.max(0, Math.ceil((callEndMs - now) / 1000));

      if (remainingSeconds !== timeLeftRef.current) {
        timeLeftRef.current = remainingSeconds;
        setTimeLeft(remainingSeconds);
      }

      // ATO 2 (Bridge = conselho + pergunta do presente):
      // - 15s: apenas atos 1 e 3
      // - 30s: ~40% da duração (12s decorridos)
      // - 60s / familia: T-20s se nenhum turno interativo ocorreu
      if (
        config.planId !== '15s' &&
        !bridgeTriggeredRef.current &&
        !farewellTriggeredRef.current &&
        remainingSeconds > farewellThresholdSeconds &&
        preparedMediaRef.current
      ) {
        const shouldTrigger30s =
          config.planId === '30s' &&
          elapsedMs >= durationMs * 0.4 &&
          (!isAudioPlayingRef.current || elapsedMs >= 15000);

        const shouldTriggerInteractive =
          (config.planId === '60s' || config.planId === 'familia') &&
          remainingSeconds <= 20 &&
          !hasInteractiveTurnRef.current &&
          !isSendingReplyRef.current &&
          !isHoldingMicRef.current &&
          (!isAudioPlayingRef.current || elapsedMs >= 43000);

        if (shouldTrigger30s || shouldTriggerInteractive) {
          void triggerBridgePhase();
        }
      }

      // ATO 3 (Farewell) em T-6s (ou T-3s para 15s)
      if (remainingSeconds <= farewellThresholdSeconds && !farewellTriggeredRef.current) {
        farewellTriggeredRef.current = true;
        callPhaseRef.current = 'farewell';
        setCallPhase('farewell');

        if (helloTimeoutRef.current !== null) {
          window.clearTimeout(helloTimeoutRef.current);
          helloTimeoutRef.current = null;
        }
        if (greetingFallbackTimeoutRef.current !== null) {
          window.clearTimeout(greetingFallbackTimeoutRef.current);
          greetingFallbackTimeoutRef.current = null;
        }
        if (genericGreetingAbortRef.current) {
          try {
            genericGreetingAbortRef.current.abort();
          } catch {
            // Ignore
          }
          genericGreetingAbortRef.current = null;
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
        setAudioPlayingState(false);
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

      // Encerramento ao zerar cronômetro
      if (remainingSeconds === 0) {
        pauseWallClockTimer();
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
      }
    }, 200);
  }, [
    config.planId,
    farewellThresholdSeconds,
    finishCallSafely,
    goodbyeVideoRef,
    pauseWallClockTimer,
    plan.durationSeconds,
    resetSpeechGate,
    setAudioPlayingState,
    stopMediaRecorderIfActive,
    stopSpeechRecognition,
    triggerBridgePhase,
    triggerFarewellPhase,
  ]);

  const playGenericBankGreetingClip = useCallback(
    async (
      genericClip: {audioBase64: string; audioMimeType: string; url: string},
      fallbackText = 'Olá! Que alegria falar com você!'
    ) => {
      if (!mountedRef.current || greetingStartedRef.current || farewellTriggeredRef.current) {
        return;
      }
      greetingStartedRef.current = true;
      setGreetingError(null);
      clearStatusNotice();
      historyRef.current = [{role: 'santa', text: fallbackText}];
      if (countdownIntervalRef.current === null) {
        callStartMsRef.current = Date.now();
        startWallClockTimer();
      }

      await playSantaAudio({
        audioBase64: genericClip.audioBase64,
        audioMimeType: genericClip.audioMimeType,
        fallbackText: '',
        useBrowserFallback: false,
        disableBrowserFallback: true,
        onStart: () => {
          setAudioPlayingState(true);
          lastAboveThresholdAtRef.current = performance.now();
          isGateTalkingRef.current = true;
          beginHelloPhase();
        },
        onAudioVolume: syncConversationVideoByVolume,
        onEnd: () => {
          setAudioPlayingState(false);
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
    },
    [
      beginHelloPhase,
      clearStatusNotice,
      resetSpeechGate,
      scheduleAutoSpeechListening,
      setAudioPlayingState,
      startWallClockTimer,
      syncConversationVideoByVolume,
    ]
  );

  // Cronômetro wall-clock inicia imediatamente ao ATENDER (isCallActive=true)
  useEffect(() => {
    if (!isCallActive) {
      cleanupAllDevices();
      helloStartedRef.current = false;
      greetingStartedRef.current = false;
      bridgeTriggeredRef.current = false;
      hasInteractiveTurnRef.current = false;
      farewellTriggeredRef.current = false;
      farewellAudioFinishedRef.current = false;
      timerReachedZeroRef.current = false;
      callEndedCalledRef.current = false;
      timeLeftRef.current = plan.durationSeconds;
      callPhaseRef.current = 'waiting-greeting';
      setCallPhase('waiting-greeting');
      setGreetingError(null);
      setStatusNotice(null);
      setTimeLeft(plan.durationSeconds);
      setVideoState('hello');
      return;
    }

    helloStartedRef.current = false;
    greetingStartedRef.current = false;
    bridgeTriggeredRef.current = false;
    hasInteractiveTurnRef.current = false;
    farewellTriggeredRef.current = false;
    farewellAudioFinishedRef.current = false;
    timerReachedZeroRef.current = false;
    callEndedCalledRef.current = false;
    timeLeftRef.current = plan.durationSeconds;
    callPhaseRef.current = 'waiting-greeting';
    setCallPhase('waiting-greeting');
    setGreetingError(null);
    setStatusNotice(null);
    setTimeLeft(plan.durationSeconds);
    setVideoState('hello');

    if (helloVideoRef.current && !helloVideoFailedRef.current) {
      try {
        helloVideoRef.current.currentTime = 0;
        helloVideoRef.current.play().catch(() => {
          helloVideoFailedRef.current = true;
          setHelloVideoFailed(true);
        });
      } catch {
        helloVideoFailedRef.current = true;
        setHelloVideoFailed(true);
      }
    }

    if (talkingVideoRef.current) {
      try {
        talkingVideoRef.current.playbackRate = 1.05;
        talkingVideoRef.current.currentTime = 0;
        talkingVideoRef.current.play().catch(() => undefined);
      } catch {
        // Ignore
      }
    }

    // Relógio wall-clock contínuo desde o momento em que a chamada é atendida
    pausedElapsedMsRef.current = 0;
    bgRetryCountRef.current = 0;
    setIsBgRetryingGreeting(false);
    callStartMsRef.current = Date.now();
    startWallClockTimer();

    // Proteção após 4000ms se preparedMedia ainda estiver carregando:
    // tenta /audio/bank/ola_generico.mp3 E .wav; se ambos faltarem, exibe card de erro com "Tentar novamente"
    greetingFallbackTimeoutRef.current = window.setTimeout(() => {
      greetingFallbackTimeoutRef.current = null;
      if (
        !mountedRef.current ||
        greetingStartedRef.current ||
        farewellTriggeredRef.current ||
        preparedMediaRef.current
      ) {
        return;
      }

      const abortController = new AbortController();
      genericGreetingAbortRef.current = abortController;

      void (async () => {
        const genericClip = await fetchStaticBankClip(
          [
            {url: '/audio/bank/ola_generico.mp3', mimeType: 'audio/mpeg'},
            {url: '/audio/bank/ola_generico.wav', mimeType: 'audio/wav'},
          ],
          abortController.signal
        );

        if (genericGreetingAbortRef.current === abortController) {
          genericGreetingAbortRef.current = null;
        }

        if (
          !mountedRef.current ||
          greetingStartedRef.current ||
          farewellTriggeredRef.current ||
          preparedMediaRef.current
        ) {
          return;
        }

        if (!genericClip) {
          pauseWallClockTimer();
          clearStatusNotice();
          setGreetingError(
            prepareErrorRef.current ||
              'Não foi possível carregar o áudio do Papai Noel no momento.'
          );
          return;
        }

        await playGenericBankGreetingClip(genericClip);
      })();
    }, 4000);

    return () => {
      cleanupAllDevices();
    };
  }, [
    cleanupAllDevices,
    clearStatusNotice,
    helloVideoRef,
    isCallActive,
    pauseWallClockTimer,
    plan.durationSeconds,
    playGenericBankGreetingClip,
    retryNonce,
    startWallClockTimer,
    talkingVideoRef,
  ]);

  // Se prepareError ocorrer antes dos 4s, tenta banco (.mp3 e .wav); se faltar, exibe card de erro imediatamente
  useEffect(() => {
    if (
      !isCallActive ||
      !prepareError ||
      preparedMedia ||
      greetingStartedRef.current ||
      farewellTriggeredRef.current
    ) {
      return;
    }

    if (greetingFallbackTimeoutRef.current !== null) {
      window.clearTimeout(greetingFallbackTimeoutRef.current);
      greetingFallbackTimeoutRef.current = null;
    }

    const abortController = new AbortController();
    genericGreetingAbortRef.current = abortController;

    void (async () => {
      const slug = normalizeAudioBankSlug(config.childName);
      const candidates: Array<{url: string; mimeType: string}> = [];
      if (slug) {
        candidates.push(
          {url: `/audio/bank/ola_${slug}.wav`, mimeType: 'audio/wav'},
          {url: `/audio/bank/${slug}.wav`, mimeType: 'audio/wav'},
          {url: `/audio/bank/ola_${slug}.mp3`, mimeType: 'audio/mpeg'},
          {url: `/audio/bank/${slug}.mp3`, mimeType: 'audio/mpeg'}
        );
      }
      candidates.push(
        {url: '/audio/bank/ola_generico.mp3', mimeType: 'audio/mpeg'},
        {url: '/audio/bank/ola_generico.wav', mimeType: 'audio/wav'}
      );

      const bankClip = await fetchStaticBankClip(candidates, abortController.signal);
      if (genericGreetingAbortRef.current === abortController) {
        genericGreetingAbortRef.current = null;
      }

      if (
        !mountedRef.current ||
        greetingStartedRef.current ||
        farewellTriggeredRef.current ||
        preparedMediaRef.current
      ) {
        return;
      }

      if (bankClip) {
        await playGenericBankGreetingClip(bankClip);
        return;
      }

      pauseWallClockTimer();
      clearStatusNotice();
      setGreetingError(prepareError);
    })();
  }, [
    clearStatusNotice,
    config.childName,
    isCallActive,
    pauseWallClockTimer,
    playGenericBankGreetingClip,
    prepareError,
    preparedMedia,
  ]);

  // Inicia áudio da saudação (ATO 1) quando preparedMedia estiver pronto (sempre sem speechSynthesis)
  useEffect(() => {
    if (!isCallActive || !preparedMedia || greetingStartedRef.current || farewellTriggeredRef.current) {
      return;
    }

    if (greetingFallbackTimeoutRef.current !== null) {
      window.clearTimeout(greetingFallbackTimeoutRef.current);
      greetingFallbackTimeoutRef.current = null;
    }
    if (genericGreetingAbortRef.current) {
      try {
        genericGreetingAbortRef.current.abort();
      } catch {
        // Ignore
      }
      genericGreetingAbortRef.current = null;
    }

    greetingStartedRef.current = true;
    setGreetingError(null);
    historyRef.current = [{role: 'santa', text: preparedMedia.greetingText}];

    void (async () => {
      let greetingAudioBase64 = preparedMedia.greetingAudioBase64 || null;
      let greetingAudioMimeType = preparedMedia.greetingAudioMimeType || null;
      let greetingVoiceSource =
        preparedMedia.voiceSource || (greetingAudioBase64 ? 'gemini-tts' : 'none');

      if (!greetingAudioBase64) {
        const slug = normalizeAudioBankSlug(config.childName);
        const candidates: Array<{url: string; mimeType: string}> = [];
        if (slug) {
          candidates.push(
            {url: `/audio/bank/ola_${slug}.wav`, mimeType: 'audio/wav'},
            {url: `/audio/bank/${slug}.wav`, mimeType: 'audio/wav'},
            {url: `/audio/bank/ola_${slug}.mp3`, mimeType: 'audio/mpeg'},
            {url: `/audio/bank/${slug}.mp3`, mimeType: 'audio/mpeg'}
          );
        }
        candidates.push(
          {url: '/audio/bank/ola_generico.mp3', mimeType: 'audio/mpeg'},
          {url: '/audio/bank/ola_generico.wav', mimeType: 'audio/wav'}
        );

        const bankFallback = await fetchStaticBankClip(candidates);
        if (bankFallback) {
          greetingAudioBase64 = bankFallback.audioBase64;
          greetingAudioMimeType = bankFallback.audioMimeType;
          greetingVoiceSource = 'audio-bank';
        }
      }

      if (!mountedRef.current || farewellTriggeredRef.current || callEndedCalledRef.current) {
        return;
      }

      console.info(
        `[VideoCallScreen] Greeting voiceSource: ${greetingVoiceSource} (mime=${greetingAudioMimeType || 'none'})`
      );

      // Se greeting falhou E nenhum clipe estático (.mp3/.wav) existir, mostra card de erro com "Tentar novamente"
      if (!greetingAudioBase64) {
        greetingStartedRef.current = false;
        pauseWallClockTimer();
        clearStatusNotice();
        setGreetingError(
          preparedMedia.ttsError ||
            'Não foi possível carregar o áudio do Papai Noel. Tente novamente.'
        );
        return;
      }

      if (countdownIntervalRef.current === null) {
        callStartMsRef.current = Date.now() - pausedElapsedMsRef.current;
        startWallClockTimer();
      }

      if (bgGreetingRetryTimeoutRef.current !== null) {
        window.clearTimeout(bgGreetingRetryTimeoutRef.current);
        bgGreetingRetryTimeoutRef.current = null;
      }
      bgRetryCountRef.current = 0;
      setIsBgRetryingGreeting(false);
      setGreetingError(null);
      clearStatusNotice();
      await playSantaAudio({
        audioBase64: greetingAudioBase64,
        audioMimeType: greetingAudioMimeType,
        fallbackText: '',
        useBrowserFallback: false,
        disableBrowserFallback: true,
        onStart: () => {
          setAudioPlayingState(true);
          lastAboveThresholdAtRef.current = performance.now();
          isGateTalkingRef.current = true;
          beginHelloPhase();
        },
        onAudioVolume: syncConversationVideoByVolume,
        onEnd: () => {
          setAudioPlayingState(false);
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
    })();
  }, [
    beginHelloPhase,
    clearStatusNotice,
    config.childName,
    isCallActive,
    pauseWallClockTimer,
    preparedMedia,
    resetSpeechGate,
    scheduleAutoSpeechListening,
    setAudioPlayingState,
    startWallClockTimer,
    syncConversationVideoByVolume,
  ]);

  // Auto-retry em background após 15s enquanto o card de retry estiver visível (sem reiniciar a chamada)
  useEffect(() => {
    if (
      !isCallActive ||
      !greetingError ||
      greetingStartedRef.current ||
      farewellTriggeredRef.current ||
      callEndedCalledRef.current ||
      isPreparingCall ||
      !onRetryGreeting
    ) {
      return;
    }

    if (bgRetryCountRef.current >= 4) {
      return;
    }

    if (bgGreetingRetryTimeoutRef.current !== null) {
      window.clearTimeout(bgGreetingRetryTimeoutRef.current);
    }

    bgGreetingRetryTimeoutRef.current = window.setTimeout(() => {
      bgGreetingRetryTimeoutRef.current = null;
      if (
        !mountedRef.current ||
        !isCallActive ||
        greetingStartedRef.current ||
        farewellTriggeredRef.current ||
        callEndedCalledRef.current
      ) {
        return;
      }
      bgRetryCountRef.current += 1;
      setIsBgRetryingGreeting(true);
      onRetryGreeting();
    }, 15000);

    return () => {
      if (bgGreetingRetryTimeoutRef.current !== null) {
        window.clearTimeout(bgGreetingRetryTimeoutRef.current);
        bgGreetingRetryTimeoutRef.current = null;
      }
    };
  }, [greetingError, isCallActive, isPreparingCall, onRetryGreeting]);

  const handleRetryGreeting = useCallback(() => {
    cleanupAllDevices();
    helloStartedRef.current = false;
    greetingStartedRef.current = false;
    bridgeTriggeredRef.current = false;
    hasInteractiveTurnRef.current = false;
    farewellTriggeredRef.current = false;
    farewellAudioFinishedRef.current = false;
    timerReachedZeroRef.current = false;
    callEndedCalledRef.current = false;
    pausedElapsedMsRef.current = 0;
    bgRetryCountRef.current = 0;
    setIsBgRetryingGreeting(false);
    timeLeftRef.current = plan.durationSeconds;
    callPhaseRef.current = 'waiting-greeting';
    setCallPhase('waiting-greeting');
    setGreetingError(null);
    setStatusNotice(null);
    setTimeLeft(plan.durationSeconds);
    setVideoState('hello');
    setRetryNonce((n) => n + 1);
    onRetryGreeting?.();
  }, [cleanupAllDevices, onRetryGreeting, plan.durationSeconds]);

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

  const stopHoldRecording = useCallback(() => {
    if (holdMaxDurationTimeoutRef.current !== null) {
      window.clearTimeout(holdMaxDurationTimeoutRef.current);
      holdMaxDurationTimeoutRef.current = null;
    }

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
  }, [flushHoldSpeechTranscript]);

  stopHoldRecordingRef.current = stopHoldRecording;

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

    // Teto de 10s no hold do mic com auto-envio (stopHoldRecording automático)
    if (holdMaxDurationTimeoutRef.current !== null) {
      window.clearTimeout(holdMaxDurationTimeoutRef.current);
    }
    holdMaxDurationTimeoutRef.current = window.setTimeout(() => {
      holdMaxDurationTimeoutRef.current = null;
      if (isHoldingMicRef.current && mountedRef.current) {
        stopHoldRecordingRef.current();
      }
    }, MIC_HOLD_MAX_MS);

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
    setAudioPlayingState(false);
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
    !isAudioPlaying &&
    !isSendingReply &&
    !statusNotice &&
    !greetingError &&
    callPhase !== 'farewell' &&
    callPhase !== 'ending' &&
    (isHoldingMic || isSpeechListening || (plan.interactive && timeLeft > farewellThresholdSeconds));

  const isHelloVisualActive = videoState === 'hello' && !helloVideoFailed;
  const isTalkingVisualActive =
    videoState === 'talking' || (videoState === 'hello' && helloVideoFailed);
  const isFarewellVisualPhase = callPhase === 'farewell' || callPhase === 'ending';
  const showPipOffPlaceholder =
    !frontCameraStream || isPipTrackUnavailable || pipVideoState === 'ended';

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

        {/* Overlapping <video> Elements with object-cover scale-105 & smooth 500ms Opacity Crossfade */}
        <video
          ref={helloVideoRef}
          src="/videos/santa-hello.mp4"
          poster="/santa-avatar.png"
          loop
          muted
          playsInline
          autoPlay
          preload="auto"
          onError={() => {
            helloVideoFailedRef.current = true;
            setHelloVideoFailed(true);
          }}
          className={`absolute inset-0 w-full h-full object-cover scale-105 pointer-events-none transition-opacity duration-500 ease-in-out ${
            isHelloVisualActive ? 'z-[12] opacity-100' : 'z-10 opacity-0'
          }`}
        />

        <video
          ref={listeningVideoRef}
          src="/videos/santa-listening.mp4"
          poster="/santa-avatar.png"
          loop
          muted
          playsInline
          autoPlay
          preload="auto"
          className={`absolute inset-0 w-full h-full object-cover scale-105 pointer-events-none transition-opacity duration-500 ease-in-out ${
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
          className={`absolute inset-0 w-full h-full object-cover scale-105 pointer-events-none transition-opacity duration-500 ease-in-out ${
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
          className={`absolute inset-0 w-full h-full object-cover scale-105 pointer-events-none transition-opacity duration-500 ease-in-out ${
            videoState === 'goodbye' ? 'z-[12] opacity-100' : 'z-10 opacity-0'
          }`}
        />

        {/* Top Scrim + Timer (or "Feliz Natal!" on farewell) + Golden-Framed Child Front Camera PiP */}
        <div className="absolute inset-x-0 top-0 z-20 pt-safe px-4 pt-4 pb-12 bg-gradient-to-b from-black/75 via-black/30 to-transparent flex items-start justify-between gap-3 pointer-events-none">
          <div className="space-y-1">
            <div className="flex items-center gap-2">
              <span
                className={`text-sm sm:text-base font-semibold tabular-nums px-2.5 py-1 rounded-lg bg-black/55 backdrop-blur-md border ${
                  isFarewellVisualPhase || timeLeft <= farewellThresholdSeconds
                    ? 'border-[#D4AF37]/70 text-[#F5D97E]'
                    : 'border-white/15 text-white'
                }`}
                style={{fontFamily: isFarewellVisualPhase ? 'var(--font-display)' : 'var(--font-mono)'}}
              >
                {isFarewellVisualPhase ? 'Feliz Natal!' : formatTimer(timeLeft)}
              </span>
            </div>
            <p className="text-xs font-medium text-white/90 drop-shadow">
              Papai Noel · Polo Norte
            </p>
          </div>

          {/* Child Front Camera Picture-in-Picture with Golden Christmas Glow Frame */}
          <div className="w-24 h-32 sm:w-28 sm:h-36 rounded-2xl p-[2px] bg-gradient-to-br from-[#FCE8A6] via-[#D4AF37] to-[#8C6812] shadow-[0_0_26px_rgba(212,175,55,0.45)] ring-1 ring-[#F5D97E]/40 shrink-0 relative">
            <div className="w-full h-full rounded-[14px] overflow-hidden bg-[#13151C]/95 relative">
              {frontCameraStream && (
                <video
                  ref={childCamRef}
                  autoPlay
                  muted
                  playsInline
                  onPlaying={() => {
                    setPipVideoState('playing');
                    const track = frontCameraStream.getVideoTracks()[0];
                    if (track && track.readyState === 'live' && !track.muted && track.enabled) {
                      setIsPipTrackUnavailable(false);
                    }
                  }}
                  onWaiting={() => setPipVideoState('waiting')}
                  onEnded={() => {
                    setPipVideoState('ended');
                    setIsPipTrackUnavailable(true);
                    requestNewCameraStreamIfNeeded();
                  }}
                  className={`w-full h-full object-cover scale-x-[-1] transition-opacity duration-200 ${
                    showPipOffPlaceholder ? 'opacity-0' : 'opacity-100'
                  }`}
                />
              )}

              {showPipOffPlaceholder && (
                <div className="absolute inset-0 w-full h-full flex flex-col items-center justify-center gap-1.5 text-[#C7C2B6] p-2 text-center bg-[#13151C]/95">
                  <CameraOff className="w-5 h-5 text-[#D4AF37]/80" aria-hidden="true" />
                  <span className="text-[11px] font-medium leading-tight text-[#E5E0D4]">
                    Câmera desligada
                  </span>
                </div>
              )}

              {!showPipOffPlaceholder && pipVideoState === 'waiting' && (
                <div className="absolute inset-0 flex items-center justify-center bg-[#13151C]/60 pointer-events-none">
                  <Loader2 className="w-4 h-4 animate-spin text-[#D4AF37]" aria-hidden="true" />
                </div>
              )}

              <div
                aria-hidden="true"
                className="absolute inset-0 pointer-events-none rounded-[14px] shadow-[inset_0_0_14px_rgba(212,175,55,0.28)]"
              />
            </div>
          </div>
        </div>

        {/* Greeting Error Card with Retry Action */}
        {greetingError && callPhase !== 'ending' && (
          <div className="absolute inset-0 z-30 flex items-center justify-center px-5 bg-[#0B0C10]/80 backdrop-blur-md">
            <div
              role="alert"
              className="w-full max-w-xs rounded-2xl border border-[#D4AF37]/45 bg-[#13151C]/95 p-5 text-center space-y-4 shadow-2xl"
            >
              <div className="w-11 h-11 mx-auto rounded-full bg-amber-500/15 border border-amber-400/40 flex items-center justify-center text-[#F5D97E]">
                <AlertTriangle className="w-5 h-5" aria-hidden="true" />
              </div>
              <div className="space-y-1.5">
                <h3
                  className="text-base font-semibold text-[#F7F4EC]"
                  style={{fontFamily: 'var(--font-display)'}}
                >
                  Sinal instável no Polo Norte
                </h3>
                <p className="text-xs text-[#C7C2B6] leading-relaxed">{greetingError}</p>
                <p className="text-[11px] text-[#F5D97E]">
                  {isBgRetryingGreeting && isPreparingCall
                    ? 'Reconectando automaticamente em segundo plano...'
                    : 'Tentativa automática em segundo plano a cada 15s.'}
                </p>
              </div>
              <div className="flex flex-col gap-2">
                <button
                  type="button"
                  onClick={handleRetryGreeting}
                  disabled={isPreparingCall && !isBgRetryingGreeting}
                  className="w-full min-h-[46px] px-4 rounded-xl bg-[#D4AF37] text-[#0B0C10] font-bold text-sm flex items-center justify-center gap-2 hover:bg-[#E5C454] active:scale-[0.98] transition-all cursor-pointer disabled:opacity-60 disabled:cursor-wait"
                >
                  {isPreparingCall ? (
                    <>
                      <Loader2 className="w-4 h-4 animate-spin" aria-hidden="true" />
                      <span>Reconectando...</span>
                    </>
                  ) : (
                    <>
                      <RotateCcw className="w-4 h-4" aria-hidden="true" />
                      <span>Tentar novamente</span>
                    </>
                  )}
                </button>
                <button
                  type="button"
                  onClick={handleHangUp}
                  className="w-full min-h-[40px] px-4 rounded-xl border border-white/15 text-xs font-medium text-[#D1D5DB] hover:bg-white/5 cursor-pointer"
                >
                  Encerrar chamada
                </button>
              </div>
            </div>
          </div>
        )}

        {/* Clean Bottom Scrim + pb-[env(safe-area-inset-bottom)] so Mic & Hang Up never hide behind mobile bars */}
        <div className="absolute inset-x-0 bottom-0 z-20 px-5 pt-12 pb-[calc(1rem+env(safe-area-inset-bottom))] bg-gradient-to-t from-black/90 via-black/55 to-transparent flex flex-col items-center gap-3">
          {/* Discreet Live State Indicator Only */}
          <div className="min-h-[28px] flex items-center justify-center">
            {statusNotice && (
              <span className="inline-flex items-center gap-2 px-3.5 py-1 rounded-full bg-black/60 backdrop-blur-md border border-[#D4AF37]/40 text-xs font-medium text-[#F5D97E]">
                <Loader2 className="w-3.5 h-3.5 animate-spin text-[#D4AF37]" aria-hidden="true" />
                <span>{statusNotice}</span>
              </span>
            )}

            {!statusNotice && !greetingError && callPhase === 'waiting-greeting' && (
              <span className="inline-flex items-center gap-2 px-3.5 py-1 rounded-full bg-black/60 backdrop-blur-md border border-[#D4AF37]/40 text-xs font-medium text-[#F5D97E]">
                <Loader2 className="w-3.5 h-3.5 animate-spin text-[#D4AF37]" aria-hidden="true" />
                <span>Conectando ao Polo Norte...</span>
              </span>
            )}

            {!statusNotice && !greetingError && isAudioPlaying && (
              <span className="inline-flex items-center gap-2 px-3.5 py-1 rounded-full bg-black/60 backdrop-blur-md border border-[#D4AF37]/40 text-xs font-medium text-[#F5D97E]">
                Papai Noel falando...
              </span>
            )}

            {!statusNotice && !greetingError && isSendingReply && (
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
          {plan.interactive && timeLeft > farewellThresholdSeconds && !isFarewellVisualPhase && (
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
