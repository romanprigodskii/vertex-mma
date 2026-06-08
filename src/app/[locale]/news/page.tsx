import type { Metadata } from "next";
import { getTranslations, setRequestLocale } from "next-intl/server";

import { Container } from "@/components/layout/container";
import { Footer } from "@/components/layout/footer";
import { Navbar } from "@/components/layout/navbar";
import { NewsRow } from "@/components/news/news-row";
import { Link } from "@/i18n/navigation";
import {
  getNewsClassificationCounts,
  listNewsFeed,
  NEWS_CLASSIFICATION_LABELS,
} from "@/lib/news";
import { cn } from "@/lib/utils";

export const dynamic = "force-dynamic";

export async function generateMetadata({
  params,
}: {
  params: Promise<{ locale: string }>;
}): Promise<Metadata> {
  const { locale } = await params;
  const t = await getTranslations({ locale, namespace: "news" });
  return { title: t("metaTitle"), description: t("metaDescription") };
}

interface PageProps {
  params: Promise<{ locale: string }>;
  searchParams: Promise<{ classification?: string; page?: string }>;
}

function FilterChip({
  href,
  label,
  active,
}: {
  href: string;
  label: string;
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
      {label}
    </Link>
  );
}

export default async function NewsPage({ params, searchParams }: PageProps) {
  const { locale } = await params;
  setRequestLocale(locale);
  const t = await getTranslations("news");
  const { classification, page: pageParam } = await searchParams;
  // 'unrelated' is the classifier's "not about MMA" bucket — never a public
  // filter (it's also excluded from the feed query and the chip counts).
  const active =
    classification &&
    classification in NEWS_CLASSIFICATION_LABELS &&
    classification !== "unrelated"
      ? classification
      : null;
  const activeLabel = active
    ? t.has(`class_${active}`)
      ? t(`class_${active}`)
      : active
    : "";

  // Paginate so older articles stay reachable instead of falling off the
  // (capped) single-fetch list as the daily ingest grows the feed. We fetch one
  // extra row to detect a next page from the feed query itself — the chip counts
  // can't gate this (they exclude NULL-classification rows the feed still shows
  // via `IS DISTINCT FROM`), so a count-derived total would strand that tail.
  const PAGE_SIZE = 50;
  const requestedPage = Math.max(1, Number.parseInt(pageParam ?? "1", 10) || 1);

  const [feed, counts] = await Promise.all([
    listNewsFeed({
      classification: active ?? undefined,
      limit: PAGE_SIZE + 1,
      offset: (requestedPage - 1) * PAGE_SIZE,
    }),
    getNewsClassificationCounts(),
  ]);
  const hasNextPage = feed.length > PAGE_SIZE;
  const items = hasNextPage ? feed.slice(0, PAGE_SIZE) : feed;
  const total = counts.reduce((sum, c) => sum + c.count, 0);

  // Filter-preserving href for the pager (drop page=1 to keep page-one URLs clean).
  const pageHref = (p: number) => {
    const sp = new URLSearchParams();
    if (active) sp.set("classification", active);
    if (p > 1) sp.set("page", String(p));
    const qs = sp.toString();
    return qs ? `/news?${qs}` : "/news";
  };

  return (
    <>
      <Navbar />
      <main className="flex-1">
        <Container size="md" className="py-10 md:py-14">
          <header className="mb-6">
            <p className="font-mono text-[11px] uppercase tracking-[0.2em] text-foreground-subtle">
              {t("kicker")}
            </p>
            <h1 className="mt-2 font-display uppercase tracking-tight text-foreground text-h1">
              {t("heading")}
            </h1>
            <p className="mt-2 max-w-xl font-sans text-sm text-foreground-muted">
              {t("lead")}
            </p>
          </header>

          {total > 0 ? (
            <div className="mb-6 flex flex-wrap gap-2">
              <FilterChip href="/news" label={t("filterAll")} active={!active} />
              {counts.map((c) => {
                const labelKey = `class_${c.classification}`;
                const label = t.has(labelKey) ? t(labelKey) : c.classification;
                return (
                  <FilterChip
                    key={c.classification}
                    href={`/news?classification=${c.classification}`}
                    label={label}
                    active={active === c.classification}
                  />
                );
              })}
            </div>
          ) : null}

          {items.length === 0 ? (
            <div className="rounded-md border border-dashed border-foreground/15 bg-background-elevated/20 px-6 py-16 text-center">
              <p className="font-display text-xl uppercase tracking-tight text-foreground break-words sm:text-2xl">
                {active
                  ? t("emptyFilteredTitle", { category: activeLabel })
                  : t("emptyTitle")}
              </p>
              <p className="mx-auto mt-3 max-w-md font-sans text-sm text-foreground-muted">
                {active ? t("emptyFilteredLead") : t("emptyLead")}
              </p>
              {active ? (
                <Link
                  href="/news"
                  className="mt-4 inline-block font-mono text-xs uppercase tracking-[0.16em] text-primary hover:underline"
                >
                  {t("backToAllNews")}
                </Link>
              ) : null}
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

          {requestedPage > 1 || hasNextPage ? (
            <nav
              aria-label={t("pagerLabel")}
              className="mt-8 flex items-center justify-between gap-3 border-t border-foreground/10 pt-5"
            >
              {requestedPage > 1 ? (
                <Link
                  href={pageHref(requestedPage - 1)}
                  className="rounded-sm border border-foreground/15 px-3 py-1.5 font-mono text-xs uppercase tracking-[0.14em] text-foreground-muted transition-colors hover:bg-foreground/[0.05] hover:text-foreground"
                >
                  {t("pagerPrev")}
                </Link>
              ) : (
                <span />
              )}
              <span className="font-mono text-[11px] uppercase tracking-[0.16em] text-foreground-subtle">
                {t("pagerStatus", { page: requestedPage })}
              </span>
              {hasNextPage ? (
                <Link
                  href={pageHref(requestedPage + 1)}
                  className="rounded-sm border border-foreground/15 px-3 py-1.5 font-mono text-xs uppercase tracking-[0.14em] text-foreground-muted transition-colors hover:bg-foreground/[0.05] hover:text-foreground"
                >
                  {t("pagerNext")}
                </Link>
              ) : (
                <span />
              )}
            </nav>
          ) : null}
        </Container>
      </main>
      <Footer />
    </>
  );
}
