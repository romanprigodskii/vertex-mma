"use server";

import { eq, inArray } from "drizzle-orm";
import { revalidatePath } from "next/cache";

import { checkAndUnlockAchievements } from "@/lib/achievements";
import { db } from "@/lib/db";
import { fighter } from "@/lib/db/schema/fighters";
import {
  customRanking,
  customRankingEntry,
} from "@/lib/db/schema/rankings";
import { userProfile } from "@/lib/db/schema/users";
import { searchFighters } from "@/lib/fighter-search";
import { createClient } from "@/lib/supabase/server";

import { RANKING_LIMITS, RankingError } from "./ranking-constants";

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const { TITLE_MIN, TITLE_MAX, DESC_MAX, NOTE_MAX, MIN_ENTRIES, MAX_ENTRIES } =
  RANKING_LIMITS;

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
        typeof (e as { position: unknown }).position === "number" &&
        // Honor the `note?: string | null` contract: a non-string note (crafted
        // payload) would otherwise reach e.note.trim() and throw a raw 500.
        ((e as { note?: unknown }).note == null ||
          typeof (e as { note: unknown }).note === "string"),
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
    // `r.name_en` is already locale-resolved: searchFighters aliases
    // localizedNameSql(...) AS name_en, so this carries the Russian name on the
    // RU site (falling back to English when name_ru is null). Saved entries and
    // the public view re-resolve the same way via getRankingById.
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
    return { error: RankingError.NO_FIGHTERS };
  }
  if (entries.length > MAX_ENTRIES) {
    return { error: RankingError.TOO_MANY_FIGHTERS };
  }
  const ids = new Set(entries.map((e) => e.fighter_id));
  if (ids.size !== entries.length) {
    return { error: RankingError.DUPLICATE_FIGHTER };
  }
  for (const e of entries) {
    if (e.note && e.note.length > NOTE_MAX) {
      return { error: RankingError.NOTE_LENGTH };
    }
  }
  // Server normalizes positions to 1..N regardless of client input order.
  const sorted = [...entries]
    .sort((a, b) => a.position - b.position)
    .map((e, i) => ({ ...e, position: i + 1 }));
  return { entries: sorted };
}

/**
 * Guard the fighter_id values before they hit the uuid FK column. Without this,
 * a malformed id ("not-a-uuid") or a stale/nonexistent id surfaces as a raw 500
 * (invalid uuid syntax / FK violation) instead of a clean validation error. The
 * existence check is a single batched query — entries are already de-duped by
 * fighter_id in validateEntries, so a count mismatch means at least one is gone.
 */
async function verifyFighters(
  ids: string[],
): Promise<{ error: string } | null> {
  if (ids.some((id) => !UUID_RE.test(id))) {
    return { error: RankingError.INVALID_FIGHTER };
  }
  const found = await db
    .select({ id: fighter.id })
    .from(fighter)
    .where(inArray(fighter.id, ids));
  if (found.length !== ids.length) {
    return { error: RankingError.FIGHTER_MISSING };
  }
  return null;
}

export async function createRankingAction(
  formData: FormData,
): Promise<{ error?: string; rankingId?: string; newlyUnlocked?: string[] }> {
  const myId = await getMyProfileId();
  if (!myId) return { error: RankingError.NOT_SIGNED_IN };

  const title = String(formData.get("title") ?? "").trim();
  const description = String(formData.get("description") ?? "").trim();
  const entriesRaw = String(formData.get("entries") ?? "");

  if (title.length < TITLE_MIN || title.length > TITLE_MAX) {
    return { error: RankingError.TITLE_LENGTH };
  }
  if (description.length > DESC_MAX) {
    return { error: RankingError.DESCRIPTION_LENGTH };
  }

  const validated = validateEntries(parseEntries(entriesRaw));
  if ("error" in validated) return { error: validated.error };

  const fighterError = await verifyFighters(
    validated.entries.map((e) => e.fighter_id),
  );
  if (fighterError) return fighterError;

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
  if (!myId) return { error: RankingError.NOT_SIGNED_IN };

  const existing = await db
    .select({ id: customRanking.id, userId: customRanking.userId })
    .from(customRanking)
    .where(eq(customRanking.id, rankingId))
    .limit(1);
  if (existing.length === 0) return { error: RankingError.RANKING_NOT_FOUND };
  if (existing[0].userId !== myId) return { error: RankingError.NOT_OWNER };

  const title = String(formData.get("title") ?? "").trim();
  const description = String(formData.get("description") ?? "").trim();
  const entriesRaw = String(formData.get("entries") ?? "");

  if (title.length < TITLE_MIN || title.length > TITLE_MAX) {
    return { error: RankingError.TITLE_LENGTH };
  }
  if (description.length > DESC_MAX) {
    return { error: RankingError.DESCRIPTION_LENGTH };
  }

  const validated = validateEntries(parseEntries(entriesRaw));
  if ("error" in validated) return { error: validated.error };

  const fighterError = await verifyFighters(
    validated.entries.map((e) => e.fighter_id),
  );
  if (fighterError) return fighterError;

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
  if (!myId) return { error: RankingError.NOT_SIGNED_IN };

  const existing = await db
    .select({ id: customRanking.id, userId: customRanking.userId })
    .from(customRanking)
    .where(eq(customRanking.id, rankingId))
    .limit(1);
  if (existing.length === 0) return { error: RankingError.RANKING_NOT_FOUND };
  if (existing[0].userId !== myId) return { error: RankingError.NOT_OWNER };

  // FK cascade drops custom_ranking_entry rows.
  await db.delete(customRanking).where(eq(customRanking.id, rankingId));

  revalidatePath("/rankings");
  return { success: true };
}
