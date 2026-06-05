import { Container } from "@/components/layout/container";
import { Footer } from "@/components/layout/footer";
import { Navbar } from "@/components/layout/navbar";

/**
 * Generic skeleton for dynamic detail routes (bout, market, news, ranking,
 * card, parlay). Keeps the nav + footer chrome and a pulsing
 * placeholder so navigation to a share-critical page never flashes blank.
 */
export function DetailLoading() {
  return (
    <>
      <Navbar />
      <main className="flex-1">
        <div className="border-b border-foreground/[0.06]">
          <Container size="xl" className="py-3">
            <span className="inline-block h-4 w-20 rounded-sm bg-foreground/[0.06] animate-pulse" />
          </Container>
        </div>

        <Container size="lg" className="py-10 md:py-14">
          <span className="block h-3 w-40 rounded-sm bg-foreground/[0.06] animate-pulse" />
          <span className="mt-3 block h-12 w-3/4 rounded-md bg-foreground/[0.07] animate-pulse md:h-16" />
          <span className="mt-4 block h-3 w-64 rounded-sm bg-foreground/[0.05] animate-pulse" />

          <div className="mt-8 grid grid-cols-1 gap-3 sm:grid-cols-2">
            {Array.from({ length: 4 }).map((_, i) => (
              <span
                key={i}
                className="block h-24 rounded-md border border-foreground/10 bg-background-elevated/30 animate-pulse"
              />
            ))}
          </div>
        </Container>
      </main>
      <Footer />
    </>
  );
}
