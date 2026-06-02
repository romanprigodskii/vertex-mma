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
  return { title: t("privacyTitle") };
}

export default async function PrivacyPage({
  params,
}: {
  params: Promise<{ locale: string }>;
}) {
  const { locale } = await params;
  setRequestLocale(locale);
  const t = await getTranslations("static");
  const sections = t.raw("privacySections") as Array<{
    heading: string;
    body: string;
  }>;
  return (
    <>
      <Navbar />
      <main className="flex-1">
        <Container size="md" className="py-16">
          <p className="text-center font-mono text-[11px] uppercase tracking-[0.2em] text-foreground-subtle">
            {t("brand")}
          </p>
          <h1 className="mt-3 text-center font-display uppercase tracking-tight text-foreground text-h1">
            {t("privacyTitle")}
          </h1>
          <p className="mt-3 text-center font-sans text-xs text-foreground-subtle">
            {t("lastUpdated")}
          </p>
          <p className="mx-auto mt-8 max-w-2xl font-sans text-sm leading-relaxed text-foreground-muted">
            {t("privacyLead")}
          </p>
          <div className="mx-auto mt-10 flex max-w-2xl flex-col gap-8">
            {sections.map((s) => (
              <section key={s.heading}>
                <h2 className="font-display text-lg uppercase tracking-tight text-foreground">
                  {s.heading}
                </h2>
                <p className="mt-2 whitespace-pre-line font-sans text-sm leading-relaxed text-foreground-muted">
                  {s.body}
                </p>
              </section>
            ))}
          </div>
          <p className="mx-auto mt-10 max-w-2xl border-t border-foreground/10 pt-6 font-sans text-xs leading-relaxed text-foreground-subtle">
            {t("contactBody")}
          </p>
        </Container>
      </main>
      <Footer />
    </>
  );
}
