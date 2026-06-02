import { hasLocale } from "next-intl";
import { NextResponse, type NextRequest } from "next/server";

import { routing } from "@/i18n/routing";
import { safeNext } from "@/lib/safe-redirect";
import { createClient } from "@/lib/supabase/server";

function siteOrigin(request: NextRequest): string {
  // Behind Traefik/Coolify the request URL may resolve to the internal
  // container origin (http://10.0.1.8:3000), which then ends up in the
  // browser's redirect chain. Prefer the canonical site URL so the user
  // lands back on https://vertexmma.com.
  const fromEnv = process.env.NEXT_PUBLIC_SITE_URL?.replace(/\/$/, "");
  if (fromEnv) return fromEnv;
  return new URL(request.url).origin;
}

export async function GET(request: NextRequest) {
  const { searchParams } = new URL(request.url);
  const code = searchParams.get("code");
  const errorDescription =
    searchParams.get("error_description") ?? searchParams.get("error");
  // Validate server-side: `next` is attacker-controlled (recovery / magic-link
  // / OAuth links carry it), and concatenating it raw allowed an open redirect
  // (e.g. next=@evil.com -> https://host@evil.com). safeNext rejects anything
  // that isn't a same-origin relative path.
  const next = safeNext(searchParams.get("next"));
  const origin = siteOrigin(request);
  // Carry the user's locale across the email round-trip (e.g. a password-reset
  // link opened on another device, which has no NEXT_LOCALE cookie yet). When
  // present and valid, persist it as the cookie the /auth layout reads so the
  // landing page renders in their language.
  const localeParam = searchParams.get("locale");
  const locale = hasLocale(routing.locales, localeParam) ? localeParam : null;

  // Supabase signals errors via query params when redirect target isn't
  // allow-listed or the token already used. Surface them so we don't show
  // a useless "callback failed" screen.
  if (errorDescription) {
    console.error("auth/callback: supabase error", errorDescription);
    return NextResponse.redirect(
      `${origin}/signin?error=${encodeURIComponent(errorDescription)}`,
    );
  }

  if (!code) {
    return NextResponse.redirect(
      `${origin}/signin?error=${encodeURIComponent("Missing code in callback URL.")}`,
    );
  }

  const supabase = await createClient();
  const { error } = await supabase.auth.exchangeCodeForSession(code);
  if (error) {
    console.error("auth/callback: exchangeCodeForSession failed", error.message);
    return NextResponse.redirect(
      `${origin}/signin?error=${encodeURIComponent(error.message)}`,
    );
  }

  const res = NextResponse.redirect(`${origin}${next}`);
  if (locale) {
    res.cookies.set("NEXT_LOCALE", locale, {
      path: "/",
      maxAge: 60 * 60 * 24 * 365,
      sameSite: "lax",
    });
  }
  return res;
}
