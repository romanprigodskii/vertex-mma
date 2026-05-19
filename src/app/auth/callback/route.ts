import { NextResponse, type NextRequest } from "next/server";

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
  const next = searchParams.get("next") ?? "/";
  const origin = siteOrigin(request);

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

  return NextResponse.redirect(`${origin}${next}`);
}
