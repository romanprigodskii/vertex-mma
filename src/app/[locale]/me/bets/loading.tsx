import { Container } from "@/components/layout/container";
import { Footer } from "@/components/layout/footer";
import { Navbar } from "@/components/layout/navbar";

export default function MyBetsLoading() {
  return (
    <>
      <Navbar />
      <main className="flex-1">
        <div className="border-b border-foreground/[0.06]">
          <Container size="xl" className="py-3">
            <div className="h-4 w-28 animate-pulse rounded bg-foreground/[0.05]" />
          </Container>
        </div>

        <Container size="lg" className="py-10 md:py-14">
          <div className="h-9 w-44 animate-pulse rounded bg-foreground/[0.05]" />
          <div className="mt-3 h-4 w-52 animate-pulse rounded bg-foreground/[0.05]" />

          <div className="mt-8 flex flex-col gap-10">
            {[0, 1].map((section) => (
              <div key={section}>
                <div className="mb-3 h-3 w-32 animate-pulse rounded bg-foreground/[0.05]" />
                <div className="flex flex-col gap-2">
                  {[0, 1, 2].map((row) => (
                    <div
                      key={row}
                      className="rounded-md border border-foreground/10 bg-background-elevated/30 p-3"
                    >
                      <div className="flex items-center justify-between gap-3">
                        <div className="min-w-0 flex-1">
                          <div className="h-4 w-40 animate-pulse rounded bg-foreground/[0.05]" />
                          <div className="mt-2 h-3 w-28 animate-pulse rounded bg-foreground/[0.05]" />
                        </div>
                        <div className="h-4 w-16 animate-pulse rounded bg-foreground/[0.05]" />
                      </div>
                    </div>
                  ))}
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
