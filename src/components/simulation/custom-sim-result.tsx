import { getTranslations } from "next-intl/server";

import { FighterAvatar } from "@/components/fighter/FighterAvatar";
import { Link } from "@/i18n/navigation";
import {
  reconcileMcMethodProbs,
  type BoutSimulationRounds,
} from "@/lib/bout-simulation";
import type { CustomSimResult, CustomSimSide } from "@/lib/custom-simulation";
import { isRuLocale } from "@/lib/i18n-name";
import { cn } from "@/lib/utils";

interface CustomSimResultPanelProps {
  result: CustomSimResult;
  modelVersion: string | null;
}

function fmtPct(v: number): string {
  return `${Math.round(v * 100)}%`;
}

function fmtClock(seconds: number | null): string | null {
  if (seconds == null) return null;
  const total = Math.round(seconds);
  const within = ((total - 1) % 300) + 1; // seconds into the finishing round
  const round = Math.floor((total - 1) / 300) + 1;
  const m = Math.floor(within / 60);
  const s = within % 60;
  return `R${round} · ${m}:${String(s).padStart(2, "0")}`;
}

/** Scored dream-fight panel: winner bar, reconciled method split, finish-
 *  round strip. All MC numbers are rescaled to the ensemble winner prob
 *  (same reconciliation contract as BoutSimulationPanel — the raw MC winner
 *  attribution is diagnostic only). */
export async function CustomSimResultPanel({
  result,
  modelVersion,
}: CustomSimResultPanelProps) {
  const t = await getTranslations("customSim");
  const tWeight = await getTranslations("weight");
  const isRu = await isRuLocale();
  const nameOf = (s: CustomSimSide) =>
    isRu && s.name_ru ? s.name_ru : s.name_en;

  const probA = result.prob_a;
  const probB = result.prob_b;
  const winnerIsA = probA >= 0.5;
  const mc = result.mc;
  // Adapt the jsonb payload to the shared reconciliation helper's shape;
  // only the six method fields are read by it.
  const reconciled = reconcileMcMethodProbs(
    {
      probKoA: mc.prob_ko_a,
      probKoB: mc.prob_ko_b,
      probSubA: mc.prob_sub_a,
      probSubB: mc.prob_sub_b,
      probDecisionA: mc.prob_decision_a,
      probDecisionB: mc.prob_decision_b,
    } as BoutSimulationRounds,
    probA,
  );
  const decisionTotal = reconciled.probDecisionA + reconciled.probDecisionB;
  // Rescale the raw per-round finish curve so the strip shares the
  // reconciled denominator (same trick as BoutSimulationPanel).
  const rawRounds = [1, 2, 3, 4, 5].map(
    (r) => mc.finish_round[String(r)] ?? 0,
  ) as number[];
  const rawFinishSum = rawRounds.reduce((s, v) => s + (v ?? 0), 0);
  const finishScale =
    rawFinishSum > 1e-6 ? (1 - decisionTotal) / rawFinishSum : 0;
  const roundCells = rawRounds.map((v) => (v ?? 0) * finishScale);
  const maxCell = Math.max(...roundCells, decisionTotal, 1e-6);

  const wcKey = result.context.weight_class as "lightweight";
  const wcLabel = tWeight.has(wcKey)
    ? tWeight(wcKey)
    : result.context.weight_class;

  return (
    <div className="overflow-hidden rounded-lg border border-foreground/10 bg-background-elevated/30">
      {/* Sides */}
      <div className="grid grid-cols-1 gap-4 border-b border-foreground/10 p-4 sm:grid-cols-[1fr_auto_1fr] sm:items-center sm:p-6">
        <SideCard
          side={result.a}
          name={nameOf(result.a)}
          alignEnd={false}
          winner={winnerIsA}
        />
        <div className="hidden select-none text-center font-display text-2xl uppercase text-foreground-subtle sm:block">
          vs
        </div>
        <SideCard
          side={result.b}
          name={nameOf(result.b)}
          alignEnd
          winner={!winnerIsA}
        />
      </div>

      {/* Winner probability bar */}
      <div className="border-b border-foreground/10 px-4 py-5 sm:px-6">
        <div className="mb-2 flex items-baseline justify-between font-display text-2xl uppercase tracking-tight sm:text-3xl">
          <span className={cn(winnerIsA ? "text-primary" : "text-foreground-muted")}>
            {fmtPct(probA)}
          </span>
          <span className="font-mono text-[10px] tracking-[0.2em] text-foreground-subtle">
            {t("winProbability")}
          </span>
          <span className={cn(!winnerIsA ? "text-primary" : "text-foreground-muted")}>
            {fmtPct(probB)}
          </span>
        </div>
        <div className="flex h-2.5 overflow-hidden rounded-full bg-background-base/60">
          <div
            className={cn("h-full", winnerIsA ? "bg-primary" : "bg-foreground/30")}
            style={{ width: `${probA * 100}%` }}
          />
          <div
            className={cn("h-full", !winnerIsA ? "bg-primary" : "bg-foreground/30")}
            style={{ width: `${probB * 100}%` }}
          />
        </div>
      </div>

      {/* Method split (reconciled) */}
      <div className="grid grid-cols-1 gap-4 border-b border-foreground/10 px-4 py-5 sm:grid-cols-2 sm:px-6">
        <MethodColumn
          heading={nameOf(result.a)}
          ko={reconciled.probKoA}
          sub={reconciled.probSubA}
          dec={reconciled.probDecisionA}
          labels={{ ko: t("byKo"), sub: t("bySub"), dec: t("byDec") }}
        />
        <MethodColumn
          heading={nameOf(result.b)}
          ko={reconciled.probKoB}
          sub={reconciled.probSubB}
          dec={reconciled.probDecisionB}
          labels={{ ko: t("byKo"), sub: t("bySub"), dec: t("byDec") }}
        />
      </div>

      {/* Finish-round strip */}
      <div className="border-b border-foreground/10 px-4 py-5 sm:px-6">
        <p className="mb-3 font-mono text-[10px] uppercase tracking-[0.2em] text-foreground-subtle">
          {t("finishRound")}
        </p>
        <div className="grid grid-cols-6 gap-1.5">
          {roundCells.map((v, i) => (
            <RoundCell key={i} label={`R${i + 1}`} value={v} max={maxCell} />
          ))}
          <RoundCell label={t("decisionShort")} value={decisionTotal} max={maxCell} />
        </div>
        {mc.avg_finish_seconds != null && 1 - decisionTotal > 0.05 && (
          <p className="mt-3 font-sans text-xs text-foreground-muted">
            {t("avgFinish", { clock: fmtClock(mc.avg_finish_seconds) ?? "—" })}
          </p>
        )}
      </div>

      {/* Meta + honesty */}
      <div className="px-4 py-4 sm:px-6">
        <p className="font-mono text-[10px] uppercase tracking-[0.2em] text-foreground-subtle">
          {wcLabel} · {t("roundsLabel", { n: result.context.scheduled_rounds })}
          {modelVersion ? ` · ${modelVersion}` : ""} ·{" "}
          {t("simCount", { n: mc.n })}
        </p>
        <p className="mt-2 max-w-2xl font-sans text-xs text-foreground-subtle">
          {t("disclaimer")}
        </p>
      </div>
    </div>
  );
}

async function SideCard({
  side,
  name,
  alignEnd,
  winner,
}: {
  side: CustomSimSide;
  name: string;
  alignEnd: boolean;
  winner: boolean;
}) {
  const t = await getTranslations("customSim");
  return (
    <div
      className={cn(
        "flex items-center gap-3",
        alignEnd && "sm:flex-row-reverse sm:text-right",
      )}
    >
      <FighterAvatar
        name={name}
        photoUrl={side.photo_thumbnail_url}
        size="lg"
        className="border-0"
      />
      <div className="min-w-0">
        <Link
          href={`/fighters/${side.slug}`}
          prefetch={false}
          className={cn(
            "block truncate font-display text-xl uppercase tracking-tight hover:text-primary sm:text-2xl",
            winner ? "text-foreground" : "text-foreground-muted",
          )}
        >
          {name}
        </Link>
        <p className="mt-0.5 font-mono text-[11px] uppercase tracking-wider text-foreground-subtle">
          {side.as_of_bout_id
            ? t("formAsOf", { date: side.as_of_date })
            : t("formCurrent")}{" "}
          · {side.record}
          {side.age != null ? ` · ${t("ageAt", { age: side.age })}` : ""}
          {side.vertex_score != null ? ` · VTX ${side.vertex_score}` : ""}
        </p>
      </div>
    </div>
  );
}

function MethodColumn({
  heading,
  ko,
  sub,
  dec,
  labels,
}: {
  heading: string;
  ko: number;
  sub: number;
  dec: number;
  labels: { ko: string; sub: string; dec: string };
}) {
  const rows = [
    { label: labels.ko, v: ko, cls: "bg-streak-loss/70" },
    { label: labels.sub, v: sub, cls: "bg-primary/70" },
    { label: labels.dec, v: dec, cls: "bg-foreground/30" },
  ];
  const max = Math.max(...rows.map((r) => r.v), 1e-6);
  return (
    <div>
      <p className="mb-2 truncate font-display text-sm uppercase tracking-tight text-foreground">
        {heading}
      </p>
      <div className="space-y-1.5">
        {rows.map((r) => (
          <div key={r.label} className="flex items-center gap-2">
            <span className="w-14 shrink-0 font-mono text-[10px] uppercase tracking-wider text-foreground-subtle">
              {r.label}
            </span>
            <div className="h-2 min-w-0 flex-1 rounded-full bg-background-base/60">
              <div
                className={cn("h-full rounded-full", r.cls)}
                style={{ width: `${(r.v / max) * 100}%` }}
              />
            </div>
            <span className="w-10 shrink-0 text-right font-mono text-[11px] tabular text-foreground-muted">
              {fmtPct(r.v)}
            </span>
          </div>
        ))}
      </div>
    </div>
  );
}

function RoundCell({
  label,
  value,
  max,
}: {
  label: string;
  value: number;
  max: number;
}) {
  return (
    <div className="flex flex-col items-center gap-1">
      <div className="flex h-16 w-full items-end rounded bg-background-base/60 p-0.5">
        <div
          className="w-full rounded-sm bg-primary/70"
          style={{ height: `${Math.max(3, (value / max) * 100)}%` }}
        />
      </div>
      <span className="font-mono text-[10px] uppercase text-foreground-subtle">
        {label}
      </span>
      <span className="font-mono text-[10px] tabular text-foreground-muted">
        {fmtPct(value)}
      </span>
    </div>
  );
}
