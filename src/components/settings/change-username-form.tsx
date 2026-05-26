"use client";

import * as React from "react";
import { useRouter } from "next/navigation";

import { changeUsernameAction } from "@/app/settings/actions";

const INPUT_CLASS =
  "rounded-sm border border-foreground/15 bg-background-elevated/30 px-3 py-2 font-sans text-sm text-foreground focus:border-primary focus:outline-none disabled:opacity-50";

const COOLDOWN_DAYS = 30;
const MS_PER_DAY = 1000 * 60 * 60 * 24;

interface Props {
  currentUsername: string;
  usernameLastChangedAt: string | null;
}

function daysLeftUntilEligible(lastIso: string | null): number {
  if (!lastIso) return 0;
  const diffMs = Date.now() - new Date(lastIso).getTime();
  if (!Number.isFinite(diffMs)) return 0;
  return Math.max(0, Math.ceil(COOLDOWN_DAYS - diffMs / MS_PER_DAY));
}

export function ChangeUsernameForm({
  currentUsername,
  usernameLastChangedAt,
}: Props) {
  const router = useRouter();
  const [pending, setPending] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const [success, setSuccess] = React.useState<string | null>(null);

  const daysLeft = daysLeftUntilEligible(usernameLastChangedAt);
  const locked = daysLeft > 0;

  async function onSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setError(null);
    setSuccess(null);
    setPending(true);
    const res = await changeUsernameAction(new FormData(e.currentTarget));
    setPending(false);
    if (res.error) {
      setError(res.error);
      return;
    }
    setSuccess(
      `Username updated to @${res.newUsername}. Redirecting…`,
    );
    // Tiny pause so the success message is visible, then bounce to the
    // canonical profile URL.
    setTimeout(() => {
      router.push(`/profile/${res.newUsername}`);
      router.refresh();
    }, 900);
  }

  return (
    <form onSubmit={onSubmit} className="flex flex-col gap-4">
      <label className="flex flex-col gap-1.5">
        <span className="font-sans text-[11px] font-medium uppercase tracking-widest text-foreground-muted">
          Current username
        </span>
        <input
          type="text"
          value={`@${currentUsername}`}
          disabled
          className="rounded-sm border border-foreground/10 bg-background-elevated/20 px-3 py-2 font-sans text-sm text-foreground-muted"
        />
      </label>

      <label className="flex flex-col gap-1.5">
        <span className="font-sans text-[11px] font-medium uppercase tracking-widest text-foreground-muted">
          New username
        </span>
        <input
          type="text"
          name="newUsername"
          required
          minLength={3}
          maxLength={30}
          pattern="[a-zA-Z0-9_]+"
          autoComplete="username"
          disabled={locked || pending}
          title="3–30 chars: letters, digits, underscore"
          className={INPUT_CLASS}
        />
        <span className="font-sans text-[11px] text-foreground-subtle">
          3–30 chars: letters, digits, underscore. Limited to once every
          30 days.
          {locked
            ? ` Available in ${daysLeft} day${daysLeft === 1 ? "" : "s"}.`
            : ""}
        </span>
      </label>

      {error ? (
        <p className="font-sans text-sm text-streak-loss" role="alert">
          {error}
        </p>
      ) : null}
      {success ? (
        <p className="font-sans text-sm text-streak-win">{success}</p>
      ) : null}

      <button
        type="submit"
        disabled={pending || locked}
        className="self-start rounded-sm bg-primary px-4 py-2 font-sans font-bold text-sm uppercase tracking-widest text-background-base hover:opacity-90 disabled:opacity-50"
      >
        {pending ? "Saving…" : "Change username"}
      </button>
    </form>
  );
}
