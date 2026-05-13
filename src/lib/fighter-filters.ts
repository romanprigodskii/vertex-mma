import { WEIGHT_CLASSES } from "@/lib/constants";
import type {
  CatalogSort,
  FighterCatalogFilters,
} from "@/lib/fighter-search";

const VALID_SORTS: ReadonlySet<CatalogSort> = new Set([
  "champions_first",
  "fights",
  "recent",
  "wins",
  "winrate",
  "name_asc",
  "name_desc",
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
  const sort: CatalogSort =
    rawSort && VALID_SORTS.has(rawSort as CatalogSort)
      ? (rawSort as CatalogSort)
      : "fights";

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
    sort,
    limit: Number.isFinite(rawLimit) ? rawLimit : undefined,
    offset: Number.isFinite(rawOffset) ? rawOffset : undefined,
  };
}
