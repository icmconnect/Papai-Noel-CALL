import React from 'react';

interface Flake {
  left: string;
  size: number;
  duration: string;
  delay: string;
  variant: 'a' | 'b';
  opacity: number;
  gold?: boolean;
}

const FLAKES: Flake[] = [
  {left: '4%', size: 4, duration: '13s', delay: '-2s', variant: 'a', opacity: 0.6, gold: true},
  {left: '10%', size: 6, duration: '17s', delay: '-8s', variant: 'b', opacity: 0.4},
  {left: '17%', size: 3, duration: '11s', delay: '-4s', variant: 'a', opacity: 0.7, gold: true},
  {left: '24%', size: 5, duration: '15s', delay: '-11s', variant: 'b', opacity: 0.45},
  {left: '31%', size: 4, duration: '12s', delay: '-1s', variant: 'a', opacity: 0.55, gold: true},
  {left: '39%', size: 7, duration: '19s', delay: '-6s', variant: 'b', opacity: 0.35},
  {left: '47%', size: 3, duration: '14s', delay: '-9s', variant: 'a', opacity: 0.65, gold: true},
  {left: '55%', size: 5, duration: '16s', delay: '-3s', variant: 'b', opacity: 0.45},
  {left: '63%', size: 4, duration: '13s', delay: '-7s', variant: 'a', opacity: 0.6, gold: true},
  {left: '71%', size: 6, duration: '18s', delay: '-12s', variant: 'b', opacity: 0.4},
  {left: '78%', size: 3, duration: '11s', delay: '-5s', variant: 'a', opacity: 0.7, gold: true},
  {left: '86%', size: 5, duration: '15s', delay: '-10s', variant: 'b', opacity: 0.5},
  {left: '93%', size: 4, duration: '12s', delay: '-3s', variant: 'a', opacity: 0.65, gold: true},
];

export const SnowfallBackground: React.FC = () => {
  return (
    <div className="fixed inset-0 overflow-hidden pointer-events-none z-[5]" aria-hidden="true">
      <div
        className="absolute inset-0"
        style={{
          background:
            'radial-gradient(ellipse 80% 55% at 50% 18%, rgba(212, 175, 55, 0.12) 0%, rgba(185, 28, 46, 0.06) 38%, rgba(11, 12, 16, 0) 75%)',
        }}
      />
      {FLAKES.map((flake, idx) => (
        <span
          key={idx}
          className={`snowflake ${flake.variant === 'a' ? 'snowflake-a' : 'snowflake-b'}`}
          style={
            {
              left: flake.left,
              width: `${flake.size}px`,
              height: `${flake.size}px`,
              opacity: flake.opacity,
              ...(flake.gold
                ? {
                    background:
                      'radial-gradient(circle, rgba(245, 217, 126, 0.98) 0%, rgba(212, 175, 55, 0.6) 65%, transparent 100%)',
                    boxShadow: '0 0 8px rgba(212, 175, 55, 0.45)',
                  }
                : {}),
              '--fall-duration': flake.duration,
              '--fall-delay': flake.delay,
            } as React.CSSProperties
          }
        />
      ))}
    </div>
  );
};
