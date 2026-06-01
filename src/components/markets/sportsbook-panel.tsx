"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";

import { placeFixedOddsBetAction } from "@/app/[locale]/markets/actions";
import { useBetSlip } from "@/components/markets/bet-slip-context";
import { Link } from "@/i18n/navigation";
import {
  type SportsbookMarketKind,
  type SportsbookOutcome,
  describeSelection,
  formatOdds,
  hasValueEdge,
  modelEdgeForSide,
  potentialPayout,
} from "@/lib/sportsbook";
import { cn } from "@/lib/utils";

interface Props {
  boutId: string;
  fighterAName: string;
  fighterBName: string;
  /** Pre-computed model outcomes (server-side, via computeSportsbookOutcomes). */
  outcomes: SportsbookOutcome[];
  /** Coin balance, or null when signed out. */
  userBalance: number | null;
  signInHref: string;
  /** Bookmaker consensus moneyline (decimal), shown as a reference only. */
  consensus?: { aDecimal: number | null; bDecimal: number | null } | null;
  /** Model−market winner edge (bout_simulation.edge_a). Drives the "value"
   *  badge on the winner market; null when the bout has no market line. */
  edgeA?: number | null;
}

const MARKET_ORDER: SportsbookMarketKind[] = [
  "winner",
  "method",
  "total_rounds",
  "distance",
];

export function SportsbookPanel({
  boutId,
  fighterAName,
  fighterBName,
  outcomes,
  userBalance,
  signInHref,
  consensus,
  edgeA,
}: Props) {
  const t = useTranslations("sportsbook");
  const router = useRouter();
  const { toggleLeg, codeForBout } = useBetSlip();
  const slipCode = codeForBout(boutId);
  const [selected, setSelected] = React.useState<SportsbookOutcome | null>(null);
  const [stake, setStake] = React.useState("100");
  const [pending, setPending] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const [success, setSuccess] = React.useState<string | null>(null);

  const signedIn = userBalance != null;
  const parsedStake = (() => {
    const n = parseInt(stake, 10);
    return Number.isFinite(n) && n > 0 ? n : 0;
  })();
  const payout = selected ? potentialPayout(parsedStake, selected.decimalOdds) : 0;
  const profit = payout - parsedStake;

  // Short label used inside a market section (the section header already
  // carries the market name; method buttons add the fighter prefix inline).
  const labelFor = React.useCallback(
    (o: SportsbookOutcome): string => {
      const d = describeSelection(o.code);
      const name = d.side === "a" ? fighterAName : fighterBName;
      switch (d.marketKind) {
        case "winner":
          return name;
        case "method":
          return t(`method_${d.methodKey}` as "method_ko");
        case "total_rounds":
          return d.totalKey === "over" ? t("over25") : t("under25");
        case "distance":
          return d.distanceKey === "yes" ? t("distanceYes") : t("distanceNo");
      }
    },
    [fighterAName, fighterBName, t],
  );

  // Unambiguous label for the bet slip (includes fighter + market context).
  const fullLabel = React.useCallback(
    (o: SportsbookOutcome): string => {
      const d = describeSelection(o.code);
      const name = d.side === "a" ? fighterAName : fighterBName;
      switch (d.marketKind) {
        case "winner":
          return name;
        case "method":
          return `${name} ${t(`method_${d.methodKey}` as "method_ko")}`;
        case "total_rounds":
          return `${t("market_total_rounds")}: ${labelFor(o)}`;
        case "distance":
          return `${t("market_distance")}: ${labelFor(o)}`;
      }
    },
    [fighterAName, fighterBName, labelFor, t],
  );

  async function onPlace() {
    if (!selected || parsedStake < 1) return;
    setError(null);
    setSuccess(null);
    if (userBalance != null && parsedStake > userBalance) {
      setError(t("notEnough"));
      return;
    }
    setPending(true);
    const res = await placeFixedOddsBetAction(boutId, selected.code, parsedStake);
    setPending(false);
    if (res.error) {
      setError(res.error);
      return;
    }
    setSuccess(
      t("placed", {
        payout: res.potentialPayout ?? payout,
        odds: formatOdds(res.decimalOdds ?? selected.decimalOdds),
      }),
    );
    setSelected(null);
    router.refresh();
  }

  const byKind = (k: SportsbookMarketKind) =>
    outcomes.filter((o) => o.marketKind === k);

  return (
    <section className="rounded-lg border border-foreground/10 bg-background-elevated/30 p-5 sm:p-6">
      <div className="flex items-baseline justify-between gap-3">
        <div>
          <h2 className="font-display text-xl uppercase tracking-tight text-foreground">
            {t("title")}
          </h2>
          <p className="mt-0.5 font-sans text-xs text-foreground-muted">
            {t("tagline")}
          </p>
        </div>
        {signedIn ? (
          <p className="shrink-0 font-mono text-[11px] tabular text-foreground-subtle">
            {t("balance", { n: userBalance!.toLocaleString() })}
          </p>
        ) : null}
      </div>

      <div className="mt-5 flex flex-col gap-5">
        {MARKET_ORDER.map((kind) => {
          const group = byKind(kind);
          if (group.length === 0) return null;
          return (
            <div key={kind}>
              <div className="mb-2 flex items-baseline gap-2">
                <h3 className="font-sans text-[11px] font-medium uppercase tracking-widest text-foreground-muted">
                  {t(`market_${kind}` as "market_winner")}
                </h3>
                {kind === "winner" && consensus ? (
                  <span className="font-mono text-[10px] tabular text-foreground-subtle">
                    {t("consensus", {
                      a: consensus.aDecimal ? consensus.aDecimal.toFixed(2) : "—",
                      b: consensus.bDecimal ? consensus.bDecimal.toFixed(2) : "—",
                    })}
                  </span>
                ) : null}
              </div>
              <div
                className={cn(
                  "grid gap-2",
                  kind === "method" ? "grid-cols-2 sm:grid-cols-3" : "grid-cols-2",
                )}
              >
                {group.map((o) => {
                  const isSel = selected?.code === o.code;
                  return (
                    <button
                      key={o.code}
                      type="button"
                      onClick={() => {
                        setSelected(o);
                        setSuccess(null);
                        setError(null);
                      }}
                      aria-pressed={isSel}
                      className={cn(
                        "flex flex-col items-start rounded-md border px-3 py-2.5 text-left transition-colors",
                        isSel
                          ? "border-primary bg-primary/10"
                          : "border-foreground/10 bg-foreground/[0.03] hover:border-foreground/30",
                      )}
                    >
                      <span className="w-full truncate font-sans text-[11px] uppercase tracking-wide text-foreground-muted">
                        {kind === "method" ? (
                          <>
                            <span className="text-foreground-subtle">
                              {describeSelection(o.code).side === "a"
                                ? fighterAName
                                : fighterBName}
                            </span>{" "}
                            {labelFor(o)}
                          </>
                        ) : (
                          labelFor(o)
                        )}
                      </span>
                      <span className="mt-1 font-display text-2xl tabular leading-none text-foreground">
                        {formatOdds(o.decimalOdds)}
                      </span>
                      <span className="mt-1 font-mono text-[10px] tabular text-foreground-subtle">
                        {t("modelPct", { pct: (o.prob * 100).toFixed(0) })}
                      </span>
                      {o.marketKind === "winner" &&
                      o.side &&
                      hasValueEdge(edgeA ?? null, o.side) ? (
                        <span
                          title={t("valueTooltip")}
                          className="mt-1 inline-flex items-center rounded-sm bg-primary/15 px-1.5 py-0.5 font-sans text-[9px] font-semibold uppercase tracking-wide text-primary"
                        >
                          {t("valueBadge", {
                            pp: Math.round(
                              (modelEdgeForSide(edgeA ?? null, o.side) ?? 0) * 100,
                            ),
                          })}
                        </span>
                      ) : null}
                    </button>
                  );
                })}
              </div>
            </div>
          );
        })}
      </div>

      {/* Add to parlay slip — available whether or not signed in (the slip is
          client-side; placement auth is enforced server-side). */}
      {selected ? (
        <div className="mt-4 flex items-center justify-between gap-3 rounded-md border border-dashed border-foreground/15 bg-foreground/[0.02] px-3 py-2">
          <span className="min-w-0 truncate font-sans text-[11px] text-foreground-muted">
            {slipCode === selected.code
              ? t("inSlip", { pick: fullLabel(selected) })
              : t("addToSlipHint", { pick: fullLabel(selected) })}
          </span>
          <button
            type="button"
            onClick={() =>
              toggleLeg({
                boutId,
                code: selected.code,
                odds: selected.decimalOdds,
                boutLabel: `${fighterAName} vs ${fighterBName}`,
                pickLabel: fullLabel(selected),
              })
            }
            className={cn(
              "shrink-0 rounded-sm border px-3 py-1.5 font-sans text-[11px] uppercase tracking-widest transition-colors",
              slipCode === selected.code
                ? "border-primary/40 bg-primary/10 text-primary"
                : "border-foreground/20 text-foreground-muted hover:border-foreground/40 hover:text-foreground",
            )}
          >
            {slipCode === selected.code ? t("inSlipRemove") : t("addToSlip")}
          </button>
        </div>
      ) : null}

      {/* Bet slip */}
      <div className="mt-6 border-t border-foreground/10 pt-5">
        {!signedIn ? (
          <Link
            href={signInHref}
            className="inline-block rounded-sm bg-primary px-4 py-2.5 font-display text-sm uppercase tracking-widest text-background-base hover:opacity-90"
          >
            {t("signInToBet")}
          </Link>
        ) : (
          <>
            <div className="flex flex-col gap-3 sm:flex-row sm:items-end">
              <label className="flex flex-1 flex-col gap-1">
                <span className="font-sans text-[10px] uppercase tracking-widest text-foreground-subtle">
                  {t("stakeLabel")}
                </span>
                <input
                  type="number"
                  min={1}
                  max={userBalance ?? undefined}
                  step={1}
                  value={stake}
                  onChange={(e) => setStake(e.target.value)}
                  className="rounded-sm border border-foreground/15 bg-background-elevated/30 px-3 py-2 font-mono text-sm tabular text-foreground focus:border-primary focus:outline-none"
                />
              </label>
              <div className="flex flex-1 flex-col gap-1">
                <span className="font-sans text-[10px] uppercase tracking-widest text-foreground-subtle">
                  {selected ? fullLabel(selected) : t("pickFirst")}
                </span>
                <p className="font-display text-lg tabular text-foreground">
                  {selected && parsedStake > 0 ? (
                    <>
                      {payout.toLocaleString()}{" "}
                      <span className="font-sans text-xs text-foreground-muted">
                        {t("toWin", { profit: profit.toLocaleString() })}
                      </span>
                    </>
                  ) : (
                    <span className="text-foreground-subtle">—</span>
                  )}
                </p>
              </div>
              <button
                type="button"
                onClick={onPlace}
                disabled={
                  pending ||
                  !selected ||
                  parsedStake < 1 ||
                  (userBalance != null && parsedStake > userBalance)
                }
                className="rounded-sm bg-primary px-5 py-2.5 font-display text-sm uppercase tracking-widest text-background-base hover:opacity-90 disabled:opacity-50"
              >
                {pending ? t("placing") : t("placeBet")}
              </button>
            </div>
            {error ? (
              <p className="mt-3 font-sans text-sm text-streak-loss" role="alert">
                {error}
              </p>
            ) : null}
            {success ? (
              <p className="mt-3 font-sans text-sm text-streak-win">{success}</p>
            ) : null}
          </>
        )}
        <p className="mt-3 font-sans text-[11px] leading-relaxed text-foreground-subtle">
          {t("hint")}
        </p>
      </div>
    </section>
  );
}
