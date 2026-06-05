import { getTranslations } from "next-intl/server";

import type { FighterDetail } from "@/lib/fighter-detail";
import { formatNumber } from "@/lib/format";

// DB method string → `method` namespace key (localized short labels).
// Mirrors ScoreHistoryChart's METHOD_KEY pattern so KO/Sub/Dec labels are
// translated everywhere instead of leaking hardcoded English into the RU UI.
const METHOD_KEY: Record<string, string> = {
  ko: "ko",
  tko: "tko",
  submission: "sub",
  decision_unanimous: "udec",
  decision_split: "sdec",
  decision_majority: "mdec",
  draw: "draw",
  no_contest: "nc",
  dq: "dq",
};

interface CareerOverviewProps {
  fighter: FighterDetail;
}

function StatRow({
  label,
  value,
  detail,
}: {
  label: string;
  value: React.ReactNode;
  detail?: React.ReactNode;
}) {
  return (
    <div className="flex items-baseline justify-between gap-4 border-b border-foreground/[0.06] py-2.5 last:border-b-0">
      <dt className="font-sans text-[11px] uppercase tracking-widest text-foreground-subtle">
        {label}
      </dt>
      <dd className="text-right">
        <span className="font-display tabular text-xl text-foreground">
          {value}
        </span>
        {detail ? (
          <span className="ml-2 font-sans text-[11px] text-foreground-muted">
            {detail}
          </span>
        ) : null}
      </dd>
    </div>
  );
}

export async function CareerOverview({ fighter }: CareerOverviewProps) {
  const t = await getTranslations("fighter");
  const tMethod = await getTranslations("method");
  const methodLabel = (method: string | null): string | null => {
    if (!method) return null;
    const key = METHOD_KEY[method];
    return key ? tMethod(key) : method;
  };
  const ufcWins = fighter.ufc_wins;
  // Finishes we know the method for vs. ones the scraper left as NULL.
  const knownFinishMethods = fighter.ufc_wins_ko + fighter.ufc_wins_sub;
  const unrecordedFinishes = Math.max(
    0,
    fighter.ufc_wins_finish - knownFinishMethods,
  );
  const koBreakdown = ufcWins
    ? unrecordedFinishes > 0
      ? t("winBreakdownWithOther", {
          ko: formatNumber(fighter.ufc_wins_ko),
          sub: formatNumber(fighter.ufc_wins_sub),
          dec: formatNumber(fighter.ufc_wins_dec),
          other: formatNumber(unrecordedFinishes),
        })
      : t("winBreakdown", {
          ko: formatNumber(fighter.ufc_wins_ko),
          sub: formatNumber(fighter.ufc_wins_sub),
          dec: formatNumber(fighter.ufc_wins_dec),
        })
    : null;

  const lastFight = fighter.last_fight_date
    ? {
        date: fighter.last_fight_date.slice(0, 10),
        result: fighter.last_fight_result ?? "—",
        method: methodLabel(fighter.last_fight_method),
      }
    : null;

  return (
    <dl className="flex flex-col">
      <StatRow
        label={t("ufcWins")}
        value={formatNumber(ufcWins)}
        detail={koBreakdown}
      />
      <StatRow
        label={t("ufcLosses")}
        value={formatNumber(fighter.ufc_losses)}
      />
      {fighter.ufc_draws > 0 ? (
        <StatRow label={t("ufcDraws")} value={formatNumber(fighter.ufc_draws)} />
      ) : null}
      {fighter.ufc_no_contests > 0 ? (
        <StatRow
          label={t("ufcNoContests")}
          value={formatNumber(fighter.ufc_no_contests)}
        />
      ) : null}
      <StatRow
        label={t("ufcBouts")}
        value={formatNumber(fighter.ufc_total)}
        detail={
          fighter.bout_count > fighter.ufc_total
            ? `${formatNumber(fighter.bout_count)}`
            : null
        }
      />
      {lastFight ? (
        <StatRow
          label={t("lastFightLabel")}
          value={lastFight.date}
          detail={
            <>
              <span
                className={
                  lastFight.result === "W"
                    ? "text-streak-win"
                    : lastFight.result === "L"
                      ? "text-streak-loss"
                      : ""
                }
              >
                {lastFight.result}
              </span>
              {lastFight.method ? (
                <span className="ml-1 text-foreground-muted">
                  · {lastFight.method}
                </span>
              ) : null}
            </>
          }
        />
      ) : null}
    </dl>
  );
}
