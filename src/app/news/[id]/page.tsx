import Link from "next/link";
import { notFound } from "next/navigation";
import { ChevronLeft, ExternalLink } from "lucide-react";

import { Container } from "@/components/layout/container";
import { Footer } from "@/components/layout/footer";
import { Navbar } from "@/components/layout/navbar";
import { NewsClassificationBadge } from "@/components/news/news-classification-badge";
import { getNewsItemById } from "@/lib/news";

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

  const date = new Date(item.published_at).toLocaleDateString("en-US", {
    month: "long",
    day: "numeric",
    year: "numeric",
  });

  const body = item.body_rephrased ?? item.body ?? "";
  const paragraphs = body
    .split(/\n{2,}/)
    .map((p) => p.trim())
    .filter(Boolean);

  return (
    <>
      <Navbar />
      <main className="flex-1">
        <Container size="sm" className="py-10 md:py-14">
          <Link
            href="/news"
            prefetch={false}
            className="inline-flex items-center gap-1.5 font-sans text-sm text-foreground-muted hover:text-primary"
          >
            <ChevronLeft className="h-4 w-4" aria-hidden /> All news
          </Link>

          <header className="mt-6">
            <div className="flex flex-wrap items-center gap-2 font-mono text-[11px] uppercase tracking-widest text-foreground-subtle">
              <NewsClassificationBadge classification={item.classification} />
              <span className="truncate text-foreground-muted">
                {item.source_name}
              </span>
              <span aria-hidden>·</span>
              <span className="shrink-0 tabular">{date}</span>
            </div>
            <h1 className="mt-4 font-display uppercase tracking-tight text-foreground text-h2">
              {item.title}
            </h1>
          </header>

          {paragraphs.length > 0 ? (
            <div className="mt-6 flex flex-col gap-4 font-sans text-base leading-relaxed text-foreground">
              {paragraphs.map((p, i) => (
                <p key={i}>{p}</p>
              ))}
            </div>
          ) : (
            <p className="mt-6 font-sans text-sm italic text-foreground-muted">
              No rephrased body yet — head to the source below.
            </p>
          )}

          {item.fighters.length > 0 ? (
            <div className="mt-6 flex flex-wrap gap-1.5">
              {item.fighters.map((f) => (
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
        </Container>
      </main>
      <Footer />
    </>
  );
}
