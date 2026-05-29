"use client";

import * as React from "react";
import { useTranslations } from "next-intl";

import { signUpAction } from "@/app/[locale]/signup/actions";
import { GoogleAuthButton } from "@/components/auth/GoogleAuthButton";
import { PasswordInput } from "@/components/auth/PasswordInput";
import { Link } from "@/i18n/navigation";

export function SignUpForm() {
  const t = useTranslations("auth");
  const [pending, setPending] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const [success, setSuccess] = React.useState(false);

  async function onSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setError(null);
    setPending(true);
    const formData = new FormData(e.currentTarget);
    const res = await signUpAction(formData);
    setPending(false);
    if (res?.error) {
      setError(res.error);
    } else {
      setSuccess(true);
    }
  }

  if (success) {
    return (
      <div className="py-8 text-center">
        <h1 className="font-display text-3xl uppercase tracking-tight text-foreground">
          {t("checkEmail")}
        </h1>
        <p className="mt-4 font-sans text-sm text-foreground-muted">
          {t("checkEmailLead")}
        </p>
        <p className="mt-6 font-sans text-sm text-foreground-muted">
          {t("alreadyConfirmed")}{" "}
          <Link href="/signin" className="text-primary hover:underline">
            {t("signIn")}
          </Link>
        </p>
      </div>
    );
  }

  return (
    <>
      <h1 className="font-display text-3xl uppercase tracking-tight text-foreground sm:text-4xl">
        {t("signUp")}
      </h1>
      <p className="mt-2 font-sans text-sm text-foreground-muted">
        {t("signUpLeadShort")}
      </p>

      <div className="mt-8">
        <GoogleAuthButton next="/" />
      </div>
      <div className="my-6 flex items-center gap-3">
        <span className="h-px flex-1 bg-foreground/10" />
        <span className="font-sans text-[11px] uppercase tracking-widest text-foreground-subtle">
          {t("orDivider")}
        </span>
        <span className="h-px flex-1 bg-foreground/10" />
      </div>

      <form onSubmit={onSubmit} className="flex flex-col gap-4">
        <label className="flex flex-col gap-1.5">
          <span className="font-sans text-[11px] font-medium uppercase tracking-widest text-foreground-muted">
            {t("email")}
          </span>
          <input
            type="email"
            name="email"
            required
            autoComplete="email"
            className="rounded-sm border border-foreground/15 bg-background-elevated/30 px-3 py-2 font-sans text-sm text-foreground focus:border-primary focus:outline-none"
          />
        </label>

        <label className="flex flex-col gap-1.5">
          <span className="font-sans text-[11px] font-medium uppercase tracking-widest text-foreground-muted">
            {t("username")}
          </span>
          <input
            type="text"
            name="username"
            required
            minLength={3}
            maxLength={30}
            pattern="[a-zA-Z0-9_]+"
            autoComplete="username"
            title={t("usernameHintLong")}
            className="rounded-sm border border-foreground/15 bg-background-elevated/30 px-3 py-2 font-sans text-sm text-foreground focus:border-primary focus:outline-none"
          />
          <span className="font-sans text-[11px] text-foreground-subtle">
            {t("usernameHintLong")}
          </span>
        </label>

        <label className="flex flex-col gap-1.5">
          <span className="font-sans text-[11px] font-medium uppercase tracking-widest text-foreground-muted">
            {t("password")}
          </span>
          <PasswordInput
            name="password"
            required
            minLength={8}
            autoComplete="new-password"
          />
          <span className="font-sans text-[11px] text-foreground-subtle">
            {t("passwordHint")}
          </span>
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
          {pending ? t("creatingAccount") : t("signUp")}
        </button>

        <p className="text-center font-sans text-sm text-foreground-muted">
          {t("haveAccount")}{" "}
          <Link href="/signin" className="text-primary hover:underline">
            {t("signIn")}
          </Link>
        </p>
      </form>
    </>
  );
}
