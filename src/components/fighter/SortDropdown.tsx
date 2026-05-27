"use client";

import * as React from "react";
import { useTranslations } from "next-intl";
import * as Popover from "@radix-ui/react-popover";
import { Check, ChevronDown } from "lucide-react";

import type { CatalogSort } from "@/lib/fighter-search";
import { cn } from "@/lib/utils";

const SORT_IDS: CatalogSort[] = [
  "vertex_current",
  "vertex_all_time",
  "elite_first",
  "all_time",
  "fights",
  "recent",
  "wins",
  "winrate",
  "champions_first",
  "name_asc",
  "name_desc",
];

interface SortDropdownProps {
  value: CatalogSort;
  onChange: (sort: CatalogSort) => void;
  className?: string;
}

export function SortDropdown({ value, onChange, className }: SortDropdownProps) {
  const t = useTranslations("catalog");
  const [open, setOpen] = React.useState(false);
  const labelFor = (id: CatalogSort): string => t(`sort_${id}` as "sort_fights");
  const currentLabel = labelFor(value);

  return (
    <Popover.Root open={open} onOpenChange={setOpen}>
      <Popover.Trigger asChild>
        <button
          type="button"
          aria-label={t("sortAria")}
          className={cn(
            "inline-flex h-9 w-full min-w-[220px] items-center justify-between gap-2 rounded-md border border-border bg-background-base pl-3 pr-2 text-xs text-foreground",
            "hover:bg-foreground/[0.04]",
            "focus:outline-none focus:border-primary focus:ring-2 focus:ring-primary/30",
            "transition-colors",
            className,
          )}
        >
          <span className="truncate">{currentLabel ?? t("sortBy")}</span>
          <ChevronDown
            aria-hidden
            className={cn(
              "h-3.5 w-3.5 shrink-0 text-foreground-subtle transition-transform",
              open && "rotate-180",
            )}
          />
        </button>
      </Popover.Trigger>
      <Popover.Portal>
        <Popover.Content
          align="end"
          sideOffset={4}
          className={cn(
            "z-50 w-[260px] rounded-md border border-foreground/15 bg-background-overlay p-1 shadow-elevation-2",
            "data-[state=open]:animate-in data-[state=closed]:animate-out",
            "data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0",
          )}
        >
          <ul className="flex flex-col">
            {SORT_IDS.map((id) => {
              const isSelected = id === value;
              return (
                <li key={id}>
                  <button
                    type="button"
                    onClick={() => {
                      onChange(id);
                      setOpen(false);
                    }}
                    className={cn(
                      "flex w-full items-center justify-between gap-2 rounded-sm px-3 py-2 text-left font-sans text-xs transition-colors",
                      isSelected
                        ? "bg-primary/15 text-foreground"
                        : "text-foreground-muted hover:bg-foreground/[0.05] hover:text-foreground",
                    )}
                  >
                    <span className="truncate">{labelFor(id)}</span>
                    {isSelected ? (
                      <Check
                        aria-hidden
                        className="h-3.5 w-3.5 shrink-0 text-primary"
                      />
                    ) : null}
                  </button>
                </li>
              );
            })}
          </ul>
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  );
}
