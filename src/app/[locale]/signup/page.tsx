import type { Metadata } from "next";
import { getTranslations } from "next-intl/server";

import { SignUpForm } from "@/app/[locale]/signup/sign-up-form";
import { Container } from "@/components/layout/container";
import { Footer } from "@/components/layout/footer";
import { Navbar } from "@/components/layout/navbar";

export async function generateMetadata({
  params,
}: {
  params: Promise<{ locale: string }>;
}): Promise<Metadata> {
  const { locale } = await params;
  const t = await getTranslations({ locale, namespace: "auth" });
  return { title: t("signUpTitle") };
}

export default function SignUpPage() {
  return (
    <>
      <Navbar />
      <main className="flex-1">
        <Container size="sm" className="py-12 md:py-16">
          <SignUpForm />
        </Container>
      </main>
      <Footer />
    </>
  );
}
