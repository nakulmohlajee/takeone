import React from 'react';
import {
  Sparkles,
  Video,
  Mic,
  Volume2,
  Globe,
  HardDrive,
  X,
  Layers,
  Cloud,
  Scissors,
  Film,
} from 'lucide-react';

interface GoogleCloudStackModalProps {
  isOpen: boolean;
  onClose: () => void;
  onOpenBigQuery: () => void;
  onOpenStorage: () => void;
}

export const GoogleCloudStackModal: React.FC<GoogleCloudStackModalProps> = ({
  isOpen,
  onClose,
  onOpenStorage,
}) => {
  if (!isOpen) return null;

  const stack = [
    {
      name: 'Gemini (Flash family)',
      role: 'Two-pass screenplay + structure',
      description:
        'Pass 1 writes a free-form creative script. Pass 2 structures it into a shootable recipe (layouts, punch-ins, inserts) without rewriting spoken words.',
      icon: Sparkles,
      color: 'text-[#1A73E8]',
      bgColor: 'bg-[#E8F0FE]',
      borderColor: 'border-[#D2E3FC]',
      badge: 'Google AI / GenAI',
    },
    {
      name: 'Gemini Image',
      role: 'Still cutaways, b-roll & backgrounds',
      description:
        'Generates still plates for b-roll inserts and virtual backgrounds (not Imagen API — Gemini image models).',
      icon: Layers,
      color: 'text-[#9333EA]',
      bgColor: 'bg-[#F3E8FD]',
      borderColor: 'border-[#E9D5FF]',
      badge: 'Gemini Image',
    },
    {
      name: 'Veo 3.1',
      role: 'Optional motion b-roll',
      description:
        'Synthesizes short video cutaways when quota allows. Stills with Ken Burns are the default fallback.',
      icon: Video,
      color: 'text-[#EA4335]',
      bgColor: 'bg-[#FCE8E6]',
      borderColor: 'border-[#FAD2CF]',
      badge: 'Veo',
    },
    {
      name: 'Cloud Speech-to-Text (Chirp)',
      role: 'Word-level timestamps',
      description:
        'Chirp / latest_long returns precise word offsets used for filler cuts, dead-air shrink, and karaoke captions.',
      icon: Mic,
      color: 'text-[#34A853]',
      bgColor: 'bg-[#E6F4EA]',
      borderColor: 'border-[#CEEAD6]',
      badge: 'Speech API',
    },
    {
      name: 'Gemini TTS',
      role: 'Director voice cues',
      description:
        'Spoken coaching prompts via Gemini audio models (not Cloud Text-to-Speech). Browser speech is the offline fallback.',
      icon: Volume2,
      color: 'text-[#F9AB00]',
      bgColor: 'bg-[#FEF7E0]',
      borderColor: 'border-[#FEEFC3]',
      badge: 'Gemini TTS',
    },
    {
      name: 'Gemini Translate',
      role: 'Script localization',
      description:
        'Localizes teleprompter / captions via Gemini JSON (not Cloud Translation API). Spoken language follows the idea.',
      icon: Globe,
      color: 'text-[#1A73E8]',
      bgColor: 'bg-[#E8F0FE]',
      borderColor: 'border-[#D2E3FC]',
      badge: 'Gemini',
    },
    {
      name: 'FFmpeg on Cloud Run',
      role: 'Director compiler → master MP4',
      description:
        'Native FFmpeg: cleanup keep-ranges, punch-ins, chromakey backgrounds, word ASS captions, music ducking. Jobs scale to zero when idle.',
      icon: Scissors,
      color: 'text-[#EA4335]',
      bgColor: 'bg-[#FCE8E6]',
      borderColor: 'border-[#FAD2CF]',
      badge: 'Cloud Run + FFmpeg',
    },
    {
      name: 'Lyria / music bed',
      role: 'Soundtrack under speech',
      description: 'Optional Lyria clip or FFmpeg mood bed with sidechain ducking under dialogue.',
      icon: Film,
      color: 'text-[#F9AB00]',
      bgColor: 'bg-[#FEF7E0]',
      borderColor: 'border-[#FEEFC3]',
      badge: 'Lyria / FFmpeg',
    },
    {
      name: 'Cloud Storage (GCS)',
      role: 'Takes, assets & masters',
      description:
        'Stores raw takes, generated stills, job status JSON, and final master MP4s. Job store is GCS — not Firestore.',
      icon: HardDrive,
      color: 'text-[#34A853]',
      bgColor: 'bg-[#E6F4EA]',
      borderColor: 'border-[#CEEAD6]',
      badge: 'Cloud Storage',
      action: onOpenStorage,
      actionLabel: 'Inspect media vault →',
    },
  ];

  return (
    <div className="fixed inset-0 z-50 bg-black/60 backdrop-blur-xs flex items-center justify-center p-4 overflow-y-auto">
      <div className="bg-white border border-[#DADCE0] rounded-3xl max-w-4xl w-full p-6 md:p-8 shadow-2xl relative my-8 text-[#202124]">
        <button
          onClick={onClose}
          className="absolute top-5 right-5 p-2 rounded-xl text-[#5F6368] hover:text-[#202124] hover:bg-[#F1F3F4] transition cursor-pointer"
        >
          <X className="w-5 h-5" />
        </button>

        <div className="space-y-1 mb-6">
          <div className="flex items-center gap-2">
            <span className="px-2.5 py-0.5 rounded-full text-[11px] font-bold bg-[#E8F0FE] text-[#1A73E8] border border-[#D2E3FC]">
              HONEST STACK · WHAT WE ACTUALLY CALL
            </span>
            <span className="text-xs text-[#5F6368]">Hack2Skill AI Builders Cup 2026</span>
          </div>
          <h2 className="text-2xl md:text-3xl font-extrabold text-[#202124] font-['Plus_Jakarta_Sans',sans-serif]">
            Google technologies powering TakeOne
          </h2>
          <p className="text-xs md:text-sm text-[#5F6368]">
            Gemini · Chirp Speech · Veo · Lyria · GCS · Cloud Run + native FFmpeg. No fake BigQuery /
            Imagen / Cloud TTS / Translation claims.
          </p>
        </div>

        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4 max-h-[520px] overflow-y-auto pr-1">
          {stack.map((item, idx) => {
            const Icon = item.icon;
            return (
              <div
                key={idx}
                className={`p-4 rounded-2xl bg-[#F8F9FA] border ${item.borderColor} flex flex-col justify-between space-y-3 shadow-2xs hover:shadow-xs transition`}
              >
                <div className="space-y-2">
                  <div className="flex items-center justify-between">
                    <div className={`p-2 rounded-xl ${item.bgColor} ${item.color}`}>
                      <Icon className="w-5 h-5" />
                    </div>
                    <span className="text-[10px] font-semibold px-2 py-0.5 rounded-full bg-white border border-[#DADCE0] text-[#3C4043]">
                      {item.badge}
                    </span>
                  </div>
                  <h3 className="font-bold text-sm text-[#202124]">{item.name}</h3>
                  <span className="text-[11px] font-semibold text-[#1A73E8] block">{item.role}</span>
                  <p className="text-xs text-[#5F6368] leading-relaxed">{item.description}</p>
                </div>
                {item.action && (
                  <button
                    onClick={() => {
                      onClose();
                      item.action!();
                    }}
                    className="text-xs font-semibold text-[#1A73E8] hover:text-[#1557B0] underline underline-offset-4 text-left transition pt-1 cursor-pointer"
                  >
                    {item.actionLabel}
                  </button>
                )}
              </div>
            );
          })}
        </div>

        <div className="mt-6 pt-4 border-t border-[#DADCE0] flex items-center justify-between text-xs text-[#5F6368]">
          <div className="flex items-center gap-1.5">
            <Cloud className="w-4 h-4 text-[#1A73E8]" />
            <span>Retention scores in-app are a local heuristic preview — not live BigQuery.</span>
          </div>
          <button
            onClick={onClose}
            className="px-4 py-2 rounded-xl bg-[#1A73E8] hover:bg-[#1557B0] text-white font-bold transition shadow-2xs cursor-pointer"
          >
            Back to App
          </button>
        </div>
      </div>
    </div>
  );
};
