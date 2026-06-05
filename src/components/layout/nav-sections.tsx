"use client";

import { useTranslations } from "next-intl";

import { Link, usePathname } from "@/i18n/navigation";
import { NAV_SECTIONS } from "@/lib/navigation";
import { cn } from "@/lib/utils";

function isActiveSection(pathname: string, href: string): boolean {
  // /events matches /events and /events/[slug]. Same for the others —
  // every section is a top-level segment so a startsWith check is
  // accurate without needing exact matches.
  if (href === "/") return pathname === "/";
  return pathname === href || pathname.startsWith(`${href}/`);
}

export function NavSections() {
  const pathname = usePathname();
  const t = useTranslations("nav");
  return (
    // `self-stretch` makes the nav span the full header height (h-14/md:h-16),
    // so each item's full-height cell anchors the active underline to the
    // header's bottom border via `bottom-0` — no magic per-height pixel offset.
    <nav className="hidden self-stretch items-stretch gap-1 md:flex">
      {NAV_SECTIONS.map((s) => {
        const active = isActiveSection(pathname, s.href);
        return (
          <div key={s.href} className="relative flex items-center">
            <Link
              href={s.href}
              className={cn(
                "rounded-sm px-3 py-1.5 font-sans text-sm uppercase tracking-widest transition-colors",
                active
                  ? "text-foreground"
                  : "text-foreground-muted hover:text-foreground",
              )}
            >
              {t(s.labelKey)}
            </Link>
            {active ? (
              <span
                className="absolute inset-x-3 bottom-0 h-0.5 bg-primary"
                aria-hidden
              />
            ) : null}
          </div>
        );
      })}
    </nav>
  );
}
