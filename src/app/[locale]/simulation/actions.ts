"use server";

import { sql } from "drizzle-orm";

import { getCurrentUser } from "@/lib/auth";
import { findCachedCustomSimulation } from "@/lib/custom-simulation";
import { db } from "@/lib/db";
import { allowAction } from "@/lib/rate-limit";

/**
 * Queues a custom "dream fight" simulation (Wave 62). The row lands in
 * custom_simulation with status='pending'; the Python worker
 * (vertex-sim-worker on the VPS) scores it within ~10s. Identical
 * matchup+form requests are served from cache instead of re-queueing.
 *
 * Machine error codes only (client maps to i18n) — project convention.
 */

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const MAX_PENDING_PER_USER = 3;
const CREATE_COOLDOWN_MS = 5_000;

export type CreateCustomSimResult =
  | { id: string; cached: boolean }
  | { error: string };

export async function createCustomSimulationAction(
  fighterAId: string,
  asOfBoutAId: string | null,
  fighterBId: string,
  asOfBoutBId: string | null,
): Promise<CreateCustomSimResult> {
  const user = await getCurrentUser();
  if (!user) return { error: "NOT_SIGNED_IN" };
  if (!allowAction(`customsim:${user.userProfileId}`, CREATE_COOLDOWN_MS)) {
    return { error: "RATE_LIMITED" };
  }

  if (!UUID_RE.test(fighterAId) || !UUID_RE.test(fighterBId)) {
    return { error: "INVALID_FIGHTER" };
  }
  if (fighterAId === fighterBId) return { error: "SAME_FIGHTER" };
  const asOfA = asOfBoutAId && UUID_RE.test(asOfBoutAId) ? asOfBoutAId : null;
  const asOfB = asOfBoutBId && UUID_RE.test(asOfBoutBId) ? asOfBoutBId : null;
  if ((asOfBoutAId && !asOfA) || (asOfBoutBId && !asOfB)) {
    return { error: "INVALID_BOUT" };
  }

  // Validate both fighters exist, share a gender (UFC has no mixed bouts —
  // the model has never seen one), and have ≥1 completed UFC bout so the
  // snapshot walk has something to stand on.
  const fighters = (await db.execute<{
    id: string;
    gender: string;
    ufc_bouts: number;
  }>(sql`
    SELECT f.id::text AS id, f.gender,
      (SELECT COUNT(*)::int FROM bout b
        JOIN event e ON e.id = b.event_id
        WHERE e.promotion = 'ufc' AND b.status = 'completed'
          AND b.method IS DISTINCT FROM 'no_contest'
          AND (b.fighter_a_id = f.id OR b.fighter_b_id = f.id)) AS ufc_bouts
    FROM fighter f
    WHERE f.id IN (${fighterAId}::uuid, ${fighterBId}::uuid)
  `)) as unknown as { id: string; gender: string; ufc_bouts: number }[];
  if (fighters.length !== 2) return { error: "INVALID_FIGHTER" };
  const fa = fighters.find((f) => f.id === fighterAId)!;
  const fb = fighters.find((f) => f.id === fighterBId)!;
  if (fa.gender !== fb.gender) return { error: "MIXED_GENDER" };
  if (fa.ufc_bouts === 0 || fb.ufc_bouts === 0) return { error: "NO_HISTORY" };

  // As-of bouts must be completed UFC bouts OF that fighter.
  for (const [fid, asof] of [
    [fighterAId, asOfA],
    [fighterBId, asOfB],
  ] as const) {
    if (!asof) continue;
    const ok = (await db.execute<{ ok: number }>(sql`
      SELECT 1 AS ok FROM bout b
      JOIN event e ON e.id = b.event_id
      WHERE b.id = ${asof}::uuid
        AND e.promotion = 'ufc'
        AND b.status = 'completed'
        AND (b.fighter_a_id = ${fid}::uuid OR b.fighter_b_id = ${fid}::uuid)
      LIMIT 1
    `)) as unknown as { ok: number }[];
    if (ok.length === 0) return { error: "INVALID_BOUT" };
  }

  // Same matchup + forms already scored → reuse (either fighter order).
  const cached = await findCachedCustomSimulation(
    fighterAId,
    asOfA,
    fighterBId,
    asOfB,
  );
  if (cached) return { id: cached, cached: true };

  const pending = (await db.execute<{ n: number }>(sql`
    SELECT COUNT(*)::int AS n FROM custom_simulation
    WHERE user_profile_id = ${user.userProfileId}::uuid AND status = 'pending'
  `)) as unknown as { n: number }[];
  if ((pending[0]?.n ?? 0) >= MAX_PENDING_PER_USER) {
    return { error: "TOO_MANY_PENDING" };
  }

  const inserted = (await db.execute<{ id: string }>(sql`
    INSERT INTO custom_simulation
      (user_profile_id, fighter_a_id, fighter_b_id, as_of_bout_a_id, as_of_bout_b_id)
    VALUES
      (${user.userProfileId}::uuid, ${fighterAId}::uuid, ${fighterBId}::uuid,
       ${asOfA}::uuid, ${asOfB}::uuid)
    RETURNING id::text AS id
  `)) as unknown as { id: string }[];
  return { id: inserted[0].id, cached: false };
}
