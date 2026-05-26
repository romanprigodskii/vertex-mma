"use client";

import * as React from "react";

import { changePasswordAction } from "@/app/settings/actions";
import { PasswordInput } from "@/components/auth/PasswordInput";

export function ChangePasswordForm() {
  const [pending, setPending] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const [saved, setSaved] = React.useState(false);

  async function onSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setError(null);
    setSaved(false);

    const formData = new FormData(e.currentTarget);
    const newPassword = String(formData.get("newPassword") ?? "");
    const confirm = String(formData.get("confirm") ?? "");
    if (newPassword.length < 8) {
      setError("Password must be at least 8 characters.");
      return;
    }
    if (newPassword !== confirm) {
      setError("Passwords do not match.");
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
          New password
        </span>
        <PasswordInput
          name="newPassword"
          required
          minLength={8}
          autoComplete="new-password"
        />
        <span className="font-sans text-[11px] text-foreground-subtle">
          At least 8 characters.
        </span>
      </label>
      <label className="flex flex-col gap-1.5">
        <span className="font-sans text-[11px] font-medium uppercase tracking-widest text-foreground-muted">
          Confirm new password
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
          Password updated.
        </p>
      ) : null}
      <button
        type="submit"
        disabled={pending}
        className="self-start rounded-sm bg-primary px-4 py-2 font-display text-sm uppercase tracking-widest text-background-base hover:opacity-90 disabled:opacity-50"
      >
        {pending ? "Updating…" : "Update password"}
      </button>
    </form>
  );
}
