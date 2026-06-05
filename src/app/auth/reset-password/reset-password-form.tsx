"use client";

import * as React from "react";
import { useTranslations } from "next-intl";

import { resetPasswordAction } from "@/app/auth/reset-password/actions";
import { PasswordInput } from "@/components/auth/PasswordInput";
import { Link } from "@/i18n/navigation";

export function ResetPasswordForm({ invalid = false }: { invalid?: boolean }) {
  const t = useTranslations("auth");
  const [pending, setPending] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const [success, setSuccess] = React.useState(false);

  async function onSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setError(null);

    const formData = new FormData(e.currentTarget);
    const newPassword = String(formData.get("newPassword") ?? "");
    const confirm = String(formData.get("confirm") ?? "");
    if (newPassword.length < 8) {
      setError(t("passwordTooShort"));
      return;
    }
    if (newPassword !== confirm) {
      setError(t("passwordsDoNotMatch"));
      return;
    }

    setPending(true);
    const res = await resetPasswordAction(formData);
    setPending(false);
    if (res?.error) setError(res.error);
    else setSuccess(true);
  }

  if (invalid) {
    return (
      <div className="py-8 text-center">
        <h1 className="font-display text-3xl uppercase tracking-tight text-foreground">
          {t("resetInvalid")}
        </h1>
        <p className="mt-6 font-sans text-sm text-foreground-muted">
          <Link
            href="/auth/forgot-password"
            className="text-primary hover:underline"
          >
            {t("requestNewLink")}
          </Link>
        </p>
      </div>
    );
  }

  if (success) {
    return (
      <div className="py-8 text-center">
        <h1 className="font-display text-3xl uppercase tracking-tight text-foreground">
          {t("passwordUpdated")}
        </h1>
        <p className="mt-4 font-sans text-sm text-foreground-muted">
          {t("passwordUpdatedLead")}
        </p>
        <p className="mt-6 font-sans text-sm text-foreground-muted">
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
        {t("chooseNewPassword")}
      </h1>
      <p className="mt-2 font-sans text-sm text-foreground-muted">
        {t("chooseNewLead")}
      </p>

      <form onSubmit={onSubmit} className="mt-8 flex flex-col gap-4">
        <label className="flex flex-col gap-1.5">
          <span className="font-sans text-[11px] font-medium uppercase tracking-widest text-foreground-muted">
            {t("newPassword")}
          </span>
          <PasswordInput
            name="newPassword"
            required
            minLength={8}
            autoComplete="new-password"
          />
        </label>
        <label className="flex flex-col gap-1.5">
          <span className="font-sans text-[11px] font-medium uppercase tracking-widest text-foreground-muted">
            {t("confirmNewPassword")}
          </span>
          <PasswordInput
            name="confirm"
            required
            minLength={8}
            autoComplete="new-password"
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
          {pending ? t("updating") : t("updatePassword")}
        </button>
      </form>
    </>
  );
}
