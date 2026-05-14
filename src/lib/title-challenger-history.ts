/**
 * Curated list of UFC fighters who lost a championship fight without ever
 * winning one. Feeds the Vertex Score's Championship Pedigree component for
 * fighters who never held a belt but were close — Cerrone, Ortega, Vera,
 * Suarez, etc.
 *
 * Fighters who lost a title fight AND later won a belt (Pena, Adesanya, etc.)
 * are tracked in `championship-history.ts` and should NOT appear here. The
 * pedigree computation prefers "former champion" (80) over "lost challenger"
 * (40) — so duplicates would be harmless but misleading.
 *
 * Scope (Wave 3.5 step 1): notable challengers from 2010+ where the fighter
 * is in our DB. Pre-2010 challengers (Jens Pulver, Pete Sell, etc.) are
 * skipped — limited coverage value at this stage.
 *
 * TODO Wave 3.5+: extend to include all UFC title challengers in DB once we
 * have a per-bout title-fight ground truth (see `title-fights.ts`).
 */

import type { WeightClass } from "./championship-history";

export interface TitleChallenge {
  slug: string;
  weightClass: WeightClass;
  /** Date of the title fight (ISO yyyy-mm-dd). */
  date: string;
  /** "lost" — fighter never won a UFC belt. Wins live in championship-history.ts. */
  result: "lost";
}

export const TITLE_CHALLENGES: readonly TitleChallenge[] = [
  // ===== Welterweight =====
  { slug: "demian-maia-427b59",       weightClass: "welterweight", date: "2017-07-29", result: "lost" }, // UFC 214 vs Woodley
  { slug: "jon-fitch-6f018c",         weightClass: "welterweight", date: "2008-08-09", result: "lost" }, // UFC 87 vs GSP
  { slug: "thiago-alves-31ee47",      weightClass: "welterweight", date: "2009-07-11", result: "lost" }, // UFC 100 vs GSP
  { slug: "colby-covington-dc9572",   weightClass: "welterweight", date: "2019-12-14", result: "lost" }, // UFC 245 vs Usman
  { slug: "colby-covington-dc9572",   weightClass: "welterweight", date: "2021-11-06", result: "lost" }, // UFC 268 vs Usman
  { slug: "colby-covington-dc9572",   weightClass: "welterweight", date: "2023-12-16", result: "lost" }, // UFC 296 vs Edwards
  { slug: "jorge-masvidal-47b9e0",    weightClass: "welterweight", date: "2020-07-11", result: "lost" }, // UFC 251 vs Usman
  { slug: "jorge-masvidal-47b9e0",    weightClass: "welterweight", date: "2021-04-24", result: "lost" }, // UFC 261 vs Usman

  // ===== Middleweight =====
  { slug: "demian-maia-427b59",       weightClass: "middleweight", date: "2010-04-10", result: "lost" }, // UFC 112 vs Anderson
  { slug: "kelvin-gastelum-8c0580",   weightClass: "middleweight", date: "2019-04-13", result: "lost" }, // UFC 236 (interim) vs Adesanya

  // ===== Light Heavyweight =====
  { slug: "anthony-johnson-365fee",   weightClass: "light_heavyweight", date: "2015-05-23", result: "lost" }, // UFC 187 vs DC
  { slug: "anthony-johnson-365fee",   weightClass: "light_heavyweight", date: "2017-04-08", result: "lost" }, // UFC 210 vs DC
  { slug: "aleksandar-rakic-333b9e",  weightClass: "light_heavyweight", date: "2022-05-07", result: "lost" }, // UFC 274 vs Blachowicz — actually #1 contender, not title. Trimmed.

  // ===== Heavyweight =====
  { slug: "travis-browne-3236bf",     weightClass: "heavyweight", date: "2015-09-05", result: "lost" }, // UFC 191? Browne never had a HW title shot. Trimmed below.

  // ===== Lightweight =====
  { slug: "donald-cerrone-1d0075",    weightClass: "lightweight", date: "2015-12-19", result: "lost" }, // UFC FN 80 vs RDA
  { slug: "renato-moicano-b64527",    weightClass: "lightweight", date: "2025-01-18", result: "lost" }, // UFC 311 vs Makhachev

  // ===== Featherweight =====
  { slug: "chad-mendes-b5b684",       weightClass: "featherweight", date: "2012-01-14", result: "lost" }, // UFC 142 vs Aldo
  { slug: "chad-mendes-b5b684",       weightClass: "featherweight", date: "2014-10-25", result: "lost" }, // UFC 179 vs Aldo
  { slug: "chad-mendes-b5b684",       weightClass: "featherweight", date: "2015-07-11", result: "lost" }, // UFC 189 (interim) vs McGregor
  { slug: "brian-ortega-def816",      weightClass: "featherweight", date: "2018-12-08", result: "lost" }, // UFC 231 vs Holloway
  { slug: "brian-ortega-def816",      weightClass: "featherweight", date: "2021-09-25", result: "lost" }, // UFC 266 vs Volk
  { slug: "yair-rodriguez-cbf5e6",    weightClass: "featherweight", date: "2023-07-08", result: "lost" }, // UFC 290 vs Volk
  { slug: "diego-lopes-f166e9",       weightClass: "featherweight", date: "2025-04-12", result: "lost" }, // UFC 314 vs Volk
  { slug: "diego-lopes-f166e9",       weightClass: "featherweight", date: "2026-01-31", result: "lost" }, // UFC 325 vs Volk

  // ===== Bantamweight =====
  { slug: "marlon-vera-7c7332",       weightClass: "bantamweight", date: "2024-03-09", result: "lost" }, // UFC 299 vs O'Malley
  { slug: "cory-sandhagen-65f09b",    weightClass: "bantamweight", date: "2021-10-30", result: "lost" }, // UFC 267 (interim) vs Yan

  // ===== Flyweight =====
  { slug: "joseph-benavidez-80eacd",  weightClass: "flyweight", date: "2012-09-22", result: "lost" }, // UFC 152 (inaugural) vs DJ
  { slug: "joseph-benavidez-80eacd",  weightClass: "flyweight", date: "2013-12-14", result: "lost" }, // UFC on Fox 9 vs DJ
  { slug: "joseph-benavidez-80eacd",  weightClass: "flyweight", date: "2020-02-29", result: "lost" }, // UFC FN 169 vs Figgy
  { slug: "joseph-benavidez-80eacd",  weightClass: "flyweight", date: "2020-07-18", result: "lost" }, // UFC FN 172 vs Figgy 2
  { slug: "taila-santos-f74671",      weightClass: "flyweight", date: "2022-06-11", result: "lost" }, // UFC 275 vs Shevchenko
  { slug: "manon-fiorot-34ff30",      weightClass: "flyweight", date: "2025-05-10", result: "lost" }, // UFC 315 vs Shevchenko

  // ===== Strawweight =====
  { slug: "tatiana-suarez-b08012",    weightClass: "strawweight", date: "2025-02-08", result: "lost" }, // UFC 312 vs Zhang
  { slug: "yan-xiaonan-c41d42",       weightClass: "strawweight", date: "2024-04-13", result: "lost" }, // UFC 300 vs Zhang

  // ===== Women's BW (uses bantamweight enum) =====
  { slug: "liz-carmouche-51a0c0",     weightClass: "bantamweight", date: "2013-02-23", result: "lost" }, // UFC 157 vs Rousey
  { slug: "sara-mcmann-7be74a",       weightClass: "bantamweight", date: "2014-02-22", result: "lost" }, // UFC 170 vs Rousey
  { slug: "cat-zingano-3ecd93",       weightClass: "bantamweight", date: "2015-02-28", result: "lost" }, // UFC 184 vs Rousey

  // ===== Women's FlyW (uses flyweight enum) =====
  { slug: "liz-carmouche-51a0c0",     weightClass: "flyweight", date: "2019-08-10", result: "lost" }, // UFC FN vs Shevchenko
];

// Drop the two trimmed entries above (Rakic and Browne — neither was a real
// title shot). Hard-filtering at the export keeps the source rows visible as
// breadcrumbs of what was *considered* and *excluded*.
const TRIMMED_SLUGS_AND_DATES = new Set([
  "aleksandar-rakic-333b9e:2022-05-07",
  "travis-browne-3236bf:2015-09-05",
]);

const ACTIVE_CHALLENGES = TITLE_CHALLENGES.filter(
  (c) => !TRIMMED_SLUGS_AND_DATES.has(`${c.slug}:${c.date}`),
);

const CHALLENGES_BY_SLUG: ReadonlyMap<string, TitleChallenge[]> = (() => {
  const m = new Map<string, TitleChallenge[]>();
  for (const c of ACTIVE_CHALLENGES) {
    const cur = m.get(c.slug) ?? [];
    cur.push(c);
    m.set(c.slug, cur);
  }
  return m;
})();

/** Number of lost title fights for a fighter who never won a belt. */
export function lostTitleChallenges(slug: string): number {
  return CHALLENGES_BY_SLUG.get(slug)?.length ?? 0;
}

/** Slug list of every fighter who has at least one lost title fight on
 *  record (used by the pedigree-population script). */
export function allChallengerSlugs(): string[] {
  return Array.from(CHALLENGES_BY_SLUG.keys());
}
