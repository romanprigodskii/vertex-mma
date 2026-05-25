import Link from "next/link";

import { Container } from "@/components/layout/container";
import { Footer } from "@/components/layout/footer";
import { Navbar } from "@/components/layout/navbar";
import { EventFights } from "@/components/markets/event-fights";
import { getCurrentUser } from "@/lib/auth";
import { listOpenMarketsByEvent } from "@/lib/markets";
import { formatCoins } from "@/lib/utils";

export const dynamic = "force-dynamic";

export const metadata = {
  title: "Markets",
  description: "Bet virtual coins on upcoming UFC bouts.",
};

export default async function MarketsPage() {
  const [events, user] = await Promise.all([
    listOpenMarketsByEvent(20),
    getCurrentUser(),
  ]);

  return (
    <>
      <Navbar />
      <main className="flex-1">
        <Container size="lg" className="py-10 md:py-14">
          <header className="mb-8 flex flex-wrap items-baseline justify-between gap-3">
            <div>
              <p className="font-mono text-[11px] uppercase tracking-[0.2em] text-foreground-subtle">
                Bookmaker
              </p>
              <h1 className="mt-2 font-display uppercase tracking-tight text-foreground text-h1">
                Markets
              </h1>
              <p className="mt-2 max-w-xl font-sans text-sm text-foreground-muted">
                Win odds on every upcoming bout — open a fight for its method,
                round, and prop markets. Prices track real sportsbook odds and
                move on every trade.
              </p>
            </div>
            {user ? (
              <div className="text-right">
                <p className="font-mono text-[11px] uppercase tracking-widest text-foreground-subtle">
                  Your balance
                </p>
                <p className="font-display text-2xl tabular text-foreground">
                  {formatCoins(user.balanceCoins)}{" "}
                  <span className="text-sm text-foreground-muted">coins</span>
                </p>
                <Link
                  href="/me/bets"
                  className="mt-1 inline-block font-sans text-xs text-primary hover:underline"
                >
                  My bets →
                </Link>
              </div>
            ) : (
              <Link
                href="/signin?next=/markets"
                className="rounded-sm border border-foreground/15 px-4 py-2 font-display text-sm uppercase tracking-widest text-foreground-muted hover:bg-foreground/[0.05] hover:text-foreground"
              >
                Sign in to bet
              </Link>
            )}
          </header>

          <EventFights events={events} />
        </Container>
      </main>
      <Footer />
    </>
  );
}
