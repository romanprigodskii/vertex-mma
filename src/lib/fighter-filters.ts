import { WEIGHT_CLASSES } from "@/lib/constants";
import type {
  CatalogChampionFilter,
  CatalogGenderFilter,
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
  "apex",
  "elite",
  "established",
  "roster",
]);

const VALID_CHAMPIONS: ReadonlySet<CatalogChampionFilter> = new Set([
  "all",
  "any",
  "active",
  "dominant",
  "former",
  "none",
]);

const VALID_GENDERS: ReadonlySet<CatalogGenderFilter> = new Set([
  "all",
  "male",
  "female",
]);

// Bounds on untrusted catalog params: cap the search string length (it feeds
// pg_trgm + triple ILIKE), and clamp limit/offset so deep-pagination can't be
// abused as an unauthenticated full-table scan.
const MAX_Q_LEN = 64;
const MAX_LIMIT = 200;
const MAX_OFFSET = 10_000;

const VALID_WEIGHTS = new Set(WEIGHT_CLASSES.map((w) => w.id as string));
const VALID_STANCES = new Set(["orthodox", "southpaw", "switch", "unknown"]);
// roster.watch emits active / retired / released. The UI collapses
// retired+released under a single "Inactive" button (status=inactive)
// so legends like Jon Jones (released, not formally retired) aren't
// hidden when sorting by all-time. URLs with the literal status=retired
// still work as an exact-match opt-in to formally-retired fighters.
const VALID_STATUSES = new Set(["all", "active", "inactive", "retired"]);

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

  const rawQ = get("q")?.trim().slice(0, MAX_Q_LEN);

  const rawSort = get("sort");
  // Default sort is Vertex Score (current) as of Wave 3.5 step 4A. Old URLs
  // with `sort=winrate` etc. continue to work via VALID_SORTS lookup.
  const sort: CatalogSort =
    rawSort && VALID_SORTS.has(rawSort as CatalogSort)
      ? (rawSort as CatalogSort)
      : "vertex_current";

  // Wave 6C: default status is "active" (live UFC roster from
  // roster.watch) so /fighters opens on the ~614 currently-rostered
  // fighters. EXCEPT when the user is sorting by an all-time signal —
  // there the active roster is the wrong default (Jon Jones, Khabib,
  // Anderson Silva are all 'released' or 'retired'), so we broaden to
  // 'all' until they explicitly pick a status. Passing ?status= in the
  // URL overrides this on either branch.
  const rawStatus = get("status");
  let status: FighterCatalogFilters["status"];
  if (rawStatus && VALID_STATUSES.has(rawStatus)) {
    status = rawStatus as FighterCatalogFilters["status"];
  } else if (rawQ || sort === "vertex_all_time" || sort === "all_time") {
    // A name search (or an all-time sort) must reach retired legends — Jon
    // Jones and Khabib live in 'released'/'retired', so the active-roster
    // default would hide them from search results. Broaden to 'all' unless
    // the user explicitly picked a status.
    status = "all";
  } else {
    status = "active";
  }

  const rawTier = get("tier");
  let tier: CatalogTierFilter =
    rawTier && VALID_TIERS.has(rawTier as CatalogTierFilter)
      ? (rawTier as CatalogTierFilter)
      : "all";

  const rawChampion = get("champion");
  let champion: CatalogChampionFilter =
    rawChampion && VALID_CHAMPIONS.has(rawChampion as CatalogChampionFilter)
      ? (rawChampion as CatalogChampionFilter)
      : "all";

  const rawGender = get("gender");
  const gender: CatalogGenderFilter =
    rawGender && VALID_GENDERS.has(rawGender as CatalogGenderFilter)
      ? (rawGender as CatalogGenderFilter)
      : "all";

  // Backwards compat (Wave 3.5 step 4A→4A.2): the old combined filter
  // value `tier=champion` is now expressed as `champion=any`. Migrate
  // silently so existing bookmarks keep working.
  if (rawTier === "champion") {
    tier = "all";
    if (champion === "all") champion = "any";
  }

  const rawLimit = Number.parseInt(get("limit") ?? "", 10);
  const rawOffset = Number.parseInt(get("offset") ?? "", 10);

  return {
    q: rawQ || undefined,
    weight,
    country,
    stance,
    status,
    hasPhoto: parseBool(get("has_photo")),
    hallOfFame: parseBool(get("hof")),
    tier,
    champion,
    gender,
    sort,
    limit: Number.isFinite(rawLimit)
      ? Math.min(MAX_LIMIT, Math.max(1, rawLimit))
      : undefined,
    offset: Number.isFinite(rawOffset)
      ? Math.min(MAX_OFFSET, Math.max(0, rawOffset))
      : undefined,
  };
}
