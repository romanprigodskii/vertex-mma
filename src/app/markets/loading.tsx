import { Container } from "@/components/layout/container";
import { Footer } from "@/components/layout/footer";
import { Navbar } from "@/components/layout/navbar";

export default function MarketsLoading() {
  return (
    <>
      <Navbar />
      <main className="flex-1">
        <Container size="xl" className="py-10 md:py-14">
          <div className="mb-8">
            <div className="mb-2 h-4 w-24 animate-pulse rounded bg-foreground/[0.05]" />
            <div className="h-12 w-64 animate-pulse rounded bg-foreground/[0.05]" />
            <div className="mt-3 h-4 w-80 animate-pulse rounded bg-foreground/[0.05]" />
          </div>
          <div className="flex flex-col gap-3">
            {[0, 1, 2, 3].map((i) => (
              <div
                key={i}
                className="rounded-md border border-foreground/10 bg-background-elevated/30 px-4 py-3"
              >
                <div className="flex items-center justify-between gap-3">
                  <div className="h-5 w-48 animate-pulse rounded bg-foreground/[0.05]" />
                  <div className="h-4 w-32 animate-pulse rounded bg-foreground/[0.05]" />
                </div>
              </div>
            ))}
          </div>
        </Container>
      </main>
      <Footer />
    </>
  );
}
