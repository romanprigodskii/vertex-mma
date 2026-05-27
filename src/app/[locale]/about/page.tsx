import type { Metadata } from "next";
import { getTranslations, setRequestLocale } from "next-intl/server";

import { Container } from "@/components/layout/container";
import { Footer } from "@/components/layout/footer";
import { Navbar } from "@/components/layout/navbar";

export async function generateMetadata({
  params,
}: {
  params: Promise<{ locale: string }>;
}): Promise<Metadata> {
  const { locale } = await params;
  const t = await getTranslations({ locale, namespace: "static" });
  return { title: t("aboutTitle") };
}

export default async function AboutPage({
  params,
}: {
  params: Promise<{ locale: string }>;
}) {
  const { locale } = await params;
  setRequestLocale(locale);
  const t = await getTranslations("static");
  return (
    <>
      <Navbar />
      <main className="flex-1">
        <Container size="md" className="py-16 text-center">
          <p className="font-mono text-[11px] uppercase tracking-[0.2em] text-foreground-subtle">
            {t("brand")}
          </p>
          <h1 className="mt-3 font-display uppercase tracking-tight text-foreground text-h1">
            {t("aboutTitle")}
          </h1>
          <p className="mt-6 font-sans text-sm text-foreground-muted">
            {t("aboutBody")}
          </p>
          <p className="mt-4 font-sans text-sm text-foreground-muted">
            {t("aboutNote")}
          </p>
        </Container>
      </main>
      <Footer />
    </>
  );
}
