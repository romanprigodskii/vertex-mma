import { notFound } from "next/navigation";
import { getTranslations, setRequestLocale } from "next-intl/server";
import { ChevronLeft, Edit3 } from "lucide-react";

import { Container } from "@/components/layout/container";
import { Footer } from "@/components/layout/footer";
import { Navbar } from "@/components/layout/navbar";
import { RankingView } from "@/components/rankings/ranking-view";
import { ShareButton } from "@/components/share/share-button";
import { Link, getPathname } from "@/i18n/navigation";
import { getCurrentUser } from "@/lib/auth";
import { getRankingById } from "@/lib/rankings";

export const dynamic = "force-dynamic";

interface PageProps {
  params: Promise<{ id: string; locale: string }>;
}

export async function generateMetadata({ params }: PageProps) {
  const { id, locale } = await params;
  const r = await getRankingById(id);
  // Fire the 404 here, not only in the page body. The page has a loading.tsx,
  // so its body renders inside a Suspense boundary that flushes a 200 shell
  // before the data fetch resolves — a notFound() in the body then can't change
  // the already-sent status. generateMetadata is awaited before the shell
  // streams, so this is the spot where a missing ranking can still emit a 404.
  if (!r) notFound();
  const t = await getTranslations({ locale, namespace: "rankings" });
  const desc = r.description
    ? `${r.description.slice(0, 140)}${r.description.length > 140 ? "…" : ""}`
    : t("metaRankedBy", { count: r.entry_count, username: r.author_username });
  const ogImage = `/api/og/rankings/${r.id}`;
  // Canonical + hreflang for the bilingual (en bare / ru-prefixed) URLs so
  // crawlers pair the two locale variants and consolidate the /en alias.
  // Resolved to absolute URLs against layout's metadataBase.
  // NOTE: this gap is site-wide (the rankings list and fighter pages also lack
  // alternates); fixed here for the ranking detail page only.
  const enPath = getPathname({ href: `/rankings/${r.id}`, locale: "en" });
  const ruPath = getPathname({ href: `/rankings/${r.id}`, locale: "ru" });
  return {
    title: `${r.title} · ${t("by")} @${r.author_username}`,
    description: desc,
    alternates: {
      canonical: locale === "ru" ? ruPath : enPath,
      languages: { en: enPath, ru: ruPath, "x-default": enPath },
    },
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
          alt: t("ogImageAlt", { title: r.title }),
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
  const { id, locale } = await params;
  setRequestLocale(locale);
  const t = await getTranslations("rankings");
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
            size="lg"
            className="flex items-center justify-between py-3"
          >
            <Link
              href="/rankings"
              className="inline-flex items-center gap-1.5 font-sans text-sm text-foreground-muted hover:text-primary"
            >
              <ChevronLeft className="h-4 w-4" aria-hidden /> {t("allRankings")}
            </Link>
            <div className="flex items-center gap-3">
              <ShareButton
                url={`/rankings/${ranking.id}`}
                ogImageUrl={`/api/og/rankings/${ranking.id}`}
                title={`${ranking.title} · ${t("by")} @${ranking.author_username}`}
                filename={`vertexmma-ranking-${ranking.id.slice(0, 8)}`}
                variant="icon"
              />
              {isOwner ? (
                <Link
                  href={`/rankings/${ranking.id}/edit`}
                  className="inline-flex items-center gap-1.5 font-sans text-sm text-foreground-muted hover:text-primary"
                >
                  <Edit3 className="h-4 w-4" aria-hidden /> {t("editLabel")}
                </Link>
              ) : null}
            </div>
          </Container>
        </div>

        <RankingView ranking={ranking} />
      </main>
      <Footer />
    </>
  );
}
