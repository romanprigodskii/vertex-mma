/**
 * Wave 6E: fair per-round UI display helpers.
 *
 * Two structural biases the raw bout_round_stats rows would produce if the UI
 * averaged them naively:
 *
 *  1. Bouts that ended in an earlier round contribute *partial* round stats
 *     (a 30-second R1 KO contributes 30s of activity). Averaging them
 *     alongside full 5-minute rounds understates the fighter's per-round rate
 *     on rounds they actually finished.
 *
 *  2. Career-wide "R3 average" must use a denominator that only counts bouts
 *     where R3 actually happened — not every bout in the career.
 *
 * The helpers below address both: `proRateToFullRound` scales a partial
 * round's stat up to its 5-minute equivalent, and `careerRoundAverage`
 * combines pro-rating with the correct denominator.
 */
const FULL_ROUND_SECONDS = 300;

/**
 * Convert a raw round counter into a 5-minute equivalent. For the round that
 * ended in a finish, scales the stat up proportionally (10 strikes in 90s →
 * 33.3 strikes-per-5min). For full rounds (round < roundFinished, or any
 * round when scheduled rounds completed cleanly), returns the raw stat
 * unchanged.
 *
 * `roundIndex` and `roundFinished` are 1-indexed (matching `bout.round_finished`).
 * `timeFinishedSeconds` is the absolute time INTO the finishing round.
 */
export function proRateToFullRound(
  rawStat: number,
  roundIndex: number,
  roundFinished: number | null,
  timeFinishedSeconds: number | null,
): number {
  if (roundFinished == null || roundIndex !== roundFinished) return rawStat;
  if (timeFinishedSeconds == null || timeFinishedSeconds <= 0) return rawStat;
  if (timeFinishedSeconds >= FULL_ROUND_SECONDS) return rawStat;
  return (rawStat * FULL_ROUND_SECONDS) / timeFinishedSeconds;
}

export interface RoundEntry {
  stat: number;
  roundIndex: number;
  roundFinished: number | null;
  timeFinishedSeconds: number | null;
}

/**
 * Career average of a per-round stat for a specific round, accounting for
 * which bouts actually reached that round and pro-rating finishing rounds
 * up to a 5-minute equivalent.
 *
 * The denominator is the number of entries the caller passes in — i.e. the
 * call site is responsible for filtering `entries` to rows where the round
 * actually happened (typically that's already true if entries come from
 * `bout_round_stats`, which only stores rounds that occurred).
 *
 * Returns 0 when the entry list is empty.
 */
export function careerRoundAverage(
  entries: ReadonlyArray<RoundEntry>,
  roundIndex: number,
): number {
  const relevant = entries.filter((e) => e.roundIndex === roundIndex);
  if (relevant.length === 0) return 0;
  let total = 0;
  for (const e of relevant) {
    total += proRateToFullRound(
      e.stat,
      e.roundIndex,
      e.roundFinished,
      e.timeFinishedSeconds,
    );
  }
  return total / relevant.length;
}
