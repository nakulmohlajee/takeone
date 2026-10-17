/**
 * Start a Cloud Run Job execution via Run v2 REST (metadata server auth on Cloud Run).
 */

const METADATA_TOKEN_URL =
  'http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default/token';

function gcpProject(): string | undefined {
  return process.env.GOOGLE_CLOUD_PROJECT || process.env.GCP_PROJECT;
}

function cloudRunRegion(): string {
  return process.env.CLOUD_RUN_REGION || 'us-central1';
}

/** Job resource name when Cloud Run Job enqueue is enabled (see enqueue.ts). */
export function configuredWorkerJobName(): string | null {
  const explicit =
    process.env.TAKEONE_WORKER_JOB?.trim() || process.env.CLOUD_RUN_JOB?.trim();
  if (!explicit) {
    if (process.env.TAKEONE_WORKER_JOB !== undefined || process.env.CLOUD_RUN_JOB !== undefined) {
      return 'takeone-worker';
    }
    return null;
  }
  return explicit;
}

async function fetchAccessToken(): Promise<string | null> {
  try {
    const res = await fetch(METADATA_TOKEN_URL, {
      headers: { 'Metadata-Flavor': 'Google' },
      signal: AbortSignal.timeout(3000),
    });
    if (!res.ok) {
      console.warn(`[worker] metadata token HTTP ${res.status}`);
      return null;
    }
    const body = (await res.json()) as { access_token?: string };
    return body.access_token || null;
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    console.warn(`[worker] metadata token unavailable: ${msg}`);
    return null;
  }
}

export type LaunchWorkerJobResult =
  | { ok: true; executionName: string }
  | { ok: false; error: string };

export async function launchWorkerJob(
  kind: string,
  id?: string
): Promise<LaunchWorkerJobResult> {
  const project = gcpProject();
  const job = configuredWorkerJobName();
  const region = cloudRunRegion();

  if (!project) {
    return { ok: false, error: 'GOOGLE_CLOUD_PROJECT / GCP_PROJECT not set' };
  }
  if (!job) {
    return { ok: false, error: 'TAKEONE_WORKER_JOB / CLOUD_RUN_JOB not configured' };
  }

  const token = await fetchAccessToken();
  if (!token) {
    return { ok: false, error: 'no GCP credentials (metadata server)' };
  }

  // Cloud Run containerOverrides.args REPLACES the job template args entirely, so the
  // override must re-include the script path. Template is `node dist-worker/worker.mjs`.
  const entry = process.env.TAKEONE_WORKER_ENTRY?.trim() || 'dist-worker/worker.mjs';
  const args = [entry, `--kind=${kind}`];
  if (id) args.push(`--id=${id}`);

  const url = `https://run.googleapis.com/v2/projects/${encodeURIComponent(project)}/locations/${encodeURIComponent(region)}/jobs/${encodeURIComponent(job)}:run`;

  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        overrides: {
          containerOverrides: [{ args }],
        },
      }),
      signal: AbortSignal.timeout(30_000),
    });

    const text = await res.text();
    if (!res.ok) {
      return {
        ok: false,
        error: `Run jobs.run HTTP ${res.status}: ${text.slice(0, 500)}`,
      };
    }

    let executionName = '';
    try {
      const parsed = JSON.parse(text) as { name?: string };
      executionName = parsed.name || '';
    } catch {
      executionName = text.slice(0, 120);
    }

    return { ok: true, executionName };
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    return { ok: false, error: msg };
  }
}
