import Link from "next/link";
import { redirect } from "next/navigation";
import { ChevronLeft } from "lucide-react";

import { Container } from "@/components/layout/container";
import { Footer } from "@/components/layout/footer";
import { Navbar } from "@/components/layout/navbar";
import { getCurrentUser } from "@/lib/auth";

export const dynamic = "force-dynamic";

export const metadata = {
  title: "My profile",
};

export default async function MePage() {
  const user = await getCurrentUser();
  if (!user) redirect("/signin?next=/me");

  const joined = new Date(user.joinedAt);
  const joinedLabel = joined.toLocaleDateString(undefined, {
    year: "numeric",
    month: "short",
    day: "numeric",
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
              {user.avatarUrl ? (
                // eslint-disable-next-line @next/next/no-img-element
                <img
                  src={user.avatarUrl}
                  alt={user.username}
                  className="h-24 w-24 rounded-full border border-foreground/15 object-cover sm:h-32 sm:w-32"
                />
              ) : (
                <div className="flex h-24 w-24 items-center justify-center rounded-full bg-primary/15 font-display text-2xl uppercase text-primary sm:h-32 sm:w-32 sm:text-3xl">
                  {user.username.slice(0, 2)}
                </div>
              )}
            </div>

            <div className="flex-1 text-center sm:text-left">
              <h1 className="font-display text-3xl uppercase tracking-tight text-foreground sm:text-4xl">
                {user.displayName || user.username}
              </h1>
              <p className="mt-1 font-mono text-sm text-foreground-muted">
                @{user.username}
              </p>
              <p className="mt-3 font-sans text-[11px] uppercase tracking-widest text-foreground-subtle">
                {user.tier.toUpperCase()} · {user.balanceCoins.toLocaleString()}{" "}
                coins · Joined {joinedLabel}
                {user.countryCode ? ` · ${user.countryCode}` : ""}
              </p>
              {user.bio ? (
                <p className="mt-4 max-w-xl font-sans text-sm text-foreground-muted whitespace-pre-line">
                  {user.bio}
                </p>
              ) : null}
              <Link
                href="/settings"
                className="mt-5 inline-flex rounded-sm border border-foreground/15 px-4 py-2 font-sans text-sm text-foreground-muted hover:bg-foreground/[0.05] hover:text-foreground"
              >
                Edit profile
              </Link>
            </div>
          </div>

          <dl className="mt-10 grid grid-cols-2 gap-4 sm:grid-cols-5">
            <Stat label="Simulations" value={user.simulationCount} />
            <Stat label="Predictions" value={user.predictionCount} />
            <Stat label="Bets" value={user.betCount} />
            <Stat label="Current streak" value={user.currentStreak} />
            <Stat label="Best streak" value={user.bestStreak} />
          </dl>
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
