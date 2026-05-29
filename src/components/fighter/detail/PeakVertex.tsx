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
    anchorBout,
    lastPeakBout,
    peakBoutCount,
    endingBout,
    currentScore,
  } = info;
  const delta = currentScore != null ? currentScore - peak : null;
  const isAtPeak = endingBout == null;
  const heldAcrossBouts = peakBoutCount > 1;
  const dateRange = heldAcrossBouts
    ? `${peakDate} → ${lastPeakBout.eventDate}`
    : peakDate;

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
          {delta != null && delta !== 0 ? (
            <span
              className={
                "font-sans text-xs " +
                (delta > 0 ? "text-streak-win" : "text-foreground-muted")
              }
            >
              {t("deltaVsCurrent", {
                delta: delta > 0 ? `+${delta}` : String(delta),
              })}
            </span>
          ) : delta === 0 ? (
            <span className="font-sans text-xs text-foreground-muted">
              {t("atPeakNow")}
            </span>
          ) : null}
        </div>

        <div className="min-w-[200px] flex-1 space-y-2 font-sans text-sm">
          <div>
            <span className="text-[11px] uppercase tracking-widest text-foreground-subtle">
              {heldAcrossBouts ? t("from") : t("after")}
            </span>
            <span className="ml-2 text-foreground-muted">
              <ResultPill result={anchorBout.result} />
              <span className="ml-1.5">{t("vs")}</span>{" "}
              <Link
                href={`/fighters/${anchorBout.opponentSlug}`}
                className="text-foreground transition-colors hover:text-primary"
              >
                {anchorBout.opponentName}
              </Link>
              <span className="text-foreground-subtle">
                {" · "}
                {methodLabel(anchorBout.method)}
              </span>
            </span>
          </div>

          {heldAcrossBouts ? (
            <div>
              <span className="text-[11px] uppercase tracking-widest text-foreground-subtle">
                {t("through")}
              </span>
              <span className="ml-2 text-foreground-muted">
                <ResultPill result={lastPeakBout.result} />
                <span className="ml-1.5">{t("vs")}</span>{" "}
                <Link
                  href={`/fighters/${lastPeakBout.opponentSlug}`}
                  className="text-foreground transition-colors hover:text-primary"
                >
                  {lastPeakBout.opponentName}
                </Link>
                <span className="text-foreground-subtle">
                  {" · "}
                  {methodLabel(lastPeakBout.method)}
                </span>
              </span>
            </div>
          ) : null}

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
            // No bout ended the peak — but the live score can still have eased
            // below it via inactivity / time-decay. Only claim "still at peak"
            // when the current score actually equals the peak.
            currentScore != null && delta != null && delta < 0 ? (
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
