"use client";

import * as React from "react";
import { useRouter } from "next/navigation";

import { placeBetAction, previewBetCost } from "@/app/markets/actions";
import { priceToDecimalOdds } from "@/lib/lmsr";
import type { MarketDetail } from "@/lib/markets";

const INPUT_CLASS =
  "rounded-sm border border-foreground/15 bg-background-elevated/30 px-3 py-2 font-sans text-sm text-foreground focus:border-primary focus:outline-none";

interface Props {
  market: MarketDetail;
  userBalance: number;
}

type Preview = { shares: number; cost: number; newPrice: number };

export function BetForm({ market, userBalance }: Props) {
  const router = useRouter();
  const [outcomeId, setOutcomeId] = React.useState(market.outcomes[0]?.id ?? "");
  const [coins, setCoins] = React.useState<string>("100");
  const [preview, setPreview] = React.useState<Preview | null>(null);
  const [pending, setPending] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const [success, setSuccess] = React.useState<string | null>(null);

  const parsedCoins = (() => {
    const n = parseInt(coins, 10);
    return Number.isFinite(n) && n > 0 ? n : 0;
  })();

  React.useEffect(() => {
    if (!outcomeId || parsedCoins < 1) {
      setPreview(null);
      return;
    }
    let cancelled = false;
    const t = setTimeout(async () => {
      const res = await previewBetCost(market.id, outcomeId, parsedCoins);
      if (cancelled) return;
      if ("error" in res) setPreview(null);
      else setPreview(res);
    }, 250);
    return () => {
      cancelled = true;
      clearTimeout(t);
    };
  }, [market.id, outcomeId, parsedCoins]);

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setSuccess(null);
    if (parsedCoins < 1) {
      setError("Enter a positive amount.");
      return;
    }
    if (parsedCoins > userBalance) {
      setError("Not enough coins.");
      return;
    }
    setPending(true);
    const res = await placeBetAction(market.id, outcomeId, parsedCoins);
    setPending(false);
    if (res.error) {
      setError(res.error);
      return;
    }
    setSuccess(
      `Bought ${res.sharesBought?.toFixed(2)} shares for ${res.coinsSpent} coins.`,
    );
    setCoins("100");
    setPreview(null);
    router.refresh();
  }

  return (
    <form
      onSubmit={onSubmit}
      className="rounded-md border border-foreground/10 bg-background-elevated/30 p-5"
    >
      <h3 className="mb-4 font-sans text-[11px] font-medium uppercase tracking-widest text-foreground-muted">
        Place bet
      </h3>

      <div className="flex flex-col gap-3 sm:flex-row">
        <select
          value={outcomeId}
          onChange={(e) => setOutcomeId(e.target.value)}
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
          onChange={(e) => setCoins(e.target.value)}
          placeholder="Coins to spend"
          className={`${INPUT_CLASS} flex-1`}
        />

        <button
          type="submit"
          disabled={pending || parsedCoins < 1 || parsedCoins > userBalance}
          className="rounded-sm bg-primary px-4 py-2 font-sans font-bold text-sm uppercase tracking-widest text-background-base hover:opacity-90 disabled:opacity-50"
        >
          {pending ? "Placing…" : "Place bet"}
        </button>
      </div>

      {preview ? (
        <p className="mt-3 font-mono text-[11px] tabular text-foreground-subtle">
          → {preview.shares.toFixed(2)} shares · price moves to{" "}
          {(preview.newPrice * 100).toFixed(1)}% ({priceToDecimalOdds(preview.newPrice)}x) · actual cost {preview.cost}c
        </p>
      ) : null}
      {error ? (
        <p className="mt-3 font-sans text-sm text-streak-loss" role="alert">
          {error}
        </p>
      ) : null}
      {success ? (
        <p className="mt-3 font-sans text-sm text-streak-win">{success}</p>
      ) : null}
      <p className="mt-3 font-sans text-[11px] text-foreground-subtle">
        Each share pays 1 coin if your outcome wins. Buying the opposite
        outcome later is the only way to hedge in Wave 38 — explicit sell
        flow lands in Wave 39.
      </p>
    </form>
  );
}
