import { ChevronRight } from "lucide-react";

import { NewsClassificationBadge } from "@/components/news/news-classification-badge";
import { NewsTimestamp } from "@/components/news/news-timestamp";
import { Link } from "@/i18n/navigation";
import type { NewsFeedItem } from "@/lib/news";

export function NewsRow({ item }: { item: NewsFeedItem }) {
  return (
    // `relative` anchors the stretched title link (after:inset-0) so the WHOLE
    // card navigates to the article — except the fighter chips, which sit above
    // it via z-10 and keep their own links.
    <div className="relative flex gap-4 rounded-md border border-foreground/10 bg-background-elevated/30 p-4 transition-colors hover:border-foreground/20 hover:bg-foreground/[0.04]">
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-2 font-mono text-[11px] uppercase tracking-widest text-foreground-subtle">
          <NewsClassificationBadge classification={item.classification} />
          <span className="truncate text-foreground-muted">
            {item.source_name}
          </span>
          <span aria-hidden>·</span>
          <NewsTimestamp
            iso={item.published_at}
            variant="short"
            className="shrink-0 tabular"
          />
        </div>

        <Link
          href={`/news/${item.id}`}
          prefetch={false}
          className="mt-2 flex items-start gap-1.5 font-sans text-base font-medium text-foreground after:absolute after:inset-0 after:z-[1] after:content-[''] hover:text-primary"
        >
          <span>{item.title}</span>
          <ChevronRight
            className="mt-1 h-3.5 w-3.5 shrink-0 text-foreground-subtle"
            aria-hidden
          />
        </Link>

        {item.snippet ? (
          <p className="mt-2 line-clamp-2 font-sans text-sm text-foreground-muted">
            {item.snippet}
          </p>
        ) : null}

        {item.fighters.length > 0 ? (
          <div className="relative z-10 mt-2.5 flex flex-wrap gap-1.5">
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

      {item.image_url ? (
        // eslint-disable-next-line @next/next/no-img-element
        <img
          src={item.image_url}
          alt=""
          loading="lazy"
          // Many outlets (e.g. Sherdog) 403 hotlinked images when a Referer is
          // sent but serve them fine with none — so suppress the referrer.
          referrerPolicy="no-referrer"
          className="h-16 w-24 shrink-0 self-center rounded-sm border border-foreground/10 object-cover sm:h-20 sm:w-32"
        />
      ) : null}
    </div>
  );
}
