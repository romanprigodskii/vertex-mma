import Link from "next/link";
import { notFound } from "next/navigation";
import { ChevronLeft } from "lucide-react";

import { AchievementsGrid } from "@/components/achievements/achievements-grid";
import { Container } from "@/components/layout/container";
import { Footer } from "@/components/layout/footer";
import { Navbar } from "@/components/layout/navbar";
import { DailyBonusButton } from "@/components/me/daily-bonus-button";
import { RankingCard } from "@/components/rankings/ranking-card";
import {
  listAchievements,
  listUserAchievements,
} from "@/lib/achievements";
import { getCurrentUser, getUserProfileByUsername } from "@/lib/auth";
import { listRankingsByUser } from "@/lib/rankings";

export const dynamic = "force-dynamic";

interface PageProps {
  params: Promise<{ username: string }>;
}

export async function generateMetadata({ params }: PageProps) {
  const { username } = await params;
  const profile = await getUserProfileByUsername(username);
  if (!profile) return { title: "User not found" };
  return {
    title: `@${profile.username}`,
    description: `${profile.displayName || profile.username}'s Vertex MMA profile · ${profile.tier} tier.`,
  };
}

export default async function PublicProfilePage({ params }: PageProps) {
  const { username } = await params;
  const [profile, currentUser] = await Promise.all([
    getUserProfileByUsername(username),
    getCurrentUser(),
  ]);
  if (!profile) notFound();

  const isOwner = currentUser?.username === profile.username;
  const [rankings, userAchievements, allAchievements] = await Promise.all([
    listRankingsByUser(profile.userProfileId),
    listUserAchievements(profile.userProfileId),
    isOwner ? listAchievements() : Promise.resolve(undefined),
  ]);
  const joined = new Date(profile.joinedAt);
  const joinedLabel = joined.toLocaleDateString("en-US", {
    year: "numeric",
    month: "long",
  });

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
              <ChevronLeft className="h-4 w-4" aria-hidden /> Home
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
              <h1 className="font-display text-3xl uppercase tracking-tight text-foreground sm:text-4xl">
                {profile.displayName || profile.username}
              </h1>
              <p className="mt-1 font-mono text-sm text-foreground-muted">
                @{profile.username}
              </p>
              <p className="mt-3 font-sans text-[11px] uppercase tracking-widest text-foreground-subtle">
                {profile.tier.toUpperCase()} · joined {joinedLabel}
                {profile.countryCode ? ` · ${profile.countryCode}` : ""}
              </p>
              {profile.bio ? (
                <p className="mt-4 max-w-xl font-sans text-sm text-foreground-muted whitespace-pre-line">
                  {profile.bio}
                </p>
              ) : null}
              {isOwner ? (
                <Link
                  href="/settings"
                  className="mt-5 inline-flex rounded-sm border border-foreground/15 px-4 py-2 font-sans text-sm text-foreground-muted hover:bg-foreground/[0.05] hover:text-foreground"
                >
                  Edit profile
                </Link>
              ) : null}
            </div>
          </div>

          <dl className="mt-10 grid grid-cols-2 gap-4 sm:grid-cols-5">
            <Stat label="Simulations" value={profile.simulationCount} />
            <Stat label="Predictions" value={profile.predictionCount} />
            <Stat label="Bets" value={profile.betCount} />
            <Stat label="Current streak" value={profile.currentStreak} />
            <Stat label="Best streak" value={profile.bestStreak} />
          </dl>

          {isOwner ? (
            <section className="mt-10">
              <h2 className="mb-4 font-sans text-[11px] font-medium uppercase tracking-widest text-foreground-muted">
                Daily bonus
              </h2>
              <DailyBonusButton
                lastDailyBonusAt={profile.lastDailyBonusAt}
              />
            </section>
          ) : null}

          <section className="mt-10">
            <h2 className="mb-4 font-sans text-[11px] font-medium uppercase tracking-widest text-foreground-muted">
              Achievements · {userAchievements.length}
              {isOwner && allAchievements ? `/${allAchievements.length}` : ""}
            </h2>
            <AchievementsGrid
              unlocked={userAchievements}
              allAchievements={allAchievements}
            />
          </section>

          {rankings.length > 0 ? (
            <section className="mt-12">
              <h2 className="mb-5 font-sans text-[11px] font-medium uppercase tracking-widest text-foreground-muted">
                Rankings by @{profile.username}
              </h2>
              <ul className="grid grid-cols-1 gap-4 sm:grid-cols-2">
                {rankings.map((r) => (
                  <li key={r.id}>
                    <RankingCard ranking={r} />
                  </li>
                ))}
              </ul>
            </section>
          ) : null}
        </Container>
      </main>
      <Footer />
    </>
  );
}

function Stat({ label, value }: { label: string; value: number }) {
  return (
    <div className="rounded-md border border-foreground/10 bg-background-elevated/30 px-4 py-3">
      <dt className="font-sans text-[10px] uppercase tracking-widest text-foreground-subtle">
        {label}
      </dt>
      <dd className="mt-1 font-display text-2xl tabular text-foreground">
        {value.toLocaleString()}
      </dd>
    </div>
  );
}
