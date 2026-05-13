"use client";

import * as React from "react";

import { FightHistoryRow } from "@/components/fighter/detail/FightHistoryRow";
import { Button } from "@/components/ui/button";
import type { FightHistoryEntry } from "@/lib/fighter-detail";
import { formatNumber } from "@/lib/format";

const INITIAL_VISIBLE = 30;

interface FightHistoryListProps {
  history: FightHistoryEntry[];
}

export function FightHistoryList({ history }: FightHistoryListProps) {
  const [expanded, setExpanded] = React.useState(false);

  if (history.length === 0) {
    return (
      <div className="rounded-md border border-dashed border-foreground/10 bg-background-elevated/30 px-6 py-12 text-center">
        <p className="font-sans text-sm text-foreground-muted">
          No completed bouts recorded for this fighter.
        </p>
      </div>
    );
  }

  const visible = expanded
    ? history
    : history.slice(0, INITIAL_VISIBLE);
  const hasMore = history.length > INITIAL_VISIBLE;

  return (
    <div>
      <ul className="flex flex-col">
        {visible.map((entry) => (
          <FightHistoryRow key={entry.bout_id} entry={entry} />
        ))}
      </ul>

      {hasMore ? (
        <div className="mt-6 flex flex-col items-center gap-2">
          <p className="font-mono text-[10px] uppercase tracking-widest text-foreground-subtle tabular">
            Showing {formatNumber(visible.length)} of{" "}
            {formatNumber(history.length)}
          </p>
          <Button
            variant="outline"
            size="sm"
            onClick={() => setExpanded((v) => !v)}
          >
            {expanded
              ? "Show fewer"
              : `Show all ${formatNumber(history.length)} bouts`}
          </Button>
        </div>
      ) : null}
    </div>
  );
}
