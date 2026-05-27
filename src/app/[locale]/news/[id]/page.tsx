import * as React from "react";
import Link from "next/link";
import { notFound } from "next/navigation";
import { ChevronLeft, ExternalLink } from "lucide-react";

import { Container } from "@/components/layout/container";
import { Footer } from "@/components/layout/footer";
import { Navbar } from "@/components/layout/navbar";
import { NewsClassificationBadge } from "@/components/news/news-classification-badge";
import { NewsComments } from "@/components/news/news-comments";
import { NewsSidebar } from "@/components/news/news-sidebar";
import { RelatedNews } from "@/components/news/related-news";
import {
  SocialEmbed,
  SocialReactions,
  type SocialEmbedData,
} from "@/components/news/social-embed";
import {
  detectMentionedEvents,
  getNextUpcomingEventForSidebar,
} from "@/lib/event-detail";
import {
  detectMentionedFighters,
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

interface PageProps {
  params: Promise<{ id: string }>;
}

export async function generateMetadata({ params }: PageProps) {
  const { id } = await params;
  const item = await getNewsItemById(id);
  if (!item) return { title: "News article not found" };
  return {
    title: item.title,
    description: `${item.source_name} · MMA news on Vertex MMA`,
  };
}

export default async function NewsArticlePage({ params }: PageProps) {
  const { id } = await params;
  const item = await getNewsItemById(id);
  if (!item) notFound();

  const body = item.body_rephrased ?? item.body ?? "";
  const existingFighterIds = new Set(item.fighters.map((f) => f.id));

  const [
    nextEvent,
    latestNews,
    related,
    detectedFighters,
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
    detectMentionedFighters(body, existingFighterIds),
    detectMentionedEvents(body),
  ]);

  // Merge ingest-tagged fighters with runtime-detected ones. Ingest-tagged
  // come first so they win the chip order; detected fighters fill in the
  // gaps when the Python pipeline missed a mention (very common — only the
  // first 1-2 names usually make it into related_fighter_ids).
  const allFighters: NewsFighter[] = [...item.fighters, ...detectedFighters];

  const date = new Date(item.published_at).toLocaleDateString("en-US", {
    month: "long",
    day: "numeric",
    year: "numeric",
  });

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
            <ChevronLeft className="h-4 w-4" aria-hidden /> All news
          </Link>

          <div className="mt-6 grid grid-cols-1 gap-x-12 gap-y-10 lg:grid-cols-[minmax(0,1fr)_320px]">
            <article className="min-w-0 max-w-[720px]">
              <header>
                <div className="flex flex-wrap items-center gap-2 font-mono text-[11px] uppercase tracking-widest text-foreground-subtle">
                  <NewsClassificationBadge classification={item.classification} />
                  <span className="truncate text-foreground-muted">
                    {item.source_name}
                  </span>
                  <span aria-hidden>·</span>
                  <span className="shrink-0 tabular-nums">{date}</span>
                  {paragraphs.length > 0 ? (
                    <>
                      <span aria-hidden>·</span>
                      <span className="shrink-0">{readMinutes} min read</span>
                    </>
                  ) : null}
                </div>
                <h1 className="mt-4 font-display uppercase tracking-tight text-foreground text-h2">
                  {item.title}
                </h1>
              </header>

              {paragraphs.length > 0 ? (
                <div className="mt-6 flex flex-col gap-5 font-sans text-base leading-relaxed text-foreground">
                  {paragraphs.map((p, i) => {
                    const nodes = autolinkParagraph(
                      p,
                      allFighters,
                      mentionedEvents,
                      inlineRefs,
                    );
                    const after = featuredByParagraph.get(i) ?? [];
                    return (
                      <React.Fragment key={i}>
                        {i === 0 ? (
                          <p className="text-lg leading-[1.65] text-foreground first-letter:float-left first-letter:mr-3 first-letter:font-display first-letter:text-[3.8em] first-letter:leading-[0.85] first-letter:text-primary">
                            {nodes}
                          </p>
                        ) : (
                          <p>{nodes}</p>
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
                  No rephrased body yet — head to the source below.
                </p>
              )}

              {allFighters.length > 0 ? (
                <div className="mt-7">
                  <p className="mb-2 font-mono text-[10px] uppercase tracking-[0.2em] text-foreground-subtle">
                    Fighters mentioned
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

              <div className="mt-8 border-t border-foreground/10 pt-6">
                <a
                  href={item.url}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="inline-flex items-center gap-1.5 font-sans text-sm text-primary hover:underline"
                >
                  Read the original at {item.source_name}
                  <ExternalLink className="h-3.5 w-3.5" aria-hidden />
                </a>
              </div>

              <RelatedNews items={related} heading="More news" />

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
