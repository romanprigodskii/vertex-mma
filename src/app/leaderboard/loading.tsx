import { Container } from "@/components/layout/container";
import { Footer } from "@/components/layout/footer";
import { Navbar } from "@/components/layout/navbar";

// Mirrors ROW_GRID from leaderboard-table.tsx so the skeleton lines up
// with the live header + rows and the swap doesn't shift columns.
const SKELETON_ROW =
  "grid grid-cols-[3rem_2.75rem_minmax(0,1fr)_8rem_4rem] items-center gap-4 px-3";

export default function LeaderboardLoading() {
  return (
    <>
      <Navbar />
      <main className="flex-1">
        <Container size="xl" className="py-10 md:py-14">
          <div className="mb-8">
            <div className="mb-2 h-4 w-24 animate-pulse rounded bg-fg/[0.05]" />
            <div className="h-12 w-56 animate-pulse rounded bg-fg/[0.05]" />
            <div className="mt-3 h-4 w-72 animate-pulse rounded bg-fg/[0.05]" />
          </div>
          <div className="mb-6 flex gap-4 border-b border-edge">
            {[0, 1, 2].map((i) => (
              <div
                key={i}
                className="my-2 h-5 w-20 animate-pulse rounded bg-fg/[0.05]"
              />
            ))}
          </div>
          <div className={`${SKELETON_ROW} border-b border-fg/15 py-2`}>
            <div className="ml-auto h-3 w-8 animate-pulse rounded bg-fg/[0.04]" />
            <div />
            <div className="h-3 w-12 animate-pulse rounded bg-fg/[0.04]" />
            <div className="ml-auto h-3 w-14 animate-pulse rounded bg-fg/[0.04]" />
            <div className="ml-auto h-3 w-8 animate-pulse rounded bg-fg/[0.04]" />
          </div>
          <ul className="flex flex-col">
            {Array.from({ length: 10 }).map((_, i) => (
              <li
                key={i}
                className={`${SKELETON_ROW} border-b border-fg/[0.08] py-2.5`}
              >
                <div className="ml-auto h-6 w-8 animate-pulse rounded bg-fg/[0.05]" />
                <div className="h-9 w-9 animate-pulse rounded-full bg-fg/[0.05]" />
                <div className="flex flex-col gap-1">
                  <div className="h-4 w-32 animate-pulse rounded bg-fg/[0.05]" />
                  <div className="h-3 w-44 animate-pulse rounded bg-fg/[0.04]" />
                </div>
                <div className="ml-auto h-6 w-20 animate-pulse rounded bg-fg/[0.05]" />
                <div className="ml-auto h-3 w-12 animate-pulse rounded bg-fg/[0.04]" />
              </li>
            ))}
          </ul>
        </Container>
      </main>
      <Footer />
    </>
  );
}
