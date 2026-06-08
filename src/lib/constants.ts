export const WEIGHT_CLASSES = [
  { id: "strawweight", label: "Strawweight", limitLb: 115 },
  { id: "flyweight", label: "Flyweight", limitLb: 125 },
  { id: "bantamweight", label: "Bantamweight", limitLb: 135 },
  { id: "featherweight", label: "Featherweight", limitLb: 145 },
  { id: "lightweight", label: "Lightweight", limitLb: 155 },
  { id: "welterweight", label: "Welterweight", limitLb: 170 },
  { id: "middleweight", label: "Middleweight", limitLb: 185 },
  { id: "light_heavyweight", label: "Light Heavyweight", limitLb: 205 },
  { id: "heavyweight", label: "Heavyweight", limitLb: 265 },
] as const;

export type WeightClassId = (typeof WEIGHT_CLASSES)[number]["id"];

export const METHODS = [
  { id: "KO", label: "KO" },
  { id: "TKO", label: "TKO" },
  { id: "SUB", label: "Submission" },
  { id: "DEC_U", label: "Decision (Unanimous)" },
  { id: "DEC_S", label: "Decision (Split)" },
  { id: "DEC_M", label: "Decision (Majority)" },
  { id: "DQ", label: "Disqualification" },
  { id: "NC", label: "No Contest" },
] as const;

export type MethodId = (typeof METHODS)[number]["id"];

// ids mirror boutStatusEnum (db/schema/enums.ts) so BoutStatusId stays a valid
// key for real DB rows — the old "live"/"finished" never matched any status.
export const BOUT_STATUSES = [
  { id: "scheduled", label: "Scheduled" },
  { id: "in_progress", label: "In progress" },
  { id: "completed", label: "Completed" },
  { id: "cancelled", label: "Cancelled" },
  { id: "no_contest", label: "No contest" },
] as const;

export type BoutStatusId = (typeof BOUT_STATUSES)[number]["id"];

export const TIER_LEVELS = [
  { id: "bronze", label: "Bronze", colorVar: "--color-tier-bronze" },
  { id: "silver", label: "Silver", colorVar: "--color-tier-silver" },
  { id: "gold", label: "Gold", colorVar: "--color-tier-gold" },
  { id: "diamond", label: "Diamond", colorVar: "--color-tier-diamond" },
  { id: "champion", label: "Champion", colorVar: "--color-tier-champion" },
] as const;

export type TierId = (typeof TIER_LEVELS)[number]["id"];
