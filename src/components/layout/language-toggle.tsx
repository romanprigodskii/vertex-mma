"use client";

import { useLocale } from "next-intl";

import { usePathname, useRouter } from "@/i18n/navigation";
import { routing } from "@/i18n/routing";
import { cn } from "@/lib/utils";

/** EN / RU pill in the navbar. Toggles between the two locales while
 *  preserving the current path — next-intl strips the prefix off the
 *  incoming pathname and re-applies whichever locale we push to. */
export function LanguageToggle({ className }: { className?: string }) {
  const locale = useLocale();
  const router = useRouter();
  const pathname = usePathname();

  const other = locale === "ru" ? "en" : "ru";
  const otherLabel = other === "ru" ? "RU" : "EN";

  return (
    <button
      type="button"
      onClick={() =>
        router.replace(pathname, {
          locale: other as (typeof routing.locales)[number],
        })
      }
      aria-label={`Switch language to ${otherLabel}`}
      className={cn(
        "inline-flex h-9 min-w-9 items-center justify-center rounded-md border border-foreground/20 bg-background-elevated px-2 font-mono text-[11px] uppercase tracking-widest text-foreground-muted transition-colors hover:border-foreground/40 hover:bg-foreground/[0.04] hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary",
        className,
      )}
    >
      {otherLabel}
    </button>
  );
}
