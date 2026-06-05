import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { getTranslations, setRequestLocale } from "next-intl/server";
import { ChevronLeft } from "lucide-react";

import { Container } from "@/components/layout/container";
import { Footer } from "@/components/layout/footer";
import { Navbar } from "@/components/layout/navbar";
import { ShareButton } from "@/components/share/share-button";
import { Link, getPathname } from "@/i18n/navigation";
import { checkAndUnlockAchievements } from "@/lib/achievements";
import { getCurrentUser } from "@/lib/auth";
import { listMyBets } from "@/lib/markets";
import {
  type SportsbookSelectionCode,
  describeSelection,
  formatOdds,
  isSelectionCode,
} from "@/lib/sportsbook";
import {
  listMyFixedOddsBets,
  listMyParlays,
  type MyFixedOddsBetRow,
} from "@/lib/sportsbook-data";

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
  const dateLocale = locale === "ru" ? "ru-RU" : "en-US";
  const t = await getTranslations("me");
  const tMarkets = await getTranslations("markets");
  const tSb = await getTranslations("sportsbook");
  const tParlay = await getTranslations("parlay");
  const user = await getCurrentUser();
  if (!user) redirect("/signin?next=/me/bets");
  // Settlement runs DB-side (trigger), which can't call the TS achievement
  // evaluator — so re-evaluate here when the user views their bets, catching
  // win-based achievements (bet_10_wins, big_win, parlay_win, …) shortly after
  // a bout settles. Idempotent + cheap; newly-unlocked surface on /achievements.
  const [bets, sbBets, parlays] = await Promise.all([
    listMyBets(user.userProfileId),
    listMyFixedOddsBets(user.userProfileId),
    listMyParlays(user.userProfileId),
    checkAndUnlockAchievements(user.userProfileId),
  ]);

  // Localised label for a sportsbook selection (mirrors SportsbookPanel).
  function selectionLabel(code: string, aName: string, bName: string): string {
    if (!isSelectionCode(code)) return code;
    const d = describeSelection(code as SportsbookSelectionCode);
    const name = d.side === "a" ? aName : bName;
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
  const sbLabel = (b: MyFixedOddsBetRow): string =>
    selectionLabel(b.selection_code, b.fighter_a_name, b.fighter_b_name);

  function statusClass(status: string): string {
    if (status === "won") return "text-streak-win";
    if (status === "lost") return "text-streak-loss";
    if (status === "void") return "text-foreground-muted";
    return "text-foreground-subtle";
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
              {user.balanceCoins.toLocaleString(dateLocale)} {t("coinsSuffix")}
            </span>
          </p>

          {bets.length === 0 && sbBets.length === 0 && parlays.length === 0 ? (
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
                                coins: b.stake_coins.toLocaleString(dateLocale),
                                odds: formatOdds(b.decimal_odds),
                              })}
                            </p>
                          </div>
                          <div className="shrink-0 text-right">
                            {b.status === "won" ? (
                              <p className="font-mono text-xs tabular text-streak-win">
                                {t("wonSuffix", {
                                  coins: (b.payout ?? 0).toLocaleString(dateLocale),
                                })}
                              </p>
                            ) : b.status === "void" ? (
                              <p className="font-mono text-xs tabular text-foreground-muted">
                                {t("refundedSuffix", {
                                  coins: (b.payout ?? 0).toLocaleString(dateLocale),
                                })}
                              </p>
                            ) : b.status === "lost" ? (
                              <p className="font-mono text-xs tabular text-streak-loss">
                                {t("lost")}
                              </p>
                            ) : (
                              <p className="font-mono text-xs tabular text-foreground-subtle">
                                {t("pending")} → {b.potential_payout.toLocaleString(dateLocale)}
                              </p>
                            )}
                          </div>
                        </div>
                      </li>
                    ))}
                  </ul>
                </section>
              ) : null}
              {parlays.length > 0 ? (
                <section>
                  <h2 className="mb-3 font-sans text-[11px] font-medium uppercase tracking-widest text-foreground-subtle">
                    {t("parlaySection")}
                  </h2>
                  <ul className="flex flex-col gap-2">
                    {parlays.map((p) => (
                      <li
                        key={p.parlay_id}
                        className="rounded-md border border-foreground/10 bg-background-elevated/30 p-3"
                      >
                        <div className="flex items-center justify-between gap-3">
                          <p className="font-sans text-sm text-foreground">
                            {t("parlayHeader", {
                              n: p.num_legs,
                              odds: formatOdds(p.combined_odds),
                            })}
                          </p>
                          <div className="flex shrink-0 items-center gap-2">
                            <ShareButton
                              url={getPathname({ href: `/parlay/${p.parlay_id}`, locale })}
                              ogImageUrl={`/api/og/parlay/${p.parlay_id}`}
                              title={tParlay("metaTitle", { n: p.legs.length })}
                              filename={`vertexmma-parlay-${p.parlay_id.slice(0, 8)}`}
                              label={tParlay("shareLabel")}
                              variant="icon"
                            />
                            <div className="text-right">
                            {p.status === "won" ? (
                              <p className="font-mono text-xs tabular text-streak-win">
                                {t("wonSuffix", {
                                  coins: (p.payout ?? 0).toLocaleString(dateLocale),
                                })}
                              </p>
                            ) : p.status === "void" ? (
                              <p className="font-mono text-xs tabular text-foreground-muted">
                                {t("refundedSuffix", {
                                  coins: (p.payout ?? 0).toLocaleString(dateLocale),
                                })}
                              </p>
                            ) : p.status === "lost" ? (
                              <p className="font-mono text-xs tabular text-streak-loss">
                                {t("lost")}
                              </p>
                            ) : (
                              <p className="font-mono text-xs tabular text-foreground-subtle">
                                {t("pending")} → {p.potential_payout.toLocaleString(dateLocale)}
                              </p>
                            )}
                            </div>
                          </div>
                        </div>
                        <ul className="mt-2 space-y-1 border-t border-foreground/[0.06] pt-2">
                          {p.legs.map((leg) => (
                            <li
                              key={`${p.parlay_id}-${leg.bout_id}`}
                              className="flex items-center justify-between gap-2 font-mono text-[11px] tabular"
                            >
                              <span className="min-w-0 truncate text-foreground-muted">
                                <span className={statusClass(leg.status)}>●</span>{" "}
                                {selectionLabel(
                                  leg.selection_code,
                                  leg.fighter_a_name,
                                  leg.fighter_b_name,
                                )}
                                <span className="text-foreground-subtle/60">
                                  {" · "}
                                  {leg.fighter_a_name} vs {leg.fighter_b_name}
                                </span>
                              </span>
                              <span className="shrink-0 text-foreground-subtle">
                                {formatOdds(leg.decimal_odds)}
                              </span>
                            </li>
                          ))}
                        </ul>
                        <p className="mt-2 font-mono text-[10px] tabular text-foreground-subtle">
                          {t("sbStaked", {
                            coins: p.stake_coins.toLocaleString(dateLocale),
                            odds: formatOdds(p.combined_odds),
                          })}
                        </p>
                      </li>
                    ))}
                  </ul>
                </section>
              ) : null}
              {bets.length > 0 ? (
                <section>
                  {/* Show the heading whenever another section is present, so a
                      user with parlays but no sportsbook bets doesn't get an
                      unlabeled prediction-market list reading as a stray
                      continuation of the Parlays section. */}
                  {sbBets.length > 0 || parlays.length > 0 ? (
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
                          coins: b.coins_spent.toLocaleString(dateLocale),
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
                              coins: (b.payout ?? 0).toLocaleString(dateLocale),
                            })}
                          </p>
                        ) : b.is_winning ? (
                          <p className="font-mono text-xs tabular text-streak-win">
                            {t("wonSuffix", {
                              coins: (b.payout ?? 0).toLocaleString(dateLocale),
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
