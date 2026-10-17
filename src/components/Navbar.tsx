import React from 'react';
import { Sparkles, Film, Camera, PlayCircle, Clapperboard, Cloud, RotateCcw } from 'lucide-react';
import { AppScreen } from '../types/director';

interface NavbarProps {
  currentScreen: AppScreen;
  setScreen: (screen: AppScreen) => void;
  onLoadDemo: () => void;
  onReset: () => void;
  onReplaySplash?: () => void;
  projectTitle?: string;
  onOpenGcpStack?: () => void;
  onOpenBigQuery?: () => void;
  onOpenStorage?: () => void;
}

export const Navbar: React.FC<NavbarProps> = ({
  currentScreen,
  setScreen,
  onLoadDemo,
  onReset,
  onReplaySplash,
  projectTitle,
  onOpenGcpStack,
  onOpenBigQuery,
  onOpenStorage,
}) => {
  const steps: { screen: AppScreen; label: string; icon: any }[] = [
    { screen: 'idea', label: 'Idea', icon: Sparkles },
    { screen: 'script-overview', label: 'Shot Direction', icon: Film },
    { screen: 'guided-shooting', label: 'Guided Shoot', icon: Camera },
    { screen: 'assembly-review', label: 'Master Cut', icon: PlayCircle },
  ];

  return (
    <header className="sticky top-0 z-[60] bg-white/95 backdrop-blur-md border-b border-[#E0E2E6] px-3 sm:px-4 py-2.5 shadow-[0_1px_2px_rgba(60,64,67,0.08)] overflow-x-hidden">
      <div className="max-w-6xl mx-auto flex items-center justify-between gap-2 sm:gap-3 min-w-0">
        {/* Brand: Google-styled TakeOne with Animated Replay Trigger */}
        <div
          className="flex items-center gap-2 sm:gap-2.5 cursor-pointer group min-w-0"
          onClick={() => {
            if (onReplaySplash) {
              onReplaySplash();
            } else {
              setScreen('idea');
            }
          }}
          title="Click to replay Director Intro"
        >
          {/* Director Symbol Badge (Google colors styled) */}
          <div className="w-9 h-9 rounded-xl bg-[#E8F0FE] border border-[#D2E3FC] flex items-center justify-center text-[#1A73E8] group-hover:scale-105 transition-transform shadow-sm">
            <Clapperboard className="w-5 h-5" />
          </div>

          <div className="min-w-0">
            <div className="flex items-center gap-2 min-w-0">
              <span className="font-bold text-base sm:text-lg tracking-tight text-[#202124] font-['Google_Sans',sans-serif] truncate">
                TakeOne
              </span>
              {/* Google 4-Color Accent Dots */}
              <div className="flex items-center gap-1">
                <span className="w-1.5 h-1.5 rounded-full bg-[#4285F4]" />
                <span className="w-1.5 h-1.5 rounded-full bg-[#EA4335]" />
                <span className="w-1.5 h-1.5 rounded-full bg-[#FBBC04]" />
                <span className="w-1.5 h-1.5 rounded-full bg-[#34A853]" />
              </div>
              <span className="hidden sm:inline-block px-1.5 py-0.5 rounded text-[10px] font-semibold bg-[#E8F0FE] text-[#1A73E8] border border-[#D2E3FC]">
                AI DIRECTOR
              </span>
            </div>
            <p className="text-[11px] text-[#5F6368] hidden sm:block font-normal">
              AI director for everyone
            </p>
          </div>
        </div>

        {/* Steps for desktop (Clean Google Material 3 Segmented Control) */}
        <nav className="hidden md:flex items-center gap-1 bg-[#F1F3F4] p-1 rounded-xl border border-[#DADCE0]">
          {steps.map((st, i) => {
            const Icon = st.icon;
            const isActive = currentScreen === st.screen;
            return (
              <button
                key={st.screen}
                onClick={() => setScreen(st.screen)}
                className={`flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium transition-all ${
                  isActive
                    ? 'bg-white text-[#1A73E8] font-bold shadow-sm border border-[#DADCE0]'
                    : 'text-[#5F6368] hover:text-[#202124] hover:bg-white/60'
                }`}
              >
                <Icon className={`w-3.5 h-3.5 ${isActive ? 'stroke-[2.5]' : ''}`} />
                <span>
                  {i + 1}. {st.label}
                </span>
              </button>
            );
          })}
        </nav>

        {/* Action Controls */}
        <div className="flex items-center gap-1.5 sm:gap-2 shrink-0">
          {onOpenGcpStack && (
            <button
              onClick={onOpenGcpStack}
              className="hidden lg:flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg text-xs font-semibold bg-[#E8F0FE] border border-[#D2E3FC] text-[#1A73E8] hover:bg-[#D2E3FC] transition shadow-xs"
              title="Google stack (Gemini, Chirp, Veo, Lyria, GCS, Cloud Run FFmpeg)"
            >
              <Cloud className="w-3.5 h-3.5 text-[#1A73E8]" />
              <span>GCP Stack (8)</span>
            </button>
          )}

          <button
            onClick={onLoadDemo}
            className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-semibold bg-[#1A73E8] text-white hover:bg-[#1557B0] transition shadow-xs active:scale-95"
            title="Load ready-to-demo 45-second plant video"
          >
            <Sparkles className="w-3.5 h-3.5 text-white" />
            <span className="hidden sm:inline">Stage Demo</span>
            <span className="sm:hidden">Demo</span>
          </button>

          <button
            onClick={onReset}
            className="p-1.5 rounded-lg text-[#5F6368] hover:text-[#202124] hover:bg-[#F1F3F4] transition"
            title="Start new video"
          >
            <RotateCcw className="w-4 h-4" />
          </button>
        </div>
      </div>
    </header>
  );
};
