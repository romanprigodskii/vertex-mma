import { Container } from "@/components/layout/container";
import { Footer } from "@/components/layout/footer";
import { Navbar } from "@/components/layout/navbar";

export default function RankingsLoading() {
  return (
    <>
      <Navbar />
      <main className="flex-1">
        <Container size="xl" className="py-10 md:py-14">
          <div className="mb-8">
            <div className="mb-2 h-4 w-24 animate-pulse rounded bg-foreground/[0.05]" />
            <div className="h-12 w-56 animate-pulse rounded bg-foreground/[0.05]" />
            <div className="mt-3 h-4 w-80 animate-pulse rounded bg-foreground/[0.05]" />
          </div>
          <ul className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
            {Array.from({ length: 6 }).map((_, i) => (
              <li
                key={i}
                className="rounded-md border border-foreground/10 bg-background-elevated/30 p-4"
              >
                <div className="h-5 w-48 animate-pulse rounded bg-foreground/[0.05]" />
                <div className="mt-2 h-3 w-32 animate-pulse rounded bg-foreground/[0.05]" />
                <div className="mt-4 flex gap-2">
                  {[0, 1, 2, 3].map((j) => (
                    <div
                      key={j}
                      className="h-10 w-10 animate-pulse rounded-sm bg-foreground/[0.05]"
                    />
                  ))}
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
