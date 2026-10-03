/**
 * Claim verification (KTD1, KTD6): does a passage entail a claim? Engine-
 * agnostic core — an engine adapter turns (claim, chunk) rows into P(entailed)
 * probabilities; the verdict layer maps probability + threshold to
 * supported / refuted / unverified. The first engine (Julia-1, a 144M
 * encoder) was measured on 2026-10-02 and FAILED the discrimination bar for
 * scientific claims (clear entailments scored P 0.29–0.53; unrelated up to
 * 0.58) — kept as a measured-rejected engine; the interface and the resident
 * batch design survive it, generative verdict models via llama.cpp are the
 * next candidate (docs/DECISIONS.md, docs/BACKLOG.md).
 */

import { spawn } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/** Owner bar for scientific writing: a verdict needs ≥99% engine confidence. */
export const DEFAULT_MIN_CONFIDENCE = 0.99;
/** Env override for the bar (labelled client policy, not a provider limit). */
export const MIN_CONFIDENCE_ENV = "UKTUB_VERIFY_MIN_CONFIDENCE";

export interface ClaimPair {
  /** The passage (registered abstract, chunk, section) judged as evidence. */
  chunk: string;
  /** The claim under test. */
  claim: string;
}

export type ClaimVerdict =
  | { verdict: "supported"; confidence: number }
  | { verdict: "refuted"; confidence: number }
  | { verdict: "unverified"; confidence: number };

export interface ClaimEngine {
  /** One resident process answers N rows; implementations may batch freely. */
  run(rows: { state: string; instructions: string }[]): Promise<number[]>;
}

export function minConfidenceFromEnv(env: Record<string, string | undefined>): number {
  const raw = env[MIN_CONFIDENCE_ENV];
  if (raw === undefined || raw === "") return DEFAULT_MIN_CONFIDENCE;
  const v = Number(raw);
  if (!Number.isFinite(v) || v < 0.5 || v > 1) return DEFAULT_MIN_CONFIDENCE;
  return v;
}

export function mapVerdict(pTrue: number, minConfidence: number): ClaimVerdict {
  if (pTrue >= minConfidence) return { verdict: "supported", confidence: pTrue };
  if (1 - pTrue >= minConfidence) return { verdict: "refuted", confidence: 1 - pTrue };
  return { verdict: "unverified", confidence: pTrue };
}

/** Verify one claim against one chunk. */
export async function verifyClaim(engine: ClaimEngine, pair: ClaimPair, minConfidence: number): Promise<ClaimVerdict> {
  const [pTrue] = await engine.run([{ state: pair.chunk, instructions: pair.claim }]);
  return mapVerdict(pTrue, minConfidence);
}

/** Verify many claim/chunk pairs over one resident engine process (batch). */
export async function verifyClaims(
  engine: ClaimEngine,
  pairs: ClaimPair[],
  minConfidence: number,
): Promise<ClaimVerdict[]> {
  if (pairs.length === 0) return [];
  const pTrues = await engine.run(pairs.map((p) => ({ state: p.chunk, instructions: p.claim })));
  return pTrues.map((p) => mapVerdict(p, minConfidence));
}

/**
 * Julia-1 engine adapter: spawns `python3 scripts/julia_decide.py` (resident:
 * the 550 MB checkpoint loads once), pipes rows as JSONL, reads one
 * `{"p_true": …}` per row. Model: `UKTUB_JULIA_MODEL` (path or HF id).
 */
export function juliaEngine(opts: {
  env: Record<string, string | undefined>;
  pythonBin?: string;
  spawnImpl?: typeof spawn;
}): ClaimEngine {
  const pythonBin = opts.pythonBin ?? opts.env.UKTUB_JULIA_PYTHON ?? "python3";
  const script = join(dirname(fileURLToPath(import.meta.url)), "../../../scripts/julia_decide.py");
  const doSpawn = opts.spawnImpl ?? spawn;
  return {
    run(rows) {
      return new Promise((resolveRun, rejectRun) => {
        const child = doSpawn(pythonBin, [script], {
          env: { ...opts.env } as NodeJS.ProcessEnv,
          stdio: ["pipe", "pipe", "pipe"],
        });
        let out = "";
        let err = "";
        const timer = setTimeout(() => child.kill("SIGKILL"), 300_000); // client policy: 5 min incl. model load
        child.stdout!.on("data", (d: Buffer) => (out += d.toString()));
        child.stderr!.on("data", (d: Buffer) => (err += d.toString()));
        child.on("error", (e) => {
          clearTimeout(timer);
          rejectRun(new EngineError(`julia engine not startable (${pythonBin}): ${e.message}`));
        });
        child.on("close", () => {
          clearTimeout(timer);
          const lines = out.split("\n").filter((l) => l.trim().length > 0);
          const readyIdx = lines.findIndex((l) => l.includes('"ready"'));
          if (readyIdx === -1) {
            return rejectRun(new EngineError(`julia engine failed to load: ${err.slice(-400) || lines[0] || "no output"}`));
          }
          const answers = lines.slice(readyIdx + 1);
          if (answers.length < rows.length) {
            return rejectRun(new EngineError(`julia engine returned ${answers.length} answers for ${rows.length} rows`));
          }
          const pTrues: number[] = [];
          for (let i = 0; i < rows.length; i++) {
            const parsed = JSON.parse(answers[i]) as { p_true?: number; error?: string };
            if (typeof parsed.p_true !== "number") return rejectRun(new EngineError(`julia engine row ${i + 1}: ${parsed.error ?? "no p_true"}`));
            pTrues.push(parsed.p_true);
          }
          resolveRun(pTrues);
        });
        child.stdin!.on("error", () => {
          /* closed below; close handler surfaces the failure */
        });
        for (const row of rows) child.stdin!.write(JSON.stringify(row) + "\n");
        child.stdin!.end();
      });
    },
  };
}

/**
 * K2-Type engine adapter (jev decision server, resident on one CUDA GPU):
 * POSTs one `noul` question per row to TypeSafe `/v1/systemone` —
 * `{"state": <passage>, "questions": {"c": {"type": "noul", "instructions": <claim>}}}`
 * → `answers.c.noul` = P(true). The server is the owner of the fit limit:
 * inputs over 8192 tokens are refused with HTTP 413 (documented provider
 * limit) — surfaced as an EngineError, never truncated. URL:
 * `UKTUB_K2_URL` (default http://127.0.0.1:8000). Stateless client; a
 * worker-safe factory returns independent instances sharing the one server.
 */
export function k2Engine(opts: { env: Record<string, string | undefined>; fetchImpl?: typeof fetch }): ClaimEngine {
  const url = (opts.env.UKTUB_K2_URL ?? "http://127.0.0.1:8000").replace(/\/+$/, "") + "/v1/systemone";
  const doFetch = opts.fetchImpl ?? fetch;
  return {
    async run(rows) {
      if (rows.length === 0) return [];
      const pTrues: number[] = [];
      for (const row of rows) {
        const res = await doFetch(url, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ state: row.state, questions: { c: { type: "noul", instructions: row.instructions } } }),
          signal: AbortSignal.timeout(120_000), // client policy: 413/tokenize/first-inference outliers
        }).catch((e: unknown) => {
          throw new EngineError(`k2 engine unreachable at ${url}: ${e instanceof Error ? e.message : String(e)}`);
        });
        if (res.status === 413) throw new EngineError(`k2 engine: row exceeds the server's 8192-token fit limit (HTTP 413)`);
        if (!res.ok) throw new EngineError(`k2 engine HTTP ${res.status}: ${(await res.text()).slice(-300)}`);
        const parsed = (await res.json()) as { answers?: Record<string, { noul?: number }> };
        const p = parsed.answers?.c?.noul;
        if (typeof p !== "number") throw new EngineError(`k2 engine: response missing answers.c.noul`);
        pTrues.push(p);
      }
      return pTrues;
    },
  };
}

/** Typed engine failure (R7-shaped): callers map it to a refusal result. */
export class EngineError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "EngineError";
  }
}
