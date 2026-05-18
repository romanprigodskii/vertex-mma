"use server";

import { eq } from "drizzle-orm";
import { revalidatePath } from "next/cache";

import { checkAndUnlockAchievements } from "@/lib/achievements";
import { db } from "@/lib/db";
import {
  customRanking,
  customRankingEntry,
} from "@/lib/db/schema/rankings";
import { userProfile } from "@/lib/db/schema/users";
import { searchFighters } from "@/lib/fighter-search";
import { createClient } from "@/lib/supabase/server";

const TITLE_MIN = 3;
const TITLE_MAX = 100;
const DESC_MAX = 500;
const NOTE_MAX = 200;
const MIN_ENTRIES = 1;
const MAX_ENTRIES = 25;

type EntryInput = {
  fighter_id: string;
  position: number;
  note?: string | null;
};

function parseEntries(raw: string): EntryInput[] | null {
  try {
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return null;
    return parsed.filter(
      (e): e is EntryInput =>
        typeof e === "object" &&
        e !== null &&
        typeof (e as { fighter_id: unknown }).fighter_id === "string" &&
        typeof (e as { position: unknown }).position === "number",
    );
  } catch {
    return null;
  }
}

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

export type PickerFighter = {
  id: string;
  name: string;
  nickname: string | null;
  photo_thumbnail_url: string | null;
  weight_class: string | null;
};

export async function searchFightersForPicker(
  query: string,
): Promise<PickerFighter[]> {
  if (!query.trim()) return [];
  const results = await searchFighters(query, 8);
  return results.map((r) => ({
    id: r.id,
    name: r.name_en,
    nickname: r.nickname,
    photo_thumbnail_url: r.photo_thumbnail_url,
    weight_class: r.weight_class_primary,
  }));
}

function validateEntries(
  entries: EntryInput[] | null,
): { error: string } | { entries: EntryInput[] } {
  if (!entries || entries.length < MIN_ENTRIES) {
    return { error: `Add at least ${MIN_ENTRIES} fighter.` };
  }
  if (entries.length > MAX_ENTRIES) {
    return { error: `Max ${MAX_ENTRIES} entries per ranking.` };
  }
  const ids = new Set(entries.map((e) => e.fighter_id));
  if (ids.size !== entries.length) {
    return { error: "Same fighter cannot appear twice." };
  }
  for (const e of entries) {
    if (e.note && e.note.length > NOTE_MAX) {
      return { error: `Notes must be under ${NOTE_MAX} chars each.` };
    }
  }
  // Server normalizes positions to 1..N regardless of client input order.
  const sorted = [...entries]
    .sort((a, b) => a.position - b.position)
    .map((e, i) => ({ ...e, position: i + 1 }));
  return { entries: sorted };
}

export async function createRankingAction(
  formData: FormData,
): Promise<{ error?: string; rankingId?: string; newlyUnlocked?: string[] }> {
  const myId = await getMyProfileId();
  if (!myId) return { error: "Not signed in." };

  const title = String(formData.get("title") ?? "").trim();
  const description = String(formData.get("description") ?? "").trim();
  const entriesRaw = String(formData.get("entries") ?? "");

  if (title.length < TITLE_MIN || title.length > TITLE_MAX) {
    return { error: `Title must be ${TITLE_MIN}–${TITLE_MAX} chars.` };
  }
  if (description.length > DESC_MAX) {
    return { error: `Description must be under ${DESC_MAX} chars.` };
  }

  const validated = validateEntries(parseEntries(entriesRaw));
  if ("error" in validated) return { error: validated.error };

  const [created] = await db
    .insert(customRanking)
    .values({
      userId: myId,
      title,
      description: description || null,
    })
    .returning({ id: customRanking.id });

  await db.insert(customRankingEntry).values(
    validated.entries.map((e) => ({
      rankingId: created.id,
      fighterId: e.fighter_id,
      position: e.position,
      note: e.note?.trim() || null,
    })),
  );

  // Newly possible: first_ranking. Other slugs are no-ops here but the
  // helper is cheap and idempotent.
  const newlyUnlocked = await checkAndUnlockAchievements(myId);

  revalidatePath("/rankings");
  return { rankingId: created.id, newlyUnlocked };
}

export async function updateRankingAction(
  rankingId: string,
  formData: FormData,
): Promise<{ error?: string }> {
  const myId = await getMyProfileId();
  if (!myId) return { error: "Not signed in." };

  const existing = await db
    .select({ id: customRanking.id, userId: customRanking.userId })
    .from(customRanking)
    .where(eq(customRanking.id, rankingId))
    .limit(1);
  if (existing.length === 0) return { error: "Ranking not found." };
  if (existing[0].userId !== myId) return { error: "Not your ranking." };

  const title = String(formData.get("title") ?? "").trim();
  const description = String(formData.get("description") ?? "").trim();
  const entriesRaw = String(formData.get("entries") ?? "");

  if (title.length < TITLE_MIN || title.length > TITLE_MAX) {
    return { error: `Title must be ${TITLE_MIN}–${TITLE_MAX} chars.` };
  }
  if (description.length > DESC_MAX) {
    return { error: `Description must be under ${DESC_MAX} chars.` };
  }

  const validated = validateEntries(parseEntries(entriesRaw));
  if ("error" in validated) return { error: validated.error };

  await db
    .update(customRanking)
    .set({
      title,
      description: description || null,
      updatedAt: new Date(),
    })
    .where(eq(customRanking.id, rankingId));

  // Delete + reinsert is the simplest way to honor the (ranking, position)
  // unique constraint without juggling intermediate states.
  await db
    .delete(customRankingEntry)
    .where(eq(customRankingEntry.rankingId, rankingId));

  await db.insert(customRankingEntry).values(
    validated.entries.map((e) => ({
      rankingId,
      fighterId: e.fighter_id,
      position: e.position,
      note: e.note?.trim() || null,
    })),
  );

  revalidatePath(`/rankings/${rankingId}`);
  revalidatePath("/rankings");
  return {};
}

export async function deleteRankingAction(
  rankingId: string,
): Promise<{ error?: string; success?: boolean }> {
  const myId = await getMyProfileId();
  if (!myId) return { error: "Not signed in." };

  const existing = await db
    .select({ id: customRanking.id, userId: customRanking.userId })
    .from(customRanking)
    .where(eq(customRanking.id, rankingId))
    .limit(1);
  if (existing.length === 0) return { error: "Ranking not found." };
  if (existing[0].userId !== myId) return { error: "Not your ranking." };

  // FK cascade drops custom_ranking_entry rows.
  await db.delete(customRanking).where(eq(customRanking.id, rankingId));

  revalidatePath("/rankings");
  return { success: true };
}
