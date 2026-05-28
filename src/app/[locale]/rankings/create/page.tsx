import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { getTranslations, setRequestLocale } from "next-intl/server";
import { ChevronLeft } from "lucide-react";

import { Container } from "@/components/layout/container";
import { Footer } from "@/components/layout/footer";
import { Navbar } from "@/components/layout/navbar";
import { RankingForm } from "@/components/rankings/ranking-form";
import { Link } from "@/i18n/navigation";
import { getCurrentUser } from "@/lib/auth";

export const dynamic = "force-dynamic";

export async function generateMetadata({
  params,
}: {
  params: Promise<{ locale: string }>;
}): Promise<Metadata> {
  const { locale } = await params;
  const t = await getTranslations({ locale, namespace: "rankings" });
  return { title: t("createMetaTitle") };
}

export default async function CreateRankingPage({
  params,
}: {
  params: Promise<{ locale: string }>;
}) {
  const { locale } = await params;
  setRequestLocale(locale);
  const t = await getTranslations("rankings");
  const user = await getCurrentUser();
  if (!user) {
    redirect(`/${locale === "en" ? "" : `${locale}/`}signin?next=/rankings/create`);
  }

  return (
    <>
      <Navbar />
      <main className="flex-1">
        <div className="border-b border-foreground/[0.06]">
          <Container size="xl" className="py-3">
            <Link
              href="/rankings"
              className="inline-flex items-center gap-1.5 font-sans text-sm text-foreground-muted hover:text-primary"
            >
              <ChevronLeft className="h-4 w-4" aria-hidden /> {t("allRankings")}
            </Link>
          </Container>
        </div>

        <Container size="lg" className="py-10 md:py-14">
          <header className="mb-8">
            <p className="font-mono text-[11px] uppercase tracking-[0.2em] text-foreground-subtle">
              {t("newRanking")}
            </p>
            <h1 className="mt-2 font-display text-3xl uppercase tracking-tight text-foreground sm:text-4xl">
              {t("createHeading")}
            </h1>
          </header>
          <RankingForm mode="create" />
        </Container>
      </main>
      <Footer />
    </>
  );
}
