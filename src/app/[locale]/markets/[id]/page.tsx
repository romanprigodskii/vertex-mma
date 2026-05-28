import { notFound } from "next/navigation";
import { getTranslations, setRequestLocale } from "next-intl/server";
import { ChevronLeft } from "lucide-react";

import { Container } from "@/components/layout/container";
import { Footer } from "@/components/layout/footer";
import { Navbar } from "@/components/layout/navbar";
import { BetForm } from "@/components/markets/bet-form";
import { SportsbookConsensus } from "@/components/markets/sportsbook-consensus";
import { ShareButton } from "@/components/share/share-button";
import { Link } from "@/i18n/navigation";
import { getCurrentUser } from "@/lib/auth";
import { priceToDecimalOdds } from "@/lib/lmsr";
import { getBoutExternalOdds, getMarketById } from "@/lib/markets";

export const dynamic = "force-dynamic";

interface PageProps {
  params: Promise<{ id: string; locale: string }>;
}

export async function generateMetadata({ params }: PageProps) {
  const { id, locale } = await params;
  const m = await getMarketById(id);
  if (!m) {
    const tNF = await getTranslations({ locale, namespace: "notFound" });
    return { title: tNF("marketTitle") };
  }
  const t = await getTranslations({ locale, namespace: "markets" });
  const title = `${m.fighter_a_name} vs ${m.fighter_b_name}`;
  const desc = t("marketDetailMetaDescription", { event: m.event_name });
  const ogImage = `/api/og/markets/${m.id}`;
  return {
    title,
    description: desc,
    openGraph: {
      title,
      description: t("marketOgDescription", { event: m.event_name }),
      siteName: "Vertex MMA",
      type: "website",
      images: [
        {
          url: ogImage,
          width: 1200,
          height: 630,
          alt: t("marketImageAlt", { title }),
        },
      ],
    },
    twitter: {
      card: "summary_large_image",
      images: [ogImage],
    },
  };
}

export default async function MarketDetailPage({ params }: PageProps) {
  const { id, locale } = await params;
  setRequestLocale(locale);
  const t = await getTranslations("markets");
  const dateLocale = locale === "ru" ? "ru-RU" : "en-US";
  const market = await getMarketById(id);
  if (!market) notFound();

  const [user, externalOdds] = await Promise.all([
    getCurrentUser(),
    getBoutExternalOdds(market.bout_id),
  ]);

  const closed =
    market.status !== "open" ||
    new Date(market.closes_at).getTime() <= Date.now();

  return (
    <>
      <Navbar />
      <main className="flex-1">
        <div className="border-b border-foreground/[0.06]">
          <Container size="xl" className="flex items-center justify-between py-3">
            <Link
              href="/markets"
              className="inline-flex items-center gap-1.5 font-sans text-sm text-foreground-muted hover:text-primary"
            >
              <ChevronLeft className="h-4 w-4" aria-hidden /> {t("allMarkets")}
            </Link>
            <ShareButton
              url={`/markets/${market.id}`}
              ogImageUrl={`/api/og/markets/${market.id}`}
              title={t("shareTitleSuffix", {
                a: market.fighter_a_name,
                b: market.fighter_b_name,
              })}
              filename={`vertexmma-market-${market.id.slice(0, 8)}`}
              label={t("shareMarket")}
              variant="icon"
            />
          </Container>
        </div>

        <Container size="lg" className="py-10 md:py-14">
          <p className="font-mono text-[11px] uppercase tracking-[0.2em] text-foreground-subtle">
            <Link
              href={`/events/${market.event_slug}`}
              className="hover:text-foreground"
            >
              {market.event_name}
            </Link>
            {" · "}
            {new Date(market.event_date).toLocaleDateString(dateLocale, {
              month: "long",
              day: "numeric",
              year: "numeric",
            })}
          </p>
          <h1
            className="mt-3 font-display uppercase tracking-tight text-foreground"
            style={{ fontSize: "clamp(32px, 4vw, 56px)" }}
          >
            {market.type === "method" ? (
              t("methodHeading")
            ) : market.type === "round" ? (
              t("roundHeading")
            ) : market.type === "distance" ? (
              t("distanceHeading")
            ) : market.type === "prop" ? (
              market.question
            ) : (
              <>
                {market.fighter_a_name}{" "}
                <span className="text-foreground-subtle">vs</span>{" "}
                {market.fighter_b_name}
              </>
            )}
          </h1>
          <p className="mt-3 font-sans text-sm text-foreground-muted">
            {market.type === "winner"
              ? market.question
              : market.type === "prop"
                ? `${market.fighter_a_name} vs ${market.fighter_b_name}`
                : `${market.fighter_a_name} vs ${market.fighter_b_name} · ${market.question}`}
          </p>

          {market.type === "method" ? (
            <div className="mt-8 grid grid-cols-1 gap-3 sm:grid-cols-2">
              <FighterOutcomesPanel
                fighterName={market.fighter_a_name}
                outcomes={market.outcomes.filter((o) => o.order_index < 3)}
              />
              <FighterOutcomesPanel
                fighterName={market.fighter_b_name}
                outcomes={market.outcomes.filter((o) => o.order_index >= 3)}
              />
            </div>
          ) : market.type === "round" ? (
            <div className="mt-8 grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4">
              {market.outcomes.map((o) => (
                <div
                  key={o.id}
                  className="rounded-md border border-foreground/10 bg-background-elevated/30 p-3"
                >
                  <p className="truncate font-sans text-[11px] uppercase tracking-widest text-foreground-muted">
                    {o.label}
                  </p>
                  <p className="mt-2 font-display text-2xl tabular text-foreground">
                    {(o.current_price * 100).toFixed(1)}
                    <span className="text-xs text-foreground-muted">%</span>
                  </p>
                  <p className="mt-1 font-mono text-xs tabular text-primary">
                    {priceToDecimalOdds(o.current_price)}x
                  </p>
                  <p className="mt-1 font-mono text-[10px] tabular text-foreground-subtle">
                    {o.current_shares.toFixed(1)} sh
                  </p>
                </div>
              ))}
            </div>
          ) : (
            <div className="mt-8 grid grid-cols-2 gap-3">
              {market.outcomes.map((o) => (
                <div
                  key={o.id}
                  className="rounded-md border border-foreground/10 bg-background-elevated/30 p-4"
                >
                  <p className="font-sans text-[11px] uppercase tracking-widest text-foreground-muted">
                    {o.label}
                  </p>
                  <p className="mt-2 font-display text-3xl tabular text-foreground">
                    {(o.current_price * 100).toFixed(1)}
                    <span className="text-base text-foreground-muted">%</span>
                  </p>
                  <p className="mt-1 font-mono text-sm tabular text-primary">
                    {priceToDecimalOdds(o.current_price)}x
                  </p>
                  <p className="mt-1 font-mono text-[10px] tabular text-foreground-subtle">
                    {o.current_shares.toFixed(1)} shares outstanding
                  </p>
                </div>
              ))}
            </div>
          )}

          <div className="mt-8">
            {closed ? (
              <p className="rounded-md border border-foreground/10 bg-background-elevated/30 px-4 py-6 text-center font-sans text-sm text-foreground-muted">
                Market is closed.
              </p>
            ) : user ? (
              <BetForm market={market} userBalance={user.balanceCoins} />
            ) : (
              <Link
                href={`/signin?next=/markets/${market.id}`}
                className="inline-block rounded-sm bg-primary px-4 py-2.5 font-display text-sm uppercase tracking-widest text-background-base hover:opacity-90"
              >
                Sign in to bet
              </Link>
            )}
          </div>

          {externalOdds ? (
            <SportsbookConsensus
              odds={externalOdds}
              marketType={market.type}
              fighterAName={market.fighter_a_name}
              fighterBName={market.fighter_b_name}
            />
          ) : null}

          <dl className="mt-10 grid grid-cols-3 gap-4">
            <div className="rounded-md border border-foreground/10 bg-background-elevated/30 px-4 py-3">
              <dt className="font-sans text-[10px] uppercase tracking-widest text-foreground-subtle">
                Volume
              </dt>
              <dd className="mt-1 font-display text-xl tabular text-foreground">
                {market.total_volume.toLocaleString()}
              </dd>
            </div>
            <div className="rounded-md border border-foreground/10 bg-background-elevated/30 px-4 py-3">
              <dt className="font-sans text-[10px] uppercase tracking-widest text-foreground-subtle">
                Traders
              </dt>
              <dd className="mt-1 font-display text-xl tabular text-foreground">
                {market.unique_traders}
              </dd>
            </div>
            <div className="rounded-md border border-foreground/10 bg-background-elevated/30 px-4 py-3">
              <dt className="font-sans text-[10px] uppercase tracking-widest text-foreground-subtle">
                Closes
              </dt>
              <dd className="mt-1 font-mono text-xs tabular text-foreground">
                {new Date(market.closes_at).toLocaleString("en-US", {
                  month: "short",
                  day: "numeric",
                  hour: "numeric",
                  minute: "2-digit",
                })}
              </dd>
            </div>
          </dl>
        </Container>
      </main>
      <Footer />
    </>
  );
}

const METHOD_SUB_LABELS = ["by KO/TKO", "by Submission", "by Decision"];

function FighterOutcomesPanel({
  fighterName,
  outcomes,
}: {
  fighterName: string;
  outcomes: Array<{
    id: string;
    label: string;
    order_index: number;
    current_price: number;
    current_shares: number;
  }>;
}) {
  return (
    <div className="rounded-md border border-foreground/10 bg-background-elevated/30 p-4">
      <p className="font-display text-lg uppercase tracking-tight text-foreground">
        {fighterName}
      </p>
      <div className="mt-3 flex flex-col gap-3">
        {outcomes.map((o, i) => (
          <div
            key={o.id}
            className="rounded-sm border border-foreground/10 bg-foreground/[0.04] px-3 py-2"
          >
            <p className="font-sans text-[10px] uppercase tracking-widest text-foreground-subtle">
              {METHOD_SUB_LABELS[i] ?? o.label}
            </p>
            <div className="mt-1 flex items-baseline justify-between gap-2">
              <p className="font-display text-2xl tabular text-foreground">
                {(o.current_price * 100).toFixed(1)}
                <span className="text-xs text-foreground-muted">%</span>
                <span className="ml-2 font-mono text-xs tabular text-primary">
                  {priceToDecimalOdds(o.current_price)}x
                </span>
              </p>
              <p className="font-mono text-[10px] tabular text-foreground-subtle">
                {o.current_shares.toFixed(1)} sh
              </p>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
