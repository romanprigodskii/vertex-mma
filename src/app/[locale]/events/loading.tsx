import { Container } from "@/components/layout/container";
import { Footer } from "@/components/layout/footer";
import { Navbar } from "@/components/layout/navbar";

export default function EventsLoading() {
  return (
    <>
      <Navbar />
      <main className="flex-1">
        <Container size="xl" className="py-10 md:py-14">
          <header className="mb-8">
            <span className="block h-3 w-10 rounded-sm bg-foreground/[0.06] animate-pulse" />
            <span className="mt-3 block h-12 w-56 rounded-md bg-foreground/[0.07] animate-pulse md:h-16" />
            <span className="mt-3 block h-3 w-80 max-w-full rounded-sm bg-foreground/[0.05] animate-pulse" />
          </header>

          <div className="mb-6 flex gap-1 border-b border-foreground/10">
            {Array.from({ length: 3 }).map((_, i) => (
              <span
                key={i}
                className="my-1 h-6 w-20 rounded-sm bg-foreground/[0.06] animate-pulse"
              />
            ))}
          </div>

          <ul className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
            {Array.from({ length: 9 }).map((_, i) => (
              <li
                key={i}
                className="rounded-md border border-foreground/10 bg-background-elevated/30 p-4"
              >
                <span className="block h-2.5 w-28 rounded-sm bg-foreground/[0.06] animate-pulse" />
                <span className="mt-3 block h-5 w-3/4 rounded-sm bg-foreground/[0.07] animate-pulse" />
                <span className="mt-2 block h-3 w-1/2 rounded-sm bg-foreground/[0.05] animate-pulse" />
                <span className="mt-3 block h-2.5 w-16 rounded-sm bg-foreground/[0.05] animate-pulse" />
              </li>
            ))}
          </ul>
        </Container>
      </main>
      <Footer />
    </>
  );
}
