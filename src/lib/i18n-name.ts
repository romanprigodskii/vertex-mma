import { sql, type SQL } from "drizzle-orm";
import { getLocale } from "next-intl/server";

/** True when the active request locale is Russian. Defensive: outside a request
 *  scope (e.g. a non-localized build step) it falls back to English. */
export async function isRuLocale(): Promise<boolean> {
  try {
    return (await getLocale()) === "ru";
  } catch {
    return false;
  }
}

// These helpers build SQL via sql.raw with string interpolation, so a caller
// that ever passed user input would open a SQL injection. Every current caller
// passes a hardcoded table alias / column name; assertIdent enforces that
// contract instead of assuming it — anything that isn't a plain `ident` or
// `ident.ident` throws.
const SQL_IDENT_RE = /^[A-Za-z_][A-Za-z0-9_]*(\.[A-Za-z_][A-Za-z0-9_]*)?$/;
function assertIdent(value: string): string {
  if (!SQL_IDENT_RE.test(value)) {
    throw new Error(
      `Unsafe SQL identifier passed to a localized name helper: ${JSON.stringify(value)}`,
    );
  }
  return value;
}

/** SQL fragment for a fighter's *display* name in the active locale. On RU we
 *  fall back to name_en whenever name_ru is missing, so an untranslated fighter
 *  still renders. `alias` is the fighter row's table alias (e.g. "f", "fa",
 *  "fb", "opp", or the table name "fighter").
 *
 *  Use this only for the value shown to users — keep search/sort/match logic on
 *  name_en. NOTE: a column you alias as `name_en` via this helper will carry
 *  Russian text on the RU site; that overloading is intentional and lets the
 *  existing consumers stay unchanged. */
export function localizedNameSql(alias: string, isRu: boolean): SQL {
  assertIdent(alias);
  return isRu
    ? sql.raw(`COALESCE(NULLIF(${alias}.name_ru, ''), ${alias}.name_en)`)
    : sql.raw(`${alias}.name_en`);
}

/** Event display name for the active locale. Many UIs prefer `short_name`
 *  (which in this DB duplicates `name`), so on RU we resolve name_ru first,
 *  then fall back to short_name / name. `alias` is the event row's table alias
 *  (e.g. "e"). Alias the result as whichever column the consumer reads. */
export function localizedEventNameSql(alias: string, isRu: boolean): SQL {
  assertIdent(alias);
  // Treat empty strings as missing (NULLIF) the same way name_ru is guarded, so
  // a blank name_ru or short_name still falls through to the full name. Keeps
  // the fallback chain consistent with localizedNameSql / localizedColSql; the
  // final `name` is NOT NULL, so the result is always non-null.
  return isRu
    ? sql.raw(
        `COALESCE(NULLIF(${alias}.name_ru, ''), NULLIF(${alias}.short_name, ''), ${alias}.name)`,
      )
    : sql.raw(`COALESCE(NULLIF(${alias}.short_name, ''), ${alias}.name)`);
}

/** Generic locale-aware column: on RU resolve `ruCol` with a fallback to
 *  `enCol`, otherwise just `enCol`. Both args are raw column expressions
 *  (e.g. "ni.title", "ni.title_ru"). Same name-overloading caveat as
 *  localizedNameSql — alias the result as the English column to keep
 *  consumers unchanged. */
export function localizedColSql(
  enCol: string,
  ruCol: string,
  isRu: boolean,
): SQL {
  assertIdent(enCol);
  assertIdent(ruCol);
  return isRu
    ? sql.raw(`COALESCE(NULLIF(${ruCol}, ''), ${enCol})`)
    : sql.raw(enCol);
}
