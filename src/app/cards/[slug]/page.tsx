import Link from "next/link";
import { notFound } from "next/navigation";
import { ChevronLeft, Edit3 } from "lucide-react";

import { FightCardActions } from "@/components/cards/fight-card-actions";
import {
  FightCardPoster,
  type PosterDisplayBout,
} from "@/components/cards/fight-card-poster";
import { Container } from "@/components/layout/container";
import { Footer } from "@/components/layout/footer";
import { Navbar } from "@/components/layout/navbar";
import { getCurrentUser } from "@/lib/auth";
import {
  getFightCardBySlug,
  hasUserLikedCard,
  incrementCardViewCount,
} from "@/lib/fight-cards";

export const dynamic = "force-dynamic";

interface PageProps {
  params: Promise<{ slug: string }>;
}

export async function generateMetadata({ params }: PageProps) {
  const { slug } = await params;
  const card = await getFightCardBySlug(slug);
  if (!card) return { title: "Fight card not found" };
  const desc = card.subtitle?.trim()
    ? card.subtitle
    : `A ${card.bouts.length}-bout fight card by @${card.author_username}.`;
  return {
    title: `${card.title} · by @${card.author_username}`,
    description: desc,
    openGraph: {
      title: `${card.title} · @${card.author_username}`,
      description: desc,
      siteName: "Vertex MMA",
      type: "article",
    },
  };
}

export default async function CardViewPage({ params }: PageProps) {
  const { slug } = await params;
  const [card, currentUser] = await Promise.all([
    getFightCardBySlug(slug),
    getCurrentUser(),
  ]);
  if (!card) notFound();

  const isOwner = currentUser?.userProfileId === card.user_id;
  if (!card.is_public && !isOwner) notFound();

  if (!isOwner) {
    // Best-effort — a view-count hiccup must never break the page.
    await incrementCardViewCount(card.id).catch(() => {});
  }
  const liked = currentUser
    ? await hasUserLikedCard(currentUser.userProfileId, card.id)
    : false;

  const posterBouts: PosterDisplayBout[] = card.bouts.map((b) => ({
    weightClass: b.weight_class,
    isMain: b.is_main,
    fighterA: b.fighter_a
      ? {
          slug: b.fighter_a.slug,
          name: b.fighter_a.name,
          photoUrl: b.fighter_a.photo_thumbnail_url,
          record: b.fighter_a.record,
        }
      : null,
    fighterB: b.fighter_b
      ? {
          slug: b.fighter_b.slug,
          name: b.fighter_b.name,
          photoUrl: b.fighter_b.photo_thumbnail_url,
          record: b.fighter_b.record,
        }
      : null,
  }));

  const dateLabel = new Date(card.created_at).toLocaleDateString("en-US", {
    month: "long",
    day: "numeric",
    year: "numeric",
  });

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
              href="/cards"
              className="inline-flex items-center gap-1.5 font-sans text-sm text-foreground-muted hover:text-primary"
            >
              <ChevronLeft className="h-4 w-4" aria-hidden /> All cards
            </Link>
            {isOwner ? (
              <Link
                href={`/cards/${card.slug}/edit`}
                className="inline-flex items-center gap-1.5 font-sans text-sm text-foreground-muted hover:text-primary"
              >
                <Edit3 className="h-4 w-4" aria-hidden /> Edit
              </Link>
            ) : null}
          </Container>
        </div>

        <Container size="md" className="py-10 md:py-14">
          <FightCardPoster
            title={card.title}
            subtitle={card.subtitle}
            themeColor={card.theme_color}
            titleFont={card.title_font}
            backgroundId={card.background_id}
            bouts={posterBouts}
          />

          <div className="mt-6 flex flex-wrap items-center justify-between gap-4">
            <p className="flex flex-wrap items-center gap-2 font-sans text-sm text-foreground-muted">
              {card.author_avatar_url ? (
                // eslint-disable-next-line @next/next/no-img-element
                <img
                  src={card.author_avatar_url}
                  alt={card.author_username}
                  className="h-6 w-6 rounded-full border border-foreground/15 object-cover"
                />
              ) : (
                <span className="flex h-6 w-6 items-center justify-center rounded-full bg-primary/15 font-display text-[10px] uppercase text-primary">
                  {card.author_username.slice(0, 2)}
                </span>
              )}
              <span>
                by{" "}
                <Link
                  href={`/profile/${card.author_username}`}
                  className="text-foreground hover:text-primary"
                >
                  @{card.author_username}
                </Link>{" "}
                · <span className="text-foreground-subtle">{dateLabel}</span> ·{" "}
                <span className="text-foreground-subtle">
                  {card.bouts.length} bout
                  {card.bouts.length === 1 ? "" : "s"}
                </span>{" "}
                ·{" "}
                <span className="text-foreground-subtle">
                  {card.view_count} view{card.view_count === 1 ? "" : "s"}
                </span>
              </span>
            </p>
            <FightCardActions
              cardId={card.id}
              slug={card.slug}
              initialLiked={liked}
              initialLikeCount={card.like_count}
              isSignedIn={Boolean(currentUser)}
            />
          </div>
        </Container>
      </main>
      <Footer />
    </>
  );
}
