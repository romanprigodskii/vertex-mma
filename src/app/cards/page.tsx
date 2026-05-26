import Link from "next/link";

import { FightCardGridCard } from "@/components/cards/fight-card-grid-card";
import { Container } from "@/components/layout/container";
import { Footer } from "@/components/layout/footer";
import { Navbar } from "@/components/layout/navbar";
import { getCurrentUser } from "@/lib/auth";
import { listCardsByUser, listPublicCards } from "@/lib/fight-cards";

export const dynamic = "force-dynamic";

export const metadata = {
  title: "Fight Cards",
  description: "Community-built dream fight cards on Vertex MMA.",
};

const SECTION_LABEL =
  "mb-3 font-sans text-[11px] font-medium uppercase tracking-widest text-foreground-muted";

export default async function CardsListPage() {
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
          <header className="mb-8 flex flex-wrap items-baseline justify-between gap-3">
            <div>
              <p className="font-mono text-[11px] uppercase tracking-[0.2em] text-foreground-subtle">
                Community
              </p>
              <h1 className="mt-2 font-sans font-bold uppercase tracking-tight text-foreground text-h1">
                Fight Cards
              </h1>
              <p className="mt-2 max-w-xl font-sans text-sm text-foreground-muted">
                Dream cards built by Vertex MMA users. Book any matchup, theme
                it, share it.
              </p>
            </div>
            {currentUser ? (
              <Link
                href="/cards/create"
                className="rounded-sm bg-primary px-4 py-2 font-sans font-bold text-sm uppercase tracking-widest text-background-base hover:opacity-90"
              >
                Build a card
              </Link>
            ) : (
              <Link
                href="/signin?next=/cards/create"
                className="rounded-sm border border-foreground/15 px-4 py-2 font-sans font-bold text-sm uppercase tracking-widest text-foreground-muted hover:bg-foreground/[0.05] hover:text-foreground"
              >
                Sign in to build
              </Link>
            )}
          </header>

          {myCards.length > 0 ? (
            <section className="mb-10">
              <h2 className={SECTION_LABEL}>Your cards</h2>
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
              <h2 className={SECTION_LABEL}>Community cards</h2>
            ) : null}
            {communityCards.length === 0 ? (
              <div className="rounded-md border border-dashed border-foreground/15 bg-background-elevated/20 px-6 py-16 text-center">
                <p className="font-sans font-bold text-2xl uppercase tracking-tight text-foreground">
                  No fight cards yet
                </p>
                <p className="mx-auto mt-3 max-w-md font-sans text-sm text-foreground-muted">
                  Be the first to book one. Pick the fighters, set the main
                  event, theme it, and share.
                </p>
                <Link
                  href={
                    currentUser ? "/cards/create" : "/signin?next=/cards/create"
                  }
                  className="mt-6 inline-block rounded-sm bg-primary px-4 py-2 font-sans font-bold text-sm uppercase tracking-widest text-background-base hover:opacity-90"
                >
                  Build the first card →
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
