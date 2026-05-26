"use client";

import * as React from "react";
import Link from "next/link";

import { signUpAction } from "@/app/signup/actions";
import { PasswordInput } from "@/components/auth/PasswordInput";

export function SignUpForm() {
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
        <h1 className="font-sans font-bold text-3xl uppercase tracking-tight text-foreground">
          Check your email
        </h1>
        <p className="mt-4 font-sans text-sm text-foreground-muted">
          We&apos;ve sent a confirmation link to the address you provided. Click
          it to finish creating your account.
        </p>
        <p className="mt-6 font-sans text-sm text-foreground-muted">
          Already confirmed?{" "}
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
        Sign up
      </h1>
      <p className="mt-2 font-sans text-sm text-foreground-muted">
        Create your Vertex MMA account.
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
            className="rounded-sm border border-foreground/15 bg-background-elevated/30 px-3 py-2 font-sans text-sm text-foreground focus:border-primary focus:outline-none"
          />
        </label>

        <label className="flex flex-col gap-1.5">
          <span className="font-sans text-[11px] font-medium uppercase tracking-widest text-foreground-muted">
            Username
          </span>
          <input
            type="text"
            name="username"
            required
            minLength={3}
            maxLength={30}
            pattern="[a-zA-Z0-9_]+"
            autoComplete="username"
            title="3–30 chars: letters, digits, underscore"
            className="rounded-sm border border-foreground/15 bg-background-elevated/30 px-3 py-2 font-sans text-sm text-foreground focus:border-primary focus:outline-none"
          />
          <span className="font-sans text-[11px] text-foreground-subtle">
            3–30 chars, letters / numbers / underscore.
          </span>
        </label>

        <label className="flex flex-col gap-1.5">
          <span className="font-sans text-[11px] font-medium uppercase tracking-widest text-foreground-muted">
            Password
          </span>
          <PasswordInput
            name="password"
            required
            minLength={8}
            autoComplete="new-password"
          />
          <span className="font-sans text-[11px] text-foreground-subtle">
            At least 8 characters.
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
          className="mt-2 rounded-sm bg-primary px-4 py-2.5 font-sans font-bold text-sm uppercase tracking-widest text-background-base hover:opacity-90 disabled:opacity-50"
        >
          {pending ? "Creating account..." : "Sign up"}
        </button>

        <p className="text-center font-sans text-sm text-foreground-muted">
          Already have an account?{" "}
          <Link href="/signin" className="text-primary hover:underline">
            Sign in
          </Link>
        </p>
      </form>
    </>
  );
}
