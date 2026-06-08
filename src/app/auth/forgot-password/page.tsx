import type { Metadata } from "next";
import { cookies } from "next/headers";
import { hasLocale } from "next-intl";
import { getTranslations } from "next-intl/server";

import { ForgotPasswordForm } from "@/app/auth/forgot-password/forgot-password-form";
import { Container } from "@/components/layout/container";
import { Footer } from "@/components/layout/footer";
import { Navbar } from "@/components/layout/navbar";
import { routing } from "@/i18n/routing";

// This route lives outside the [locale] segment (reset links arrive from
// Supabase emails with no prefix), so we resolve the locale from the
// NEXT_LOCALE cookie — the same source the auth layout uses — to localize the
// title/description instead of hardcoding English.
export async function generateMetadata(): Promise<Metadata> {
  const cookieStore = await cookies();
  const cookieLocale = cookieStore.get("NEXT_LOCALE")?.value;
  const locale = hasLocale(routing.locales, cookieLocale)
    ? cookieLocale
    : routing.defaultLocale;
  const t = await getTranslations({ locale, namespace: "auth" });
  return { title: t("forgotTitle"), description: t("forgotLead") };
}

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
