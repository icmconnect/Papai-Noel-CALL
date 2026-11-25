import React from 'react';
import {WifiOff} from 'lucide-react';
import {useOnlineStatus} from '../hooks/useOnlineStatus';

export const OfflineIndicator: React.FC = () => {
  const isOnline = useOnlineStatus();

  if (isOnline) return null;

  return (
    <div
      role="status"
      className="fixed bottom-4 left-4 z-50 flex items-center gap-2 rounded-xl border border-amber-400/40 bg-[#1B1710] px-3.5 py-2 text-xs font-medium text-amber-200 shadow-lg"
    >
      <WifiOff className="w-4 h-4 text-amber-400 shrink-0" aria-hidden="true" />
      <span>Sem conexão — Usando dados em cache</span>
    </div>
  );
};
