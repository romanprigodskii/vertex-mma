import { createServerClient } from "@supabase/ssr";
import createIntlMiddleware from "next-intl/middleware";
import { type NextRequest } from "next/server";

import { publicEnv } from "@/lib/env";
import { routing } from "@/i18n/routing";

const intlMiddleware = createIntlMiddleware(routing);

export async function middleware(request: NextRequest) {
  // Locale detection / redirect / rewrite. With `localePrefix: "as-needed"`
  // the EN default is internally rewritten from `/foo` to `/en/foo` — that
  // rewrite info lives on the response object, so we MUST keep using this
  // response downstream instead of creating a fresh NextResponse.next().
  const intlResponse = intlMiddleware(request);

  // Run the Supabase refresh on EVERY matched request, including the ones where
  // next-intl emits a locale redirect (Location header). Returning early on a
  // redirect would skip token rotation, so the refreshed cookies would never be
  // written on that response — leaving an expiring session un-refreshed until
  // the next non-redirecting request (which surfaces as an intermittent
  // logged-in user appearing logged-out). A 3xx response carries Set-Cookie
  // fine, so we write the rotated cookies onto intlResponse either way.
  //
  // Chain Supabase session refresh on the SAME response. Supabase's
  // createServerClient writes refresh cookies via setAll — we just point
  // those writes at intlResponse.cookies, preserving the rewrite/redirect
  // headers it set.
  const supabase = createServerClient(
    publicEnv.NEXT_PUBLIC_SUPABASE_URL,
    publicEnv.NEXT_PUBLIC_SUPABASE_ANON_KEY,
    {
      cookies: {
        getAll() {
          return request.cookies.getAll();
        },
        setAll(cookiesToSet) {
          for (const { name, value, options } of cookiesToSet) {
            intlResponse.cookies.set(name, value, options);
          }
        },
      },
    },
  );
  await supabase.auth.getUser();

  return intlResponse;
}

export const config = {
  matcher: [
    /*
     * Match all paths except:
     *   - _next/static, _next/image  (build assets)
     *   - favicon.ico, sitemap.xml, robots.txt, manifest.webmanifest  (metadata files)
     *   - api/* and auth/*  (locale prefix doesn't make sense here)
     *   - common image extensions
     */
    "/((?!api|auth|_next/static|_next/image|favicon.ico|sitemap.xml|robots.txt|manifest.webmanifest|.*\\.(?:svg|png|jpg|jpeg|gif|webp)$).*)",
  ],
};
