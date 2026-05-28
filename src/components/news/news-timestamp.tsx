"use client";

import { useEffect, useState } from "react";
import { useLocale } from "next-intl";

type Variant = "full" | "short" | "compact";

/** Postgres `timestamptz::text` comes through as "2026-05-28 15:00:00+00".
 *  Safari rejects the space separator and bare hour offset, so normalize to
 *  ISO 8601 before constructing the Date. */
function parsePgTimestamp(s: string): Date {
  const iso = s.replace(" ", "T").replace(/([+-]\d{2})$/, "$1:00");
  return new Date(iso);
}

const DATE_OPTS: Record<Variant, Intl.DateTimeFormatOptions> = {
  full: { day: "numeric", month: "long", year: "numeric" },
  short: { day: "numeric", month: "short", year: "numeric" },
  compact: { day: "numeric", month: "short" },
};

function format(iso: string, locale: string, variant: Variant, timeZone?: string): string {
  return parsePgTimestamp(iso).toLocaleString(locale === "ru" ? "ru-RU" : "en-US", {
    ...DATE_OPTS[variant],
    hour: "2-digit",
    minute: "2-digit",
    timeZone,
  });
}

/** Renders an article's publication date *and* time of day. Server and the
 *  first client render use UTC so the markup is deterministic (no hydration
 *  mismatch); after mount we re-render in the viewer's own timezone. */
export function NewsTimestamp({
  iso,
  variant = "short",
  className,
}: {
  iso: string;
  variant?: Variant;
  className?: string;
}) {
  const locale = useLocale();
  const [text, setText] = useState(() => format(iso, locale, variant, "UTC"));

  useEffect(() => {
    setText(format(iso, locale, variant));
  }, [iso, locale, variant]);

  return (
    <time dateTime={parsePgTimestamp(iso).toISOString()} className={className} suppressHydrationWarning>
      {text}
    </time>
  );
}
