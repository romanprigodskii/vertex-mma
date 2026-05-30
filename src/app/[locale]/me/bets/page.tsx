import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { getTranslations, setRequestLocale } from "next-intl/server";
import { ChevronLeft } from "lucide-react";

import { Container } from "@/components/layout/container";
import { Footer } from "@/components/layout/footer";
import { Navbar } from "@/components/layout/navbar";
import { Link } from "@/i18n/navigation";
import { getCurrentUser } from "@/lib/auth";
import { listMyBets } from "@/lib/markets";

export const dynamic = "force-dynamic";

export async function generateMetadata({
  params,
}: {
  params: Promise<{ locale: string }>;
}): Promise<Metadata> {
  const { locale } = await params;
  const t = await getTranslations({ locale, namespace: "me" });
  return { title: t("myBetsTitle") };
}

export default async function MyBetsPage({
  params,
}: {
  params: Promise<{ locale: string }>;
}) {
  const { locale } = await params;
  setRequestLocale(locale);
  const t = await getTranslations("me");
  const tMarkets = await getTranslations("markets");
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
              <ChevronLeft className="h-4 w-4" aria-hidden /> {tMarkets("heading")}
            </Link>
          </Container>
        </div>

        <Container size="lg" className="py-10 md:py-14">
          <h1 className="font-display text-3xl uppercase tracking-tight text-foreground sm:text-4xl">
            {t("myBetsTitle")}
          </h1>
          <p className="mt-2 font-sans text-sm text-foreground-muted">
            {t("balance")}{" "}
            <span className="text-foreground">
              {user.balanceCoins.toLocaleString()} {t("coinsSuffix")}
            </span>
          </p>

          {bets.length === 0 ? (
            <div className="mt-10 rounded-md border border-dashed border-foreground/15 bg-background-elevated/20 px-6 py-16 text-center">
              <p className="font-display text-xl uppercase tracking-tight text-foreground break-words sm:text-2xl">
                {t("noBets")}
              </p>
              <p className="mx-auto mt-3 max-w-md font-sans text-sm text-foreground-muted">
                {t("noBetsLead")}
              </p>
              <Link
                href="/markets"
                className="mt-6 inline-block rounded-sm bg-primary px-4 py-2 font-display text-sm uppercase tracking-widest text-background-base hover:opacity-90"
              >
                {t("browseMarkets")} →
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
                        {t("onOutcomeAt", {
                          outcome: b.outcome_label,
                          pct: (b.price_at_purchase * 100).toFixed(1),
                        })}
                      </p>
                    </div>
                    <div className="shrink-0 text-right">
                      <p className="font-mono text-sm tabular text-foreground-muted">
                        {t("spentForShares", {
                          coins: b.coins_spent.toLocaleString(),
                          shares: b.shares_bought.toFixed(1),
                        })}
                      </p>
                      {b.resolved_at ? (
                        // Refund check comes BEFORE is_winning: a cancelled
                        // market leaves is_winning NULL so the previous
                        // ternary would have shown "Lost" incorrectly.
                        b.market_status === "cancelled" ? (
                          <p className="font-mono text-xs tabular text-foreground-muted">
                            {t("refundedSuffix", {
                              coins: (b.payout ?? 0).toLocaleString(),
                            })}
                          </p>
                        ) : b.is_winning ? (
                          <p className="font-mono text-xs tabular text-streak-win">
                            {t("wonSuffix", {
                              coins: (b.payout ?? 0).toLocaleString(),
                            })}
                          </p>
                        ) : (
                          <p className="font-mono text-xs tabular text-streak-loss">
                            {t("lost")}
                          </p>
                        )
                      ) : (
                        <p className="font-mono text-xs tabular text-foreground-subtle">
                          {t("pending")}
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
