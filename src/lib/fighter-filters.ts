import { WEIGHT_CLASSES } from "@/lib/constants";
import type {
  CatalogSort,
  CatalogTierFilter,
  FighterCatalogFilters,
} from "@/lib/fighter-search";

const VALID_SORTS: ReadonlySet<CatalogSort> = new Set([
  "vertex_current",
  "vertex_all_time",
  "elite_first",
  "all_time",
  "champions_first",
  "fights",
  "recent",
  "wins",
  "winrate",
  "name_asc",
  "name_desc",
]);

const VALID_TIERS: ReadonlySet<CatalogTierFilter> = new Set([
  "all",
  "champion",
  "elite",
  "contender",
  "pro",
  "veteran",
]);

const VALID_WEIGHTS = new Set(WEIGHT_CLASSES.map((w) => w.id as string));
const VALID_STANCES = new Set(["orthodox", "southpaw", "switch", "unknown"]);
const VALID_STATUSES = new Set(["all", "active", "retired", "inactive"]);

function parseList(raw: string | null | undefined): string[] {
  if (!raw) return [];
  return raw
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

function parseBool(raw: string | null | undefined): boolean {
  return raw === "1" || raw === "true";
}

/**
 * Parse a URLSearchParams-like surface into FighterCatalogFilters with
 * all values validated against known enums. Unknown values are silently dropped.
 */
export function parseCatalogFilters(
  params: URLSearchParams | Record<string, string | string[] | undefined>,
): FighterCatalogFilters {
  const get = (key: string): string | null => {
    if (params instanceof URLSearchParams) return params.get(key);
    const value = params[key];
    if (Array.isArray(value)) return value[0] ?? null;
    return value ?? null;
  };

  const weight = parseList(get("weight")).filter((w) => VALID_WEIGHTS.has(w));
  const stance = parseList(get("stance")).filter((s) => VALID_STANCES.has(s));
  const country = parseList(get("country"))
    .map((c) => c.toUpperCase())
    .filter((c) => c.length === 2);

  const rawStatus = get("status");
  const status = rawStatus && VALID_STATUSES.has(rawStatus)
    ? (rawStatus as FighterCatalogFilters["status"])
    : "all";

  const rawSort = get("sort");
  // Default sort is Vertex Score (current) as of Wave 3.5 step 4A. Old URLs
  // with `sort=winrate` etc. continue to work via VALID_SORTS lookup.
  const sort: CatalogSort =
    rawSort && VALID_SORTS.has(rawSort as CatalogSort)
      ? (rawSort as CatalogSort)
      : "vertex_current";

  const rawTier = get("tier");
  const tier: CatalogTierFilter =
    rawTier && VALID_TIERS.has(rawTier as CatalogTierFilter)
      ? (rawTier as CatalogTierFilter)
      : "all";

  const rawLimit = Number.parseInt(get("limit") ?? "", 10);
  const rawOffset = Number.parseInt(get("offset") ?? "", 10);

  return {
    q: get("q") ?? undefined,
    weight,
    country,
    stance,
    status,
    hasPhoto: parseBool(get("has_photo")),
    hallOfFame: parseBool(get("hof")),
    tier,
    sort,
    limit: Number.isFinite(rawLimit) ? rawLimit : undefined,
    offset: Number.isFinite(rawOffset) ? rawOffset : undefined,
  };
}
