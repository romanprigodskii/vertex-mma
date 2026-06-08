/**
 * Centralised environment-variable validation.
 *
 * Importing this module asserts the required PUBLIC vars are present, and
 * `serverEnv()` lazily validates the server-only secrets (refusing to run in
 * the browser so they can never leak into a client bundle). The point is to
 * fail fast at boot with a clear message instead of surfacing opaque 500s deep
 * inside a request when a deploy is misconfigured.
 *
 * NEXT_PUBLIC_* are referenced as literals below so Next inlines them at build.
 */

function required(name: string, value: string | undefined): string {
  if (!value || value.trim() === "") {
    throw new Error(
      `Missing required environment variable: ${name}. Set it in .env.local (see .env.example).`,
    );
  }
  return value;
}

export const publicEnv = {
  NEXT_PUBLIC_SUPABASE_URL: required(
    "NEXT_PUBLIC_SUPABASE_URL",
    process.env.NEXT_PUBLIC_SUPABASE_URL,
  ),
  NEXT_PUBLIC_SUPABASE_ANON_KEY: required(
    "NEXT_PUBLIC_SUPABASE_ANON_KEY",
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY,
  ),
};

let cachedServerEnv: {
  DATABASE_URL: string;
  SUPABASE_SERVICE_ROLE_KEY: string;
} | null = null;

export function serverEnv() {
  if (typeof window !== "undefined") {
    throw new Error("serverEnv() must never be called in the browser.");
  }
  if (!cachedServerEnv) {
    const isProduction = process.env.NODE_ENV === "production";

    // NEXT_PUBLIC_SITE_URL drives metadataBase (OG/Twitter images), sitemap
    // URLs, and the OAuth callback redirect. Blank in production ships broken
    // canonical URLs and a redirect_uri that fails auth — so fail fast here
    // rather than serving subtly broken pages. (Lenient in dev, where code
    // falls back to localhost.)
    if (isProduction && !(process.env.NEXT_PUBLIC_SITE_URL ?? "").trim()) {
      throw new Error(
        "NEXT_PUBLIC_SITE_URL is required in production — it drives metadataBase " +
          "(OG/Twitter images), sitemap URLs, and the OAuth callback redirect. " +
          "Set it in the deploy environment (e.g. https://vertexmma.com, no trailing slash).",
      );
    }

    // ADMIN_EMAILS is the staff/moderator allowlist (see isStaffEmail in
    // auth.ts). Optional, but an empty allowlist in production means nobody can
    // moderate — silently. Warn once at boot so a misconfigured deploy shows up
    // in the logs instead of being discovered when a report goes unactioned.
    if (isProduction && !(process.env.ADMIN_EMAILS ?? "").trim()) {
      console.warn(
        "[env] ADMIN_EMAILS is empty in production — staff moderation is disabled " +
          "(no user can remove another user's comment). Set ADMIN_EMAILS to a " +
          "comma-separated allowlist to enable it.",
      );
    }

    cachedServerEnv = {
      DATABASE_URL: required("DATABASE_URL", process.env.DATABASE_URL),
      SUPABASE_SERVICE_ROLE_KEY: required(
        "SUPABASE_SERVICE_ROLE_KEY",
        process.env.SUPABASE_SERVICE_ROLE_KEY,
      ),
    };
  }
  return cachedServerEnv;
}
