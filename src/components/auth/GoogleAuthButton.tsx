"use client";

import * as React from "react";
import { useTranslations } from "next-intl";

import { mapAuthError } from "@/lib/auth-errors";
import { createClient } from "@/lib/supabase/client";

function GoogleG() {
  return (
    <svg className="h-4 w-4" viewBox="0 0 48 48" aria-hidden>
      <path
        fill="#FFC107"
        d="M43.611 20.083H42V20H24v8h11.303c-1.649 4.657-6.08 8-11.303 8-6.627 0-12-5.373-12-12s5.373-12 12-12c3.059 0 5.842 1.154 7.961 3.039l5.657-5.657C34.046 6.053 29.268 4 24 4 12.955 4 4 12.955 4 24s8.955 20 20 20 20-8.955 20-20c0-1.341-.138-2.65-.389-3.917z"
      />
      <path
        fill="#FF3D00"
        d="M6.306 14.691l6.571 4.819C14.655 15.108 18.961 12 24 12c3.059 0 5.842 1.154 7.961 3.039l5.657-5.657C34.046 6.053 29.268 4 24 4 16.318 4 9.656 8.337 6.306 14.691z"
      />
      <path
        fill="#4CAF50"
        d="M24 44c5.166 0 9.86-1.977 13.409-5.192l-6.19-5.238C29.211 35.091 26.715 36 24 36c-5.202 0-9.619-3.317-11.283-7.946l-6.522 5.025C9.505 39.556 16.227 44 24 44z"
      />
      <path
        fill="#1976D2"
        d="M43.611 20.083H42V20H24v8h11.303c-.792 2.237-2.231 4.166-4.087 5.571l6.19 5.238C36.971 39.205 44 34 44 24c0-1.341-.138-2.65-.389-3.917z"
      />
    </svg>
  );
}

/** "Continue with Google" — kicks off Supabase OAuth. Google redirects back to
 *  /auth/callback, which exchanges the code for a session (same handler as the
 *  email magic-link / recovery flow). Requires the Google provider to be enabled
 *  in the Supabase dashboard. */
export function GoogleAuthButton({ next = "/" }: { next?: string }) {
  const t = useTranslations("auth");
  const [pending, setPending] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);

  async function onClick() {
    setPending(true);
    setError(null);
    const supabase = createClient();
    const site =
      process.env.NEXT_PUBLIC_SITE_URL?.replace(/\/$/, "") ??
      window.location.origin;
    const { error: oauthError } = await supabase.auth.signInWithOAuth({
      provider: "google",
      options: {
        redirectTo: `${site}/auth/callback?next=${encodeURIComponent(next)}`,
      },
    });
    if (oauthError) {
      // Map to a localized message instead of echoing the raw English
      // Supabase error — same discipline as the auth server actions, so RU
      // users don't get an untranslated provider string.
      setError(mapAuthError(oauthError, t));
      setPending(false);
    }
    // On success the browser is redirected to Google's consent screen.
  }

  return (
    <div className="flex flex-col gap-2">
      <button
        type="button"
        onClick={onClick}
        disabled={pending}
        className="flex items-center justify-center gap-2.5 rounded-sm border border-foreground/15 bg-background-elevated/30 px-4 py-2.5 font-sans text-sm font-medium text-foreground transition-colors hover:bg-foreground/[0.04] disabled:opacity-50"
      >
        <GoogleG />
        {t("continueWithGoogle")}
      </button>
      {error ? (
        <p className="font-sans text-sm text-streak-loss" role="alert">
          {error}
        </p>
      ) : null}
    </div>
  );
}
