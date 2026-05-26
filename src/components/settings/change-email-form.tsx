"use client";

import * as React from "react";

import { changeEmailAction } from "@/app/settings/actions";

const INPUT_CLASS =
  "rounded-sm border border-foreground/15 bg-background-elevated/30 px-3 py-2 font-sans text-sm text-foreground focus:border-primary focus:outline-none";

interface Props {
  currentEmail: string;
}

export function ChangeEmailForm({ currentEmail }: Props) {
  const [pending, setPending] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const [sent, setSent] = React.useState(false);

  async function onSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setError(null);
    setSent(false);
    setPending(true);
    const res = await changeEmailAction(new FormData(e.currentTarget));
    setPending(false);
    if (res?.error) setError(res.error);
    else setSent(true);
  }

  return (
    <form onSubmit={onSubmit} className="flex flex-col gap-4">
      <label className="flex flex-col gap-1.5">
        <span className="font-sans text-[11px] font-medium uppercase tracking-widest text-foreground-muted">
          Current email
        </span>
        <input
          type="email"
          value={currentEmail}
          disabled
          className="rounded-sm border border-foreground/10 bg-background-elevated/20 px-3 py-2 font-sans text-sm text-foreground-muted"
        />
      </label>
      <label className="flex flex-col gap-1.5">
        <span className="font-sans text-[11px] font-medium uppercase tracking-widest text-foreground-muted">
          New email
        </span>
        <input
          type="email"
          name="newEmail"
          required
          autoComplete="email"
          className={INPUT_CLASS}
        />
        <span className="font-sans text-[11px] text-foreground-subtle">
          We&apos;ll send confirmation links to both addresses. Both must be
          clicked before the change takes effect.
        </span>
      </label>
      {error ? (
        <p className="font-sans text-sm text-streak-loss" role="alert">
          {error}
        </p>
      ) : null}
      {sent ? (
        <p className="font-sans text-sm text-streak-win">
          Confirmation sent. Check both your current and new inboxes.
        </p>
      ) : null}
      <button
        type="submit"
        disabled={pending}
        className="self-start rounded-sm bg-primary px-4 py-2 font-display text-sm uppercase tracking-widest text-background-base hover:opacity-90 disabled:opacity-50"
      >
        {pending ? "Sending…" : "Change email"}
      </button>
    </form>
  );
}
