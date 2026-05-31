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
