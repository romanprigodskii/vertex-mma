import { Trophy } from "lucide-react";

import { cn } from "@/lib/utils";

interface TrophyBadgeProps {
  /** Division short code, e.g. "HW", "W-FLW". */
  divisionShort: string;
  /** Full division name, used in the aria-label. */
  divisionFull?: string;
  isInterim?: boolean;
  className?: string;
}

export function TrophyBadge({
  divisionShort,
  divisionFull,
  isInterim = false,
  className,
}: TrophyBadgeProps) {
  const labelText = isInterim ? "INTERIM CHAMP" : "CHAMPION";
  const ariaLabel = `${divisionFull ?? divisionShort} ${labelText.toLowerCase()}`;
  return (
    <span
      role="img"
      aria-label={ariaLabel}
      className={cn(
        "inline-flex items-center gap-1.5 rounded-md px-2 py-1",
        "font-sans text-[11px] uppercase tracking-[0.18em]",
        "border backdrop-blur-sm",
        isInterim
          ? "border-foreground/15 bg-foreground/5 text-foreground-muted"
          : "border-primary/35 bg-primary/10 text-primary",
        className,
      )}
    >
      <Trophy className="h-3.5 w-3.5" aria-hidden />
      <span>
        {divisionShort} · {labelText}
      </span>
    </span>
  );
}
