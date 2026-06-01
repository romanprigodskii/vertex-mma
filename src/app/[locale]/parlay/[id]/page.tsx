import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { getTranslations, setRequestLocale } from "next-intl/server";

import { Container } from "@/components/layout/container";
import { Footer } from "@/components/layout/footer";
import { Navbar } from "@/components/layout/navbar";
import { ShareButton } from "@/components/share/share-button";
import { Link, getPathname } from "@/i18n/navigation";
import {
  type SportsbookSelectionCode,
  describeSelection,
  formatOdds,
  isSelectionCode,
} from "@/lib/sportsbook";
import { getParlayById } from "@/lib/sportsbook-data";
import { cn } from "@/lib/utils";

export const dynamic = "force-dynamic";

interface PageProps {
  params: Promise<{ id: string; locale: string }>;
}

export async function generateMetadata({ params }: PageProps): Promise<Metadata> {
  const { id, locale } = await params;
  const p = await getParlayById(id);
  const t = await getTranslations({ locale, namespace: "parlay" });
  if (!p) return { title: t("notFound") };
  const title = t("metaTitle", { n: p.legs.length });
  const og = `/api/og/parlay/${p.id}`;
  return {
    title,
    description: t("metaDescription", { n: p.num_legs, odds: formatOdds(p.combined_odds) }),
    openGraph: {
      title,
      description: t("metaDescription", { n: p.num_legs, odds: formatOdds(p.combined_odds) }),
      siteName: "Vertex MMA",
      type: "website",
      images: [{ url: og, width: 1200, height: 630, alt: title }],
    },
    twitter: { card: "summary_large_image", images: [og] },
  };
}

const STATUS_STYLE: Record<string, { key: string; cls: string }> = {
  won: { key: "statusWon", cls: "border-streak-win/40 bg-streak-win/10 text-streak-win" },
  lost: { key: "statusLost", cls: "border-streak-loss/40 bg-streak-loss/10 text-streak-loss" },
  void: { key: "statusVoid", cls: "border-foreground/20 bg-foreground/[0.04] text-foreground-muted" },
  open: { key: "statusOpen", cls: "border-primary/40 bg-primary/10 text-primary" },
};

export default async function ParlayPage({ params }: PageProps) {
  const { id, locale } = await params;
  setRequestLocale(locale);
  const t = await getTranslations("parlay");
  const tSb = await getTranslations("sportsbook");
  const p = await getParlayById(id);
  if (!p) notFound();

  function legLabel(code: string, aName: string, bName: string): string {
    if (!isSelectionCode(code)) return code;
    const d = describeSelection(code as SportsbookSelectionCode);
    const name = d.side === "a" ? aName : bName;
    switch (d.marketKind) {
      case "winner":
        return name;
      case "method":
        return `${name} ${tSb(`method_${d.methodKey}` as "method_ko")}`;
      case "total_rounds":
        return `${tSb("market_total_rounds")}: ${d.totalKey === "over" ? tSb("over25") : tSb("under25")}`;
      case "distance":
        return `${tSb("market_distance")}: ${d.distanceKey === "yes" ? tSb("distanceYes") : tSb("distanceNo")}`;
    }
  }

  function legDot(status: string): string {
    if (status === "won") return "text-streak-win";
    if (status === "lost") return "text-streak-loss";
    if (status === "void") return "text-foreground-muted";
    return "text-foreground-subtle";
  }

  const status = STATUS_STYLE[p.status] ?? STATUS_STYLE.open;
  const bettor = p.bettor_display_name || `@${p.bettor_username}`;

  return (
    <>
      <Navbar />
      <main className="flex-1">
        <Container size="md" className="py-10 md:py-14">
          <div className="flex items-center justify-between gap-3">
            <p className="font-mono text-[11px] uppercase tracking-[0.2em] text-foreground-subtle">
              {t("kicker")}
            </p>
            <ShareButton
              url={getPathname({ href: `/parlay/${p.id}`, locale })}
              ogImageUrl={`/api/og/parlay/${p.id}`}
              title={t("metaTitle", { n: p.legs.length })}
              filename={`vertexmma-parlay-${p.id.slice(0, 8)}`}
              label={t("shareLabel")}
              variant="icon"
            />
          </div>

          {/* Hero: bettor + combined odds + status */}
          <div className="mt-6 flex items-end justify-between gap-4">
            <div className="min-w-0">
              <div className="flex items-center gap-2">
                {p.bettor_avatar_url ? (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img
                    src={p.bettor_avatar_url}
                    alt=""
                    className="h-7 w-7 rounded-full border border-foreground/15 object-cover"
                  />
                ) : null}
                <span className="truncate font-sans text-sm text-foreground-muted">
                  {t("placedBy", { name: bettor })}
                </span>
              </div>
              <p className="mt-2 font-display text-foreground" style={{ fontSize: "clamp(48px, 9vw, 88px)", lineHeight: 1 }}>
                {formatOdds(p.combined_odds)}
                <span className="text-foreground-muted">×</span>
              </p>
              <p className="mt-1 font-mono text-sm tabular text-foreground-subtle">
                {t("stakeToWin", {
                  stake: p.stake_coins.toLocaleString(),
                  payout: p.potential_payout.toLocaleString(),
                })}
              </p>
            </div>
            <span
              className={cn(
                "shrink-0 rounded-md border px-3 py-1.5 font-display text-sm uppercase tracking-widest",
                status.cls,
              )}
            >
              {t(status.key as "statusOpen")}
              {/* Only a WIN shows "+payout" — a void/push refunds the stake,
                  so a "+" there would read as profit (it's net zero). */}
              {p.status === "won" && p.payout != null
                ? ` +${p.payout.toLocaleString()}`
                : ""}
            </span>
          </div>

          {/* Legs */}
          <h2 className="mb-3 mt-10 font-sans text-[11px] font-medium uppercase tracking-widest text-foreground-subtle">
            {t("legsHeading")}
          </h2>
          <ul className="overflow-hidden rounded-lg border border-foreground/10 bg-background-elevated/20">
            {p.legs.map((leg, i) => (
              <li
                key={i}
                className="flex items-center gap-3 border-b border-foreground/[0.06] px-4 py-3 last:border-b-0"
              >
                <span className={cn("font-mono text-lg leading-none", legDot(leg.status))}>
                  ●
                </span>
                <div className="min-w-0 flex-1">
                  <p className="truncate font-sans text-sm text-foreground">
                    {legLabel(leg.selection_code, leg.fighter_a_name, leg.fighter_b_name)}
                  </p>
                  <p className="truncate font-mono text-[11px] uppercase tracking-wide text-foreground-subtle">
                    {leg.fighter_a_name} vs {leg.fighter_b_name}
                    {" · "}
                    <Link
                      href={`/events/${leg.event_slug}`}
                      className="hover:text-foreground"
                    >
                      {leg.event_name}
                    </Link>
                  </p>
                </div>
                <span className="shrink-0 font-mono text-sm tabular text-foreground-muted">
                  {formatOdds(leg.decimal_odds)}
                </span>
              </li>
            ))}
          </ul>

          <Link
            href="/markets"
            className="mt-8 inline-block rounded-sm bg-primary px-5 py-2.5 font-display text-sm uppercase tracking-widest text-background-base hover:opacity-90"
          >
            {t("buildYourOwn")}
          </Link>
        </Container>
      </main>
      <Footer />
    </>
  );
}
