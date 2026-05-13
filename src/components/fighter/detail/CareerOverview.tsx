import type { FighterDetail } from "@/lib/fighter-detail";
import { formatNumber } from "@/lib/format";

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

export function CareerOverview({ fighter }: CareerOverviewProps) {
  const ufcWins = fighter.ufc_wins;
  const koBreakdown = ufcWins
    ? `KO/TKO ${fighter.ufc_wins_ko} · Sub ${fighter.ufc_wins_sub} · Dec ${fighter.ufc_wins_dec}`
    : null;

  const lastFight = fighter.last_fight_date
    ? {
        date: fighter.last_fight_date.slice(0, 10),
        result: fighter.last_fight_result ?? "—",
        method: fighter.last_fight_method
          ? METHOD_SHORT[fighter.last_fight_method] ?? fighter.last_fight_method
          : null,
      }
    : null;

  return (
    <dl className="flex flex-col">
      <StatRow
        label="UFC wins"
        value={formatNumber(ufcWins)}
        detail={koBreakdown}
      />
      <StatRow
        label="UFC losses"
        value={formatNumber(fighter.ufc_losses)}
      />
      {fighter.ufc_draws > 0 ? (
        <StatRow label="UFC draws" value={formatNumber(fighter.ufc_draws)} />
      ) : null}
      {fighter.ufc_no_contests > 0 ? (
        <StatRow
          label="UFC no contests"
          value={formatNumber(fighter.ufc_no_contests)}
        />
      ) : null}
      <StatRow
        label="UFC bouts"
        value={formatNumber(fighter.ufc_total)}
        detail={
          fighter.bout_count > fighter.ufc_total
            ? `${formatNumber(fighter.bout_count)} career`
            : null
        }
      />
      {lastFight ? (
        <StatRow
          label="Last fight"
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
