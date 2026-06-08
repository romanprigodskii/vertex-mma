import * as React from "react";
import { notFound } from "next/navigation";
import { getTranslations, setRequestLocale } from "next-intl/server";
import { ChevronLeft, ExternalLink } from "lucide-react";

import { Container } from "@/components/layout/container";
import { Footer } from "@/components/layout/footer";
import { Navbar } from "@/components/layout/navbar";
import { NewsClassificationBadge } from "@/components/news/news-classification-badge";
import { NewsComments } from "@/components/news/news-comments";
import {
  NewsNextEventCompact,
  NewsSidebar,
} from "@/components/news/news-sidebar";
import { NewsTimestamp } from "@/components/news/news-timestamp";
import { RelatedNews } from "@/components/news/related-news";
import { safeHttpUrl } from "@/components/news/safe-url";
import {
  SocialEmbed,
  SocialReactions,
  type SocialEmbedData,
} from "@/components/news/social-embed";
import { Link } from "@/i18n/navigation";
import {
  cachedMentionedEvents,
  getNextUpcomingEventForSidebar,
} from "@/lib/event-detail";
import {
  cachedMentionedFighters,
  getNewsItemById,
  listLatestNewsExcluding,
  listRelatedNews,
  type NewsFighter,
} from "@/lib/news";
import {
  autolinkParagraph,
  featuredEmbedParagraphIndex,
} from "@/lib/news-autolinker";
import type { NewsExternalRef } from "@/lib/db/schema/news";

function toEmbedData(ref: NewsExternalRef): SocialEmbedData {
  return {
    platform: ref.kind,
    url: ref.url,
    author: ref.author ?? null,
    handle: ref.handle ?? null,
    quote: ref.quote ?? null,
    posted_at: ref.posted_at ?? null,
    thumbnail_url: ref.thumbnail_url ?? null,
    duration: ref.duration ?? null,
  };
}

export const dynamic = "force-dynamic";

// A line inside a multi-line block that reads like a bout — an upcoming matchup
// ("A vs. B") or a result ("A def. B via …"). Fight cards and results lists are
// written one bout per line (single \n); rendered as a plain paragraph those
// newlines collapse into an unreadable run-on, so such blocks get their own
// one-line-per-bout list instead.
const BOUT_LINE = /\s(?:def\.|defeats|vs\.?)\s/i;

interface PageProps {
  params: Promise<{ id: string; locale: string }>;
}

export async function generateMetadata({ params }: PageProps) {
  const { id, locale } = await params;
  const t = await getTranslations({ locale, namespace: "news" });
  const item = await getNewsItemById(id);
  if (!item) return { title: t("articleNotFound") };
  return {
    title: item.title,
    description: t("metaDescriptionArticle", { source: item.source_name }),
    ...(item.image_url
      ? {
          openGraph: { images: [item.image_url] },
          twitter: { card: "summary_large_image", images: [item.image_url] },
        }
      : {}),
  };
}

export default async function NewsArticlePage({ params }: PageProps) {
  const { id, locale } = await params;
  setRequestLocale(locale);
  const t = await getTranslations("news");
  const item = await getNewsItemById(id);
  if (!item) notFound();

  const body = item.body_rephrased ?? item.body ?? "";
  const existingFighterIds = new Set(item.fighters.map((f) => f.id));
  const isRu = locale === "ru";

  const [
    nextEvent,
    latestNews,
    related,
    detectedFightersAll,
    mentionedEvents,
  ] = await Promise.all([
    getNextUpcomingEventForSidebar(),
    listLatestNewsExcluding(item.id, 5),
    listRelatedNews({
      excludeId: item.id,
      fighterIds: item.fighters.map((f) => f.id),
      classification: item.classification,
      limit: 4,
    }),
    cachedMentionedFighters(item.id, body, isRu),
    cachedMentionedEvents(item.id, body, isRu),
  ]);

  // The cached scan returns the full match set; drop the ingest-tagged
  // fighters here (they're prepended below) so the exclude Set never has to
  // be part of the cache key.
  const detectedFighters = detectedFightersAll.filter(
    (f) => !existingFighterIds.has(f.id),
  );

  // Merge ingest-tagged fighters with runtime-detected ones. Ingest-tagged
  // come first so they win the chip order; detected fighters fill in the
  // gaps when the Python pipeline missed a mention (very common — only the
  // first 1-2 names usually make it into related_fighter_ids).
  const allFighters: NewsFighter[] = [...item.fighters, ...detectedFighters];

  const paragraphs = body
    .split(/\n{2,}/)
    .map((p) => p.trim())
    .filter(Boolean);

  const wordCount = body.split(/\s+/).filter(Boolean).length;
  const readMinutes = Math.max(1, Math.round(wordCount / 220));

  const inlineRefs = item.external_refs.filter((r) => r.role === "inline");
  const featuredRefs = item.external_refs.filter((r) => r.role === "featured");
  const reactionRefs = item.external_refs.filter((r) => r.role === "reaction");

  // Map "after which paragraph" → featured refs that land there. Refs whose
  // anchor isn't found in any paragraph fall back to "after paragraph 0".
  const featuredByParagraph = new Map<number, NewsExternalRef[]>();
  for (const ref of featuredRefs) {
    const idx = featuredEmbedParagraphIndex(paragraphs, ref);
    const slot = idx >= 0 ? idx : 0;
    const list = featuredByParagraph.get(slot) ?? [];
    list.push(ref);
    featuredByParagraph.set(slot, list);
  }

  const heroImage = safeHttpUrl(item.image_url);
  const sourceHref = safeHttpUrl(item.url);

  return (
    <>
      <Navbar />
      <main className="flex-1">
        <Container size="lg" className="py-10 md:py-14">
          <Link
            href="/news"
            prefetch={false}
            className="inline-flex items-center gap-1.5 font-sans text-sm text-foreground-muted hover:text-primary"
          >
            <ChevronLeft className="h-4 w-4" aria-hidden /> {t("allNews")}
          </Link>

          {nextEvent ? <NewsNextEventCompact event={nextEvent} /> : null}

          <div className="mt-6 grid grid-cols-1 gap-x-12 gap-y-10 lg:grid-cols-[minmax(0,1fr)_320px]">
            <article className="min-w-0 max-w-[720px]">
              <header>
                <div className="flex flex-wrap items-center gap-2 font-mono text-[11px] uppercase tracking-widest text-foreground-muted">
                  <NewsClassificationBadge classification={item.classification} />
                  <span className="truncate text-foreground-muted">
                    {item.source_name}
                  </span>
                  <span aria-hidden>·</span>
                  <NewsTimestamp
                    iso={item.published_at}
                    variant="full"
                    className="shrink-0 tabular-nums"
                  />
                  {paragraphs.length > 0 ? (
                    <>
                      <span aria-hidden>·</span>
                      <span className="shrink-0">
                        {t("minRead", { n: readMinutes })}
                      </span>
                    </>
                  ) : null}
                </div>
                <h1 className="mt-4 font-display uppercase tracking-tight text-foreground text-h2 break-words">
                  {item.title}
                </h1>
              </header>

              {heroImage ? (
                <figure className="mt-6 overflow-hidden rounded-md border border-foreground/10 bg-background-elevated/30">
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img
                    src={heroImage}
                    alt={item.title}
                    loading="lazy"
                    referrerPolicy="no-referrer"
                    className="max-h-[440px] w-full object-cover"
                  />
                </figure>
              ) : null}

              {paragraphs.length > 0 ? (
                <div className="mt-6 flex flex-col gap-5 font-sans text-base leading-relaxed text-foreground">
                  {paragraphs.map((p, i) => {
                    const after = featuredByParagraph.get(i) ?? [];
                    const lines = p
                      .split("\n")
                      .map((l) => l.trim())
                      .filter(Boolean);
                    // A fight card / results list: multiple lines, at least one
                    // a bout. Render each bout on its own line in a distinct
                    // block so the matchups/results stand out instead of
                    // collapsing into a paragraph.
                    const isBoutList =
                      lines.length > 1 && lines.some((l) => BOUT_LINE.test(l));
                    return (
                      <React.Fragment key={i}>
                        {isBoutList ? (
                          <div className="overflow-hidden rounded-md border border-foreground/10 bg-foreground/[0.02] px-4 py-1.5">
                            {lines.map((line, li) =>
                              BOUT_LINE.test(line) ? (
                                <p
                                  key={li}
                                  className="border-b border-foreground/[0.06] py-2.5 font-sans text-[15px] leading-snug text-foreground last:border-0 sm:text-base"
                                >
                                  {autolinkParagraph(
                                    line,
                                    allFighters,
                                    mentionedEvents,
                                    inlineRefs,
                                  )}
                                </p>
                              ) : (
                                <p
                                  key={li}
                                  className="mb-1 mt-4 font-mono text-[11px] uppercase tracking-widest text-foreground-muted first:mt-2"
                                >
                                  {line}
                                </p>
                              ),
                            )}
                          </div>
                        ) : i === 0 ? (
                          <p
                            className={
                              // Drop-cap only when the paragraph opens with an
                              // actual letter — a digit, quote or emoji rendered
                              // at 3.8em in the primary color looks broken.
                              /^\p{L}/u.test(p)
                                ? "whitespace-pre-line text-lg leading-[1.65] text-foreground first-letter:float-left first-letter:mr-3 first-letter:font-display first-letter:text-[3.8em] first-letter:leading-[0.85] first-letter:text-primary"
                                : "whitespace-pre-line text-lg leading-[1.65] text-foreground"
                            }
                          >
                            {autolinkParagraph(
                              p,
                              allFighters,
                              mentionedEvents,
                              inlineRefs,
                            )}
                          </p>
                        ) : (
                          <p className="whitespace-pre-line">
                            {autolinkParagraph(
                              p,
                              allFighters,
                              mentionedEvents,
                              inlineRefs,
                            )}
                          </p>
                        )}
                        {after.map((ref) => (
                          <SocialEmbed key={ref.url} embed={toEmbedData(ref)} />
                        ))}
                      </React.Fragment>
                    );
                  })}
                </div>
              ) : (
                <p className="mt-6 font-sans text-sm italic text-foreground-muted">
                  {t("noBody")}
                </p>
              )}

              {allFighters.length > 0 ? (
                <div className="mt-7">
                  <p className="mb-2 font-mono text-[10px] uppercase tracking-[0.2em] text-foreground-muted">
                    {t("fightersMentioned")}
                  </p>
                  <div className="flex flex-wrap gap-1.5">
                    {allFighters.map((f) => (
                      <Link
                        key={f.id}
                        href={`/fighters/${f.slug}`}
                        prefetch={false}
                        className="rounded-sm border border-foreground/10 bg-foreground/[0.04] px-2.5 py-1 font-mono text-[10px] uppercase tracking-widest text-foreground-muted transition-colors hover:border-primary/40 hover:text-foreground"
                      >
                        {f.name}
                      </Link>
                    ))}
                  </div>
                </div>
              ) : null}

              {reactionRefs.length > 0 ? (
                <SocialReactions
                  embeds={reactionRefs.map((r) => toEmbedData(r))}
                />
              ) : null}

              {sourceHref ? (
                <div className="mt-8 border-t border-foreground/10 pt-6">
                  <a
                    href={sourceHref}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="inline-flex items-center gap-1.5 font-sans text-sm text-primary hover:underline"
                  >
                    {t("readOriginal", { source: item.source_name })}
                    <ExternalLink className="h-3.5 w-3.5" aria-hidden />
                  </a>
                </div>
              ) : null}

              <RelatedNews items={related} heading={t("moreNews")} />

              <NewsComments newsItemId={item.id} />
            </article>

            <NewsSidebar nextEvent={nextEvent} latestNews={latestNews} />
          </div>
        </Container>
      </main>
      <Footer />
    </>
  );
}
