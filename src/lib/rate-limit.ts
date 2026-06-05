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

function evictIfNeeded() {
  if (lastAllowed.size <= MAX_KEYS) return;
  // Drop the oldest ~10% in insertion order (Map preserves it). Entries are
  // tiny and churn naturally as users act, so this is cheap and good enough.
  const toDrop = Math.ceil(MAX_KEYS * 0.1);
  let dropped = 0;
  for (const k of lastAllowed.keys()) {
    lastAllowed.delete(k);
    if (++dropped >= toDrop) break;
  }
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
