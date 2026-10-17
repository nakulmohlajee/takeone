import React, { useEffect, useMemo, useRef, useState } from 'react';
import { ArrowUp } from 'lucide-react';

/**
 * Home page showcase, below the idea form.
 *
 * 1. "Watch an idea get directed" — pick an example idea; the teleprompter highlights each line
 *    while a phone plays that line's finished cut (AI b-roll drifting, bold-pop captions with the
 *    spoken word flashing, a text pop landing). "Use this idea" fills the form above.
 * 2. A moving strip of frames TakeOne generated during real test shoots.
 *
 * Every picture is TakeOne's own output (public/assets/reel). Motion is CSS only and stops for
 * prefers-reduced-motion; the demo also pauses while off screen or in a background tab.
 */

type Line = { text: string; image: string; pop?: string };
type Example = { id: string; label: string; length: string; idea: string; lines: Line[] };

const EXAMPLES: Example[] = [
  {
    id: 'sourdough',
    label: 'My first sourdough was a brick',
    length: '45s',
    idea: 'My first sourdough loaf took 36 hours and came out as a dense brick. Funny story of what went wrong and the one lesson I learned about starter timing.',
    lines: [
      { text: 'I spent thirty-six hours on my first sourdough loaf.', image: '/assets/reel/sourdough-starter.jpg', pop: '36 HOURS' },
      { text: 'It came out as a literal brick.', image: '/assets/reel/sourdough-crumb.jpg' },
      { text: 'I used my starter six hours after it peaked.', image: '/assets/reel/sourdough-dough.jpg', pop: 'STARTER WAS DEAD' },
      { text: 'Catch it at the bubbly peak, or make croutons.', image: '/assets/reel/sourdough-toast.jpg' },
    ],
  },
  {
    id: 'mars',
    label: 'Today’s weather, from Mars',
    length: '60s',
    idea: 'A 60-second weather report delivered from Mars — the real temperatures, the dust storms and the blue sunsets, told like a TV forecast.',
    lines: [
      { text: 'Good morning from Jezero Crater.', image: '/assets/reel/mars-crater.jpg' },
      { text: 'Today’s high is minus twenty, tonight minus eighty.', image: '/assets/reel/mars-dunes.jpg', pop: '−80°C' },
      { text: 'Expect dust devils across the dunes after lunch.', image: '/assets/reel/mars-dunes.jpg' },
      { text: 'And the sunset here? It’s blue.', image: '/assets/reel/mars-sunset.jpg', pop: 'BLUE SUNSET' },
    ],
  },
  {
    id: 'coffee',
    label: 'Your coffee isn’t bitter, your grind is',
    length: '30s',
    idea: 'A 30-second coffee tip: bitter coffee usually comes from the grind, not the beans — show how to dial it in.',
    lines: [
      { text: 'Your coffee isn’t bitter because of the beans.', image: '/assets/reel/coffee-pour.jpg' },
      { text: 'It’s the grind.', image: '/assets/reel/coffee-grinder.jpg', pop: 'IT’S THE GRIND' },
      { text: 'Go one step coarser and taste it again.', image: '/assets/reel/coffee-bloom.jpg' },
      { text: 'Dial it in like a mad scientist.', image: '/assets/reel/coffee-lab.jpg' },
    ],
  },
];

const REEL: Array<{ src: string; from: string; pop?: string }> = [
  { src: '/assets/reel/mars-sunset.jpg', from: 'Weather from Mars', pop: 'BLUE SUNSET' },
  { src: '/assets/reel/sourdough-starter.jpg', from: 'Sourdough fail' },
  { src: '/assets/reel/street-food.jpg', from: 'Street food tour', pop: 'STREET EATS' },
  { src: '/assets/reel/coffee-lab.jpg', from: 'Coffee tips' },
  { src: '/assets/reel/library.jpg', from: 'Study tips', pop: 'TIP #1' },
  { src: '/assets/reel/mars-crater.jpg', from: 'Weather from Mars' },
  { src: '/assets/reel/sourdough-toast.jpg', from: 'Sourdough fail', pop: 'CROUTONS' },
  { src: '/assets/reel/monstera-dew.jpg', from: 'Plant love story' },
  { src: '/assets/reel/coffee-pour.jpg', from: 'Coffee tips', pop: 'IT’S THE GRIND' },
  { src: '/assets/reel/urban-skyline.jpg', from: 'City vlog' },
  { src: '/assets/reel/plant-sanctuary.jpg', from: 'Plant love story' },
  { src: '/assets/reel/sourdough-dough.jpg', from: 'Sourdough fail' },
];

/** One line on screen; word cadence for the captions. */
const LINE_MS = 3200;
const WORD_MS = 280;

function useReducedMotion(): boolean {
  const [reduced, setReduced] = useState(
    () => typeof window !== 'undefined' && window.matchMedia?.('(prefers-reduced-motion: reduce)').matches
  );
  useEffect(() => {
    const mq = window.matchMedia?.('(prefers-reduced-motion: reduce)');
    if (!mq) return;
    const on = () => setReduced(mq.matches);
    mq.addEventListener?.('change', on);
    return () => mq.removeEventListener?.('change', on);
  }, []);
  return reduced;
}

/** True while the element is at least partly on screen and the tab is visible. */
function useActive(ref: React.RefObject<HTMLElement | null>): boolean {
  const [onScreen, setOnScreen] = useState(false);
  const [visible, setVisible] = useState(() => typeof document === 'undefined' || !document.hidden);
  useEffect(() => {
    const el = ref.current;
    if (!el || typeof IntersectionObserver === 'undefined') {
      setOnScreen(true);
      return;
    }
    const io = new IntersectionObserver(([e]) => setOnScreen(e.isIntersecting), { threshold: 0.25 });
    io.observe(el);
    const vis = () => setVisible(!document.hidden);
    document.addEventListener('visibilitychange', vis);
    return () => {
      io.disconnect();
      document.removeEventListener('visibilitychange', vis);
    };
  }, [ref]);
  return onScreen && visible;
}

const captionStroke: React.CSSProperties = {
  WebkitTextStroke: '0.14em #000',
  paintOrder: 'stroke fill',
};

export const HomeShowcase: React.FC<{ onUseIdea: (idea: string, durationSeconds: number) => void }> = ({
  onUseIdea,
}) => {
  const reduced = useReducedMotion();
  const sectionRef = useRef<HTMLElement | null>(null);
  const active = useActive(sectionRef);
  const [exIdx, setExIdx] = useState(0);
  const [lineIdx, setLineIdx] = useState(0);
  const [wordIdx, setWordIdx] = useState(0);
  /** Bumped on every pick so the tab's progress bar restarts even on the same tab. */
  const [runId, setRunId] = useState(0);
  const tabsRef = useRef<HTMLDivElement | null>(null);
  // Phones: keep the selected idea visible in the swipe row (moves the row only, never the page).
  useEffect(() => {
    const row = tabsRef.current;
    const chip = row?.children[exIdx] as HTMLElement | undefined;
    if (!row || !chip || row.scrollWidth <= row.clientWidth) return;
    row.scrollTo({ left: chip.offsetLeft - 16, behavior: reduced ? 'auto' : 'smooth' });
  }, [exIdx, reduced]);

  const example = EXAMPLES[exIdx];
  const line = example.lines[lineIdx];
  const words = useMemo(() => line.text.toUpperCase().split(/\s+/), [line.text]);
  // Bold pop shows 3–4 words at a time, like the renderer.
  const chunk = Math.floor(wordIdx / 3);
  const shown = words.slice(chunk * 3, chunk * 3 + 3);
  const activeInChunk = wordIdx - chunk * 3;

  // Line clock: next line, then next example. Paused off screen / in a background tab.
  useEffect(() => {
    if (!active || reduced) return;
    const t = window.setTimeout(() => {
      if (lineIdx + 1 < example.lines.length) {
        setLineIdx(lineIdx + 1);
      } else {
        setExIdx((exIdx + 1) % EXAMPLES.length);
        setLineIdx(0);
        setRunId((r) => r + 1);
      }
      setWordIdx(0);
    }, LINE_MS);
    return () => clearTimeout(t);
  }, [active, reduced, lineIdx, exIdx, example.lines.length]);

  // Word clock for the captions.
  useEffect(() => {
    if (!active || reduced) return;
    if (wordIdx >= words.length - 1) return;
    const t = window.setTimeout(() => setWordIdx((w) => w + 1), WORD_MS);
    return () => clearTimeout(t);
  }, [active, reduced, wordIdx, words.length]);

  const pick = (i: number) => {
    setExIdx(i);
    setLineIdx(0);
    setWordIdx(0);
    setRunId((r) => r + 1);
  };

  return (
    <div className="w-full max-w-6xl mx-auto px-4 sm:px-8 pb-24">
      <section
        ref={sectionRef}
        aria-labelledby="directed-heading"
        className="mt-28 lg:mt-40 showcase-grid"
      >
        <div className="min-w-0 [grid-area:intro]">
          <h2
            id="directed-heading"
            className="text-4xl sm:text-5xl lg:text-6xl font-extrabold tracking-[-0.035em] leading-[1.02] text-[#202124] font-['Plus_Jakarta_Sans',sans-serif] [text-wrap:balance]"
          >
            Watch an idea get directed.
          </h2>
          <p className="mt-5 text-lg text-[#3C4043] leading-relaxed max-w-[46ch]">
            Pick one. TakeOne writes the lines, keeps the teleprompter on your voice, and cuts the video
            with captions, AI visuals and text pops.
          </p>
        </div>

        {/* Phones: one swipeable row of ideas above the phone. Desktop: a stacked list. */}
        <div
          ref={tabsRef}
          role="tablist"
          aria-label="Example ideas"
          className="[grid-area:tabs] min-w-0 flex gap-2 overflow-x-auto snap-x snap-mandatory -mx-4 px-4 sm:-mx-8 sm:px-8 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden lg:mx-0 lg:px-0 lg:flex-col lg:gap-1.5 lg:overflow-visible"
        >
            {EXAMPLES.map((ex, i) => {
              const on = i === exIdx;
              return (
                <button
                  key={ex.id}
                  role="tab"
                  aria-selected={on}
                  onClick={() => pick(i)}
                  className={`group relative overflow-hidden text-left rounded-xl px-4 py-3.5 lg:px-5 lg:py-4 shrink-0 w-[80%] sm:w-[55%] lg:w-auto snap-start transition-colors duration-200 cursor-pointer active:scale-[0.99] ${
                    on ? 'bg-[#E8F0FE]' : 'bg-[#F1F3F4] hover:bg-[#E8EAED]'
                  }`}
                >
                  <span className="flex items-baseline justify-between gap-4">
                    <span className={`text-base md:text-lg font-bold ${on ? 'text-[#1A73E8]' : 'text-[#202124]'}`}>
                      {ex.label}
                    </span>
                    <span className="text-sm text-[#5F6368] tabular-nums shrink-0">{ex.length}</span>
                  </span>
                  {on && !reduced && (
                    <span
                      key={`${ex.id}-${runId}-${active}`}
                      aria-hidden
                      className="absolute left-0 bottom-0 h-1 bg-[#1A73E8] origin-left"
                      style={{
                        width: '100%',
                        animation: active
                          ? `showcase-progress ${LINE_MS * ex.lines.length}ms linear forwards`
                          : 'none',
                        transform: active ? undefined : 'scaleX(0)',
                      }}
                    />
                  )}
                </button>
              );
            })}
        </div>

        {/* The teleprompter: the line being said is in full ink, the rest wait in grey. */}
        <ol className="[grid-area:lines] min-w-0 space-y-2.5 text-lg md:text-xl font-bold leading-snug" aria-label="Lines to speak">
            {example.lines.map((l, i) => (
              <li
                key={`${example.id}-${i}`}
                className={`transition-colors duration-300 ${
                  i === lineIdx ? 'text-[#202124]' : 'text-[#70757A]'
                }`}
              >
                {l.text}
              </li>
            ))}
        </ol>

        <div className="[grid-area:cta] flex flex-col items-start gap-3">
          <button
            type="button"
            onClick={() => onUseIdea(example.idea, parseInt(example.length, 10))}
            className="inline-flex items-center gap-2 px-6 py-3.5 rounded-full bg-[#1A73E8] text-white text-base font-bold hover:bg-[#1557B0] active:scale-[0.97] transition cursor-pointer"
          >
            <ArrowUp className="w-4 h-4" />
            Use this idea
          </button>
          <p className="text-sm text-[#5F6368]">AI b-roll, bold-pop captions and text pops — all added by TakeOne.</p>
        </div>

        {/* The finished cut of the current line, as TakeOne renders it. */}
        <div className="[grid-area:phone] justify-self-center self-center" data-ui>
          <div className="relative w-[min(78vw,320px)] lg:w-[320px] aspect-[9/16] rounded-[2.4rem] bg-[#0B0B0C] p-2">
            <div className="relative w-full h-full rounded-[1.9rem] overflow-hidden bg-[#1F1F1F]">
              {example.lines.map((l, i) => (
                <img
                  key={`${example.id}-${i}`}
                  src={l.image}
                  alt=""
                  aria-hidden={i !== lineIdx}
                  className={`absolute inset-0 w-full h-full object-cover transition-opacity duration-500 ${
                    i === lineIdx ? 'opacity-100' : 'opacity-0'
                  }`}
                  style={
                    i === lineIdx && !reduced
                      ? { animation: `showcase-drift ${LINE_MS + 600}ms ease-out forwards` }
                      : undefined
                  }
                />
              ))}

              {line.pop && (
                <p
                  key={`pop-${example.id}-${lineIdx}`}
                  className="absolute inset-x-4 top-[16%] text-center text-[1.65rem] leading-[1.05] font-black text-white"
                  style={{
                    ...captionStroke,
                    animation: reduced ? undefined : 'showcase-pop 420ms cubic-bezier(0.34,1.56,0.64,1) both',
                  }}
                >
                  {line.pop}
                </p>
              )}

              <p
                className="absolute inset-x-3 bottom-[13%] flex flex-wrap justify-center gap-x-[0.32em] text-[1.2rem] leading-tight font-black text-white"
                style={captionStroke}
                aria-hidden
              >
                {(reduced ? words : shown).map((w, i) => (
                  <span
                    key={`${chunk}-${i}-${w}`}
                    className="inline-block"
                    style={
                      !reduced && i === activeInChunk
                        ? { color: '#FFE566', animation: 'showcase-word 220ms ease-out both' }
                        : undefined
                    }
                  >
                    {w}
                  </span>
                ))}
              </p>
            </div>
          </div>
        </div>
      </section>

      <section aria-labelledby="reel-heading" className="mt-32 md:mt-44">
        <h2
          id="reel-heading"
          className="text-3xl md:text-5xl font-extrabold tracking-[-0.03em] leading-[1.05] text-[#202124] font-['Plus_Jakarta_Sans',sans-serif] max-w-[18ch] [text-wrap:balance]"
        >
          Every frame here, TakeOne made.
        </h2>
        <p className="mt-4 text-lg text-[#3C4043] leading-relaxed max-w-[52ch]">
          AI b-roll it generated from creators’ scripts during real test shoots. No stock footage.
        </p>
      </section>

      <div
        className={`mt-10 pb-8 rounded-3xl group ${reduced ? 'overflow-x-auto snap-x' : 'overflow-hidden'}`}
        aria-label="Frames generated by TakeOne"
      >
        <ul
          className={`flex gap-4 w-max ${
            reduced
              ? ''
              : 'animate-[showcase-marquee_70s_linear_infinite] group-hover:[animation-play-state:paused]'
          }`}
        >
          {(reduced ? REEL : [...REEL, ...REEL]).map((f, i) => (
            <li
              key={`${f.src}-${i}`}
              className={`w-[160px] sm:w-[220px] shrink-0 snap-start ${i % 2 ? 'sm:translate-y-8' : ''}`}
              aria-hidden={i >= REEL.length}
            >
              <div className="relative">
                <img
                  src={f.src}
                  alt={i < REEL.length ? `AI b-roll for “${f.from}”` : ''}
                  loading="lazy"
                  className="w-full aspect-[9/16] object-cover rounded-2xl bg-[#F1F3F4]"
                />
                {f.pop && (
                  <span
                    className="absolute inset-x-2 top-[14%] text-center text-xl sm:text-2xl font-black leading-none text-white"
                    style={captionStroke}
                  >
                    {f.pop}
                  </span>
                )}
              </div>
              <p className="mt-2.5 text-sm text-[#3C4043]">{f.from}</p>
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
};
