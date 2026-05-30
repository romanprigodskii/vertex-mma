import { cn } from "@/lib/utils";

interface StatRowProps {
  label: string;
  valueA: string | number;
  valueB: string | number;
  highlightA?: boolean;
  highlightB?: boolean;
  /** Render the row slightly dimmer for omitted-or-low-signal lines. */
  muted?: boolean;
}

export function StatRow({
  label,
  valueA,
  valueB,
  highlightA,
  highlightB,
  muted,
}: StatRowProps) {
  const cellClass = (highlighted?: boolean) =>
    cn(
      "font-mono tabular text-sm",
      muted && "text-foreground-subtle",
      !muted && highlighted && "font-semibold text-foreground",
      !muted && !highlighted && "text-foreground-muted",
    );
  return (
    <div className="border-b border-foreground/[0.05] py-2 last:border-b-0">
      {/* Mobile — label on top, values on a single row below. Stops the
       *  long "X / Y (Z%)" cells from squeezing the center label off-screen
       *  at 375px. */}
      <div className="sm:hidden">
        <div className="text-center font-sans text-[10px] uppercase tracking-widest text-foreground-subtle">
          {label}
        </div>
        <div className="mt-1 grid grid-cols-2 gap-3">
          <div className={cn("text-right", cellClass(highlightA))}>{valueA}</div>
          <div className={cn("text-left", cellClass(highlightB))}>{valueB}</div>
        </div>
      </div>
      {/* Desktop — value · label · value. */}
      <div className="hidden grid-cols-[1fr_auto_1fr] items-baseline gap-3 sm:grid">
        <div className={cn("text-right", cellClass(highlightA))}>{valueA}</div>
        <div className="text-center font-sans text-[10px] uppercase tracking-widest text-foreground-subtle">
          {label}
        </div>
        <div className={cn("text-left", cellClass(highlightB))}>{valueB}</div>
      </div>
    </div>
  );
}

export function formatStrike(landed: number, attempted: number): string {
  if (!attempted) return `${landed}`;
  const pct = Math.round((landed / attempted) * 100);
  return `${landed} / ${attempted} (${pct}%)`;
}

export function formatTakedowns(landed: number, attempted: number): string {
  if (!attempted) return `${landed}`;
  return `${landed} / ${attempted}`;
}

export function formatTime(seconds: number): string {
  const safe = Math.max(0, Math.floor(seconds));
  const m = Math.floor(safe / 60);
  const s = safe % 60;
  return `${m}:${s.toString().padStart(2, "0")}`;
}
