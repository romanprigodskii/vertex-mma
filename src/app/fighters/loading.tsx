import { CatalogSkeleton } from "@/components/fighter/CatalogSkeleton";
import { Container } from "@/components/layout/container";
import { Footer } from "@/components/layout/footer";
import { Navbar } from "@/components/layout/navbar";

export default function FightersLoading() {
  return (
    <>
      <Navbar />
      <main className="flex-1">
        <section className="border-b border-border">
          <Container size="xl" className="py-10 md:py-14">
            <p className="font-mono text-[11px] uppercase tracking-[0.2em] text-foreground-subtle">
              Catalog
            </p>
            <h1 className="mt-2 font-display text-6xl md:text-7xl lg:text-8xl tracking-wider leading-none text-foreground">
              FIGHTERS
            </h1>
            <p className="mt-4 max-w-2xl text-base md:text-lg text-foreground-muted">
              Loading roster…
            </p>
          </Container>
        </section>

        <Container size="xl" className="py-6 md:py-8">
          <div className="flex flex-col gap-4">
            <div className="h-12 w-full rounded-md border border-border bg-background-elevated/40 animate-pulse" />
            <div className="flex gap-6 lg:gap-8">
              <div className="hidden lg:block w-[260px] shrink-0">
                <div className="h-64 rounded-md border border-border bg-background-elevated/40 animate-pulse" />
              </div>
              <div className="flex-1">
                <CatalogSkeleton count={12} />
              </div>
            </div>
          </div>
        </Container>
      </main>
      <Footer />
    </>
  );
}
