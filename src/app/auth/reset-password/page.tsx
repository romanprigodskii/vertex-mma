import type { Metadata } from "next";
import { cookies } from "next/headers";
import { hasLocale } from "next-intl";
import { getTranslations } from "next-intl/server";

import { ResetPasswordForm } from "@/app/auth/reset-password/reset-password-form";
import { Container } from "@/components/layout/container";
import { Footer } from "@/components/layout/footer";
import { Navbar } from "@/components/layout/navbar";
import { routing } from "@/i18n/routing";
import { createClient } from "@/lib/supabase/server";

// Mirrors auth/layout: resolve locale from the NEXT_LOCALE cookie so the
// <title> matches the language the user picked (the reset flow lives outside
// the [locale] segment). Falls back to the base locale when absent/invalid.
export async function generateMetadata(): Promise<Metadata> {
  const cookieStore = await cookies();
  const cookieLocale = cookieStore.get("NEXT_LOCALE")?.value;
  const locale = hasLocale(routing.locales, cookieLocale)
    ? cookieLocale
    : routing.defaultLocale;
  const t = await getTranslations({ locale, namespace: "metadata" });
  return {
    title: t("resetPasswordTitle"),
  };
}

// /auth/callback exchanges the recovery code for a session before redirecting
// here, so a valid link always arrives with one. When there's no session
// (direct navigation, or an expired/used link that never minted one), render
// the invalid-link state instead of a password form that will only fail on
// submit. Reading the session opts the route into dynamic rendering.
export const dynamic = "force-dynamic";

export default async function ResetPasswordPage() {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  return (
    <>
      <Navbar />
      <main className="flex-1">
        <Container size="sm" className="py-12 md:py-16">
          <ResetPasswordForm invalid={!user} />
        </Container>
      </main>
      <Footer />
    </>
  );
}
