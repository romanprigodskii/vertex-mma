import type { Metadata } from "next";
import { getTranslations, setRequestLocale } from "next-intl/server";

import { Container } from "@/components/layout/container";
import { Footer } from "@/components/layout/footer";
import { Navbar } from "@/components/layout/navbar";
import { RankingCard } from "@/components/rankings/ranking-card";
import { Link } from "@/i18n/navigation";
import { getCurrentUser } from "@/lib/auth";
import { listRecentRankings } from "@/lib/rankings";

export const dynamic = "force-dynamic";

export async function generateMetadata({
  params,
}: {
  params: Promise<{ locale: string }>;
}): Promise<Metadata> {
  const { locale } = await params;
  const t = await getTranslations({ locale, namespace: "rankings" });
  const title = t("metaTitle");
  const description = t("metaDescription");
  // Set og/twitter explicitly so the shared card doesn't inherit the root
  // layout's generic "Vertex MMA — AI-powered MMA fight simulator".
  return {
    title,
    description,
    openGraph: { title, description, siteName: "Vertex MMA", type: "website" },
    twitter: { title, description },
  };
}

export default async function RankingsListPage({
  params,
}: {
  params: Promise<{ locale: string }>;
}) {
  const { locale } = await params;
  setRequestLocale(locale);
  const t = await getTranslations("rankings");
  const [rankings, currentUser] = await Promise.all([
    listRecentRankings(30),
    getCurrentUser(),
  ]);

  return (
    <>
      <Navbar />
      <main className="flex-1">
        <Container size="xl" className="py-10 md:py-14">
          <header className="mb-8 flex flex-col items-start gap-4 sm:flex-row sm:flex-wrap sm:items-baseline sm:justify-between sm:gap-3">
            <div className="min-w-0 flex-1">
              <p className="font-mono text-[11px] uppercase tracking-[0.2em] text-foreground-subtle">
                {t("kicker")}
              </p>
              <h1 className="mt-2 font-display uppercase tracking-tight text-foreground text-h1">
                {t("heading")}
              </h1>
              <p className="mt-2 max-w-xl font-sans text-sm text-foreground-muted">
                {t("lead")}
              </p>
            </div>
            {currentUser ? (
              <Link
                href="/rankings/create"
                className="rounded-sm bg-primary px-4 py-2 font-display text-sm uppercase tracking-widest text-background-base hover:opacity-90"
              >
                {t("createRanking")}
              </Link>
            ) : (
              <Link
                href="/signin?next=/rankings/create"
                className="rounded-sm border border-foreground/15 px-4 py-2 font-display text-sm uppercase tracking-widest text-foreground-muted hover:bg-foreground/[0.05] hover:text-foreground"
              >
                {t("signInToCreate")}
              </Link>
            )}
          </header>

          {rankings.length === 0 ? (
            <div className="rounded-md border border-dashed border-foreground/15 bg-background-elevated/20 px-4 py-12 text-center sm:px-6 sm:py-16">
              <p className="font-display text-xl uppercase tracking-tight text-foreground sm:text-2xl">
                {t("emptyTitle")}
              </p>
              <p className="mx-auto mt-3 max-w-md font-sans text-sm text-foreground-muted">
                {t("emptyLead")}
              </p>
              <Link
                href={currentUser ? "/rankings/create" : "/signin?next=/rankings/create"}
                className="mt-6 inline-block rounded-sm bg-primary px-4 py-2 font-display text-sm uppercase tracking-widest text-background-base hover:opacity-90"
              >
                {t("createFirst")} →
              </Link>
            </div>
          ) : (
            <ul className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
              {rankings.map((r) => (
                <li key={r.id}>
                  <RankingCard ranking={r} />
                </li>
              ))}
            </ul>
          )}
        </Container>
      </main>
      <Footer />
    </>
  );
}
