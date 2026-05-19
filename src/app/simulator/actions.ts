"use server";

import { eq, sql } from "drizzle-orm";
import { revalidatePath } from "next/cache";

import { db } from "@/lib/db";
import { simulation } from "@/lib/db/schema/simulations";
import { userProfile } from "@/lib/db/schema/users";
import { simulate, type SimulatorFighter } from "@/lib/simulator";
import { createClient } from "@/lib/supabase/server";

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

async function fetchSimulatorFighter(
  fighterId: string,
): Promise<SimulatorFighter | null> {
  if (!UUID_RE.test(fighterId)) return null;
  const rows = await db.execute(sql`
    SELECT
      f.id::text AS id,
      f.name_en,
      fvs.vertex_score,
      fvs.vertex_score_all_time,
      fvs.finishing_dominance_decayed,
      fvs.defensive_vulnerability,
      fvs.recent_form_score,
      fsa.slpm,
      fsa.sapm,
      fsa.str_def,
      fsa.td_def,
      fsa.td_avg,
      fsa.td_acc,
      fsa.sub_avg,
      f.height_cm,
      f.reach_cm
    FROM fighter f
    LEFT JOIN fighter_vertex_score fvs ON fvs.id = f.id
    LEFT JOIN fighter_stats_aggregate fsa ON fsa.fighter_id = f.id
    WHERE f.id = ${fighterId}::uuid
    LIMIT 1
  `);
  return (rows as unknown as SimulatorFighter[])[0] ?? null;
}

const GAMEPLAN_MAX = 500;

export async function runSimulationAction(
  fighterAId: string,
  fighterBId: string,
  gameplanA?: string,
  gameplanB?: string,
): Promise<{ error?: string; simulationId?: string }> {
  if (!UUID_RE.test(fighterAId) || !UUID_RE.test(fighterBId)) {
    return { error: "Invalid fighter id." };
  }
  if (fighterAId === fighterBId) {
    return { error: "Pick two different fighters." };
  }

  const [a, b] = await Promise.all([
    fetchSimulatorFighter(fighterAId),
    fetchSimulatorFighter(fighterBId),
  ]);
  if (!a || !b) return { error: "Fighter not found." };

  const result = simulate(a, b, {
    gameplanA: gameplanA?.slice(0, GAMEPLAN_MAX),
    gameplanB: gameplanB?.slice(0, GAMEPLAN_MAX),
  });

  // Anonymous sims are allowed — userId stays NULL. Only signed-in
  // users get the row credited to them + their simulation_count bumped.
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  let myProfileId: string | null = null;
  if (user) {
    const rows = await db
      .select({ id: userProfile.id })
      .from(userProfile)
      .where(eq(userProfile.authUserId, user.id))
      .limit(1);
    myProfileId = rows[0]?.id ?? null;
  }

  const inserted = await db
    .insert(simulation)
    .values({
      userId: myProfileId,
      fighterAId,
      fighterBId,
      result,
    })
    .returning({ id: simulation.id });
  const simulationId = inserted[0].id;

  if (myProfileId) {
    await db.execute(sql`
      UPDATE user_profile
      SET simulation_count = simulation_count + 1
      WHERE id = ${myProfileId}::uuid
    `);
  }

  revalidatePath(`/simulator/${simulationId}`);
  return { simulationId };
}
