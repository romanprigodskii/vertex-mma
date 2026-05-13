/**
 * Current UFC champions as of 2026-05-13.
 *
 * The roster reality is intentionally in flux — Islam vacated LW after moving
 * to WW, Topuria has been bouncing between LW and FW, and the strawweight
 * picture is contested. Where the DB's `weight_class_primary` and the latest
 * news disagree, we keep the DB slug authoritative and label the strip
 * division per the user's spec, with `// TODO verify` for the user to resolve
 * manually post-build. Don't silently overwrite — the misalignment is real.
 *
 * `slug` must match `fighter.slug` exactly. If a fighter row is missing at
 * runtime, the strip renders a "TBD" placeholder for that slot instead of
 * crashing.
 */

export interface ChampionEntry {
  slug: string;
  division: string;
  divisionShort: string;
  isInterim?: boolean;
}

export const CURRENT_CHAMPIONS: readonly ChampionEntry[] = [
  { slug: "tom-aspinall-399afb", division: "Heavyweight", divisionShort: "HW" },
  {
    slug: "alex-pereira-e5549c",
    division: "Light Heavyweight",
    divisionShort: "LHW",
  },
  {
    slug: "khamzat-chimaev-767755",
    division: "Middleweight",
    divisionShort: "MW",
  },
  // TODO verify: spec says Islam moved up to WW; DB still has him at LW.
  {
    slug: "islam-makhachev-275aca",
    division: "Welterweight",
    divisionShort: "WW",
  },
  // TODO verify: spec said Topuria vacated LW; if he's still active LW champ
  // delete this entry and Gaethje's interim status. If he moved back to FW,
  // swap with Volk below.
  {
    slug: "ilia-topuria-54f64b",
    division: "Lightweight",
    divisionShort: "LW",
  },
  // Interim per spec (Islam vacated LW).
  {
    slug: "justin-gaethje-9e8f6c",
    division: "Lightweight",
    divisionShort: "LW",
    isInterim: true,
  },
  // TODO verify: spec said Volk reclaimed FW after Topuria vacated. DB has
  // both Volk and Topuria at FW — keeping Volk at FW since user said
  // "if both are listed, pick the most recent" and Volk reclaimed.
  {
    slug: "alexander-volkanovski-e12489",
    division: "Featherweight",
    divisionShort: "FW",
  },
  { slug: "petr-yan-d661ce", division: "Bantamweight", divisionShort: "BW" },
  { slug: "joshua-van-17e976", division: "Flyweight", divisionShort: "FLW" },
  // Women's
  {
    slug: "zhang-weili-1ebe20",
    division: "Women's Strawweight",
    divisionShort: "W-SW",
  },
  {
    slug: "valentina-shevchenko-132deb",
    division: "Women's Flyweight",
    divisionShort: "W-FLW",
  },
  // TODO verify: DB has Dern at SW (same as Zhang Weili). If Dern is the
  // W-BW champion instead, edit divisionShort to W-BW. If she shouldn't be
  // in this list at all, remove the entry.
  {
    slug: "mackenzie-dern-7447e9",
    division: "Women's Bantamweight",
    divisionShort: "W-BW",
  },
];

export const CHAMPION_SLUGS: readonly string[] = CURRENT_CHAMPIONS.map(
  (c) => c.slug,
);

/** Quick lookup by slug for the strip rendering path. */
export const CHAMPION_BY_SLUG: Map<string, ChampionEntry> = new Map(
  CURRENT_CHAMPIONS.map((c) => [c.slug, c]),
);
