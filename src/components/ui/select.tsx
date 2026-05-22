"use client";

import * as React from "react";
import * as Popover from "@radix-ui/react-popover";
import { Check, ChevronDown } from "lucide-react";

import { cn } from "@/lib/utils";

export interface SelectOption<T extends string = string> {
  value: T;
  label: string;
  /** Optional secondary line shown under the label inside the dropdown. */
  hint?: string;
}

interface SelectProps<T extends string> {
  value: T;
  onChange: (value: T) => void;
  options: ReadonlyArray<SelectOption<T>>;
  /** Trigger text shown when nothing matches `value`. */
  placeholder?: string;
  /** Accessible name for the trigger button. */
  ariaLabel?: string;
  /** Extra classes for the trigger (width, min-width, …). */
  className?: string;
  /** Popover alignment relative to the trigger. */
  align?: "start" | "center" | "end";
  disabled?: boolean;
}

/**
 * The site's single-select dropdown. Radix Popover under the hood (the app
 * doesn't ship @radix-ui/react-select); the panel matches the trigger width
 * and the active option carries a check. Use this for every "pick one from a
 * list" control so they all look and behave identically.
 */
export function Select<T extends string>({
  value,
  onChange,
  options,
  placeholder = "Select…",
  ariaLabel,
  className,
  align = "start",
  disabled,
}: SelectProps<T>) {
  const [open, setOpen] = React.useState(false);
  const current = options.find((o) => o.value === value);

  return (
    <Popover.Root open={open} onOpenChange={setOpen}>
      <Popover.Trigger asChild>
        <button
          type="button"
          aria-label={ariaLabel}
          disabled={disabled}
          className={cn(
            "inline-flex h-9 w-full items-center justify-between gap-2 rounded-md border border-border bg-background-base pl-3 pr-2 text-xs text-foreground",
            "transition-colors hover:bg-foreground/[0.04]",
            "focus:border-primary focus:outline-none focus:ring-2 focus:ring-primary/30",
            "disabled:cursor-not-allowed disabled:opacity-50",
            className,
          )}
        >
          <span
            className={cn("truncate", !current && "text-foreground-subtle")}
          >
            {current?.label ?? placeholder}
          </span>
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
          align={align}
          sideOffset={4}
          className={cn(
            "z-50 w-[var(--radix-popover-trigger-width)] min-w-[200px]",
            "max-h-[min(340px,var(--radix-popover-content-available-height))] overflow-y-auto",
            "rounded-md border border-foreground/15 bg-background-overlay p-1 shadow-elevation-2",
            "data-[state=open]:animate-in data-[state=closed]:animate-out",
            "data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0",
          )}
        >
          <ul className="flex flex-col">
            {options.map((opt) => {
              const isSelected = opt.value === value;
              return (
                <li key={opt.value}>
                  <button
                    type="button"
                    onClick={() => {
                      onChange(opt.value);
                      setOpen(false);
                    }}
                    className={cn(
                      "flex w-full items-center justify-between gap-2 rounded-sm px-3 py-2 text-left font-sans text-xs transition-colors",
                      isSelected
                        ? "bg-primary/15 text-foreground"
                        : "text-foreground-muted hover:bg-foreground/[0.05] hover:text-foreground",
                    )}
                  >
                    <span className="flex min-w-0 flex-col">
                      <span className="truncate">{opt.label}</span>
                      {opt.hint ? (
                        <span className="truncate font-mono text-[10px] text-foreground-subtle">
                          {opt.hint}
                        </span>
                      ) : null}
                    </span>
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
