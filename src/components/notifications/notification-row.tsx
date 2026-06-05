"use client";

import * as React from "react";
import { Award, Bell, Coins, Megaphone, type LucideIcon } from "lucide-react";
import { useLocale, useTranslations } from "next-intl";

import { markNotificationReadAction } from "@/app/[locale]/notifications/actions";
import { useLocalizedNotification } from "@/components/notifications/use-localized-notification";
import { useMounted } from "@/hooks/use-mounted";
import { Link } from "@/i18n/navigation";
import type { NotificationRow as NotificationRowData } from "@/lib/notifications";
import { cn } from "@/lib/utils";

// Monochrome lucide icons (tinted with theme tokens) instead of emoji, which
// render inconsistently across OS/browser and clash with the rest of the app's
// icon design language. Unknown types fall back to a generic bell.
const TYPE_ICON: Record<string, LucideIcon> = {
  bet_settled: Coins,
  achievement_unlocked: Award,
  system: Megaphone,
};

interface Props {
  notification: NotificationRowData;
}

function useFormatAgo() {
  const t = useTranslations("notifications");
  const locale = useLocale();
  return React.useCallback(
    (iso: string): string => {
      const diffMs = Date.now() - new Date(iso).getTime();
      if (!Number.isFinite(diffMs) || diffMs < 0) return t("justNow");
      const diff = diffMs / 1000;
      if (diff < 60) return t("justNow");
      if (diff < 3600) return t("minutesAgo", { n: Math.floor(diff / 60) });
      if (diff < 86400) return t("hoursAgo", { n: Math.floor(diff / 3600) });
      if (diff < 7 * 86400) return t("daysAgo", { n: Math.floor(diff / 86400) });
      return new Date(iso).toLocaleDateString(
        locale === "ru" ? "ru-RU" : "en-US",
      );
    },
    [t, locale],
  );
}

/** Deterministic absolute date ("Jun 5, 2026") for the SSR / pre-mount render,
 *  so the timestamp slot is never empty (no layout shift, and a date still
 *  shows with JS disabled). Postgres `timestamptz::text` arrives as
 *  "2026-06-05 15:00:00+00", which Safari rejects, so normalize to ISO 8601
 *  first; render in UTC so the server and the first client render produce the
 *  identical string regardless of the viewer's time zone. After mount it's
 *  replaced by the relative "5m ago" string (suppressHydrationWarning on the
 *  host covers the swap). */
function formatAbsoluteDate(iso: string, locale: string): string {
  const normalized = iso.replace(" ", "T").replace(/([+-]\d{2})$/, "$1:00");
  const d = new Date(normalized);
  if (Number.isNaN(d.getTime())) return "";
  return d.toLocaleDateString(locale === "ru" ? "ru-RU" : "en-US", {
    year: "numeric",
    month: "short",
    day: "numeric",
    timeZone: "UTC",
  });
}

export function NotificationRow({ notification: n }: Props) {
  const t = useTranslations("notifications");
  const locale = useLocale();
  const formatAgo = useFormatAgo();
  const mounted = useMounted();
  const localize = useLocalizedNotification();
  const Icon = TYPE_ICON[n.type] ?? Bell;
  const { title, body: localizedBody } = localize(n);
  // Local optimistic flip so the row visually quiets the moment the user
  // clicks — the server action also marks it server-side, and the next
  // page refresh confirms via revalidatePath.
  const [readNow, setReadNow] = React.useState(n.is_read);

  function markRead() {
    if (readNow) return;
    setReadNow(true);
    void markNotificationReadAction(n.id);
  }

  const body = (
    <div
      className={cn(
        "flex items-start gap-3 border-b border-foreground/[0.06] px-3 py-3",
        readNow ? "bg-transparent" : "bg-primary/[0.04]",
      )}
    >
      <Icon
        className="mt-0.5 h-5 w-5 shrink-0 text-foreground-muted"
        aria-hidden
      />
      <div className="min-w-0 flex-1">
        <p
          className={cn(
            "line-clamp-2 font-sans text-sm",
            readNow
              ? "text-foreground-muted"
              : "font-medium text-foreground",
          )}
        >
          {!readNow ? <span className="sr-only">{t("unread")}: </span> : null}
          {title}
        </p>
        {localizedBody ? (
          <p className="mt-0.5 font-sans text-xs text-foreground-muted line-clamp-2">
            {localizedBody}
          </p>
        ) : null}
        <p
          className="mt-1 font-mono text-[10px] tabular text-foreground-subtle"
          suppressHydrationWarning
        >
          {mounted
            ? formatAgo(n.created_at)
            : formatAbsoluteDate(n.created_at, locale)}
        </p>
      </div>
      {!readNow ? (
        <span
          className="mt-1.5 h-2 w-2 shrink-0 rounded-full bg-primary"
          aria-hidden
        />
      ) : null}
    </div>
  );

  if (n.link) {
    return (
      <Link
        href={n.link}
        prefetch={false}
        onClick={markRead}
        className="block hover:bg-foreground/[0.03]"
      >
        {body}
      </Link>
    );
  }
  return (
    <button
      type="button"
      onClick={markRead}
      className="block w-full text-left hover:bg-foreground/[0.03]"
    >
      {body}
    </button>
  );
}
