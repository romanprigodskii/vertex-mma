"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";

import { claimDailyBonusAction } from "@/app/[locale]/me/actions";
import { useMounted } from "@/hooks/use-mounted";
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
  const [isError, setIsError] = React.useState(false);
  // Track the "applied at" value locally so a fresh claim immediately
  // disables the button without needing a full server refresh.
  const [lastIso, setLastIso] = React.useState<string | null>(lastDailyBonusAt);

  const mounted = useMounted();
  const amount = dailyBonusAmount(tier);
  // hoursUntilEligible reads Date.now(), so computing eligibility during the
  // initial render can mismatch at an hour boundary AND flip the whole rendered
  // subtree (cooldown box ⇄ claim button). Gate it behind `mounted` so SSR and
  // the first client render agree; a never-claimed user (lastIso === null) is
  // eligible deterministically, so show that immediately.
  const eligible =
    lastIso === null || (mounted && hoursUntilEligible(lastIso) <= 0);

  async function onClick() {
    setPending(true);
    setFeedback(null);
    setIsError(false);
    const res = await claimDailyBonusAction();
    setPending(false);
    if (res.error) {
      setIsError(true);
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
    // Before mount, render a deterministic placeholder (the full cooldown) so
    // SSR and the first client render match; the real remaining hours fill in
    // after mount.
    const hoursLeft = mounted
      ? Math.ceil(hoursUntilEligible(lastIso))
      : COOLDOWN_HOURS;
    return (
      <div
        className="rounded-md border border-foreground/10 bg-background-elevated/30 px-3 py-2 font-sans text-sm text-foreground-subtle"
        suppressHydrationWarning
      >
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
        <p
          role={isError ? "alert" : undefined}
          aria-live={isError ? undefined : "polite"}
          className={`mt-2 font-sans text-sm ${isError ? "text-streak-loss" : "text-streak-win"}`}
        >
          {feedback}
        </p>
      ) : null}
    </div>
  );
}
