"use client";

import * as React from "react";
import { useTranslations } from "next-intl";
import { ChevronRight } from "lucide-react";

import { useBetSlip } from "@/components/markets/bet-slip-context";
import { NewsTimestamp } from "@/components/news/news-timestamp";
import { Link } from "@/i18n/navigation";
import {
  formatOdds,
  hasValueEdge,
  modelEdgeForSide,
} from "@/lib/sportsbook";
import type { BoardBout, BoardEvent, BoardPrice } from "@/lib/sportsbook-board";
import { cn } from "@/lib/utils";

function PriceButton({
  boutId,
  price,
  name,
  boutLabel,
  side,
  edgeA,
}: {
  boutId: string;
  price: BoardPrice;
  name: string;
  boutLabel: string;
  side: "a" | "b";
  edgeA: number | null;
}) {
  const t = useTranslations("sportsbook");
  const { toggleLeg, codeForBout, hydrated } = useBetSlip();
  const inSlip = hydrated && codeForBout(boutId) === price.code;
  const showValue = hasValueEdge(edgeA, side);

  return (
    <button
      type="button"
      aria-pressed={inSlip}
      onClick={() =>
        toggleLeg({
          boutId,
          code: price.code,
          odds: price.decimalOdds,
          boutLabel,
          pickLabel: name,
        })
      }
      className={cn(
        "flex flex-1 flex-col items-start rounded-md border px-3 py-2.5 text-left transition-colors",
        inSlip
          ? "border-primary bg-primary/10"
          : "border-foreground/10 bg-foreground/[0.03] hover:border-foreground/30",
      )}
    >
      <span className="flex w-full items-center gap-1.5">
        <span className="min-w-0 flex-1 truncate font-sans text-xs font-medium text-foreground">
          {name}
        </span>
        {showValue ? (
          <span
            title={t("valueTooltip")}
            aria-label={t("valueTooltip")}
            className="shrink-0 rounded-sm bg-primary/15 px-1 py-0.5 font-sans text-[10px] font-semibold uppercase tracking-wide text-primary"
          >
            {t("valueBadge", {
              pp: Math.round((modelEdgeForSide(edgeA, side) ?? 0) * 100),
            })}
          </span>
        ) : null}
      </span>
      <span className="mt-1 font-display text-2xl tabular leading-none text-foreground">
        {formatOdds(price.decimalOdds)}
      </span>
      <span className="mt-1 font-mono text-[10px] tabular text-foreground-subtle">
        {t("modelPct", { pct: (price.prob * 100).toFixed(0) })}
      </span>
    </button>
  );
}

function BoardBoutCard({ bout }: { bout: BoardBout }) {
  const t = useTranslations("sportsbook");
  const tMarkets = useTranslations("markets");
  const tWeight = useTranslations("weight");
  const weightLabel = tWeight.has(bout.weightClass)
    ? tWeight(bout.weightClass)
    : bout.weightClass;
  const boutLabel = `${bout.fighterAName} vs ${bout.fighterBName}`;

  return (
    <div className="rounded-md border border-foreground/10 bg-background-elevated/30 p-3.5">
      <div className="mb-2.5 flex flex-wrap items-center gap-2 font-mono text-[10px] uppercase tracking-widest text-foreground-subtle">
        {bout.isTitleFight ? (
          <span className="rounded-sm border border-gold/30 bg-gold/10 px-1.5 py-0.5 text-gold">
            {tMarkets("title")}
          </span>
        ) : bout.isMainEvent ? (
          <span className="rounded-sm border border-primary/30 bg-primary/10 px-1.5 py-0.5 text-primary">
            {tMarkets("main")}
          </span>
        ) : null}
        <span className="truncate text-foreground-muted">{weightLabel}</span>
      </div>

      <div className="flex items-stretch gap-2">
        <PriceButton
          boutId={bout.boutId}
          price={bout.winnerA}
          name={bout.fighterAName}
          boutLabel={boutLabel}
          side="a"
          edgeA={bout.edgeA}
        />
        <PriceButton
          boutId={bout.boutId}
          price={bout.winnerB}
          name={bout.fighterBName}
          boutLabel={boutLabel}
          side="b"
          edgeA={bout.edgeA}
        />
      </div>

      <div className="mt-2.5 flex items-center justify-between gap-2">
        {bout.consensus ? (
          <span className="font-mono text-[10px] tabular text-foreground-subtle">
            {t("consensus", {
              a: bout.consensus.aDecimal
                ? bout.consensus.aDecimal.toFixed(2)
                : "—",
              b: bout.consensus.bDecimal
                ? bout.consensus.bDecimal.toFixed(2)
                : "—",
            })}
          </span>
        ) : (
          <span />
        )}
        <Link
          href={`/bouts/${bout.boutId}`}
          prefetch={false}
          className="inline-flex items-center gap-0.5 font-sans text-[11px] text-primary hover:underline"
        >
          {t("boardAllMarkets")}
          <ChevronRight className="h-3 w-3" aria-hidden />
        </Link>
      </div>
    </div>
  );
}

export function SportsbookBoard({ events }: { events: BoardEvent[] }) {
  const tMarkets = useTranslations("markets");

  if (events.length === 0) {
    return (
      <div className="rounded-md border border-dashed border-foreground/15 bg-background-elevated/20 px-6 py-12 text-center">
        <p className="font-sans text-sm text-foreground-muted">
          {tMarkets("sportsbookEmpty")}
        </p>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-8">
      {events.map((ev) => (
        <div key={ev.slug}>
          <div className="mb-3 flex items-baseline justify-between gap-3 border-b border-foreground/10 pb-2">
            <Link
              href={`/events/${ev.slug}`}
              className="min-w-0 truncate font-display text-base uppercase tracking-tight text-foreground hover:text-primary"
            >
              {ev.shortName || ev.name}
            </Link>
            <NewsTimestamp
              iso={ev.date}
              variant="compact"
              className="shrink-0 font-mono text-[10px] tabular text-foreground-subtle"
            />
          </div>
          <div className="grid gap-2.5 sm:grid-cols-2 xl:grid-cols-3">
            {ev.bouts.map((b) => (
              <BoardBoutCard key={b.boutId} bout={b} />
            ))}
          </div>
        </div>
      ))}
    </div>
  );
}
