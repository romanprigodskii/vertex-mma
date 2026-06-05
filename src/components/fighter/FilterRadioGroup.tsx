"use client";

import * as React from "react";

import { cn } from "@/lib/utils";

export interface FilterRadioOption<T extends string> {
  id: T;
  label: string;
}

interface FilterRadioGroupProps<T extends string> {
  value: T;
  onChange: (value: T) => void;
  options: ReadonlyArray<FilterRadioOption<T>>;
  ariaLabel: string;
  /** Wrapper layout classes (e.g. "grid grid-cols-3 gap-1"). */
  className?: string;
  /** Per-item overrides appended after the base button classes. */
  itemClassName?: string;
}

const FOCUS_RING =
  "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-offset-2 focus-visible:ring-offset-background-base";

/**
 * Accessible single-select radio group. Implements the WAI-ARIA radiogroup
 * pattern: a single tab stop (roving tabindex — only the checked option is
 * tabbable) with Arrow/Home/End keys moving the selection, plus a visible
 * focus ring. Treated as a 1-D list, so Up/Left step back and Down/Right step
 * forward regardless of the visual grid layout.
 */
export function FilterRadioGroup<T extends string>({
  value,
  onChange,
  options,
  ariaLabel,
  className,
  itemClassName,
}: FilterRadioGroupProps<T>) {
  const refs = React.useRef<(HTMLButtonElement | null)[]>([]);
  // The checked option owns tabindex=0. Fall back to the first option when the
  // current value isn't in the list so the group is never fully untabbable.
  const checkedIndex = Math.max(
    0,
    options.findIndex((o) => o.id === value),
  );

  const moveTo = (index: number) => {
    const opt = options[index];
    if (!opt) return;
    onChange(opt.id);
    refs.current[index]?.focus();
  };

  const onKeyDown = (event: React.KeyboardEvent, index: number) => {
    let next = index;
    switch (event.key) {
      case "ArrowRight":
      case "ArrowDown":
        next = (index + 1) % options.length;
        break;
      case "ArrowLeft":
      case "ArrowUp":
        next = (index - 1 + options.length) % options.length;
        break;
      case "Home":
        next = 0;
        break;
      case "End":
        next = options.length - 1;
        break;
      default:
        return;
    }
    event.preventDefault();
    moveTo(next);
  };

  return (
    <div role="radiogroup" aria-label={ariaLabel} className={className}>
      {options.map((opt, index) => {
        const isActive = opt.id === value;
        return (
          <button
            key={opt.id}
            ref={(el) => {
              refs.current[index] = el;
            }}
            type="button"
            role="radio"
            aria-checked={isActive}
            tabIndex={index === checkedIndex ? 0 : -1}
            onClick={() => onChange(opt.id)}
            onKeyDown={(e) => onKeyDown(e, index)}
            className={cn(
              "inline-flex h-7 items-center justify-center rounded-sm border px-2 text-[11px] transition-colors",
              FOCUS_RING,
              isActive
                ? "border-primary bg-primary text-primary-foreground"
                : "border-foreground/10 bg-transparent text-foreground-muted hover:border-foreground/30 hover:text-foreground",
              itemClassName,
            )}
          >
            {opt.label}
          </button>
        );
      })}
    </div>
  );
}
