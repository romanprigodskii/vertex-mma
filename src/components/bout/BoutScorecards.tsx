import type { BoutScorecardJudge } from "@/lib/bout-detail";
import { cn } from "@/lib/utils";

interface BoutScorecardsProps {
  scorecards: BoutScorecardJudge[];
  fighterAName: string;
  fighterBName: string;
  fighterAId: string;
  winnerId: string | null;
}

function lastNameOnly(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  return parts[parts.length - 1] ?? name;
}

export function BoutScorecards({
  scorecards,
  fighterAName,
  fighterBName,
  fighterAId,
  winnerId,
}: BoutScorecardsProps) {
  if (scorecards.length === 0) return null;

  const labelA = lastNameOnly(fighterAName);
  const labelB = lastNameOnly(fighterBName);

  return (
    <section aria-label="Judges' scorecards">
      <h2 className="mb-4 font-sans text-[11px] font-medium uppercase tracking-widest text-foreground-muted">
        Judges&apos; scorecards
      </h2>
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
        {scorecards.map((judge) => {
          const aHigher = judge.total_a > judge.total_b;
          const bHigher = judge.total_b > judge.total_a;
          // "Agreed" = this judge's higher-total side matches the actual
          // winner. Highlight the card border green when so.
          const agreed =
            winnerId != null &&
            ((winnerId === fighterAId && aHigher) ||
              (winnerId !== fighterAId && bHigher));
          return (
            <JudgeCard
              key={judge.judge_name}
              judge={judge}
              labelA={labelA}
              labelB={labelB}
              agreed={agreed}
            />
          );
        })}
      </div>
    </section>
  );
}

function JudgeCard({
  judge,
  labelA,
  labelB,
  agreed,
}: {
  judge: BoutScorecardJudge;
  labelA: string;
  labelB: string;
  agreed: boolean;
}) {
  const aWon = judge.total_a > judge.total_b;
  const bWon = judge.total_b > judge.total_a;
  return (
    <article
      className={cn(
        "rounded-md border bg-background-elevated/30 p-4",
        agreed ? "border-streak-win/30" : "border-foreground/10",
      )}
    >
      <p className="mb-3 font-sans text-[11px] uppercase tracking-widest text-foreground">
        {judge.judge_name}
      </p>
      <table className="w-full">
        <thead>
          <tr className="border-b border-foreground/10">
            <th className="py-1 text-left font-sans text-[10px] font-medium uppercase tracking-widest text-foreground-subtle">
              Round
            </th>
            <th className="py-1 text-right font-sans text-[10px] font-medium uppercase tracking-widest text-foreground-subtle">
              {labelA}
            </th>
            <th className="py-1 text-right font-sans text-[10px] font-medium uppercase tracking-widest text-foreground-subtle">
              {labelB}
            </th>
          </tr>
        </thead>
        <tbody>
          {judge.rounds.map((r) => (
            <tr key={r.round} className="border-b border-foreground/[0.05]">
              <td className="py-1.5 font-mono text-xs tabular text-foreground-muted">
                R{r.round}
              </td>
              <td
                className={cn(
                  "py-1.5 text-right font-mono text-sm tabular",
                  r.fighter_a_score > r.fighter_b_score
                    ? "font-medium text-foreground"
                    : "text-foreground-muted",
                )}
              >
                {r.fighter_a_score}
              </td>
              <td
                className={cn(
                  "py-1.5 text-right font-mono text-sm tabular",
                  r.fighter_b_score > r.fighter_a_score
                    ? "font-medium text-foreground"
                    : "text-foreground-muted",
                )}
              >
                {r.fighter_b_score}
              </td>
            </tr>
          ))}
        </tbody>
        <tfoot>
          <tr>
            <td className="pt-3 text-left font-sans text-[10px] uppercase tracking-widest text-foreground">
              Total
            </td>
            <td
              className={cn(
                "pt-3 text-right font-sans font-bold text-lg tabular",
                aWon ? "text-streak-win" : "text-foreground",
              )}
            >
              {judge.total_a}
            </td>
            <td
              className={cn(
                "pt-3 text-right font-sans font-bold text-lg tabular",
                bWon ? "text-streak-win" : "text-foreground",
              )}
            >
              {judge.total_b}
            </td>
          </tr>
        </tfoot>
      </table>
    </article>
  );
}
