"use client";

import * as React from "react";
import { useTranslations } from "next-intl";

import { changeEmailAction } from "@/app/[locale]/settings/actions";
import { PasswordInput } from "@/components/auth/PasswordInput";

const INPUT_CLASS =
  "rounded-sm border border-foreground/15 bg-background-elevated/30 px-3 py-2 font-sans text-sm text-foreground focus:border-primary focus:outline-none";

interface Props {
  currentEmail: string;
  hasPassword: boolean;
}

export function ChangeEmailForm({ currentEmail, hasPassword }: Props) {
  const t = useTranslations("settings");
  const [pending, setPending] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const [sent, setSent] = React.useState(false);

  async function onSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const form = e.currentTarget;
    setError(null);
    setSent(false);
    setPending(true);
    const res = await changeEmailAction(new FormData(form));
    setPending(false);
    if (res?.error) {
      setError(res.error);
    } else {
      setSent(true);
      // Clear the typed value so the success state reads as a clean
      // confirmation, not an apparently-already-applied change.
      form.reset();
    }
  }

  return (
    <form onSubmit={onSubmit} className="flex flex-col gap-4">
      <label className="flex flex-col gap-1.5">
        <span className="font-sans text-[11px] font-medium uppercase tracking-widest text-foreground-muted">
          {t("currentEmail")}
        </span>
        <input
          type="email"
          value={currentEmail}
          readOnly
          title={currentEmail}
          className="rounded-sm border border-foreground/10 bg-background-elevated/20 px-3 py-2 font-sans text-sm text-foreground-muted"
        />
      </label>
      {hasPassword ? (
        <label className="flex flex-col gap-1.5">
          <span className="font-sans text-[11px] font-medium uppercase tracking-widest text-foreground-muted">
            {t("currentPassword")}
          </span>
          <PasswordInput
            name="currentPassword"
            required
            autoComplete="current-password"
          />
          <span className="font-sans text-[11px] text-foreground-subtle">
            {t("confirmWithPassword")}
          </span>
        </label>
      ) : null}
      <label className="flex flex-col gap-1.5">
        <span className="font-sans text-[11px] font-medium uppercase tracking-widest text-foreground-muted">
          {t("newEmail")}
        </span>
        <input
          type="email"
          name="newEmail"
          required
          autoComplete="email"
          className={INPUT_CLASS}
        />
        <span className="font-sans text-[11px] text-foreground-subtle">
          {t("emailDualConfirmHint")}
        </span>
      </label>
      {error ? (
        <p className="font-sans text-sm text-streak-loss" role="alert">
          {error}
        </p>
      ) : null}
      {sent ? (
        <p className="font-sans text-sm text-streak-win" role="status">
          {t("emailConfirmationSent")}
        </p>
      ) : null}
      <button
        type="submit"
        disabled={pending}
        className="self-start rounded-sm bg-primary px-4 py-2 font-display text-sm uppercase tracking-widest text-background-base hover:opacity-90 disabled:opacity-50"
      >
        {pending ? t("sending") : t("changeEmail")}
      </button>
    </form>
  );
}
