import { getTranslations } from "next-intl/server";

import { Link } from "@/i18n/navigation";
import type { PeakVertexInfo } from "@/lib/score-history";

function ResultPill({ result }: { result: "W" | "L" | "D" | "NC" }) {
  const cls =
    result === "W"
      ? "text-streak-win"
      : result === "L"
        ? "text-streak-loss"
        : "text-foreground-muted";
  return <span className={cls}>{result}</span>;
}

interface PeakVertexProps {
  info: PeakVertexInfo;
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

export async function PeakVertex({ info }: PeakVertexProps) {
  const t = await getTranslations("peakVertex");
  const tHistory = await getTranslations("scoreHistory");
  function methodLabel(method: string | null): string {
    if (!method) return "—";
    const key = METHOD_KEY[method];
    if (!key) return method;
    return tHistory(key as "methodKo");
  }
  const {
    peak,
    peakDate,
    lastPeakBout,
    peakBoutCount,
    peakBouts,
    endingBout,
    currentScore,
  } = info;
  const delta = currentScore != null ? currentScore - peak : null;
  const isAtPeak = endingBout == null;
  const heldAcrossBouts = peakBoutCount > 1;
  const dateRange = heldAcrossBouts
    ? `${peakDate} → ${lastPeakBout.eventDate}`
    : peakDate;
  // ±4 tolerance — within 4 points of peak still reads as "at peak" rather
  // than rendering a noisy "-2 vs current" while also claiming "still at peak".
  const AT_PEAK_TOLERANCE = 4;
  const isCurrentAtPeak = delta != null && delta >= -AT_PEAK_TOLERANCE;

  return (
    <section
      aria-label={t("aria")}
      className="rounded-md border border-foreground/10 bg-background-elevated/30 p-4 sm:p-5"
    >
      <div className="mb-3 flex items-baseline justify-between gap-3">
        <h3 className="font-sans text-[11px] font-medium uppercase tracking-widest text-foreground-subtle">
          {t("heading")}
        </h3>
        <span className="font-mono text-[10px] uppercase tracking-widest text-foreground-subtle">
          {dateRange}
        </span>
      </div>

      <div className="flex flex-wrap items-end gap-x-6 gap-y-3">
        <div className="flex items-baseline gap-2">
          <span className="font-display tabular text-5xl leading-none text-foreground">
            {peak}
          </span>
          {heldAcrossBouts ? (
            <span className="font-sans text-xs text-foreground-muted">
              {t("heldNBouts", { n: peakBoutCount })}
            </span>
          ) : null}
          {delta != null && !isCurrentAtPeak ? (
            <span className="font-sans text-xs text-foreground-muted">
              {t("deltaVsCurrent", { delta: String(delta) })}
            </span>
          ) : delta != null ? (
            <span className="font-sans text-xs text-foreground-muted">
              {t("atPeakNow")}
            </span>
          ) : null}
        </div>

        <div className="min-w-[200px] flex-1 space-y-2 font-sans text-sm">
          <div>
            <span className="text-[11px] uppercase tracking-widest text-foreground-subtle">
              {heldAcrossBouts ? t("boutsAtPeak") : t("after")}
            </span>
            <ul className="mt-1 space-y-1.5">
              {peakBouts.map((b) => (
                <li key={b.id} className="text-foreground-muted">
                  <ResultPill result={b.result} />
                  <span className="ml-1.5">{t("vs")}</span>{" "}
                  <Link
                    href={`/fighters/${b.opponentSlug}`}
                    className="text-foreground transition-colors hover:text-primary"
                  >
                    {b.opponentName}
                  </Link>
                  <span className="text-foreground-subtle">
                    {" · "}
                    {methodLabel(b.method)}
                    {heldAcrossBouts ? ` · ${b.eventDate}` : ""}
                  </span>
                </li>
              ))}
            </ul>
          </div>

          {endingBout ? (
            <div>
              <span className="text-[11px] uppercase tracking-widest text-foreground-subtle">
                {t("ended")}
              </span>
              <span className="ml-2 text-foreground-muted">
                <ResultPill result={endingBout.result} />
                <span className="ml-1.5">{t("vs")}</span>{" "}
                <Link
                  href={`/fighters/${endingBout.opponentSlug}`}
                  className="text-foreground transition-colors hover:text-primary"
                >
                  {endingBout.opponentName}
                </Link>
                <span className="text-foreground-subtle">
                  {" · "}
                  {methodLabel(endingBout.method)} · {endingBout.eventDate}
                  {" · "}
                  <span className="text-foreground-muted">
                    {t("scoreAfter", { score: endingBout.scoreAfter })}
                  </span>
                </span>
              </span>
            </div>
          ) : isAtPeak ? (
            // No bout ended the peak — but live score can have eased below it
            // via inactivity / time-decay. Treat within ±AT_PEAK_TOLERANCE as
            // still at peak; only flag "softened" once the gap exceeds it.
            currentScore != null && !isCurrentAtPeak ? (
              <div className="text-[11px] uppercase tracking-widest text-foreground-subtle">
                {t("softenedSincePeak")}
              </div>
            ) : (
              <div className="text-[11px] uppercase tracking-widest text-streak-win">
                {currentScore != null ? t("stillAtPeak") : t("retiredAtPeak")}
              </div>
            )
          ) : null}
        </div>
      </div>
    </section>
  );
}
