import { Container } from "@/components/layout/container";
import { Footer } from "@/components/layout/footer";
import { Navbar } from "@/components/layout/navbar";

export default function LeaderboardLoading() {
  return (
    <>
      <Navbar />
      <main className="flex-1">
        <Container size="xl" className="py-10 md:py-14">
          <div className="mb-8">
            <div className="mb-2 h-4 w-24 animate-pulse rounded bg-foreground/[0.05]" />
            <div className="h-12 w-56 animate-pulse rounded bg-foreground/[0.05]" />
            <div className="mt-3 h-4 w-80 animate-pulse rounded bg-foreground/[0.05]" />
          </div>
          <div className="mb-4 flex gap-4 border-b border-foreground/10">
            {[0, 1, 2].map((i) => (
              <div
                key={i}
                className="my-2 h-5 w-20 animate-pulse rounded bg-foreground/[0.05]"
              />
            ))}
          </div>
          <ul className="flex flex-col gap-1">
            {Array.from({ length: 10 }).map((_, i) => (
              <li
                key={i}
                className="grid grid-cols-[2rem_2.25rem_minmax(0,1fr)_auto] items-center gap-2 rounded-md border border-foreground/10 bg-background-elevated/30 px-2.5 py-2.5 sm:grid-cols-[2.5rem_2.5rem_minmax(0,1fr)_auto] sm:gap-3 sm:px-3"
              >
                <div className="h-5 w-8 animate-pulse rounded bg-foreground/[0.05]" />
                <div className="h-8 w-8 animate-pulse rounded-full bg-foreground/[0.05]" />
                <div className="h-4 w-32 animate-pulse rounded bg-foreground/[0.05]" />
                <div className="h-4 w-20 animate-pulse rounded bg-foreground/[0.05]" />
              </li>
            ))}
          </ul>
        </Container>
      </main>
      <Footer />
    </>
  );
}
