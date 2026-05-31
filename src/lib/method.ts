/**
 * Map a raw `bout.method` value (or NULL) to a short fight-card abbreviation.
 *
 * Our scraper left method NULL for ~4391 of completed bouts; callers can pass
 * `inferredMethod` when they have round-stat-derived signals (knockdowns >0
 * → KO/TKO, sub_attempts >0 → Sub) so the abbreviation still reads
 * informatively instead of "—".
 */
export function abbreviateMethod(method: string | null | undefined): string {
  if (!method) return "—";
  const m = method.toLowerCase().trim();
  if (m.startsWith("tko")) return "TKO";
  if (m.startsWith("ko")) return "KO";
  if (m.startsWith("sub")) return "Sub";
  if (m.includes("unanimous")) return "U-Dec";
  if (m.includes("split")) return "S-Dec";
  if (m.includes("majority")) return "M-Dec";
  if (m.includes("decision")) return "Dec";
  if (m.includes("dq") || m.includes("disqualif")) return "DQ";
  if (m.includes("draw")) return "Draw";
  if (m.includes("no_contest") || m.includes("no contest") || m === "nc")
    return "NC";
  return method.split(/[\s_-]/)[0].slice(0, 5);
}

export type MethodAbbrevKey =
  | "ko"
  | "tko"
  | "sub"
  | "udec"
  | "sdec"
  | "mdec"
  | "dec"
  | "dq"
  | "draw"
  | "nc";

/**
 * Stable i18n key for the method abbreviation, or null when the method is
 * unknown/free-form (caller then falls back to {@link abbreviateMethod}'s raw
 * output). Mirrors abbreviateMethod's branch order so the two stay in sync;
 * lets the abbreviation be localized (the EN abbreviations leaked onto RU pages).
 */
export function methodAbbrevKey(
  method: string | null | undefined,
): MethodAbbrevKey | null {
  if (!method) return null;
  const m = method.toLowerCase().trim();
  if (m.startsWith("tko")) return "tko";
  if (m.startsWith("ko")) return "ko";
  if (m.startsWith("sub")) return "sub";
  if (m.includes("unanimous")) return "udec";
  if (m.includes("split")) return "sdec";
  if (m.includes("majority")) return "mdec";
  if (m.includes("decision")) return "dec";
  if (m.includes("dq") || m.includes("disqualif")) return "dq";
  if (m.includes("draw")) return "draw";
  if (m.includes("no_contest") || m.includes("no contest") || m === "nc")
    return "nc";
  return null;
}
