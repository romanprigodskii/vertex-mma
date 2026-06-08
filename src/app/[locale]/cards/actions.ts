"use server";

import { and, eq, sql } from "drizzle-orm";
import { revalidatePath } from "next/cache";

import {
  CARD_THEME_BACKGROUNDS,
  CARD_THEME_COLORS,
  CARD_THEME_FONTS,
  WEIGHT_CLASSES,
} from "@/lib/card-theme";
import { db } from "@/lib/db";
import {
  fightCard,
  fightCardLike,
  type FightCardBout,
} from "@/lib/db/schema/cards";
import { userProfile } from "@/lib/db/schema/users";
import { searchFighters } from "@/lib/fighter-search";
import { COOLDOWN_MS, allowAction } from "@/lib/rate-limit";
import { createClient } from "@/lib/supabase/server";
import { slugify } from "@/lib/utils";

const TITLE_MIN = 3;
const TITLE_MAX = 100;
const SUBTITLE_MAX = 120;
const MIN_BOUTS = 1;
const MAX_BOUTS = 15;

// Per-account creation caps so one user can't flood the table: the rate-limit
// blocks scripted bursts, the count cap bounds lifetime rows. Both surface as
// stable codes that fall back to the form's generic error message.
const CREATE_COOLDOWN_MS = 5_000;
const MAX_CARDS_PER_USER = 100;

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const WEIGHT_SET = new Set<string>(WEIGHT_CLASSES);

/** Postgres unique-violation (SQLSTATE 23505). postgres-js exposes `.code`. */
function isUniqueViolation(err: unknown): boolean {
  return (
    typeof err === "object" &&
    err !== null &&
    (err as { code?: unknown }).code === "23505"
  );
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
  // Authoring-only helper — gate behind sign-in so it isn't an open,
  // unauthenticated fighter-search endpoint.
  if (!(await getMyProfileId())) return [];
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

/** Clamp a free-text theme value to a known registry id. */
function clampToRegistry(
  value: string,
  allowed: ReadonlyArray<{ id: string }>,
  fallback: string,
): string {
  return allowed.some((a) => a.id === value) ? value : fallback;
}

function parseBouts(raw: string): FightCardBout[] | null {
  try {
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return null;
    const out: FightCardBout[] = [];
    parsed.forEach((b, i) => {
      if (typeof b !== "object" || b === null) return;
      const rec = b as Record<string, unknown>;
      if (
        typeof rec.fighterAId === "string" &&
        typeof rec.fighterBId === "string" &&
        typeof rec.weightClass === "string"
      ) {
        out.push({
          fighterAId: rec.fighterAId,
          fighterBId: rec.fighterBId,
          weightClass: rec.weightClass,
          isMain: rec.isMain === true,
          order: i,
        });
      }
    });
    return out;
  } catch {
    return null;
  }
}

// Server actions return stable, machine-readable error codes (never English
// prose). The client maps each code to a localized message — see
// `actionErrorMessage` in fight-card-form.tsx. Keep these in sync.
function validateBouts(
  bouts: FightCardBout[] | null,
): { error: string } | { bouts: FightCardBout[] } {
  if (!bouts || bouts.length < MIN_BOUTS) {
    return { error: "NO_BOUTS" };
  }
  if (bouts.length > MAX_BOUTS) {
    return { error: "TOO_MANY_BOUTS" };
  }
  for (const b of bouts) {
    if (!UUID_RE.test(b.fighterAId) || !UUID_RE.test(b.fighterBId)) {
      return { error: "BOUT_NEEDS_FIGHTERS" };
    }
    if (b.fighterAId === b.fighterBId) {
      return { error: "FIGHTER_VS_SELF" };
    }
    if (!WEIGHT_SET.has(b.weightClass)) {
      return { error: "INVALID_WEIGHT_CLASS" };
    }
  }
  if (bouts.filter((b) => b.isMain).length > 1) {
    return { error: "TOO_MANY_MAIN_EVENTS" };
  }
  // Normalize `order` to 0..N-1 in array order.
  return { bouts: bouts.map((b, i) => ({ ...b, order: i })) };
}

type CardFields = {
  title: string;
  subtitle: string | null;
  themeColor: string;
  titleFont: string;
  backgroundId: string;
  isPublic: boolean;
  bouts: FightCardBout[];
};

function readCardForm(
  formData: FormData,
): { error: string } | { fields: CardFields } {
  const title = String(formData.get("title") ?? "").trim();
  const subtitle = String(formData.get("subtitle") ?? "").trim();

  if (title.length < TITLE_MIN || title.length > TITLE_MAX) {
    return { error: "INVALID_TITLE" };
  }
  if (subtitle.length > SUBTITLE_MAX) {
    return { error: "INVALID_SUBTITLE" };
  }

  const validated = validateBouts(
    parseBouts(String(formData.get("bouts") ?? "")),
  );
  if ("error" in validated) return { error: validated.error };

  return {
    fields: {
      title,
      subtitle: subtitle || null,
      themeColor: clampToRegistry(
        String(formData.get("themeColor") ?? ""),
        CARD_THEME_COLORS,
        "primary",
      ),
      titleFont: clampToRegistry(
        String(formData.get("titleFont") ?? ""),
        CARD_THEME_FONTS,
        "display",
      ),
      backgroundId: clampToRegistry(
        String(formData.get("backgroundId") ?? ""),
        CARD_THEME_BACKGROUNDS,
        "default",
      ),
      isPublic: String(formData.get("isPublic") ?? "true") === "true",
      bouts: validated.bouts,
    },
  };
}

/** A title-derived slug plus a short random tail, checked for collisions. */
async function uniqueSlug(title: string): Promise<string> {
  const base = slugify(title).slice(0, 60) || "fight-card";
  for (let attempt = 0; attempt < 6; attempt++) {
    const candidate = `${base}-${Math.random().toString(36).slice(2, 8)}`;
    const existing = await db
      .select({ id: fightCard.id })
      .from(fightCard)
      .where(eq(fightCard.slug, candidate))
      .limit(1);
    if (existing.length === 0) return candidate;
  }
  return `${base}-${Date.now().toString(36)}`;
}

export async function createFightCardAction(
  formData: FormData,
): Promise<{ error?: string; slug?: string }> {
  const myId = await getMyProfileId();
  if (!myId) return { error: "NOT_SIGNED_IN" };

  if (!allowAction(`card-create:${myId}`, CREATE_COOLDOWN_MS)) {
    // TODO(audit i18n: errRateLimited) — generic fallback for now.
    return { error: "RATE_LIMITED" };
  }
  const countRows = (await db.execute<{ c: number }>(sql`
    SELECT COUNT(*)::int AS c FROM fight_card WHERE user_id = ${myId}::uuid
  `)) as unknown as Array<{ c: number }>;
  if ((countRows[0]?.c ?? 0) >= MAX_CARDS_PER_USER) {
    // TODO(audit i18n: errTooManyCards) — generic fallback for now.
    return { error: "TOO_MANY_CARDS" };
  }

  const parsed = readCardForm(formData);
  if ("error" in parsed) return { error: parsed.error };
  const f = parsed.fields;

  // uniqueSlug pre-checks for a free slug, but a concurrent insert can still
  // claim the same candidate between that check and our INSERT. Retry on a slug
  // unique-violation with a freshly generated slug rather than surfacing a 500;
  // give up with a clean code if it somehow never settles.
  for (let attempt = 0; attempt < 5; attempt++) {
    const slug = await uniqueSlug(f.title);
    try {
      await db.insert(fightCard).values({
        userId: myId,
        slug,
        title: f.title,
        subtitle: f.subtitle,
        themeColor: f.themeColor,
        titleFont: f.titleFont,
        backgroundId: f.backgroundId,
        isPublic: f.isPublic,
        bouts: f.bouts,
      });
      revalidatePath("/cards");
      return { slug };
    } catch (err) {
      if (isUniqueViolation(err) && attempt < 4) continue;
      if (isUniqueViolation(err)) {
        // TODO(audit i18n: errSlugCollision) — generic fallback for now.
        return { error: "SLUG_COLLISION" };
      }
      throw err;
    }
  }
  // TODO(audit i18n: errSlugCollision) — generic fallback for now.
  return { error: "SLUG_COLLISION" };
}

export async function updateFightCardAction(
  cardId: string,
  formData: FormData,
): Promise<{ error?: string; slug?: string }> {
  const myId = await getMyProfileId();
  if (!myId) return { error: "NOT_SIGNED_IN" };
  if (!UUID_RE.test(cardId)) return { error: "CARD_NOT_FOUND" };

  const existing = await db
    .select({
      id: fightCard.id,
      userId: fightCard.userId,
      slug: fightCard.slug,
    })
    .from(fightCard)
    .where(eq(fightCard.id, cardId))
    .limit(1);
  if (existing.length === 0) return { error: "CARD_NOT_FOUND" };
  if (existing[0].userId !== myId) return { error: "NOT_YOUR_CARD" };

  const parsed = readCardForm(formData);
  if ("error" in parsed) return { error: parsed.error };
  const f = parsed.fields;

  // The slug is generated once at creation and never changes, so links
  // already shared keep resolving.
  await db
    .update(fightCard)
    .set({
      title: f.title,
      subtitle: f.subtitle,
      themeColor: f.themeColor,
      titleFont: f.titleFont,
      backgroundId: f.backgroundId,
      isPublic: f.isPublic,
      bouts: f.bouts,
      updatedAt: new Date(),
    })
    .where(eq(fightCard.id, cardId));

  revalidatePath("/cards");
  revalidatePath(`/cards/${existing[0].slug}`);
  return { slug: existing[0].slug };
}

export async function deleteFightCardAction(
  cardId: string,
): Promise<{ error?: string; success?: boolean }> {
  const myId = await getMyProfileId();
  if (!myId) return { error: "NOT_SIGNED_IN" };
  if (!UUID_RE.test(cardId)) return { error: "CARD_NOT_FOUND" };

  const existing = await db
    .select({ id: fightCard.id, userId: fightCard.userId })
    .from(fightCard)
    .where(eq(fightCard.id, cardId))
    .limit(1);
  if (existing.length === 0) return { error: "CARD_NOT_FOUND" };
  if (existing[0].userId !== myId) return { error: "NOT_YOUR_CARD" };

  // FK cascade drops fight_card_like rows.
  await db.delete(fightCard).where(eq(fightCard.id, cardId));

  revalidatePath("/cards");
  return { success: true };
}

export async function toggleLikeAction(
  cardId: string,
): Promise<{ error?: string; liked?: boolean; likeCount?: number }> {
  const myId = await getMyProfileId();
  if (!myId) return { error: "SIGN_IN_TO_LIKE" };
  if (!allowAction(`like:${myId}`, COOLDOWN_MS.like)) {
    return { error: "RATE_LIMITED" };
  }
  if (!UUID_RE.test(cardId)) return { error: "CARD_NOT_FOUND" };

  const card = await db
    .select({ id: fightCard.id, slug: fightCard.slug })
    .from(fightCard)
    .where(eq(fightCard.id, cardId))
    .limit(1);
  if (card.length === 0) return { error: "CARD_NOT_FOUND" };

  const existing = await db
    .select({ userId: fightCardLike.userId })
    .from(fightCardLike)
    .where(
      and(
        eq(fightCardLike.userId, myId),
        eq(fightCardLike.fightCardId, cardId),
      ),
    )
    .limit(1);

  const liked = existing.length === 0;
  if (liked) {
    await db
      .insert(fightCardLike)
      .values({ userId: myId, fightCardId: cardId })
      .onConflictDoNothing();
  } else {
    await db
      .delete(fightCardLike)
      .where(
        and(
          eq(fightCardLike.userId, myId),
          eq(fightCardLike.fightCardId, cardId),
        ),
      );
  }

  // Recompute the denormalized counter from the join table — race-safe.
  const countRows = (await db.execute<{ c: number }>(sql`
    SELECT COUNT(*)::int AS c
    FROM fight_card_like
    WHERE fight_card_id = ${cardId}::uuid
  `)) as unknown as Array<{ c: number }>;
  const likeCount = countRows[0]?.c ?? 0;
  await db
    .update(fightCard)
    .set({ likeCount })
    .where(eq(fightCard.id, cardId));

  revalidatePath("/cards");
  revalidatePath(`/cards/${card[0].slug}`);
  return { liked, likeCount };
}
