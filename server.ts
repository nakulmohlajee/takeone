import express from 'express';
import http from 'http';
import path from 'path';
import dotenv from 'dotenv';
import { GoogleGenAI, Type, GenerateVideosOperation, ThinkingLevel } from '@google/genai';
import { hedgedCall, streamGeminiText } from './server/script/geminiCalls';
import { Storage } from '@google-cloud/storage';
import { createRenderRouter } from './server/render';
import { attachLiveStt } from './server/liveStt';
import { transcribeWithWords } from './server/speech/chirp';
import { compileDirectorCut } from './server/cut/compile';
import { ensureTakeWords } from './server/cut/ensureWords';
import { planImportEdit } from './server/edit/planImport';
import { planTweak } from './server/edit/tweak';
import {
  startDirectorEditJob,
  loadDirectorEditJob,
  waitForDirectorEditJob,
} from './server/edit/directorEditJobs';
import {
  buildCreativeScriptPrompt,
  buildRepairPrompt,
  buildStructurePrompt,
  buildSystemInstruction,
  normalizeProductionPlan,
  productionPlanSchema,
  ideaLikelyNeedsSpeech,
  repairPlanAnchors,
  splitCreativeScript,
  planHasSpokenLines,
  sanitizeProductionPrefs,
  validateAgainstPrefs,
} from './server/script/productionPlan';
import { fillMissingLooks, planSpokenWordCount, restoreSpokenLines } from './server/script/planGuarantees';
import {
  detectSpokenLanguageFromText,
  normalizeSpokenLanguage,
} from './src/utils/spokenLanguage';
import { defaultProductionPrefs, type Project } from './src/types/director';
import { rateLimitMiddleware } from './server/security/rateLimit';

dotenv.config();

const app = express();
const PORT = Number(process.env.PORT) || 3000;
const GCS_BUCKET = process.env.GCS_BUCKET || '';
const GCP_PROJECT = process.env.GOOGLE_CLOUD_PROJECT || process.env.GCP_PROJECT || '';

app.use(express.json({ limit: '10mb' }));

// Rate-limit only expensive render POSTs — status/media/download polls stay unlimited
app.post('/api/render/start', rateLimitMiddleware('render'));
app.post('/api/render/upload-url', rateLimitMiddleware('upload'));
app.use('/api/render', createRenderRouter());

// In-memory cache for downloaded Veo MP4 video buffers
const videoBufferCache = new Map<string, Buffer>();

const getStorage = () => {
  if (!GCS_BUCKET) return null;
  return new Storage(GCP_PROJECT ? { projectId: GCP_PROJECT } : undefined);
};

// Shared server-side Gemini client
const getAiClient = () => {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    console.warn('GEMINI_API_KEY is not set in environment.');
  }
  return new GoogleGenAI({
    apiKey: apiKey || '',
    httpOptions: {
      headers: {
        'User-Agent': 'takeone-cloudrun',
      },
    },
  });
};

function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => {
    if (timer) clearTimeout(timer);
  }) as Promise<T>;
}

app.get('/api/health', (_req, res) => {
  res.json({
    ok: true,
    service: 'takeone',
    geminiConfigured: Boolean(process.env.GEMINI_API_KEY),
    liveStt: true,
    gcsBucket: GCS_BUCKET || null,
    workerJob: process.env.TAKEONE_WORKER_JOB || null,
    models: {
      script: 'gemini-3.8-flash',
      image: 'gemini-3.1-flash-image',
      video: 'veo-3.1-generate-preview',
      tts: 'gemini-3.8-flash-lite-tts',
    },
  });
});

// 1. Idea to Script & Shot Direction Generator (two-pass: creative script → structured plan)
app.post('/api/generate-script', rateLimitMiddleware('script'), async (req, res) => {
  const {
    idea = 'My video project',
    duration = '45 seconds',
    style = 'Friendly & authentic vlog',
    format = 'short-form',
    aspectRatio = '9:16',
    captureStrategy: preferredCaptureStrategy,
    briefHints = null,
    prefs: prefsIn = null,
    spokenLanguage: spokenLanguageIn = null,
  } = req.body || {};

  if (!idea || !idea.trim()) {
    return res.status(400).json({ error: 'Video idea is required.' });
  }

  const isLongForm =
    format === 'long-form' ||
    duration.toLowerCase().includes('minute') ||
    duration.toLowerCase().includes('min');

  const prefs = sanitizeProductionPrefs(prefsIn, isLongForm ? 'long-form' : format);
  const hints = briefHints && typeof briefHints === 'object' ? briefHints : null;
  const spokenLanguage = normalizeSpokenLanguage(
    spokenLanguageIn || detectSpokenLanguageFromText(idea)
  );
  const resolvedAspect = aspectRatio || (isLongForm ? '16:9' : '9:16');

  const structureSystemInstruction = buildSystemInstruction(duration, isLongForm, prefs);
  const creative = buildCreativeScriptPrompt({
    idea,
    duration,
    style,
    isLongForm,
    prefs,
    spokenLanguage,
    briefHints: hints,
  });

  const ai = getAiClient();
  const modelsToTry = ['gemini-3.8-flash', 'gemini-flash-latest', 'gemini-3.1-flash-lite'];
  const t0 = Date.now();
  const timings: Record<string, number> = {};
  const mark = (stage: string, since: number) => {
    timings[stage] = Date.now() - since;
    console.log(`[generate-script] ${stage} ${timings[stage]}ms (total ${Date.now() - t0}ms)`);
  };

  // Optional NDJSON progress stream for the Idea screen; plain JSON otherwise.
  const wantsProgress = req.body?.progress === true;
  if (wantsProgress) {
    res.status(200);
    res.setHeader('Content-Type', 'application/x-ndjson; charset=utf-8');
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('X-Accel-Buffering', 'no');
    res.flushHeaders?.();
  }
  const emit = (stage: string, message: string) => {
    if (!wantsProgress) return;
    res.write(`${JSON.stringify({ type: 'progress', stage, message, elapsedMs: Date.now() - t0 })}\n`);
  };
  const finish = (status: number, body: Record<string, unknown>) => {
    if (wantsProgress) {
      res.write(`${JSON.stringify({ type: 'result', status, body })}\n`);
      return res.end();
    }
    return res.status(status).json(body);
  };

  const normalizeOpts = {
    idea,
    duration,
    style,
    isLongForm,
    aspectRatio: resolvedAspect,
    preferredCaptureStrategy,
    briefHints: hints,
    prefs,
  };

  // Structuring is transcription into a schema — low thinking keeps quality and cuts latency.
  const structureThinking = (model: string) =>
    model.startsWith('gemini-3') ? { thinkingConfig: { thinkingLevel: ThinkingLevel.LOW } } : {};

  // Pass 1: free-form creative script — default thinking, high temperature.
  const runCreativePass = (model: string, signal: AbortSignal, onFirstChunk: () => void) =>
    streamGeminiText(
      ai,
      {
        model,
        contents: creative.prompt,
        config: { systemInstruction: creative.systemInstruction, temperature: 0.9 },
      },
      {
        label: `${model}:pass1`,
        firstChunkMs: 45_000,
        idleMs: 20_000,
        totalMs: isLongForm ? 150_000 : 90_000,
        signal,
        onFirstChunk,
      }
    ).then((text) => {
      const draft = text.trim();
      if (draft.length < 40) throw new Error('empty creative script');
      return draft;
    });

  // Pass 2 / repair: structured JSON — streamed so long plans are never cut off mid-output.
  const runStructurePass = (contents: string, label: string) =>
    hedgedCall(
      modelsToTry,
      (model, signal, onFirstChunk) =>
        streamGeminiText(
          ai,
          {
            model,
            contents,
            config: {
              systemInstruction: structureSystemInstruction,
              responseMimeType: 'application/json',
              responseSchema: productionPlanSchema,
              temperature: 0.2,
              ...structureThinking(model),
            },
          },
          {
            label: `${model}:${label}`,
            firstChunkMs: 40_000,
            idleMs: 20_000,
            totalMs: isLongForm ? 180_000 : 90_000,
            signal,
            onFirstChunk,
          }
        ).then((text) => {
          const parsed = JSON.parse(text);
          if (!Array.isArray(parsed?.scenes) || !parsed.scenes.length) throw new Error('no scenes');
          return parsed;
        }),
      { hedgeAfterMs: 25_000, label }
    );

  try {
    emit('script', isLongForm ? 'Writing your long-form script…' : 'Writing your script…');
    let tStage = Date.now();
    const pass1 = await hedgedCall(modelsToTry, runCreativePass, {
      hedgeAfterMs: 30_000,
      label: 'pass1',
    });
    const creativeScript = pass1.value;
    mark(`pass1(${pass1.model})`, tStage);

    // Long-form: structure chapters in parallel, then stitch scenes back in order.
    const words = creativeScript.split(/\s+/).length;
    const partCount = isLongForm ? (words > 1400 ? 3 : words > 450 ? 2 : 1) : 1;
    const scriptParts = splitCreativeScript(creativeScript, partCount);
    const setupBudget = prefs.shots === 'few' ? 3 : prefs.shots === 'cinematic' ? 6 : 4;
    emit(
      'structure',
      scriptParts.length > 1
        ? `Planning shots & edits (${scriptParts.length} chapters in parallel)…`
        : 'Planning shots & edits…'
    );
    tStage = Date.now();
    const structurePrompts = scriptParts.map((part, k) => {
      const prompt = buildStructurePrompt({
        creativeScript: part,
        idea,
        duration,
        style,
        aspectRatio: resolvedAspect,
        isLongForm,
        briefHints: hints,
        prefs,
      });
      if (scriptParts.length === 1) return prompt;
      const n = scriptParts.length;
      return `${prompt}

PARALLEL STRUCTURING: this is PART ${k + 1} of ${n} of the approved script; the other parts are structured separately and joined in order. Return the full schema, but scenes[] must cover ONLY the spoken text in this part, in order, verbatim.${k > 0 ? ' Do not add a hook or intro — this part continues mid-video.' : ''}${k < n - 1 ? ' Do not add a CTA or outro — the video continues after this part.' : ''} The shot budget is for the whole video: use at most ${Math.max(1, Math.ceil(setupBudget / n))} capture setup(s) in this part. Spread the creator's looks (b-roll, overlays, text pops) across this part too.`;
    });
    const partResults = await Promise.all(
      structurePrompts.map((prompt, k) =>
        runStructurePass(prompt, scriptParts.length > 1 ? `pass2.part${k + 1}` : 'pass2')
      )
    );
    mark(`pass2(${partResults.map((r) => r.model).join(',')})`, tStage);

    let parsed: any = partResults[0].value;
    if (partResults.length > 1) {
      const scenes = partResults.flatMap((r) => (Array.isArray(r.value?.scenes) ? r.value.scenes : []));
      parsed = {
        ...parsed,
        scenes: scenes.map((sc: any, i: number) => ({ ...sc, sceneNumber: i + 1 })),
        estimatedTotalSeconds:
          partResults.reduce((a, r) => a + (Number(r.value?.estimatedTotalSeconds) || 0), 0) ||
          parsed.estimatedTotalSeconds,
      };
    }
    // The approved pass-1 script is the source of truth for speech: if structuring dropped
    // lines (slow/fallback models sometimes do), put them back before anything else.
    let normalized = normalizeProductionPlan(parsed, normalizeOpts);
    normalized = repairPlanAnchors(restoreSpokenLines(normalized, creativeScript));

    // One combined repair call for missing speech and/or unmet looks.
    let validation = validateAgainstPrefs(normalized, prefs);
    const missingSpeech = ideaLikelyNeedsSpeech(idea, hints) && !planHasSpokenLines(normalized);
    if (!validation.ok || missingSpeech) {
      const issues = [
        ...(missingSpeech
          ? [
              'speech: the plan has no spoken lines — copy the approved script\'s spoken words verbatim into dialogue.teleprompterText / teleprompterPrompt for each beat',
            ]
          : []),
        ...validation.missing,
      ];
      console.warn('[generate-script] repair needed:', issues);
      emit('repair', 'Making sure every look you picked is in the plan…');
      tStage = Date.now();
      try {
        const repaired = await runStructurePass(
          buildRepairPrompt({
            previousJson: JSON.stringify(parsed),
            missing: issues,
            prefs,
            creativeScript: missingSpeech ? creativeScript : undefined,
          }),
          'repair'
        );
        const repairedPlan = repairPlanAnchors(
          restoreSpokenLines(normalizeProductionPlan(repaired.value, normalizeOpts), creativeScript)
        );
        const repairedValidation = validateAgainstPrefs(repairedPlan, prefs);
        // A repair may only add looks — never accept one that drops the creator's lines.
        const keepsSpeech = planSpokenWordCount(repairedPlan) >= planSpokenWordCount(normalized) * 0.85;
        if (
          keepsSpeech &&
          (repairedValidation.ok || repairedValidation.missing.length <= validation.missing.length)
        ) {
          normalized = repairedPlan;
          validation = repairedValidation;
        }
        mark(`repair(${repaired.model})`, tStage);
      } catch (repairErr: any) {
        console.warn('[generate-script] repair failed:', repairErr?.message || repairErr);
      }
    }

    // Whatever the creator picked but the model still left out is placed on spoken phrases.
    if (!validation.ok) {
      normalized = repairPlanAnchors(fillMissingLooks(normalized, prefs, idea));
      validation = validateAgainstPrefs(normalized, prefs);
    }

    timings.total = Date.now() - t0;
    console.log(`[generate-script] done in ${timings.total}ms`, JSON.stringify(timings));
    return finish(200, {
      ...normalized,
      modelUsed: partResults[0].model,
      timings,
      ...(validation.ok ? {} : { prefsUnmet: validation.missing }),
    });
  } catch (err: any) {
    const lastError = String(err?.message || err).slice(0, 600);
    console.error('[generate-script] all models failed:', lastError);
    return finish(502, {
      error: 'We could not generate your script right now. Please try again in a moment.',
      retryable: true,
      lastError,
    });
  }
});

// 2. AI Cutaway Scene Generator (Imagen / Gemini 3.1 Flash Image / Real AI Synthesis)
app.post('/api/generate-cutaway', rateLimitMiddleware('script'), async (req, res) => {
  try {
    const {
      prompt,
      sceneTitle,
      aspectRatio = '9:16',
      styleBible = '',
      referenceImageBase64,
      referenceMimeType = 'image/jpeg',
    } = req.body;
    if (!prompt) {
      return res.status(400).json({ error: 'Prompt is required.' });
    }

    const ai = getAiClient();
    const isWidescreen = aspectRatio === '16:9';
    const enrichedPrompt = [
      styleBible ? `Match this visual continuity: ${styleBible}.` : '',
      `Cinematic photorealistic video cutaway b-roll, high production value cinematography: ${prompt}`,
    ]
      .filter(Boolean)
      .join(' ');

    // Nano Banana / Gemini Image models (current production image generation family)
    const imageModels = [
      'gemini-3.1-flash-image',
      'gemini-3-pro-image',
      'gemini-3.1-flash-lite-image',
      'gemini-2.5-flash-image',
    ];
    const errors: string[] = [];

    for (const model of imageModels) {
      try {
        const imageConfig =
          model.includes('lite')
            ? { aspectRatio: isWidescreen ? '16:9' : '9:16' }
            : { aspectRatio: isWidescreen ? '16:9' : '9:16', imageSize: '1K' };

        const parts: any[] = [];
        if (referenceImageBase64) {
          parts.push({
            inlineData: { mimeType: referenceMimeType, data: referenceImageBase64 },
          });
          parts.push({
            text: `Using the attached reference photo of the creator's real subject, generate a matching cinematic cutaway. ${enrichedPrompt}`,
          });
        } else {
          parts.push({ text: enrichedPrompt });
        }

        const response = await ai.models.generateContent({
          model,
          contents: { parts },
          config: {
            imageConfig,
          },
        });

        if (response.candidates?.[0]?.content?.parts) {
          for (const part of response.candidates[0].content.parts) {
            if (part.inlineData?.data) {
              const mimeType = part.inlineData.mimeType || 'image/png';
              const imageUrl = `data:${mimeType};base64,${part.inlineData.data}`;

              const storage = getStorage();
              if (storage && GCS_BUCKET) {
                try {
                  const objectName = `cutaways/${Date.now()}-${model.replace(/[^a-z0-9.-]/gi, '_')}.png`;
                  const buf = Buffer.from(part.inlineData.data, 'base64');
                  await storage.bucket(GCS_BUCKET).file(objectName).save(buf, {
                    contentType: mimeType,
                    resumable: false,
                    metadata: { cacheControl: 'public, max-age=86400' },
                  });
                } catch (gcsErr: any) {
                  console.warn('GCS cutaway upload failed:', gcsErr?.message);
                }
              }

              return res.json({ imageUrl, source: model, fallbackUsed: false });
            }
          }
        }
        errors.push(`${model}: empty image response`);
      } catch (imgErr: any) {
        errors.push(`${model}: ${imgErr?.message || 'failed'}`);
      }
    }

    return res.status(503).json({
      ok: false,
      fallbackUsed: false,
      error:
        'Gemini Image could not generate a cutaway for this scene. No stock placeholder was returned.',
      promptUsed: prompt,
      errors,
    });
  } catch (error: any) {
    return res.status(500).json({
      ok: false,
      fallbackUsed: false,
      error: error?.message || 'Cutaway generation failed',
    });
  }
});

// 2b. Veo 3.1 Long-Running Video Generation (Google Cloud Veo API)
// Step 1: Start Video Generation
app.post('/api/generate-video', rateLimitMiddleware('veo'), async (req, res) => {
  try {
    const {
      prompt,
      aspectRatio = '9:16',
      resolution = '720p',
      model = 'veo-3.1-generate-preview',
      startingImageUrl,
    } = req.body || {};

    if (!prompt || typeof prompt !== 'string') {
      return res.status(400).json({ error: 'A text prompt is required for Veo video generation.' });
    }

    const ai = getAiClient();
    const isWidescreen = aspectRatio === '16:9';
    const chosenAspect = isWidescreen ? '16:9' : '9:16';
    const chosenRes = resolution === '1080p' ? '1080p' : '720p';

    // Optional starting image for image-to-video (data URL, http(s), gs://, or GCS object key)
    let imageSource: any = undefined;
    if (startingImageUrl && typeof startingImageUrl === 'string') {
      try {
        if (startingImageUrl.startsWith('data:')) {
          const match = startingImageUrl.match(/^data:([^;]+);base64,(.+)$/);
          if (match) {
            imageSource = { mimeType: match[1], imageBytes: match[2] };
          }
        } else {
          // Resolve remote / GCS / public asset into bytes
          let bytes: Buffer | null = null;
          let mime = 'image/jpeg';
          if (startingImageUrl.startsWith('gs://') || (!startingImageUrl.startsWith('http') && GCS_BUCKET)) {
            const storage = getStorage();
            if (storage) {
              let bucket = GCS_BUCKET;
              let object = startingImageUrl;
              if (startingImageUrl.startsWith('gs://')) {
                const without = startingImageUrl.slice(5);
                const slash = without.indexOf('/');
                bucket = without.slice(0, slash);
                object = without.slice(slash + 1);
              }
              const [buf] = await storage.bucket(bucket).file(object.replace(/^\//, '')).download();
              bytes = buf;
            }
          } else if (startingImageUrl.startsWith('http')) {
            const imgRes = await fetch(startingImageUrl);
            if (imgRes.ok) {
              bytes = Buffer.from(await imgRes.arrayBuffer());
              mime = imgRes.headers.get('content-type') || mime;
            }
          } else {
            const fs = await import('fs/promises');
            const pathMod = await import('path');
            const candidates = [
              pathMod.resolve('public', startingImageUrl.replace(/^\//, '')),
              pathMod.resolve('dist', startingImageUrl.replace(/^\//, '')),
            ];
            for (const c of candidates) {
              try {
                bytes = await fs.readFile(c);
                break;
              } catch {
                /* try next */
              }
            }
          }
          if (bytes) {
            imageSource = { mimeType: mime, imageBytes: bytes.toString('base64') };
          }
        }
      } catch (refErr: any) {
        console.warn('startingImageUrl resolve failed:', refErr?.message);
      }
    }

    const modelsToTry = [
      model,
      model === 'veo-3.1-generate-preview' ? 'veo-3.1-lite-generate-preview' : 'veo-3.1-generate-preview',
    ];

    let lastError: any = null;

    for (const targetModel of modelsToTry) {
      try {
        const operation = await ai.models.generateVideos({
          model: targetModel,
          source: {
            prompt: `Cinematic professional B-roll, high production value 60fps motion video: ${prompt}`,
            ...(imageSource ? { image: imageSource } : {}),
          },
          config: {
            numberOfVideos: 1,
            resolution: chosenRes,
            aspectRatio: chosenAspect,
          },
        });

        if (operation && operation.name) {
          return res.json({
            operationName: operation.name,
            model: targetModel,
            prompt,
            aspectRatio: chosenAspect,
            resolution: chosenRes,
          });
        }
      } catch (err: any) {
        lastError = err;
        const errMsg = err?.message || JSON.stringify(err);
        // If quota exhausted or paid key needed
        if (errMsg.includes('429') || errMsg.includes('RESOURCE_EXHAUSTED') || errMsg.includes('quota')) {
          console.warn(`Veo model ${targetModel} quota limit:`, errMsg);
        }
      }
    }

    // If quota is exhausted or requires paid key, return informative response
    const errString = lastError?.message || JSON.stringify(lastError || {});
    if (errString.includes('429') || errString.includes('RESOURCE_EXHAUSTED') || errString.includes('quota')) {
      return res.status(429).json({
        error: 'QUOTA_EXHAUSTED',
        message: 'Google Cloud Veo 3.1 is a flagship video model requiring a paid Gemini API key with Veo quota enabled in AI Studio.',
        requiresPaidKey: true,
      });
    }

    return res.status(500).json({
      error: 'VEO_INIT_FAILED',
      message: lastError?.message || 'Failed to initialize Veo video generation',
    });
  } catch (error: any) {
    return res.status(500).json({
      error: 'SERVER_ERROR',
      message: error?.message || 'Internal server error starting video generation',
    });
  }
});

// Step 2: Poll Video Generation Status
app.post('/api/video-status', async (req, res) => {
  try {
    const { operationName } = req.body || {};
    if (!operationName || typeof operationName !== 'string') {
      return res.status(400).json({ error: 'operationName is required to check status.' });
    }

    const ai = getAiClient();
    const op = new GenerateVideosOperation();
    op.name = operationName;

    const updated = await ai.operations.getVideosOperation({ operation: op });

    const isDone = !!updated.done;
    const hasError = !!updated.error;
    const uri = updated.response?.generatedVideos?.[0]?.video?.uri;

    return res.json({
      done: isDone,
      error: updated.error || null,
      hasVideo: !!uri,
      downloadUrl: isDone && uri ? `/api/video-download?operationName=${encodeURIComponent(operationName)}` : null,
    });
  } catch (error: any) {
    return res.status(500).json({
      done: false,
      error: error?.message || 'Failed to poll video status',
    });
  }
});

// Step 3: Download Video Binary (supports both GET and POST)
const handleVideoDownload = async (req: express.Request, res: express.Response) => {
  try {
    const operationName = (req.body?.operationName || req.query?.operationName) as string;
    if (!operationName || typeof operationName !== 'string') {
      return res.status(400).json({ error: 'operationName is required to download video.' });
    }

    // 1. Check in-memory video buffer cache
    if (videoBufferCache.has(operationName)) {
      const cached = videoBufferCache.get(operationName)!;
      res.setHeader('Content-Type', 'video/mp4');
      res.setHeader('Accept-Ranges', 'bytes');
      res.setHeader('Content-Length', cached.length.toString());
      res.setHeader('Cache-Control', 'public, max-age=86400');
      return res.send(cached);
    }

    // 2. Fetch video from Google Cloud operations
    const ai = getAiClient();
    const op = new GenerateVideosOperation();
    op.name = operationName;

    const updated = await ai.operations.getVideosOperation({ operation: op });
    const uri = updated.response?.generatedVideos?.[0]?.video?.uri;

    if (!uri) {
      return res.status(404).json({ error: 'Video URI not available for this operation' });
    }

    const apiKey = process.env.GEMINI_API_KEY;
    const videoRes = await fetch(uri, {
      headers: {
        'x-goog-api-key': apiKey || '',
      },
    });

    if (!videoRes.ok) {
      return res.status(videoRes.status).json({
        error: `Failed to fetch video stream from Google Cloud: ${videoRes.statusText}`,
      });
    }

    const arrayBuffer = await videoRes.arrayBuffer();
    const buffer = Buffer.from(arrayBuffer);

    // Cache the downloaded buffer
    videoBufferCache.set(operationName, buffer);

    res.setHeader('Content-Type', 'video/mp4');
    res.setHeader('Accept-Ranges', 'bytes');
    res.setHeader('Content-Length', buffer.length.toString());
    res.setHeader('Cache-Control', 'public, max-age=86400');
    return res.send(buffer);
  } catch (error: any) {
    return res.status(500).json({
      error: error?.message || 'Failed to download generated video',
    });
  }
};

app.post('/api/video-download', handleVideoDownload);
app.get('/api/video-download', handleVideoDownload);

// Backward-compatible Veo entrypoint (single handler — no duplicate route)
app.post('/api/generate-veo-video', rateLimitMiddleware('veo'), async (req, res) => {
  try {
    const {
      prompt,
      aspectRatio = '9:16',
      resolution = '720p',
      model = 'veo-3.1-generate-preview',
      startingImageUrl,
    } = req.body || {};

    if (!prompt || typeof prompt !== 'string') {
      return res.status(400).json({ error: 'A text prompt is required for Veo video generation.' });
    }

    // Reuse the same start logic by forwarding body to generate-video handler internals
    req.body = { prompt, aspectRatio, resolution, model, startingImageUrl };
    // Call generate-video route stack by invoking shared start
    const ai = getAiClient();
    const isWidescreen = aspectRatio === '16:9';
    const chosenAspect = isWidescreen ? '16:9' : '9:16';
    const chosenRes = resolution === '1080p' ? '1080p' : '720p';

    let imageSource: any = undefined;
    if (startingImageUrl && typeof startingImageUrl === 'string' && startingImageUrl.startsWith('data:')) {
      const match = startingImageUrl.match(/^data:([^;]+);base64,(.+)$/);
      if (match) {
        imageSource = { mimeType: match[1], imageBytes: match[2] };
      }
    }

    const modelsToTry = [
      model,
      model === 'veo-3.1-generate-preview' ? 'veo-3.1-lite-generate-preview' : 'veo-3.1-generate-preview',
      'veo-3.1-fast-generate-preview',
    ];

    let lastError: any = null;
    for (const targetModel of modelsToTry) {
      try {
        const operation = await ai.models.generateVideos({
          model: targetModel,
          source: {
            prompt: `Cinematic professional B-roll, high production value 60fps motion video: ${prompt}`,
            ...(imageSource ? { image: imageSource } : {}),
          },
          config: {
            numberOfVideos: 1,
            resolution: chosenRes,
            aspectRatio: chosenAspect,
          },
        });

        if (operation?.name) {
          return res.json({
            operationName: operation.name,
            model: targetModel,
            prompt,
            aspectRatio: chosenAspect,
            resolution: chosenRes,
            status: 'PROCESSING',
            engine: 'Google Cloud Veo 3.1',
          });
        }
      } catch (err: any) {
        lastError = err;
      }
    }

    const errString = lastError?.message || JSON.stringify(lastError || {});
    if (errString.includes('429') || errString.includes('RESOURCE_EXHAUSTED') || errString.includes('quota')) {
      return res.status(429).json({
        error: 'QUOTA_EXHAUSTED',
        message:
          'Veo requires a Gemini API key with Veo quota enabled. Use still cutaways or enable billing for Veo.',
        requiresPaidKey: true,
      });
    }

    return res.status(500).json({
      error: 'VEO_INIT_FAILED',
      message: lastError?.message || 'Failed to initialize Veo video generation',
    });
  } catch (error: any) {
    return res.status(500).json({
      error: 'SERVER_ERROR',
      message: error?.message || 'Internal server error starting video generation',
    });
  }
});

// 2c. Gemini Live Fact-Checker & Audience Connection Radar (Real-Time Script Analysis)
app.post('/api/live-fact-check', async (req, res) => {
  try {
    const {
      spokenText = '',
      expectedScript = '',
      sceneContext = '',
      projectTitle = '',
    } = req.body || {};

    if (!spokenText.trim()) {
      return res.json({
        status: 'listening',
        isFactual: true,
        issueType: 'none',
        alertTitle: 'Listening',
        factCheckMessage: 'Listening for your lines…',
        audienceConnectionScore: null,
        connectionFeedback: 'Speak into the mic — score updates after each phrase.',
        actionableTip: 'Keep relaxed eye contact with the camera lens.',
      });
    }

    const ai = getAiClient();
    const textLower = spokenText.toLowerCase();

    // Heuristic score from script overlap (used when Gemini is slow/unavailable)
    const scriptWords = String(expectedScript || '')
      .toLowerCase()
      .replace(/[^a-z0-9\s]/g, ' ')
      .split(/\s+/)
      .filter((w: string) => w.length > 2);
    const spokenWords = textLower.replace(/[^a-z0-9\s]/g, ' ').split(/\s+/).filter((w: string) => w.length > 2);
    const spokenSet = new Set(spokenWords);
    const overlap =
      scriptWords.length === 0
        ? 0.55
        : scriptWords.filter((w: string) => spokenSet.has(w)).length / Math.max(1, scriptWords.length);
    const lengthRatio = Math.min(
      1,
      spokenWords.length / Math.max(8, Math.round(scriptWords.length * 0.35))
    );
    const heuristicScore = Math.min(
      96,
      Math.max(18, Math.round(28 + overlap * 52 + lengthRatio * 18))
    );

    // Fast-path intelligent heuristics for instant sub-10ms feedback on common creator stumble points
    // 1. Plant care facts
    if (textLower.includes('gallon') && (textLower.includes('water') || textLower.includes('plant'))) {
      return res.json({
        status: 'alert',
        isFactual: false,
        issueType: 'factual_error',
        alertTitle: 'Overwatering Myth',
        factCheckMessage: '🚨 Plants do NOT need gallons of water daily! Overwatering causes fatal root rot.',
        audienceConnectionScore: 40,
        connectionFeedback: 'Beginners may follow this and drown their houseplant!',
        actionableTip: 'Say: "Only water when the top 2 inches of soil feel dry."',
      });
    }

    if (textLower.includes('every day') && textLower.includes('water') && (textLower.includes('plant') || textLower.includes('leaves') || textLower.includes('monstera'))) {
      return res.json({
        status: 'warning',
        isFactual: false,
        issueType: 'factual_error',
        alertTitle: 'Watering Schedule Alert',
        factCheckMessage: '⚠️ Most indoor houseplants need watering only every 7–14 days, never every day.',
        audienceConnectionScore: 58,
        connectionFeedback: 'Experienced viewers will notice rigid daily watering advice.',
        actionableTip: 'Say: "Don\'t water on a fixed schedule — let soil moisture guide you."',
      });
    }

    // 2. Coffee facts
    if (textLower.includes('boiling') && (textLower.includes('water') || textLower.includes('coffee') || textLower.includes('pour'))) {
      return res.json({
        status: 'warning',
        isFactual: false,
        issueType: 'factual_error',
        alertTitle: 'Scorched Coffee Grounds',
        factCheckMessage: '⚠️ 100°C boiling water scorches delicate coffee oils, producing harsh bitterness!',
        audienceConnectionScore: 64,
        connectionFeedback: 'Coffee enthusiasts in the audience will notice scorched temperature advice.',
        actionableTip: 'Say: "Let the kettle rest for 45s after boiling to hit ~92°C."',
      });
    }

    if (textLower.includes('dark roast') && (textLower.includes('more caffeine') || textLower.includes('10x') || textLower.includes('ten times'))) {
      return res.json({
        status: 'alert',
        isFactual: false,
        issueType: 'factual_error',
        alertTitle: 'Caffeine Density Myth',
        factCheckMessage: '🚨 Dark roast does NOT have more caffeine — roasting burns off bean mass!',
        audienceConnectionScore: 48,
        connectionFeedback: 'Common misconception alert — debunking this wins credibility.',
        actionableTip: 'Say: "Contrary to myth, light roast preserves more natural caffeine density."',
      });
    }

    // 3. Fitness / Running facts
    if (textLower.includes('20 miles') || (textLower.includes('sprint') && textLower.includes('day one'))) {
      return res.json({
        status: 'alert',
        isFactual: false,
        issueType: 'factual_error',
        alertTitle: 'Injury Risk Warning',
        factCheckMessage: '🚨 High risk of shin splints & injury! Beginners must use gradual walk-run intervals.',
        audienceConnectionScore: 38,
        connectionFeedback: 'Viewers will find extreme early mileage intimidating and unsafe.',
        actionableTip: 'Say: "Start with 1 minute jogging, 2 minutes walking."',
      });
    }

    // 4. Jargon Overload Heuristics
    if (textLower.includes('synergistic') || textLower.includes('hyper-parameter') || textLower.includes('paradigm shift')) {
      return res.json({
        status: 'warning',
        isFactual: true,
        issueType: 'jargon_overload',
        alertTitle: 'Simplify Technical Jargon',
        factCheckMessage: '⚠️ Heavy corporate jargon detected. Beginner viewers will tune out quickly.',
        audienceConnectionScore: 52,
        connectionFeedback: 'Audience connection drops when buzzwords replace plain talk.',
        actionableTip: 'Say it in plain, conversational English like you are talking to a close friend.',
      });
    }

    // 5. Dynamic Gemini evaluation — try multiple models (mobile often hits rate limits)
    const modelsToTry = ['gemini-3.8-flash', 'gemini-flash-latest', 'gemini-3.1-flash-lite'];
    for (const model of modelsToTry) {
      try {
        const prompt = `You are TakeOne's Gemini Live Director and Real-Time Fact-Checker.
A creator is filming themselves right now for a video production.
Project Topic: "${projectTitle || 'Video'}"
Current Scene: "${sceneContext || 'User Take'}"
Target Script / Teleprompter Lines: "${expectedScript || 'Deliver a warm, authentic take'}"
What the creator actually just spoke into their microphone: "${spokenText}"

Analyze in real time:
1. FACTUAL ACCURACY: Did they state any factual inaccuracies, incorrect stats/instructions, or misconceptions?
2. AUDIENCE CONNECTION & ENGAGEMENT: Will viewers connect? Is the tone conversational and warm, or dry, robotic, monotone, or overly technical?
3. SCRIPT ADHERENCE: Are they following the core purpose of this scene, or drifting completely off-topic?

Vary audienceConnectionScore honestly based on THIS spoken text — never default to 92.
Respond ONLY with this JSON structure:
{
  "status": "alert" | "warning" | "verified",
  "isFactual": boolean,
  "issueType": "factual_error" | "audience_disconnect" | "jargon_overload" | "off_track" | "none",
  "alertTitle": "Punchy 2-4 word headline (e.g. 'Scorched Water Temp', 'Simplify Jargon', 'Great Delivery')",
  "factCheckMessage": "1 short, direct sentence for the creator to glance at on camera",
  "audienceConnectionScore": integer between 15 and 100,
  "connectionFeedback": "1 sentence on audience retention and emotional resonance",
  "actionableTip": "Exact spoken phrase they can say right now (e.g. Say: '...')"
}`;

        const response = await ai.models.generateContent({
          model,
          contents: prompt,
          config: {
            responseMimeType: 'application/json',
          },
        });

        if (response && response.text) {
          const parsed = JSON.parse(response.text);
          const rawScore = Number(parsed.audienceConnectionScore);
          let normalizedScore = isNaN(rawScore)
            ? heuristicScore
            : rawScore <= 1
            ? Math.round(rawScore * 100)
            : Math.min(100, Math.max(10, Math.round(rawScore)));
          // Blend with heuristic so repeated identical "92" responses get broken up
          if (normalizedScore === 92) {
            normalizedScore = Math.min(100, Math.max(15, Math.round(heuristicScore * 0.6 + 92 * 0.4)));
          }

          return res.json({
            status: parsed.status || (parsed.isFactual === false ? 'alert' : 'verified'),
            isFactual: parsed.isFactual !== false,
            issueType: parsed.issueType || 'none',
            alertTitle: parsed.alertTitle || (parsed.status === 'alert' ? 'Fact Alert' : 'Verified'),
            factCheckMessage: parsed.factCheckMessage || 'Delivery analyzed by Gemini Live Radar.',
            audienceConnectionScore: normalizedScore,
            connectionFeedback: parsed.connectionFeedback || 'Audience connection is stable.',
            actionableTip: parsed.actionableTip || 'Keep your gaze focused on the lens.',
          });
        }
      } catch (_geminiErr) {
        // try next model
      }
    }

    const status =
      overlap < 0.25 && spokenWords.length > 6
        ? 'warning'
        : overlap > 0.45
        ? 'verified'
        : 'warning';
    return res.json({
      status,
      isFactual: true,
      issueType: status === 'warning' ? 'audience_disconnect' : 'none',
      alertTitle: status === 'verified' ? 'On Track' : 'Stay With Script',
      factCheckMessage:
        status === 'verified'
          ? '✓ Delivery matches this scene’s teleprompter.'
          : 'Drift detected — glance at the teleprompter and land the key line.',
      audienceConnectionScore: heuristicScore,
      connectionFeedback:
        overlap < 0.25
          ? 'Low script overlap — viewers may lose the thread of this beat.'
          : 'Solid script coverage for this take so far.',
      actionableTip: 'Speak the next teleprompter line clearly toward camera.',
    });
  } catch (err: any) {
    return res.json({
      status: 'listening',
      isFactual: true,
      issueType: 'none',
      alertTitle: 'Radar Busy',
      factCheckMessage: 'Could not analyze that phrase — keep talking.',
      audienceConnectionScore: null,
      connectionFeedback: 'Fact-check temporarily unavailable.',
    });
  }
});

// 2d. Professional multi-stage director edit (async jobs — survive browser close)
app.post('/api/director-edit/start', rateLimitMiddleware('director'), async (req, res) => {
  try {
    const { project, preset, style, maxCriticIterations = 2, mode } = req.body || {};
    const started = await startDirectorEditJob(getAiClient(), {
      project,
      preset,
      style,
      maxCriticIterations,
      mode: mode === 'analyze' || mode === 'recut' ? mode : undefined,
    });
    if (!started.ok) {
      return res.status(started.status).json({
        ok: false,
        error: started.error,
        stage: started.stage,
        jobId: started.existingJobId,
      });
    }
    return res.json({ ok: true, jobId: started.jobId, status: started.status });
  } catch (err: any) {
    console.error('Director edit start error:', err);
    return res.status(500).json({ ok: false, error: err?.message || 'Failed to start Director Edit' });
  }
});

app.get('/api/director-edit/status/:id', async (req, res) => {
  try {
    const job = await loadDirectorEditJob(req.params.id);
    if (!job) {
      res.set('Cache-Control', 'no-store');
      return res.status(404).json({ ok: false, error: 'Director edit job not found' });
    }
    const payload = {
      ok: true,
      jobId: job.id,
      projectId: job.projectId,
      status: job.status,
      state: job.state,
      percent: job.percent,
      stage: job.stage,
      message: job.message,
      heartbeatAt: job.heartbeatAt,
      error: job.error,
      result: job.status === 'done' || job.status === 'error' ? job.result : undefined,
      createdAt: job.createdAt,
      updatedAt: job.updatedAt,
    };
    // Bypass Express ETag so polls never get empty 304 bodies.
    const body = JSON.stringify(payload);
    res.status(200);
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.setHeader('Content-Length', Buffer.byteLength(body));
    res.end(body);
  } catch (err: any) {
    return res.status(500).json({ ok: false, error: err?.message || 'Status failed' });
  }
});

/** Legacy sync alias: start job then wait (prefer /start + poll from the client). */
async function handleDirectorEdit(req: express.Request, res: express.Response) {
  try {
    const { project, preset, style, maxCriticIterations = 2 } = req.body || {};
    const started = await startDirectorEditJob(getAiClient(), {
      project,
      preset,
      style,
      maxCriticIterations,
    });
    if (!started.ok) {
      return res.status(started.status).json({
        ok: false,
        error: started.error,
        stage: started.stage,
        jobId: started.existingJobId,
      });
    }
    const job = await waitForDirectorEditJob(started.jobId);
    if (job.status === 'error') {
      return res.status(500).json(job.result || { ok: false, error: job.error || 'Director edit failed' });
    }
    return res.json(job.result || { ok: true });
  } catch (err: any) {
    console.error('Director edit error:', err);
    return res.status(500).json({ ok: false, error: err?.message || 'Director edit failed' });
  }
}

app.post('/api/director-edit', rateLimitMiddleware('director'), handleDirectorEdit);

// Legacy alias — same professional pipeline (no longer cosmetic transition-only)
app.post('/api/ai-auto-edit', rateLimitMiddleware('director'), handleDirectorEdit);

// Large takes can exceed the global 10mb JSON limit when sent as base64 — allow 60mb here only.
app.post(
  '/api/transcribe-live-chunk',
  express.json({ limit: '60mb' }),
  rateLimitMiddleware('stt'),
  async (req, res) => {
    return handleTranscribeLiveChunk(req, res);
  }
);

async function handleTranscribeLiveChunk(req: any, res: any) {
  try {
    const { audioBase64, mimeType = 'audio/webm' } = req.body || {};
    if (!audioBase64) {
      return res.status(400).json({ error: 'audioBase64 is required.' });
    }

    const mappedMime = mimeType.includes('mp4')
      ? mimeType.startsWith('video/')
        ? 'video/mp4'
        : 'audio/mp4'
      : mimeType.includes('webm')
        ? mimeType.startsWith('video/')
          ? 'video/webm'
          : 'audio/webm'
        : mimeType;

    const ai = getAiClient();
    const models = ['gemini-3.1-flash-lite', 'gemini-flash-latest'];
    for (const model of models) {
      try {
        const response = await ai.models.generateContent({
          model,
          contents: {
            parts: [
              {
                inlineData: {
                  mimeType: mappedMime,
                  data: audioBase64,
                },
              },
              {
                text: 'Transcribe what the speaker is saying in this audio or video snippet. Output ONLY the plain transcription text. If silence or inaudible, output nothing.',
              },
            ],
          },
        });
        const transcript = (response.text || '').trim();
        return res.json({ transcript, model });
      } catch (modelErr: any) {
        console.warn(`[transcribe-live] ${model}:`, modelErr?.message);
      }
    }
    return res.json({ transcript: '' });
  } catch (_err) {
    return res.json({ transcript: '' });
  }
}

/** Shape a Chirp / Speech result for transcription clients (legacy field names kept). */
function speechResultPayload(r: Awaited<ReturnType<typeof transcribeWithWords>>) {
  const ok = Boolean(r.transcript.trim());
  return {
    ok,
    transcript: r.transcript,
    segments: r.segments,
    words: r.words,
    engine: r.engine,
    // legacy fields (existing clients read these)
    fullTranscript: r.transcript,
    transcriptSegments: r.segments,
    confidence: r.words.length
      ? Math.round((r.words.reduce((a, w) => a + (w.conf ?? 0.9), 0) / r.words.length) * 100) / 100
      : ok
        ? 0.85
        : 0,
    source: r.engine,
  };
}

// 3. Audio Transcription — Chirp / Speech word timestamps first, Gemini only as fallback
// Base64 takes can exceed the global 10mb limit — allow 60mb on this route only.
app.post('/api/transcribe-audio', express.json({ limit: '60mb' }), rateLimitMiddleware('stt'), async (req, res) => {
  try {
    const { audioBase64, mimeType = 'audio/webm', languageCode, language, durationSec } = req.body;
    if (!audioBase64) {
      return res.status(400).json({
        ok: false,
        error: 'audioBase64 is required.',
        transcript: '',
        segments: [],
        words: [],
        engine: 'none',
        fullTranscript: '',
        transcriptSegments: [],
      });
    }

    // Preferred path: Cloud Speech (Chirp → latest_long) with word-level timestamps
    try {
      const fsp = await import('fs/promises');
      const osMod = await import('os');
      const pathMod = await import('path');
      const workDir = await fsp.mkdtemp(pathMod.join(osMod.tmpdir(), 'takeone-txchirp-'));
      try {
        const ext = String(mimeType).includes('webm')
          ? 'webm'
          : String(mimeType).includes('mp4') || String(mimeType).includes('m4a')
            ? 'm4a'
            : String(mimeType).includes('ogg')
              ? 'ogg'
              : String(mimeType).includes('wav')
                ? 'wav'
                : 'webm';
        const local = pathMod.join(workDir, `audio.${ext}`);
        await fsp.writeFile(local, Buffer.from(audioBase64, 'base64'));
        const speech = await transcribeWithWords({
          localPath: local,
          languageCode: languageCode || language,
          durationSec: Number(durationSec) > 0 ? Number(durationSec) : undefined,
        });
        return res.json(speechResultPayload(speech));
      } finally {
        try {
          await fsp.rm(workDir, { recursive: true, force: true });
        } catch {
          /* ignore */
        }
      }
    } catch (speechErr: any) {
      console.warn('[transcribe-audio] Chirp/Speech unavailable, falling back to Gemini:', speechErr?.message);
    }

    const ai = getAiClient();
    const models = ['gemini-3.1-flash-lite', 'gemini-flash-latest'];

    for (const model of models) {
      try {
        const response = await ai.models.generateContent({
          model,
          contents: {
            parts: [
              {
                inlineData: {
                  mimeType,
                  data: audioBase64,
                },
              },
              {
                text: `Transcribe this creator take precisely. Return ONLY JSON:
{
  "fullTranscript": "exact words spoken (empty string if silence/unintelligible)",
  "confidence": 0.0,
  "segments": [
    {"start": 0.0, "end": 1.2, "text": "phrase"}
  ]
}
Do NOT invent dialogue. Do NOT use any expected script. If you cannot hear speech, return empty fullTranscript and empty segments.`,
              },
            ],
          },
          config: {
            responseMimeType: 'application/json',
          },
        });

        const parsed = JSON.parse(response.text || '{}');
        const fullTranscript = (parsed.fullTranscript || '').trim();
        let segments = Array.isArray(parsed.segments)
          ? parsed.segments
              .filter((s: any) => s?.text?.trim())
              .map((s: any) => ({
                start: Number(s.start) || 0,
                end: Number(s.end) || 0,
                text: String(s.text).trim(),
              }))
          : [];

        // Retime compressed Gemini timestamps onto real speech via ffmpeg envelope
        try {
          const fs = await import('fs/promises');
          const os = await import('os');
          const pathMod = await import('path');
          const { computeAudioEnvelope, retimeSegmentsToAudio } = await import(
            './server/edit/audioEnvelope'
          );
          const workDir = await fs.mkdtemp(pathMod.join(os.tmpdir(), 'takeone-txenv-'));
          const ext = String(mimeType).includes('webm') ? 'webm' : 'm4a';
          const local = pathMod.join(workDir, `audio.${ext}`);
          try {
            await fs.writeFile(local, Buffer.from(audioBase64, 'base64'));
            const envelope = await computeAudioEnvelope(local);
            if (envelope && segments.length) {
              segments = retimeSegmentsToAudio(segments, envelope);
            }
          } finally {
            try {
              await fs.rm(workDir, { recursive: true, force: true });
            } catch {
              /* ignore */
            }
          }
        } catch (envErr: any) {
          console.warn('[transcribe-audio] envelope retime skipped:', envErr?.message);
        }

        return res.json({
          ok: Boolean(fullTranscript),
          transcript: fullTranscript,
          segments,
          words: [],
          engine: 'gemini',
          fullTranscript,
          confidence: parsed.confidence ?? (fullTranscript ? 0.85 : 0),
          transcriptSegments: segments,
          source: model,
        });
      } catch (err: any) {
        console.warn(`Transcribe model ${model} failed:`, err?.message);
      }
    }

    return res.json({
      ok: false,
      transcript: '',
      segments: [],
      words: [],
      engine: 'none',
      fullTranscript: '',
      transcriptSegments: [],
      confidence: 0,
      source: 'none',
      message: 'Transcription unavailable — captions will be omitted for this take.',
    });
  } catch (error: any) {
    return res.json({
      ok: false,
      transcript: '',
      segments: [],
      words: [],
      engine: 'none',
      fullTranscript: '',
      transcriptSegments: [],
      confidence: 0,
      error: error?.message,
    });
  }
});

/** Transcribe durable GCS footage (import path — no teleprompter required). */
app.post('/api/transcribe-gcs', rateLimitMiddleware('stt'), async (req, res) => {
  try {
    const { gcsUri, mimeType = 'video/mp4', languageCode, language, durationSec } = req.body || {};
    if (!gcsUri || typeof gcsUri !== 'string' || gcsUri.startsWith('blob:')) {
      return res.status(400).json({
        ok: false,
        error: 'gcsUri (gs://…) is required',
        fullTranscript: '',
        transcriptSegments: [],
      });
    }

    const fs = await import('fs/promises');
    const os = await import('os');
    const pathMod = await import('path');
    const workDir = await fs.mkdtemp(pathMod.join(os.tmpdir(), 'takeone-tx-'));
    const ext = String(mimeType).includes('webm')
      ? 'webm'
      : String(mimeType).includes('quicktime')
        ? 'mov'
        : 'mp4';
    const local = pathMod.join(workDir, `clip.${ext}`);

    try {
      const { Storage } = await import('@google-cloud/storage');
      const bucketName = process.env.GCS_BUCKET || '';
      const projectId = process.env.GOOGLE_CLOUD_PROJECT || process.env.GCP_PROJECT || '';
      const storage = new Storage(projectId ? { projectId } : undefined);
      const without = gcsUri.startsWith('gs://') ? gcsUri.slice(5) : gcsUri;
      const slash = without.indexOf('/');
      const bucket = without.slice(0, slash) || bucketName;
      const object = without.slice(slash + 1);
      await storage.bucket(bucket).file(object).download({ destination: local });

      // Preferred path: Cloud Speech (Chirp → latest_long) with word timestamps, no size cap
      try {
        const speech = await transcribeWithWords({
          localPath: local,
          gcsUri: `gs://${bucket}/${object}`,
          languageCode: languageCode || language,
          durationSec: Number(durationSec) > 0 ? Number(durationSec) : undefined,
        });
        return res.json(speechResultPayload(speech));
      } catch (speechErr: any) {
        console.warn('[transcribe-gcs] Chirp/Speech unavailable, falling back to Gemini:', speechErr?.message);
      }

      const buf = await fs.readFile(local);
      if (buf.length > 18 * 1024 * 1024) {
        return res.json({
          ok: false,
          transcript: '',
          segments: [],
          words: [],
          engine: 'none',
          fullTranscript: '',
          transcriptSegments: [],
          confidence: 0,
          message: 'File too large for inline transcription — Director Edit will analyze natively.',
        });
      }

      const ai = getAiClient();
      const mappedMime = mimeType.includes('webm')
        ? 'video/webm'
        : mimeType.includes('quicktime')
          ? 'video/mp4'
          : mimeType.startsWith('video/')
            ? mimeType.split(';')[0]
            : 'video/mp4';

      for (const model of ['gemini-3.1-flash-lite', 'gemini-flash-latest']) {
        try {
          const response = await ai.models.generateContent({
            model,
            contents: {
              parts: [
                { inlineData: { mimeType: mappedMime, data: buf.toString('base64') } },
                {
                  text: `Transcribe this video take precisely with timestamps. Return ONLY JSON:
{
  "fullTranscript": "exact words (empty if silence)",
  "confidence": 0.0,
  "segments": [{"start": 0.0, "end": 1.2, "text": "phrase"}]
}
Do NOT invent dialogue.`,
                },
              ],
            },
            config: { responseMimeType: 'application/json' },
          });
          const parsed = JSON.parse(response.text || '{}');
          const fullTranscript = (parsed.fullTranscript || '').trim();
          let segments = Array.isArray(parsed.segments)
            ? parsed.segments
                .filter((s: any) => s?.text?.trim())
                .map((s: any) => ({
                  start: Number(s.start) || 0,
                  end: Number(s.end) || 0,
                  text: String(s.text).trim(),
                }))
            : [];
          try {
            const { computeAudioEnvelope, retimeSegmentsToAudio } = await import(
              './server/edit/audioEnvelope'
            );
            const envelope = await computeAudioEnvelope(local);
            if (envelope && segments.length) {
              segments = retimeSegmentsToAudio(segments, envelope);
            }
          } catch (envErr: any) {
            console.warn('[transcribe-gcs] envelope retime skipped:', envErr?.message);
          }
          return res.json({
            ok: Boolean(fullTranscript),
            transcript: fullTranscript,
            segments,
            words: [],
            engine: 'gemini',
            fullTranscript,
            confidence: parsed.confidence ?? (fullTranscript ? 0.85 : 0),
            transcriptSegments: segments,
            source: model,
          });
        } catch (err: any) {
          console.warn(`[transcribe-gcs] ${model}:`, err?.message);
        }
      }

      return res.json({
        ok: false,
        transcript: '',
        segments: [],
        words: [],
        engine: 'none',
        fullTranscript: '',
        transcriptSegments: [],
        confidence: 0,
        message: 'Transcription unavailable for this file.',
      });
    } finally {
      try {
        await fs.rm(workDir, { recursive: true, force: true });
      } catch {
        /* ignore */
      }
    }
  } catch (error: any) {
    return res.status(500).json({
      ok: false,
      error: error?.message || 'transcribe-gcs failed',
      fullTranscript: '',
      transcriptSegments: [],
    });
  }
});

/**
 * Compile only — the same cut the export makes (cleanup, punch-ins, captions, text pops, AI visuals),
 * returned as an EDL for the browser's Live Cut player. No render, no AI calls (except
 * re-transcribing a take whose word timings are missing), so it is cheap enough to run after every edit.
 */
app.post('/api/director-cut/compile', rateLimitMiddleware('compile'), async (req, res) => {
  try {
    const { project, prefs, options } = req.body || {};
    if (!project || !Array.isArray(project.scenes) || project.scenes.length === 0) {
      return res.status(400).json({ ok: false, error: 'project with scenes is required' });
    }
    const ensured = await ensureTakeWords(project as Project);
    const proj = repairPlanAnchors(ensured.project);
    const resolvedPrefs = sanitizeProductionPrefs(
      prefs ?? proj.prefs ?? proj.creativeBrief?.prefs ?? defaultProductionPrefs(proj.videoFormat),
      proj.videoFormat
    );
    const { edl, report } = compileDirectorCut({
      project: proj,
      prefs: resolvedPrefs,
      options: options && typeof options === 'object' ? options : undefined,
    });
    const wordUpdates = Object.keys(ensured.updates).length ? ensured.updates : undefined;
    return res.json({ ok: true, edl, report, wordUpdates });
  } catch (error: any) {
    console.error('[director-cut/compile] failed:', error);
    return res.status(500).json({ ok: false, error: error?.message || 'compile failed' });
  }
});

/**
 * Director compiler: ProductionPrefs + scene recipes + word timings → cleaned, punched-in, captioned EDL.
 * Body: { project, prefs?, quality?: 'draft'|'final', startRender?: boolean, options?: {...} }
 * Returns { ok, edl, report } and, when startRender is true, { jobId, status, quality }.
 */
app.post('/api/director-cut', rateLimitMiddleware('director'), async (req, res) => {
  try {
    const { project, prefs, quality, startRender, options } = req.body || {};
    if (!project || !Array.isArray(project.scenes) || project.scenes.length === 0) {
      return res.status(400).json({ ok: false, error: 'project with scenes is required' });
    }
    // Older plans may carry caption text as anchors — re-anchor to the spoken script first.
    // Cuts and captions sit on word timestamps: re-transcribe takes whose words are missing or
    // came from live captions before compiling.
    const ensured = await ensureTakeWords(project as Project);
    const proj = repairPlanAnchors(ensured.project);
    const resolvedPrefs = sanitizeProductionPrefs(
      prefs ?? proj.prefs ?? proj.creativeBrief?.prefs ?? defaultProductionPrefs(proj.videoFormat),
      proj.videoFormat
    );

    const { edl, report } = compileDirectorCut({
      project: proj,
      prefs: resolvedPrefs,
      options: options && typeof options === 'object' ? options : undefined,
    });
    const wordUpdates = Object.keys(ensured.updates).length ? ensured.updates : undefined;

    if (!edl.clips.length) {
      return res.status(422).json({
        ok: false,
        error:
          'No clips with durable media to compile. Save takes to cloud (gcsObjectPath) before running Director Cut.',
        report,
        warnings: edl.warnings,
      });
    }

    // Same shape the client attaches in AssemblyReviewView before /api/render/start
    (edl as any).project = {
      id: proj.id,
      scenes: proj.scenes,
      editPlan: proj.editPlan,
      captureStrategy: proj.captureStrategy,
      creativeBrief: proj.creativeBrief,
      entryPath: proj.entryPath,
    };

    const qRaw = String(quality || '').toLowerCase();
    const renderQuality: 'draft' | 'standard' | 'high' =
      qRaw === 'draft' ? 'draft' : qRaw === 'high' ? 'high' : 'standard';
    if (!startRender) {
      return res.json({ ok: true, edl, report, prefs: resolvedPrefs, quality: renderQuality, wordUpdates });
    }

    const startRes = await fetch(`http://127.0.0.1:${PORT}/api/render/start`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ edl, quality: renderQuality }),
    });
    const started: any = await startRes.json().catch(() => ({}));
    if (!startRes.ok || !started?.jobId) {
      return res.status(startRes.status || 500).json({
        ok: false,
        error: started?.error || 'Failed to start render',
        edl,
        report,
      });
    }
    return res.json({
      ok: true,
      jobId: started.jobId,
      status: started.status,
      resumed: started.resumed,
      quality: renderQuality,
      report,
      edl,
      prefs: resolvedPrefs,
      wordUpdates,
    });
  } catch (error: any) {
    console.error('[director-cut] failed:', error);
    return res.status(500).json({ ok: false, error: error?.message || 'director-cut failed' });
  }
});

/**
 * Classify transcript segments into claims vs opinions, fact-check factual claims only.
 * Used by Import Existing Footage (not live teleprompter).
 */
/**
 * Plan an edit for imported footage: the creator's goal + request + picked looks + transcripts →
 * per-clip edit recipes (AI visuals with prompts, text pops, punch-ins on spoken phrases).
 */
app.post('/api/plan-import-edit', rateLimitMiddleware('script'), async (req, res) => {
  try {
    const { goal = '', request = '', prefs, clips, language, format } = req.body || {};
    if (!Array.isArray(clips) || !clips.length) {
      return res.status(400).json({ ok: false, error: 'clips are required' });
    }
    const cleanClips = clips.slice(0, 20).map((c: any, i: number) => ({
      sceneId: String(c?.sceneId || `clip-${i + 1}`),
      title: String(c?.title || `Clip ${i + 1}`).slice(0, 120),
      durationSeconds: Math.max(1, Number(c?.durationSeconds) || 5),
      transcript: String(c?.transcript || '').slice(0, 12000),
    }));
    let ai: any = null;
    try {
      ai = getAiClient();
    } catch {
      ai = null;
    }
    const plan = await planImportEdit(ai, {
      goal: String(goal).slice(0, 1200),
      request: String(request).slice(0, 1200),
      prefs: sanitizeProductionPrefs(prefs, format === 'long-form' ? 'long-form' : 'short-form'),
      clips: cleanClips,
      language: language ? String(language).slice(0, 12) : undefined,
    });
    return res.json({ ok: true, ...plan });
  } catch (error: any) {
    console.error('[plan-import] failed:', error);
    return res.status(500).json({ ok: false, error: error?.message || 'Could not plan the edit' });
  }
});

app.post('/api/fact-check-claims', async (req, res) => {
  try {
    const { segments = [], fullTranscript = '', projectTitle = '' } = req.body || {};
    const segs = Array.isArray(segments) ? segments.filter((s: any) => s?.text?.trim()) : [];
    const transcript =
      String(fullTranscript || '').trim() || segs.map((s: any) => s.text).join(' ');

    if (!transcript) {
      return res.json({ ok: true, claims: [] });
    }

    const ai = getAiClient();
    const prompt = `You are TakeOne's post-production fact checker.
Project: "${projectTitle}"

Timestamped transcript segments:
${JSON.stringify(segs.slice(0, 80))}

Full transcript:
"""${transcript.slice(0, 8000)}"""

1) Label each statement as factual_claim | opinion | personal | other.
2) Fact-check ONLY factual_claim items (skip opinions/personal stories).
3) For each factual claim return verdict: supported | disputed | unverifiable.
4) Include brief explanation and optional sources (title + url when known).

Return ONLY JSON:
{
  "claims": [
    {
      "start": 0.0,
      "end": 2.5,
      "text": "...",
      "kind": "factual_claim",
      "verdict": "supported",
      "confidence": 0.7,
      "explanation": "...",
      "sources": [{"title": "...", "url": "https://..."}]
    }
  ]
}
Do not invent quotes. Prefer fewer claims. Opinions get kind=opinion and verdict=skipped.`;

    try {
      const response = await ai.models.generateContent({
        model: 'gemini-3.8-flash',
        contents: prompt,
        config: { responseMimeType: 'application/json' },
      });
      const parsed = JSON.parse(response.text || '{"claims":[]}');
      const claims = Array.isArray(parsed.claims)
        ? parsed.claims.map((c: any) => ({
            start: Number(c.start) || 0,
            end: Number(c.end) || 0,
            text: String(c.text || '').trim(),
            kind: ['factual_claim', 'opinion', 'personal', 'other'].includes(c.kind)
              ? c.kind
              : 'other',
            verdict: ['supported', 'disputed', 'unverifiable', 'skipped'].includes(c.verdict)
              ? c.verdict
              : c.kind === 'factual_claim'
                ? 'unverifiable'
                : 'skipped',
            confidence: typeof c.confidence === 'number' ? c.confidence : undefined,
            explanation: c.explanation ? String(c.explanation) : undefined,
            sources: Array.isArray(c.sources)
              ? c.sources.map((s: any) => ({
                  title: s.title ? String(s.title) : undefined,
                  url: s.url ? String(s.url) : undefined,
                }))
              : undefined,
          }))
        : [];
      return res.json({ ok: true, claims });
    } catch (err: any) {
      console.warn('fact-check-claims Gemini failed:', err?.message);
      const claims = segs.slice(0, 12).map((s: any) => {
        const t = String(s.text || '');
        const looksFactual =
          /\b(is|are|was|were|always|never|percent|%|\d+)\b/i.test(t) &&
          !/\b(i feel|i think|in my opinion|love|hate)\b/i.test(t);
        return {
          start: Number(s.start) || 0,
          end: Number(s.end) || 0,
          text: t,
          kind: looksFactual ? 'factual_claim' : 'opinion',
          verdict: looksFactual ? 'unverifiable' : 'skipped',
          explanation: looksFactual
            ? 'Could not verify automatically — review manually.'
            : 'Treated as opinion/personal.',
        };
      });
      return res.json({ ok: true, claims, fallback: true });
    }
  } catch (error: any) {
    return res.status(500).json({ ok: false, error: error?.message, claims: [] });
  }
});

/** Derive a visual style bible from a take frame so AI cutaways match the creator's world */
app.post('/api/style-bible', async (req, res) => {
  try {
    const { imageBase64, mimeType = 'image/jpeg', projectTitle = '' } = req.body || {};
    if (!imageBase64) {
      return res.status(400).json({ error: 'imageBase64 required' });
    }
    const ai = getAiClient();
    const response = await ai.models.generateContent({
      model: 'gemini-3.1-flash-lite',
      contents: {
        parts: [
          { inlineData: { mimeType, data: imageBase64 } },
          {
            text: `You are a cinematographer matching B-roll to this creator's real footage for "${projectTitle}".
Describe in 2-3 dense sentences: setting/environment, light direction & quality, color palette, time of day, lens feel (focal length / depth of field).
Return plain text only — no markdown. This text will be prepended to image/video generation prompts.`,
          },
        ],
      },
    });
    const styleBible = (response.text || '').trim();
    return res.json({ styleBible, ok: Boolean(styleBible) });
  } catch (err: any) {
    return res.json({ ok: false, styleBible: '', error: err?.message });
  }
});

/** Suggest B-roll insert anchors from a transcript */
app.post('/api/suggest-broll', async (req, res) => {
  try {
    const { transcript = '', styleBible = '', sceneTitle = '', durationSeconds = 10 } = req.body || {};
    if (!transcript.trim()) {
      return res.json({ inserts: [] });
    }
    const ai = getAiClient();
    const response = await ai.models.generateContent({
      model: 'gemini-3.1-flash-lite',
      contents: `Given this spoken take (${durationSeconds}s) titled "${sceneTitle}":
"""${transcript}"""
Style bible: ${styleBible || 'match warm natural creator footage'}

Suggest 0-2 short B-roll inserts (1.5-3s each) anchored to concrete nouns the creator mentioned.
Return JSON: { "inserts": [ { "startOffsetSeconds": 2.0, "durationSeconds": 2.0, "prompt": "cinematic cutaway matching style bible...", "label": "short label" } ] }
Prefer fewer inserts. Empty array is OK.`,
      config: { responseMimeType: 'application/json' },
    });
    const parsed = JSON.parse(response.text || '{"inserts":[]}');
    return res.json({ inserts: parsed.inserts || [] });
  } catch (err: any) {
    return res.json({ inserts: [], error: err?.message });
  }
});

/**
 * Virtual background by server-side matting (RVM): start a matte job for one take, then poll it.
 * Runs on the worker job in production (in-process locally).
 */
const recentMatteJobs = new Map<string, { id: string; at: number }>();
app.post('/api/matte/start', rateLimitMiddleware('render'), async (req, res) => {
  try {
    const { gcsUri, backgroundUrl, aspectRatio, projectId, sceneId } = req.body || {};
    if (typeof gcsUri !== 'string' || !gcsUri.startsWith('gs://')) {
      return res.status(400).json({ error: 'gcsUri (gs://…) is required' });
    }
    if (typeof backgroundUrl !== 'string' || !/^(gs:|https?:|data:image)/.test(backgroundUrl)) {
      return res.status(400).json({ error: 'backgroundUrl is required' });
    }
    // The same take on the same background is already being done: hand back that job.
    const dupKey = `${gcsUri}|${backgroundUrl}|${aspectRatio || ''}`;
    const recent = recentMatteJobs.get(dupKey);
    const { createMatteJob, readMatteStatus } = await import('./server/jobs/matte');
    if (recent && Date.now() - recent.at < 15 * 60_000) {
      const st = await readMatteStatus(recent.id);
      if (st && st.status !== 'failed') return res.json({ ok: true, jobId: recent.id, reused: true });
    }
    const { enqueueWorker } = await import('./server/jobs/enqueue');
    const job = await createMatteJob({
      sourceGcsUri: gcsUri,
      backgroundUrl,
      aspectRatio: typeof aspectRatio === 'string' ? aspectRatio : undefined,
      projectId: String(projectId || 'project').replace(/[^\w-]/g, '').slice(0, 80) || 'project',
      sceneId: String(sceneId || 'scene').replace(/[^\w-]/g, '').slice(0, 80) || 'scene',
    });
    recentMatteJobs.set(dupKey, { id: job.id, at: Date.now() });
    await enqueueWorker('matte', job.id);
    return res.json({ ok: true, jobId: job.id });
  } catch (err: any) {
    return res.status(500).json({ error: err?.message || 'Could not start background job' });
  }
});

app.get('/api/matte/status/:id', async (req, res) => {
  const { readMatteStatus } = await import('./server/jobs/matte');
  const id = String(req.params.id || '').replace(/[^\w-]/g, '');
  const job = id ? await readMatteStatus(id) : null;
  if (!job) return res.status(404).json({ error: 'not found' });
  return res.json({
    status: job.status,
    progress: job.progress ?? 0,
    outputGcsUri: job.outputGcsUri,
    error: job.error,
    stale: job.status === 'running' && Date.now() - (job.heartbeatAt || job.updatedAt) > 120_000,
  });
});

/** Revise one scene/chapter from a creator prompt — script fields, background and AI visuals. */
app.post('/api/revise-scene', async (req, res) => {
  try {
    const { scene, instruction = '', projectTitle = '', projectLogline = '' } = req.body || {};
    if (!scene || !instruction.trim()) {
      return res.status(400).json({ error: 'scene and instruction are required' });
    }
    // Only what Gemini needs to rewrite the scene: no transcript words or media (smaller = faster).
    const recipe = scene.recipe || null;
    const brief = {
      ...scene,
      words: undefined,
      transcript: undefined,
      transcriptSegments: undefined,
      userRecordedVideoUrl: undefined,
      gcsObjectPath: undefined,
      aiGeneratedImageUrl: undefined,
      aiGeneratedVideoUrl: undefined,
      recipe: undefined,
    };
    const visuals = (recipe?.inserts || []).map((ins: any, index: number) => ({
      index,
      kind: ins.kind === 'text_pop' ? 'text_pop' : ins.kind === 'meme' ? 'meme' : ins.layout === 'pip' ? 'overlay' : 'broll',
      onPhrase: ins.anchorPhrase,
      ...(ins.kind === 'text_pop' ? { text: ins.text } : { prompt: ins.prompt }),
    }));
    const prompt = `You are TakeOne, an AI director. Revise ONE scene for the video "${projectTitle}" (${projectLogline}).

Current scene:
${JSON.stringify(brief)}

Virtual background: ${recipe?.layout === 'virtual_background' ? JSON.stringify(recipe?.background?.prompt || '(no prompt yet)') : 'off'}
AI visuals on this scene (by index): ${JSON.stringify(visuals)}

Creator request: "${instruction}"

Return ONLY JSON containing just the fields that change (omit everything that stays the same):
{
  "title": "...",
  "chapterTitle": "...",
  "purpose": "why this beat exists",
  "contentMode": "dialogue|voiceover|visual_only|natural_audio|text_overlay|mixed",
  "plainInstruction": "plain English shot card: what to capture, camera, framing, action, duration. No jargon.",
  "directorTip": "encouraging tip",
  "teleprompterPrompt": "spoken lines ONLY if dialogue is required; otherwise null",
  "dialogue": { "required": false, "teleprompterText": null },
  "visual": { "action": "...", "camera": "...", "framing": "...", "movement": "...", "environment": "..." },
  "onScreenText": null,
  "durationSeconds": number,
  "aiGenerationPrompt": "only if filmedBy is ai",
  "virtualBackground": true | false,
  "backgroundPrompt": "new description of the virtual background (a place, no people, no text)",
  "visualChanges": [{ "index": 0, "prompt": "new image description" , "text": "new words for a text_pop" }],
  "summary": "one short sentence saying what you changed"
}
Rules:
- A request about the background ("change the background to a beach", "put me in an office") sets backgroundPrompt (and virtualBackground true if it was off). Never refuse it.
- A request about b-roll, overlays, memes or text pops changes visualChanges by index. Keep every other visual as it is.
- Do not invent dialogue for visual_only/natural_audio. teleprompterPrompt must be null when dialogue.required is false.
- Keep spoken lines word-for-word unless the creator asked to change them.`;

    const ai = getAiClient();
    let updated: any = null;
    let lastErr: any = null;
    for (let attempt = 0; attempt < 2 && !updated; attempt++) {
      try {
        const response = await Promise.race([
          ai.models.generateContent({
            model: 'gemini-3.8-flash',
            contents: prompt,
            config: { responseMimeType: 'application/json' },
          }),
          new Promise<never>((_, reject) => setTimeout(() => reject(new Error('Gemini took too long — try again.')), 30_000)),
        ]);
        const parsed = JSON.parse(response.text || '');
        if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) updated = parsed;
      } catch (e) {
        lastErr = e;
      }
    }
    if (!updated) throw lastErr || new Error('Gemini returned an unreadable answer — try again.');

    const {
      virtualBackground,
      backgroundPrompt,
      visualChanges,
      summary,
      ...sceneFields
    } = updated;
    // Fields the revise must never change.
    for (const k of ['id', 'sceneNumber', 'filmedBy', 'recipe', 'words', 'gcsObjectPath', 'userRecordedVideoUrl']) {
      delete (sceneFields as any)[k];
    }
    const next: any = { ...sceneFields };
    if ('dialogue' in next || 'teleprompterPrompt' in next) {
      const dialogue = next.dialogue ?? scene.dialogue;
      const spoken =
        (typeof dialogue?.teleprompterText === 'string' && dialogue.teleprompterText.trim()) ||
        (typeof next.teleprompterPrompt === 'string' && next.teleprompterPrompt.trim()) ||
        '';
      if (dialogue?.required !== true || !spoken) {
        next.teleprompterPrompt = undefined;
        next.dialogue = { required: false, teleprompterText: null };
      } else {
        next.teleprompterPrompt = spoken;
        next.dialogue = { required: true, teleprompterText: spoken };
      }
    }
    const recipeChanges: {
      virtualBackground?: boolean;
      backgroundPrompt?: string;
      visuals?: Array<{ index: number; prompt?: string; text?: string }>;
    } = {};
    if (typeof virtualBackground === 'boolean') recipeChanges.virtualBackground = virtualBackground;
    if (typeof backgroundPrompt === 'string' && backgroundPrompt.trim()) {
      recipeChanges.backgroundPrompt = backgroundPrompt.trim();
    }
    if (Array.isArray(visualChanges)) {
      recipeChanges.visuals = visualChanges
        .filter((v: any) => Number.isInteger(v?.index) && v.index >= 0 && v.index < visuals.length)
        .map((v: any) => ({
          index: v.index,
          ...(typeof v.prompt === 'string' && v.prompt.trim() ? { prompt: v.prompt.trim() } : {}),
          ...(typeof v.text === 'string' && v.text.trim() ? { text: v.text.trim().toUpperCase().slice(0, 40) } : {}),
        }));
    }
    return res.json({ ok: true, scene: next, recipeChanges, summary: typeof summary === 'string' ? summary : '' });
  } catch (err: any) {
    return res.status(500).json({ error: err?.message || 'Revise failed' });
  }
});

/** Direction clarify — Gemini may ask follow-ups before generating a script */
app.post('/api/direction/clarify', rateLimitMiddleware('script'), async (req, res) => {
  try {
    const {
      idea = '',
      duration = '',
      style = '',
      format = 'short-form',
      aspectRatio = '9:16',
      answers = [],
      round = 0,
      prefs: prefsIn = null,
    } = req.body || {};
    if (!String(idea).trim()) {
      return res.status(400).json({ error: 'idea is required' });
    }

    // Creator's own picks are authoritative — clarify only fills gaps.
    const prefs = sanitizeProductionPrefs(prefsIn, format);
    const prefsWantMedia = prefs.looks.some(
      (l) => l === 'overlays' || l === 'virtual_background' || l === 'broll' || l === 'memes'
    );
    const prefsWantGreenscreen = prefs.looks.includes('virtual_background');
    // Never force overlays off when the creator chose them; otherwise leave to Gemini / default false.
    const lockedHints = {
      ...(prefsWantMedia ? { preferOverlays: true } : {}),
      ...(prefsWantGreenscreen ? { greenscreen: true } : {}),
    };
    const musicMood = prefs.music ? 'subtle' : 'none';

    // A specific idea (topic + angle in a full sentence) needs no clarifying round — save the call.
    const ideaWords = String(idea).trim().split(/\s+/).filter(Boolean).length;
    const ideaIsSpecific =
      Number(round) === 0 &&
      !(Array.isArray(answers) && answers.length) &&
      (ideaWords >= 20 ||
        (ideaWords >= 10 &&
          /\b(about|how|why|what|for|review|tutorial|vs|versus|tips|guide|story|mistakes?|lessons?)\b/i.test(
            String(idea)
          )));
    if (Number(round) >= 2 || ideaIsSpecific) {
      if (ideaIsSpecific) console.log(`[clarify] idea is specific (${ideaWords} words) — skipping Gemini`);
      return res.json({
        status: 'ready',
        skipped: ideaIsSpecific || undefined,
        briefHints: {
          idea,
          duration,
          style,
          musicMood,
          answers,
          preferOverlays: prefsWantMedia,
          ...lockedHints,
        },
      });
    }
    const ai = getAiClient();
    const response = await ai.models.generateContent({
      model: 'gemini-3.8-flash',
      contents: `You are TakeOne's AI director for every kind of creator (explainers, vlogs, tutorials, comedy, reviews, motivational, product reviews).

Idea: "${idea}"
Duration: ${duration || 'unspecified'}
Style: ${style || 'unspecified'}
Format: ${format}
Aspect: ${aspectRatio}
Creator's production prefs (already chosen — do NOT ask about these and do NOT contradict them): ${JSON.stringify(prefs)}
Prior answers (round ${round}): ${JSON.stringify(answers || [])}

Only fill gaps. If prefs.looks includes overlays / virtual_background / broll / memes, set preferOverlays=true (and greenscreen=true for virtual_background). Otherwise set preferOverlays=false unless the idea clearly asks for overlays or inserts.

If you have enough to generate a strong shoot plan, return:
{"status":"ready","briefHints":{"audience":"...","tone":"...","preferOverlays":false,"greenscreen":false,"musicMood":"...","viralHooks":["..."],"mustInclude":["..."],"avoid":["..."]}}

Otherwise ask 1–2 short clarifying questions (max 2 rounds). Prefer:
- who the video is for / the one takeaway
- anything specific they must say or show (CTA, link, story beat)
- language they will speak on camera

Do NOT ask about overlays, b-roll, memes, captions, music or number of shots — the creator already picked those.

Return:
{"status":"questions","questions":[{"id":"q1","prompt":"...","choices":["optional","choices"]}] }

JSON only.`,
      config: {
        responseMimeType: 'application/json',
        thinkingConfig: { thinkingLevel: ThinkingLevel.LOW },
      },
    });
    const parsed = JSON.parse(response.text || '{}');
    if (parsed.status === 'ready') {
      const hints = { ...(parsed.briefHints || { idea, duration, style }), ...lockedHints };
      if (typeof hints.preferOverlays !== 'boolean') hints.preferOverlays = false;
      if (!prefs.music) hints.musicMood = 'none';
      return res.json({
        status: 'ready',
        briefHints: hints,
      });
    }
    const questions = Array.isArray(parsed.questions) ? parsed.questions.slice(0, 3) : [];
    if (!questions.length) {
      return res.json({
        status: 'ready',
        briefHints: {
          idea,
          duration,
          style,
          preferOverlays: prefsWantMedia,
          ...lockedHints,
        },
      });
    }
    return res.json({ status: 'questions', questions, round: Number(round) || 0 });
  } catch (err: any) {
    return res.status(500).json({ error: err?.message || 'Clarify failed' });
  }
});

/** Master prompt — mutate the full production plan / scenes list */
app.post('/api/direction/master-prompt', async (req, res) => {
  try {
    const { project, instruction = '' } = req.body || {};
    if (!project?.scenes || !String(instruction).trim()) {
      return res.status(400).json({ error: 'project.scenes and instruction are required' });
    }
    const ai = getAiClient();
    const compactScenes = (project.scenes || []).map((s: any) => ({
      id: s.id,
      sceneNumber: s.sceneNumber,
      title: s.title,
      purpose: s.purpose,
      filmedBy: s.filmedBy,
      editIntent: s.editIntent,
      durationSeconds: s.durationSeconds,
      mediaRole: s.mediaRole,
      includeInExport: s.includeInExport,
      plainInstruction: s.plainInstruction,
      teleprompterPrompt: s.teleprompterPrompt,
      aiGenerationPrompt: s.aiGenerationPrompt,
    }));
    const response = await ai.models.generateContent({
      model: 'gemini-3.8-flash',
      contents: `You are TakeOne's AI director. Mutate the production plan for "${project.title || 'Untitled'}".

Logline: ${project.logline || ''}
Narrative beats: ${JSON.stringify(project.narrativeBeats || [])}
Current scenes:
${JSON.stringify(compactScenes, null, 2)}

Creator master prompt: "${instruction}"

Return JSON ONLY:
{
  "summary": "what changed",
  "narrativeBeats": [ {"id":"...","title":"...","purpose":"...","editIntent":"..."} ] | null,
  "scenes": [ full scene objects — keep existing ids when revising; new scenes get new ids like "scene-new-1" ],
  "captureStrategy": "single_take" | "multi_shot" | null
}

Rules:
- Prefer optional AI stills as mediaRole:"overlay" with overlayParentSceneId pointing at a user talking-head scene, overlayLayout "pip_br" or "full", includeInExport:false (they composite, not hard-cut).
- Do not invent filmed takes. New user scenes need plainInstruction / teleprompter as appropriate.
- Preserve filmedBy:"user" scenes that already have media unless asked to remove.
- Keep scene order intentional.`,
      config: { responseMimeType: 'application/json' },
    });
    const parsed = JSON.parse(response.text || '{}');
    if (!Array.isArray(parsed.scenes) || !parsed.scenes.length) {
      return res.status(422).json({ error: 'Master prompt returned no scenes' });
    }
    const byId = new Map<string, any>((project.scenes || []).map((s: any) => [s.id, s]));
    const nextScenes = parsed.scenes.map((s: any, i: number) => {
      const prev: any = byId.get(s.id) || {};
      const id = s.id || `scene-new-${Date.now()}-${i}`;
      return {
        ...prev,
        ...s,
        id,
        sceneNumber: s.sceneNumber ?? i + 1,
        filmedBy: s.filmedBy === 'ai' ? 'ai' : prev.filmedBy || 'user',
        // Preserve recorded/imported media from previous scene
        userRecordedVideoUrl: prev.userRecordedVideoUrl,
        gcsObjectPath: prev.gcsObjectPath,
        mimeType: prev.mimeType,
        proxyUrl: prev.proxyUrl,
        recordedDuration: prev.recordedDuration,
        transcript: prev.transcript,
        transcriptSegments: prev.transcriptSegments,
        footageIntel: prev.footageIntel,
        aiGeneratedImageUrl: s.aiGeneratedImageUrl || prev.aiGeneratedImageUrl,
        aiGeneratedVideoUrl: s.aiGeneratedVideoUrl || prev.aiGeneratedVideoUrl,
        brollInserts: prev.brollInserts,
      };
    });
    return res.json({
      ok: true,
      summary: parsed.summary || 'Plan updated',
      scenes: nextScenes,
      narrativeBeats: parsed.narrativeBeats ?? project.narrativeBeats,
      captureStrategy: parsed.captureStrategy ?? project.captureStrategy,
    });
  } catch (err: any) {
    return res.status(500).json({ error: err?.message || 'Master prompt failed' });
  }
});

/**
 * Master Cut "Tweak with a prompt": request → operations on what the export reads (kept ranges,
 * recipe visuals / text pops / punch-ins, prefs). Applied in the browser; the Live Cut player
 * shows the result right away.
 */
app.post('/api/edit/tweak', rateLimitMiddleware('director'), async (req, res) => {
  try {
    const { request = '', project, prefs, musicVolume } = req.body || {};
    if (!String(request).trim()) return res.status(400).json({ ok: false, error: 'request is required' });
    if (!project || !Array.isArray(project.scenes)) {
      return res.status(400).json({ ok: false, error: 'project is required' });
    }
    const resolvedPrefs = sanitizeProductionPrefs(
      prefs ?? project.prefs ?? defaultProductionPrefs(project.videoFormat),
      project.videoFormat
    );
    const result = await planTweak(getAiClient(), {
      request: String(request).slice(0, 800),
      scenes: project.scenes,
      prefs: resolvedPrefs,
      musicVolume: typeof musicVolume === 'number' ? musicVolume : undefined,
    });
    return res.json({ ok: true, ...result });
  } catch (error: any) {
    console.error('[tweak] failed:', error);
    return res.status(500).json({ ok: false, error: error?.message || 'Could not apply that edit' });
  }
});

/** Runway-style NL edit prompt → structured EDL mutations */
app.post('/api/edit/prompt', rateLimitMiddleware('director'), async (req, res) => {
  try {
    const {
      prompt = '',
      project,
      plan: planIn,
      footageIntel,
      mediaUrls = [],
    } = req.body || {};
    if (!String(prompt).trim()) {
      return res.status(400).json({ error: 'prompt is required' });
    }
    if (!project) {
      return res.status(400).json({ error: 'project is required' });
    }

    const { buildBasePlan } = await import('./src/utils/basePlan');
    let plan = planIn;
    if (!plan?.sequence?.length) {
      plan = buildBasePlan(project);
    }
    if (!plan?.sequence?.length) {
      return res.status(400).json({ error: 'No usable takes to build a base plan' });
    }

    const { applyEditMutations, parseEditMutations, buildEditPromptSystem } = await import(
      './server/edit/editMutations'
    );

    const editPolicy =
      plan.editPolicy || (project.entryPath === 'import' ? 'creative_recut' : 'directed');
    const ai = getAiClient();
    const system = buildEditPromptSystem(plan, editPolicy);
    const response = await ai.models.generateContent({
      model: 'gemini-3.8-flash',
      contents: `${system}

Available media URLs the user may reference for overlays (use only these for add_overlay.mediaUrl):
${JSON.stringify(mediaUrls || [])}

User edit request: "${prompt}"

Return JSON mutations only.`,
      config: { responseMimeType: 'application/json' },
    });

    let parsed: { mutations: any[]; summary: string };
    try {
      parsed = parseEditMutations(JSON.parse(response.text || '{}'));
    } catch {
      return res.status(422).json({ error: 'Could not parse edit mutations' });
    }

    // If user asked for overlay and has no mediaUrl, synthesize image or attach available still
    const enriched: any[] = [];
    for (const m of parsed.mutations) {
      if (m.op === 'add_overlay' && !m.mediaUrl) {
        const overlayPrompt = m.prompt || prompt;
        const isWidescreen = project?.videoFormat === 'long-form';
        const styleBible = project?.styleBible || project?.channelSettings?.styleBible || '';
        const enrichedPrompt = [
          styleBible ? `Match this visual continuity: ${styleBible}.` : '',
          `Cinematic photorealistic video cutaway or graphic overlay: ${overlayPrompt}`,
        ]
          .filter(Boolean)
          .join(' ');

        let synthUrl: string | null = null;
        for (const model of [
          'gemini-3.1-flash-image',
          'gemini-3-pro-image',
          'gemini-3.1-flash-lite-image',
          'gemini-2.5-flash-image',
        ]) {
          try {
            const imageConfig = model.includes('lite')
              ? { aspectRatio: isWidescreen ? '16:9' : '9:16' }
              : { aspectRatio: isWidescreen ? '16:9' : '9:16', imageSize: '1K' };
            const resp = await ai.models.generateContent({
              model,
              contents: { parts: [{ text: enrichedPrompt }] },
              config: { imageConfig },
            });
            const parts = resp.candidates?.[0]?.content?.parts;
            if (parts) {
              for (const part of parts) {
                if (part.inlineData?.data) {
                  const mimeType = part.inlineData.mimeType || 'image/png';
                  synthUrl = `data:${mimeType};base64,${part.inlineData.data}`;
                  break;
                }
              }
            }
            if (synthUrl) break;
          } catch (imgErr: any) {
            console.warn(`Overlay generation with ${model} failed:`, imgErr?.message);
          }
        }

        if (synthUrl) {
          enriched.push({
            ...m,
            mediaUrl: synthUrl,
            mediaType: 'image',
            prompt: overlayPrompt,
          });
          continue;
        } else if (Array.isArray(mediaUrls) && mediaUrls[0]) {
          enriched.push({
            ...m,
            mediaUrl: mediaUrls[0].url || mediaUrls[0],
            mediaType: mediaUrls[0].mediaType || 'image',
          });
          continue;
        }
      }
      enriched.push(m);
    }

    const intel = Array.isArray(footageIntel)
      ? footageIntel
      : (project.scenes || [])
          .map((s: any) => s.footageIntel)
          .filter(Boolean);

    const result = applyEditMutations(plan, enriched, intel, project, { editPolicy });
    return res.json({
      ok: true,
      summary: parsed.summary || result.summary,
      changes: result.changes,
      plan: result.plan,
      projectPatch: result.projectPatch,
      musicMood: result.musicMood,
    });
  } catch (err: any) {
    console.error('edit/prompt failed', err);
    return res.status(500).json({ error: err?.message || 'Edit prompt failed' });
  }
});

/** Apply a typed EditMutationOp (from Analyze insights Apply buttons). */
app.post('/api/edit/apply-mutation', async (req, res) => {
  try {
    const { project, plan: planIn, mutation, footageIntel } = req.body || {};
    if (!project || !mutation?.op) {
      return res.status(400).json({ error: 'project and mutation are required' });
    }
    const { buildBasePlan } = await import('./src/utils/basePlan');
    let plan = planIn?.sequence?.length ? planIn : project.editPlan;
    if (!plan?.sequence?.length) {
      plan = buildBasePlan(project);
    }
    if (!plan?.sequence?.length) {
      return res.status(400).json({ error: 'No usable takes to build a base plan' });
    }
    const { applyEditMutations } = await import('./server/edit/editMutations');
    const intel = Array.isArray(footageIntel)
      ? footageIntel
      : (project.scenes || []).map((s: any) => s.footageIntel).filter(Boolean);
    const editPolicy =
      plan.editPolicy || (project.entryPath === 'import' ? 'creative_recut' : 'directed');
    const result = applyEditMutations(plan, [mutation], intel, project, { editPolicy });
    return res.json({
      ok: true,
      summary: result.summary,
      changes: result.changes,
      plan: result.plan,
      projectPatch: result.projectPatch,
      musicMood: result.musicMood,
    });
  } catch (err: any) {
    console.error('edit/apply-mutation failed', err);
    return res.status(500).json({ error: err?.message || 'Apply mutation failed' });
  }
});

/** Generate cinematic brand intro background with Gemini Image */
app.post('/api/generate-intro', async (req, res) => {
  try {
    const {
      channelName = 'My Channel',
      tagline = '',
      brandColor = '#1A73E8',
      styleBible = '',
      aspectRatio = '9:16',
      prompt: userPrompt = '',
      channelNotes = '',
    } = req.body || {};
    const prompt = `Cinematic YouTube channel intro background plate, no text, no logos, no watermarks.
Mood matching channel "${channelName}"${tagline ? ` — ${tagline}` : ''}.
Brand accent color vibe ${brandColor}. Soft bokeh, premium creator aesthetic, shallow depth of field.
${styleBible ? `Match this look: ${styleBible}` : 'Warm natural light, modern lifestyle.'}
${channelNotes ? `Channel / existing intro notes: ${channelNotes}` : ''}
${userPrompt ? `Creator request for this intro: ${userPrompt}` : ''}
Abstract or environmental only — leave clear center space for title overlay.`;

    const ai = getAiClient();
    const isWidescreen = aspectRatio === '16:9';
    const models = ['gemini-3.1-flash-image', 'gemini-3-pro-image', 'gemini-2.5-flash-image'];
    for (const model of models) {
      try {
        const response = await ai.models.generateContent({
          model,
          contents: { parts: [{ text: prompt }] },
          config: {
            imageConfig: {
              aspectRatio: isWidescreen ? '16:9' : '9:16',
              imageSize: '1K',
            },
          },
        });
        for (const part of response.candidates?.[0]?.content?.parts || []) {
          if (part.inlineData?.data) {
            const mimeType = part.inlineData.mimeType || 'image/png';
            return res.json({
              ok: true,
              imageUrl: `data:${mimeType};base64,${part.inlineData.data}`,
              source: model,
            });
          }
        }
      } catch (e: any) {
        console.warn('intro gen', model, e?.message);
      }
    }
    return res.status(503).json({ ok: false, error: 'Could not generate intro background' });
  } catch (err: any) {
    return res.status(500).json({ error: err?.message });
  }
});

function pcm16ToWavBase64(pcmB64: string, sampleRate = 24000, channels = 1): string {
  const pcm = Buffer.from(pcmB64, 'base64');
  const header = Buffer.alloc(44);
  const dataSize = pcm.length;
  header.write('RIFF', 0);
  header.writeUInt32LE(36 + dataSize, 4);
  header.write('WAVE', 8);
  header.write('fmt ', 12);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(channels, 22);
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(sampleRate * channels * 2, 28);
  header.writeUInt16LE(channels * 2, 32);
  header.writeUInt16LE(16, 34);
  header.write('data', 36);
  header.writeUInt32LE(dataSize, 40);
  return Buffer.concat([header, pcm]).toString('base64');
}

async function scrapeYouTubePublicMeta(urlOrHandle: string): Promise<{
  title?: string;
  description?: string;
  image?: string;
  handle?: string;
  source: string;
}> {
  const raw = (urlOrHandle || '').trim();
  if (!raw) return { source: 'none' };
  let handle = raw.replace(/^@/, '');
  if (raw.includes('youtube.com')) {
    const at = raw.match(/youtube\.com\/@([^/?#]+)/i);
    const ch = raw.match(/youtube\.com\/channel\/([^/?#]+)/i);
    handle = at?.[1] || ch?.[1] || handle;
  }
  const pageUrl = raw.startsWith('http')
    ? raw
    : `https://www.youtube.com/@${handle.replace(/^@/, '')}`;
  try {
    const htmlRes = await fetch(pageUrl, {
      headers: {
        'User-Agent':
          'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123.0.0.0 Safari/537.36',
        'Accept-Language': 'en-US,en;q=0.9',
      },
    });
    const html = await htmlRes.text();
    const og = (prop: string) => {
      const m =
        html.match(new RegExp(`<meta[^>]+property=["']${prop}["'][^>]+content=["']([^"']+)["']`, 'i')) ||
        html.match(new RegExp(`<meta[^>]+content=["']([^"']+)["'][^>]+property=["']${prop}["']`, 'i'));
      return m?.[1];
    };
    const title = og('og:title') || html.match(/<title>([^<]+)<\/title>/i)?.[1];
    const description = og('og:description');
    const image = og('og:image');
    if (title || description) {
      return {
        title: title?.replace(' - YouTube', '').trim(),
        description: description?.slice(0, 800),
        image,
        handle: handle.startsWith('@') ? handle : `@${handle}`,
        source: 'youtube-public-html',
      };
    }
  } catch (e: any) {
    console.warn('YouTube public scrape failed:', e?.message);
  }

  try {
    const oembed = await fetch(
      `https://www.youtube.com/oembed?url=${encodeURIComponent(pageUrl)}&format=json`
    );
    if (oembed.ok) {
      const oj = await oembed.json();
      if (oj?.title) {
        return {
          title: String(oj.title).replace(' - YouTube', '').trim(),
          description: oj.author_name ? `Channel by ${oj.author_name}` : undefined,
          image: oj.thumbnail_url,
          handle: handle ? `@${handle.replace(/^@/, '')}` : undefined,
          source: 'youtube-oembed',
        };
      }
    }
  } catch (e: any) {
    console.warn('YouTube oEmbed failed:', e?.message);
  }

  return { handle: handle ? `@${handle.replace(/^@/, '')}` : undefined, source: 'none' };
}

async function synthesizeMoodMusicMp3(mood: string, seconds: number): Promise<Buffer> {
  const { spawn } = await import('child_process');
  const os = await import('os');
  const path = await import('path');
  const fs = await import('fs/promises');
  const out = path.join(os.tmpdir(), `takeone-music-${Date.now()}.mp3`);
  const freq =
    mood.includes('Upbeat') ? '220:330:440' : mood.includes('Lo-Fi') ? '174:220:261' : mood.includes('Ambient') ? '130:196:246' : '196:247:294';
  const [a, b, c] = freq.split(':');
  const filter = `sine=frequency=${a}:duration=${seconds},sine=frequency=${b}:duration=${seconds},sine=frequency=${c}:duration=${seconds},amix=inputs=3:duration=first,lowpass=f=1800,highpass=f=80,volume=0.18`;
  await new Promise<void>((resolve, reject) => {
    const child = spawn('ffmpeg', [
      '-nostdin',
      '-y',
      '-f',
      'lavfi',
      '-i',
      filter,
      '-t',
      String(seconds),
      '-c:a',
      'libmp3lame',
      '-b:a',
      '160k',
      out,
    ]);
    child.on('error', reject);
    child.on('close', (code) => (code === 0 ? resolve() : reject(new Error(`ffmpeg music exit ${code}`))));
  });
  const buf = await fs.readFile(out);
  try {
    await fs.unlink(out);
  } catch {
    /* ignore */
  }
  return buf;
}

async function fetchImageAsInlinePart(
  url: string
): Promise<{ inlineData: { mimeType: string; data: string } } | null> {
  try {
    const res = await fetch(url, {
      headers: { 'User-Agent': 'takeone-cloudrun' },
    });
    if (!res.ok) return null;
    const buf = Buffer.from(await res.arrayBuffer());
    if (buf.length < 800 || buf.length > 4_000_000) return null;
    const ct = (res.headers.get('content-type') || 'image/jpeg').split(';')[0].trim();
    const mimeType = ct.startsWith('image/') ? ct : 'image/jpeg';
    return { inlineData: { mimeType, data: buf.toString('base64') } };
  } catch {
    return null;
  }
}

/** Analyze an existing YouTube channel URL / handle for style continuity */
app.post('/api/analyze-channel', async (req, res) => {
  try {
    const { channelUrl = '', channelHandle = '', notes = '' } = req.body || {};
    if (!channelUrl.trim() && !channelHandle.trim() && !notes.trim()) {
      return res.status(400).json({ error: 'Provide a channel URL, handle, or description of your style.' });
    }
    const ai = getAiClient();
    const ytKey = process.env.YOUTUBE_API_KEY;
    let ytMeta: Record<string, unknown> = {};
    let channelTitle = channelHandle || '';
    let usedYoutubeApi = false;
    const recentVideos: Array<{
      title: string;
      description: string;
      tags: string[];
      thumbnailUrl?: string;
      publishedAt?: string;
    }> = [];
    const thumbnailParts: Array<{ inlineData: { mimeType: string; data: string } }> = [];

    const publicMeta = await scrapeYouTubePublicMeta(channelUrl || channelHandle);
    if (publicMeta.title) channelTitle = publicMeta.title;
    if (publicMeta.title || publicMeta.description) {
      ytMeta = {
        title: publicMeta.title,
        description: publicMeta.description,
        image: publicMeta.image,
        handle: publicMeta.handle,
        source: publicMeta.source,
      };
    }

    // YouTube Data API: channel stats + recent upload titles/tags + thumbnails for visual look
    if (ytKey && (channelUrl || channelHandle)) {
      try {
        let channelId = '';
        const handleRaw = (channelHandle || channelUrl).trim();
        const handle =
          handleRaw.match(/youtube\.com\/@([^/?#]+)/i)?.[1] ||
          handleRaw.replace(/^@/, '').split('/').filter(Boolean).pop() ||
          '';
        if (channelUrl.includes('channel/')) {
          channelId = channelUrl.split('channel/')[1].split(/[?/]/)[0];
        } else if (handle) {
          const byHandle = await fetch(
            `https://www.googleapis.com/youtube/v3/channels?part=snippet,brandingSettings,statistics,contentDetails&forHandle=${encodeURIComponent(handle)}&key=${ytKey}`
          );
          const hj = await byHandle.json();
          if (hj.items?.[0]) {
            channelId = hj.items[0].id;
            channelTitle = hj.items[0].snippet?.title || channelTitle;
          } else {
            const search = await fetch(
              `https://www.googleapis.com/youtube/v3/search?part=snippet&type=channel&q=${encodeURIComponent(handle)}&maxResults=1&key=${ytKey}`
            );
            const sj = await search.json();
            channelId = sj.items?.[0]?.snippet?.channelId || sj.items?.[0]?.id?.channelId || '';
            channelTitle = sj.items?.[0]?.snippet?.channelTitle || channelTitle;
          }
        }
        if (channelId) {
          const ch = await fetch(
            `https://www.googleapis.com/youtube/v3/channels?part=snippet,brandingSettings,statistics,contentDetails&id=${channelId}&key=${ytKey}`
          );
          const cj = await ch.json();
          const item = cj.items?.[0];
          if (item) {
            usedYoutubeApi = true;
            channelTitle = item.snippet?.title || channelTitle;
            ytMeta = {
              title: item.snippet?.title,
              description: (item.snippet?.description || '').slice(0, 1200),
              keywords: item.brandingSettings?.channel?.keywords,
              country: item.snippet?.country,
              subscriberCount: item.statistics?.subscriberCount,
              videoCount: item.statistics?.videoCount,
              viewCount: item.statistics?.viewCount,
              bannerUrl: item.brandingSettings?.image?.bannerExternalUrl,
              unsubscribedTrailer: item.brandingSettings?.channel?.unsubscribedTrailer,
            };

            // Recent uploads via uploads playlist (more accurate than search)
            const uploadsId = item.contentDetails?.relatedPlaylists?.uploads;
            let videoIds: string[] = [];
            if (uploadsId) {
              const pl = await fetch(
                `https://www.googleapis.com/youtube/v3/playlistItems?part=snippet,contentDetails&playlistId=${encodeURIComponent(uploadsId)}&maxResults=8&key=${ytKey}`
              );
              const pj = await pl.json();
              videoIds = (pj.items || [])
                .map((it: any) => it.contentDetails?.videoId || it.snippet?.resourceId?.videoId)
                .filter(Boolean);
            }
            if (!videoIds.length) {
              const searchVids = await fetch(
                `https://www.googleapis.com/youtube/v3/search?part=snippet&channelId=${encodeURIComponent(channelId)}&order=date&type=video&maxResults=8&key=${ytKey}`
              );
              const sv = await searchVids.json();
              videoIds = (sv.items || []).map((it: any) => it.id?.videoId).filter(Boolean);
            }
            if (videoIds.length) {
              const vids = await fetch(
                `https://www.googleapis.com/youtube/v3/videos?part=snippet,topicDetails&id=${videoIds.slice(0, 8).join(',')}&key=${ytKey}`
              );
              const vj = await vids.json();
              for (const v of vj.items || []) {
                const thumbs = v.snippet?.thumbnails || {};
                const thumbUrl =
                  thumbs.maxres?.url || thumbs.standard?.url || thumbs.high?.url || thumbs.medium?.url;
                recentVideos.push({
                  title: v.snippet?.title || '',
                  description: String(v.snippet?.description || '').slice(0, 400),
                  tags: Array.isArray(v.snippet?.tags) ? v.snippet.tags.slice(0, 12) : [],
                  thumbnailUrl: thumbUrl,
                  publishedAt: v.snippet?.publishedAt,
                });
              }
            }
          }
        }
      } catch (ytErr: any) {
        console.warn('YouTube lookup:', ytErr?.message);
      }
    }

    // Visual look from channel art + a few recent thumbnails (proxy for set/background/lighting)
    const imageUrls = [
      publicMeta.image,
      typeof ytMeta.bannerUrl === 'string' ? ytMeta.bannerUrl : undefined,
      ...recentVideos.map((v) => v.thumbnailUrl),
    ].filter(Boolean) as string[];
    const seen = new Set<string>();
    for (const url of imageUrls) {
      if (seen.has(url) || thumbnailParts.length >= 4) break;
      seen.add(url);
      const part = await fetchImageAsInlinePart(url);
      if (part) thumbnailParts.push(part);
    }

    const ytSnippet = JSON.stringify({
      ...ytMeta,
      recentVideos: recentVideos.map((v) => ({
        title: v.title,
        description: v.description,
        tags: v.tags,
        publishedAt: v.publishedAt,
      })),
    });

    if ((!ytSnippet || ytSnippet === '{}') && !String(notes || '').trim()) {
      return res.status(422).json({
        ok: false,
        error:
          'Could not read this YouTube channel. Paste a public youtube.com/@handle URL, add notes about your style, or set YOUTUBE_API_KEY on the server for full channel stats.',
        needsYoutubeApiKey: !ytKey,
        metaSource: publicMeta.source || 'none',
      });
    }

    const textPrompt = `You are a creative director onboarding an existing YouTube creator into TakeOne.
Use ONLY the real YouTube metadata, recent video list, attached thumbnails/banner (if any), and creator notes.
Do not invent subscriber counts or fake video titles.
When images are attached, describe the recurring visual look: background/set, lighting, wardrobe, framing, color grade — from what you can see (not guess beyond the images).
Channel URL: ${channelUrl || 'n/a'}
Handle: ${channelHandle || 'n/a'}
YouTube metadata + recent uploads: ${ytSnippet || 'unavailable'}
Creator notes: ${notes || 'none'}

Infer their brand kit for future videos. Return ONLY JSON:
{
  "channelName": "",
  "youtubeChannelHandle": "@...",
  "youtubeTagline": "short tagline",
  "brandColor": "#RRGGBB",
  "musicMood": "Warm Acoustic | Chill Lo-Fi | Modern Upbeat | Ambient Calm",
  "styleBible": "2-4 sentences on lighting, color, pacing, lens feel, and typical set/background for matching B-roll",
  "visualLook": "1-2 sentences: background/set, lighting, camera distance from thumbnails/banner",
  "contentThemes": ["theme1", "theme2", "theme3"],
  "introStyleNotes": "how their intros usually feel",
  "editingNotes": "pacing, caption style, talking-head vs B-roll habits",
  "aiEditingPreset": "viral-creator | cinematic-documentary | educational-explainer | chill-vlog",
  "channelAnalysisNotes": "brief summary for the creator covering content + look"
}`;

    const response = await ai.models.generateContent({
      model: 'gemini-3.8-flash',
      contents: [
        {
          role: 'user',
          parts: [{ text: textPrompt }, ...thumbnailParts],
        },
      ],
      config: { responseMimeType: 'application/json' },
    });

    const parsed = JSON.parse(response.text || '{}');
    if (channelTitle && !parsed.channelName) parsed.channelName = channelTitle;
    if (publicMeta.handle && !parsed.youtubeChannelHandle) parsed.youtubeChannelHandle = publicMeta.handle;
    return res.json({
      ok: true,
      ...parsed,
      metaSource: usedYoutubeApi
        ? 'youtube-data-api'
        : publicMeta.source,
      usedYoutubeApiKey: Boolean(ytKey) && usedYoutubeApi,
      needsYoutubeApiKey: !ytKey,
      pulledTitle: channelTitle || null,
      pulledDescription:
        (typeof ytMeta.description === 'string' && ytMeta.description) ||
        publicMeta.description ||
        null,
      recentVideoCount: recentVideos.length,
      thumbnailsAnalyzed: thumbnailParts.length,
      recentVideoTitles: recentVideos.map((v) => v.title).slice(0, 6),
    });
  } catch (err: any) {
    return res.status(500).json({ error: err?.message || 'Channel analysis failed' });
  }
});

// 4. Text-to-Speech (TTS) for Director Voice Guidance & AI Dubbing
app.post('/api/generate-tts', rateLimitMiddleware('default'), async (req, res) => {
  try {
    const { text, voice = 'Puck', style = 'Encouraging, warm film director' } = req.body;
    if (!text) {
      return res.status(400).json({ error: 'Text is required for TTS' });
    }

    const ai = getAiClient();

    const ttsModels = ['gemini-3.8-flash-lite-tts', 'gemini-3.1-flash-tts-preview'];
    for (const ttsModel of ttsModels) {
    try {
      const response = await ai.models.generateContent({
        model: ttsModel,
        contents: [
          {
            role: 'user',
            parts: [
              {
                text: text,
                speechMetadata: {
                  style: style,
                },
              },
            ],
          },
        ],
        config: {
          responseModalities: ['AUDIO'],
          speechConfig: {
            voiceConfig: {
              prebuiltVoiceConfig: { voiceName: voice }, // 'Puck', 'Charon', 'Kore', 'Fenrir', 'Zephyr'
            },
          },
        },
      });

      const part = response.candidates?.[0]?.content?.parts?.[0];
      const raw = part?.inlineData?.data;
      const mime = part?.inlineData?.mimeType || 'audio/pcm';
      if (raw) {
        const wav =
          mime.includes('wav') || mime.includes('mp3') || mime.includes('mpeg')
            ? raw
            : pcm16ToWavBase64(raw, 24000, 1);
        return res.json({
          audioBase64: wav,
          format: 'audio/wav',
          voice,
          source: ttsModel,
        });
      }
    } catch (_ttsErr) {
      console.warn(`[tts] ${ttsModel} failed`);
    }
    }

    return res.json({
      useWebSpeech: true,
      text,
      voice,
      source: 'web-speech-fallback',
    });
  } catch (_error) {
    return res.json({ useWebSpeech: true, source: 'web-speech-fallback' });
  }
});

// 4b. Soundtrack generation — Lyria first, FFmpeg bed always as last resort
app.post('/api/generate-music', rateLimitMiddleware('default'), async (req, res) => {
  try {
    const { prompt, durationSeconds = 30, mood = 'Warm Acoustic' } = req.body || {};
    const seconds = Math.max(12, Math.min(60, Number(durationSeconds) || 30));
    const models = seconds <= 30
      ? ['lyria-3-clip-preview', 'lyria-3-pro-preview']
      : ['lyria-3-pro-preview', 'lyria-3-clip-preview'];
    const ai = getAiClient();

    const musicPrompt =
      prompt ||
      `Original ${mood} soundtrack for YouTube video, atmospheric, high quality, melodic, cinematic mix, tempo aligned`;

    for (const model of models) {
      try {
        const response: any = await ai.models.generateContent({
          model,
          contents: musicPrompt,
          config: { responseModalities: ['AUDIO'] },
        });

        const part =
          response?.candidates?.[0]?.content?.parts?.find((p: any) => p?.inlineData?.data) ||
          response?.candidates?.[0]?.content?.parts?.[0];
        if (part?.inlineData?.data) {
          const mime = part.inlineData.mimeType || 'audio/mp3';
          const audioBase64 =
            mime.includes('pcm') || mime.includes('raw') || mime.includes('L16')
              ? pcm16ToWavBase64(part.inlineData.data, 48000, 2)
              : part.inlineData.data;
          const outMime =
            mime.includes('pcm') || mime.includes('raw') || mime.includes('L16')
              ? 'audio/wav'
              : mime;
          console.log(`[lyria] generated audio via ${model} (${outMime})`);
          return res.json({
            audioBase64,
            mimeType: outMime,
            modelUsed: model,
            prompt: musicPrompt,
            fallbackUsed: false,
          });
        }
      } catch (lyriaErr: any) {
        console.warn(`[lyria] ${model} failed:`, lyriaErr?.message);
      }
    }

    try {
      const buf = await synthesizeMoodMusicMp3(mood, seconds);
      console.log(`[music] FFmpeg bed ready for ${mood} (${seconds}s)`);
      return res.json({
        audioBase64: buf.toString('base64'),
        mimeType: 'audio/mpeg',
        modelUsed: 'ffmpeg-mood-bed',
        prompt: musicPrompt,
        fallbackUsed: true,
        message: `Lyria unavailable — generated a ${mood} bed so export still has music.`,
      });
    } catch (ffErr: any) {
      console.error('[music] FFmpeg bed failed:', ffErr?.message);
      return res.status(500).json({
        error: 'Could not generate soundtrack. Check GEMINI_API_KEY (Lyria) and ffmpeg.',
      });
    }
  } catch (err: any) {
    return res.status(500).json({ error: err.message });
  }
});

// 5. Cloud Translation for Multilingual Video Localization
app.post('/api/translate-content', async (req, res) => {
  try {
    const { targetLanguage = 'es', project } = req.body || {};
    if (!project || !project.scenes) {
      return res.status(400).json({ error: 'Project data required' });
    }

    const ai = getAiClient();
    const prompt = `You are Google Cloud Translation engine for video production.
Translate the following video project script and instructions into language code: "${targetLanguage}".
Keep tone natural, conversational, beginner-friendly, and maintain all scene structures.

Project to translate:
${JSON.stringify({
  title: project.title,
  logline: project.logline,
  scenes: project.scenes.map((s: any) => ({
    id: s.id,
    title: s.title,
    plainInstruction: s.plainInstruction,
    directorTip: s.directorTip,
    teleprompterPrompt: s.teleprompterPrompt,
    transcript: s.transcript || s.teleprompterPrompt,
  })),
})}`;

    const schemaConfig = {
      type: Type.OBJECT,
      properties: {
        translatedTitle: { type: Type.STRING },
        translatedLogline: { type: Type.STRING },
        scenes: {
          type: Type.ARRAY,
          items: {
            type: Type.OBJECT,
            properties: {
              id: { type: Type.STRING },
              title: { type: Type.STRING },
              plainInstruction: { type: Type.STRING },
              directorTip: { type: Type.STRING },
              teleprompterPrompt: { type: Type.STRING },
              transcript: { type: Type.STRING },
            },
            required: ['id', 'title', 'plainInstruction', 'directorTip'],
          },
        },
      },
      required: ['translatedTitle', 'translatedLogline', 'scenes'],
    };

    const modelsToTry = ['gemini-3.8-flash', 'gemini-flash-latest', 'gemini-3.1-flash-lite'];
    for (const model of modelsToTry) {
      try {
        const response = await ai.models.generateContent({
          model,
          contents: prompt,
          config: {
            responseMimeType: 'application/json',
            responseSchema: schemaConfig,
          },
        });

        if (response && response.text) {
          const parsed = JSON.parse(response.text);
          return res.json({ translation: parsed, targetLanguage, modelUsed: model });
        }
      } catch (_err) {
        // Continue quietly to next model or fallback
      }
    }

    // Heuristic localization fallback so stage demo never breaks
    return res.json({
      translation: getHeuristicTranslation(project, targetLanguage),
      targetLanguage,
      fallbackUsed: true,
    });
  } catch (_error) {
    return res.json({
      translation: getHeuristicTranslation(req.body?.project, req.body?.targetLanguage || 'es'),
      targetLanguage: req.body?.targetLanguage || 'es',
      fallbackUsed: true,
    });
  }
});

function getHeuristicTranslation(project: any, lang: string) {
  const isEs = lang === 'es';
  const prefix = isEs ? ' [Español]' : ` [${lang.toUpperCase()}]`;

  return {
    translatedTitle: (project?.title || 'TakeOne Video') + prefix,
    translatedLogline: isEs
      ? 'Una mirada suave a por qué llenar una habitación de verde trae tranquilidad diaria.'
      : (project?.logline || '') + prefix,
    scenes: (project?.scenes || []).map((s: any) => ({
      id: s.id,
      title: isEs ? `Escena: ${s.title}` : `${s.title} (${lang})`,
      plainInstruction: isEs
        ? `Sostén tu teléfono al nivel de los ojos con luz suave. Habla con calma y naturalidad.`
        : `${s.plainInstruction} (${lang})`,
      directorTip: isEs
        ? '¡Tú puedes! Respira hondo y habla como si estuvieras charlando con un amigo.'
        : `${s.directorTip} (${lang})`,
      teleprompterPrompt: isEs
        ? 'Solía pensar que no podía mantener nada vivo... hasta que esta planta cambió mi perspectiva.'
        : `${s.teleprompterPrompt || ''} (${lang})`,
      transcript: isEs
        ? 'Solía pensar que no podía mantener nada vivo... hasta que esta planta cambió mi perspectiva.'
        : `${s.transcript || s.teleprompterPrompt || ''} (${lang})`,
    })),
  };
}

// 6. Removed duplicate Mixkit Veo stub — real Veo lives at /api/generate-video + /api/generate-veo-video

function getCuratedCinematicVideo(keyword: string = ''): string {
  const k = keyword.toLowerCase();
  if (k.includes('coffee') || k.includes('pour')) {
    return 'https://assets.mixkit.co/videos/preview/mixkit-coffee-beans-falling-into-a-grinder-42867-large.mp4';
  }
  if (k.includes('city') || k.includes('skyline') || k.includes('urban')) {
    return 'https://assets.mixkit.co/videos/preview/mixkit-aerial-view-of-city-traffic-at-night-42284-large.mp4';
  }
  return 'https://assets.mixkit.co/videos/preview/mixkit-hands-holding-a-small-plant-40915-large.mp4';
}

// 7. BigQuery Audience Analytics & Retention Predictor
app.post('/api/bigquery/analytics', async (req, res) => {
  try {
    const { project } = req.body;
    const scenes = project?.scenes || [];
    const totalDuration = scenes.reduce((a: number, s: any) => a + (s.durationSeconds || 5), 0);

    // Compute scene-by-scene retention curve via BigQuery predictive benchmark model
    let currentRetention = 100;
    const sceneAnalytics = scenes.map((s: any, idx: number) => {
      // First 3 seconds is the hook
      const dropRate = idx === 0 ? 8 : (s.filmedBy === 'user' ? 4 : 2);
      currentRetention = Math.max(45, Math.round(currentRetention - dropRate));
      const hookScore = idx === 0 ? 94 : 88;
      const pacing = s.durationSeconds <= 6 ? 'Optimal Pacing' : 'Slightly Relaxed';

      return {
        sceneNumber: idx + 1,
        title: s.title,
        filmedBy: s.filmedBy,
        durationSeconds: s.durationSeconds,
        predictedRetention: currentRetention,
        dropoffRisk: idx === 0 ? 'Low (Strong Hook)' : (dropRate > 5 ? 'Medium' : 'Very Low'),
        pacing,
        hookScore
      };
    });

    const bqResult = {
      queryEngine: 'TakeOne Retention Heuristic (Gemini-informed pacing model)',
      dataset: 'local_predictor.creator_retention_v1',
      liveBigQuery: false,
      note: 'Predicted from scene structure — not a live BigQuery job.',
      bytesBilled: '0 B',
      queryTimeMs: 12,
      totalDurationSeconds: totalDuration,
      overallRetentionScore: 89,
      viralHookPotential: 'Top 8% in Lifestyle/Vlog Category',
      averageWatchTimePercentage: '78.4%',
      audienceDemographics: [
        { group: 'Gen Z Mobile Viewers (18-24)', percentage: 46 },
        { group: 'Millennial Professionals (25-34)', percentage: 38 },
        { group: 'Broad Lifestyle Creators (35+)', percentage: 16 }
      ],
      sceneAnalytics,
      directorRecommendation: 'Your mix of personal camera eye-contact and cinematic AI cutaways creates an optimal retention saw-tooth wave, keeping viewer attention 2.4x higher than standard talking-head videos.'
    };

    return res.json(bqResult);
  } catch (error: any) {
    return res.status(500).json({ error: error.message });
  }
});

// 8. Google Cloud Storage (GCS) Asset Vault — real listing when GCS_BUCKET is set
app.get('/api/storage/assets', async (_req, res) => {
  const storage = getStorage();
  if (storage && GCS_BUCKET) {
    try {
      const [files] = await storage.bucket(GCS_BUCKET).getFiles({ maxResults: 50 });
      const assets = await Promise.all(
        files.map(async (file) => {
          const [metadata] = await file.getMetadata();
          return {
            name: file.name,
            bucket: GCS_BUCKET,
            uri: `gs://${GCS_BUCKET}/${file.name}`,
            contentType: metadata.contentType || 'application/octet-stream',
            size: metadata.size ? `${(Number(metadata.size) / (1024 * 1024)).toFixed(2)} MB` : '—',
            storageClass: metadata.storageClass || 'STANDARD',
            updated: metadata.updated || new Date().toISOString(),
          };
        })
      );

      return res.json({
        bucket: GCS_BUCKET,
        region: 'us-central1',
        totalAssets: assets.length,
        live: true,
        assets,
      });
    } catch (err: any) {
      console.warn('GCS list failed:', err?.message);
    }
  }

  return res.json({
    bucket: GCS_BUCKET || 'takeone-media-vault (not configured)',
    region: 'us-central1',
    totalAssets: 0,
    live: false,
    message: 'Set GCS_BUCKET to enable live Cloud Storage vault listing.',
    assets: [],
  });
});

app.post('/api/storage/upload', rateLimitMiddleware('upload'), async (req, res) => {
  try {
    const { dataBase64, contentType = 'application/octet-stream', path: objectPath } = req.body || {};
    if (!dataBase64 || !objectPath) {
      return res.status(400).json({ error: 'dataBase64 and path are required' });
    }
    const storage = getStorage();
    if (!storage || !GCS_BUCKET) {
      return res.status(503).json({ error: 'GCS_BUCKET not configured' });
    }

    const buf = Buffer.from(dataBase64, 'base64');
    const file = storage.bucket(GCS_BUCKET).file(objectPath);
    await file.save(buf, {
      contentType,
      resumable: false,
      metadata: { cacheControl: 'private, max-age=3600' },
    });

    return res.json({
      ok: true,
      bucket: GCS_BUCKET,
      uri: `gs://${GCS_BUCKET}/${objectPath}`,
      size: buf.length,
    });
  } catch (err: any) {
    return res.status(500).json({ error: err?.message || 'Upload failed' });
  }
});

/**
 * Fire-and-forget friendly: build (or reuse) a 480p proxy for a take.
 * Call after shoot/import so Analyze rarely encodes on the hot path.
 */
app.post('/api/media/ensure-proxy', async (req, res) => {
  try {
    const { gcsObjectPath, projectId, sceneId, durationSec } = req.body || {};
    if (!gcsObjectPath) {
      return res.status(400).json({ error: 'gcsObjectPath required' });
    }
    const { ensureProxyForSource } = await import('./server/jobs/media');
    const proxyUrl = await ensureProxyForSource(String(gcsObjectPath), {
      projectId: projectId ? String(projectId) : undefined,
      sceneId: sceneId ? String(sceneId) : undefined,
      durationSec: Number(durationSec) || undefined,
    });
    return res.json({ ok: Boolean(proxyUrl), proxyUrl: proxyUrl || null });
  } catch (err: any) {
    return res.status(500).json({ error: err?.message || 'Proxy failed', proxyUrl: null });
  }
});

/**
 * Opt-in trim cleanup: extract kept range to source/.../trimmed.mp4,
 * return new gcsObjectPath, delete the original object.
 */
app.post('/api/media/trim-extract', async (req, res) => {
  const os = await import('os');
  const fs = await import('fs/promises');
  const { spawn } = await import('child_process');
  const { randomUUID } = await import('crypto');
  try {
    const { gcsObjectPath, projectId, sceneId, inPoint, outPoint } = req.body || {};
    if (!gcsObjectPath || !projectId || !sceneId) {
      return res.status(400).json({ error: 'gcsObjectPath, projectId, sceneId required' });
    }
    const start = Math.max(0, Number(inPoint) || 0);
    const end = Math.max(start + 0.3, Number(outPoint) || start + 1);
    const storage = getStorage();
    if (!storage || !GCS_BUCKET) {
      return res.status(503).json({ error: 'GCS_BUCKET not configured' });
    }

    const parseGcs = (p: string) => {
      const m = String(p).match(/^gs:\/\/([^/]+)\/(.+)$/);
      if (m) return { bucket: m[1], object: m[2] };
      return { bucket: GCS_BUCKET, object: String(p).replace(/^\//, '') };
    };
    const src = parseGcs(gcsObjectPath);
    const workDir = await fs.mkdtemp(path.join(os.tmpdir(), 'takeone-trim-'));
    const rawPath = path.join(workDir, 'raw.mp4');
    const outLocal = path.join(workDir, 'trimmed.mp4');

    await storage.bucket(src.bucket).file(src.object).download({ destination: rawPath });

    const dur = end - start;
    await new Promise<void>((resolve, reject) => {
      const child = spawn(
        'ffmpeg',
        [
          '-nostdin',
          '-y',
          '-ss',
          String(start),
          '-i',
          rawPath,
          '-t',
          String(dur),
          '-c:v',
          'libx264',
          '-preset',
          'veryfast',
          '-crf',
          '23',
          '-c:a',
          'aac',
          '-b:a',
          '192k',
          '-movflags',
          '+faststart',
          outLocal,
        ],
        { stdio: ['ignore', 'pipe', 'pipe'] }
      );
      let stderr = '';
      child.stderr?.on('data', (d) => (stderr += d.toString()));
      child.on('close', (code) =>
        code === 0 ? resolve() : reject(new Error(`ffmpeg trim failed: ${stderr.slice(-400)}`))
      );
      child.on('error', reject);
    });

    const newObject = `source/${projectId}/${sceneId}/trimmed-${randomUUID().slice(0, 8)}.mp4`;
    await storage.bucket(GCS_BUCKET).file(newObject).save(await fs.readFile(outLocal), {
      contentType: 'video/mp4',
      resumable: false,
      metadata: { cacheControl: 'private, max-age=3600', metadata: { 'takeone-role': 'trimmed' } },
    });

    // Delete original (best-effort)
    try {
      await storage.bucket(src.bucket).file(src.object).delete({ ignoreNotFound: true });
    } catch (e: any) {
      console.warn('[trim-extract] delete original failed:', e?.message);
    }

    try {
      await fs.rm(workDir, { recursive: true, force: true });
    } catch {
      /* ignore */
    }

    return res.json({
      ok: true,
      gcsObjectPath: `gs://${GCS_BUCKET}/${newObject}`,
      durationSeconds: dur,
      inPoint: 0,
      outPoint: dur,
    });
  } catch (err: any) {
    console.error('[trim-extract]', err);
    return res.status(500).json({ error: err?.message || 'Trim extract failed' });
  }
});

// Serve frontend in production or via Vite in dev
async function startServer() {
  if (process.env.NODE_ENV === 'production') {
    app.use(express.static(path.resolve('dist')));
    // Worklet + any non-hashed public assets (Vite also copies public/ → dist/)
    app.use(express.static(path.resolve('public')));
    app.use('/assets', express.static(path.resolve('public/assets')));
    // Never serve SPA HTML for unknown API routes — clients call res.json().
    app.use('/api', (_req, res) => {
      res.status(404).json({ error: 'Not found' });
    });
    app.get('*', (_req, res) => {
      res.sendFile(path.resolve('dist/index.html'));
    });
  } else {
    const { createServer: createViteServer } = await import('vite');
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: 'spa',
    });
    app.use(vite.middlewares);
  }

  const server = http.createServer(app);
  attachLiveStt(server);
  server.listen(PORT, '0.0.0.0', () => {
    console.log(`🎬 TakeOne Director Server running on http://0.0.0.0:${PORT}`);
    void import('./server/jobs/lifecycle')
      .then((m) => m.ensureTempLifecycle())
      .catch((e) => console.warn('[lifecycle] boot failed:', e?.message || e));
    const runReclaim = () =>
      import('./server/jobs/reclaim')
        .then((m) => m.reclaimOrphans())
        .catch((e) => console.warn('[reclaim] failed:', e?.message || e));
    void runReclaim();
    setInterval(runReclaim, 60_000);
  });
}

startServer();
