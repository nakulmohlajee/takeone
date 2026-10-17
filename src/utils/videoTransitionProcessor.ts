/**
 * Video Transition Processor using Web Audio & Canvas APIs
 *
 * Implements professional transitions between stitched video segments:
 * - Optical Cross-Dissolve: Luminance-calibrated cosine S-curve blending.
 * - Fade to Black (Dip to Black): 3-stage cinematic fade out, black frame hold, and fade up.
 * - Whip Pan: Velocity-mapped motion blur swipe with speed lines.
 * - Zoom Dissolve: Dynamic scale push-in optical dissolve.
 * - Light Leak: Golden film flash / lens flare dissolve.
 * - Web Audio Equal-Power Crossfade: Mathematical constant-energy audio mixing (cos/sin curve).
 * - Web Audio Fade-to-Silence: Acoustic dip to match visual fade to black.
 */

import { TransitionType } from '../types/director';

export interface TransitionRenderOptions {
  durationSeconds?: number;
  easing?: 'cosine' | 'smoothstep' | 'linear';
  fadeColor?: string; // default '#000000'
  holdRatio?: number; // ratio of duration held at pure black (e.g. 0.15 = 15%)
  additiveDissolve?: boolean;
}

export interface AudioTransitionOptions {
  curve?: 'equal-power' | 'linear' | 'dip-to-silence';
  durationSeconds?: number;
  whooshVolume?: number;
}

/**
 * Normalizes transition type aliases
 */
export function normalizeTransitionType(type?: string): TransitionType {
  if (!type) return 'dissolve';
  if (type === 'crossfade') return 'dissolve';
  if (type === 'dip-black') return 'fade-to-black';
  return type as TransitionType;
}

/**
 * Cosine S-curve interpolation for optical film dissolves.
 * Prevents the 50% luminance dip caused by naive linear alpha blending.
 */
export function cosineEase(t: number): number {
  const clamped = Math.max(0, Math.min(1, t));
  return (1 - Math.cos(clamped * Math.PI)) / 2;
}

/**
 * Smoothstep interpolation: 3t^2 - 2t^3
 */
export function smoothstep(t: number): number {
  const clamped = Math.max(0, Math.min(1, t));
  return clamped * clamped * (3 - 2 * clamped);
}

/**
 * Applies professional visual transition between two media frames on an HTML5 2D Canvas.
 *
 * @param ctx 2D Canvas rendering context
 * @param width Viewport width
 * @param height Viewport height
 * @param fromMedia Outgoing video/image element (null if first scene)
 * @param toMedia Incoming video/image element (null if last scene)
 * @param progress Normalized progress between 0.0 and 1.0
 * @param type Transition type ('dissolve', 'fade-to-black', 'whip-pan', etc.)
 * @param options Styling options
 */
export function renderCanvasTransition(
  ctx: CanvasRenderingContext2D,
  width: number,
  height: number,
  fromMedia: CanvasImageSource | null,
  toMedia: CanvasImageSource | null,
  progress: number,
  type: TransitionType = 'dissolve',
  options?: TransitionRenderOptions
): void {
  const p = Math.max(0, Math.min(1, progress));
  const normType = normalizeTransitionType(type);
  const fadeColor = options?.fadeColor || '#000000';
  const holdRatio = options?.holdRatio ?? 0.15; // 15% hold in the middle

  // Clear frame
  ctx.save();
  ctx.fillStyle = '#0a0a0a';
  ctx.fillRect(0, 0, width, height);

  switch (normType) {
    // -------------------------------------------------------------
    // 1. PROFESSIONAL OPTICAL DISSOLVE / CROSS-DISSOLVE
    // -------------------------------------------------------------
    case 'dissolve': {
      const easeP =
        options?.easing === 'linear'
          ? p
          : options?.easing === 'smoothstep'
          ? smoothstep(p)
          : cosineEase(p);

      // Outgoing Media (fading out smoothly)
      if (fromMedia) {
        ctx.save();
        ctx.globalAlpha = 1.0 - easeP;
        try {
          ctx.drawImage(fromMedia, 0, 0, width, height);
        } catch (_) {
          ctx.fillStyle = '#18181b';
          ctx.fillRect(0, 0, width, height);
        }
        ctx.restore();
      }

      // Incoming Media (fading in with equalized luminance)
      if (toMedia) {
        ctx.save();
        ctx.globalAlpha = easeP;
        try {
          ctx.drawImage(toMedia, 0, 0, width, height);
        } catch (_) {
          ctx.fillStyle = '#27272a';
          ctx.fillRect(0, 0, width, height);
        }
        ctx.restore();
      }

      // Optional subtle film optical bloom at the midpoint (p = 0.5)
      if (options?.additiveDissolve && p > 0.35 && p < 0.65) {
        const bloomIntensity = Math.sin((p - 0.35) * (Math.PI / 0.3)) * 0.18;
        ctx.save();
        ctx.globalCompositeOperation = 'screen';
        ctx.fillStyle = `rgba(255, 255, 255, ${bloomIntensity})`;
        ctx.fillRect(0, 0, width, height);
        ctx.restore();
      }
      break;
    }

    // -------------------------------------------------------------
    // 2. PROFESSIONAL FADE TO BLACK / DIP TO BLACK
    // -------------------------------------------------------------
    case 'fade-to-black': {
      // 3-Stage Timeline:
      // Stage 1 (0 to fadeOutEnd): fromMedia fades down to black
      // Stage 2 (fadeOutEnd to fadeInStart): PURE BLACK HOLD (cinematic breath)
      // Stage 3 (fadeInStart to 1.0): toMedia fades up from black
      const fadeOutEnd = (1 - holdRatio) / 2; // e.g. 0.425
      const fadeInStart = (1 + holdRatio) / 2; // e.g. 0.575

      if (p <= fadeOutEnd) {
        // Stage 1: Fade out fromMedia
        const subP = p / fadeOutEnd;
        const alpha = 1.0 - cosineEase(subP);
        if (fromMedia) {
          ctx.save();
          try {
            ctx.drawImage(fromMedia, 0, 0, width, height);
          } catch (_) {
            ctx.fillStyle = '#18181b';
            ctx.fillRect(0, 0, width, height);
          }
          // Black overlay fading in
          ctx.fillStyle = fadeColor;
          ctx.globalAlpha = 1.0 - alpha;
          ctx.fillRect(0, 0, width, height);
          ctx.restore();
        } else {
          ctx.fillStyle = fadeColor;
          ctx.fillRect(0, 0, width, height);
        }
      } else if (p < fadeInStart) {
        // Stage 2: Pure black hold
        ctx.fillStyle = fadeColor;
        ctx.fillRect(0, 0, width, height);
      } else {
        // Stage 3: Fade in toMedia
        const subP = (p - fadeInStart) / (1 - fadeInStart);
        const alpha = cosineEase(subP);
        if (toMedia) {
          ctx.save();
          try {
            ctx.drawImage(toMedia, 0, 0, width, height);
          } catch (_) {
            ctx.fillStyle = '#27272a';
            ctx.fillRect(0, 0, width, height);
          }
          // Black overlay fading out
          ctx.fillStyle = fadeColor;
          ctx.globalAlpha = 1.0 - alpha;
          ctx.fillRect(0, 0, width, height);
          ctx.restore();
        } else {
          ctx.fillStyle = fadeColor;
          ctx.fillRect(0, 0, width, height);
        }
      }
      break;
    }

    // -------------------------------------------------------------
    // 3. WHIP PAN (Fast Velocity Motion Blur)
    // -------------------------------------------------------------
    case 'whip-pan': {
      const easeP = smoothstep(p);
      const panOffset = -easeP * width * 1.1;

      // Draw outgoing media panning out left
      if (fromMedia) {
        ctx.save();
        ctx.translate(panOffset, 0);
        try {
          ctx.drawImage(fromMedia, 0, 0, width, height);
        } catch (_) {}
        ctx.restore();
      }

      // Draw incoming media following from right
      if (toMedia) {
        ctx.save();
        ctx.translate(width + panOffset, 0);
        try {
          ctx.drawImage(toMedia, 0, 0, width, height);
        } catch (_) {}
        ctx.restore();
      }

      // Draw horizontal speed blur streaks across the middle of the cut
      if (p > 0.15 && p < 0.85) {
        const streakAlpha = Math.sin(((p - 0.15) / 0.7) * Math.PI) * 0.45;
        ctx.save();
        ctx.strokeStyle = `rgba(255, 255, 255, ${streakAlpha})`;
        ctx.lineWidth = 4;
        for (let i = 0; i < 6; i++) {
          const y = (height / 7) * (i + 1);
          ctx.beginPath();
          ctx.moveTo(width * 0.2, y);
          ctx.lineTo(width * 0.85, y);
          ctx.stroke();
        }
        ctx.restore();
      }
      break;
    }

    // -------------------------------------------------------------
    // 4. ZOOM SNAP (Dynamic Punch-In Optical Dissolve)
    // -------------------------------------------------------------
    case 'zoom-snap': {
      const easeP = cosineEase(p);

      // Outgoing zooms in while fading
      if (fromMedia) {
        ctx.save();
        ctx.globalAlpha = Math.max(0, 1.0 - easeP * 1.1);
        const scaleA = 1.0 + easeP * 0.35;
        ctx.translate(width / 2, height / 2);
        ctx.scale(scaleA, scaleA);
        ctx.translate(-width / 2, -height / 2);
        try {
          ctx.drawImage(fromMedia, 0, 0, width, height);
        } catch (_) {}
        ctx.restore();
      }

      // Incoming starts slightly punched in, then snaps to 1.0
      if (toMedia) {
        ctx.save();
        ctx.globalAlpha = Math.min(1.0, easeP * 1.2);
        const scaleB = 1.25 - easeP * 0.25;
        ctx.translate(width / 2, height / 2);
        ctx.scale(scaleB, scaleB);
        ctx.translate(-width / 2, -height / 2);
        try {
          ctx.drawImage(toMedia, 0, 0, width, height);
        } catch (_) {}
        ctx.restore();
      }
      break;
    }

    // -------------------------------------------------------------
    // 5. LIGHT LEAK (Golden Lens Flare Optical Burst)
    // -------------------------------------------------------------
    case 'light-leak': {
      const easeP = cosineEase(p);

      if (fromMedia) {
        ctx.save();
        ctx.globalAlpha = 1.0 - easeP;
        try {
          ctx.drawImage(fromMedia, 0, 0, width, height);
        } catch (_) {}
        ctx.restore();
      }

      if (toMedia) {
        ctx.save();
        ctx.globalAlpha = easeP;
        try {
          ctx.drawImage(toMedia, 0, 0, width, height);
        } catch (_) {}
        ctx.restore();
      }

      // Golden flare burst centered at the cut
      const flareIntensity = Math.sin(p * Math.PI);
      if (flareIntensity > 0.05) {
        ctx.save();
        ctx.globalCompositeOperation = 'screen';
        const grad = ctx.createRadialGradient(
          width * 0.7,
          height * 0.3,
          20,
          width * 0.7,
          height * 0.3,
          width * 0.8
        );
        grad.addColorStop(0, `rgba(255, 230, 140, ${flareIntensity * 0.85})`);
        grad.addColorStop(0.4, `rgba(255, 140, 40, ${flareIntensity * 0.55})`);
        grad.addColorStop(1, 'rgba(0, 0, 0, 0)');
        ctx.fillStyle = grad;
        ctx.fillRect(0, 0, width, height);
        ctx.restore();
      }
      break;
    }

    // Direct Cut (Hard switch at midpoint)
    default: {
      const activeMedia = p < 0.5 ? fromMedia : toMedia;
      if (activeMedia) {
        try {
          ctx.drawImage(activeMedia, 0, 0, width, height);
        } catch (_) {}
      }
      break;
    }
  }

  ctx.restore();
}

/**
 * Web Audio Professional Audio Crossfader & Transition Engine
 *
 * Implements NLE industry-standard Equal-Power Crossfading and Audio Dip to Silence.
 */
export class WebAudioTransitionEngine {
  /**
   * Applies an Equal-Power audio crossfade between two audio gain nodes.
   * Uses mathematical cos/sin curve values: GainA^2 + GainB^2 = 1.0.
   * This guarantees true constant acoustic loudness without the 3dB dip of linear crossfades.
   *
   * @param ctx AudioContext
   * @param gainNodeA GainNode of outgoing segment
   * @param gainNodeB GainNode of incoming segment
   * @param startTime AudioContext timestamp to begin the transition
   * @param durationSeconds Transition duration in seconds (e.g. 0.8s)
   */
  public static applyEqualPowerCrossfade(
    ctx: AudioContext,
    gainNodeA: GainNode,
    gainNodeB: GainNode,
    startTime: number,
    durationSeconds: number
  ): void {
    const steps = 32;
    const curveA = new Float32Array(steps);
    const curveB = new Float32Array(steps);

    for (let i = 0; i < steps; i++) {
      const t = i / (steps - 1);
      // Equal power sine / cosine formula:
      // A fades from 1 -> 0 with cos(t * PI/2)
      // B fades from 0 -> 1 with sin(t * PI/2)
      curveA[i] = Math.cos(t * (Math.PI / 2));
      curveB[i] = Math.sin(t * (Math.PI / 2));
    }

    const t0 = Math.max(ctx.currentTime, startTime);
    gainNodeA.gain.setValueCurveAtTime(curveA, t0, durationSeconds);
    gainNodeB.gain.setValueCurveAtTime(curveB, t0, durationSeconds);
  }

  /**
   * Applies an Audio Dip to Silence to perfectly synchronize with a "Fade to Black" transition.
   *
   * @param ctx AudioContext
   * @param gainNodeA Outgoing gain node
   * @param gainNodeB Incoming gain node
   * @param startTime AudioContext timestamp
   * @param durationSeconds Total duration
   * @param holdRatio Ratio of time spent in complete silence
   */
  public static applyAudioDipToSilence(
    ctx: AudioContext,
    gainNodeA: GainNode,
    gainNodeB: GainNode,
    startTime: number,
    durationSeconds: number,
    holdRatio = 0.15
  ): void {
    const fadeOutDur = (durationSeconds * (1 - holdRatio)) / 2;
    const holdDur = durationSeconds * holdRatio;
    const fadeInDur = (durationSeconds * (1 - holdRatio)) / 2;

    const t0 = Math.max(ctx.currentTime, startTime);
    const tHold = t0 + fadeOutDur;
    const tResume = tHold + holdDur;

    // Outgoing ramps to silence
    gainNodeA.gain.setValueAtTime(gainNodeA.gain.value, t0);
    gainNodeA.gain.exponentialRampToValueAtTime(0.0001, tHold);
    gainNodeA.gain.setValueAtTime(0, tHold + 0.001);

    // Incoming starts at 0, then ramps up from tResume
    gainNodeB.gain.setValueAtTime(0, t0);
    gainNodeB.gain.setValueAtTime(0, tResume);
    gainNodeB.gain.exponentialRampToValueAtTime(1.0, tResume + fadeInDur);
  }

  /**
   * Synthesizes an aerodynamic air whoosh / riser to mask room-tone differences between cuts.
   *
   * @param ctx AudioContext
   * @param dest MediaStreamDestination or master GainNode
   * @param startTime Timestamp to trigger sound
   * @param durationSeconds Duration of whoosh (e.g. 0.45s)
   */
  public static synthesizeTransitionWhoosh(
    ctx: AudioContext,
    dest: AudioNode,
    startTime: number,
    durationSeconds = 0.45
  ): void {
    try {
      const bufferSize = Math.floor(ctx.sampleRate * durationSeconds);
      const buffer = ctx.createBuffer(1, bufferSize, ctx.sampleRate);
      const data = buffer.getChannelData(0);
      for (let i = 0; i < bufferSize; i++) {
        data[i] = Math.random() * 2 - 1;
      }

      const noise = ctx.createBufferSource();
      noise.buffer = buffer;

      // Swept bandpass filter
      const filter = ctx.createBiquadFilter();
      filter.type = 'bandpass';
      filter.Q.setValueAtTime(3.2, startTime);
      filter.frequency.setValueAtTime(260, startTime);
      filter.frequency.exponentialRampToValueAtTime(1900, startTime + durationSeconds * 0.45);
      filter.frequency.exponentialRampToValueAtTime(240, startTime + durationSeconds);

      // Volume envelope
      const gain = ctx.createGain();
      gain.gain.setValueAtTime(0.001, startTime);
      gain.gain.linearRampToValueAtTime(0.22, startTime + durationSeconds * 0.4);
      gain.gain.exponentialRampToValueAtTime(0.001, startTime + durationSeconds);

      noise.connect(filter);
      filter.connect(gain);
      gain.connect(dest);

      noise.start(startTime);
      noise.stop(startTime + durationSeconds);
    } catch (_) {}
  }
}
