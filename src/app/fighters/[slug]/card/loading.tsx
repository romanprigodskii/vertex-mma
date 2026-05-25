import { Container } from "@/components/layout/container";
import { Footer } from "@/components/layout/footer";
import { Navbar } from "@/components/layout/navbar";

export default function FighterCardLoading() {
  return (
    <>
      <Navbar />
      <main className="flex-1">
        <div className="border-b border-foreground/[0.06]">
          <Container size="xl" className="py-3">
            <span className="inline-block h-4 w-32 rounded-sm bg-foreground/[0.06] animate-pulse" />
          </Container>
        </div>

        <section className="py-10 md:py-16">
          <Container
            size="xl"
            className="flex flex-col items-center gap-6 md:gap-8"
          >
            <span className="h-3 w-48 rounded-sm bg-foreground/[0.05] animate-pulse" />
            <div className="aspect-[3/4] w-[300px] rounded-xl border border-foreground/15 bg-background-elevated/40 animate-pulse sm:w-[360px]" />
            <span className="h-3 w-72 rounded-sm bg-foreground/[0.04] animate-pulse" />
          </Container>
        </section>
      </main>
      <Footer />
    </>
  );
}
