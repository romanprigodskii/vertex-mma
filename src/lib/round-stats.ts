/**
 * Wave 6E: fair per-round UI display helper.
 *
 * Raw bout_round_stats rows would mislead the UI if averaged naively: bouts
 * that ended in an earlier round contribute *partial* round stats (a 30-second
 * R1 KO contributes 30s of activity). Averaging those alongside full 5-minute
 * rounds understates the fighter's per-round rate on rounds they actually
 * finished. `proRateToFullRound` scales a partial finishing round's stat up to
 * its 5-minute equivalent so the per-round display is comparable.
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
