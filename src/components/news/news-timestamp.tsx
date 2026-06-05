"use client";

import { useEffect, useState } from "react";
import { useLocale, useTranslations } from "next-intl";

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

function formatAbsolute(
  iso: string,
  locale: string,
  variant: Variant,
  timeZone?: string,
): string {
  return parsePgTimestamp(iso).toLocaleString(
    locale === "ru" ? "ru-RU" : "en-US",
    { ...DATE_OPTS[variant], hour: "2-digit", minute: "2-digit", timeZone },
  );
}

function formatDateOnly(
  iso: string,
  locale: string,
  variant: Variant,
  timeZone?: string,
): string {
  return parsePgTimestamp(iso).toLocaleDateString(
    locale === "ru" ? "ru-RU" : "en-US",
    { ...DATE_OPTS[variant], timeZone },
  );
}

/** Renders an article's publication time. With `relative` it shows "5m / 3h /
 *  2d ago" (falling back to an absolute date past a week), matching the sidebar
 *  convention used across the feed and related cards; without it, the full
 *  publication date *and* time of day for the article header. Server and the
 *  first client render use a deterministic UTC string (no hydration mismatch);
 *  after mount we re-render in the viewer's timezone / against their clock. */
export function NewsTimestamp({
  iso,
  variant = "short",
  relative = false,
  className,
}: {
  iso: string;
  variant?: Variant;
  relative?: boolean;
  className?: string;
}) {
  const locale = useLocale();
  const t = useTranslations("news");
  const [text, setText] = useState(() =>
    relative
      ? formatDateOnly(iso, locale, variant, "UTC")
      : formatAbsolute(iso, locale, variant, "UTC"),
  );

  useEffect(() => {
    let next: string;
    if (!relative) {
      next = formatAbsolute(iso, locale, variant);
    } else {
      const then = parsePgTimestamp(iso).getTime();
      const diffMs = Math.max(0, Date.now() - then);
      const minutes = Math.round(diffMs / 60_000);
      if (minutes < 1) next = t("justNow");
      else if (minutes < 60) next = t("minutesAgo", { n: minutes });
      else {
        const hours = Math.round(minutes / 60);
        if (hours < 24) next = t("hoursAgo", { n: hours });
        else {
          const days = Math.round(hours / 24);
          next =
            days < 7
              ? t("daysAgo", { n: days })
              : formatDateOnly(iso, locale, variant);
        }
      }
    }
    // One post-mount sync to the viewer's clock/timezone — the same accepted
    // mount-flip pattern as useMounted / the original NewsTimestamp.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setText(next);
  }, [iso, locale, variant, relative, t]);

  return (
    <time
      dateTime={parsePgTimestamp(iso).toISOString()}
      className={className}
      suppressHydrationWarning
    >
      {text}
    </time>
  );
}
