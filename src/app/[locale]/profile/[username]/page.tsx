import { notFound } from "next/navigation";
import {
  getLocale,
  getTranslations,
  setRequestLocale,
} from "next-intl/server";
import { ChevronLeft } from "lucide-react";

import { AchievementsGrid } from "@/components/achievements/achievements-grid";
import { Container } from "@/components/layout/container";
import { Footer } from "@/components/layout/footer";
import { Navbar } from "@/components/layout/navbar";
import { FightCardGridCard } from "@/components/cards/fight-card-grid-card";
import { DailyBonusButton } from "@/components/me/daily-bonus-button";
import { TierProgress } from "@/components/profile/tier-progress";
import { RankingCard } from "@/components/rankings/ranking-card";
import { ShareButton } from "@/components/share/share-button";
import { Link } from "@/i18n/navigation";
import {
  listAchievements,
  listUserAchievements,
} from "@/lib/achievements";
import { getCurrentUser, getUserProfileByUsername } from "@/lib/auth";
import { formatNumber } from "@/lib/format";
import { listCardsByUser } from "@/lib/fight-cards";
import { listRankingsByUser } from "@/lib/rankings";
import { isTier } from "@/lib/tier";

export const dynamic = "force-dynamic";

interface PageProps {
  params: Promise<{ username: string; locale: string }>;
}

export async function generateMetadata({ params }: PageProps) {
  const { username, locale } = await params;
  const t = await getTranslations({ locale, namespace: "profile" });
  const profile = await getUserProfileByUsername(username);
  if (!profile) return { title: t("notFound") };
  const name = profile.displayName || profile.username;
  const desc = t("metaDescription", { name, tier: profile.tier });
  const ogImage = `/api/og/profile/${profile.username}`;
  return {
    title: t("metaTitle", { username: profile.username }),
    description: desc,
    openGraph: {
      title: t("ogTitle", { username: profile.username }),
      description: desc,
      siteName: "Vertex MMA",
      type: "profile",
      images: [
        {
          url: ogImage,
          width: 1200,
          height: 630,
          alt: t("ogAlt", { username: profile.username }),
        },
      ],
    },
    twitter: { card: "summary_large_image", images: [ogImage] },
  };
}

export default async function PublicProfilePage({ params }: PageProps) {
  const { username, locale } = await params;
  setRequestLocale(locale);
  const t = await getTranslations("profile");
  const activeLocale = await getLocale();
  const [profile, currentUser] = await Promise.all([
    getUserProfileByUsername(username),
    getCurrentUser(),
  ]);
  if (!profile) notFound();

  const isOwner = currentUser?.username === profile.username;
  const [rankings, cards, userAchievements, allAchievements] =
    await Promise.all([
      listRankingsByUser(profile.userProfileId),
      listCardsByUser(profile.userProfileId),
      listUserAchievements(profile.userProfileId),
      isOwner ? listAchievements() : Promise.resolve(undefined),
    ]);
  // Non-owners only see public cards; the owner sees their drafts too.
  const visibleCards = isOwner ? cards : cards.filter((c) => c.is_public);
  const joined = new Date(profile.joinedAt);
  const joinedLabel = joined.toLocaleDateString(
    activeLocale === "ru" ? "ru-RU" : "en-US",
    { year: "numeric", month: "long" },
  );

  return (
    <>
      <Navbar />
      <main className="flex-1">
        <div className="border-b border-foreground/[0.06]">
          <Container size="xl" className="py-3">
            <Link
              href="/"
              className="inline-flex items-center gap-1.5 font-sans text-sm text-foreground-muted hover:text-primary"
            >
              <ChevronLeft className="h-4 w-4" aria-hidden /> {t("home")}
            </Link>
          </Container>
        </div>

        <Container size="lg" className="py-12 md:py-16">
          <div className="flex flex-col items-center gap-6 sm:flex-row sm:items-start">
            <div className="shrink-0">
              {profile.avatarUrl ? (
                // eslint-disable-next-line @next/next/no-img-element
                <img
                  src={profile.avatarUrl}
                  alt={profile.username}
                  className="h-24 w-24 rounded-full border border-foreground/15 object-cover sm:h-32 sm:w-32"
                />
              ) : (
                <div className="flex h-24 w-24 items-center justify-center rounded-full bg-primary/15 font-display text-2xl uppercase text-primary sm:h-32 sm:w-32 sm:text-3xl">
                  {profile.username.slice(0, 2)}
                </div>
              )}
            </div>

            <div className="flex-1 text-center sm:text-left">
              <h1 className="font-display uppercase tracking-tight text-foreground text-h1">
                {profile.displayName || profile.username}
              </h1>
              <p className="mt-1 font-mono text-sm text-foreground-muted">
                @{profile.username}
              </p>
              <p className="mt-3 font-sans text-[11px] uppercase tracking-widest text-foreground-subtle">
                {profile.tier.toUpperCase()} · {t("joined", { date: joinedLabel })}
                {profile.countryCode ? ` · ${profile.countryCode}` : ""}
              </p>
              {isOwner && isTier(profile.tier) ? (
                <TierProgress
                  currentTier={profile.tier}
                  totalEarned={profile.totalCoinsEarned}
                  isOwner={isOwner}
                />
              ) : null}
              {profile.bio ? (
                <p className="mt-4 max-w-xl font-sans text-sm text-foreground-muted whitespace-pre-line">
                  {profile.bio}
                </p>
              ) : null}
              <div className="mt-5 flex flex-wrap items-center gap-3 sm:justify-start justify-center">
                {isOwner ? (
                  <>
                    <Link
                      href="/settings"
                      className="inline-flex rounded-sm border border-foreground/15 px-4 py-2 font-sans text-sm text-foreground-muted hover:bg-foreground/[0.05] hover:text-foreground"
                    >
                      {t("editProfile")}
                    </Link>
                    <Link
                      href="/me/transactions"
                      className="inline-flex rounded-sm border border-foreground/15 px-4 py-2 font-sans text-sm text-foreground-muted hover:bg-foreground/[0.05] hover:text-foreground"
                    >
                      {t("coinActivity")}
                    </Link>
                  </>
                ) : null}
                <ShareButton
                  url={`/profile/${profile.username}`}
                  ogImageUrl={`/api/og/profile/${profile.username}`}
                  title={t("ogTitle", { username: profile.username })}
                  filename={`vertexmma-profile-${profile.username}`}
                  label={t("shareProfile")}
                />
              </div>
            </div>
          </div>

          <dl className="mt-10 grid grid-cols-2 gap-4 sm:grid-cols-3">
            <Stat label={t("bets")} value={profile.betCount} />
            <Stat label={t("currentStreak")} value={profile.currentStreak} />
            <Stat label={t("bestStreak")} value={profile.bestStreak} />
          </dl>

          {isOwner ? (
            <section className="mt-10">
              <h2 className="mb-4 font-sans text-[11px] font-medium uppercase tracking-widest text-foreground-muted">
                {t("dailyBonus")}
              </h2>
              <DailyBonusButton
                lastDailyBonusAt={profile.lastDailyBonusAt}
                tier={profile.tier}
              />
            </section>
          ) : null}

          <section className="mt-10">
            <h2 className="mb-4 font-sans text-[11px] font-medium uppercase tracking-widest text-foreground-muted">
              {t("achievements")} · {userAchievements.length}
              {isOwner && allAchievements ? `/${allAchievements.length}` : ""}
            </h2>
            <AchievementsGrid
              unlocked={userAchievements}
              allAchievements={allAchievements}
            />
          </section>

          <section className="mt-12">
            <h2 className="mb-5 font-sans text-[11px] font-medium uppercase tracking-widest text-foreground-muted">
              {t("rankingsBy", { username: profile.username })}
            </h2>
            {rankings.length > 0 ? (
              <ul className="grid grid-cols-1 gap-4 sm:grid-cols-2">
                {rankings.map((r) => (
                  <li key={r.id}>
                    <RankingCard ranking={r} />
                  </li>
                ))}
              </ul>
            ) : (
              <ProfileEmptySection
                message={
                  isOwner
                    ? t("youNoRankings")
                    : t("theyNoRankings", { username: profile.username })
                }
                ctaHref={isOwner ? "/rankings/create" : null}
                ctaLabel={`${t("createFirstRanking")} →`}
              />
            )}
          </section>

          <section className="mt-12">
            <h2 className="mb-5 font-sans text-[11px] font-medium uppercase tracking-widest text-foreground-muted">
              {t("cardsBy", { username: profile.username })}
            </h2>
            {visibleCards.length > 0 ? (
              <ul className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
                {visibleCards.map((c) => (
                  <li key={c.id}>
                    <FightCardGridCard card={c} />
                  </li>
                ))}
              </ul>
            ) : (
              <ProfileEmptySection
                message={
                  isOwner
                    ? t("youNoCards")
                    : t("theyNoCards", { username: profile.username })
                }
                ctaHref={isOwner ? "/cards/create" : null}
                ctaLabel={`${t("createFirstCard")} →`}
              />
            )}
          </section>

        </Container>
      </main>
      <Footer />
    </>
  );
}

function ProfileEmptySection({
  message,
  ctaHref,
  ctaLabel,
}: {
  message: string;
  ctaHref: string | null;
  ctaLabel: string;
}) {
  return (
    <div className="rounded-md border border-dashed border-foreground/15 bg-background-elevated/20 px-6 py-10 text-center">
      <p className="font-sans text-sm text-foreground-muted">{message}</p>
      {ctaHref ? (
        <Link
          href={ctaHref}
          className="mt-4 inline-block rounded-sm border border-foreground/15 px-4 py-2 font-sans text-sm text-foreground-muted hover:bg-foreground/[0.05] hover:text-foreground"
        >
          {ctaLabel}
        </Link>
      ) : null}
    </div>
  );
}

function Stat({ label, value }: { label: string; value: number }) {
  return (
    <div className="rounded-md border border-foreground/10 bg-background-elevated/30 px-4 py-3">
      <dt className="font-sans text-[10px] uppercase tracking-widest text-foreground-subtle">
        {label}
      </dt>
      <dd className="mt-1 font-display text-2xl tabular text-foreground">
        {formatNumber(value)}
      </dd>
    </div>
  );
}
