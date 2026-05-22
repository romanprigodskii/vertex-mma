import Link from "next/link";

import { Container } from "@/components/layout/container";
import { Footer } from "@/components/layout/footer";
import { Navbar } from "@/components/layout/navbar";
import { NewsRow } from "@/components/news/news-row";
import {
  formatNewsClassification,
  getNewsClassificationCounts,
  listNewsFeed,
  NEWS_CLASSIFICATION_LABELS,
} from "@/lib/news";
import { cn } from "@/lib/utils";

export const dynamic = "force-dynamic";

export const metadata = {
  title: "News",
  description: "Latest MMA news, auto-classified and linked to fighters.",
};

interface PageProps {
  searchParams: Promise<{ classification?: string }>;
}

function FilterChip({
  href,
  label,
  count,
  active,
}: {
  href: string;
  label: string;
  count: number;
  active: boolean;
}) {
  return (
    <Link
      href={href}
      className={cn(
        "rounded-sm border px-3 py-1.5 font-sans text-xs transition-colors",
        active
          ? "border-primary bg-primary/10 text-foreground"
          : "border-foreground/15 text-foreground-muted hover:bg-foreground/[0.05] hover:text-foreground",
      )}
    >
      {label}{" "}
      <span className="tabular text-foreground-subtle">{count}</span>
    </Link>
  );
}

export default async function NewsPage({ searchParams }: PageProps) {
  const { classification } = await searchParams;
  const active =
    classification && classification in NEWS_CLASSIFICATION_LABELS
      ? classification
      : null;

  const [items, counts] = await Promise.all([
    listNewsFeed({ classification: active ?? undefined, limit: 80 }),
    getNewsClassificationCounts(),
  ]);
  const total = counts.reduce((sum, c) => sum + c.count, 0);

  return (
    <>
      <Navbar />
      <main className="flex-1">
        <Container size="md" className="py-10 md:py-14">
          <header className="mb-6">
            <p className="font-mono text-[11px] uppercase tracking-[0.2em] text-foreground-subtle">
              MMA wire
            </p>
            <h1 className="mt-2 font-display uppercase tracking-tight text-foreground text-h1">
              News
            </h1>
            <p className="mt-2 max-w-xl font-sans text-sm text-foreground-muted">
              Headlines from across MMA, auto-classified and linked to the
              fighters they mention.
            </p>
          </header>

          {total > 0 ? (
            <div className="mb-6 flex flex-wrap gap-2">
              <FilterChip
                href="/news"
                label="All"
                count={total}
                active={!active}
              />
              {counts.map((c) => (
                <FilterChip
                  key={c.classification}
                  href={`/news?classification=${c.classification}`}
                  label={formatNewsClassification(c.classification)}
                  count={c.count}
                  active={active === c.classification}
                />
              ))}
            </div>
          ) : null}

          {items.length === 0 ? (
            <div className="rounded-md border border-dashed border-foreground/15 bg-background-elevated/20 px-6 py-16 text-center">
              <p className="font-display text-2xl uppercase tracking-tight text-foreground">
                No news yet
              </p>
              <p className="mx-auto mt-3 max-w-md font-sans text-sm text-foreground-muted">
                The wire is quiet. Check back once the next ingest runs.
              </p>
            </div>
          ) : (
            <ul className="flex flex-col gap-3">
              {items.map((item) => (
                <li key={item.id}>
                  <NewsRow item={item} />
                </li>
              ))}
            </ul>
          )}
        </Container>
      </main>
      <Footer />
    </>
  );
}
