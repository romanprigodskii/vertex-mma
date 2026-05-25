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
            <p className="type-meta text-[11px] text-fg-subtle">
              Community
            </p>
            <h1 className="mt-2 type-h1 text-h1 text-fg">
              Leaderboard
            </h1>
            <p className="mt-2 max-w-xl type-body text-sm text-fg-muted">
              Top Vertex MMA bettors and listmakers.
            </p>
          </header>
          <LeaderboardTable rows={rows} activeSort={sort} />
        </Container>
      </main>
      <Footer />
    </>
  );
}
