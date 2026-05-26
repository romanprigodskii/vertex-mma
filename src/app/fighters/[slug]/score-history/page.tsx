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

type Mode = "current" | "all_time";

interface PageProps {
  params: Promise<{ slug: string }>;
  searchParams: Promise<{ mode?: string }>;
}

function resolveMode(raw: string | undefined): Mode {
  return raw === "all_time" ? "all_time" : "current";
}

export async function generateMetadata({
  params,
  searchParams,
}: PageProps): Promise<Metadata> {
  const { slug } = await params;
  const fighter = await getFighterBySlug(slug);
  if (!fighter) return { title: "Score history not found" };
  const { mode: rawMode } = await searchParams;
  const mode = resolveMode(rawMode);
  const label = mode === "current" ? "Current" : "All-Time";
  return {
    title: `${fighter.name_en} · ${label} Vertex history`,
    description: `Per-bout ${label.toLowerCase()} Vertex Score trajectory for ${fighter.name_en}.`,
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
  searchParams,
}: PageProps) {
  const { slug } = await params;
  const fighter = await getFighterBySlug(slug);
  if (!fighter) notFound();
  const { mode: rawMode } = await searchParams;
  const mode = resolveMode(rawMode);

  const history = await getScoreHistory(fighter.id);
  const modeHistory =
    mode === "all_time"
      ? history.filter((p) => p.allTimeScore != null)
      : history;

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
            {mode === "current"
              ? "Current score, fight by fight"
              : "All-time score, fight by fight"}
          </h1>
          <p className="mt-2 max-w-xl font-sans text-sm text-foreground-muted">
            {mode === "current"
              ? "Replay of the current-Vertex formula at each completed UFC bout. Hover the chart for the bout that locked in each value."
              : "Replay of the all-time legacy formula at each bout — quality wins, championship pedigree, era dominance, performance, finishing, career peak, minus weighted losses."}
          </p>

          <div className="mt-6 inline-flex rounded-md border border-foreground/15 bg-background-elevated/30 p-0.5">
            <ModeTab
              slug={fighter.slug}
              mode="current"
              active={mode === "current"}
            />
            <ModeTab
              slug={fighter.slug}
              mode="all_time"
              active={mode === "all_time"}
            />
          </div>

          <div className="mt-8 rounded-lg border border-foreground/10 bg-background-elevated/20 p-4 sm:p-6">
            <ScoreHistoryChart history={history} mode={mode} />
          </div>

          {modeHistory.length > 0 ? (
            <HistoryTable history={modeHistory} mode={mode} />
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

function ModeTab({
  slug,
  mode,
  active,
}: {
  slug: string;
  mode: Mode;
  active: boolean;
}) {
  const label = mode === "current" ? "Current" : "All-Time";
  return (
    <Link
      href={`/fighters/${slug}/score-history?mode=${mode}`}
      prefetch={false}
      className={
        "rounded-sm px-4 py-1.5 font-sans text-[11px] uppercase tracking-widest transition-colors " +
        (active
          ? "bg-foreground/[0.08] text-foreground"
          : "text-foreground-muted hover:text-foreground")
      }
      aria-current={active ? "page" : undefined}
    >
      {label}
    </Link>
  );
}

function HistoryTable({
  history,
  mode,
}: {
  history: ScoreHistoryPoint[];
  mode: Mode;
}) {
  // Most-recent first reads better in a list view; chart stays oldest→newest.
  const rows = [...history].reverse();
  return (
    <div className="mt-10">
      <h2 className="mb-4 font-sans text-[11px] font-medium uppercase tracking-widest text-foreground-subtle">
        Bouts
      </h2>
      <ul className="divide-y divide-foreground/[0.06] rounded-md border border-foreground/10 bg-background-elevated/20">
        {rows.map((p, i) => {
          const value =
            mode === "current" ? p.currentScore : p.allTimeScore ?? 0;
          const prevPoint = i === rows.length - 1 ? null : rows[i + 1];
          const prevValue =
            prevPoint == null
              ? null
              : mode === "current"
                ? prevPoint.currentScore
                : prevPoint.allTimeScore;
          const delta = prevValue != null ? value - prevValue : null;
          return (
            <li
              key={p.boutId}
              className="flex flex-wrap items-baseline gap-x-4 gap-y-1 px-4 py-3 sm:px-5"
            >
              <span className="font-display tabular text-2xl leading-none text-foreground sm:text-3xl">
                {value}
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
