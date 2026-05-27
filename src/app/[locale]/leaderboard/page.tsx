import type { Metadata } from "next";
import { getTranslations, setRequestLocale } from "next-intl/server";

import { Container } from "@/components/layout/container";
import { Footer } from "@/components/layout/footer";
import { Navbar } from "@/components/layout/navbar";
import { LeaderboardTable } from "@/components/leaderboard/leaderboard-table";
import { getLeaderboard, type LeaderboardSort } from "@/lib/leaderboard";

export const dynamic = "force-dynamic";

export async function generateMetadata({
  params,
}: {
  params: Promise<{ locale: string }>;
}): Promise<Metadata> {
  const { locale } = await params;
  const t = await getTranslations({ locale, namespace: "leaderboard" });
  return { title: t("metaTitle"), description: t("metaDescription") };
}

interface PageProps {
  params: Promise<{ locale: string }>;
  searchParams: Promise<{ sort?: string }>;
}

function parseSort(raw: string | undefined): LeaderboardSort {
  if (raw === "volume" || raw === "achievements") return raw;
  return "profit";
}

export default async function LeaderboardPage({ params, searchParams }: PageProps) {
  const { locale } = await params;
  setRequestLocale(locale);
  const t = await getTranslations("leaderboard");
  const sp = await searchParams;
  const sort = parseSort(sp.sort);
  const rows = await getLeaderboard(sort, 100);

  return (
    <>
      <Navbar />
      <main className="flex-1">
        <Container size="xl" className="py-10 md:py-14">
          <header className="mb-8">
            <p className="font-mono text-[11px] uppercase tracking-[0.2em] text-foreground-subtle">
              {t("kicker")}
            </p>
            <h1 className="mt-2 font-display uppercase tracking-tight text-foreground text-h1">
              {t("heading")}
            </h1>
            <p className="mt-2 max-w-xl font-sans text-sm text-foreground-muted">
              {t("lead")}
            </p>
          </header>
          <LeaderboardTable rows={rows} activeSort={sort} />
        </Container>
      </main>
      <Footer />
    </>
  );
}
