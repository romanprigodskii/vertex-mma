import { cn } from "@/lib/utils";

interface CatalogSkeletonProps {
  count?: number;
  className?: string;
}

/**
 * Skeleton grid matching the FighterCard layout. Pure CSS, no JS.
 */
export function CatalogSkeleton({
  count = 12,
  className,
}: CatalogSkeletonProps) {
  return (
    <div
      className={cn(
        "grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4",
        className,
      )}
    >
      {Array.from({ length: count }).map((_, i) => (
        <div
          key={i}
          className="relative aspect-[3/4] overflow-hidden rounded-lg border border-border bg-background-elevated"
        >
          <div className="absolute inset-0 animate-pulse bg-background-overlay/50" />
          <div className="absolute inset-x-0 bottom-0">
            <div className="h-16 bg-background-base/80" />
          </div>
        </div>
      ))}
    </div>
  );
}
