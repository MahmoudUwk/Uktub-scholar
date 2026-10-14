/**
 * Acceptance decisions and power planning for the bad-row rate (PLAN.md rev 3, section 4.7).
 *
 * Estimand: pooled bad-row rate = total bad cited units / total cited units over notes.
 * Rate CIs: (1) note-cluster percentile bootstrap (10,000 replicates, seeded PRNG);
 * (2) linearized (delta-method) ratio standard error with a Student t(n-1) quantile.
 * FDR interval: Korn-Graubard, i.e. Clopper-Pearson at effective n = n / DEFF.
 * Simulation: beta-binomial method-of-moments fit; note sizes resampled from observed
 * sizes; per-note p drawn from a Beta with the target mean and fitted overdispersion.
 * Agreement: positive agreement on bad, Cohen's kappa, observed agreement, rate gap.
 *
 *   node scripts/live/analysis.ts simulate --counts <file.json> [--reps N] [--seed S]
 *   node scripts/live/analysis.ts agreement --a <labels.json> --b <labels.json>
 *
 * Numerics (incomplete beta, Student t, Clopper-Pearson) are implemented here from
 * standard references (Numerical Recipes betacf/betai); no new dependencies.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";

export interface NoteCount {
  id: string;
  /** Bad cited units (unsupported + wrong + misattributed). */
  bad: number;
  /** Cited units graded. */
  rows: number;
}

export interface RateCI {
  pooled: number;
  lower: number;
  upper: number;
}

export interface GradeLabel {
  note: string;
  unit: string;
  bad: boolean;
}

// Numerics: regularized incomplete beta and inverses.

function lgamma(x: number): number {
  const c = [
    0.99999999999980993, 676.5203681218851, -1259.1392167224028, 771.32342877765313,
    -176.61502916214059, 12.507343278686905, -0.13857109526572012, 9.9843695780195716e-6,
    1.5056327351493116e-7,
  ];
  if (x < 0.5) return Math.log(Math.PI / Math.sin(Math.PI * x)) - lgamma(1 - x);
  const y = x - 1;
  let a = c[0] ?? 0;
  for (let i = 1; i < 9; i++) a += (c[i] ?? 0) / (y + i);
  const t = y + 7.5;
  return 0.5 * Math.log(2 * Math.PI) + (y + 0.5) * Math.log(t) - t + Math.log(a);
}

function betacf(a: number, b: number, x: number): number {
  const maxIt = 200;
  const eps = 3e-14;
  const fpmin = 1e-300;
  const qab = a + b;
  const qap = a + 1;
  const qam = a - 1;
  let c = 1;
  let d = 1 - (qab * x) / qap;
  if (Math.abs(d) < fpmin) d = fpmin;
  d = 1 / d;
  let h = d;
  for (let m = 1; m <= maxIt; m++) {
    const m2 = 2 * m;
    let aa = (m * (b - m) * x) / ((qam + m2) * (a + m2));
    d = 1 + aa * d;
    if (Math.abs(d) < fpmin) d = fpmin;
    c = 1 + aa / c;
    if (Math.abs(c) < fpmin) c = fpmin;
    d = 1 / d;
    h *= d * c;
    aa = (-(a + m) * (qab + m) * x) / ((a + m2) * (qap + m2));
    d = 1 + aa * d;
    if (Math.abs(d) < fpmin) d = fpmin;
    c = 1 + aa / c;
    if (Math.abs(c) < fpmin) c = fpmin;
    d = 1 / d;
    const del = d * c;
    h *= del;
    if (Math.abs(del - 1) < eps) break;
  }
  return h;
}

/** Regularized incomplete beta I_x(a, b) for a, b > 0 and x in [0, 1]. */
function betai(a: number, b: number, x: number): number {
  if (x <= 0) return 0;
  if (x >= 1) return 1;
  const bt = Math.exp(lgamma(a + b) - lgamma(a) - lgamma(b) + a * Math.log(x) + b * Math.log(1 - x));
  if (x < (a + 1) / (a + b + 2)) return (bt * betacf(a, b, x)) / a;
  return 1 - (bt * betacf(b, a, 1 - x)) / b;
}

/** Inverse of betai by bisection: smallest y with I_y(a, b) >= p. */
function betaInv(p: number, a: number, b: number): number {
  if (p <= 0) return 0;
  if (p >= 1) return 1;
  let lo = 0;
  let hi = 1;
  for (let i = 0; i < 200; i++) {
    const mid = (lo + hi) / 2;
    if (betai(a, b, mid) < p) lo = mid;
    else hi = mid;
  }
  return (lo + hi) / 2;
}

/** Upper-tail Student t quantile: t with P(T <= t) = p, df >= 1. */
export function tQuantile(p: number, df: number): number {
  if (!(df >= 1) || !(p > 0 && p < 1)) throw new Error(`tQuantile needs p in (0,1), df >= 1 (got p=${p}, df=${df})`);
  if (p === 0.5) return 0;
  if (p > 0.5) {
    const x = betaInv(2 * (1 - p), df / 2, 0.5);
    return Math.sqrt((df * (1 - x)) / x);
  }
  return -tQuantile(1 - p, df);
}

/** Two-sided Clopper-Pearson interval at level 1 - alpha; x may be fractional (effective counts). */
export function clopperPearson(x: number, n: number, alpha = 0.05): { lower: number; upper: number } {
  if (!(n > 0) || x < 0 || x > n) throw new Error(`clopperPearson needs 0 <= x <= n, n > 0 (got x=${x}, n=${n})`);
  const lower = x <= 0 ? 0 : betaInv(alpha / 2, x, n - x + 1);
  const upper = x >= n ? 1 : betaInv(1 - alpha / 2, x + 1, n - x);
  return { lower, upper };
}

/** Deterministic PRNG (mulberry32). */
export function mulberry32(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function checkNotes(notes: NoteCount[]): void {
  if (notes.length === 0) throw new Error("need at least one note");
  for (const n of notes) {
    if (!Number.isInteger(n.bad) || !Number.isInteger(n.rows) || n.bad < 0 || n.rows < 1 || n.bad > n.rows) {
      throw new Error(`invalid note ${JSON.stringify(n)}: need integers with 0 <= bad <= rows, rows >= 1`);
    }
  }
}

/** Pooled bad-row rate = total bad / total rows. */
export function pooledRate(notes: NoteCount[]): number {
  checkNotes(notes);
  let bad = 0;
  let rows = 0;
  for (const n of notes) {
    bad += n.bad;
    rows += n.rows;
  }
  return bad / rows;
}

/**
 * Linearized (delta-method) ratio standard error over note clusters:
 * se^2 = sum((y_i - p x_i)^2) / ((n - 1) (n xbar)^2 ... ), i.e. s_e^2 / (n xbar^2).
 */
export function linearizedSE(notes: NoteCount[]): { pooled: number; se: number } {
  checkNotes(notes);
  const pooled = pooledRate(notes);
  const n = notes.length;
  if (n < 2) return { pooled, se: 0 };
  let rows = 0;
  for (const note of notes) rows += note.rows;
  const xbar = rows / n;
  let s = 0;
  for (const note of notes) {
    const e = note.bad - pooled * note.rows;
    s += e * e;
  }
  return { pooled, se: Math.sqrt(s / (n - 1) / n) / xbar };
}

/** Linearized 95% CI: pooled +/- t(n-1) se, clamped to [0, 1]. */
export function linearizedCI(notes: NoteCount[], alpha = 0.05): RateCI & { se: number } {
  const { pooled, se } = linearizedSE(notes);
  const margin = notes.length < 2 ? 0 : tQuantile(1 - alpha / 2, notes.length - 1) * se;
  return { pooled, se, lower: Math.max(0, pooled - margin), upper: Math.min(1, pooled + margin) };
}

export interface BootstrapOptions {
  replicates?: number;
  seed?: number;
}

/** Note-cluster percentile bootstrap CI (default 10,000 replicates, fixed seed). */
export function bootstrapCI(notes: NoteCount[], opts?: BootstrapOptions): RateCI {
  checkNotes(notes);
  const replicates = opts?.replicates ?? 10000;
  const rand = mulberry32(opts?.seed ?? 20261014);
  const pooled = pooledRate(notes);
  const k = notes.length;
  const stats = new Array<number>(replicates);
  for (let r = 0; r < replicates; r++) {
    let bad = 0;
    let rows = 0;
    for (let i = 0; i < k; i++) {
      const note = notes[Math.floor(rand() * k)] as NoteCount;
      bad += note.bad;
      rows += note.rows;
    }
    stats[r] = bad / rows;
  }
  stats.sort((a, b) => a - b);
  const q = (p: number): number => stats[Math.min(replicates - 1, Math.floor(p * replicates))] as number;
  return { pooled, lower: q(0.025), upper: q(0.975) };
}

/**
 * Design effect: linearized cluster variance over the SRS variance p(1-p)/N.
 * Floored at 1; exactly 1 when nothing is bad (SRS variance is 0 there).
 */
export function deff(notes: NoteCount[]): number {
  const { pooled, se } = linearizedSE(notes);
  let rows = 0;
  let bad = 0;
  for (const n of notes) {
    rows += n.rows;
    bad += n.bad;
  }
  if (bad === 0 || pooled <= 0 || pooled >= 1) return 1;
  return Math.max(1, (se * se) / ((pooled * (1 - pooled)) / rows));
}

/**
 * Korn-Graubard interval for clustered promotions: Clopper-Pearson at
 * n_eff = N / DEFF, x_eff = pooled * n_eff. Pass promoted counts as notes
 * (bad = false promotions, rows = promotions); the raw rate is what gates.
 */
export function kornGraubard(notes: NoteCount[], alpha = 0.05): RateCI {
  checkNotes(notes);
  const pooled = pooledRate(notes);
  let rows = 0;
  for (const n of notes) rows += n.rows;
  const nEff = rows / deff(notes);
  const xEff = pooled * nEff;
  const cp = clopperPearson(xEff, nEff, alpha);
  return { pooled, lower: cp.lower, upper: cp.upper };
}

/** OD1 acceptance: pooled <= 0.05 and the two-sided 95% CI upper bound <= 0.10. */
export function passesOD1(pooled: number, upper: number): boolean {
  return pooled <= 0.05 && upper <= 0.1;
}

// Beta-binomial fit and simulation.

export interface BetaBinomialFit {
  /** Mean of the per-note rates. */
  mean: number;
  /** Overdispersion rho in [0, 1): per-note p ~ Beta with alpha+beta = 1/rho - 1. */
  rho: number;
  alpha: number;
  beta: number;
}

/**
 * Method-of-moments beta-binomial fit on per-note rates p_i = bad_i / rows_i.
 * rho = vBeta / (m (1 - m)) where vBeta is the sample variance of the p_i minus
 * the expected binomial sampling variance m (1 - m) mean(1 / rows_i): the
 * simulation draws bad ~ Binomial(rows, p) on top, so the fit must net that out.
 */
export function fitBetaBinomial(notes: NoteCount[]): BetaBinomialFit {
  checkNotes(notes);
  const ps = notes.map((n) => n.bad / n.rows);
  const mean = ps.reduce((a, p) => a + p, 0) / ps.length;
  let v = 0;
  if (ps.length > 1) {
    let s = 0;
    for (const p of ps) s += (p - mean) * (p - mean);
    v = s / (ps.length - 1);
  }
  let inv = 0;
  for (const n of notes) inv += 1 / n.rows;
  inv /= notes.length;
  const vBeta = Math.max(0, v - mean * (1 - mean) * inv);
  const denom = mean * (1 - mean);
  const rho = denom <= 0 ? 0 : Math.min(0.99, vBeta / denom);
  const total = rho <= 0 ? 0 : 1 / rho - 1;
  return { mean, rho, alpha: mean * total, beta: (1 - mean) * total };
}

function randn(rand: () => number): number {
  const u1 = Math.max(rand(), 1e-12);
  const u2 = rand();
  return Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
}

function randGamma(shape: number, rand: () => number): number {
  if (shape <= 0) return 0;
  if (shape < 1) return randGamma(shape + 1, rand) * Math.pow(rand(), 1 / shape);
  const d = shape - 1 / 3;
  const c = 1 / Math.sqrt(9 * d);
  for (;;) {
    const x = randn(rand);
    let v = 1 + c * x;
    if (v <= 0) continue;
    v = v * v * v;
    const u = rand();
    if (u < 1 - 0.0331 * x * x * x * x) return d * v;
    if (Math.log(u) < 0.5 * x * x + d * (1 - v + Math.log(v))) return d * v;
  }
}

function randBeta(alpha: number, beta: number, rand: () => number): number {
  const g1 = randGamma(alpha, rand);
  const g2 = randGamma(beta, rand);
  return g1 + g2 <= 0 ? alpha / (alpha + beta) : g1 / (g1 + g2);
}

function randBinomial(n: number, p: number, rand: () => number): number {
  let x = 0;
  for (let i = 0; i < n; i++) if (rand() < p) x++;
  return x;
}

export interface SimulateOptions {
  reps?: number;
  seed?: number;
  rates?: number[];
  ns?: number[];
  deltas?: number[];
  bootReplicates?: number;
}

export interface CoverageRow {
  method: "bootstrap" | "linearized";
  rate: number;
  n: number;
  coverage: number;
}

export interface PassRow {
  method: "bootstrap" | "linearized";
  rate: number;
  n: number;
  pPass: number;
}

export interface ABSizeRow {
  delta: number;
  nPerArm: number | null;
  power: number;
}

export interface SimulateResult {
  observed: { notes: number; bad: number; rows: number; pooled: number };
  fit: BetaBinomialFit;
  params: { reps: number; seed: number; rates: number[]; ns: number[]; deltas: number[] };
  coverage: CoverageRow[];
  pPass: PassRow[];
  /** n per arm so the 95% upper bound of the C1-C0 difference is < delta with 80% power at true difference 0. */
  abSize: ABSizeRow[];
  /** Common true rate used for both A/B arms (the fitted pooled mean). */
  abCommonRate: number;
}

/**
 * Simulate the PLAN 4.7 outputs: (1) CI coverage, (2) OD1 P(pass) on the
 * rate x n grid, (3) A/B n per arm per delta. One PRNG stream in fixed loop
 * order, so the result is deterministic given the seed.
 */
export function simulate(counts: NoteCount[], opts?: SimulateOptions): SimulateResult {
  checkNotes(counts);
  const reps = opts?.reps ?? 200;
  const seed = opts?.seed ?? 20261014;
  const rates = opts?.rates ?? [0.02, 0.03, 0.04, 0.05, 0.06, 0.07, 0.08];
  const ns = opts?.ns ?? [12, 15, 20, 25];
  const deltas = opts?.deltas ?? [0.02, 0.03, 0.04, 0.05];
  const bootReplicates = opts?.bootReplicates ?? 10000;
  const rand = mulberry32(seed);
  const fit = fitBetaBinomial(counts);
  const sizes = counts.map((n) => n.rows);
  const total = fit.rho <= 0 ? 0 : 1 / fit.rho - 1;

  const drawBatch = (rate: number, n: number): NoteCount[] => {
    const alpha = rate * total;
    const beta = (1 - rate) * total;
    return Array.from({ length: n }, (_, i) => {
      const rows = sizes[Math.floor(rand() * sizes.length)] as number;
      const p = total <= 0 ? rate : randBeta(alpha, beta, rand);
      return { id: `sim${i}`, bad: randBinomial(rows, p, rand), rows };
    });
  };

  let bad = 0;
  let rows = 0;
  for (const n of counts) {
    bad += n.bad;
    rows += n.rows;
  }

  const coverage: CoverageRow[] = [];
  const pPass: PassRow[] = [];
  for (const rate of rates) {
    for (const n of ns) {
      let covB = 0;
      let covL = 0;
      let passB = 0;
      let passL = 0;
      for (let r = 0; r < reps; r++) {
        const batch = drawBatch(rate, n);
        const b = bootstrapCI(batch, { replicates: bootReplicates, seed: Math.floor(rand() * 2 ** 31) });
        const l = linearizedCI(batch);
        if (b.lower <= rate && rate <= b.upper) covB++;
        if (l.lower <= rate && rate <= l.upper) covL++;
        if (passesOD1(b.pooled, b.upper)) passB++;
        if (passesOD1(l.pooled, l.upper)) passL++;
      }
      coverage.push({ method: "bootstrap", rate, n, coverage: covB / reps });
      coverage.push({ method: "linearized", rate, n, coverage: covL / reps });
      pPass.push({ method: "bootstrap", rate, n, pPass: passB / reps });
      pPass.push({ method: "linearized", rate, n, pPass: passL / reps });
    }
  }

  // A/B sizing at true difference 0, both arms at the fitted pooled mean.
  const abCommonRate = bad / rows;
  const diffUpperBelow = (nPerArm: number, delta: number): number => {
    let hits = 0;
    for (let r = 0; r < reps; r++) {
      const c0 = drawBatch(abCommonRate, nPerArm);
      const c1 = drawBatch(abCommonRate, nPerArm);
      const s0 = linearizedSE(c0);
      const s1 = linearizedSE(c1);
      const diff = s1.pooled - s0.pooled;
      const se = Math.sqrt(s0.se * s0.se + s1.se * s1.se);
      const upper = diff + tQuantile(0.975, 2 * nPerArm - 2) * se;
      if (upper < delta) hits++;
    }
    return hits / reps;
  };
  const abSize: ABSizeRow[] = deltas.map((delta) => {
    for (let nPerArm = 2; nPerArm <= 400; nPerArm++) {
      const power = diffUpperBelow(nPerArm, delta);
      if (power >= 0.8) return { delta, nPerArm, power };
    }
    return { delta, nPerArm: null, power: diffUpperBelow(400, delta) };
  });

  return {
    observed: { notes: counts.length, bad, rows, pooled: bad / rows },
    fit,
    params: { reps, seed, rates, ns, deltas },
    coverage,
    pPass,
    abSize,
    abCommonRate,
  };
}

// Grader agreement.

export interface AgreementResult {
  n: number;
  a: number;
  b: number;
  c: number;
  d: number;
  paBad: number;
  kappa: number;
  observed: number;
  rateA: number;
  rateB: number;
  gap: number;
}

/**
 * Agreement on paired binary labels. a = both bad, b = A-only, c = B-only,
 * d = neither. PA_bad = 2a/(2a+b+c); kappa is reported only (unstable when
 * bad is rare); gap = |pooled A - pooled B|.
 */
export function agreement(aLabels: GradeLabel[], bLabels: GradeLabel[]): AgreementResult {
  const key = (l: GradeLabel): string => `${l.note} ${l.unit}`;
  const bMap = new Map<string, boolean>();
  for (const l of bLabels) {
    if (bMap.has(key(l))) throw new Error(`duplicate unit ${key(l)} in B labels`);
    bMap.set(key(l), l.bad);
  }
  let a = 0;
  let b = 0;
  let c = 0;
  let d = 0;
  const seen = new Set<string>();
  for (const l of aLabels) {
    const k = key(l);
    if (seen.has(k)) throw new Error(`duplicate unit ${k} in A labels`);
    seen.add(k);
    const bb = bMap.get(k);
    if (bb === undefined) throw new Error(`unit ${k} has no B label`);
    if (l.bad && bb) a++;
    else if (l.bad) b++;
    else if (bb) c++;
    else d++;
  }
  if (seen.size !== bMap.size) throw new Error(`label sets differ: A has ${seen.size} units, B has ${bMap.size}`);
  const n = a + b + c + d;
  const paBad = 2 * a + b + c === 0 ? 1 : (2 * a) / (2 * a + b + c);
  const observed = (a + d) / n;
  const expected = ((a + b) * (a + c) + (c + d) * (b + d)) / (n * n);
  const kappa = expected >= 1 ? 1 : (observed - expected) / (1 - expected);
  const rateA = (a + b) / n;
  const rateB = (a + c) / n;
  return { n, a, b, c, d, paBad, kappa, observed, rateA, rateB, gap: Math.abs(rateA - rateB) };
}

// CLI.

function readJson(path: string): unknown {
  return JSON.parse(readFileSync(path, "utf8")) as unknown;
}

function parseCounts(raw: unknown): NoteCount[] {
  if (!Array.isArray(raw)) throw new Error("counts file must be a JSON array of { id, bad, rows }");
  return raw.map((e, i) => {
    const r = e as { id?: unknown; bad?: unknown; rows?: unknown };
    return {
      id: typeof r.id === "string" ? r.id : `note${i}`,
      bad: r.bad as number,
      rows: r.rows as number,
    };
  });
}

function parseLabels(raw: unknown): GradeLabel[] {
  if (!Array.isArray(raw)) throw new Error("labels file must be a JSON array of { note, unit, bad }");
  return raw.map((e) => {
    const r = e as { note?: unknown; unit?: unknown; bad?: unknown };
    if (typeof r.note !== "string" || typeof r.unit !== "string" || typeof r.bad !== "boolean") {
      throw new Error(`invalid label ${JSON.stringify(e)}: need { note: string, unit: string, bad: boolean }`);
    }
    return { note: r.note, unit: r.unit, bad: r.bad };
  });
}

const usage = [
  "usage:",
  "  node scripts/live/analysis.ts simulate --counts <file.json> [--reps N] [--seed S]",
  "  node scripts/live/analysis.ts agreement --a <labels.json> --b <labels.json>",
].join("\n");

const argv = process.argv.slice(2);
const cmd = argv[0];
// The CLI dispatches only when this module is the entry point: importers (e.g. grade.ts,
// which has its own `agreement` subcommand) share process.argv and must not trigger it.
const isMain = process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain && (cmd === "simulate" || cmd === "agreement")) {
  const flag = (name: string): string | undefined => {
    const i = argv.indexOf(name);
    return i >= 0 && i + 1 < argv.length ? argv[i + 1] : undefined;
  };
  if (cmd === "simulate") {
    const countsPath = flag("--counts");
    if (countsPath === undefined) throw new Error(`${usage}\nmissing --counts`);
    const repsArg = flag("--reps");
    const seedArg = flag("--seed");
    const result = simulate(parseCounts(readJson(countsPath)), {
      ...(repsArg === undefined ? {} : { reps: Number(repsArg) }),
      ...(seedArg === undefined ? {} : { seed: Number(seedArg) }),
    });
    process.stdout.write(`${JSON.stringify(result)}\n`);
  } else {
    const aPath = flag("--a");
    const bPath = flag("--b");
    if (aPath === undefined || bPath === undefined) throw new Error(`${usage}\nmissing --a/--b`);
    process.stdout.write(`${JSON.stringify(agreement(parseLabels(readJson(aPath)), parseLabels(readJson(bPath))))}\n`);
  }
} else if (isMain) {
  throw new Error(usage);
}
