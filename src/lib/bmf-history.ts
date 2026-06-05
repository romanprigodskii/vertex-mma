/**
 * UFC BMF (Baddest Motherfucker) title history.
 *
 * ⚠️ DISPLAY-ONLY. Never import this file in:
 *   - scripts/compute_championship_pedigree.ts
 *   - scripts/materialize_vertex_score.ts
 *   - scripts/compute_*.ts of any kind
 *   - src/lib/vertex-tier.ts
 * BMF is a promotional title — counting it in championship_pedigree would
 * overstate the pedigree of fighters with thin divisional-belt resumes
 * (Masvidal never held an undisputed UFC belt).
 *
 * History snapshot 2026-05-16: 4 reigns, 4 distinct champions, exactly ONE
 * successful BMF defense in the title's lifetime (Holloway at UFC 318 vs
 * Poirier — Poirier retirement bout).
 */

export interface BmfReign {
  slug: string;
  /** Date the fighter won the BMF title (ISO yyyy-mm-dd). */
  startDate: string;
  /** Date the reign ended — null if still champion. */
  endDate: string | null;
  /** Successful BMF defenses during this reign (excludes the title win). */
  defenses: number;
  /** How the reign ended (omit for current champion). */
  endReason?: "lost_bout" | "stripped";
  /** Short note for UI tooltips — event + opponent + method. */
  notes?: string;
  /** Russian rendering of `notes`, shown in the BmfBadge tooltip on /ru.
   *  Falls back to `notes` when absent. */
  notesRu?: string;
}

export const BMF_HISTORY: readonly BmfReign[] = [
  { slug: "charles-oliveira-07225b", startDate: "2026-03-07", endDate: null,         defenses: 0,
    notes: "UFC 326 vs Holloway (UD 50-45 all cards). First double champ to also hold BMF.",
    notesRu:
      "UFC 326 против Холлоуэя (единогласное решение, 50-45 по всем картам). Первый двойной чемпион, у которого есть и пояс BMF." },
  { slug: "max-holloway-150ff4",     startDate: "2024-04-13", endDate: "2026-03-07", defenses: 1, endReason: "lost_bout",
    notes: "Won UFC 300 vs Gaethje (KO last second). Defended UFC 318 vs Poirier (UD) — Poirier farewell. Lost to Oliveira.",
    notesRu:
      "Выиграл на UFC 300 у Гейджи (нокаут на последней секунде). Защитил титул на UFC 318 против Порье (решением) — прощальный бой Порье. Проиграл Оливейре." },
  { slug: "justin-gaethje-9e8f6c",   startDate: "2023-07-29", endDate: "2024-04-13", defenses: 0, endReason: "lost_bout",
    notes: "Won UFC 291 vacant vs Poirier (KO head kick R2). Lost to Holloway.",
    notesRu:
      "Выиграл вакантный титул на UFC 291 у Порье (нокаут с хедкика во 2-м раунде). Проиграл Холлоуэю." },
  { slug: "jorge-masvidal-47b9e0",   startDate: "2019-11-02", endDate: "2023-05-16", defenses: 0, endReason: "stripped",
    notes: "Won UFC 244 vacant vs Diaz (TKO doctor stoppage; belt presented by The Rock). Stripped after UFC 287 retirement.",
    notesRu:
      "Выиграл вакантный титул на UFC 244 у Диаса (врачебная остановка; пояс вручал Дуэйн «Скала» Джонсон). Лишён титула после ухода из спорта на UFC 287." },
];

const REIGNS_BY_SLUG: ReadonlyMap<string, BmfReign[]> = (() => {
  const m = new Map<string, BmfReign[]>();
  for (const r of BMF_HISTORY) {
    const cur = m.get(r.slug) ?? [];
    cur.push(r);
    m.set(r.slug, cur);
  }
  return m;
})();

export function getBmfReigns(slug: string): BmfReign[] {
  return REIGNS_BY_SLUG.get(slug) ?? [];
}

export function isCurrentBmf(slug: string): boolean {
  const reigns = REIGNS_BY_SLUG.get(slug);
  if (!reigns) return false;
  return reigns.some((r) => r.endDate === null);
}

export function wasBmfChampion(slug: string): boolean {
  return REIGNS_BY_SLUG.has(slug);
}

export function totalBmfDefenses(slug: string): number {
  const reigns = REIGNS_BY_SLUG.get(slug);
  if (!reigns) return 0;
  return reigns.reduce((sum, r) => sum + r.defenses, 0);
}
