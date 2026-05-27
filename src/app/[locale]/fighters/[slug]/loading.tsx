import { Container } from "@/components/layout/container";
import { Footer } from "@/components/layout/footer";
import { Navbar } from "@/components/layout/navbar";

export default function FighterDetailLoading() {
  return (
    <>
      <Navbar />
      <main className="flex-1">
        <div className="border-b border-foreground/[0.06]">
          <Container size="xl" className="py-3">
            <span className="inline-block h-4 w-28 rounded-sm bg-foreground/[0.06] animate-pulse" />
          </Container>
        </div>

        {/* Hero skeleton */}
        <section className="border-b border-foreground/10">
          <div className="mx-auto flex max-w-[1440px] flex-col gap-6 px-4 py-8 sm:px-6 md:py-10 lg:flex-row lg:gap-10 lg:px-8 lg:py-12">
            <div className="aspect-[3/4] w-full shrink-0 rounded-md border border-foreground/10 bg-foreground/[0.05] animate-pulse lg:h-[480px] lg:w-[360px] lg:aspect-auto" />
            <div className="flex min-w-0 flex-1 flex-col gap-6">
              <span className="h-16 w-3/4 rounded-md bg-foreground/[0.07] animate-pulse md:h-24" />
              <span className="h-5 w-40 rounded-sm bg-foreground/[0.05] animate-pulse" />
              <span className="h-3 w-72 rounded-sm bg-foreground/[0.05] animate-pulse" />
              <span className="mt-6 h-20 w-72 rounded-md bg-foreground/[0.07] animate-pulse" />
            </div>
          </div>
        </section>

        {/* Key stats skeleton */}
        <section className="py-10 md:py-14">
          <Container size="xl">
            <span className="mb-5 block h-3 w-24 rounded-sm bg-foreground/[0.06] animate-pulse" />
            <div className="grid grid-cols-1 gap-10 lg:grid-cols-2 lg:gap-16">
              <div className="aspect-square w-full max-w-[360px] rounded-full bg-foreground/[0.04] animate-pulse" />
              <div className="flex flex-col gap-3">
                {Array.from({ length: 6 }).map((_, i) => (
                  <div
                    key={i}
                    className="h-8 w-full rounded-sm bg-foreground/[0.04] animate-pulse"
                  />
                ))}
              </div>
            </div>
          </Container>
        </section>

        {/* Lower sections skeleton */}
        <section className="mt-16 sm:mt-20">
          <Container size="xl">
            <span className="mb-5 block h-3 w-44 rounded-sm bg-foreground/[0.06] animate-pulse" />
            <div className="h-40 w-full rounded-md bg-foreground/[0.04] animate-pulse" />
          </Container>
        </section>
      </main>
      <Footer />
    </>
  );
}
