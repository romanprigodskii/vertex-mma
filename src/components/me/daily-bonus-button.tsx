"use client";

import * as React from "react";
import { useRouter } from "next/navigation";

import { claimDailyBonusAction } from "@/app/me/actions";
import { dailyBonusAmount } from "@/lib/tier";

const COOLDOWN_HOURS = 20;

interface Props {
  lastDailyBonusAt: string | null;
  tier: string;
}

function hoursUntilEligible(lastIso: string | null): number {
  if (!lastIso) return 0;
  const ms = Date.now() - new Date(lastIso).getTime();
  return Math.max(0, COOLDOWN_HOURS - ms / (1000 * 60 * 60));
}

export function DailyBonusButton({ lastDailyBonusAt, tier }: Props) {
  const router = useRouter();
  const [pending, setPending] = React.useState(false);
  const [feedback, setFeedback] = React.useState<string | null>(null);
  // Track the "applied at" value locally so a fresh claim immediately
  // disables the button without needing a full server refresh.
  const [lastIso, setLastIso] = React.useState<string | null>(lastDailyBonusAt);

  const amount = dailyBonusAmount(tier);
  const eligible = hoursUntilEligible(lastIso) <= 0;

  async function onClick() {
    setPending(true);
    setFeedback(null);
    const res = await claimDailyBonusAction();
    setPending(false);
    if (res.error) {
      setFeedback(res.error);
      return;
    }
    let msg = `+${res.awarded?.toLocaleString() ?? amount} coins claimed!`;
    if (res.newlyUnlocked && res.newlyUnlocked.length > 0) {
      msg += ` Unlocked: ${res.newlyUnlocked.join(", ")}`;
    }
    setFeedback(msg);
    setLastIso(new Date().toISOString());
    router.refresh();
  }

  if (!eligible) {
    const hoursLeft = Math.ceil(hoursUntilEligible(lastIso));
    return (
      <div className="rounded-md border border-foreground/10 bg-background-elevated/30 px-3 py-2 font-sans text-sm text-foreground-subtle">
        Daily bonus available in {hoursLeft}h
      </div>
    );
  }

  return (
    <div>
      <button
        type="button"
        onClick={onClick}
        disabled={pending}
        className="rounded-sm bg-primary px-4 py-2 font-display text-sm uppercase tracking-widest text-background-base hover:opacity-90 disabled:opacity-50"
      >
        {pending ? "Claiming…" : `Claim daily +${amount.toLocaleString()}`}
      </button>
      {feedback ? (
        <p className="mt-2 font-sans text-sm text-streak-win">{feedback}</p>
      ) : null}
    </div>
  );
}
