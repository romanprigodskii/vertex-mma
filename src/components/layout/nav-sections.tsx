"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

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
  return (
    <nav className="hidden md:flex items-center gap-1">
      {NAV_SECTIONS.map((s) => {
        const active = isActiveSection(pathname, s.href);
        return (
          <Link
            key={s.href}
            href={s.href}
            className={cn(
              "type-label relative rounded-sm px-3 py-1.5 text-sm transition-colors duration-(--motion-fast) ease-out-soft",
              active
                ? "text-fg"
                : "text-fg-muted hover:text-fg",
            )}
          >
            {s.label}
            {active ? (
              <span
                className="absolute inset-x-3 -bottom-[15px] h-0.5 bg-accent"
                aria-hidden
              />
            ) : null}
          </Link>
        );
      })}
    </nav>
  );
}
