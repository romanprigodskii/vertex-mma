import Link from "next/link";
import { notFound } from "next/navigation";
import { ChevronLeft, Edit3 } from "lucide-react";

import { Container } from "@/components/layout/container";
import { Footer } from "@/components/layout/footer";
import { Navbar } from "@/components/layout/navbar";
import { RankingView } from "@/components/rankings/ranking-view";
import { getCurrentUser } from "@/lib/auth";
import { getRankingById } from "@/lib/rankings";

export const dynamic = "force-dynamic";

interface PageProps {
  params: Promise<{ id: string }>;
}

export async function generateMetadata({ params }: PageProps) {
  const { id } = await params;
  const r = await getRankingById(id);
  if (!r) return { title: "Ranking not found" };
  const desc = r.description
    ? `${r.description.slice(0, 140)}${r.description.length > 140 ? "…" : ""}`
    : `${r.entry_count} fighter${r.entry_count === 1 ? "" : "s"} ranked by @${r.author_username}.`;
  const ogImage = `/api/og/rankings/${r.id}`;
  return {
    title: `${r.title} · by @${r.author_username}`,
    description: desc,
    openGraph: {
      title: `${r.title} · @${r.author_username}`,
      description: desc,
      siteName: "Vertex MMA",
      type: "article",
      images: [
        {
          url: ogImage,
          width: 1200,
          height: 630,
          alt: `${r.title} — Vertex MMA ranking`,
        },
      ],
    },
    twitter: {
      card: "summary_large_image",
      images: [ogImage],
    },
  };
}

export default async function RankingViewPage({ params }: PageProps) {
  const { id } = await params;
  const [ranking, currentUser] = await Promise.all([
    getRankingById(id),
    getCurrentUser(),
  ]);
  if (!ranking) notFound();

  const isOwner = currentUser?.userProfileId === ranking.user_id;

  return (
    <>
      <Navbar />
      <main className="flex-1">
        <div className="border-b border-foreground/[0.06]">
          <Container
            size="xl"
            className="flex items-center justify-between py-3"
          >
            <Link
              href="/rankings"
              className="inline-flex items-center gap-1.5 font-sans text-sm text-foreground-muted hover:text-primary"
            >
              <ChevronLeft className="h-4 w-4" aria-hidden /> All rankings
            </Link>
            {isOwner ? (
              <Link
                href={`/rankings/${ranking.id}/edit`}
                className="inline-flex items-center gap-1.5 font-sans text-sm text-foreground-muted hover:text-primary"
              >
                <Edit3 className="h-4 w-4" aria-hidden /> Edit
              </Link>
            ) : null}
          </Container>
        </div>

        <RankingView ranking={ranking} />
      </main>
      <Footer />
    </>
  );
}
