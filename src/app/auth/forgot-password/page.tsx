import type { Metadata } from "next";
import { cookies } from "next/headers";
import { hasLocale } from "next-intl";
import { getTranslations } from "next-intl/server";

import { ForgotPasswordForm } from "@/app/auth/forgot-password/forgot-password-form";
import { Container } from "@/components/layout/container";
import { Footer } from "@/components/layout/footer";
import { Navbar } from "@/components/layout/navbar";
import { routing } from "@/i18n/routing";

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
    title: t("forgotPasswordTitle"),
  };
}

// generateMetadata reads the NEXT_LOCALE cookie (as does auth/layout), so this
// route renders dynamically — declare it explicitly to match reset-password.
export const dynamic = "force-dynamic";

export default function ForgotPasswordPage() {
  return (
    <>
      <Navbar />
      <main className="flex-1">
        <Container size="sm" className="py-12 md:py-16">
          <ForgotPasswordForm />
        </Container>
      </main>
      <Footer />
    </>
  );
}
