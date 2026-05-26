"use client";

import * as React from "react";
import { Moon, Sun } from "lucide-react";
import { useTheme } from "next-themes";

import { cn } from "@/lib/utils";

/** Sun ↔ moon button. Renders nothing until mounted so the server output
 *  matches every theme — otherwise we'd hydration-mismatch on the icon. */
export function ThemeToggle({ className }: { className?: string }) {
  const { resolvedTheme, setTheme } = useTheme();
  const [mounted, setMounted] = React.useState(false);
  React.useEffect(() => setMounted(true), []);

  const isLight = resolvedTheme === "light";
  const next = isLight ? "dark" : "light";

  return (
    <button
      type="button"
      onClick={() => setTheme(next)}
      aria-label={
        mounted ? `Switch to ${next} theme` : "Toggle theme"
      }
      title={mounted ? `Switch to ${next} theme` : undefined}
      className={cn(
        "inline-flex h-9 w-9 items-center justify-center rounded-md border border-foreground/15 bg-background-elevated text-foreground-muted transition-colors hover:border-foreground/30 hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary",
        className,
      )}
    >
      {/* Reserve space on the server with one icon; swap once the client
          knows the resolved theme. Both icons are 16px to avoid layout
          shift between states. */}
      {!mounted ? (
        <Sun className="h-4 w-4 opacity-0" aria-hidden />
      ) : isLight ? (
        <Moon className="h-4 w-4" aria-hidden />
      ) : (
        <Sun className="h-4 w-4" aria-hidden />
      )}
    </button>
  );
}
