/**
 * `verify_claims` tool: check claims against a registered paper's ingested
 * text, chunk-first (every claim is verified against every chunk of the
 * paper; paper verdict = any-chunk-supported / any-chunk-refuted, KTD6).
 * The engine comes from `verification.engine` in config/chunking.yaml —
 * mercury-decide:free via OpenRouter by default, a local llama.cpp System
 * One endpoint (`verification.engine: llama-cpp`, `UKTUB_VERIFY_URL`) for
 * offline runs. Fresh verdicts persist to the content-addressed cache; the
 * tool itself writes nothing else.
 */

import { Type } from "typebox";

import { openRegistry } from "../registry.ts";
import { EngineError } from "../verify/claim.ts";
import { createConfiguredEngine, verificationModelLabel } from "../verify/engines.ts";
import { chunksOf, cachedVerdicts, saveVerdicts } from "../verify/store.ts";
import { verifyClaimInPaper } from "../verify/pipeline.ts";
import { loadChunkConfig } from "../config.ts";
import { refusalResult, type ToolContext, type ToolResult } from "./context.ts";

/** Client policy: bounded tool result and bounded free-tier run per call. */
export const MAX_CLAIMS_PER_CALL = 8;
/** Client policy: a claim is a sentence-scale proposition, not a document. */
export const MAX_CLAIM_CHARS = 2_000;

export const VerifyClaimsParams = Type.Object({
  doi: Type.String({ minLength: 7, description: "Registered paper DOI to verify against" }),
  claims: Type.Array(Type.String({ minLength: 8, maxLength: MAX_CLAIM_CHARS }), {
    minItems: 1,
    maxItems: MAX_CLAIMS_PER_CALL,
    description: `Claims to verify (propositions, one sentence each; at most ${MAX_CLAIMS_PER_CALL} per call)`,
  }),
});

export const VerifyClaimsOutput = Type.Object({
  engine: Type.String(),
  model: Type.String(),
  results: Type.Array(
    Type.Object({
      claim: Type.String(),
      verdict: Type.Union([Type.Literal("supported"), Type.Literal("refuted"), Type.Literal("unverified")]),
      confidence: Type.Number(),
      bestChunkIndex: Type.Union([Type.Integer(), Type.Null()]),
      cached: Type.Integer(),
    }),
  ),
});

export interface VerifyClaimResult {
  claim: string;
  verdict: "supported" | "refuted" | "unverified";
  confidence: number;
  bestChunkIndex: number | null;
  cached: number;
}

export interface VerifyClaimsStructured {
  engine: string;
  model: string;
  results: VerifyClaimResult[];
}

/** Core verify run, shared by the Pi tool and the CLI. Throws EngineError
 * for engine failures (callers map to refusals); returns per-claim verdicts. */
export async function runVerifyClaims(
  ctx: Pick<ToolContext, "root" | "env">,
  args: { doi: string; claims: string[] },
  hooks?: { createEngine?: (engineName: string) => ReturnType<typeof createConfiguredEngine> },
): Promise<VerifyClaimsStructured> {
  const cfg = loadChunkConfig(ctx.root, { env: ctx.env, required: true });
  const engineName = cfg.verification.engine;
  const engine = hooks?.createEngine
    ? hooks.createEngine(engineName)
    : createConfiguredEngine(ctx.env, engineName);
  const model = verificationModelLabel(ctx.env, engineName);

  const db = openRegistry(ctx.root);
  try {
    const paper = db.prepare("SELECT doi FROM papers WHERE doi = ?").get(args.doi) as { doi: string } | undefined;
    if (!paper) {
      const err = new Error(`DOI ${args.doi} is not registered (or carries no ingested text)`);
      (err as Error & { code?: string }).code = "DOI_NOT_FOUND";
      throw err;
    }
    const results: VerifyClaimResult[] = [];
    for (const claim of args.claims) {
      const r = await verifyClaimInPaper(db, { chunksOf, cachedVerdicts, saveVerdicts }, {
        createEngine: () => engine,
        doi: args.doi,
        claim,
        model,
        minConfidence: cfg.verification.min_confidence,
        workers: cfg.verification.workers,
      });
      const best = r.chunks.reduce<{ i: number; p: number } | null>((acc, c) => (acc === null || c.p_true > acc.p ? { i: c.chunk_index, p: c.p_true } : acc), null);
      results.push({
        claim,
        verdict: r.verdict,
        confidence: r.confidence,
        bestChunkIndex: best ? best.i : null,
        cached: r.chunks.some((c) => c.cached) ? 1 : 0,
      });
    }
    return { engine: engineName, model, results };
  } finally {
    db.close();
  }
}

export async function verifyClaimsTool(ctx: ToolContext, args: { doi: string; claims: string[] }): Promise<ToolResult<VerifyClaimsStructured>> {
  if (args.claims.length === 0) {
    return refusalResult({ code: "QUERY_REQUIRED", message: "verify_claims needs at least one claim. Next: pass the propositions to check as `claims`." });
  }
  if (args.claims.length > MAX_CLAIMS_PER_CALL) {
    return refusalResult({
      code: "BATCH_TOO_LARGE",
      message: `at most ${MAX_CLAIMS_PER_CALL} claims per call (client policy). Next: split the batch.`,
    });
  }
  try {
    const structured = await runVerifyClaims(ctx, args);
    const lines = structured.results.map(
      (r) => `${r.verdict.toUpperCase()} (p=${r.confidence.toFixed(3)}, chunk ${r.bestChunkIndex ?? "-"}): ${r.claim}`,
    );
    return {
      content: [{ type: "text", text: `verified ${args.claims.length} claim(s) against ${args.doi} via ${structured.model}\n${lines.join("\n")}` }],
      structuredContent: structured,
      details: {},
    };
  } catch (err) {
    if (err instanceof EngineError) {
      return refusalResult({
        code: "VERIFY_ENGINE_MISSING",
        message: `${err.message} Next: start the verification engine (OpenRouter needs OPENROUTER_API_KEY; engine llama-cpp needs UKTUB_VERIFY_URL pointing at a local System One server) or switch verification.engine in config/chunking.yaml.`,
      });
    }
    const code = (err as Error & { code?: string }).code;
    if (code === "DOI_NOT_FOUND") {
      return refusalResult({ code: "DOI_NOT_FOUND", message: `${(err as Error).message} Next: register_papers first, or check the DOI.` });
    }
    if (code === "CONFIG_INVALID") {
      return refusalResult({ code: "CONFIG_INVALID", message: `${(err as Error).message} Next: fix config/chunking.yaml.` });
    }
    throw err;
  }
}
