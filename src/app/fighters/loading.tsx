import { CatalogSkeleton } from "@/components/fighter/CatalogSkeleton";
import { Container } from "@/components/layout/container";
import { Footer } from "@/components/layout/footer";
import { Navbar } from "@/components/layout/navbar";

export default function FightersLoading() {
  return (
    <>
      <Navbar />
      <main className="flex-1">
        <section className="relative border-b border-foreground/10">
          <Container size="xl" className="pb-16 pt-20 md:pt-24">
            <p className="font-mono text-[11px] uppercase tracking-[0.2em] text-foreground-subtle">
              The roster
            </p>
            <h1
              className="mt-3 font-sans font-bold tracking-[-0.01em] text-foreground leading-[0.85]"
              style={{ fontSize: "clamp(64px, 8vw, 144px)" }}
            >
              FIGHTERS
            </h1>
            <p className="mt-6 font-sans text-base text-foreground-muted">
              Loading roster…
            </p>
          </Container>
        </section>

        <Container size="xl" className="pb-16 pt-6">
          <div className="flex flex-col gap-6">
            <div className="-mx-4 flex gap-3 overflow-x-hidden px-4 sm:-mx-6 sm:px-6 lg:-mx-8 lg:px-8">
              {Array.from({ length: 6 }).map((_, i) => (
                <div
                  key={i}
                  className="h-[120px] w-[320px] shrink-0 rounded-lg border border-foreground/10 bg-background-elevated/40 animate-pulse"
                />
              ))}
            </div>
            <div className="h-12 w-full rounded-md border border-foreground/10 bg-background-elevated/40 animate-pulse" />
            <div className="flex gap-6 lg:gap-8">
              <div className="hidden lg:block w-[220px] shrink-0">
                <div className="h-64 rounded-md border border-foreground/10 bg-background-elevated/40 animate-pulse" />
              </div>
              <div className="min-w-0 flex-1">
                <CatalogSkeleton count={10} />
              </div>
            </div>
          </div>
        </Container>
      </main>
      <Footer />
    </>
  );
}
