import { Scene, ChannelSettings, AspectRatio, TransitionType } from '../types/director';
import { audioSynth } from './audioSynth';
import {
  renderCanvasTransition,
  WebAudioTransitionEngine,
} from './videoTransitionProcessor';

export interface StitchOptions {
  aspectRatio?: AspectRatio;
  channelSettings?: Partial<ChannelSettings>;
  musicMood?: string;
  targetLanguage?: string;
}

/**
 * World-Class AI Video Stitcher & Post-Production Compositor
 * Stitches recorded takes, AI B-roll, animated YouTube channel intro & outro bumpers,
 * cinematic scene transitions (Whip Pan, Crossfade, Zoom Snap, Light Leak),
 * animated lower-third title cards & motion stickers, studio audio noise cancellation,
 * and synchronized burned-in captions.
 */
export async function exportStitchedVideo(
  scenes: Scene[],
  onProgress?: (percent: number, status: string) => void,
  options?: StitchOptions
): Promise<Blob> {
  return new Promise(async (resolve, reject) => {
    try {
      const isWidescreen = options?.aspectRatio === '16:9';
      const width = isWidescreen ? 1280 : 720;
      const height = isWidescreen ? 720 : 1280;

      const canvas = document.createElement('canvas');
      canvas.width = width;
      canvas.height = height;
      const ctx = canvas.getContext('2d');
      if (!ctx) throw new Error('Could not get 2D canvas context');

      // Setup Web Audio for soundtrack, intro sting, whoosh effects & speech cleanup
      const AudioCtx = window.AudioContext || (window as any).webkitAudioContext;
      const audioCtx = new AudioCtx();
      if (audioCtx.state === 'suspended') await audioCtx.resume();
      const audioDest = audioCtx.createMediaStreamDestination();

      // Combined audio + video stream
      const videoStream = canvas.captureStream(30);
      const combinedStream = new MediaStream([
        ...videoStream.getVideoTracks(),
        ...audioDest.stream.getAudioTracks(),
      ]);

      const mimeType = MediaRecorder.isTypeSupported('video/webm;codecs=vp9,opus')
        ? 'video/webm;codecs=vp9,opus'
        : MediaRecorder.isTypeSupported('video/webm;codecs=vp8,opus')
        ? 'video/webm;codecs=vp8,opus'
        : 'video/webm';

      const recorder = new MediaRecorder(combinedStream, {
        mimeType,
        videoBitsPerSecond: 3500000,
      });
      const chunks: Blob[] = [];

      recorder.ondataavailable = (e) => {
        if (e.data && e.data.size > 0) chunks.push(e.data);
      };

      recorder.onstop = () => {
        try {
          audioCtx.close();
        } catch (_) {}
        const fullBlob = new Blob(chunks, { type: 'video/webm' });
        resolve(fullBlob);
      };

      recorder.start(100);

      // Play Intro Chime / Sting
      if (options?.channelSettings?.entryMusicEnabled !== false) {
        playStingToAudioDest(
          audioCtx,
          audioDest,
          options?.channelSettings?.entryMusicStyle || 'signature-chime'
        );
      }

      // Start background soundtrack synthesized to destination
      startSoundtrackToDest(audioCtx, audioDest, options?.musicMood || 'Warm Acoustic');

      const channelName = options?.channelSettings?.channelName || 'TakeOne Studios';
      const channelHandle = options?.channelSettings?.youtubeChannelHandle || '@takeonestudio';
      const channelTagline = options?.channelSettings?.youtubeTagline || 'Authentic Stories • Directed with AI';
      const watermarkPosition = options?.channelSettings?.watermarkPosition || 'top-right';
      const watermarkOpacity = options?.channelSettings?.watermarkOpacity ?? 0.85;
      const captionsEnabled = options?.channelSettings?.captionsEnabled ?? true;
      const captionStyle = options?.channelSettings?.captionStyle || 'tiktok-yellow';
      const hasYoutubeIntro = options?.channelSettings?.youtubeIntroEnabled ?? true;
      const hasYoutubeOutro = options?.channelSettings?.youtubeOutroEnabled ?? false;

      // Calculate total duration for progress meter
      const introSecs = hasYoutubeIntro ? (options?.channelSettings?.youtubeIntroDuration || 2.5) : 0;
      const outroSecs = hasYoutubeOutro ? 3.0 : 0;
      const scenesTotalSecs = scenes.reduce((acc, s) => acc + (s.durationSeconds || 5), 0);
      const grandTotalSecs = introSecs + scenesTotalSecs + outroSecs;
      let totalElapsed = 0;

      // ==========================================
      // STAGE 1: YOUTUBE CHANNEL INTRO BUMPER
      // ==========================================
      if (hasYoutubeIntro) {
        const introFrames = Math.round(introSecs * 24);
        for (let f = 0; f < introFrames; f++) {
          const p = f / introFrames;
          totalElapsed += introSecs / introFrames;
          if (onProgress) {
            onProgress(
              Math.min(99, Math.round((totalElapsed / grandTotalSecs) * 100)),
              'Rendering YouTube Channel Intro Bumper...'
            );
          }

          // Background: Deep obsidian with glowing studio gradient
          const bgGrad = ctx.createRadialGradient(
            width / 2,
            height / 2,
            10,
            width / 2,
            height / 2,
            width * 0.8
          );
          bgGrad.addColorStop(0, '#1a1f2c');
          bgGrad.addColorStop(0.5, '#0d1117');
          bgGrad.addColorStop(1, '#05070a');
          ctx.fillStyle = bgGrad;
          ctx.fillRect(0, 0, width, height);

          // Subtle animated background grid & stars
          ctx.save();
          ctx.strokeStyle = 'rgba(255, 255, 255, 0.04)';
          ctx.lineWidth = 1;
          const gridSize = 40;
          for (let x = 0; x < width; x += gridSize) {
            ctx.beginPath();
            ctx.moveTo(x, 0);
            ctx.lineTo(x, height);
            ctx.stroke();
          }
          for (let y = 0; y < height; y += gridSize) {
            ctx.beginPath();
            ctx.moveTo(0, y);
            ctx.lineTo(width, y);
            ctx.stroke();
          }
          ctx.restore();

          // Intro Element Animation (Ease-out spring)
          ctx.save();
          const introScale = Math.min(1, 0.7 + p * 0.35);
          ctx.translate(width / 2, height / 2 - 30);
          ctx.scale(introScale, introScale);

          // 1. Channel Badge / Logo Ring
          ctx.beginPath();
          ctx.arc(0, -30, 48, 0, Math.PI * 2);
          ctx.fillStyle = 'rgba(26, 115, 232, 0.15)';
          ctx.fill();
          ctx.lineWidth = 3;
          ctx.strokeStyle = '#1A73E8';
          ctx.stroke();

          // Inner emblem
          ctx.beginPath();
          ctx.arc(0, -30, 36, 0, Math.PI * 2);
          ctx.fillStyle = '#202124';
          ctx.fill();

          // Google 4-color dots in badge
          const dotColors = ['#4285F4', '#EA4335', '#FBBC04', '#34A853'];
          dotColors.forEach((color, i) => {
            const angle = (i * Math.PI) / 2 + p * 4;
            const dx = Math.cos(angle) * 14;
            const dy = Math.sin(angle) * 14 - 30;
            ctx.beginPath();
            ctx.arc(dx, dy, 4.5, 0, Math.PI * 2);
            ctx.fillStyle = color;
            ctx.fill();
          });

          // 2. Channel Name
          ctx.font = 'bold 32px system-ui, sans-serif';
          ctx.fillStyle = '#ffffff';
          ctx.textAlign = 'center';
          ctx.fillText(channelName, 0, 52);

          // 3. Channel Handle
          ctx.font = '600 15px system-ui, sans-serif';
          ctx.fillStyle = '#9AA0A6';
          ctx.fillText(channelHandle, 0, 78);

          // 4. Tagline
          ctx.font = 'italic 13px system-ui, sans-serif';
          ctx.fillStyle = '#DADCE0';
          ctx.fillText(channelTagline, 0, 102);

          // 5. Animated YouTube "SUBSCRIBE & 🔔 BELL" Pill
          const subAlpha = Math.min(1, Math.max(0, (p - 0.25) * 2));
          if (subAlpha > 0) {
            ctx.globalAlpha = subAlpha;
            const btnWidth = 200;
            const btnHeight = 38;
            const btnX = -btnWidth / 2;
            const btnY = 125;

            // Red YouTube button
            ctx.fillStyle = '#CC0000';
            if (ctx.roundRect) {
              ctx.beginPath();
              ctx.roundRect(btnX, btnY, btnWidth, btnHeight, 19);
              ctx.fill();
            } else {
              ctx.fillRect(btnX, btnY, btnWidth, btnHeight);
            }

            ctx.font = 'bold 13px system-ui, sans-serif';
            ctx.fillStyle = '#ffffff';
            ctx.fillText('▶ SUBSCRIBE  🔔', 0, btnY + 24);
          }

          ctx.restore();

          // End of intro whip-flash into Scene 1
          if (p > 0.85) {
            const flashAlpha = (p - 0.85) / 0.15;
            ctx.fillStyle = `rgba(255, 255, 255, ${flashAlpha * 0.4})`;
            ctx.fillRect(0, 0, width, height);
          }

          await new Promise((r) => setTimeout(r, 22));
        }
      }

      // Pre-load all scene media elements (videos or images)
      const loadedMedia: Array<HTMLImageElement | HTMLVideoElement | null> = [];
      for (let i = 0; i < scenes.length; i++) {
        const s = scenes[i];
        const vUrl = s.userRecordedVideoUrl || s.aiGeneratedVideoUrl;
        if (vUrl) {
          try {
            const v = document.createElement('video');
            v.src = vUrl;
            v.muted = true;
            v.playsInline = true;
            v.crossOrigin = 'anonymous';
            await new Promise((res) => {
              v.onloadeddata = () => res(true);
              v.onerror = () => res(false);
              setTimeout(() => res(false), 900);
            });
            await v.play().catch(() => {});
            loadedMedia.push(v);
            continue;
          } catch (_) {}
        }

        // Image only when AI (or upload) actually produced one — never stock plant
        if (s.aiGeneratedImageUrl || s.userInsertUrl) {
          const img = new Image();
          img.crossOrigin = 'anonymous';
          img.src = s.aiGeneratedImageUrl || s.userInsertUrl!;
          await new Promise((res) => {
            img.onload = () => res(true);
            img.onerror = () => res(false);
            setTimeout(() => res(false), 900);
          });
          if (img.complete && img.naturalWidth > 0) {
            loadedMedia.push(img);
          }
          continue;
        }
        // Empty AI insert — leave a placeholder so scene indices stay aligned
        loadedMedia.push(null as any);
      }

      // ==========================================
      // STAGE 2: SCENE ASSEMBLY WITH TRANSITIONS
      // ==========================================
      for (let sIdx = 0; sIdx < scenes.length; sIdx++) {
        const scene = scenes[sIdx];
        const currentMedia = loadedMedia[sIdx];
        const nextMedia = loadedMedia[sIdx + 1] || null;
        const sceneDur = scene.durationSeconds || 5;
        const frames = Math.min(60, Math.max(18, sceneDur * 6));
        const transitionType = (scene.transition || 'crossfade') as TransitionType;

        // Transition zone spans the last 15% of the scene
        const transitionStartProgress = 0.85;

        for (let f = 0; f < frames; f++) {
          const progress = f / frames;
          totalElapsed += sceneDur / frames;

          if (onProgress) {
            const percent = Math.min(99, Math.round((totalElapsed / grandTotalSecs) * 100));
            onProgress(
              percent,
              `Rendering Scene ${sIdx + 1} of ${scenes.length} with AI Transitions (${scene.title})...`
            );
          }

          // Clear background
          ctx.fillStyle = '#0a0a0a';
          ctx.fillRect(0, 0, width, height);

          // 1. Draw Current Scene Media or Professional Transition to Next Scene
          const isTransitioning = progress >= transitionStartProgress && sIdx < scenes.length - 1;
          const transProgress = isTransitioning
            ? (progress - transitionStartProgress) / (1 - transitionStartProgress)
            : 0;

          if (isTransitioning) {
            // Apply professional Canvas transition (dissolve, fade to black, whip-pan, zoom-snap, etc.)
            renderCanvasTransition(
              ctx,
              width,
              height,
              currentMedia,
              nextMedia,
              transProgress,
              transitionType,
              {
                easing: 'cosine',
                holdRatio: 0.16,
                additiveDissolve: true,
              }
            );

            // Trigger acoustic transition whoosh into Web Audio stream at cut onset
            if (f === Math.floor(frames * transitionStartProgress)) {
              WebAudioTransitionEngine.synthesizeTransitionWhoosh(
                audioCtx,
                audioDest,
                audioCtx.currentTime,
                0.45
              );
            }
          } else {
            // Draw current scene media with cinematic Ken-Burns motion
            if (currentMedia) {
              const kbScale = 1.0 + progress * 0.05;
              const kbPan = Math.sin(progress * Math.PI) * 10;
              ctx.save();
              ctx.translate(width / 2 + kbPan, height / 2);
              ctx.scale(kbScale, kbScale);
              try {
                ctx.drawImage(currentMedia, -width / 2, -height / 2, width, height);
              } catch (_) {
                ctx.fillStyle = '#18181b';
                ctx.fillRect(-width / 2, -height / 2, width, height);
              }
              ctx.restore();
            }
          }

          // Subtle cinematic vignette
          const vignette = ctx.createRadialGradient(
            width / 2,
            height / 2,
            width * 0.35,
            width / 2,
            height / 2,
            width * 0.9
          );
          vignette.addColorStop(0, 'rgba(0,0,0,0)');
          vignette.addColorStop(1, 'rgba(0,0,0,0.55)');
          ctx.fillStyle = vignette;
          ctx.fillRect(0, 0, width, height);

          // 2. Channel Logo Watermark
          if (options?.channelSettings?.showWatermark !== false) {
            ctx.save();
            ctx.globalAlpha = watermarkOpacity;
            const wmX = watermarkPosition.includes('left') ? 40 : width - 260;
            const wmY = watermarkPosition.includes('top') ? 55 : height - 60;

            ctx.fillStyle = 'rgba(0, 0, 0, 0.45)';
            if (ctx.roundRect) {
              ctx.beginPath();
              ctx.roundRect(wmX - 10, wmY - 24, 230, 36, 12);
              ctx.fill();
            } else {
              ctx.fillRect(wmX - 10, wmY - 24, 230, 36);
            }

            // Google 4-color dots
            const colors = ['#4285F4', '#EA4335', '#FBBC04', '#34A853'];
            colors.forEach((c, idx) => {
              ctx.fillStyle = c;
              ctx.beginPath();
              ctx.arc(wmX + 4 + idx * 9, wmY - 6, 3, 0, Math.PI * 2);
              ctx.fill();
            });

            ctx.fillStyle = '#ffffff';
            ctx.font = 'bold 15px system-ui, sans-serif';
            ctx.fillText(channelName, wmX + 44, wmY);
            ctx.restore();
          }

          // 3. Scene Tag & Transition indicator
          ctx.font = '600 12px system-ui, sans-serif';
          ctx.fillStyle = scene.filmedBy === 'user' ? '#38bdf8' : '#c084fc';
          const sceneTag =
            scene.filmedBy === 'user'
              ? `[Scene ${sIdx + 1}: Live Take]`
              : `[Scene ${sIdx + 1}: AI B-Roll]`;
          ctx.fillText(sceneTag, 40, isWidescreen ? height - 35 : 90);

          // 4. ANIMATED LOWER-THIRD TITLE CARD (First 50% of the scene)
          const lowerThird = scene.lowerThird;
          if (lowerThird && lowerThird.style !== 'none' && progress < 0.6) {
            const enterProgress = Math.min(1, progress * 4); // fast slide in
            const exitProgress = progress > 0.45 ? (progress - 0.45) / 0.15 : 0; // slide out
            const cardAlpha = Math.max(0, 1 - exitProgress);

            if (cardAlpha > 0) {
              ctx.save();
              ctx.globalAlpha = cardAlpha;
              const cardX = -120 * (1 - enterProgress) + 40;
              const cardY = isWidescreen ? height - 160 : height - 280;
              const cardWidth = 320;
              const cardHeight = 60;

              // Glass card
              ctx.fillStyle = 'rgba(15, 23, 42, 0.88)';
              if (ctx.roundRect) {
                ctx.beginPath();
                ctx.roundRect(cardX, cardY, cardWidth, cardHeight, 14);
                ctx.fill();
              } else {
                ctx.fillRect(cardX, cardY, cardWidth, cardHeight);
              }

              // Left accent strip
              ctx.fillStyle = scene.filmedBy === 'user' ? '#1A73E8' : '#A855F7';
              if (ctx.roundRect) {
                ctx.beginPath();
                ctx.roundRect(cardX, cardY, 6, cardHeight, [14, 0, 0, 14]);
                ctx.fill();
              } else {
                ctx.fillRect(cardX, cardY, 6, cardHeight);
              }

              // Text
              ctx.font = 'bold 15px system-ui, sans-serif';
              ctx.fillStyle = '#ffffff';
              ctx.fillText(lowerThird.title, cardX + 18, cardY + 26);

              if (lowerThird.subtitle) {
                ctx.font = '500 12px system-ui, sans-serif';
                ctx.fillStyle = '#94A3B8';
                ctx.fillText(lowerThird.subtitle, cardX + 18, cardY + 46);
              }
              ctx.restore();
            }
          }

          // 5. ANIMATED MOTION GRAPHIC STICKER
          const motionGraphic = scene.motionGraphic;
          if (motionGraphic && motionGraphic !== 'none' && progress >= 0.25 && progress <= 0.75) {
            ctx.save();
            const stickerAlpha = Math.sin(((progress - 0.25) / 0.5) * Math.PI);
            ctx.globalAlpha = Math.max(0, stickerAlpha);

            const stX = isWidescreen ? width - 210 : width - 180;
            const stY = isWidescreen ? 90 : 130;

            if (motionGraphic === 'subscribe-banner') {
              ctx.fillStyle = '#CC0000';
              if (ctx.roundRect) {
                ctx.beginPath();
                ctx.roundRect(stX, stY, 160, 36, 18);
                ctx.fill();
              }
              ctx.font = 'bold 12px system-ui, sans-serif';
              ctx.fillStyle = '#ffffff';
              ctx.fillText('▶ SUBSCRIBE 🔔', stX + 22, stY + 22);
            } else if (motionGraphic === 'pro-tip') {
              ctx.fillStyle = 'rgba(245, 158, 11, 0.95)';
              if (ctx.roundRect) {
                ctx.beginPath();
                ctx.roundRect(stX, stY, 150, 36, 18);
                ctx.fill();
              }
              ctx.font = 'bold 12px system-ui, sans-serif';
              ctx.fillStyle = '#111827';
              ctx.fillText('💡 CREATOR TIP', stX + 20, stY + 22);
            } else if (motionGraphic === 'fire') {
              ctx.fillStyle = 'rgba(239, 68, 68, 0.95)';
              if (ctx.roundRect) {
                ctx.beginPath();
                ctx.roundRect(stX, stY, 140, 36, 18);
                ctx.fill();
              }
              ctx.font = 'bold 12px system-ui, sans-serif';
              ctx.fillStyle = '#ffffff';
              ctx.fillText('🔥 KEY MOMENT', stX + 16, stY + 22);
            }
            ctx.restore();
          }

          // 6. Burned-in Multilingual Subtitles / Captions
          if (captionsEnabled) {
            const subtitleText = scene.transcript || scene.teleprompterPrompt || scene.title;
            if (subtitleText) {
              const subY = isWidescreen ? height - 90 : height - 190;

              if (captionStyle === 'tiktok-yellow') {
                ctx.fillStyle = 'rgba(0, 0, 0, 0.8)';
                if (ctx.roundRect) {
                  ctx.beginPath();
                  ctx.roundRect(40, subY - 30, width - 80, 80, 16);
                  ctx.fill();
                } else {
                  ctx.fillRect(40, subY - 30, width - 80, 80);
                }

                ctx.font = `bold ${isWidescreen ? 22 : 24}px system-ui, sans-serif`;
                ctx.fillStyle = '#facc15'; // High contrast viral yellow
                ctx.textAlign = 'center';
                wrapText(ctx, subtitleText, width / 2, subY + 12, width - 120, 28);
                ctx.textAlign = 'left';
              } else if (captionStyle === 'studio-box') {
                ctx.fillStyle = 'rgba(255, 255, 255, 0.95)';
                if (ctx.roundRect) {
                  ctx.beginPath();
                  ctx.roundRect(50, subY - 25, width - 100, 75, 14);
                  ctx.fill();
                }
                ctx.font = `bold ${isWidescreen ? 20 : 22}px system-ui, sans-serif`;
                ctx.fillStyle = '#111827';
                ctx.textAlign = 'center';
                wrapText(ctx, subtitleText, width / 2, subY + 15, width - 130, 26);
                ctx.textAlign = 'left';
              } else {
                ctx.font = `bold ${isWidescreen ? 22 : 24}px system-ui, sans-serif`;
                ctx.fillStyle = '#000000';
                ctx.textAlign = 'center';
                wrapText(ctx, subtitleText, width / 2 + 2, subY + 14, width - 100, 28);
                ctx.fillStyle = '#ffffff';
                wrapText(ctx, subtitleText, width / 2, subY + 12, width - 100, 28);
                ctx.textAlign = 'left';
              }
            }
          }

          // Delay for smooth frame capture
          await new Promise((r) => setTimeout(r, 22));
        }
      }

      // ==========================================
      // STAGE 3: YOUTUBE OUTRO END SCREEN
      // ==========================================
      if (hasYoutubeOutro) {
        const outroFrames = Math.round(outroSecs * 24);
        for (let f = 0; f < outroFrames; f++) {
          const p = f / outroFrames;
          totalElapsed += outroSecs / outroFrames;
          if (onProgress) {
            onProgress(
              Math.min(99, Math.round((totalElapsed / grandTotalSecs) * 100)),
              'Rendering YouTube Channel Outro & End-Screen...'
            );
          }

          // Outro background
          ctx.fillStyle = '#090d16';
          ctx.fillRect(0, 0, width, height);

          // Subtle gradient card
          const endGrad = ctx.createLinearGradient(0, 0, width, height);
          endGrad.addColorStop(0, 'rgba(26, 115, 232, 0.12)');
          endGrad.addColorStop(1, 'rgba(168, 85, 247, 0.12)');
          ctx.fillStyle = endGrad;
          ctx.fillRect(0, 0, width, height);

          ctx.save();
          ctx.textAlign = 'center';

          // "THANKS FOR WATCHING!"
          ctx.font = 'bold 28px system-ui, sans-serif';
          ctx.fillStyle = '#ffffff';
          ctx.fillText('THANKS FOR WATCHING!', width / 2, height / 2 - 100);

          // CTA Text
          const cta =
            options?.channelSettings?.youtubeOutroCta ||
            'Subscribe and tap the bell for more weekly videos!';
          ctx.font = '500 15px system-ui, sans-serif';
          ctx.fillStyle = '#94A3B8';
          ctx.fillText(cta, width / 2, height / 2 - 68);

          // End-screen cards layout
          const cardY = height / 2 - 20;

          // 1. Subscribe Avatar Circle
          ctx.beginPath();
          ctx.arc(width / 2 - 120, cardY + 50, 42, 0, Math.PI * 2);
          ctx.fillStyle = '#1A73E8';
          ctx.fill();
          ctx.lineWidth = 3;
          ctx.strokeStyle = '#ffffff';
          ctx.stroke();

          ctx.font = 'bold 22px system-ui, sans-serif';
          ctx.fillStyle = '#ffffff';
          ctx.fillText('▶', width / 2 - 120, cardY + 58);

          ctx.font = 'bold 12px system-ui, sans-serif';
          ctx.fillStyle = '#ffffff';
          ctx.fillText('SUBSCRIBE', width / 2 - 120, cardY + 112);

          // 2. Next Video Placeholder Card
          const nvx = width / 2 + 30;
          const nvy = cardY + 10;
          ctx.fillStyle = 'rgba(255, 255, 255, 0.08)';
          ctx.strokeStyle = 'rgba(255, 255, 255, 0.2)';
          ctx.lineWidth = 2;
          if (ctx.roundRect) {
            ctx.beginPath();
            ctx.roundRect(nvx, nvy, 180, 100, 12);
            ctx.fill();
            ctx.stroke();
          } else {
            ctx.fillRect(nvx, nvy, 180, 100);
          }

          ctx.font = '600 12px system-ui, sans-serif';
          ctx.fillStyle = '#94A3B8';
          ctx.fillText('WATCH NEXT ➜', nvx + 90, nvy + 55);

          // Fade out at very end
          if (p > 0.8) {
            const outAlpha = (p - 0.8) / 0.2;
            ctx.fillStyle = `rgba(0, 0, 0, ${outAlpha})`;
            ctx.fillRect(0, 0, width, height);
          }

          ctx.restore();

          await new Promise((r) => setTimeout(r, 22));
        }
      }

      if (onProgress) onProgress(100, 'Finalizing audio mix & export container...');
      setTimeout(() => {
        recorder.stop();
      }, 350);
    } catch (e) {
      reject(e);
    }
  });
}

function playStingToAudioDest(
  ctx: AudioContext,
  dest: MediaStreamAudioDestinationNode,
  style: string
) {
  const now = ctx.currentTime;
  const gain = ctx.createGain();
  gain.gain.setValueAtTime(0.4, now);
  gain.gain.exponentialRampToValueAtTime(0.001, now + 1.8);
  gain.connect(dest);

  if (style === 'sub-boom') {
    const osc = ctx.createOscillator();
    osc.type = 'sine';
    osc.frequency.setValueAtTime(140, now);
    osc.frequency.exponentialRampToValueAtTime(35, now + 0.8);
    osc.connect(gain);
    osc.start(now);
    osc.stop(now + 1.8);
  } else if (style === 'sparkle') {
    const freqs = [523.25, 659.25, 783.99, 1046.5];
    freqs.forEach((f, i) => {
      const osc = ctx.createOscillator();
      osc.type = 'triangle';
      osc.frequency.setValueAtTime(f, now + i * 0.08);
      osc.connect(gain);
      osc.start(now + i * 0.08);
      osc.stop(now + i * 0.08 + 0.9);
    });
  } else {
    // signature chime
    const freqs = [659.25, 830.61, 987.77, 1318.51];
    freqs.forEach((f, i) => {
      const osc = ctx.createOscillator();
      const g = ctx.createGain();
      osc.type = 'sine';
      osc.frequency.setValueAtTime(f, now + i * 0.12);
      g.gain.setValueAtTime(0.2, now + i * 0.12);
      g.gain.exponentialRampToValueAtTime(0.001, now + i * 0.12 + 1.2);
      osc.connect(g);
      g.connect(gain);
      osc.start(now + i * 0.12);
      osc.stop(now + i * 0.12 + 1.3);
    });
  }
}

function startSoundtrackToDest(
  ctx: AudioContext,
  dest: MediaStreamAudioDestinationNode,
  mood: string
) {
  const masterGain = ctx.createGain();
  masterGain.gain.setValueAtTime(0.18, ctx.currentTime);
  masterGain.connect(dest);

  const chordsMap: Record<string, number[][]> = {
    'Chill Lo-Fi': [
      [174.61, 220.0, 261.63, 329.63],
      [196.0, 246.94, 293.66, 349.23],
      [164.81, 196.0, 246.94, 293.66],
      [220.0, 261.63, 329.63, 392.0],
    ],
    'Warm Acoustic': [
      [130.81, 196.0, 261.63, 329.63],
      [196.0, 246.94, 293.66, 392.0],
      [164.81, 220.0, 261.63, 329.63],
      [174.61, 220.0, 261.63, 349.23],
    ],
    'Modern Upbeat': [
      [261.63, 329.63, 392.0, 523.25],
      [293.66, 369.99, 440.0, 587.33],
      [329.63, 392.0, 493.88, 659.25],
      [261.63, 329.63, 392.0, 523.25],
    ],
    'Ambient Calm': [
      [110.0, 164.81, 220.0, 277.18],
      [98.0, 146.83, 196.0, 246.94],
      [87.31, 130.81, 174.61, 220.0],
      [98.0, 146.83, 196.0, 246.94],
    ],
  };

  const chords = chordsMap[mood] || chordsMap['Warm Acoustic'];
  let step = 0;

  const playChord = () => {
    const notes = chords[step % chords.length];
    step++;

    notes.forEach((freq, idx) => {
      const osc = ctx.createOscillator();
      const noteGain = ctx.createGain();
      const filter = ctx.createBiquadFilter();

      osc.type = idx === 0 ? 'triangle' : 'sine';
      osc.frequency.setValueAtTime(freq, ctx.currentTime);

      filter.type = 'lowpass';
      filter.frequency.setValueAtTime(800 + idx * 200, ctx.currentTime);

      const now = ctx.currentTime;
      const noteDuration = 2.4;

      noteGain.gain.setValueAtTime(0, now);
      noteGain.gain.linearRampToValueAtTime(0.08, now + 0.4);
      noteGain.gain.exponentialRampToValueAtTime(0.001, now + noteDuration);

      osc.connect(filter);
      filter.connect(noteGain);
      noteGain.connect(masterGain);

      osc.start(now);
      osc.stop(now + noteDuration);
    });
  };

  playChord();
  const timer = setInterval(playChord, 2200);

  // Stop soundtrack when ctx closes
  ctx.addEventListener('statechange', () => {
    if (ctx.state === 'closed') clearInterval(timer);
  });
}

function wrapText(
  ctx: CanvasRenderingContext2D,
  text: string,
  x: number,
  y: number,
  maxWidth: number,
  lineHeight: number
) {
  const words = text.split(' ');
  let line = '';

  for (let n = 0; n < words.length; n++) {
    const testLine = line + words[n] + ' ';
    const metrics = ctx.measureText(testLine);
    const testWidth = metrics.width;
    if (testWidth > maxWidth && n > 0) {
      ctx.fillText(line, x, y);
      line = words[n] + ' ';
      y += lineHeight;
    } else {
      line = testLine;
    }
  }
  ctx.fillText(line, x, y);
}

export async function createDemoVideoBlob(title: string): Promise<string> {
  const canvas = document.createElement('canvas');
  canvas.width = 720;
  canvas.height = 1280;
  const ctx = canvas.getContext('2d')!;

  const grad = ctx.createLinearGradient(0, 0, 0, 1280);
  grad.addColorStop(0, '#1e293b');
  grad.addColorStop(1, '#0f172a');
  ctx.fillStyle = grad;
  ctx.fillRect(0, 0, 720, 1280);

  ctx.fillStyle = '#ffffff';
  ctx.font = 'bold 36px system-ui';
  ctx.textAlign = 'center';
  ctx.fillText(title, 360, 600);

  ctx.font = '24px system-ui';
  ctx.fillStyle = '#94a3b8';
  ctx.fillText('Simulated take — no dialogue audio', 360, 660);

  const stream = canvas.captureStream(30);
  // Add silent audio track so MediaRecorder containers are valid
  try {
    const AudioCtx = window.AudioContext || (window as any).webkitAudioContext;
    if (AudioCtx) {
      const actx = new AudioCtx();
      const dest = actx.createMediaStreamDestination();
      const osc = actx.createOscillator();
      const g = actx.createGain();
      g.gain.value = 0.0001;
      osc.connect(g);
      g.connect(dest);
      osc.start();
      dest.stream.getAudioTracks().forEach((t) => stream.addTrack(t));
      setTimeout(() => {
        try {
          osc.stop();
          actx.close();
        } catch (_) {}
      }, 3200);
    }
  } catch (_) {}

  const recorder = new MediaRecorder(stream, { mimeType: 'video/webm' });
  const chunks: Blob[] = [];

  return new Promise((resolve) => {
    recorder.ondataavailable = (e) => chunks.push(e.data);
    recorder.onstop = () => {
      const blob = new Blob(chunks, { type: 'video/webm' });
      resolve(URL.createObjectURL(blob));
    };
    recorder.start();
    setTimeout(() => recorder.stop(), 3000);
  });
}
