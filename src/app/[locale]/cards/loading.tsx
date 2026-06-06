import { Container } from "@/components/layout/container";
import { Footer } from "@/components/layout/footer";
import { Navbar } from "@/components/layout/navbar";

/**
 * Skeleton for the /cards index. Keeps the nav + footer chrome and mirrors the
 * header and 3-column card grid so navigation to this share-heavy page never
 * flashes blank — matching the DetailLoading pattern used by /cards/[slug].
 */
export default function CardsLoading() {
  return (
    <>
      <Navbar />
      <main className="flex-1">
        <Container size="xl" className="py-10 md:py-14">
          <header className="mb-8 flex flex-col gap-3">
            <span className="block h-3 w-24 rounded-sm bg-foreground/[0.06] animate-pulse" />
            <span className="block h-10 w-56 rounded-md bg-foreground/[0.07] animate-pulse md:h-12" />
            <span className="block h-3 w-80 max-w-full rounded-sm bg-foreground/[0.05] animate-pulse" />
          </header>

          <ul className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
            {Array.from({ length: 6 }).map((_, i) => (
              <li
                key={i}
                className="overflow-hidden rounded-md border border-foreground/10 bg-background-elevated/30"
              >
                <div className="h-1 w-full bg-foreground/[0.08] animate-pulse" />
                <div className="flex flex-col gap-3 p-4">
                  <span className="block h-5 w-3/4 rounded-sm bg-foreground/[0.07] animate-pulse" />
                  <span className="block h-3 w-2/3 rounded-sm bg-foreground/[0.05] animate-pulse" />
                  <span className="block h-3 w-1/2 rounded-sm bg-foreground/[0.05] animate-pulse" />
                  <div className="mt-1 flex items-center justify-between">
                    <span className="block h-3 w-20 rounded-sm bg-foreground/[0.05] animate-pulse" />
                    <span className="block h-3 w-10 rounded-sm bg-foreground/[0.05] animate-pulse" />
                  </div>
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
