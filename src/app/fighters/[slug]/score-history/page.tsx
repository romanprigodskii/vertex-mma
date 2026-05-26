import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { ChevronLeft } from "lucide-react";

import { ScoreHistoryChart } from "@/components/fighter/detail/ScoreHistoryChart";
import { Container } from "@/components/layout/container";
import { Footer } from "@/components/layout/footer";
import { Navbar } from "@/components/layout/navbar";
import { getFighterBySlug } from "@/lib/fighter-detail";
import {
  getScoreHistory,
  type ScoreHistoryPoint,
} from "@/lib/score-history";

export const dynamic = "force-dynamic";

interface PageProps {
  params: Promise<{ slug: string }>;
}

export async function generateMetadata({
  params,
}: PageProps): Promise<Metadata> {
  const { slug } = await params;
  const fighter = await getFighterBySlug(slug);
  if (!fighter) return { title: "Score history not found" };
  return {
    title: `${fighter.name_en} · Vertex score history`,
    description: `Per-bout Vertex Score trajectory for ${fighter.name_en}.`,
  };
}

const METHOD_SHORT: Record<string, string> = {
  ko: "KO",
  tko: "TKO",
  submission: "Sub",
  decision_unanimous: "U-Dec",
  decision_split: "S-Dec",
  decision_majority: "M-Dec",
  draw: "Draw",
  no_contest: "NC",
  dq: "DQ",
};

function methodLabel(method: string | null): string {
  if (!method) return "—";
  return METHOD_SHORT[method] ?? method;
}

function resultClass(r: "W" | "L" | "D" | "NC"): string {
  if (r === "W") return "text-streak-win";
  if (r === "L") return "text-streak-loss";
  return "text-foreground-muted";
}

export default async function FighterScoreHistoryPage({
  params,
}: PageProps) {
  const { slug } = await params;
  const fighter = await getFighterBySlug(slug);
  if (!fighter) notFound();

  const history = await getScoreHistory(fighter.id);

  return (
    <>
      <Navbar />
      <main className="flex-1">
        <div className="border-b border-foreground/[0.06]">
          <Container size="xl" className="py-3">
            <Link
              href={`/fighters/${fighter.slug}`}
              className="inline-flex items-center gap-1.5 font-sans text-sm text-foreground-muted transition-colors hover:text-primary"
            >
              <ChevronLeft className="h-4 w-4" aria-hidden />
              Back to {fighter.name_en}
            </Link>
          </Container>
        </div>

        <Container size="xl" className="py-10 md:py-14">
          <p className="font-mono text-[11px] uppercase tracking-[0.2em] text-foreground-subtle">
            {fighter.name_en} · Vertex history
          </p>
          <h1 className="mt-2 font-display uppercase tracking-tight text-foreground text-h1">
            Current score, fight by fight
          </h1>
          <p className="mt-2 max-w-xl font-sans text-sm text-foreground-muted">
            Replay of the current-Vertex formula at each completed UFC bout.
            Hover the chart for the bout that locked in each value. All-time
            score per bout is a separate backfill — not wired up yet.
          </p>

          <div className="mt-8 rounded-lg border border-foreground/10 bg-background-elevated/20 p-4 sm:p-6">
            <ScoreHistoryChart history={history} />
          </div>

          {history.length > 0 ? (
            <HistoryTable history={history} />
          ) : (
            <p className="mt-8 font-sans text-sm text-foreground-muted">
              No replay data — this fighter has fewer than three completed
              UFC bouts, so the formula has nothing to anchor on yet.
            </p>
          )}
        </Container>
      </main>
      <Footer />
    </>
  );
}

function HistoryTable({ history }: { history: ScoreHistoryPoint[] }) {
  // Most-recent first reads better in a list view; chart stays oldest→newest.
  const rows = [...history].reverse();
  return (
    <div className="mt-10">
      <h2 className="mb-4 font-sans text-[11px] font-medium uppercase tracking-widest text-foreground-subtle">
        Bouts
      </h2>
      <ul className="divide-y divide-foreground/[0.06] rounded-md border border-foreground/10 bg-background-elevated/20">
        {rows.map((p, i) => {
          const prevValue =
            i === rows.length - 1 ? null : rows[i + 1].currentScore;
          const delta = prevValue != null ? p.currentScore - prevValue : null;
          return (
            <li
              key={p.boutId}
              className="flex flex-wrap items-baseline gap-x-4 gap-y-1 px-4 py-3 sm:px-5"
            >
              <span className="font-display tabular text-2xl leading-none text-foreground sm:text-3xl">
                {p.currentScore}
              </span>
              {delta != null && delta !== 0 ? (
                <span
                  className={
                    "font-mono text-xs tabular " +
                    (delta > 0 ? "text-streak-win" : "text-streak-loss")
                  }
                >
                  {delta > 0 ? `+${delta}` : delta}
                </span>
              ) : null}
              <span className="font-sans text-sm text-foreground-muted">
                <span className={resultClass(p.result)}>{p.result}</span>{" "}
                vs{" "}
                <Link
                  href={`/fighters/${p.opponentSlug}`}
                  className="text-foreground transition-colors hover:text-primary"
                >
                  {p.opponentName}
                </Link>
                <span className="text-foreground-subtle">
                  {" · "}
                  {methodLabel(p.method)}
                </span>
              </span>
              <span className="ml-auto font-mono text-[11px] tabular text-foreground-subtle">
                {p.eventDate}
              </span>
            </li>
          );
        })}
      </ul>
    </div>
  );
}
