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
  return isRu
    ? sql.raw(`COALESCE(NULLIF(${alias}.name_ru, ''), ${alias}.name_en)`)
    : sql.raw(`${alias}.name_en`);
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
  return isRu
    ? sql.raw(`COALESCE(NULLIF(${ruCol}, ''), ${enCol})`)
    : sql.raw(enCol);
}
