import React, {useEffect} from 'react';
import {PhoneOff, Video} from 'lucide-react';
import {CallConfig, PLANS} from '../types';
import {startIncomingRingtone, stopIncomingRingtone} from '../utils/audioEngine';

interface IncomingCallScreenProps {
  config: CallConfig;
  isPrepared: boolean;
  onAccept: () => void;
  onDecline: () => void;
}

export const IncomingCallScreen: React.FC<IncomingCallScreenProps> = ({
  config,
  isPrepared,
  onAccept,
  onDecline,
}) => {
  const plan = PLANS.find((p) => p.id === config.planId) || PLANS[2];

  useEffect(() => {
    startIncomingRingtone();

    let vibInterval: number | null = null;
    if (typeof navigator !== 'undefined' && 'vibrate' in navigator) {
      try {
        navigator.vibrate([400, 250, 400, 250]);
        vibInterval = window.setInterval(() => {
          navigator.vibrate([400, 250, 400, 250]);
        }, 2200);
      } catch {
        // Ignore on unsupported browsers (iOS Safari)
      }
    }

    return () => {
      stopIncomingRingtone();
      if (vibInterval !== null) {
        window.clearInterval(vibInterval);
      }
      if (typeof navigator !== 'undefined' && 'vibrate' in navigator) {
        try {
          navigator.vibrate(0);
        } catch {
          // Ignore
        }
      }
    };
  }, []);

  return (
    <div className="fixed inset-0 z-40 bg-[#0B0C10]/95 backdrop-blur-xl flex flex-col items-center justify-between pt-safe pb-safe px-6 py-10 text-center">
      {/* Top Caller Info */}
      <div className="mt-6 sm:mt-10 flex flex-col items-center space-y-4">
        <p className="text-xs font-medium tracking-widest uppercase text-[#D4AF37]">
          Chamada de Vídeo Recebida
        </p>

        {/* Realistic Santa Avatar with Gold Border & Real Call Pulsing Effect */}
        <div className="relative mt-4">
          <span
            className="absolute -inset-3 rounded-full border-2 border-[#D4AF37]/55 animate-ring-pulse pointer-events-none"
            aria-hidden="true"
          />
          <span
            className="absolute -inset-6 rounded-full border border-[#D4AF37]/25 animate-ring-pulse pointer-events-none"
            style={{animationDelay: '0.45s'}}
            aria-hidden="true"
          />
          <div className="w-36 h-36 sm:w-40 sm:h-40 rounded-full overflow-hidden border-[3px] border-[#D4AF37] shadow-[0_0_55px_rgba(212,175,55,0.38)] relative z-10 bg-[#13151C]">
            <img
              src="/santa-avatar.png"
              alt="Papai Noel ligando ao vivo"
              className="w-full h-full object-cover"
            />
          </div>
        </div>

        <div className="space-y-1.5 pt-2">
          <h1
            className="text-3xl sm:text-4xl font-semibold text-[#F7F4EC]"
            style={{fontFamily: 'var(--font-display)'}}
          >
            Papai Noel
          </h1>
          <p className="text-base text-[#C7C2B6]">Polo Norte · Linha Mágica</p>
          {config.childName && (
            <p className="text-sm text-[#D4AF37] pt-1">
              Chamando para falar com {config.childName} · {plan.durationSeconds}s
            </p>
          )}
        </div>
      </div>

      {/* Bottom Action Buttons (Authentic Mobile Call UI) */}
      <div className="w-full max-w-sm mb-6 sm:mb-10">
        {!isPrepared && (
          <p className="text-xs text-[#A8A396] mb-5">
            Conectando áudio ao vivo com o Polo Norte...
          </p>
        )}

        <div className="flex items-center justify-around gap-8">
          {/* Recusar */}
          <div className="flex flex-col items-center gap-2.5">
            <button
              type="button"
              onClick={onDecline}
              aria-label="Recusar ligação"
              className="w-[72px] h-[72px] rounded-full bg-red-600 hover:bg-red-500 active:scale-95 text-white flex items-center justify-center shadow-[0_10px_30px_rgba(220,38,38,0.45)] transition-transform cursor-pointer focus-visible:outline-2 focus-visible:outline-white"
            >
              <PhoneOff className="w-8 h-8" aria-hidden="true" />
            </button>
            <span className="text-sm font-medium text-[#E5E7EB]">Recusar</span>
          </div>

          {/* Atender (Verde Pulsante) */}
          <div className="flex flex-col items-center gap-2.5">
            <div className="relative">
              <span
                className="absolute -inset-2 rounded-full bg-emerald-500/45 animate-ring-pulse pointer-events-none"
                aria-hidden="true"
              />
              <button
                type="button"
                onClick={onAccept}
                aria-label="Atender ligação de vídeo"
                className="relative z-10 w-[72px] h-[72px] rounded-full bg-emerald-600 hover:bg-emerald-500 active:scale-95 text-white flex items-center justify-center shadow-[0_10px_32px_rgba(16,185,129,0.5)] transition-transform cursor-pointer focus-visible:outline-2 focus-visible:outline-white"
              >
                <Video className="w-8 h-8" aria-hidden="true" />
              </button>
            </div>
            <span className="text-sm font-semibold text-emerald-300">Atender</span>
          </div>
        </div>
      </div>
    </div>
  );
};
