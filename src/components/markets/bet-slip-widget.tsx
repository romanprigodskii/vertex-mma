"use client";

import * as React from "react";
import { usePathname, useRouter } from "next/navigation";
import { useLocale, useTranslations } from "next-intl";
import { Share2, Ticket, X } from "lucide-react";

import { placeParlayAction } from "@/app/[locale]/markets/actions";
import { encodeSlip, useBetSlip } from "@/components/markets/bet-slip-context";
import { Link } from "@/i18n/navigation";
import { formatNumber } from "@/lib/format";
import {
  MIN_PARLAY_LEGS,
  combineParlayOdds,
  formatOdds,
  potentialPayout,
} from "@/lib/sportsbook";
import { cn } from "@/lib/utils";

export function BetSlipWidget() {
  const t = useTranslations("sportsbook");
  const router = useRouter();
  const pathname = usePathname();
  const locale = useLocale();
  const { legs, removeBout, clear, hydrated } = useBetSlip();
  const [open, setOpen] = React.useState(false);
  const [shareMsg, setShareMsg] = React.useState<string | null>(null);
  const [stake, setStake] = React.useState("100");
  const [pending, setPending] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const [needAuth, setNeedAuth] = React.useState(false);
  // Set on a successful place so the widget stays mounted to confirm + offer a
  // share link even though the slip itself is cleared.
  const [placed, setPlaced] = React.useState<{
    id?: string;
    odds: number;
    payout: number;
  } | null>(null);

  // Avoid SSR/first-paint mismatch — render nothing until the slip hydrates.
  if (!hydrated) return null;
  // Nothing to show: empty slip and no just-placed confirmation.
  if (legs.length === 0 && !placed) return null;

  const combined = combineParlayOdds(legs.map((l) => l.odds));
  const parsedStake = (() => {
    const n = parseInt(stake, 10);
    return Number.isFinite(n) && n > 0 ? n : 0;
  })();
  const payout = potentialPayout(parsedStake, combined);
  const enoughLegs = legs.length >= MIN_PARLAY_LEGS;

  function translateError(code: string): string {
    switch (code) {
      case "NOT_SIGNED_IN":
        return t("errNotSignedIn");
      case "RATE_LIMITED":
        return t("errRateLimited");
      case "INVALID_AMOUNT":
        return t("errInvalidAmount");
      case "NOT_ENOUGH_COINS":
        return t("notEnough");
      case "PARLAY_LEG_COUNT":
        return t("errParlayLegs");
      case "PARLAY_DUP_BOUT":
        return t("errParlayDup");
      case "PARLAY_LEG_CLOSED":
        return t("errParlayLegClosed");
      case "PARLAY_NO_ODDS":
        return t("errParlayNoOdds");
      case "MARKET_NOT_OFFERED":
        return t("errMarketNotOffered");
      default:
        return t("errGeneric");
    }
  }

  async function onShare() {
    const url = `${window.location.origin}/${locale}/markets?slip=${encodeURIComponent(
      encodeSlip(legs),
    )}`;
    try {
      if (typeof navigator !== "undefined" && navigator.share) {
        await navigator.share({ title: t("slipTitle"), url });
      } else if (typeof navigator !== "undefined" && navigator.clipboard) {
        await navigator.clipboard.writeText(url);
        setShareMsg(t("shareCopied"));
        setTimeout(() => setShareMsg(null), 2000);
      }
    } catch {
      // user cancelled the share sheet / clipboard blocked — no-op
    }
  }

  async function onPlace() {
    setError(null);
    setNeedAuth(false);
    if (!enoughLegs || parsedStake < 1) return;
    setPending(true);
    const res = await placeParlayAction(
      legs.map((l) => ({ boutId: l.boutId, code: l.code })),
      parsedStake,
    );
    setPending(false);
    if (res.error) {
      // Branch on the stable machine code, NOT the (now localized) message —
      // regex-matching the human text broke the moment errors were localized.
      if (res.error === "NOT_SIGNED_IN") setNeedAuth(true);
      setError(translateError(res.error));
      return;
    }
    setPlaced({
      id: res.parlayId,
      odds: res.combinedOdds ?? combined,
      payout: res.potentialPayout ?? payout,
    });
    clear();
    router.refresh();
  }

  // Just placed: the slip is cleared, so confirm here + offer a share link.
  if (legs.length === 0 && placed) {
    return (
      <div className="fixed bottom-4 right-4 z-50 w-[min(92vw,360px)] rounded-lg border border-foreground/15 bg-background-elevated/95 p-4 shadow-elevation-2 backdrop-blur">
        <p
          className="font-sans text-sm text-streak-win"
          role="status"
          aria-live="polite"
        >
          {t("parlayPlaced", {
            payout: formatNumber(placed.payout),
            odds: formatOdds(placed.odds),
          })}
        </p>
        <div className="mt-3 flex items-center gap-2">
          {placed.id ? (
            <Link
              href={`/parlay/${placed.id}`}
              prefetch={false}
              className="rounded-sm bg-primary px-3 py-1.5 font-display text-xs uppercase tracking-widest text-background-base hover:opacity-90"
            >
              {t("viewShare")}
            </Link>
          ) : null}
          <button
            type="button"
            onClick={() => setPlaced(null)}
            className="rounded-sm border border-foreground/15 px-3 py-1.5 font-sans text-xs uppercase tracking-widest text-foreground-muted hover:text-foreground"
          >
            {t("done")}
          </button>
        </div>
      </div>
    );
  }

  return (
    <>
      {/* click-catcher to close on outside tap */}
      {open ? (
        <button
          type="button"
          aria-hidden
          tabIndex={-1}
          onClick={() => setOpen(false)}
          className="fixed inset-0 z-40 cursor-default bg-transparent"
        />
      ) : null}

      <div className="fixed bottom-4 right-4 z-50 flex flex-col items-end gap-3">
        {open ? (
          <div className="w-[min(92vw,360px)] overflow-hidden rounded-lg border border-foreground/15 bg-background-elevated/95 shadow-elevation-2 backdrop-blur">
            <div className="flex items-center justify-between border-b border-foreground/10 px-4 py-3">
              <h2 className="font-display text-sm uppercase tracking-widest text-foreground">
                {t("slipTitle")}
              </h2>
              <div className="flex items-center gap-3">
                <button
                  type="button"
                  onClick={onShare}
                  className="inline-flex items-center gap-1 font-sans text-[11px] uppercase tracking-widest text-foreground-subtle hover:text-primary"
                >
                  <Share2 className="h-3 w-3" aria-hidden />
                  {shareMsg ?? t("share")}
                </button>
                <button
                  type="button"
                  onClick={() => clear()}
                  className="font-sans text-[11px] uppercase tracking-widest text-foreground-subtle hover:text-streak-loss"
                >
                  {t("clearSlip")}
                </button>
              </div>
            </div>

            <ul className="max-h-[40vh] divide-y divide-foreground/[0.06] overflow-y-auto">
              {legs.map((l) => (
                <li key={l.boutId} className="flex items-center gap-2 px-4 py-2.5">
                  <div className="min-w-0 flex-1">
                    <p className="truncate font-sans text-sm text-foreground">
                      {l.pickLabel}
                    </p>
                    <p className="truncate font-mono text-[10px] uppercase tracking-wide text-foreground-subtle">
                      {l.boutLabel} · {formatOdds(l.odds)}
                    </p>
                  </div>
                  <button
                    type="button"
                    aria-label={t("removeLeg")}
                    onClick={() => removeBout(l.boutId)}
                    className="shrink-0 rounded-sm p-1 text-foreground-subtle hover:text-streak-loss"
                  >
                    <X className="h-3.5 w-3.5" />
                  </button>
                </li>
              ))}
            </ul>

            <div className="border-t border-foreground/10 px-4 py-3">
              <div className="mb-2 flex items-center justify-between font-mono text-[11px] tabular text-foreground-muted">
                <span>{t("combinedOdds")}</span>
                <span className="font-display text-base text-foreground">
                  {formatOdds(combined)}
                </span>
              </div>
              <div className="flex items-end gap-2">
                <label className="flex flex-1 flex-col gap-1">
                  <span className="font-sans text-[10px] uppercase tracking-widest text-foreground-subtle">
                    {t("stakeLabel")}
                  </span>
                  <input
                    type="number"
                    min={1}
                    step={1}
                    value={stake}
                    onChange={(e) => setStake(e.target.value)}
                    className="rounded-sm border border-foreground/15 bg-background-elevated/30 px-2.5 py-1.5 font-mono text-sm tabular text-foreground focus:border-primary focus:outline-none"
                  />
                </label>
                <div className="flex flex-1 flex-col gap-1 text-right">
                  <span className="font-sans text-[10px] uppercase tracking-widest text-foreground-subtle">
                    {t("toWinLabel")}
                  </span>
                  <span className="font-display text-lg tabular text-foreground">
                    {/* Only show a concrete "to win" once the parlay is actually
                        placeable (≥ MIN legs) — otherwise it implies a payout a
                        1-leg slip can't collect. */}
                    {enoughLegs && parsedStake > 0 ? formatNumber(payout) : "—"}
                  </span>
                </div>
              </div>

              <button
                type="button"
                onClick={onPlace}
                data-umami-event="parlay-place"
                disabled={pending || !enoughLegs || parsedStake < 1}
                className="mt-3 w-full rounded-sm bg-primary px-4 py-2.5 font-display text-sm uppercase tracking-widest text-background-base hover:opacity-90 disabled:opacity-50"
              >
                {pending
                  ? t("placing")
                  : enoughLegs
                    ? t("placeParlay")
                    : t("needMorePicks")}
              </button>

              {/* Explain what's missing rather than relying on a greyed button. */}
              {!pending && !needAuth && !error ? (
                !enoughLegs ? (
                  <p className="mt-2 font-sans text-[11px] text-foreground-subtle">
                    {t("slipAddMore")}
                  </p>
                ) : parsedStake < 1 ? (
                  <p className="mt-2 font-sans text-[11px] text-foreground-subtle">
                    {t("hintEnterStake")}
                  </p>
                ) : null
              ) : null}

              {needAuth ? (
                <Link
                  href={`/signin?next=${encodeURIComponent(pathname || "/markets")}`}
                  className="mt-2 block text-center font-sans text-xs text-primary hover:underline"
                >
                  {t("signInToBet")}
                </Link>
              ) : error ? (
                <p className="mt-2 font-sans text-xs text-streak-loss" role="alert">
                  {error}
                </p>
              ) : null}
            </div>
          </div>
        ) : null}

        <button
          type="button"
          onClick={() => setOpen((v) => !v)}
          aria-label={t("slipAria", { n: legs.length })}
          className={cn(
            "inline-flex items-center gap-2 rounded-full border border-foreground/15 bg-background-elevated/95 px-4 py-2.5 font-display text-sm uppercase tracking-widest text-foreground shadow-elevation-2 backdrop-blur transition-colors hover:border-primary/40",
          )}
        >
          <Ticket className="h-4 w-4 text-primary" aria-hidden />
          {t("slipTitle")}
          <span className="inline-flex h-5 min-w-5 items-center justify-center rounded-full bg-primary px-1.5 font-mono text-[11px] tabular text-background-base">
            {legs.length}
          </span>
        </button>
      </div>
    </>
  );
}
