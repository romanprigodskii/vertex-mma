import Link from "next/link";
import { redirect } from "next/navigation";
import { ChevronLeft } from "lucide-react";

import { Container } from "@/components/layout/container";
import { Footer } from "@/components/layout/footer";
import { Navbar } from "@/components/layout/navbar";
import { getCurrentUser } from "@/lib/auth";
import { listMyBets } from "@/lib/markets";

export const dynamic = "force-dynamic";

export const metadata = { title: "My bets" };

export default async function MyBetsPage() {
  const user = await getCurrentUser();
  if (!user) redirect("/signin?next=/me/bets");
  const bets = await listMyBets(user.userProfileId);

  return (
    <>
      <Navbar />
      <main className="flex-1">
        <div className="border-b border-foreground/[0.06]">
          <Container size="xl" className="py-3">
            <Link
              href="/markets"
              className="inline-flex items-center gap-1.5 font-sans text-sm text-foreground-muted hover:text-primary"
            >
              <ChevronLeft className="h-4 w-4" aria-hidden /> Markets
            </Link>
          </Container>
        </div>

        <Container size="lg" className="py-10 md:py-14">
          <h1 className="font-display text-3xl uppercase tracking-tight text-foreground sm:text-4xl">
            My bets
          </h1>
          <p className="mt-2 font-sans text-sm text-foreground-muted">
            Balance:{" "}
            <span className="text-foreground">
              {user.balanceCoins.toLocaleString()} coins
            </span>
          </p>

          {bets.length === 0 ? (
            <div className="mt-10 rounded-md border border-dashed border-foreground/15 bg-background-elevated/20 px-6 py-16 text-center">
              <p className="font-display text-2xl uppercase tracking-tight text-foreground">
                No bets yet
              </p>
              <p className="mx-auto mt-3 max-w-md font-sans text-sm text-foreground-muted">
                Pick a market to start. Every trade nudges the implied odds —
                early shares pay more if you&rsquo;re right.
              </p>
              <Link
                href="/markets"
                className="mt-6 inline-block rounded-sm bg-primary px-4 py-2 font-display text-sm uppercase tracking-widest text-background-base hover:opacity-90"
              >
                Browse markets →
              </Link>
            </div>
          ) : (
            <ul className="mt-8 flex flex-col gap-2">
              {bets.map((b) => (
                <li
                  key={b.bet_id}
                  className="rounded-md border border-foreground/10 bg-background-elevated/30 p-3"
                >
                  <div className="flex items-center justify-between gap-3">
                    <div className="min-w-0 flex-1">
                      <Link
                        href={`/markets/${b.market_id}`}
                        prefetch={false}
                        className="block truncate font-sans text-sm text-foreground hover:text-primary"
                      >
                        {b.fighter_a_name} vs {b.fighter_b_name}
                      </Link>
                      <p className="mt-1 font-mono text-[11px] tabular text-foreground-subtle">
                        on &ldquo;{b.outcome_label}&rdquo; @{" "}
                        {(b.price_at_purchase * 100).toFixed(1)}%
                      </p>
                    </div>
                    <div className="shrink-0 text-right">
                      <p className="font-mono text-sm tabular text-foreground-muted">
                        -{b.coins_spent.toLocaleString()}c →{" "}
                        {b.shares_bought.toFixed(1)} shares
                      </p>
                      {b.resolved_at ? (
                        // Refund check comes BEFORE is_winning: a cancelled
                        // market leaves is_winning NULL so the previous
                        // ternary would have shown "Lost" incorrectly.
                        b.market_status === "cancelled" ? (
                          <p className="font-mono text-xs tabular text-foreground-muted">
                            Refunded · {(b.payout ?? 0).toLocaleString()}c
                            returned
                          </p>
                        ) : b.is_winning ? (
                          <p className="font-mono text-xs tabular text-streak-win">
                            Won · +{(b.payout ?? 0).toLocaleString()}c
                          </p>
                        ) : (
                          <p className="font-mono text-xs tabular text-streak-loss">
                            Lost
                          </p>
                        )
                      ) : (
                        <p className="font-mono text-xs tabular text-foreground-subtle">
                          Pending
                        </p>
                      )}
                    </div>
                  </div>
                </li>
              ))}
            </ul>
          )}
        </Container>
      </main>
      <Footer />
    </>
  );
}
