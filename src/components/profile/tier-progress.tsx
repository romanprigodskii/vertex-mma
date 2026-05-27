import { useTranslations } from "next-intl";

import { nextTier, TIER_LABEL, type Tier } from "@/lib/tier";

interface Props {
  currentTier: Tier;
  totalEarned: number;
  isOwner: boolean;
}

export function TierProgress({ currentTier, totalEarned, isOwner }: Props) {
  const t = useTranslations("profile");
  if (!isOwner) return null;

  const next = nextTier(currentTier);
  if (!next) return null;

  const toNext = Math.max(0, next.threshold - totalEarned);
  const progressPct = Math.min(100, (totalEarned / next.threshold) * 100);

  return (
    <div className="mt-4 max-w-md rounded-md border border-foreground/10 bg-background-elevated/20 p-3">
      <div className="mb-2 flex items-baseline justify-between gap-3">
        <p className="font-mono text-[10px] uppercase tracking-widest text-foreground-subtle">
          {TIER_LABEL[currentTier]} → {TIER_LABEL[next.tier]}
        </p>
        <p className="font-mono text-[10px] tabular text-foreground-muted">
          {t("moreCoins", { n: toNext.toLocaleString() })}
        </p>
      </div>
      <div className="h-1.5 w-full overflow-hidden rounded-sm bg-foreground/[0.06]">
        <div
          className="h-full bg-primary"
          style={{ width: `${progressPct}%` }}
        />
      </div>
      <p className="mt-2 font-sans text-[11px] text-foreground-subtle">
        {t("lifetimeEarned", {
          earned: totalEarned.toLocaleString(),
          target: next.threshold.toLocaleString(),
        })}
      </p>
    </div>
  );
}
