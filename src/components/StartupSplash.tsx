import React, { useEffect, useRef, useState } from 'react';
import { Play } from 'lucide-react';

interface StartupSplashProps {
  onComplete: () => void;
}

export const StartupSplash: React.FC<StartupSplashProps> = ({ onComplete }) => {
  const [animationStep, setAnimationStep] = useState<'enter' | 'lift' | 'clap' | 'action' | 'exit'>('enter');
  const [clapped, setClapped] = useState(false);

  const onCompleteRef = useRef(onComplete);
  onCompleteRef.current = onComplete;

  useEffect(() => {
    // 1. Enter: 0ms -> Chair and Clapper scale up in center
    // 2. Lift: 450ms -> Clapper top arm swings up
    const t1 = setTimeout(() => {
      setAnimationStep('lift');
    }, 450);

    // 3. Clap: 1050ms -> Clapper top arm claps down sharply!
    const t2 = setTimeout(() => {
      setAnimationStep('clap');
      setClapped(true);
      // Play a soft synthetic audio clap
      playGentleClapSound();
    }, 1050);

    // 4. Action: 1400ms -> "Take 1 • Action!" reveals
    const t3 = setTimeout(() => {
      setAnimationStep('action');
    }, 1400);

    // 5. Exit: 2200ms -> Smooth fade to homepage
    const t4 = setTimeout(() => {
      setAnimationStep('exit');
    }, 2200);

    // 6. Complete: 2700ms -> Unmount splash
    const t5 = setTimeout(() => {
      onCompleteRef.current();
    }, 2700);

    return () => {
      clearTimeout(t1);
      clearTimeout(t2);
      clearTimeout(t3);
      clearTimeout(t4);
      clearTimeout(t5);
    };
  }, []);

  // Audio synthesize a crisp clapperboard snap
  const playGentleClapSound = () => {
    try {
      const AudioCtx = window.AudioContext || (window as any).webkitAudioContext;
      if (!AudioCtx) return;
      const ctx = new AudioCtx();
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();

      osc.type = 'triangle';
      osc.frequency.setValueAtTime(320, ctx.currentTime);
      osc.frequency.exponentialRampToValueAtTime(80, ctx.currentTime + 0.08);

      gain.gain.setValueAtTime(0.25, ctx.currentTime);
      gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.09);

      osc.connect(gain);
      gain.connect(ctx.destination);

      osc.start();
      osc.stop(ctx.currentTime + 0.1);
    } catch {
      // AudioContext auto-play might be restricted before user gesture
    }
  };

  return (
    <div
      className={`fixed inset-0 z-50 flex flex-col items-center justify-center bg-white transition-opacity duration-500 ease-out select-none ${
        animationStep === 'exit' ? 'opacity-0 pointer-events-none' : 'opacity-100'
      }`}
    >
      {/* Google 4-Color Subtle Top Bar */}
      <div className="absolute top-0 inset-x-0 h-1 bg-gradient-to-r from-[#4285F4] via-[#EA4335] via-[#FBBC04] to-[#34A853]" />

      {/* Skip Button */}
      <button
        onClick={onComplete}
        className="absolute top-6 right-6 px-3.5 py-1.5 rounded-full text-xs font-medium text-[#5F6368] hover:text-[#202124] hover:bg-[#F1F3F4] transition-colors border border-[#DADCE0] flex items-center gap-1.5"
      >
        <span>Skip</span>
        <Play className="w-3 h-3 fill-current" />
      </button>

      {/* Main Center Animation Stage */}
      <div className="flex flex-col items-center justify-center space-y-6 max-w-sm px-4">
        {/* Animated Symbols Container: Director's Chair + Clapperboard */}
        <div className="relative w-56 h-48 flex items-center justify-center">
          {/* Subtle Google ambient blur ring */}
          <div
            className={`absolute inset-0 rounded-full bg-gradient-to-tr from-[#4285F4]/10 via-[#FBBC04]/10 to-[#34A853]/10 blur-2xl transition-all duration-700 ${
              clapped ? 'scale-125 opacity-70' : 'scale-90 opacity-40'
            }`}
          />

          {/* 1. DIRECTOR'S CHAIR (Left-Center) */}
          <div
            className={`absolute left-4 bottom-2 transition-all duration-700 ease-out ${
              animationStep === 'enter' ? 'opacity-0 translate-y-6 scale-90' : 'opacity-100 translate-y-0 scale-100'
            }`}
          >
            <svg
              width="100"
              height="120"
              viewBox="0 0 100 120"
              fill="none"
              xmlns="http://www.w3.org/2000/svg"
              className="drop-shadow-md"
            >
              {/* Backrest Canvas */}
              <rect x="20" y="14" width="60" height="26" rx="4" fill="#1A73E8" />
              {/* "DIRECTOR" text subtle on backrest */}
              <text
                x="50"
                y="30"
                textAnchor="middle"
                fill="#FFFFFF"
                fontSize="6"
                fontWeight="700"
                letterSpacing="1.5"
                fontFamily="system-ui, sans-serif"
              >
                DIRECTOR
              </text>

              {/* Wooden Frame Back Poles */}
              <rect x="18" y="8" width="4" height="42" rx="2" fill="#202124" />
              <rect x="78" y="8" width="4" height="42" rx="2" fill="#202124" />

              {/* Armrests */}
              <rect x="12" y="44" width="22" height="4" rx="2" fill="#3C4043" />
              <rect x="66" y="44" width="22" height="4" rx="2" fill="#3C4043" />

              {/* Seat Canvas */}
              <path
                d="M18 52 C30 55, 70 55, 82 52 L82 56 C70 59, 30 59, 18 56 Z"
                fill="#1557B0"
              />

              {/* X-Legs (Scissors mechanism) */}
              {/* Leg 1: Top-Left to Bottom-Right */}
              <line x1="20" y1="54" x2="78" y2="114" stroke="#202124" strokeWidth="4" strokeLinecap="round" />
              {/* Leg 2: Top-Right to Bottom-Left */}
              <line x1="80" y1="54" x2="22" y2="114" stroke="#202124" strokeWidth="4" strokeLinecap="round" />

              {/* Pivot Bolt Center */}
              <circle cx="50" cy="84" r="3.5" fill="#FBBC04" stroke="#202124" strokeWidth="1.5" />

              {/* Footrest Bar */}
              <rect x="26" y="98" width="48" height="3" rx="1.5" fill="#5F6368" />
            </svg>
          </div>

          {/* 2. CLAPPERBOARD (Right-Center with Hinged Arm) */}
          <div
            className={`absolute right-4 bottom-4 transition-all duration-700 ease-out ${
              animationStep === 'enter' ? 'opacity-0 translate-y-6 scale-90' : 'opacity-100 translate-y-0 scale-100'
            }`}
          >
            <div className="relative w-28 h-24">
              {/* HINGED TOP CLAPPER ARM (Rotates around left hinge!) */}
              <div
                className="absolute top-1 left-0 origin-bottom-left transition-transform duration-150 ease-out z-20"
                style={{
                  transform:
                    animationStep === 'lift'
                      ? 'rotate(-28deg)'
                      : animationStep === 'clap' || animationStep === 'action' || animationStep === 'exit'
                      ? 'rotate(0deg)'
                      : 'rotate(0deg)',
                }}
              >
                <svg width="108" height="22" viewBox="0 0 108 22" fill="none">
                  {/* Top Arm Body */}
                  <rect x="0" y="0" width="108" height="20" rx="3" fill="#202124" />
                  {/* Diagonal White/Google-Color Stripes */}
                  <path d="M12 0 L24 0 L14 20 L2 20 Z" fill="#FFFFFF" />
                  <path d="M34 0 L46 0 L36 20 L24 20 Z" fill="#4285F4" />
                  <path d="M56 0 L68 0 L58 20 L46 20 Z" fill="#EA4335" />
                  <path d="M78 0 L90 0 L80 20 L68 20 Z" fill="#FBBC04" />
                  <path d="M100 0 L108 0 L102 20 L90 20 Z" fill="#34A853" />
                  {/* Hinge Pin */}
                  <circle cx="8" cy="10" r="3" fill="#DADCE0" stroke="#202124" strokeWidth="1" />
                </svg>
              </div>

              {/* Lower Clapperboard Body (Fixed) */}
              <div className="absolute top-5 left-0 z-10">
                <svg width="108" height="74" viewBox="0 0 108 74" fill="none">
                  {/* Board Plate */}
                  <rect x="0" y="0" width="108" height="74" rx="4" fill="#202124" />
                  {/* Slate Info Panels */}
                  <rect x="6" y="8" width="96" height="58" rx="2" fill="#303134" />

                  {/* Grid Lines */}
                  <line x1="6" y1="28" x2="102" y2="28" stroke="#5F6368" strokeWidth="1" />
                  <line x1="6" y1="48" x2="102" y2="48" stroke="#5F6368" strokeWidth="1" />
                  <line x1="38" y1="28" x2="38" y2="70" stroke="#5F6368" strokeWidth="1" />
                  <line x1="72" y1="28" x2="72" y2="70" stroke="#5F6368" strokeWidth="1" />

                  {/* Slate Labels */}
                  <text x="10" y="20" fill="#9AA0A6" fontSize="5" fontWeight="600" fontFamily="system-ui">
                    PRODUCTION
                  </text>
                  <text x="50" y="21" fill="#FFFFFF" fontSize="7" fontWeight="700" fontFamily="system-ui">
                    TakeOne AI
                  </text>

                  <text x="10" y="37" fill="#9AA0A6" fontSize="4.5" fontWeight="600" fontFamily="system-ui">
                    SCENE
                  </text>
                  <text x="22" y="44" fill="#FFFFFF" fontSize="9" fontWeight="800" fontFamily="system-ui">
                    01
                  </text>

                  <text x="42" y="37" fill="#9AA0A6" fontSize="4.5" fontWeight="600" fontFamily="system-ui">
                    TAKE
                  </text>
                  <text x="53" y="44" fill="#FBBC04" fontSize="9" fontWeight="800" fontFamily="system-ui">
                    01
                  </text>

                  <text x="76" y="37" fill="#9AA0A6" fontSize="4.5" fontWeight="600" fontFamily="system-ui">
                    ROLL
                  </text>
                  <text x="85" y="44" fill="#FFFFFF" fontSize="9" fontWeight="800" fontFamily="system-ui">
                    A
                  </text>

                  <text x="10" y="58" fill="#9AA0A6" fontSize="4.5" fontWeight="600" fontFamily="system-ui">
                    DIRECTOR
                  </text>
                  <text x="10" y="65" fill="#4285F4" fontSize="5.5" fontWeight="700" fontFamily="system-ui">
                    GEMINI FLASH
                  </text>

                  <text x="76" y="58" fill="#9AA0A6" fontSize="4.5" fontWeight="600" fontFamily="system-ui">
                    DATE
                  </text>
                  <text x="76" y="65" fill="#34A853" fontSize="5" fontWeight="600" fontFamily="system-ui">
                    2026
                  </text>
                </svg>
              </div>

              {/* CLAP IMPACT BURST! Visual shockwave */}
              {clapped && (
                <div className="absolute -top-3 left-6 z-30 pointer-events-none animate-ping">
                  <span className="w-5 h-5 rounded-full bg-[#FBBC04] block opacity-75" />
                </div>
              )}
            </div>
          </div>
        </div>

        {/* Branding Title with Google styling */}
        <div className="text-center space-y-2">
          <div className="flex items-center justify-center gap-2">
            <h1 className="text-3xl font-extrabold text-[#202124] tracking-tight font-['Plus_Jakarta_Sans',sans-serif]">
              TakeOne
            </h1>
            {/* Google 4-color dots */}
            <div className="flex items-center gap-1 mt-1">
              <span className="w-2 h-2 rounded-full bg-[#4285F4]" />
              <span className="w-2 h-2 rounded-full bg-[#EA4335]" />
              <span className="w-2 h-2 rounded-full bg-[#FBBC04]" />
              <span className="w-2 h-2 rounded-full bg-[#34A853]" />
            </div>
          </div>

          {/* Action Callout */}
          <div className="h-6 flex items-center justify-center">
            {animationStep === 'action' || animationStep === 'exit' ? (
              <div className="flex items-center gap-2 text-xs font-semibold uppercase tracking-wider text-[#1A73E8] bg-[#E8F0FE] px-3 py-0.5 rounded-full border border-[#D2E3FC] animate-fade-in">
                <span>Scene 1</span>
                <span>•</span>
                <span>Take 1</span>
                <span>•</span>
                <span className="font-extrabold text-[#EA4335]">ACTION!</span>
              </div>
            ) : (
              <p className="text-xs text-[#5F6368] font-normal tracking-wide">
                You're the talent. TakeOne is the director.
              </p>
            )}
          </div>
        </div>

        {/* Elegant Google Progress Indicator */}
        <div className="w-48 h-1 bg-[#F1F3F4] rounded-full overflow-hidden mt-2">
          <div
            className="h-full bg-gradient-to-r from-[#4285F4] via-[#EA4335] via-[#FBBC04] to-[#34A853] transition-all duration-1000 ease-out"
            style={{
              width:
                animationStep === 'enter'
                  ? '25%'
                  : animationStep === 'lift'
                  ? '55%'
                  : animationStep === 'clap'
                  ? '85%'
                  : '100%',
            }}
          />
        </div>
      </div>

      {/* Footer Hackathon attribution */}
      <div className="absolute bottom-6 text-center text-xs text-[#80868B] flex items-center gap-1.5">
        <span>Powered by Google Cloud & Gemini 3.8 Flash</span>
      </div>
    </div>
  );
};
