/**
 * Current UFC champions — DERIVED from championship-history.ts.
 *
 * This strip used to be a hand-maintained list and drifted out of sync with the
 * authoritative reign data (it listed Pereira/Chimaev/Zhang as champions after
 * they'd lost or vacated, and mislabeled Dern). It's now generated from the
 * single source of truth: a fighter is a current champion iff they hold an open
 * reign (`endDate === null`) — the exact same predicate vertex-tier.ts uses for
 * the "active champion" crown, so the profile-hero trophy badge and the card
 * crown can no longer disagree.
 *
 * championship-history.ts reuses the men's `WeightClass` enum for the women's
 * divisions (women's bantamweight → `bantamweight`, etc.), so the display label
 * and the men's/women's distinction can't be recovered from `weightClass`
 * alone. Men's labels are mapped per weight class below; the women's champions
 * are resolved by slug via an explicit override.
 *
 * `slug` matches `fighter.slug`. If a fighter row is missing at runtime, the
 * strip renders a "TBD" placeholder for that slot instead of crashing.
 */

import { CHAMPIONSHIP_HISTORY, type WeightClass } from "./championship-history";

export interface ChampionEntry {
  slug: string;
  division: string;
  divisionShort: string;
  isInterim?: boolean;
}

interface DivisionLabel {
  division: string;
  divisionShort: string;
}

// Men's division labels keyed by the championship-history WeightClass enum.
const MENS_DIVISION: Record<WeightClass, DivisionLabel> = {
  heavyweight: { division: "Heavyweight", divisionShort: "HW" },
  light_heavyweight: { division: "Light Heavyweight", divisionShort: "LHW" },
  middleweight: { division: "Middleweight", divisionShort: "MW" },
  welterweight: { division: "Welterweight", divisionShort: "WW" },
  lightweight: { division: "Lightweight", divisionShort: "LW" },
  featherweight: { division: "Featherweight", divisionShort: "FW" },
  bantamweight: { division: "Bantamweight", divisionShort: "BW" },
  flyweight: { division: "Flyweight", divisionShort: "FLW" },
  strawweight: { division: "Strawweight", divisionShort: "SW" },
};

// Women's champions share the men's WeightClass enum, so their gendered label is
// resolved by slug. Keep in sync with the women's open reigns in
// championship-history.ts (W-BW / W-FLW / W-SW).
const WOMENS_DIVISION: Record<string, DivisionLabel | undefined> = {
  "kayla-harrison-1af117": {
    division: "Women's Bantamweight",
    divisionShort: "W-BW",
  },
  "valentina-shevchenko-132deb": {
    division: "Women's Flyweight",
    divisionShort: "W-FLW",
  },
  "mackenzie-dern-7447e9": {
    division: "Women's Strawweight",
    divisionShort: "W-SW",
  },
};

/**
 * Every fighter holding an open reign (`endDate === null`), in
 * championship-history.ts order (heaviest men's division first, then women's).
 * Derived — do not hand-edit; fix the reign data in championship-history.ts.
 */
export const CURRENT_CHAMPIONS: readonly ChampionEntry[] = CHAMPIONSHIP_HISTORY
  .filter((reign) => reign.endDate === null)
  .map((reign): ChampionEntry => {
    const label = WOMENS_DIVISION[reign.slug] ?? MENS_DIVISION[reign.weightClass];
    const entry: ChampionEntry = {
      slug: reign.slug,
      division: label.division,
      divisionShort: label.divisionShort,
    };
    if (reign.isInterim) entry.isInterim = true;
    return entry;
  });

export const CHAMPION_SLUGS: readonly string[] = CURRENT_CHAMPIONS.map(
  (c) => c.slug,
);

/** Quick lookup by slug for the strip rendering path. */
export const CHAMPION_BY_SLUG: Map<string, ChampionEntry> = new Map(
  CURRENT_CHAMPIONS.map((c) => [c.slug, c]),
);
