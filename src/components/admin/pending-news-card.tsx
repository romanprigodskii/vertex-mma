"use client";

import * as React from "react";
import { useTranslations } from "next-intl";
import { Check, ExternalLink, ShieldAlert, X } from "lucide-react";

import {
  approveNewsAction,
  rejectNewsAction,
} from "@/app/[locale]/admin/news/actions";
import { NewsClassificationBadge } from "@/components/news/news-classification-badge";
import { NewsTimestamp } from "@/components/news/news-timestamp";
import type { PendingNewsItem } from "@/lib/news-moderation";
import { cn } from "@/lib/utils";

export function PendingNewsCard({ item }: { item: PendingNewsItem }) {
  const t = useTranslations("admin");
  const [decision, setDecision] = React.useState<
    null | "approved" | "rejected"
  >(null);
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);

  async function act(kind: "approve" | "reject") {
    if (busy || decision) return;
    setBusy(true);
    setError(null);
    const res =
      kind === "approve"
        ? await approveNewsAction({ id: item.id })
        : await rejectNewsAction({ id: item.id });
    setBusy(false);
    if (res.ok) {
      setDecision(kind === "approve" ? "approved" : "rejected");
    } else {
      setError(res.error ?? t("actionFailed"));
    }
  }

  if (decision) {
    return (
      <div
        className={cn(
          "flex items-center gap-2 rounded-md border px-4 py-3 font-mono text-[11px] uppercase tracking-widest",
          decision === "approved"
            ? "border-streak-win/30 bg-streak-win/[0.06] text-streak-win"
            : "border-foreground/10 bg-foreground/[0.03] text-foreground-subtle",
        )}
      >
        {decision === "approved" ? (
          <Check className="h-3.5 w-3.5" aria-hidden />
        ) : (
          <X className="h-3.5 w-3.5" aria-hidden />
        )}
        {decision === "approved" ? t("approvedMsg") : t("rejectedMsg")}
      </div>
    );
  }

  const confidencePct =
    item.confidence != null ? Math.round(item.confidence * 100) : null;

  return (
    <div className="flex gap-4 rounded-md border border-foreground/10 bg-background-elevated/30 p-4">
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-2 font-mono text-[11px] uppercase tracking-widest text-foreground-subtle">
          <NewsClassificationBadge classification={item.classification} />
          <span className="truncate text-foreground-muted">
            {item.source_name}
          </span>
          {item.is_trusted ? (
            <span className="rounded-sm border border-primary/30 bg-primary/10 px-1.5 py-0.5 text-[9px] text-primary">
              {t("trusted")}
            </span>
          ) : null}
          {confidencePct != null ? (
            <span
              className={cn(
                "tabular",
                confidencePct >= 70
                  ? "text-streak-win"
                  : confidencePct >= 50
                    ? "text-gold"
                    : "text-foreground-subtle",
              )}
            >
              {t("confidence", { pct: confidencePct })}
            </span>
          ) : null}
          <span aria-hidden>·</span>
          <NewsTimestamp
            iso={item.published_at}
            variant="short"
            className="shrink-0 tabular"
          />
        </div>

        <a
          href={item.url}
          target="_blank"
          rel="noopener noreferrer"
          className="mt-2 flex items-start gap-1.5 font-sans text-base font-medium text-foreground hover:text-primary"
        >
          <span>{item.title}</span>
          <ExternalLink
            className="mt-1 h-3.5 w-3.5 shrink-0 text-foreground-subtle"
            aria-hidden
          />
        </a>

        {item.snippet ? (
          <p className="mt-2 line-clamp-4 font-sans text-sm text-foreground-muted">
            {item.snippet}
          </p>
        ) : (
          <p className="mt-2 inline-flex items-center gap-1.5 font-sans text-xs italic text-foreground-subtle">
            <ShieldAlert className="h-3.5 w-3.5" aria-hidden />
            {t("noBody")}
          </p>
        )}

        <div className="mt-3 flex flex-wrap items-center gap-2">
          <button
            type="button"
            onClick={() => act("approve")}
            disabled={busy}
            className="inline-flex items-center gap-1.5 rounded-sm border border-streak-win/40 bg-streak-win/10 px-3 py-1.5 font-sans text-xs font-medium text-streak-win transition-colors hover:bg-streak-win/20 disabled:opacity-50"
          >
            <Check className="h-3.5 w-3.5" />
            {t("approve")}
          </button>
          <button
            type="button"
            onClick={() => act("reject")}
            disabled={busy}
            className="inline-flex items-center gap-1.5 rounded-sm border border-foreground/15 px-3 py-1.5 font-sans text-xs text-foreground-muted transition-colors hover:border-streak-loss/40 hover:text-streak-loss disabled:opacity-50"
          >
            <X className="h-3.5 w-3.5" />
            {t("reject")}
          </button>
          {error ? (
            <span className="font-sans text-xs text-streak-loss">{error}</span>
          ) : null}
        </div>
      </div>

      {item.image_url ? (
        // eslint-disable-next-line @next/next/no-img-element
        <img
          src={item.image_url}
          alt=""
          loading="lazy"
          referrerPolicy="no-referrer"
          className="h-16 w-24 shrink-0 self-center rounded-sm border border-foreground/10 object-cover sm:h-20 sm:w-32"
        />
      ) : null}
    </div>
  );
}
