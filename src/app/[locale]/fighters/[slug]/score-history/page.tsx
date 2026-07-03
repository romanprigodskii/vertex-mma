import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { getTranslations, setRequestLocale } from "next-intl/server";
import { ChevronLeft } from "lucide-react";

import { ScoreHistoryChart } from "@/components/fighter/detail/ScoreHistoryChart";
import { Container } from "@/components/layout/container";
import { Footer } from "@/components/layout/footer";
import { Navbar } from "@/components/layout/navbar";
import { FighterSearchTrigger } from "@/components/search/fighter-search-palette";
import { Link } from "@/i18n/navigation";
import { getDivisionalScores, getFighterBySlug } from "@/lib/fighter-detail";
import {
  getScoreHistory,
  type ScoreHistoryPoint,
} from "@/lib/score-history";
import { headlineScore } from "@/lib/vertex-tier";

export const dynamic = "force-dynamic";

type Mode = "current" | "all_time";

interface PageProps {
  params: Promise<{ slug: string; locale: string }>;
  searchParams: Promise<{ mode?: string }>;
}

function resolveMode(raw: string | undefined): Mode {
  return raw === "all_time" ? "all_time" : "current";
}

export async function generateMetadata({
  params,
  searchParams,
}: PageProps): Promise<Metadata> {
  const { slug, locale } = await params;
  const t = await getTranslations({ locale, namespace: "scoreHistory" });
  const fighter = await getFighterBySlug(slug);
  if (!fighter) return { title: t("scoreHistoryNotFound") };
  const { mode: rawMode } = await searchParams;
  const mode = resolveMode(rawMode);
  const label = mode === "current" ? t("labelCurrent") : t("labelAllTime");
  const labelLower =
    mode === "current" ? t("labelCurrentLower") : t("labelAllTimeLower");
  return {
    title: t("metaTitle", { fighter: fighter.name_en, label }),
    description: t("metaDescription", {
      fighter: fighter.name_en,
      label: labelLower,
    }),
  };
}

const METHOD_KEY: Record<string, string> = {
  ko: "methodKo",
  tko: "methodTko",
  submission: "methodSub",
  decision_unanimous: "methodUDec",
  decision_split: "methodSDec",
  decision_majority: "methodMDec",
  draw: "methodDraw",
  no_contest: "methodNc",
  dq: "methodDq",
};

function resultClass(r: "W" | "L" | "D" | "NC" | null): string {
  if (r === "W") return "text-streak-win";
  if (r === "L") return "text-streak-loss";
  return "text-foreground-muted";
}

export default async function FighterScoreHistoryPage({
  params,
  searchParams,
}: PageProps) {
  const { slug, locale } = await params;
  setRequestLocale(locale);
  const t = await getTranslations("scoreHistory");
  const fighter = await getFighterBySlug(slug);
  if (!fighter) notFound();
  const { mode: rawMode } = await searchParams;
  const mode = resolveMode(rawMode);

  // Mirror the profile hero EXACTLY (Wave 14B.2): the octagon the user
  // clicked shows the divisional score when an in_active_ranking row
  // drives it, so the chart's right edge must show the same number —
  // fighter_score_history itself replays only the GLOBAL formula.
  const divisionalScores = await getDivisionalScores(fighter.id);
  const activeDivisionalRow = fighter.current_division
    ? divisionalScores.find(
        (d) =>
          d.division === fighter.current_division && d.in_active_ranking,
      ) ?? null
    : null;
  const heroHeadline = headlineScore({
    rosterStatus: fighter.roster_status,
    divisionalScore: activeDivisionalRow?.vertex_score ?? null,
    vertexScore: fighter.vertex_score,
    vertexScoreAllTime: fighter.vertex_score_all_time,
  });
  const history = await getScoreHistory(fighter.id, {
    liveCurrentScore:
      heroHeadline.basis === "all_time" ? null : heroHeadline.value,
  });
  const boutHistory = history.filter((p) => p.kind === "bout");
  const modeHistory =
    mode === "all_time"
      ? boutHistory.filter((p) => p.allTimeScore != null)
      : boutHistory;

  return (
    <>
      <Navbar />
      <main className="flex-1">
        <div className="border-b border-foreground/[0.06]">
          <Container
            size="xl"
            className="flex items-center justify-between gap-3 py-3"
          >
            <Link
              href={`/fighters/${fighter.slug}`}
              className="inline-flex items-center gap-1.5 font-sans text-sm text-foreground-muted transition-colors hover:text-primary"
            >
              <ChevronLeft className="h-4 w-4" aria-hidden />
              {t("backTo", { fighter: fighter.name_en })}
            </Link>
            <FighterSearchTrigger />
          </Container>
        </div>

        <Container size="xl" className="py-10 md:py-14">
          <p className="font-mono text-[11px] uppercase tracking-[0.2em] text-foreground-subtle">
            {t("kicker", { fighter: fighter.name_en })}
          </p>
          <h1 className="mt-2 font-display uppercase tracking-tight text-foreground text-h1">
            {mode === "current" ? t("headingCurrent") : t("headingAllTime")}
          </h1>
          <p className="mt-2 max-w-xl font-sans text-sm text-foreground-muted">
            {mode === "current" ? t("leadCurrent") : t("leadAllTime")}
          </p>
          {mode === "current" ? (
            <p className="mt-3 max-w-xl font-sans text-xs leading-relaxed text-foreground-subtle">
              {t("currentFormNote")}
            </p>
          ) : null}

          <div className="mt-6 inline-flex rounded-md border border-foreground/15 bg-background-elevated/30 p-0.5">
            <ModeTab
              slug={fighter.slug}
              mode="current"
              active={mode === "current"}
              label={t("labelCurrent")}
            />
            <ModeTab
              slug={fighter.slug}
              mode="all_time"
              active={mode === "all_time"}
              label={t("labelAllTime")}
            />
          </div>

          <div className="mt-8 rounded-lg border border-foreground/10 bg-background-elevated/20 p-4 sm:p-6">
            <ScoreHistoryChart history={history} mode={mode} />
          </div>

          {modeHistory.length > 0 ? (
            <HistoryTable history={modeHistory} mode={mode} />
          ) : (
            <p className="mt-8 font-sans text-sm text-foreground-muted">
              {t("noReplay")}
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
  label,
}: {
  slug: string;
  mode: Mode;
  active: boolean;
  label: string;
}) {
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

async function HistoryTable({
  history,
  mode,
}: {
  history: ScoreHistoryPoint[];
  mode: Mode;
}) {
  const t = await getTranslations("scoreHistory");
  function methodLabel(method: string | null): string {
    if (!method) return "—";
    const key = METHOD_KEY[method];
    if (!key) return method;
    return t(key as "methodKo");
  }
  const rows = [...history].reverse();
  return (
    <div className="mt-10">
      <h2 className="mb-4 font-sans text-[11px] font-medium uppercase tracking-widest text-foreground-subtle">
        {t("boutsHeading")}
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
              key={p.key}
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
                {t("vsLabel")}{" "}
                {p.opponentSlug ? (
                  <Link
                    href={`/fighters/${p.opponentSlug}`}
                    className="text-foreground transition-colors hover:text-primary"
                  >
                    {p.opponentName}
                  </Link>
                ) : (
                  <span className="text-foreground">{p.opponentName}</span>
                )}
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
