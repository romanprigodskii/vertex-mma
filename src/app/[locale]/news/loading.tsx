import { Container } from "@/components/layout/container";
import { Footer } from "@/components/layout/footer";
import { Navbar } from "@/components/layout/navbar";

/** Skeleton for the /news feed (force-dynamic, blocks on the feed fetch).
 *  Header + filter chips + a column of row placeholders so navigating to /news
 *  shows structure instead of hanging on the previous page. */
export default function NewsListLoading() {
  return (
    <>
      <Navbar />
      <main className="flex-1">
        <Container size="md" className="py-10 md:py-14">
          <div className="mb-6">
            <span className="block h-3 w-24 animate-pulse rounded-sm bg-foreground/[0.05]" />
            <span className="mt-2 block h-10 w-40 animate-pulse rounded-md bg-foreground/[0.07]" />
            <span className="mt-3 block h-4 w-80 max-w-full animate-pulse rounded-sm bg-foreground/[0.05]" />
          </div>

          <div className="mb-6 flex flex-wrap gap-2">
            {Array.from({ length: 6 }).map((_, i) => (
              <span
                key={i}
                className="block h-7 w-20 animate-pulse rounded-sm bg-foreground/[0.05]"
              />
            ))}
          </div>

          <ul className="flex flex-col gap-3">
            {Array.from({ length: 6 }).map((_, i) => (
              <li key={i}>
                <span className="block h-28 animate-pulse rounded-md border border-foreground/10 bg-background-elevated/30" />
              </li>
            ))}
          </ul>
        </Container>
      </main>
      <Footer />
    </>
  );
}
