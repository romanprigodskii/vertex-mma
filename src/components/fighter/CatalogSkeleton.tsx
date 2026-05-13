import { cn } from "@/lib/utils";

interface CatalogSkeletonProps {
  count?: number;
  className?: string;
}

/**
 * Roster-row skeleton matching the FighterRow grid (rank · avatar · identity · record).
 */
export function CatalogSkeleton({
  count = 12,
  className,
}: CatalogSkeletonProps) {
  return (
    <ul className={cn("flex flex-col", className)} aria-hidden>
      {Array.from({ length: count }).map((_, i) => (
        <li
          key={i}
          className="grid grid-cols-[40px_64px_1fr_auto] items-center gap-3 border-b border-foreground/[0.06] px-2 py-3 last:border-b-0 sm:grid-cols-[48px_72px_1fr_auto] sm:gap-4 sm:px-4"
        >
          <span className="h-5 w-8 justify-self-end rounded-sm bg-foreground/[0.06] animate-pulse" />
          <span className="h-16 w-16 rounded-md bg-foreground/[0.06] animate-pulse sm:h-[72px] sm:w-[72px]" />
          <span className="flex flex-col gap-1.5">
            <span className="h-4 w-44 rounded-sm bg-foreground/[0.08] animate-pulse" />
            <span className="h-3 w-32 rounded-sm bg-foreground/[0.05] animate-pulse" />
            <span className="h-3 w-52 rounded-sm bg-foreground/[0.04] animate-pulse" />
          </span>
          <span className="flex flex-col items-end gap-1.5">
            <span className="h-5 w-16 rounded-sm bg-foreground/[0.08] animate-pulse" />
            <span className="h-3 w-10 rounded-sm bg-foreground/[0.05] animate-pulse" />
          </span>
        </li>
      ))}
    </ul>
  );
}
