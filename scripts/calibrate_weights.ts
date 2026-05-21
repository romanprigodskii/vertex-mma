/**
 * Wave 56 — weight calibration via ridge regression.
 *
 * The current-score formula's 9 component weights were hand-tuned across
 * Waves 15-55. This regresses them against ground truth: the real UFC
 * top-15 (ranking_snapshot, latest date). For each ranked fighter we
 * have (9 component values from fighter_vertex_score, actual rank); a
 * random sample of active UNRANKED fighters gives negative examples.
 *
 *   target y = 25 - rank   (champion rank 0 → 25; rank 15 → 10;
 *                           unranked pinned at rank 22 → 3)
 *
 * Ridge: β = (XᵀX + λI)⁻¹ Xᵀy on standardised features (λ mild — the
 * point is a calibration read, not aggressive shrinkage). Reports each
 * component's data-optimal RELATIVE weight next to its hand-tuned
 * relative weight, plus R².
 *
 * This VALIDATES the current-score weights. The all-time weights have
 * no regression target — ranking_snapshot is current-form ground
 * truth, not all-time legacy — so they are out of scope here.
 *
 * Read-only. Prints a report; changes nothing.
 */
import { config } from "dotenv";
config({ path: ".env.local" });
import { install as installDnsFallback } from "../src/lib/dns-fallback";
installDnsFallback();
import postgres from "postgres";

const url = process.env.DATABASE_URL;
if (!url) throw new Error("DATABASE_URL not set");
const sql = postgres(url, { prepare: false, max: 3 });

// The 9 weighted current-score components, with their hand-tuned weight.
// Sign = direction in raw_current (penalties negative).
const COMPONENTS = [
  { key: "quality_wins_decayed", hand: 0.16 },
  { key: "current_cp", hand: 0.1 },
  { key: "era_dominance_current", hand: 0.06 },
  { key: "performance_diff_current", hand: 0.16 },
  { key: "finishing_dominance_decayed", hand: 0.1 },
  { key: "activity", hand: 0.12 },
  { key: "recent_form_score", hand: 0.18 },
  { key: "recent_loss_penalty", hand: -0.2 },
  { key: "defensive_vulnerability", hand: -0.1 },
] as const;
const P = COMPONENTS.length;

const UNRANKED_RANK = 22;
const RIDGE_LAMBDA = 1.0; // mild — on standardised features

// ── matrix helpers ──────────────────────────────────────────────────
function transpose(m: number[][]): number[][] {
  return m[0].map((_, j) => m.map((row) => row[j]));
}
function matMul(a: number[][], b: number[][]): number[][] {
  const n = a.length;
  const k = b.length;
  const p = b[0].length;
  const out = Array.from({ length: n }, () => new Array(p).fill(0));
  for (let i = 0; i < n; i++) {
    for (let x = 0; x < k; x++) {
      const aix = a[i][x];
      for (let j = 0; j < p; j++) out[i][j] += aix * b[x][j];
    }
  }
  return out;
}
function matVec(a: number[][], v: number[]): number[] {
  return a.map((row) => row.reduce((s, x, j) => s + x * v[j], 0));
}
/** Gauss-Jordan inverse of a square matrix. */
function inverse(m: number[][]): number[][] {
  const n = m.length;
  const a = m.map((row, i) => [
    ...row,
    ...Array.from({ length: n }, (_, j) => (i === j ? 1 : 0)),
  ]);
  for (let col = 0; col < n; col++) {
    let piv = col;
    for (let r = col + 1; r < n; r++) {
      if (Math.abs(a[r][col]) > Math.abs(a[piv][col])) piv = r;
    }
    [a[col], a[piv]] = [a[piv], a[col]];
    const d = a[col][col];
    if (Math.abs(d) < 1e-12) throw new Error("singular matrix");
    for (let j = 0; j < 2 * n; j++) a[col][j] /= d;
    for (let r = 0; r < n; r++) {
      if (r === col) continue;
      const f = a[r][col];
      for (let j = 0; j < 2 * n; j++) a[r][j] -= f * a[col][j];
    }
  }
  return a.map((row) => row.slice(n));
}

interface Row {
  features: number[];
  rank: number;
}

/** Largest eigenvalue of a symmetric matrix via power iteration. */
function largestEigenvalue(A: number[][]): number {
  const p = A.length;
  let v = new Array(p).fill(1 / Math.sqrt(p));
  let lambda = 1;
  for (let it = 0; it < 200; it++) {
    const Av = matVec(A, v);
    const norm = Math.sqrt(Av.reduce((s, x) => s + x * x, 0));
    if (norm < 1e-12) break;
    v = Av.map((x) => x / norm);
    lambda = norm;
  }
  return lambda;
}

/**
 * Ridge least-squares with per-coefficient sign constraints, via
 * projected gradient descent. signs[j] = +1 → β_j ≥ 0, -1 → β_j ≤ 0.
 * Minimises ½‖Xβ−y‖² + ½λ‖β‖². Used because the components have KNOWN
 * correct signs (penalties negative) — the unconstrained fit flips some
 * of them, which is a multicollinearity artifact, not real signal.
 * Step size = 1/λmax(XᵀX+λI) so it converges on collinear data.
 */
function solveConstrained(
  X: number[][],
  y: number[],
  lambda: number,
  signs: number[],
): number[] {
  const p = X[0].length;
  const Xt = transpose(X);
  const A = matMul(Xt, X);
  for (let j = 0; j < p; j++) A[j][j] += lambda;
  const b = matVec(Xt, y);
  const beta = new Array(p).fill(0);
  const lr = 1.0 / largestEigenvalue(A);
  for (let it = 0; it < 200000; it++) {
    const grad = matVec(A, beta).map((v, j) => v - b[j]);
    for (let j = 0; j < p; j++) {
      beta[j] -= lr * grad[j];
      if (signs[j] > 0 && beta[j] < 0) beta[j] = 0;
      if (signs[j] < 0 && beta[j] > 0) beta[j] = 0;
    }
  }
  return beta;
}

async function main() {
  const latest = (
    await sql<Array<{ d: string }>>`
      SELECT MAX(snapshot_date)::text AS d FROM ranking_snapshot
    `
  )[0].d.slice(0, 10);
  console.log(`Latest ranking snapshot: ${latest}`);

  const cols = COMPONENTS.map((c) => c.key);
  const colSql = sql.unsafe(cols.map((c) => `vs.${c}`).join(", "));

  // Ranked fighters — one row per fighter, best (lowest) rank if listed
  // in two divisions.
  const ranked = (await sql<Array<Record<string, number>>>`
    SELECT DISTINCT ON (vs.id)
      vs.id::text AS id, rs.rank, ${colSql}
    FROM ranking_snapshot rs
    JOIN fighter_vertex_score vs ON vs.id = rs.fighter_id
    WHERE rs.snapshot_date = ${latest}::date
      AND rs.fighter_id IS NOT NULL
      AND vs.raw_current IS NOT NULL
    ORDER BY vs.id, rs.rank ASC
  `) as unknown as Array<Record<string, number> & { rank: number }>;

  // Unranked negatives — active, scored, not in the latest snapshot.
  const unranked = (await sql<Array<Record<string, number>>>`
    SELECT vs.id::text AS id, ${colSql}
    FROM fighter_vertex_score vs
    JOIN fighter f ON f.id = vs.id
    WHERE vs.raw_current IS NOT NULL
      AND f.roster_status = 'active'
      AND NOT EXISTS (
        SELECT 1 FROM ranking_snapshot rs
        WHERE rs.snapshot_date = ${latest}::date AND rs.fighter_id = vs.id
      )
    ORDER BY random()
    LIMIT 220
  `) as unknown as Array<Record<string, number>>;

  const rows: Row[] = [];
  for (const r of ranked) {
    rows.push({ features: cols.map((c) => Number(r[c])), rank: r.rank });
  }
  for (const r of unranked) {
    rows.push({
      features: cols.map((c) => Number(r[c])),
      rank: UNRANKED_RANK,
    });
  }
  console.log(
    `Dataset: ${ranked.length} ranked + ${unranked.length} unranked = ${rows.length} rows, ${P} features.`,
  );

  // ── build X, y; standardise X, centre y ───────────────────────────
  const n = rows.length;
  const y = rows.map((r) => 25 - r.rank);
  const yMean = y.reduce((s, v) => s + v, 0) / n;
  const yc = y.map((v) => v - yMean);

  const means: number[] = [];
  const stds: number[] = [];
  for (let j = 0; j < P; j++) {
    const col = rows.map((r) => r.features[j]);
    const mean = col.reduce((s, v) => s + v, 0) / n;
    const variance = col.reduce((s, v) => s + (v - mean) ** 2, 0) / n;
    means.push(mean);
    stds.push(Math.sqrt(variance) || 1);
  }
  const X = rows.map((r) => r.features.map((v, j) => (v - means[j]) / stds[j]));

  // ── ridge: β = (XᵀX + λI)⁻¹ Xᵀy ────────────────────────────────────
  const Xt = transpose(X);
  const XtX = matMul(Xt, X);
  for (let j = 0; j < P; j++) XtX[j][j] += RIDGE_LAMBDA;
  const betaStd = matVec(inverse(XtX), matVec(Xt, yc));

  // R² on the fit.
  const yhat = matVec(X, betaStd).map((v) => v + yMean);
  const ssRes = y.reduce((s, v, i) => s + (v - yhat[i]) ** 2, 0);
  const ssTot = y.reduce((s, v) => s + (v - yMean) ** 2, 0);
  const r2 = 1 - ssRes / ssTot;

  // De-standardise: β per raw component point. Then normalise both the
  // fitted and the hand-tuned weights to a share of total |weight| so
  // they're comparable despite different y-scales.
  const betaRaw = betaStd.map((b, j) => b / stds[j]);
  const fitAbsSum = betaRaw.reduce((s, b) => s + Math.abs(b), 0);
  const handAbsSum = COMPONENTS.reduce((s, c) => s + Math.abs(c.hand), 0);

  console.log(`\nRidge λ=${RIDGE_LAMBDA}  ·  R² = ${r2.toFixed(3)}\n`);
  console.log(
    "component                      hand%   fit%   sign  note",
  );
  console.log("-".repeat(72));
  COMPONENTS.forEach((c, j) => {
    const handPct = (Math.abs(c.hand) / handAbsSum) * 100;
    const fitPct = (Math.abs(betaRaw[j]) / fitAbsSum) * 100;
    const handSign = Math.sign(c.hand);
    const fitSign = Math.sign(betaRaw[j]);
    const signOk = handSign === fitSign ? "ok" : "FLIP";
    const drift = fitPct - handPct;
    const note =
      signOk === "FLIP"
        ? "SIGN FLIP — collinearity artifact"
        : Math.abs(drift) >= 8
          ? `data wants ${drift > 0 ? "MORE" : "less"} weight`
          : "≈ in line";
    console.log(
      c.key.padEnd(30) +
        handPct.toFixed(1).padStart(5) +
        "  " +
        fitPct.toFixed(1).padStart(5) +
        "   " +
        (fitSign >= 0 ? "+" : "-") +
        "    " +
        note,
    );
  });

  // ── sign-constrained fit (penalties forced ≤ 0, positives ≥ 0) ─────
  const signs = COMPONENTS.map((c) => Math.sign(c.hand));
  const betaC = solveConstrained(X, yc, RIDGE_LAMBDA, signs);
  const yhatC = matVec(X, betaC).map((v) => v + yMean);
  const r2c =
    1 - y.reduce((s, v, i) => s + (v - yhatC[i]) ** 2, 0) / ssTot;
  const betaCRaw = betaC.map((b, j) => b / stds[j]);
  const fitCAbs = betaCRaw.reduce((s, b) => s + Math.abs(b), 0);

  console.log(
    `\nSign-constrained fit (known signs enforced)  ·  R² = ${r2c.toFixed(3)}\n`,
  );
  console.log("component                      hand%   fit%   note");
  console.log("-".repeat(72));
  COMPONENTS.forEach((c, j) => {
    const handPct = (Math.abs(c.hand) / handAbsSum) * 100;
    const fitPct = fitCAbs > 0 ? (Math.abs(betaCRaw[j]) / fitCAbs) * 100 : 0;
    const drift = fitPct - handPct;
    const note =
      fitPct < 1.5
        ? "≈0 — redundant given collinear peers"
        : Math.abs(drift) >= 8
          ? `data wants ${drift > 0 ? "MORE" : "less"} weight`
          : "≈ in line";
    console.log(
      c.key.padEnd(30) +
        handPct.toFixed(1).padStart(5) +
        "  " +
        fitPct.toFixed(1).padStart(5) +
        "   " +
        note,
    );
  });

  await sql.end();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
