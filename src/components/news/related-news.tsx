import { getTranslations } from "next-intl/server";

import { NewsClassificationBadge } from "@/components/news/news-classification-badge";
import { NewsTimestamp } from "@/components/news/news-timestamp";
import { Link } from "@/i18n/navigation";
import type { NewsFeedItem } from "@/lib/news";

export async function RelatedNews({
  items,
  heading,
}: {
  items: NewsFeedItem[];
  heading?: string;
}) {
  if (items.length === 0) return null;
  const t = await getTranslations("news");
  const headingLabel = heading ?? t("moreLikeThis");
  return (
    <section className="mt-14 border-t border-foreground/10 pt-8">
      <div className="mb-5 flex items-baseline justify-between">
        <h3 className="font-display text-xl uppercase tracking-tight text-foreground break-words sm:text-2xl">
          {headingLabel}
        </h3>
        <Link
          href="/news"
          prefetch={false}
          className="font-mono text-[11px] uppercase tracking-[0.16em] text-foreground-muted hover:text-foreground"
        >
          {t("allNews")} →
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
                <NewsTimestamp
                  iso={item.published_at}
                  variant="compact"
                  className="tabular-nums"
                />
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
