/**
 * User tier system. Auto-promotes based on lifetime `total_coins_earned`.
 *
 * Thresholds and bonuses MUST stay in sync with the PL/pgSQL helper
 * `check_and_promote_tier` (migration 0065). The Postgres CASE expression
 * is the single source of truth at write-time; this file is the source
 * of truth at render-time (e.g. daily-bonus button label).
 *
 * Uses the existing `user_tier` enum: bronze / silver / gold / diamond /
 * champion. (No `platinum` — keeping the schema's enum order.)
 */

export type Tier = "bronze" | "silver" | "gold" | "diamond" | "champion";

export const TIER_ORDER: readonly Tier[] = [
  "bronze",
  "silver",
  "gold",
  "diamond",
  "champion",
] as const;

export const TIER_THRESHOLDS: Record<Tier, number> = {
  bronze: 0,
  silver: 50_000,
  gold: 200_000,
  diamond: 500_000,
  champion: 1_000_000,
};

export const TIER_DAILY_BONUS: Record<Tier, number> = {
  bronze: 500,
  silver: 750,
  gold: 1_000,
  diamond: 1_500,
  champion: 2_000,
};

export const TIER_LABEL: Record<Tier, string> = {
  bronze: "Bronze",
  silver: "Silver",
  gold: "Gold",
  diamond: "Diamond",
  champion: "Champion",
};

export function isTier(value: string): value is Tier {
  return (TIER_ORDER as readonly string[]).includes(value);
}

export function tierFromTotalEarned(total: number): Tier {
  if (total >= TIER_THRESHOLDS.champion) return "champion";
  if (total >= TIER_THRESHOLDS.diamond) return "diamond";
  if (total >= TIER_THRESHOLDS.gold) return "gold";
  if (total >= TIER_THRESHOLDS.silver) return "silver";
  return "bronze";
}

export function nextTier(
  current: Tier,
): { tier: Tier; threshold: number } | null {
  const idx = TIER_ORDER.indexOf(current);
  if (idx < 0 || idx >= TIER_ORDER.length - 1) return null;
  const next = TIER_ORDER[idx + 1];
  return { tier: next, threshold: TIER_THRESHOLDS[next] };
}

export function dailyBonusAmount(tier: Tier | string): number {
  if (isTier(tier)) return TIER_DAILY_BONUS[tier];
  return TIER_DAILY_BONUS.bronze;
}
