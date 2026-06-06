"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";

import { placeBetAction, previewBetCost } from "@/app/[locale]/markets/actions";
import { formatNumber } from "@/lib/format";
import { priceToDecimalOdds } from "@/lib/lmsr";
import type { MarketDetail } from "@/lib/markets";

const INPUT_CLASS =
  "rounded-sm border border-foreground/15 bg-background-elevated/30 px-3 py-2 font-sans text-sm text-foreground focus:border-primary focus:outline-none";

interface Props {
  market: MarketDetail;
  userBalance: number;
}

type Preview = { shares: number; cost: number; newPrice: number };

/** A starting stake the user can actually afford (never pre-fill more than the
 *  balance, so a near-broke user doesn't land on a silently-disabled button). */
function defaultStake(balance: number): number {
  return Math.min(100, Math.max(0, balance));
}

export function BetForm({ market, userBalance }: Props) {
  const router = useRouter();
  const t = useTranslations("markets");
  const [outcomeId, setOutcomeId] = React.useState(market.outcomes[0]?.id ?? "");
  const [coins, setCoins] = React.useState<string>(() =>
    String(defaultStake(userBalance)),
  );
  const [preview, setPreview] = React.useState<Preview | null>(null);
  const [previewing, setPreviewing] = React.useState(false);
  const [pending, setPending] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const [success, setSuccess] = React.useState<string | null>(null);

  const parsedCoins = (() => {
    const n = parseInt(coins, 10);
    return Number.isFinite(n) && n > 0 ? n : 0;
  })();

  // Will typing `amount` for `outcome` kick off a debounced cost-preview fetch?
  // Used to flip the "Calculating…" hint from the event handlers (not the
  // effect body) so we don't add a setState-in-effect lint error.
  function willPreview(amount: string, outcome: string): boolean {
    const n = parseInt(amount, 10);
    return !!outcome && Number.isFinite(n) && n >= 1;
  }

  function translateError(code: string): string {
    switch (code) {
      case "NOT_SIGNED_IN":
        return t("errNotSignedIn");
      case "RATE_LIMITED":
        return t("errRateLimited");
      case "INVALID_AMOUNT":
        return t("errInvalidAmount");
      case "NOT_ENOUGH_COINS":
        return t("notEnoughCoins");
      case "MARKET_CLOSED":
        return t("errMarketClosed");
      default:
        return t("errGeneric");
    }
  }

  React.useEffect(() => {
    if (!outcomeId || parsedCoins < 1) {
      setPreview(null);
      return;
    }
    let cancelled = false;
    const timer = setTimeout(async () => {
      const res = await previewBetCost(market.id, outcomeId, parsedCoins);
      if (cancelled) return;
      setPreviewing(false);
      if ("error" in res) setPreview(null);
      else setPreview(res);
    }, 250);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [market.id, outcomeId, parsedCoins]);

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setSuccess(null);
    if (parsedCoins < 1) {
      setError(t("enterPositive"));
      return;
    }
    if (parsedCoins > userBalance) {
      setError(t("notEnoughCoins"));
      return;
    }
    setPending(true);
    const res = await placeBetAction(market.id, outcomeId, parsedCoins);
    setPending(false);
    if (res.error) {
      setError(translateError(res.error));
      return;
    }
    setSuccess(
      t("boughtShares", {
        shares: res.sharesBought?.toFixed(2) ?? "",
        coins: res.coinsSpent ?? 0,
      }),
    );
    // Clear the amount instead of re-arming a fixed 100 that may now exceed the
    // (reduced) balance — the button stays disabled with a hint until the user
    // enters a new amount, by which point router.refresh() has the new balance.
    setCoins("");
    setPreview(null);
    setPreviewing(false);
    router.refresh();
  }

  const disabledReason =
    userBalance <= 0
      ? t("hintOutOfCoins")
      : parsedCoins < 1
        ? t("hintEnterAmount")
        : parsedCoins > userBalance
          ? t("hintExceedsBalance")
          : null;

  return (
    <form
      onSubmit={onSubmit}
      className="rounded-md border border-foreground/10 bg-background-elevated/30 p-5"
    >
      <h3 className="mb-4 font-sans text-[11px] font-medium uppercase tracking-widest text-foreground-muted">
        {t("placeBet")}
      </h3>

      <div className="flex flex-col gap-3 sm:flex-row">
        <select
          value={outcomeId}
          onChange={(e) => {
            setOutcomeId(e.target.value);
            setSuccess(null);
            setPreviewing(willPreview(coins, e.target.value));
          }}
          aria-label={t("chooseOutcome")}
          className={`${INPUT_CLASS} sm:min-w-[220px]`}
        >
          {market.outcomes.map((o) => (
            <option key={o.id} value={o.id}>
              {o.label} · {(o.current_price * 100).toFixed(1)}% ·{" "}
              {priceToDecimalOdds(o.current_price)}x
            </option>
          ))}
        </select>

        <input
          type="number"
          min={1}
          max={userBalance}
          step={1}
          value={coins}
          onChange={(e) => {
            setCoins(e.target.value);
            setSuccess(null);
            setPreviewing(willPreview(e.target.value, outcomeId));
          }}
          placeholder={t("coinsToSpend")}
          aria-label={t("coinsToSpend")}
          className={`${INPUT_CLASS} flex-1`}
        />

        <button
          type="submit"
          disabled={pending || parsedCoins < 1 || parsedCoins > userBalance}
          className="rounded-sm bg-primary px-4 py-2 font-display text-sm uppercase tracking-widest text-background-base hover:opacity-90 disabled:opacity-50"
        >
          {pending ? t("placing") : t("placeBet")}
        </button>
      </div>

      {/* Tell the user WHY the place button is disabled instead of relying on a
          silently greyed-out control they can't even focus. */}
      {!pending && disabledReason ? (
        <p className="mt-2 font-sans text-[11px] text-foreground-subtle">
          {disabledReason}
        </p>
      ) : null}

      {previewing ? (
        <p className="mt-3 font-mono text-[11px] tabular text-foreground-subtle">
          {t("calculating")}
        </p>
      ) : preview ? (
        <p className="mt-3 font-mono text-[11px] tabular text-foreground-subtle">
          {t("previewLine", {
            shares: preview.shares.toFixed(2),
            pct: (preview.newPrice * 100).toFixed(1),
            odds: priceToDecimalOdds(preview.newPrice),
            cost: formatNumber(preview.cost),
          })}
        </p>
      ) : null}
      {error ? (
        <p className="mt-3 font-sans text-sm text-streak-loss" role="alert">
          {error}
        </p>
      ) : null}
      {success ? (
        <p
          className="mt-3 font-sans text-sm text-streak-win"
          role="status"
          aria-live="polite"
        >
          {success}
        </p>
      ) : null}
      <p className="mt-3 font-sans text-[11px] text-foreground-subtle">
        {t("shareHint")}
      </p>
    </form>
  );
}
