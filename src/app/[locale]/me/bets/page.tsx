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
import { describeSelection, formatOdds, isSelectionCode } from "@/lib/sportsbook";
import { listMyFixedOddsBets, type MyFixedOddsBetRow } from "@/lib/sportsbook-data";

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
  const tSb = await getTranslations("sportsbook");
  const user = await getCurrentUser();
  if (!user) redirect("/signin?next=/me/bets");
  const [bets, sbBets] = await Promise.all([
    listMyBets(user.userProfileId),
    listMyFixedOddsBets(user.userProfileId),
  ]);

  // Localised label for a sportsbook selection (mirrors SportsbookPanel).
  function sbLabel(b: MyFixedOddsBetRow): string {
    if (!isSelectionCode(b.selection_code)) return b.selection_code;
    const d = describeSelection(b.selection_code);
    const name = d.side === "a" ? b.fighter_a_name : b.fighter_b_name;
    switch (d.marketKind) {
      case "winner":
        return name;
      case "method":
        return `${name} ${tSb(`method_${d.methodKey}` as "method_ko")}`;
      case "total_rounds":
        return `${tSb("market_total_rounds")}: ${
          d.totalKey === "over" ? tSb("over25") : tSb("under25")
        }`;
      case "distance":
        return `${tSb("market_distance")}: ${
          d.distanceKey === "yes" ? tSb("distanceYes") : tSb("distanceNo")
        }`;
    }
  }

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

          {bets.length === 0 && sbBets.length === 0 ? (
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
            <div className="mt-8 flex flex-col gap-10">
              {sbBets.length > 0 ? (
                <section>
                  <h2 className="mb-3 font-sans text-[11px] font-medium uppercase tracking-widest text-foreground-subtle">
                    {t("sbSection")}
                  </h2>
                  <ul className="flex flex-col gap-2">
                    {sbBets.map((b) => (
                      <li
                        key={b.bet_id}
                        className="rounded-md border border-foreground/10 bg-background-elevated/30 p-3"
                      >
                        <div className="flex items-center justify-between gap-3">
                          <div className="min-w-0 flex-1">
                            <Link
                              href={`/bouts/${b.bout_id}`}
                              prefetch={false}
                              className="block truncate font-sans text-sm text-foreground hover:text-primary"
                            >
                              {b.fighter_a_name} vs {b.fighter_b_name}
                            </Link>
                            <p className="mt-1 truncate font-mono text-[11px] tabular text-foreground-subtle">
                              {sbLabel(b)} ·{" "}
                              {t("sbStaked", {
                                coins: b.stake_coins.toLocaleString(),
                                odds: formatOdds(b.decimal_odds),
                              })}
                            </p>
                          </div>
                          <div className="shrink-0 text-right">
                            {b.status === "won" ? (
                              <p className="font-mono text-xs tabular text-streak-win">
                                {t("wonSuffix", {
                                  coins: (b.payout ?? 0).toLocaleString(),
                                })}
                              </p>
                            ) : b.status === "void" ? (
                              <p className="font-mono text-xs tabular text-foreground-muted">
                                {t("refundedSuffix", {
                                  coins: (b.payout ?? 0).toLocaleString(),
                                })}
                              </p>
                            ) : b.status === "lost" ? (
                              <p className="font-mono text-xs tabular text-streak-loss">
                                {t("lost")}
                              </p>
                            ) : (
                              <p className="font-mono text-xs tabular text-foreground-subtle">
                                {t("pending")} → {b.potential_payout.toLocaleString()}
                              </p>
                            )}
                          </div>
                        </div>
                      </li>
                    ))}
                  </ul>
                </section>
              ) : null}
              {bets.length > 0 ? (
                <section>
                  {sbBets.length > 0 ? (
                    <h2 className="mb-3 font-sans text-[11px] font-medium uppercase tracking-widest text-foreground-subtle">
                      {t("predictionSection")}
                    </h2>
                  ) : null}
                  <ul className="flex flex-col gap-2">
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
                </section>
              ) : null}
            </div>
          )}
        </Container>
      </main>
      <Footer />
    </>
  );
}
