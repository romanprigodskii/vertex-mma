import { Container } from "@/components/layout/container";
import { Footer } from "@/components/layout/footer";
import { Navbar } from "@/components/layout/navbar";

/** News-article-specific skeleton. The generic DetailLoading renders a bordered
 *  breadcrumb bar + a 2x2 box grid, which doesn't match this route (an inline
 *  back link + a prose column + a 320px sidebar) and causes a layout shift on
 *  swap-in. This mirrors the real article structure instead. */
export default function NewsArticleLoading() {
  return (
    <>
      <Navbar />
      <main className="flex-1">
        <Container size="lg" className="py-10 md:py-14">
          <span className="inline-block h-4 w-24 animate-pulse rounded-sm bg-foreground/[0.06]" />

          <div className="mt-6 grid grid-cols-1 gap-x-12 gap-y-10 lg:grid-cols-[minmax(0,1fr)_320px]">
            <div className="min-w-0 max-w-[720px]">
              <span className="block h-3 w-48 animate-pulse rounded-sm bg-foreground/[0.05]" />
              <span className="mt-4 block h-9 w-full animate-pulse rounded-md bg-foreground/[0.07]" />
              <span className="mt-2 block h-9 w-2/3 animate-pulse rounded-md bg-foreground/[0.07]" />
              <span className="mt-6 block aspect-[16/9] w-full animate-pulse rounded-md bg-foreground/[0.05]" />
              <div className="mt-6 flex flex-col gap-3">
                <span className="block h-4 w-full animate-pulse rounded-sm bg-foreground/[0.05]" />
                <span className="block h-4 w-11/12 animate-pulse rounded-sm bg-foreground/[0.05]" />
                <span className="block h-4 w-full animate-pulse rounded-sm bg-foreground/[0.05]" />
                <span className="block h-4 w-10/12 animate-pulse rounded-sm bg-foreground/[0.05]" />
                <span className="block h-4 w-9/12 animate-pulse rounded-sm bg-foreground/[0.05]" />
                <span className="block h-4 w-2/3 animate-pulse rounded-sm bg-foreground/[0.05]" />
              </div>
            </div>

            <div className="flex flex-col gap-4">
              <span className="block h-44 animate-pulse rounded-md border border-foreground/10 bg-background-elevated/30" />
              <span className="block h-56 animate-pulse rounded-md border border-foreground/10 bg-background-elevated/30" />
              <span className="block h-12 animate-pulse rounded-md border border-foreground/10 bg-background-elevated/30" />
            </div>
          </div>
        </Container>
      </main>
      <Footer />
    </>
  );
}
