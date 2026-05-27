"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";

import { claimDailyBonusAction } from "@/app/[locale]/me/actions";
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
  const t = useTranslations("profile");
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
    const awardedAmount = res.awarded?.toLocaleString() ?? amount.toLocaleString();
    let msg = t("claimedToast", { amount: awardedAmount });
    if (res.newlyUnlocked && res.newlyUnlocked.length > 0) {
      msg += ` ${t("unlockedToast", { list: res.newlyUnlocked.join(", ") })}`;
    }
    setFeedback(msg);
    setLastIso(new Date().toISOString());
    router.refresh();
  }

  if (!eligible) {
    const hoursLeft = Math.ceil(hoursUntilEligible(lastIso));
    return (
      <div className="rounded-md border border-foreground/10 bg-background-elevated/30 px-3 py-2 font-sans text-sm text-foreground-subtle">
        {t("dailyAvailableIn", { hours: hoursLeft })}
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
        {pending
          ? t("claiming")
          : t("claimDaily", { amount: amount.toLocaleString() })}
      </button>
      {feedback ? (
        <p className="mt-2 font-sans text-sm text-streak-win">{feedback}</p>
      ) : null}
    </div>
  );
}
