import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Scissors, RotateCcw, SplitSquareHorizontal, Trash2 } from 'lucide-react';
import { formatDuration } from '../types/director';

type KeepRange = { start: number; end: number };

interface TakeTrimEditorProps {
  videoUrl: string;
  title?: string;
  inPoint?: number;
  outPoint?: number;
  keepRanges?: KeepRange[];
  userTrimLocked?: boolean;
  gcsObjectPath?: string;
  projectId?: string;
  sceneId?: string;
  /** Called after trim save; optional cleanupExtract triggers server trim + delete original */
  onSaveTrim: (
    inPoint: number,
    outPoint: number,
    opts?: { cleanupExtract?: boolean; keepRanges?: KeepRange[] }
  ) => void;
  onResetTrim: () => void;
  compact?: boolean;
}

const MIN_SEG = 0.3;
const RANGE_COLORS = ['#1A73E8', '#34A853', '#F9AB00', '#A142F4', '#E8710A'];

function normalizeRanges(ranges: KeepRange[]): KeepRange[] {
  return [...ranges]
    .map((r) => ({
      start: Math.min(r.start, r.end),
      end: Math.max(r.start, r.end),
    }))
    .filter((r) => r.end - r.start >= 0.05)
    .sort((a, b) => a.start - b.start);
}

function initialRanges(
  keepRanges: KeepRange[] | undefined,
  inPoint: number | undefined,
  outPoint: number | undefined,
  duration: number
): KeepRange[] {
  if (keepRanges?.length) return normalizeRanges(keepRanges);
  const start = typeof inPoint === 'number' ? inPoint : 0;
  const end =
    typeof outPoint === 'number' && outPoint > start
      ? outPoint
      : duration > 0
        ? duration
        : start;
  if (end > start) return [{ start, end }];
  return duration > 0 ? [{ start: 0, end: duration }] : [];
}

/**
 * YouTube Create-style dual-handle range trimmer with playhead, Split, and Save/Reset.
 */
export const TakeTrimEditor: React.FC<TakeTrimEditorProps> = ({
  videoUrl,
  title,
  inPoint,
  outPoint,
  keepRanges: keepRangesProp,
  userTrimLocked,
  gcsObjectPath,
  projectId,
  sceneId,
  onSaveTrim,
  onResetTrim,
  compact = false,
}) => {
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const trackRef = useRef<HTMLDivElement | null>(null);
  const [duration, setDuration] = useState(0);
  const [current, setCurrent] = useState(0);
  const [ranges, setRanges] = useState<KeepRange[]>(() =>
    initialRanges(keepRangesProp, inPoint, outPoint, 0)
  );
  const [selectedIndex, setSelectedIndex] = useState(0);
  const [dirty, setDirty] = useState(false);
  const [dragging, setDragging] = useState<'in' | 'out' | 'playhead' | null>(null);
  const [cleanupExtract, setCleanupExtract] = useState(false);
  const [cleanupBusy, setCleanupBusy] = useState(false);

  const keepRangesKey = JSON.stringify(keepRangesProp ?? null);
  useEffect(() => {
    const next = initialRanges(keepRangesProp, inPoint, outPoint, duration);
    setRanges(next);
    setSelectedIndex((idx) => (next.length ? Math.min(idx, next.length - 1) : 0));
    setDirty(false);
    // keepRangesProp read via keepRangesKey to avoid identity churn
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [videoUrl, inPoint, outPoint, keepRangesKey, duration]);

  useEffect(() => {
    const v = videoRef.current;
    if (!v) return;
    const onMeta = () => {
      const d = Number.isFinite(v.duration) && v.duration > 0 ? v.duration : 0;
      setDuration(d);
      setRanges((prev) => {
        if (prev.length > 0) return prev;
        return d > 0 ? [{ start: 0, end: d }] : prev;
      });
    };
    const onTime = () => setCurrent(v.currentTime || 0);
    v.addEventListener('loadedmetadata', onMeta);
    v.addEventListener('durationchange', onMeta);
    v.addEventListener('timeupdate', onTime);
    if (v.readyState >= 1) onMeta();
    return () => {
      v.removeEventListener('loadedmetadata', onMeta);
      v.removeEventListener('durationchange', onMeta);
      v.removeEventListener('timeupdate', onTime);
    };
  }, [videoUrl]);

  const selected = ranges[selectedIndex] || ranges[0];
  const draftIn = selected?.start ?? 0;
  const draftOut = selected?.end ?? duration;

  // Loop preview within selected range while playing
  useEffect(() => {
    const v = videoRef.current;
    if (!v || !selected) return;
    const onTime = () => {
      if (v.paused) return;
      const end = selected.end > selected.start ? selected.end : duration;
      if (end > selected.start && v.currentTime >= end - 0.05) {
        v.currentTime = selected.start;
      }
    };
    v.addEventListener('timeupdate', onTime);
    return () => v.removeEventListener('timeupdate', onTime);
  }, [selected, duration]);

  const clamp = (n: number) => Math.max(0, Math.min(duration || n, n));
  const keepTotal = useMemo(
    () => ranges.reduce((sum, r) => sum + Math.max(0, r.end - r.start), 0),
    [ranges]
  );
  const pct = (t: number) => (duration > 0 ? Math.min(100, Math.max(0, (t / duration) * 100)) : 0);

  const updateSelectedRange = (next: KeepRange) => {
    setRanges((prev) => {
      const copy = [...prev];
      const idx = selectedIndex < copy.length ? selectedIndex : 0;
      if (!copy[idx]) return prev;
      const prevR = copy[idx - 1];
      const nextR = copy[idx + 1];
      let start = clamp(next.start);
      let end = clamp(next.end);
      if (prevR) start = Math.max(start, prevR.end);
      if (nextR) end = Math.min(end, nextR.start);
      if (end - start < MIN_SEG) {
        if (next.start !== copy[idx].start) {
          start = Math.max(prevR?.end ?? 0, end - MIN_SEG);
        } else {
          end = Math.min(nextR?.start ?? duration, start + MIN_SEG);
        }
      }
      copy[idx] = { start, end };
      return copy;
    });
    setDirty(true);
  };

  const setIn = (n: number) => {
    if (!selected) return;
    updateSelectedRange({ start: Math.min(n, draftOut - MIN_SEG), end: draftOut });
  };
  const setOut = (n: number) => {
    if (!selected) return;
    updateSelectedRange({ start: draftIn, end: Math.max(n, draftIn + MIN_SEG) });
  };

  const timeFromClientX = useCallback(
    (clientX: number) => {
      const el = trackRef.current;
      if (!el || duration <= 0) return 0;
      const rect = el.getBoundingClientRect();
      const ratio = Math.min(1, Math.max(0, (clientX - rect.left) / rect.width));
      return ratio * duration;
    },
    [duration]
  );

  const rangeContaining = (t: number): number => {
    const idx = ranges.findIndex((r) => t >= r.start && t <= r.end);
    return idx;
  };

  useEffect(() => {
    if (!dragging) return;
    const onMove = (e: PointerEvent) => {
      const t = timeFromClientX(e.clientX);
      if (dragging === 'in') setIn(Math.min(t, draftOut - MIN_SEG));
      else if (dragging === 'out') setOut(Math.max(t, draftIn + MIN_SEG));
      else if (dragging === 'playhead' && videoRef.current) {
        videoRef.current.currentTime = clamp(t);
        setCurrent(clamp(t));
      }
    };
    const onUp = () => setDragging(null);
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
    return () => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dragging, draftIn, draftOut, timeFromClientX, selectedIndex]);

  const canSplit = useMemo(() => {
    const idx = rangeContaining(current);
    const target = idx >= 0 ? ranges[idx] : selected;
    if (!target) return false;
    return current > target.start + MIN_SEG && current < target.end - MIN_SEG;
  }, [current, ranges, selected]);

  const splitAtPlayhead = () => {
    const containing = rangeContaining(current);
    const idx = containing >= 0 ? containing : selectedIndex;
    const target = ranges[idx];
    if (!target) return;
    if (!(current > target.start + MIN_SEG && current < target.end - MIN_SEG)) return;
    const left: KeepRange = { start: target.start, end: current };
    const right: KeepRange = { start: current, end: target.end };
    setRanges((prev) => {
      const copy = [...prev];
      copy.splice(idx, 1, left, right);
      return normalizeRanges(copy);
    });
    setSelectedIndex(idx);
    setDirty(true);
  };

  const deleteSelectedSegment = () => {
    if (ranges.length <= 1) {
      // Empty → reset to full take
      if (duration > 0) {
        setRanges([{ start: 0, end: duration }]);
        setSelectedIndex(0);
        setDirty(true);
      }
      return;
    }
    setRanges((prev) => {
      const copy = prev.filter((_, i) => i !== selectedIndex);
      return copy.length ? copy : duration > 0 ? [{ start: 0, end: duration }] : [];
    });
    setSelectedIndex((idx) => Math.max(0, Math.min(idx, ranges.length - 2)));
    setDirty(true);
  };

  const overallBounds = () => {
    const sorted = normalizeRanges(ranges);
    if (!sorted.length) {
      return { inPoint: 0, outPoint: duration || 0, keepRanges: [] as KeepRange[] };
    }
    return {
      inPoint: sorted[0].start,
      outPoint: sorted[sorted.length - 1].end,
      keepRanges: sorted,
    };
  };

  const multiRange = ranges.length > 1;

  const commitSave = async () => {
    const { inPoint: saveIn, outPoint: saveOut, keepRanges: saveRanges } = overallBounds();
    if (!saveRanges.length) return;

    // Server trim-extract is single-range only
    if (cleanupExtract && !multiRange && gcsObjectPath && projectId && sceneId) {
      setCleanupBusy(true);
      try {
        const res = await fetch('/api/media/trim-extract', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            gcsObjectPath,
            projectId,
            sceneId,
            inPoint: saveIn,
            outPoint: saveOut,
          }),
        });
        const data = await res.json();
        if (!res.ok) throw new Error(data.error || 'Trim extract failed');
        const newDur = data.durationSeconds || saveOut - saveIn;
        onSaveTrim(0, newDur, {
          cleanupExtract: true,
          keepRanges: [{ start: 0, end: newDur }],
        });
        window.dispatchEvent(
          new CustomEvent('takeone:trim-extracted', {
            detail: {
              sceneId,
              gcsObjectPath: data.gcsObjectPath,
              durationSeconds: data.durationSeconds,
            },
          })
        );
      } catch (err) {
        console.warn('trim-extract failed, saving in/out only', err);
        onSaveTrim(saveIn, saveOut, { keepRanges: saveRanges });
      } finally {
        setCleanupBusy(false);
        setDirty(false);
      }
      return;
    }
    onSaveTrim(saveIn, saveOut, { keepRanges: saveRanges });
    setDirty(false);
  };

  return (
    <div className={`space-y-2 ${compact ? '' : 'p-3 rounded-xl bg-[#F8F9FA] border border-[#DADCE0]'}`}>
      {title && (
        <p className="text-[11px] font-semibold text-[#202124] truncate flex items-center gap-1">
          <Scissors className="w-3 h-3 text-[#1A73E8]" />
          {title}
        </p>
      )}
      <video
        ref={videoRef}
        src={videoUrl}
        controls
        playsInline
        preload="metadata"
        className={`w-full rounded-xl bg-black object-contain ${compact ? 'max-h-40' : 'max-h-72'}`}
      />
      <div className="space-y-2 text-[11px]">
        <div className="flex items-center justify-between text-[#5F6368]">
          <span>
            Keep {formatDuration(keepTotal)} of {formatDuration(duration || 0)}
            <span className="ml-2 font-mono text-[#202124]">
              {multiRange
                ? `${ranges.length} segments`
                : `${draftIn.toFixed(1)}s – ${draftOut.toFixed(1)}s`}
            </span>
          </span>
          <span className="font-mono">{formatDuration(current)}</span>
        </div>

        {/* Multi-range track with selected dual handles */}
        <div
          ref={trackRef}
          className="relative h-8 select-none touch-none cursor-pointer"
          onPointerDown={(e) => {
            if ((e.target as HTMLElement).dataset.handle) return;
            const t = timeFromClientX(e.clientX);
            const hit = rangeContaining(t);
            if (hit >= 0) setSelectedIndex(hit);
            if (videoRef.current) {
              videoRef.current.currentTime = clamp(t);
              setCurrent(clamp(t));
            }
            setDragging('playhead');
          }}
        >
          <div className="absolute inset-x-0 top-1/2 -translate-y-1/2 h-2 rounded-full bg-[#E8EAED]" />
          {ranges.map((r, i) => (
            <div
              key={`${r.start}-${r.end}-${i}`}
              className="absolute top-1/2 -translate-y-1/2 h-2 rounded-full"
              style={{
                left: `${pct(r.start)}%`,
                width: `${Math.max(0, pct(r.end) - pct(r.start))}%`,
                backgroundColor: RANGE_COLORS[i % RANGE_COLORS.length],
                opacity: i === selectedIndex ? 0.9 : 0.45,
                outline: i === selectedIndex ? '1px solid rgba(0,0,0,0.25)' : undefined,
              }}
              onPointerDown={(e) => {
                e.stopPropagation();
                setSelectedIndex(i);
              }}
            />
          ))}
          {/* Playhead */}
          <div
            className="absolute top-0 bottom-0 w-0.5 bg-[#EA4335] pointer-events-none"
            style={{ left: `${pct(current)}%` }}
          />
          {/* In handle (selected) */}
          {selected && (
            <button
              type="button"
              data-handle="in"
              aria-label="Trim in"
              className="absolute top-1/2 -translate-y-1/2 -translate-x-1/2 w-4 h-6 rounded-sm bg-[#1A73E8] border-2 border-white shadow cursor-ew-resize z-10"
              style={{ left: `${pct(draftIn)}%` }}
              onPointerDown={(e) => {
                e.stopPropagation();
                (e.target as HTMLElement).setPointerCapture?.(e.pointerId);
                setDragging('in');
              }}
            />
          )}
          {/* Out handle (selected) */}
          {selected && (
            <button
              type="button"
              data-handle="out"
              aria-label="Trim out"
              className="absolute top-1/2 -translate-y-1/2 -translate-x-1/2 w-4 h-6 rounded-sm bg-[#1A73E8] border-2 border-white shadow cursor-ew-resize z-10"
              style={{ left: `${pct(draftOut)}%` }}
              onPointerDown={(e) => {
                e.stopPropagation();
                (e.target as HTMLElement).setPointerCapture?.(e.pointerId);
                setDragging('out');
              }}
            />
          )}
        </div>

        {multiRange && (
          <div className="flex flex-wrap gap-1">
            {ranges.map((r, i) => (
              <button
                key={`chip-${i}`}
                type="button"
                onClick={() => {
                  setSelectedIndex(i);
                  if (videoRef.current) {
                    videoRef.current.currentTime = r.start;
                    setCurrent(r.start);
                  }
                }}
                className={`px-1.5 py-0.5 rounded font-mono text-[10px] border cursor-pointer ${
                  i === selectedIndex
                    ? 'bg-[#1A73E8] text-white border-[#1A73E8]'
                    : 'bg-white text-[#5F6368] border-[#DADCE0]'
                }`}
              >
                {r.start.toFixed(1)}–{r.end.toFixed(1)}s
              </button>
            ))}
          </div>
        )}

        <div className="flex flex-wrap items-center gap-1.5 pt-1">
          <button
            type="button"
            onClick={() => {
              setIn(current);
              if (videoRef.current) videoRef.current.currentTime = current;
            }}
            className="px-2 py-1 rounded-lg bg-white border border-[#DADCE0] font-bold text-[#202124] hover:bg-[#F1F3F4] cursor-pointer"
          >
            Mark in
          </button>
          <button
            type="button"
            onClick={() => {
              setOut(current);
              if (videoRef.current) videoRef.current.currentTime = Math.max(draftIn, current - 0.05);
            }}
            className="px-2 py-1 rounded-lg bg-white border border-[#DADCE0] font-bold text-[#202124] hover:bg-[#F1F3F4] cursor-pointer"
          >
            Mark out
          </button>
          <button
            type="button"
            disabled={!canSplit}
            onClick={splitAtPlayhead}
            title="Split selected segment at playhead (min 0.3s each side)"
            className="inline-flex items-center gap-1 px-2 py-1 rounded-lg bg-white border border-[#DADCE0] font-bold text-[#202124] hover:bg-[#F1F3F4] disabled:opacity-40 cursor-pointer"
          >
            <SplitSquareHorizontal className="w-3 h-3" />
            Split
          </button>
          <button
            type="button"
            disabled={!ranges.length}
            onClick={deleteSelectedSegment}
            title={
              ranges.length <= 1
                ? 'Reset to full take'
                : 'Delete selected keep segment'
            }
            className="inline-flex items-center gap-1 px-2 py-1 rounded-lg bg-white border border-[#DADCE0] font-bold text-[#5F6368] hover:bg-[#F1F3F4] disabled:opacity-40 cursor-pointer"
          >
            <Trash2 className="w-3 h-3" />
            Delete segment
          </button>
          <button
            type="button"
            disabled={(!dirty && !userTrimLocked) || cleanupBusy}
            onClick={() => void commitSave()}
            className="px-2 py-1 rounded-lg bg-[#1A73E8] text-white font-bold hover:bg-[#1557B0] disabled:opacity-40 cursor-pointer"
          >
            {cleanupBusy ? 'Extracting…' : 'Save'}
          </button>
          <button
            type="button"
            disabled={
              !userTrimLocked &&
              ranges.length === 1 &&
              draftIn === 0 &&
              (!duration || draftOut >= duration - 0.05)
            }
            onClick={() => {
              onResetTrim();
              setRanges(duration > 0 ? [{ start: 0, end: duration }] : []);
              setSelectedIndex(0);
              setDirty(false);
              setCleanupExtract(false);
            }}
            className="inline-flex items-center gap-1 px-2 py-1 rounded-lg bg-white border border-[#DADCE0] font-bold text-[#5F6368] hover:bg-[#F1F3F4] disabled:opacity-40 cursor-pointer"
          >
            <RotateCcw className="w-3 h-3" />
            Reset
          </button>
        </div>

        {gcsObjectPath && (
          <label
            className={`flex items-center gap-2 text-[10px] text-[#5F6368] ${
              multiRange ? 'opacity-40 cursor-not-allowed' : 'cursor-pointer'
            }`}
          >
            <input
              type="checkbox"
              checked={cleanupExtract && !multiRange}
              disabled={multiRange}
              onChange={(e) => setCleanupExtract(e.target.checked)}
              className="accent-[#1A73E8]"
            />
            {multiRange
              ? 'Extract kept range unavailable with multiple segments (saves keepRanges only)'
              : 'Extract kept range to new file & delete original (saves storage)'}
          </label>
        )}

        {userTrimLocked && (
          <p className="text-[10px] font-semibold text-[#137333]">
            Manual trim locked — Gemini will keep{' '}
            {multiRange ? `these ${ranges.length} segments` : 'this range'} on the master cut.
          </p>
        )}
      </div>
    </div>
  );
};
