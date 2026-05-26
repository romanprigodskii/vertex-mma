import { Container } from "@/components/layout/container";
import { Footer } from "@/components/layout/footer";
import { Navbar } from "@/components/layout/navbar";
import { LeaderboardTable } from "@/components/leaderboard/leaderboard-table";
import { getLeaderboard, type LeaderboardSort } from "@/lib/leaderboard";

export const dynamic = "force-dynamic";

export const metadata = {
  title: "Leaderboard",
  description: "Top Vertex MMA bettors and listmakers.",
};

interface PageProps {
  searchParams: Promise<{ sort?: string }>;
}

function parseSort(raw: string | undefined): LeaderboardSort {
  if (raw === "volume" || raw === "achievements") return raw;
  return "profit";
}

export default async function LeaderboardPage({ searchParams }: PageProps) {
  const params = await searchParams;
  const sort = parseSort(params.sort);
  const rows = await getLeaderboard(sort, 100);

  return (
    <>
      <Navbar />
      <main className="flex-1">
        <Container size="xl" className="py-10 md:py-14">
          <header className="mb-8">
            <p className="font-mono text-[11px] uppercase tracking-[0.2em] text-foreground-subtle">
              Community
            </p>
            <h1 className="mt-2 font-display uppercase tracking-tight text-foreground text-h1">
              Leaderboard
            </h1>
            <p className="mt-2 max-w-xl font-sans text-sm text-foreground-muted">
              Top Vertex MMA bettors and listmakers. Pick a sort to switch
              the ordering — every row links to that user&apos;s profile.
            </p>
          </header>
          <LeaderboardTable rows={rows} activeSort={sort} />
        </Container>
      </main>
      <Footer />
    </>
  );
}
