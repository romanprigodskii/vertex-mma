"use client";

import { useTranslations } from "next-intl";
import { Moon, Sun } from "lucide-react";
import { useTheme } from "next-themes";

import { useMounted } from "@/hooks/use-mounted";
import { cn } from "@/lib/utils";

/** Sun ↔ moon button. Renders nothing until mounted so the server output
 *  matches every theme — otherwise we'd hydration-mismatch on the icon. */
export function ThemeToggle({ className }: { className?: string }) {
  const t = useTranslations("theme");
  const { resolvedTheme, setTheme } = useTheme();
  const mounted = useMounted();

  const isLight = resolvedTheme === "light";
  const next = isLight ? "dark" : "light";
  const label = mounted
    ? next === "dark"
      ? t("switchToDark")
      : t("switchToLight")
    : t("toggle");

  return (
    <button
      type="button"
      onClick={() => setTheme(next)}
      aria-label={label}
      title={mounted ? label : undefined}
      className={cn(
        "inline-flex h-9 w-9 items-center justify-center rounded-md border border-foreground/20 bg-background-elevated text-foreground-muted transition-colors hover:border-foreground/40 hover:bg-foreground/[0.04] hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary",
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
