import Link from "next/link";
import { ChevronRight } from "lucide-react";

import { NewsClassificationBadge } from "@/components/news/news-classification-badge";
import type { NewsFeedItem } from "@/lib/news";

export function NewsRow({ item }: { item: NewsFeedItem }) {
  const date = new Date(item.published_at).toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
  });

  return (
    <div className="rounded-md border border-foreground/10 bg-background-elevated/30 p-4 transition-colors hover:border-foreground/20 hover:bg-foreground/[0.04]">
      <div className="flex flex-wrap items-center gap-2 font-mono text-[11px] uppercase tracking-widest text-foreground-subtle">
        <NewsClassificationBadge classification={item.classification} />
        <span className="truncate text-foreground-muted">
          {item.source_name}
        </span>
        <span aria-hidden>·</span>
        <span className="shrink-0 tabular">{date}</span>
      </div>

      <Link
        href={`/news/${item.id}`}
        prefetch={false}
        className="mt-2 flex items-start gap-1.5 font-sans text-base font-medium text-foreground hover:text-primary"
      >
        <span>{item.title}</span>
        <ChevronRight
          className="mt-1 h-3.5 w-3.5 shrink-0 text-foreground-subtle"
          aria-hidden
        />
      </Link>

      {item.fighters.length > 0 ? (
        <div className="mt-2.5 flex flex-wrap gap-1.5">
          {item.fighters.map((f) => (
            <Link
              key={f.id}
              href={`/fighters/${f.slug}`}
              prefetch={false}
              className="rounded-sm border border-foreground/10 bg-foreground/[0.04] px-2 py-0.5 font-mono text-[10px] uppercase tracking-widest text-foreground-muted transition-colors hover:border-primary/40 hover:text-foreground"
            >
              {f.name}
            </Link>
          ))}
        </div>
      ) : null}
    </div>
  );
}
