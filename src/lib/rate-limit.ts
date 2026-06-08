import "server-only";

/**
 * Best-effort, in-memory throttle for engagement / money mutations.
 *
 * The HARD money-safety guarantees already live in the DB layer — FOR UPDATE
 * row locks, the `balance_coins >= 0` CHECK, and the conditional daily-bonus
 * UPDATE. This limiter is NOT load-bearing for any of that. It exists for a
 * different threat: a script hammering bets / votes / likes / daily-bonus to
 * farm achievements, inflate stats, or saturate the connection pooler. So it
 * is deliberately lightweight and adds ZERO database round-trips.
 *
 * Process-local by design: production runs as a single self-hosted instance
 * (Coolify), so a Map is sufficient. If we ever scale horizontally this stays
 * a useful per-instance first line of defence; a shared store (Redis) would
 * replace it then. Either way nothing here is required for correctness.
 */

// key -> last-allowed timestamp (ms). Bounded; oldest entries are evicted so
// the map can't grow without limit under a churn of distinct keys.
const lastAllowed = new Map<string, number>();
const MAX_KEYS = 50_000;

// Drop the oldest ~10% in insertion order (Map preserves it). Entries are
// tiny and churn naturally as callers act, so this is cheap and good enough.
// Generic so both the cooldown map and the burst-window map reuse it.
function evictOldest<V>(map: Map<string, V>) {
  const toDrop = Math.ceil(MAX_KEYS * 0.1);
  let dropped = 0;
  for (const k of map.keys()) {
    map.delete(k);
    if (++dropped >= toDrop) break;
  }
}

function evictIfNeeded() {
  if (lastAllowed.size <= MAX_KEYS) return;
  evictOldest(lastAllowed);
}

/**
 * Returns true if the action is allowed (recording the hit), false if the
 * caller is still inside the cooldown window for this key.
 *
 * @param key        stable actor+action identity, e.g. `bet:${userId}`
 * @param cooldownMs minimum gap between two allowed actions for that key
 */
export function allowAction(key: string, cooldownMs: number): boolean {
  const now = Date.now();
  const last = lastAllowed.get(key);
  if (last !== undefined && now - last < cooldownMs) {
    return false;
  }
  // Re-insert so this key moves to the newest position (insertion-order LRU
  // for the eviction sweep above).
  lastAllowed.delete(key);
  lastAllowed.set(key, now);
  evictIfNeeded();
  return true;
}

// key -> current fixed window {start ms, count}. Bounded like lastAllowed.
const windows = new Map<string, { start: number; count: number }>();

/**
 * Fixed-window per-key limiter for PUBLIC READ endpoints. allowAction's single
 * gap cooldown is the wrong shape for them — legitimate clients fire small
 * bursts (debounced typeahead, infinite-scroll, rapid filter toggles). A window
 * with generous headroom lets those through while still cutting off a scraper
 * hammering hundreds/sec. Process-local and best-effort, exactly like
 * allowAction; nothing here is load-bearing for correctness.
 *
 * @param key      stable bucket identity, e.g. `api-fighters:${ip}`
 * @param limit    max allowed hits within the window
 * @param windowMs window length in ms
 */
export function allowBurst(
  key: string,
  limit: number,
  windowMs: number,
): boolean {
  const now = Date.now();
  const w = windows.get(key);
  if (!w || now - w.start >= windowMs) {
    windows.delete(key);
    windows.set(key, { start: now, count: 1 });
    if (windows.size > MAX_KEYS) evictOldest(windows);
    return true;
  }
  if (w.count >= limit) return false;
  w.count += 1;
  return true;
}

/**
 * Best-effort client IP, for use ONLY as a rate-limit bucket key — never for
 * authorization. Behind Coolify/Traefik the real client IP arrives in
 * x-forwarded-for (first hop); fall back to x-real-ip, then a shared bucket.
 * Accepts anything Headers-shaped (NextRequest.headers or next/headers()).
 */
export function clientIp(h: { get(name: string): string | null }): string {
  const fwd = h.get("x-forwarded-for");
  if (fwd) {
    const first = fwd.split(",")[0]?.trim();
    if (first) return first;
  }
  return h.get("x-real-ip")?.trim() || "unknown";
}

/**
 * Per-action cooldowns (ms). Tuned to be invisible to a human clicking but to
 * throttle scripted hammering. Bets get a touch more room than the read-only
 * vote/like taps since a single mis-tapped bet is costlier to repeat.
 */
export const COOLDOWN_MS = {
  bet: 1_000,
  dailyBonus: 3_000,
  vote: 700,
  like: 700,
} as const;

/**
 * App-level cooldowns (ms) for unauthenticated auth flows. Defence-in-depth on
 * top of Supabase's own GoTrue rate limits — throttles scripted credential
 * checks and reset/confirmation-email spam without being noticeable to a human.
 * Single-instance, in-memory (see file header); keyed by email and/or IP.
 */
export const AUTH_COOLDOWN_MS = {
  signIn: 1_000, // per email — scripted password guessing against one account
  signUp: 5_000, // per email — repeat signup attempts for one address
  signUpIp: 2_000, // per IP — mass account creation / confirm-email spam
  forgotPassword: 15_000, // per email — don't resend a reset mail this fast
  forgotPasswordIp: 2_000, // per IP — reset-email enumeration from one host
} as const;
