"use client";

import * as React from "react";
import NextLink from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { useTranslations } from "next-intl";

import { signInAction } from "@/app/[locale]/signin/actions";
import { GoogleAuthButton } from "@/components/auth/GoogleAuthButton";
import { PasswordInput } from "@/components/auth/PasswordInput";
import { Link } from "@/i18n/navigation";
import { safeNext } from "@/lib/safe-redirect";

const INPUT_CLASS =
  "rounded-sm border border-foreground/15 bg-background-elevated/30 px-3 py-2 font-sans text-sm text-foreground focus:border-primary focus:outline-none";

export function SignInForm() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const next = safeNext(searchParams.get("next"));
  const t = useTranslations("auth");

  // The callback route hands us a stable code (never raw Supabase text); map it
  // to localized copy. Unknown/legacy values fall back to a generic message so
  // we never render low-level English reflected from the URL.
  const errorParam = searchParams.get("error");
  const initialError =
    errorParam === "link_expired"
      ? t("errLinkExpired")
      : errorParam === "auth_failed"
        ? t("errAuthCallback")
        : errorParam
          ? t("errGeneric")
          : null;

  const [pending, setPending] = React.useState(false);
  const [error, setError] = React.useState<string | null>(initialError);

  async function onSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setError(null);
    setPending(true);
    const formData = new FormData(e.currentTarget);
    const res = await signInAction(formData);
    setPending(false);
    if (res?.error) {
      setError(res.error);
    } else {
      router.push(next);
      router.refresh();
    }
  }

  return (
    <>
      <h1 className="font-display text-3xl uppercase tracking-tight text-foreground sm:text-4xl">
        {t("signInTitle")}
      </h1>
      <p className="mt-2 font-sans text-sm text-foreground-muted">
        {t("signInWelcome")}
      </p>

      <div className="mt-8">
        <GoogleAuthButton next={next} />
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
            className={INPUT_CLASS}
          />
        </label>

        <label className="flex flex-col gap-1.5">
          <div className="flex items-baseline justify-between gap-3">
            <span className="font-sans text-[11px] font-medium uppercase tracking-widest text-foreground-muted">
              {t("password")}
            </span>
            {/* /auth/* lives OUTSIDE the [locale] tree (middleware excludes
                it), so the locale-aware Link would wrongly prefix it to
                /ru/auth/... → 404. Use the plain next/link Link so the path
                stays bare on every locale. */}
            <NextLink
              href="/auth/forgot-password"
              className="font-sans text-[11px] text-primary hover:underline"
            >
              {t("forgotPassword")}
            </NextLink>
          </div>
          <PasswordInput
            name="password"
            required
            autoComplete="current-password"
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
          {pending ? t("signingIn") : t("signIn")}
        </button>

        <p className="text-center font-sans text-sm text-foreground-muted">
          {t("noAccountYet")}{" "}
          <Link href="/signup" className="text-primary hover:underline">
            {t("signUp")}
          </Link>
        </p>
      </form>
    </>
  );
}
