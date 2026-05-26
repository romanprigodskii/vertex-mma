import Link from "next/link";

import { Container } from "@/components/layout/container";
import { Footer } from "@/components/layout/footer";
import { Navbar } from "@/components/layout/navbar";
import { RankingCard } from "@/components/rankings/ranking-card";
import { getCurrentUser } from "@/lib/auth";
import { listRecentRankings } from "@/lib/rankings";

export const dynamic = "force-dynamic";

export const metadata = {
  title: "Rankings",
  description: "Community-built UFC rankings on Vertex MMA.",
};

export default async function RankingsListPage() {
  const [rankings, currentUser] = await Promise.all([
    listRecentRankings(30),
    getCurrentUser(),
  ]);

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
                Rankings
              </h1>
              <p className="mt-2 max-w-xl font-sans text-sm text-foreground-muted">
                Lists made by Vertex MMA users. Make your own to share with the
                community.
              </p>
            </div>
            {currentUser ? (
              <Link
                href="/rankings/create"
                className="rounded-sm bg-primary px-4 py-2 font-sans font-bold text-sm uppercase tracking-widest text-background-base hover:opacity-90"
              >
                Create ranking
              </Link>
            ) : (
              <Link
                href="/signin?next=/rankings/create"
                className="rounded-sm border border-foreground/15 px-4 py-2 font-sans font-bold text-sm uppercase tracking-widest text-foreground-muted hover:bg-foreground/[0.05] hover:text-foreground"
              >
                Sign in to create
              </Link>
            )}
          </header>

          {rankings.length === 0 ? (
            <div className="rounded-md border border-dashed border-foreground/15 bg-background-elevated/20 px-6 py-16 text-center">
              <p className="font-sans font-bold text-2xl uppercase tracking-tight text-foreground">
                No community rankings yet
              </p>
              <p className="mx-auto mt-3 max-w-md font-sans text-sm text-foreground-muted">
                Be the first to publish one. Drag-and-drop up to 25 fighters,
                add notes, share with the community.
              </p>
              <Link
                href={currentUser ? "/rankings/create" : "/signin?next=/rankings/create"}
                className="mt-6 inline-block rounded-sm bg-primary px-4 py-2 font-sans font-bold text-sm uppercase tracking-widest text-background-base hover:opacity-90"
              >
                Create the first ranking →
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
