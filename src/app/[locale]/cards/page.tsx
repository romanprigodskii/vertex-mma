import type { Metadata } from "next";
import { getTranslations, setRequestLocale } from "next-intl/server";

import { FightCardGridCard } from "@/components/cards/fight-card-grid-card";
import { Container } from "@/components/layout/container";
import { Footer } from "@/components/layout/footer";
import { Navbar } from "@/components/layout/navbar";
import { Link } from "@/i18n/navigation";
import { getCurrentUser } from "@/lib/auth";
import { listCardsByUser, listPublicCards } from "@/lib/fight-cards";

export const dynamic = "force-dynamic";

export async function generateMetadata({
  params,
}: {
  params: Promise<{ locale: string }>;
}): Promise<Metadata> {
  const { locale } = await params;
  const t = await getTranslations({ locale, namespace: "cards" });
  return { title: t("metaTitle"), description: t("metaDescription") };
}

const SECTION_LABEL =
  "mb-3 font-sans text-[11px] font-medium uppercase tracking-widest text-foreground-muted";

export default async function CardsListPage({
  params,
}: {
  params: Promise<{ locale: string }>;
}) {
  const { locale } = await params;
  setRequestLocale(locale);
  const t = await getTranslations("cards");
  const currentUser = await getCurrentUser();
  const [publicCards, myCards] = await Promise.all([
    listPublicCards(36),
    currentUser
      ? listCardsByUser(currentUser.userProfileId)
      : Promise.resolve([]),
  ]);

  const myIds = new Set(myCards.map((c) => c.id));
  const communityCards = publicCards.filter((c) => !myIds.has(c.id));

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
                href="/cards/create"
                className="rounded-sm bg-primary px-4 py-2 font-display text-sm uppercase tracking-widest text-background-base hover:opacity-90"
              >
                {t("buildCard")}
              </Link>
            ) : (
              <Link
                href="/signin?next=/cards/create"
                className="rounded-sm border border-foreground/15 px-4 py-2 font-display text-sm uppercase tracking-widest text-foreground-muted hover:bg-foreground/[0.05] hover:text-foreground"
              >
                {t("signInToBuild")}
              </Link>
            )}
          </header>

          {myCards.length > 0 ? (
            <section className="mb-10">
              <h2 className={SECTION_LABEL}>{t("yourCards")}</h2>
              <ul className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
                {myCards.map((c) => (
                  <li key={c.id}>
                    <FightCardGridCard card={c} />
                  </li>
                ))}
              </ul>
            </section>
          ) : null}

          <section>
            {myCards.length > 0 ? (
              <h2 className={SECTION_LABEL}>{t("communityCards")}</h2>
            ) : null}
            {communityCards.length === 0 ? (
              <div className="rounded-md border border-dashed border-foreground/15 bg-background-elevated/20 px-6 py-16 text-center">
                <p className="font-display text-xl uppercase tracking-tight text-foreground break-words sm:text-2xl">
                  {t("emptyTitle")}
                </p>
                <p className="mx-auto mt-3 max-w-md font-sans text-sm text-foreground-muted">
                  {t("emptyLead")}
                </p>
                <Link
                  href={
                    currentUser ? "/cards/create" : "/signin?next=/cards/create"
                  }
                  className="mt-6 inline-block rounded-sm bg-primary px-4 py-2 font-display text-sm uppercase tracking-widest text-background-base hover:opacity-90"
                >
                  {t("buildFirst")} →
                </Link>
              </div>
            ) : (
              <ul className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
                {communityCards.map((c) => (
                  <li key={c.id}>
                    <FightCardGridCard card={c} />
                  </li>
                ))}
              </ul>
            )}
          </section>
        </Container>
      </main>
      <Footer />
    </>
  );
}
