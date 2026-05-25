import { cn } from "@/lib/utils";

interface CatalogSkeletonProps {
  count?: number;
  className?: string;
}

/**
 * Skeleton grid matching the wide FighterCard layout.
 * 2 columns on lg+, 1 column below. Pure CSS, no JS.
 */
export function CatalogSkeleton({
  count = 12,
  className,
}: CatalogSkeletonProps) {
  return (
    <ul
      className={cn("grid grid-cols-1 gap-4 lg:grid-cols-2 2xl:grid-cols-3", className)}
      aria-hidden
    >
      {Array.from({ length: count }).map((_, i) => (
        <li
          key={i}
          className="flex min-h-[180px] gap-4 rounded-lg border border-edge bg-surface-elevated/30 p-4"
        >
          <span className="h-[160px] w-[160px] shrink-0 rounded-md bg-fg/[0.06] animate-pulse" />
          <span className="flex min-w-0 flex-1 flex-col justify-between gap-3">
            <span className="flex flex-col gap-2">
              <span className="h-3 w-10 rounded-sm bg-fg/[0.05] animate-pulse" />
              <span className="h-6 w-56 rounded-sm bg-fg/[0.09] animate-pulse" />
              <span className="h-3 w-36 rounded-sm bg-fg/[0.05] animate-pulse" />
            </span>
            <span className="flex flex-col gap-2">
              <span className="h-px w-full bg-fg/[0.07]" />
              <span className="h-3 w-44 rounded-sm bg-fg/[0.05] animate-pulse" />
              <span className="h-3 w-52 rounded-sm bg-fg/[0.04] animate-pulse" />
            </span>
          </span>
          <span className="flex flex-col items-end gap-2 pl-1">
            <span className="h-7 w-20 rounded-sm bg-fg/[0.09] animate-pulse" />
            <span className="h-px w-6 bg-fg/[0.1]" />
            <span className="h-3 w-10 rounded-sm bg-fg/[0.05] animate-pulse" />
          </span>
        </li>
      ))}
    </ul>
  );
}
