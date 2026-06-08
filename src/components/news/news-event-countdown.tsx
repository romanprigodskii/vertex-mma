"use client";

import { useEffect, useState } from "react";
import { useLocale, useTranslations } from "next-intl";

function formatAbsolute(iso: string, locale: string): string {
  return new Date(iso).toLocaleDateString(locale === "ru" ? "ru-RU" : "en-US", {
    month: "short",
    day: "numeric",
    timeZone: "UTC",
  });
}

/** Days-until countdown for an upcoming event ("today / tomorrow / N days out").
 *  The delta needs the current clock, which differs between the server and the
 *  viewer's browser and goes stale once the (cacheable) HTML is rendered. The
 *  server and first client render show a deterministic UTC absolute date (no
 *  clock read, so no hydration mismatch); after mount we re-render the relative
 *  countdown against the viewer's clock — mirroring NewsTimestamp. */
export function NewsEventCountdown({
  iso,
  className,
}: {
  iso: string;
  className?: string;
}) {
  const locale = useLocale();
  const t = useTranslations("news");
  const [text, setText] = useState(() => formatAbsolute(iso, locale));

  useEffect(() => {
    const diffDay = Math.round((new Date(iso).getTime() - Date.now()) / 86_400_000);
    const next =
      diffDay <= 0
        ? t("today")
        : diffDay === 1
          ? t("tomorrow")
          : t("daysOut", { n: diffDay });
    // One post-mount sync to the viewer's clock — the same accepted mount-flip
    // pattern as NewsTimestamp.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setText(next);
  }, [iso, t]);

  return (
    <span suppressHydrationWarning className={className}>
      {text}
    </span>
  );
}
