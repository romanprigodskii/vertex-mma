import { Container } from "@/components/layout/container";
import { Footer } from "@/components/layout/footer";
import { Navbar } from "@/components/layout/navbar";

/**
 * Skeleton for the /simulation index. Keeps the nav + footer chrome and mirrors
 * the header, stats strip, and 2-column bout-card grid so a cold/slow DB fetch
 * never leaves the user on a blank screen — matching the DetailLoading pattern.
 */
export default function SimulationLoading() {
  return (
    <>
      <Navbar />
      <main className="flex-1">
        <Container size="xl" className="py-10 md:py-14">
          <header className="mb-8 flex flex-col gap-3">
            <span className="block h-3 w-28 rounded-sm bg-foreground/[0.06] animate-pulse" />
            <span className="block h-10 w-48 rounded-md bg-foreground/[0.07] animate-pulse md:h-12" />
            <span className="block h-3 w-80 max-w-full rounded-sm bg-foreground/[0.05] animate-pulse" />
          </header>

          <ul className="mb-6 grid grid-cols-2 gap-2 sm:grid-cols-4">
            {Array.from({ length: 4 }).map((_, i) => (
              <li
                key={i}
                className="rounded-md border border-foreground/10 bg-background-elevated/30 px-3 py-3 sm:px-4"
              >
                <span className="block h-2.5 w-16 rounded-sm bg-foreground/[0.05] animate-pulse" />
                <span className="mt-2 block h-7 w-12 rounded-sm bg-foreground/[0.07] animate-pulse" />
              </li>
            ))}
          </ul>

          <ul className="grid grid-cols-1 gap-3 lg:grid-cols-2">
            {Array.from({ length: 6 }).map((_, i) => (
              <li
                key={i}
                className="flex flex-col gap-3 rounded-md border border-foreground/10 bg-background-elevated/30 px-4 py-4"
              >
                <span className="block h-2.5 w-24 rounded-sm bg-foreground/[0.05] animate-pulse" />
                <div className="flex items-center gap-3">
                  <span className="h-12 w-12 shrink-0 rounded-full bg-foreground/[0.06] animate-pulse" />
                  <span className="block h-4 flex-1 rounded-sm bg-foreground/[0.06] animate-pulse" />
                  <span className="h-12 w-12 shrink-0 rounded-full bg-foreground/[0.06] animate-pulse" />
                </div>
                <div className="border-t border-foreground/10 pt-3">
                  <span className="block h-7 w-32 rounded-sm bg-foreground/[0.07] animate-pulse" />
                </div>
              </li>
            ))}
          </ul>
        </Container>
      </main>
      <Footer />
    </>
  );
}
