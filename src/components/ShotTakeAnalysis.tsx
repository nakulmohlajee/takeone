import React from 'react';
import { ShieldCheck, AlertTriangle } from 'lucide-react';
import type { FactCheckedClaim, Scene } from '../types/director';

export const ShotTakeAnalysis: React.FC<{ scene: Scene; analyzing?: boolean }> = ({
  scene,
  analyzing,
}) => {
  const claims = scene.factCheckClaims || [];
  const live = scene.liveFactCheck;
  const factual = claims.filter((c) => c.kind === 'factual_claim' || c.verdict === 'disputed');
  const disputed = factual.filter((c) => c.verdict === 'disputed');

  if (!analyzing && !claims.length && !live && !scene.transcript) return null;

  return (
    <div className="rounded-xl border border-[#D2E3FC] bg-[#E8F0FE]/40 p-3 space-y-2 overflow-hidden">
      <div className="flex items-center gap-1.5 text-xs font-bold text-[#174EA6]">
        <ShieldCheck className="w-3.5 h-3.5 shrink-0" />
        AI analysis
        {analyzing && <span className="text-[#1A73E8] animate-pulse">Checking…</span>}
      </div>

      {live?.factCheckMessage && (
        <div
          className={`text-xs rounded-lg border px-2.5 py-2 ${
            live.status === 'alert'
              ? 'bg-[#FCE8E6] border-[#F5C2C7] text-[#C5221F]'
              : live.status === 'warning'
                ? 'bg-[#FEF7E0] border-[#FEEFC3] text-[#B06000]'
                : 'bg-[#E6F4EA] border-[#CEEAD6] text-[#137333]'
          }`}
        >
          <div className="font-bold">{live.alertTitle || 'Live director'}</div>
          <p className="mt-0.5 break-words">{live.factCheckMessage}</p>
          {live.audienceConnectionScore != null && (
            <p className="mt-1 text-xs font-semibold">
              Connection {live.audienceConnectionScore}%
            </p>
          )}
        </div>
      )}

      {factual.length === 0 && scene.transcript && !analyzing && (
        <p className="text-xs text-[#5F6368]">
          No factual claims flagged. Transcript looks conversational.
        </p>
      )}

      {disputed.length > 0 && (
        <p className="text-xs font-semibold text-[#C5221F] flex items-center gap-1">
          <AlertTriangle className="w-3 h-3" />
          {disputed.length} claim{disputed.length === 1 ? '' : 's'} need a look
        </p>
      )}

      {factual.slice(0, 6).map((c: FactCheckedClaim, i) => (
        <div
          key={`${c.start}-${i}`}
          className={`text-xs rounded-lg border px-2.5 py-2 break-words ${
            c.verdict === 'disputed'
              ? 'bg-[#FCE8E6] border-[#F5C2C7] text-[#C5221F]'
              : c.verdict === 'supported'
                ? 'bg-[#E6F4EA] border-[#CEEAD6] text-[#137333]'
                : 'bg-white border-[#DADCE0] text-[#3C4043]'
          }`}
        >
          <div className="font-mono text-xs opacity-70 mb-0.5">
            {c.start.toFixed(1)}–{c.end.toFixed(1)}s · {c.verdict || c.kind}
          </div>
          <div className="font-semibold">“{c.text}”</div>
          {c.explanation && <div className="mt-0.5 opacity-80">{c.explanation}</div>}
        </div>
      ))}
    </div>
  );
};
