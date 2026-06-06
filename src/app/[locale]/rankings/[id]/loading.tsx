import { Container } from "@/components/layout/container";
import { Footer } from "@/components/layout/footer";
import { Navbar } from "@/components/layout/navbar";

/**
 * Ranking-specific skeleton. The shared DetailLoading renders a 2-column grid
 * of cards, but a ranking detail is a single-column numbered list (hero +
 * full-width fighter rows), so reuse here would reflow on load. This mirrors
 * RankingView's structure so the layout stays put once data arrives.
 */
export default function RankingDetailLoading() {
  return (
    <>
      <Navbar />
      <main className="flex-1">
        <div className="border-b border-foreground/[0.06]">
          <Container
            size="lg"
            className="flex items-center justify-between py-3"
          >
            <span className="inline-block h-4 w-24 rounded-sm bg-foreground/[0.06] animate-pulse" />
            <span className="inline-block h-4 w-12 rounded-sm bg-foreground/[0.06] animate-pulse" />
          </Container>
        </div>

        <section className="border-b border-foreground/[0.06]">
          <Container size="lg" className="py-10 md:py-14">
            <span className="block h-3 w-44 rounded-sm bg-foreground/[0.06] animate-pulse" />
            <span className="mt-3 block h-12 w-3/4 rounded-md bg-foreground/[0.07] animate-pulse md:h-16" />
            <span className="mt-5 block h-4 w-64 rounded-sm bg-foreground/[0.05] animate-pulse" />
          </Container>
        </section>

        <section className="py-10 md:py-14">
          <Container size="lg">
            <ol className="flex flex-col gap-3">
              {Array.from({ length: 6 }).map((_, i) => (
                <li
                  key={i}
                  className="flex items-center gap-4 rounded-md border border-foreground/10 bg-background-elevated/30 px-4 py-3"
                >
                  <span className="h-7 w-7 shrink-0 rounded-sm bg-foreground/[0.06] animate-pulse" />
                  <span className="h-14 w-14 shrink-0 rounded-sm bg-foreground/[0.06] animate-pulse" />
                  <span className="flex min-w-0 flex-1 flex-col gap-2">
                    <span className="block h-4 w-2/5 rounded-sm bg-foreground/[0.06] animate-pulse" />
                    <span className="block h-3 w-1/4 rounded-sm bg-foreground/[0.05] animate-pulse" />
                  </span>
                </li>
              ))}
            </ol>
          </Container>
        </section>
      </main>
      <Footer />
    </>
  );
}
