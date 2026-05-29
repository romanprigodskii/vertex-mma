"use client";

import { useLocale } from "next-intl";
import { Languages } from "lucide-react";
import { useSearchParams } from "next/navigation";

import { usePathname, useRouter } from "@/i18n/navigation";
import { routing } from "@/i18n/routing";
import { cn } from "@/lib/utils";

/** Globe + EN/RU pill in the navbar. Toggles between the two locales while
 *  preserving the current path — next-intl strips the prefix off the
 *  incoming pathname and re-applies whichever locale we push to. The label
 *  shows the language you'll switch TO. */
export function LanguageToggle({ className }: { className?: string }) {
  const locale = useLocale();
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();

  const other = locale === "ru" ? "en" : "ru";
  const otherLabel = other === "ru" ? "RU" : "EN";

  return (
    <button
      type="button"
      onClick={() => {
        // Keep the query string (compare selections, catalog filters, etc.) —
        // usePathname() drops it, so switching locale would otherwise reset state.
        const qs = searchParams.toString();
        router.replace(`${pathname}${qs ? `?${qs}` : ""}`, {
          locale: other as (typeof routing.locales)[number],
        });
      }}
      aria-label={`Switch language to ${otherLabel}`}
      title={`Switch language to ${otherLabel}`}
      className={cn(
        "inline-flex h-9 items-center justify-center gap-1.5 rounded-md border border-foreground/20 bg-background-elevated px-2.5 font-mono text-[11px] uppercase tracking-widest text-foreground-muted transition-colors hover:border-foreground/40 hover:bg-foreground/[0.04] hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary",
        className,
      )}
    >
      <Languages className="h-4 w-4" aria-hidden />
      {otherLabel}
    </button>
  );
}
