"use client";

import * as React from "react";
import { useTranslations } from "next-intl";

import { changePasswordAction } from "@/app/[locale]/settings/actions";
import { PasswordInput } from "@/components/auth/PasswordInput";

export function ChangePasswordForm() {
  const t = useTranslations("settings");
  const [pending, setPending] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const [saved, setSaved] = React.useState(false);

  async function onSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setError(null);
    setSaved(false);

    const formData = new FormData(e.currentTarget);
    const currentPassword = String(formData.get("currentPassword") ?? "");
    const newPassword = String(formData.get("newPassword") ?? "");
    const confirm = String(formData.get("confirm") ?? "");
    if (!currentPassword) {
      setError(t("currentPasswordRequired"));
      return;
    }
    if (newPassword.length < 8) {
      setError(t("passwordTooShort"));
      return;
    }
    if (newPassword !== confirm) {
      setError(t("passwordsDoNotMatch"));
      return;
    }

    setPending(true);
    const res = await changePasswordAction(formData);
    setPending(false);
    if (res?.error) {
      setError(res.error);
    } else {
      setSaved(true);
      e.currentTarget.reset();
    }
  }

  return (
    <form onSubmit={onSubmit} className="flex flex-col gap-4">
      <label className="flex flex-col gap-1.5">
        <span className="font-sans text-[11px] font-medium uppercase tracking-widest text-foreground-muted">
          {t("currentPassword")}
        </span>
        <PasswordInput
          name="currentPassword"
          required
          autoComplete="current-password"
        />
      </label>
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
        <span className="font-sans text-[11px] text-foreground-subtle">
          {t("passwordAtLeast8")}
        </span>
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
      {saved ? (
        <p className="font-sans text-sm text-streak-win">
          {t("passwordUpdated")}
        </p>
      ) : null}
      <button
        type="submit"
        disabled={pending}
        className="self-start rounded-sm bg-primary px-4 py-2 font-display text-sm uppercase tracking-widest text-background-base hover:opacity-90 disabled:opacity-50"
      >
        {pending ? t("updating") : t("updatePassword")}
      </button>
    </form>
  );
}
