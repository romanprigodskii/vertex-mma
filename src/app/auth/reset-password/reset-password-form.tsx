"use client";

import * as React from "react";
import Link from "next/link";

import { resetPasswordAction } from "@/app/auth/reset-password/actions";
import { PasswordInput } from "@/components/auth/PasswordInput";

export function ResetPasswordForm() {
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
      setError("Password must be at least 8 characters.");
      return;
    }
    if (newPassword !== confirm) {
      setError("Passwords do not match.");
      return;
    }

    setPending(true);
    const res = await resetPasswordAction(formData);
    setPending(false);
    if (res?.error) setError(res.error);
    else setSuccess(true);
  }

  if (success) {
    return (
      <div className="py-8 text-center">
        <h1 className="font-sans font-bold text-3xl uppercase tracking-tight text-foreground">
          Password updated
        </h1>
        <p className="mt-4 font-sans text-sm text-foreground-muted">
          You can now sign in with your new password.
        </p>
        <p className="mt-6 font-sans text-sm text-foreground-muted">
          <Link href="/signin" className="text-primary hover:underline">
            Sign in
          </Link>
        </p>
      </div>
    );
  }

  return (
    <>
      <h1 className="font-sans font-bold text-3xl uppercase tracking-tight text-foreground sm:text-4xl">
        Choose a new password
      </h1>
      <p className="mt-2 font-sans text-sm text-foreground-muted">
        Pick something at least 8 characters long.
      </p>

      <form onSubmit={onSubmit} className="mt-8 flex flex-col gap-4">
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

        <button
          type="submit"
          disabled={pending}
          className="mt-2 rounded-sm bg-primary px-4 py-2.5 font-sans font-bold text-sm uppercase tracking-widest text-background-base hover:opacity-90 disabled:opacity-50"
        >
          {pending ? "Updating…" : "Update password"}
        </button>
      </form>
    </>
  );
}
