import { Container } from "@/components/layout/container";
import { Footer } from "@/components/layout/footer";
import { Navbar } from "@/components/layout/navbar";

export default function ProfileLoading() {
  return (
    <>
      <Navbar />
      <main className="flex-1">
        <div className="border-b border-foreground/[0.06]">
          <Container size="xl" className="py-3">
            <div className="h-5 w-20 animate-pulse rounded bg-foreground/[0.05]" />
          </Container>
        </div>
        <Container size="lg" className="py-12 md:py-16">
          <div className="flex flex-col items-center gap-6 sm:flex-row sm:items-start">
            <div className="h-24 w-24 shrink-0 animate-pulse rounded-full bg-foreground/[0.05] sm:h-32 sm:w-32" />
            <div className="flex-1 space-y-3 text-center sm:text-left">
              <div className="mx-auto h-8 w-48 animate-pulse rounded bg-foreground/[0.05] sm:mx-0" />
              <div className="mx-auto h-4 w-32 animate-pulse rounded bg-foreground/[0.05] sm:mx-0" />
              <div className="mx-auto h-3 w-56 animate-pulse rounded bg-foreground/[0.05] sm:mx-0" />
            </div>
          </div>
          <dl className="mt-10 grid grid-cols-2 gap-4 sm:grid-cols-5">
            {Array.from({ length: 5 }).map((_, i) => (
              <div
                key={i}
                className="rounded-md border border-foreground/10 bg-background-elevated/30 px-4 py-3"
              >
                <div className="h-3 w-20 animate-pulse rounded bg-foreground/[0.05]" />
                <div className="mt-2 h-7 w-12 animate-pulse rounded bg-foreground/[0.05]" />
              </div>
            ))}
          </dl>
          <div className="mt-12">
            <div className="mb-4 h-3 w-32 animate-pulse rounded bg-foreground/[0.05]" />
            <div className="grid grid-cols-3 gap-3 sm:grid-cols-6">
              {Array.from({ length: 6 }).map((_, i) => (
                <div
                  key={i}
                  className="h-20 animate-pulse rounded bg-foreground/[0.05]"
                />
              ))}
            </div>
          </div>
        </Container>
      </main>
      <Footer />
    </>
  );
}
