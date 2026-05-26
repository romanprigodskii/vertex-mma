import Link from "next/link";

import { NewsClassificationBadge } from "@/components/news/news-classification-badge";
import type { NewsFeedItem } from "@/lib/news";

function formatShort(iso: string): string {
  return new Date(iso).toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
  });
}

export function RelatedNews({
  items,
  heading = "More like this",
}: {
  items: NewsFeedItem[];
  heading?: string;
}) {
  if (items.length === 0) return null;
  return (
    <section className="mt-14 border-t border-foreground/10 pt-8">
      <div className="mb-5 flex items-baseline justify-between">
        <h3 className="font-display text-2xl uppercase tracking-tight text-foreground">
          {heading}
        </h3>
        <Link
          href="/news"
          prefetch={false}
          className="font-mono text-[11px] uppercase tracking-[0.16em] text-foreground-muted hover:text-foreground"
        >
          All news →
        </Link>
      </div>
      <ul className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
        {items.map((item) => (
          <li key={item.id}>
            <Link
              href={`/news/${item.id}`}
              prefetch={false}
              className="block h-full rounded-md border border-foreground/10 bg-background-elevated/40 p-4 transition-colors hover:border-foreground/25 hover:bg-foreground/[0.04]"
            >
              <div className="flex flex-wrap items-center gap-2 font-mono text-[10px] uppercase tracking-[0.16em] text-foreground-subtle">
                <NewsClassificationBadge classification={item.classification} />
                <span className="tabular-nums">
                  {formatShort(item.published_at).toUpperCase()}
                </span>
              </div>
              <p className="mt-2 line-clamp-3 text-sm leading-snug text-foreground">
                {item.title}
              </p>
            </Link>
          </li>
        ))}
      </ul>
    </section>
  );
}
