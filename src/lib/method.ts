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
