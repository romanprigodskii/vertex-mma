"use client";

import * as React from "react";
import { useLocale, useTranslations } from "next-intl";

import { markNotificationReadAction } from "@/app/[locale]/notifications/actions";
import { useLocalizedNotification } from "@/components/notifications/use-localized-notification";
import { Link } from "@/i18n/navigation";
import type { NotificationRow as NotificationRowData } from "@/lib/notifications";
import { cn } from "@/lib/utils";

const TYPE_ICON: Record<string, string> = {
  bet_settled: "💰",
  achievement_unlocked: "⭐",
  system: "📢",
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

export function NotificationRow({ notification: n }: Props) {
  const t = useTranslations("notifications");
  const formatAgo = useFormatAgo();
  const localize = useLocalizedNotification();
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
      <span className="shrink-0 text-xl" aria-hidden>
        {TYPE_ICON[n.type] ?? "📬"}
      </span>
      <div className="min-w-0 flex-1">
        <p
          className={cn(
            "font-sans text-sm",
            readNow
              ? "text-foreground-muted"
              : "font-medium text-foreground",
          )}
        >
          {title}
        </p>
        {localizedBody ? (
          <p className="mt-0.5 font-sans text-xs text-foreground-muted line-clamp-2">
            {localizedBody}
          </p>
        ) : null}
        <p className="mt-1 font-mono text-[10px] tabular text-foreground-subtle">
          {formatAgo(n.created_at)}
        </p>
      </div>
      {!readNow ? (
        <span
          className="mt-1.5 h-2 w-2 shrink-0 rounded-full bg-primary"
          aria-label={t("unread")}
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
