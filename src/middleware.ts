import { createServerClient } from "@supabase/ssr";
import createIntlMiddleware from "next-intl/middleware";
import { type NextRequest } from "next/server";

import { routing } from "@/i18n/routing";

const intlMiddleware = createIntlMiddleware(routing);

export async function middleware(request: NextRequest) {
  // Locale detection / redirect / rewrite. With `localePrefix: "as-needed"`
  // the EN default is internally rewritten from `/foo` to `/en/foo` — that
  // rewrite info lives on the response object, so we MUST keep using this
  // response downstream instead of creating a fresh NextResponse.next().
  const intlResponse = intlMiddleware(request);
  if (intlResponse.headers.get("location")) {
    return intlResponse;
  }

  // Chain Supabase session refresh on the SAME response. Supabase's
  // createServerClient writes refresh cookies via setAll — we just point
  // those writes at intlResponse.cookies, preserving the rewrite headers
  // it set.
  const supabase = createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL ?? "",
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? "",
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
     *   - favicon.ico, sitemap.xml, robots.txt  (metadata files)
     *   - api/* and auth/*  (locale prefix doesn't make sense here)
     *   - common image extensions
     */
    "/((?!api|auth|_next/static|_next/image|favicon.ico|sitemap.xml|robots.txt|.*\\.(?:svg|png|jpg|jpeg|gif|webp)$).*)",
  ],
};
