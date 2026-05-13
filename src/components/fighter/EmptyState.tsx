import { SearchX } from "lucide-react";

import { Button } from "@/components/ui/button";

interface EmptyStateProps {
  onReset?: () => void;
  hint?: string;
}

export function EmptyState({
  onReset,
  hint = "Try a different name or remove some filters.",
}: EmptyStateProps) {
  return (
    <div className="flex flex-col items-center justify-center gap-4 rounded-xl border border-dashed border-border bg-background-elevated/40 px-6 py-20 text-center">
      <div className="flex h-12 w-12 items-center justify-center rounded-full bg-background-overlay text-foreground-subtle">
        <SearchX className="h-5 w-5" />
      </div>
      <div className="space-y-1">
        <p className="font-display text-2xl uppercase tracking-wide text-foreground">
          No fighters found
        </p>
        <p className="max-w-sm text-sm text-foreground-muted">{hint}</p>
      </div>
      {onReset ? (
        <Button variant="outline" size="sm" onClick={onReset}>
          Reset filters
        </Button>
      ) : null}
    </div>
  );
}
