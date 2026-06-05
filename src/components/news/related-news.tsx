import { getTranslations } from "next-intl/server";

import { NewsClassificationBadge } from "@/components/news/news-classification-badge";
import { NewsTimestamp } from "@/components/news/news-timestamp";
import { safeHttpUrl } from "@/components/news/safe-url";
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
      <ul className="grid grid-cols-1 gap-4 sm:grid-cols-2">
        {items.map((item) => {
          const imageUrl = safeHttpUrl(item.image_url);
          return (
            <li key={item.id}>
              <Link
                href={`/news/${item.id}`}
                prefetch={false}
                className="flex h-full flex-col overflow-hidden rounded-md border border-foreground/10 bg-background-elevated/40 transition-colors hover:border-foreground/25 hover:bg-foreground/[0.04]"
              >
                {imageUrl ? (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img
                    src={imageUrl}
                    alt=""
                    loading="lazy"
                    referrerPolicy="no-referrer"
                    className="aspect-[16/9] w-full object-cover"
                  />
                ) : null}
                <div className="flex flex-1 flex-col p-4">
                  <div className="flex flex-wrap items-center gap-2 font-mono text-[10px] uppercase tracking-[0.16em] text-foreground-muted">
                    <NewsClassificationBadge classification={item.classification} />
                    <NewsTimestamp
                      iso={item.published_at}
                      variant="compact"
                      relative
                      className="tabular-nums"
                    />
                  </div>
                  <p className="mt-2 line-clamp-3 text-sm leading-snug text-foreground">
                    {item.title}
                  </p>
                </div>
              </Link>
            </li>
          );
        })}
      </ul>
    </section>
  );
}
