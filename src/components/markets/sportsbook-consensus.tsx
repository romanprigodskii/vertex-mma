import type { BoutExternalOddsRow } from "@/lib/markets";

interface Props {
  odds: BoutExternalOddsRow;
  marketType: string;
  fighterAName: string;
  fighterBName: string;
}

function lastName(full: string): string {
  const parts = full.trim().split(/\s+/);
  return parts[parts.length - 1] ?? full;
}

function impliedPct(decimal: number | null): string {
  if (!decimal || decimal <= 1) return "—";
  return `${(100 / decimal).toFixed(0)}%`;
}

function pairImpliedPct(
  a: number | null,
  b: number | null,
  side: "a" | "b",
): string {
  // Show vig-free implied % for two-outcome moneyline so the displayed
  // numbers actually add up to 100. Each individual cell still also
  // shows raw decimal for transparency.
  if (!a || !b || a <= 1 || b <= 1) return "—";
  const raw = side === "a" ? 1 / a : 1 / b;
  const total = 1 / a + 1 / b;
  return `${((raw / total) * 100).toFixed(0)}%`;
}

function relativeHours(iso: string): string {
  const ms = Date.now() - new Date(iso).getTime();
  if (!Number.isFinite(ms) || ms < 0) return "just now";
  const hours = Math.floor(ms / 3_600_000);
  if (hours < 1) return "just now";
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}

export function SportsbookConsensus({
  odds,
  marketType,
  fighterAName,
  fighterBName,
}: Props) {
  const isMethod = marketType === "method";
  const hasMethodOdds =
    odds.method_a_kotko_decimal != null ||
    odds.method_a_sub_decimal != null ||
    odds.method_a_dec_decimal != null;

  return (
    <section className="mt-8 rounded-md border border-foreground/10 bg-background-elevated/20 p-4">
      <div className="flex items-baseline justify-between gap-2">
        <h3 className="font-sans text-[11px] font-medium uppercase tracking-widest text-foreground-muted">
          Sportsbook consensus
        </h3>
        <p className="font-mono text-[10px] tabular text-foreground-subtle">
          {odds.source} · {relativeHours(odds.fetched_at)}
        </p>
      </div>

      {isMethod ? (
        hasMethodOdds ? (
          <div className="mt-3 grid grid-cols-2 gap-3">
            <FighterMethodOdds
              name={fighterAName}
              kotko={odds.method_a_kotko_decimal}
              sub={odds.method_a_sub_decimal}
              dec={odds.method_a_dec_decimal}
            />
            <FighterMethodOdds
              name={fighterBName}
              kotko={odds.method_b_kotko_decimal}
              sub={odds.method_b_sub_decimal}
              dec={odds.method_b_dec_decimal}
            />
          </div>
        ) : (
          <p className="mt-3 font-sans text-xs text-foreground-subtle">
            Per-method consensus not available for this bout.
          </p>
        )
      ) : (
        <div className="mt-3 grid grid-cols-2 gap-3">
          <WinnerCell
            name={fighterAName}
            decimal={odds.winner_a_decimal}
            impliedNoVig={pairImpliedPct(
              odds.winner_a_decimal,
              odds.winner_b_decimal,
              "a",
            )}
          />
          <WinnerCell
            name={fighterBName}
            decimal={odds.winner_b_decimal}
            impliedNoVig={pairImpliedPct(
              odds.winner_a_decimal,
              odds.winner_b_decimal,
              "b",
            )}
          />
        </div>
      )}

      <p className="mt-3 font-sans text-[11px] text-foreground-subtle">
        Implied probability with sportsbook overround removed. Reference
        only — Vertex market prices come from user trades via LMSR and can
        drift away from consensus.
      </p>
    </section>
  );
}

function WinnerCell({
  name,
  decimal,
  impliedNoVig,
}: {
  name: string;
  decimal: number | null;
  impliedNoVig: string;
}) {
  return (
    <div className="rounded-sm border border-foreground/10 bg-foreground/[0.04] px-3 py-2">
      <p className="truncate font-mono text-[10px] uppercase tracking-widest text-foreground-subtle">
        {lastName(name)}
      </p>
      <p className="font-display text-xl tabular text-foreground">
        {impliedNoVig}
      </p>
      <p className="font-mono text-[10px] tabular text-foreground-subtle">
        {decimal ? decimal.toFixed(2) : "—"} dec
      </p>
    </div>
  );
}

function FighterMethodOdds({
  name,
  kotko,
  sub,
  dec,
}: {
  name: string;
  kotko: number | null;
  sub: number | null;
  dec: number | null;
}) {
  return (
    <div className="rounded-sm border border-foreground/10 bg-foreground/[0.04] px-3 py-2">
      <p className="truncate font-mono text-[10px] uppercase tracking-widest text-foreground-subtle">
        {lastName(name)}
      </p>
      <div className="mt-1 flex flex-col gap-1">
        {[
          { label: "KO/TKO", v: kotko },
          { label: "Sub", v: sub },
          { label: "Dec", v: dec },
        ].map((r) => (
          <div
            key={r.label}
            className="flex items-baseline justify-between"
          >
            <span className="font-mono text-[10px] uppercase tracking-widest text-foreground-subtle">
              {r.label}
            </span>
            <span className="font-display text-sm tabular text-foreground">
              {impliedPct(r.v)}
            </span>
          </div>
        ))}
      </div>
    </div>
  );
}
