// Shared validation limits + machine error codes for custom rankings.
//
// Kept in a plain (non-"use server") module so it can be imported by BOTH the
// server action (`actions.ts`, which validates and returns a code) and the
// client form (`ranking-form.tsx`, which translates the code for display).
// Co-locating the limits here keeps the server validation, the client-side
// error copy, and the input `maxLength` attributes in lockstep — change a bound
// in one place and every surface follows.

export const RANKING_LIMITS = {
  TITLE_MIN: 3,
  TITLE_MAX: 100,
  DESC_MAX: 500,
  NOTE_MAX: 200,
  MIN_ENTRIES: 1,
  MAX_ENTRIES: 25,
} as const;

/**
 * Stable machine codes returned by the ranking server actions. The client maps
 * each code to a localized message (see `translateRankingError` in the form),
 * so the user never sees a hardcoded English sentence and callers branch on a
 * stable token rather than translated prose.
 */
export const RankingError = {
  NOT_SIGNED_IN: "NOT_SIGNED_IN",
  RANKING_NOT_FOUND: "RANKING_NOT_FOUND",
  NOT_OWNER: "NOT_OWNER",
  TITLE_LENGTH: "TITLE_LENGTH",
  DESCRIPTION_LENGTH: "DESCRIPTION_LENGTH",
  NO_FIGHTERS: "NO_FIGHTERS",
  TOO_MANY_FIGHTERS: "TOO_MANY_FIGHTERS",
  DUPLICATE_FIGHTER: "DUPLICATE_FIGHTER",
  NOTE_LENGTH: "NOTE_LENGTH",
  INVALID_FIGHTER: "INVALID_FIGHTER",
  FIGHTER_MISSING: "FIGHTER_MISSING",
} as const;

export type RankingErrorCode =
  (typeof RankingError)[keyof typeof RankingError];
