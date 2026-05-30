import { getLocale, getTranslations } from "next-intl/server";
import { Check, X } from "lucide-react";

import { Link } from "@/i18n/navigation";
import type { GradedSimulationPick } from "@/lib/simulation-accuracy";
import { cn } from "@/lib/utils";

interface Props {
  picks: GradedSimulationPick[];
  /** Cap how many to render — caller usually wants 10. */
  limit?: number;
}

function formatDate(iso: string, locale: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso.slice(0, 10);
  return d.toLocaleDateString(locale === "ru" ? "ru-RU" : "en-US", {
    month: "short",
    day: "numeric",
  });
}

const METHOD_KEY: Record<string, string> = {
  ko: "methodKo",
  tko: "methodTko",
  submission: "methodSub",
  decision_unanimous: "methodUDec",
  decision_split: "methodSDec",
  decision_majority: "methodMDec",
};

export async function RecentGradedList({ picks, limit = 10 }: Props) {
  const t = await getTranslations("simulationIndex");
  const tHistory = await getTranslations("scoreHistory");
  const locale = await getLocale();
  const visible = picks.slice(0, limit);

  if (visible.length === 0) return null;

  return (
    <section
      aria-label={t("recentGradedHeading")}
      className="mb-10 rounded-md border border-foreground/10 bg-background-elevated/20 px-4 py-4 sm:px-5"
    >
      <header className="mb-3 flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
        <h2 className="font-sans text-[11px] font-medium uppercase tracking-widest text-foreground-muted">
          {t("recentGradedHeading")}
        </h2>
        <span className="font-mono text-[10px] uppercase tracking-widest text-foreground-subtle">
          {t("recentGradedSubtitle", { n: visible.length })}
        </span>
      </header>

      <ul className="flex flex-col">
        {visible.map((p) => {
          const methodKey = p.method ? METHOD_KEY[p.method] : null;
          const methodLabel = methodKey
            ? tHistory(methodKey as "methodKo")
            : p.method;
          return (
            <li
              key={p.boutId}
              className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1 border-b border-foreground/[0.06] py-2.5 last:border-b-0"
            >
              <Link
                href={`/bouts/${p.boutId}`}
                prefetch={false}
                className="flex min-w-0 items-baseline gap-2 font-sans text-sm text-foreground transition-colors hover:text-primary"
              >
                <span
                  aria-hidden
                  className={cn(
                    "inline-flex h-4 w-4 shrink-0 items-center justify-center rounded-sm",
                    p.correct
                      ? "bg-streak-win/15 text-streak-win"
                      : "bg-streak-loss/15 text-streak-loss",
                  )}
                >
                  {p.correct ? (
                    <Check className="h-3 w-3" strokeWidth={3} />
                  ) : (
                    <X className="h-3 w-3" strokeWidth={3} />
                  )}
                </span>
                <span className="truncate">
                  <span className="font-display uppercase tracking-tight">
                    {p.correct
                      ? p.predictedWinnerName
                      : t("recentWrongPick", {
                          pred: p.predictedWinnerName,
                          actual: p.actualWinnerName,
                        })}
                  </span>
                </span>
              </Link>
              <span className="flex shrink-0 items-baseline gap-3 font-mono text-[10px] uppercase tracking-widest text-foreground-subtle">
                <span>
                  {t("recentPickAt", {
                    pct: `${Math.round(p.predictedWinnerProb * 100)}%`,
                  })}
                </span>
                {methodLabel ? <span>{methodLabel}</span> : null}
                <span>{formatDate(p.eventDate, locale)}</span>
              </span>
            </li>
          );
        })}
      </ul>
    </section>
  );
}
