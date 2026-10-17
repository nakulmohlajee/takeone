/**
 * Lightweight in-memory rate limiting + optional demo passcode.
 * Not durable across instances — enough for hackathon / demo abuse control.
 */

type Bucket = { count: number; resetAt: number };

const buckets = new Map<string, Bucket>();
const dailyBuckets = new Map<string, Bucket>();

function clientIp(req: { headers: Record<string, unknown>; ip?: string; socket?: { remoteAddress?: string } }): string {
  const xf = req.headers['x-forwarded-for'];
  if (typeof xf === 'string' && xf.trim()) return xf.split(',')[0].trim();
  if (Array.isArray(xf) && xf[0]) return String(xf[0]).split(',')[0].trim();
  return req.ip || req.socket?.remoteAddress || 'unknown';
}

function take(map: Map<string, Bucket>, key: string, limit: number, windowMs: number): { ok: boolean; remaining: number; retryAfterSec: number } {
  const now = Date.now();
  let b = map.get(key);
  if (!b || now >= b.resetAt) {
    b = { count: 0, resetAt: now + windowMs };
    map.set(key, b);
  }
  b.count += 1;
  const remaining = Math.max(0, limit - b.count);
  if (b.count > limit) {
    return { ok: false, remaining: 0, retryAfterSec: Math.max(1, Math.ceil((b.resetAt - now) / 1000)) };
  }
  return { ok: true, remaining, retryAfterSec: 0 };
}

/** Per-IP window limits for expensive routes. */
export const EXPENSIVE_LIMITS: Record<string, { limit: number; windowMs: number }> = {
  script: { limit: 20, windowMs: 60 * 60 * 1000 },
  veo: { limit: 8, windowMs: 60 * 60 * 1000 },
  render: { limit: 12, windowMs: 60 * 60 * 1000 },
  director: { limit: 20, windowMs: 60 * 60 * 1000 },
  /** Compile-only (no AI, no render) — the Live Cut player recompiles after every edit. */
  compile: { limit: 600, windowMs: 60 * 60 * 1000 },
  stt: { limit: 60, windowMs: 60 * 60 * 1000 },
  upload: { limit: 40, windowMs: 60 * 60 * 1000 },
  default: { limit: 120, windowMs: 60 * 60 * 1000 },
};

const DAILY_CAP = Math.max(50, Number(process.env.TAKEONE_DAILY_CAP || 200));

export function checkPasscode(req: { headers: Record<string, unknown>; query?: Record<string, unknown>; body?: any }): boolean {
  const required = (process.env.TAKEONE_DEMO_PASSCODE || '').trim();
  if (!required) return true;
  const header = String(req.headers['x-takeone-passcode'] || '').trim();
  const query = String(req.query?.passcode || '').trim();
  const body = String(req.body?.passcode || '').trim();
  return header === required || query === required || body === required;
}

/** Kinds that are cheap enough not to count toward the daily cap. */
const SKIP_DAILY = new Set<string>(['compile']);

export function rateLimitMiddleware(kind: keyof typeof EXPENSIVE_LIMITS = 'default') {
  const cfg = EXPENSIVE_LIMITS[kind] || EXPENSIVE_LIMITS.default;
  return (req: any, res: any, next: any) => {
    if (!checkPasscode(req)) {
      return res.status(401).json({
        error: 'Demo passcode required. Set header X-TakeOne-Passcode.',
      });
    }
    const ip = clientIp(req);
    const hour = take(buckets, `${kind}:${ip}`, cfg.limit, cfg.windowMs);
    if (!hour.ok) {
      res.setHeader('Retry-After', String(hour.retryAfterSec));
      return res.status(429).json({
        error: `Rate limit exceeded for ${kind}. Try again in ${hour.retryAfterSec}s.`,
        kind,
      });
    }
    const day = SKIP_DAILY.has(kind)
      ? { ok: true, remaining: DAILY_CAP, retryAfterSec: 0 }
      : take(dailyBuckets, `day:${ip}`, DAILY_CAP, 24 * 60 * 60 * 1000);
    if (!day.ok) {
      res.setHeader('Retry-After', String(day.retryAfterSec));
      return res.status(429).json({
        error: `Daily request cap (${DAILY_CAP}) reached for this IP.`,
        kind: 'daily',
      });
    }
    res.setHeader('X-RateLimit-Remaining', String(Math.min(hour.remaining, day.remaining)));
    next();
  };
}
