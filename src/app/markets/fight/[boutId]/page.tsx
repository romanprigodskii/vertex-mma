import Link from "next/link";
import { notFound } from "next/navigation";
import { ChevronLeft } from "lucide-react";

import { Container } from "@/components/layout/container";
import { Footer } from "@/components/layout/footer";
import { Navbar } from "@/components/layout/navbar";
import { MarketSection } from "@/components/markets/market-section";
import { SportsbookConsensus } from "@/components/markets/sportsbook-consensus";
import { getBoutExternalOdds, getFightMarkets } from "@/lib/markets";

export const dynamic = "force-dynamic";

interface PageProps {
  params: Promise<{ boutId: string }>;
}

export async function generateMetadata({ params }: PageProps) {
  const { boutId } = await params;
  const fight = await getFightMarkets(boutId);
  if (!fight) return { title: "Fight not found" };
  const title = `${fight.fighter_a_name} vs ${fight.fighter_b_name}`;
  return {
    title: `${title} · Markets`,
    description: `Betting markets for ${title} — ${fight.event_name}.`,
  };
}

export default async function FightMarketsPage({ params }: PageProps) {
  const { boutId } = await params;
  const fight = await getFightMarkets(boutId);
  if (!fight) notFound();

  const externalOdds = await getBoutExternalOdds(fight.bout_id);
  const tag = fight.is_main_event
    ? "Main event"
    : fight.is_co_main_event
      ? "Co-main"
      : null;

  return (
    <>
      <Navbar />
      <main className="flex-1">
        <div className="border-b border-foreground/[0.06]">
          <Container size="md" className="py-3">
            <Link
              href="/markets"
              className="inline-flex items-center gap-1.5 font-sans text-sm text-foreground-muted hover:text-primary"
            >
              <ChevronLeft className="h-4 w-4" aria-hidden /> All markets
            </Link>
          </Container>
        </div>

        <Container size="md" className="py-10 md:py-14">
          <p className="font-mono text-[11px] uppercase tracking-[0.2em] text-foreground-subtle">
            <Link
              href={`/events/${fight.event_slug}`}
              className="hover:text-foreground"
            >
              {fight.event_name}
            </Link>
            {" · "}
            {new Date(fight.event_date).toLocaleDateString("en-US", {
              month: "long",
              day: "numeric",
              year: "numeric",
            })}
          </p>
          <h1
            className="mt-3 font-display uppercase tracking-tight text-foreground"
            style={{ fontSize: "clamp(28px, 4vw, 48px)" }}
          >
            {fight.fighter_a_name}{" "}
            <span className="text-foreground-subtle">vs</span>{" "}
            {fight.fighter_b_name}
          </h1>
          <p className="mt-2 font-mono text-[11px] uppercase tracking-widest text-foreground-subtle">
            {tag ? `${tag} · ` : ""}
            {fight.weight_class.replace(/_/g, " ")}
            {fight.is_title_fight ? " · Title fight" : ""}
          </p>

          <div className="mt-8 rounded-md border border-foreground/10 bg-background-elevated/30 px-4">
            {fight.markets.map((m) => (
              <MarketSection key={m.id} market={m} defaultOpen />
            ))}
          </div>
          <p className="mt-2 font-sans text-[11px] text-foreground-subtle">
            Tap any odds to place a bet.
          </p>

          {externalOdds ? (
            <SportsbookConsensus
              odds={externalOdds}
              marketType="winner"
              fighterAName={fight.fighter_a_name}
              fighterBName={fight.fighter_b_name}
            />
          ) : null}
        </Container>
      </main>
      <Footer />
    </>
  );
}
