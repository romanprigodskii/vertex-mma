"use client";

import { useLocale } from "next-intl";

import { useMounted } from "@/hooks/use-mounted";

/** Postgres `timestamptz::text` arrives as "2026-05-28 15:00:00+00". Safari
 *  rejects the space separator and the bare-hour offset, so normalize to ISO
 *  8601 before constructing the Date. */
function parsePgTimestamp(s: string): Date {
  const iso = s.replace(" ", "T").replace(/([+-]\d{2})$/, "$1:00");
  return new Date(iso);
}

const DATE_OPTS: Intl.DateTimeFormatOptions = {
  month: "long",
  day: "numeric",
  year: "numeric",
};
const DATETIME_OPTS: Intl.DateTimeFormatOptions = {
  month: "short",
  day: "numeric",
  hour: "numeric",
  minute: "2-digit",
};

/** Renders a market's event date / close time in the *viewer's* timezone. The
 *  server and the first client render format in UTC (deterministic — identical
 *  on both sides, so no hydration mismatch); after mount we re-render against
 *  the browser's zone. Mirrors the NewsTimestamp pattern so a 15:00 close reads
 *  in the reader's clock, not the server's. */
export function MarketDateTime({
  iso,
  mode,
  className,
}: {
  iso: string;
  mode: "date" | "datetime";
  className?: string;
}) {
  const locale = useLocale();
  const mounted = useMounted();
  const date = parsePgTimestamp(iso);
  const text = date.toLocaleString(locale === "ru" ? "ru-RU" : "en-US", {
    ...(mode === "date" ? DATE_OPTS : DATETIME_OPTS),
    // Pin to UTC until mounted so SSR and first hydration agree; then fall back
    // to the viewer's local zone.
    timeZone: mounted ? undefined : "UTC",
  });
  return (
    <time
      dateTime={date.toISOString()}
      className={className}
      suppressHydrationWarning
    >
      {text}
    </time>
  );
}
