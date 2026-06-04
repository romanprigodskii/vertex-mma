import type { Metadata } from "next";
import { getTranslations, setRequestLocale } from "next-intl/server";

import { Container } from "@/components/layout/container";
import { Footer } from "@/components/layout/footer";
import { Navbar } from "@/components/layout/navbar";
import { EventMarketsAccordion } from "@/components/markets/event-markets-accordion";
import { SportsbookBoard } from "@/components/markets/sportsbook-board";
import { Link } from "@/i18n/navigation";
import { getCurrentUser } from "@/lib/auth";
import { listOpenMarketsByEvent } from "@/lib/markets";
import { getSportsbookBoard } from "@/lib/sportsbook-board";

export const dynamic = "force-dynamic";

export async function generateMetadata({
  params,
}: {
  params: Promise<{ locale: string }>;
}): Promise<Metadata> {
  const { locale } = await params;
  const t = await getTranslations({ locale, namespace: "markets" });
  return { title: t("metaTitle"), description: t("metaDescription") };
}

export default async function MarketsPage({
  params,
}: {
  params: Promise<{ locale: string }>;
}) {
  const { locale } = await params;
  setRequestLocale(locale);
  const t = await getTranslations("markets");
  const [events, board, user] = await Promise.all([
    listOpenMarketsByEvent(20),
    getSportsbookBoard(60),
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
            {user ? (
              <div className="text-right">
                <p className="font-mono text-[11px] uppercase tracking-widest text-foreground-subtle">
                  {t("yourBalance")}
                </p>
                <p className="font-display text-2xl tabular text-foreground">
                  {user.balanceCoins.toLocaleString()}{" "}
                  <span className="text-sm text-foreground-muted">
                    {t("coins")}
                  </span>
                </p>
                <Link
                  href="/me/bets"
                  className="mt-1 inline-block font-sans text-xs text-primary hover:underline"
                >
                  {t("myBets")} →
                </Link>
              </div>
            ) : (
              <Link
                href="/signin?next=/markets"
                className="rounded-sm border border-foreground/15 px-4 py-2 font-display text-sm uppercase tracking-widest text-foreground-muted hover:bg-foreground/[0.05] hover:text-foreground"
              >
                {t("signInToBet")}
              </Link>
            )}
          </header>

          {board.length > 0 ? (
            <section className="mb-12">
              <div className="mb-4">
                <h2 className="font-display text-xl uppercase tracking-tight text-foreground sm:text-2xl">
                  {t("sportsbookHeading")}
                </h2>
                <p className="mt-1 max-w-xl font-sans text-sm text-foreground-muted">
                  {t("sportsbookLead")}
                </p>
              </div>
              <SportsbookBoard events={board} />
            </section>
          ) : null}

          <section>
            <div className="mb-4">
              <h2 className="font-display text-xl uppercase tracking-tight text-foreground sm:text-2xl">
                {t("lmsrHeading")}
              </h2>
              <p className="mt-1 max-w-xl font-sans text-sm text-foreground-muted">
                {t("lmsrLead")}
              </p>
            </div>
            <EventMarketsAccordion events={events} />
          </section>
        </Container>
      </main>
      <Footer />
    </>
  );
}
