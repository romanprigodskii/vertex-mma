import { getBmfReigns, wasBmfChampion } from "@/lib/bmf-history";
import { cn } from "@/lib/utils";

/**
 * Wave 10A: BMF (Baddest Motherfucker) title indicator. Display-only —
 * does not feed championship_pedigree or any vertex_score input.
 *
 * Visually distinct from divisional TrophyBadge: a flat gold pill (active)
 * or muted bordered chip (former). Year range comes from the most recent
 * reign; tooltip = the reign's notes string from bmf-history.ts.
 *
 *   variant="hero"    full label, used on the profile FighterHero
 *   variant="card"    compact "BMF" chip, current-champion only
 */
interface BmfBadgeProps {
  slug: string;
  variant: "hero" | "card";
  className?: string;
}

export function BmfBadge({ slug, variant, className }: BmfBadgeProps) {
  if (!wasBmfChampion(slug)) return null;
  const reigns = getBmfReigns(slug);
  const currentReign = reigns.find((r) => r.endDate === null);

  if (variant === "card") {
    // Card chip — current BMF only. Skip former (keeps catalog cards uncluttered).
    if (!currentReign) return null;
    return (
      <span
        className={cn(
          "inline-flex items-center rounded-sm bg-amber-400 px-1.5 py-px font-sans font-bold text-[9px] font-medium uppercase tracking-wider leading-none text-black",
          className,
        )}
        title={currentReign.notes}
      >
        BMF
      </span>
    );
  }

  // Hero variant — current (gold pill) or former (muted bordered chip).
  if (currentReign) {
    return (
      <span
        className={cn(
          "inline-flex items-center rounded-full bg-amber-400 px-2.5 py-1 font-sans font-bold text-[10px] uppercase tracking-wider leading-none text-black shadow-md",
          className,
        )}
        title={currentReign.notes}
      >
        BMF Champion
      </span>
    );
  }

  // Former — pick the most recent closed reign for the year-range label.
  const mostRecent = [...reigns]
    .filter((r) => r.endDate !== null)
    .sort((a, b) => (b.endDate ?? "").localeCompare(a.endDate ?? ""))[0];
  if (!mostRecent || !mostRecent.endDate) return null;
  const startYear = mostRecent.startDate.slice(0, 4);
  const endYear = mostRecent.endDate.slice(0, 4);
  return (
    <span
      className={cn(
        "inline-flex items-center rounded-full border border-amber-500/40 bg-amber-500/10 px-2 py-0.5 font-sans text-[10px] uppercase tracking-wider leading-none text-amber-300/80",
        className,
      )}
      title={mostRecent.notes}
    >
      Former BMF ({startYear}–{endYear})
    </span>
  );
}
