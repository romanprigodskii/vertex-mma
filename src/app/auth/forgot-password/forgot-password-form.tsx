"use client";

import * as React from "react";
import { useTranslations } from "next-intl";

import { forgotPasswordAction } from "@/app/auth/forgot-password/actions";
import { Link } from "@/i18n/navigation";

const INPUT_CLASS =
  "rounded-sm border border-foreground/15 bg-background-elevated/30 px-3 py-2 font-sans text-sm text-foreground focus:border-primary focus:outline-none";

export function ForgotPasswordForm() {
  const t = useTranslations("auth");
  const [pending, setPending] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const [success, setSuccess] = React.useState(false);

  async function onSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setError(null);
    setPending(true);
    const res = await forgotPasswordAction(new FormData(e.currentTarget));
    setPending(false);
    if (res?.error) setError(res.error);
    else setSuccess(true);
  }

  if (success) {
    return (
      <div className="py-8 text-center">
        <h1 className="font-display text-3xl uppercase tracking-tight text-foreground">
          {t("checkEmail")}
        </h1>
        <p className="mt-4 font-sans text-sm text-foreground-muted">
          {t("resetSent")}
        </p>
        <p className="mt-6 font-sans text-sm text-foreground-muted">
          <Link href="/signin" className="text-primary hover:underline">
            {t("backToSignIn")}
          </Link>
        </p>
      </div>
    );
  }

  return (
    <>
      <h1 className="font-display text-3xl uppercase tracking-tight text-foreground sm:text-4xl">
        {t("forgotTitle")}
      </h1>
      <p className="mt-2 font-sans text-sm text-foreground-muted">
        {t("forgotLead")}
      </p>

      <form onSubmit={onSubmit} className="mt-8 flex flex-col gap-4">
        <label className="flex flex-col gap-1.5">
          <span className="font-sans text-[11px] font-medium uppercase tracking-widest text-foreground-muted">
            {t("email")}
          </span>
          <input
            type="email"
            name="email"
            required
            autoComplete="email"
            className={INPUT_CLASS}
          />
        </label>

        {error ? (
          <p className="font-sans text-sm text-streak-loss" role="alert">
            {error}
          </p>
        ) : null}

        <button
          type="submit"
          disabled={pending}
          className="mt-2 rounded-sm bg-primary px-4 py-2.5 font-display text-sm uppercase tracking-widest text-background-base hover:opacity-90 disabled:opacity-50"
        >
          {pending ? t("sending") : t("sendResetLink")}
        </button>

        <p className="text-center font-sans text-sm text-foreground-muted">
          <Link href="/signin" className="text-primary hover:underline">
            {t("backToSignIn")}
          </Link>
        </p>
      </form>
    </>
  );
}
