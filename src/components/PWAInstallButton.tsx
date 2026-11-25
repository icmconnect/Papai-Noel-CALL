import React, {useState} from 'react';
import {Download, Share, X} from 'lucide-react';
import {usePWAInstall} from '../hooks/usePWAInstall';

export const PWAInstallButton: React.FC = () => {
  const {isInstallable, isInstalled, isIOS, install} = usePWAInstall();
  const [showIOSGuide, setShowIOSGuide] = useState(false);

  if (isInstalled) {
    return null;
  }

  if (isInstallable) {
    return (
      <button
        type="button"
        onClick={install}
        className="inline-flex items-center gap-2 min-h-[44px] px-4 py-2 rounded-xl border border-[#D4AF37]/40 bg-[#151821] text-sm font-medium text-[#F5D97E] hover:bg-[#1E222E] transition-colors whitespace-nowrap shrink-0 cursor-pointer focus-visible:outline-2 focus-visible:outline-[#D4AF37]"
      >
        <Download className="w-4 h-4" aria-hidden="true" />
        <span>Instalar App</span>
      </button>
    );
  }

  if (isIOS) {
    return (
      <>
        <button
          type="button"
          onClick={() => setShowIOSGuide(true)}
          className="inline-flex items-center gap-2 min-h-[44px] px-4 py-2 rounded-xl border border-[#D4AF37]/35 bg-[#151821] text-sm font-medium text-[#F5D97E] hover:bg-[#1E222E] transition-colors whitespace-nowrap shrink-0 cursor-pointer focus-visible:outline-2 focus-visible:outline-[#D4AF37]"
        >
          <Share className="w-4 h-4" aria-hidden="true" />
          <span>Instalar no iPhone</span>
        </button>

        {showIOSGuide && (
          <div
            className="fixed inset-0 z-50 flex items-center justify-center bg-black/75 backdrop-blur-sm p-4"
            role="dialog"
            aria-modal="true"
            aria-labelledby="ios-pwa-title"
          >
            <div className="w-full max-w-sm rounded-2xl border border-[#D4AF37]/30 bg-[#13151C] p-6 text-[#F7F4EC] shadow-2xl">
              <div className="flex items-start justify-between gap-4">
                <h3
                  id="ios-pwa-title"
                  className="text-lg font-semibold text-[#F5D97E]"
                  style={{fontFamily: 'var(--font-display)'}}
                >
                  Instalar no iPhone / iPad
                </h3>
                <button
                  type="button"
                  onClick={() => setShowIOSGuide(false)}
                  aria-label="Fechar instruções"
                  className="min-w-[40px] min-h-[40px] flex items-center justify-center rounded-lg text-[#9CA3AF] hover:text-white hover:bg-white/5 cursor-pointer"
                >
                  <X className="w-5 h-5" />
                </button>
              </div>
              <ol className="mt-4 space-y-3 text-sm text-[#D1D5DB] leading-relaxed">
                <li>
                  1. Toque no botão <strong className="text-white">Compartilhar</strong> na barra
                  inferior do Safari.
                </li>
                <li>
                  2. Role para baixo e toque em{' '}
                  <strong className="text-white">Adicionar à Tela de Início</strong>.
                </li>
                <li>
                  3. Confirme em <strong className="text-white">Adicionar</strong> para usar em
                  tela cheia.
                </li>
              </ol>
              <button
                type="button"
                onClick={() => setShowIOSGuide(false)}
                className="mt-6 w-full min-h-[44px] rounded-xl bg-[#D4AF37] text-[#0B0C10] font-semibold text-sm hover:bg-[#E5C454] transition-colors cursor-pointer"
              >
                Entendi
              </button>
            </div>
          </div>
        )}
      </>
    );
  }

  return null;
};
