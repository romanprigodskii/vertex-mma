import { formatNewsClassification } from "@/lib/news";
import { cn } from "@/lib/utils";

// Subtle per-category tint. Unknown values fall back to the neutral style.
const STYLES: Record<string, string> = {
  bout_announced: "border-primary/30 bg-primary/10 text-primary",
  bout_cancelled: "border-streak-loss/30 bg-streak-loss/10 text-streak-loss",
  bout_changed: "border-warning/30 bg-warning/10 text-warning",
  weigh_in: "border-info/30 bg-info/10 text-info",
  result: "border-streak-win/30 bg-streak-win/10 text-streak-win",
  general_news:
    "border-foreground/15 bg-foreground/[0.05] text-foreground-muted",
  rumor: "border-foreground/15 bg-foreground/[0.05] text-foreground-subtle",
  unrelated: "border-foreground/15 bg-foreground/[0.05] text-foreground-subtle",
};

export function NewsClassificationBadge({
  classification,
}: {
  classification: string;
}) {
  return (
    <span
      className={cn(
        "inline-block shrink-0 rounded-sm border px-1.5 py-0.5 font-mono text-[9px] font-medium uppercase tracking-widest",
        STYLES[classification] ?? STYLES.general_news,
      )}
    >
      {formatNewsClassification(classification)}
    </span>
  );
}
