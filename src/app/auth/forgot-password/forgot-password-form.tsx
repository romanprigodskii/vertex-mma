"use client";

import * as React from "react";
import Link from "next/link";

import { forgotPasswordAction } from "@/app/auth/forgot-password/actions";

const INPUT_CLASS =
  "rounded-sm border border-foreground/15 bg-background-elevated/30 px-3 py-2 font-sans text-sm text-foreground focus:border-primary focus:outline-none";

export function ForgotPasswordForm() {
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
          Check your email
        </h1>
        <p className="mt-4 font-sans text-sm text-foreground-muted">
          If that address has an account, we&apos;ve sent a reset link. Open it
          to choose a new password.
        </p>
        <p className="mt-6 font-sans text-sm text-foreground-muted">
          <Link href="/signin" className="text-primary hover:underline">
            Back to sign in
          </Link>
        </p>
      </div>
    );
  }

  return (
    <>
      <h1 className="font-display text-3xl uppercase tracking-tight text-foreground sm:text-4xl">
        Reset password
      </h1>
      <p className="mt-2 font-sans text-sm text-foreground-muted">
        Enter the email tied to your account and we&apos;ll send a reset link.
      </p>

      <form onSubmit={onSubmit} className="mt-8 flex flex-col gap-4">
        <label className="flex flex-col gap-1.5">
          <span className="font-sans text-[11px] font-medium uppercase tracking-widest text-foreground-muted">
            Email
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
          {pending ? "Sending…" : "Send reset link"}
        </button>

        <p className="text-center font-sans text-sm text-foreground-muted">
          Remembered it?{" "}
          <Link href="/signin" className="text-primary hover:underline">
            Sign in
          </Link>
        </p>
      </form>
    </>
  );
}
