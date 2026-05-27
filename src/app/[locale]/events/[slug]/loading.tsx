import { Container } from "@/components/layout/container";
import { Footer } from "@/components/layout/footer";
import { Navbar } from "@/components/layout/navbar";

export default function EventLoading() {
  return (
    <>
      <Navbar />
      <main className="flex-1">
        <div className="border-b border-foreground/[0.06]">
          <Container size="xl" className="py-3">
            <span className="inline-block h-4 w-16 rounded-sm bg-foreground/[0.06] animate-pulse" />
          </Container>
        </div>

        <section className="border-b border-foreground/10">
          <Container size="xl" className="py-10 md:py-12">
            <span className="block h-3 w-32 rounded-sm bg-foreground/[0.06] animate-pulse" />
            <span className="mt-3 block h-16 w-3/4 rounded-md bg-foreground/[0.07] animate-pulse md:h-20" />
            <span className="mt-4 block h-3 w-80 rounded-sm bg-foreground/[0.05] animate-pulse" />
          </Container>
        </section>

        <section className="py-10 md:py-14">
          <Container size="xl">
            <span className="mb-5 block h-3 w-24 rounded-sm bg-foreground/[0.06] animate-pulse" />
            <ul className="flex flex-col gap-3">
              {Array.from({ length: 8 }).map((_, i) => (
                <li
                  key={i}
                  className="h-24 rounded-md border border-foreground/10 bg-background-elevated/30 animate-pulse"
                />
              ))}
            </ul>
          </Container>
        </section>
      </main>
      <Footer />
    </>
  );
}
