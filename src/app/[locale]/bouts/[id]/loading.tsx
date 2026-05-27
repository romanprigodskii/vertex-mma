import { Container } from "@/components/layout/container";
import { Footer } from "@/components/layout/footer";
import { Navbar } from "@/components/layout/navbar";

export default function BoutLoading() {
  return (
    <>
      <Navbar />
      <main className="flex-1">
        <div className="border-b border-foreground/[0.06]">
          <Container size="xl" className="py-3">
            <span className="inline-block h-4 w-24 rounded-sm bg-foreground/[0.06] animate-pulse" />
          </Container>
        </div>

        <Container size="xl">
          <section className="border-b border-foreground/10 py-8 md:py-10">
            <span className="block h-3 w-44 rounded-sm bg-foreground/[0.06] animate-pulse" />
            <span className="mt-4 block h-10 w-2/3 rounded-md bg-foreground/[0.07] animate-pulse md:h-12" />
            <span className="mt-3 block h-3 w-64 rounded-sm bg-foreground/[0.05] animate-pulse" />
            <div className="mt-8 grid grid-cols-1 gap-6 sm:grid-cols-[1fr_auto_1fr] sm:items-center">
              <span className="h-32 rounded-md bg-foreground/[0.05] animate-pulse" />
              <span className="block h-8 w-12 mx-auto rounded-sm bg-foreground/[0.06] animate-pulse" />
              <span className="h-32 rounded-md bg-foreground/[0.05] animate-pulse" />
            </div>
          </section>
        </Container>

        <section className="py-10 md:py-12">
          <Container size="xl">
            <span className="mb-4 block h-3 w-32 rounded-sm bg-foreground/[0.06] animate-pulse" />
            <div className="flex flex-col gap-5">
              {Array.from({ length: 3 }).map((_, i) => (
                <div
                  key={i}
                  className="h-72 rounded-md border border-foreground/10 bg-background-elevated/30 animate-pulse"
                />
              ))}
            </div>
          </Container>
        </section>
      </main>
      <Footer />
    </>
  );
}
