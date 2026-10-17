# TakeOne — AI Director & Video Co-Pilot

**You're the talent. TakeOne is the director.**

Give TakeOne an idea. It writes a screenplay that honors your preferences (shot count, virtual background, b-roll, captions), coaches the shoot with a teleprompter, then compiles a master cut with:

1. **Silence / filler removal** from Cloud Speech (Chirp) word timestamps  
2. **Word-by-word animated captions** burned with FFmpeg ASS  
3. **B-roll, overlays, text pops, and virtual backgrounds** from the screenplay recipe  

Built for the **Hack2Skill AI Builders Cup 2026**.

---

## Architecture

```
Idea + Prefs
    → Gemini pass 1 (creative script, temp ~0.9)
    → Gemini pass 2 (structure → SceneRecipe JSON, temp ~0.2)
    → Prefs validator + one repair call
    → Guided shoot (+ MediaPipe virtual green when needed)
    → Chirp word timestamps on every take
    → Director compiler (cleanup keep-ranges + anchors → EDL)
    → FFmpeg on Cloud Run Job → Master MP4
    → "What I did" report (matches the actual EDL)
```

### Google technologies we actually call

| Service | Role |
|--------|------|
| **Gemini** | Two-pass screenplay, stills, TTS, translate, fact-check |
| **Veo 3.1** | Optional motion b-roll |
| **Lyria** | Optional soundtrack |
| **Cloud Speech-to-Text (Chirp / latest_long)** | Word-level timestamps |
| **Cloud Storage** | Takes, assets, job status, masters |
| **Cloud Run + native FFmpeg** | Director-cut render (scale-to-zero idle) |

Retention scores in the UI are a **local heuristic preview**, not live BigQuery. We do **not** claim Imagen, Cloud TTS, or Cloud Translation APIs.

---

## Quick start (local)

**Prerequisites:** Node 22+, FFmpeg on `PATH`, Google ADC if you want Chirp / GCS.

```bash
npm install --legacy-peer-deps
cp .env.example .env
# set GEMINI_API_KEY (and optionally GCS_BUCKET + GOOGLE_CLOUD_PROJECT)
npm run dev
```

Open http://localhost:3000

Without GCS, you can still generate scripts and shoot; master render requires a bucket.

### Unit checks

```bash
npx tsc --noEmit
npx tsx scripts/testCleanup.ts
npx tsx scripts/testCompile.ts
```

---

## Production deploy (Cloud Run)

Service stays **min-instances=0** (idle ≈ $0). Renders run as a **Cloud Run Job** so CPU throttling on the API does not kill FFmpeg.

```bash
# 1) Deploy the API service (example)
gcloud run deploy takeone --source . --region=us-central1 \
  --min-instances=0 --cpu=2 --memory=2Gi --cpu-throttling \
  --set-secrets=GEMINI_API_KEY=GEMINI_API_KEY:latest \
  --set-env-vars=GCS_BUCKET=...,GOOGLE_CLOUD_PROJECT=...,TAKEONE_WORKER_JOB=takeone-worker,CLOUD_RUN_REGION=us-central1

# 2) Deploy the worker job with the SAME image
export IMAGE_URI=...   # from the service revision
./scripts/deploy-worker-job.sh

# 3) Grant the API service account permission to run the job
gcloud run jobs add-iam-policy-binding takeone-worker \
  --region=us-central1 \
  --member=serviceAccount:YOUR_API_SA@PROJECT.iam.gserviceaccount.com \
  --role=roles/run.developer
```

Optional abuse controls: `TAKEONE_DEMO_PASSCODE`, `TAKEONE_DAILY_CAP` (see `.env.example`). Expensive routes are rate-limited per IP; JSON body limit is **10 MB**.

---

## Demo script for judges (≈8 minutes)

1. **Idea** — pick “3 study tips (45s)” or type your own. Set prefs: shots = one take, captions = bold_pop, cleanup on.  
2. **Script** — confirm one camera setup, natural spoken lines, recipe punch-ins / text pops.  
3. **Shoot** — teleprompter + live STT. For “Weather from Mars”, generate a background in Script Overview, then shoot with **Virtual background ON** (MediaPipe → recorded over `#00FF00`).  
4. **Director’s Cut** — toggle prefs if needed → **Render** (draft) or **Final**. Read the **What I did** report (fillers removed, dead air shrunk, inserts, captions).  
5. **Download** the master and spot-check captions + punch-ins.

Golden set: study tips · Mars weather (virtual BG) · sourdough fail (b-roll) · headphones review (memes/text) · Hindi motivational short.

---

## Key API

| Route | Purpose |
|-------|---------|
| `POST /api/generate-script` | Two-pass screenplay (`prefs` required for shot/look budget) |
| `POST /api/direction/clarify` | Fills gaps only — never overrides explicit prefs |
| `POST /api/transcribe-audio` | Chirp words → `{ words, segments, engine }` |
| `POST /api/director-cut` | Compile EDL + report; `startRender: true` enqueues FFmpeg job |
| `POST /api/render/start` | Low-level render (used by director-cut) |
| `WS /api/live-stt` | Streaming Cloud Speech while shooting |

---

## Product principles

- The **screenplay recipe** is the creative source of truth.  
- **Cleanup** comes from word timestamps, not a separate “AI editor” that never reaches the MP4.  
- The **What I did** report is generated from the compile step — UI and render stay aligned.  
- Failures should be **visible** (no silent greenscreen → PiP swap for required backgrounds).

---

## License / notes

Hackathon prototype. Keep `GEMINI_API_KEY` server-side only (never Vite-injected).
