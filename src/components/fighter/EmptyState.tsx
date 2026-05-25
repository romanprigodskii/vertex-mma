import { SearchX } from "lucide-react";

import { Button } from "@/components/ui/button";

interface EmptyStateProps {
  onReset?: () => void;
  hint?: string;
}

export function EmptyState({
  onReset,
  hint = "No fighters match these filters.",
}: EmptyStateProps) {
  return (
    <div className="flex flex-col items-center justify-center gap-4 border-y border-dashed border-edge px-6 py-20 text-center">
      <div className="flex h-12 w-12 items-center justify-center rounded-full border border-edge bg-surface-elevated/60 text-fg-subtle">
        <SearchX className="h-5 w-5" />
      </div>
      <div className="space-y-1">
        <p className="type-display text-2xl text-fg">
          Nothing here
        </p>
        <p className="type-body max-w-sm text-sm text-fg-muted">{hint}</p>
      </div>
      {onReset ? (
        <Button variant="outline" size="sm" onClick={onReset}>
          Clear filters
        </Button>
      ) : null}
    </div>
  );
}
