"use server";

import { eq, sql } from "drizzle-orm";
import { revalidatePath } from "next/cache";

import { db } from "@/lib/db";
import { userProfile } from "@/lib/db/schema/users";
import { createClient } from "@/lib/supabase/server";

type PickInput = { bout_id: string; picked_fighter_id: string };

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

async function getMyProfileId(): Promise<string | null> {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return null;
  const rows = await db
    .select({ id: userProfile.id })
    .from(userProfile)
    .where(eq(userProfile.authUserId, user.id))
    .limit(1);
  return rows[0]?.id ?? null;
}

export async function submitPicksAction(
  predictionEventId: string,
  picksRaw: string,
): Promise<{ error?: string; saved?: number }> {
  if (!UUID_RE.test(predictionEventId)) {
    return { error: "Invalid prediction event id." };
  }
  const myId = await getMyProfileId();
  if (!myId) return { error: "Not signed in." };

  let picks: PickInput[];
  try {
    const parsed = JSON.parse(picksRaw);
    if (!Array.isArray(parsed)) return { error: "Invalid picks payload." };
    picks = parsed.filter(
      (p): p is PickInput =>
        typeof p === "object" &&
        p !== null &&
        typeof (p as { bout_id: unknown }).bout_id === "string" &&
        typeof (p as { picked_fighter_id: unknown }).picked_fighter_id ===
          "string" &&
        UUID_RE.test((p as PickInput).bout_id) &&
        UUID_RE.test((p as PickInput).picked_fighter_id),
    );
  } catch {
    return { error: "Invalid picks payload." };
  }

  if (picks.length === 0) return { error: "No picks supplied." };

  const peRows = await db.execute<{
    closes_at: string;
    status: string;
    event_id: string;
  }>(sql`
    SELECT closes_at::text AS closes_at, status, event_id::text AS event_id
    FROM prediction_event
    WHERE id = ${predictionEventId}::uuid
    LIMIT 1
  `);
  const pe = (
    peRows as unknown as Array<{
      closes_at: string;
      status: string;
      event_id: string;
    }>
  )[0];
  if (!pe) return { error: "Prediction event not found." };
  if (pe.status !== "upcoming") return { error: "Predictions closed." };
  if (new Date(pe.closes_at).getTime() <= Date.now()) {
    return { error: "Submission deadline passed." };
  }

  // Check whether the user has ever submitted a pick for this event before —
  // drives the total_participants bump + user.prediction_count increment.
  const priorPickRows = await db.execute<{ has_prior: boolean }>(sql`
    SELECT EXISTS (
      SELECT 1 FROM prediction_pick
      WHERE prediction_event_id = ${predictionEventId}::uuid
        AND user_id = ${myId}::uuid
    ) AS has_prior
  `);
  const hadPriorPicks =
    (priorPickRows as unknown as Array<{ has_prior: boolean }>)[0]
      ?.has_prior === true;

  let saved = 0;
  for (const p of picks) {
    // Anti-tamper: the picked fighter must be one of the two on this bout,
    // and the bout must belong to this prediction event.
    const validRows = await db.execute<{ ok: boolean }>(sql`
      SELECT (b.fighter_a_id::text = ${p.picked_fighter_id}
              OR b.fighter_b_id::text = ${p.picked_fighter_id}) AS ok
      FROM bout b
      WHERE b.id = ${p.bout_id}::uuid
        AND b.event_id = ${pe.event_id}::uuid
    `);
    const ok =
      (validRows as unknown as Array<{ ok: boolean }>)[0]?.ok === true;
    if (!ok) continue;

    await db.execute(sql`
      INSERT INTO prediction_pick (
        user_id, prediction_event_id, bout_id, picked_fighter_id, locked_at
      )
      VALUES (
        ${myId}::uuid,
        ${predictionEventId}::uuid,
        ${p.bout_id}::uuid,
        ${p.picked_fighter_id}::uuid,
        NOW()
      )
      ON CONFLICT (user_id, bout_id) DO UPDATE
        SET picked_fighter_id = EXCLUDED.picked_fighter_id,
            locked_at = NOW()
    `);
    saved++;
  }

  // If this is the user's first pick on this event, bump participant
  // count and the user's lifetime prediction_count.
  if (!hadPriorPicks && saved > 0) {
    await db.execute(sql`
      UPDATE prediction_event
      SET total_participants = (
        SELECT COUNT(DISTINCT user_id)
        FROM prediction_pick
        WHERE prediction_event_id = ${predictionEventId}::uuid
      )
      WHERE id = ${predictionEventId}::uuid
    `);
    await db.execute(sql`
      UPDATE user_profile
      SET prediction_count = prediction_count + 1
      WHERE id = ${myId}::uuid
    `);
  }

  revalidatePath(`/predictions/${predictionEventId}`);
  revalidatePath("/predictions");
  revalidatePath("/me/predictions");
  return { saved };
}
