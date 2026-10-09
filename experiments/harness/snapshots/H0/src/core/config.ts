/**
 * YAML chunking + verification configuration, resolved on ONE path: the
 * project's `config/chunking.yaml` (or the file `UKTUB_CHUNK_CONFIG` names)
 * when present, the documented package defaults when absent, and the same
 * env overrides applied to either. Malformed or unknown supplied
 * configuration fails with CONFIG_INVALID — never silently defaulted.
 */

import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { parse as yamlParse } from "yaml";

import { VERIFICATION_ENGINES } from "./verify/engines.ts";

export const CHUNK_CONFIG_ENV = "UKTUB_CHUNK_CONFIG";
export const VERIFY_ENGINE_ENV = "UKTUB_VERIFY_ENGINE";
export const VERIFY_MIN_CONFIDENCE_ENV = "UKTUB_VERIFY_MIN_CONFIDENCE";
export const DEFAULT_CHUNK_CONFIG_PATH = "config/chunking.yaml";

export interface ChunkConfig {
  chunking: {
    chunk_tokens: number;
    overlap_tokens: number;
    chars_per_token: number;
    boundary: "paragraph" | "hard" | "section";
  };
  verification: {
    engine: string;
    min_confidence: number;
    workers: number;
    max_judgments: number;
  };
}

export class ConfigError extends Error {
  readonly code = "CONFIG_INVALID";
  constructor(message: string) {
    super(message);
    this.name = "ConfigError";
  }
}

const SHAPE: Record<string, Record<string, "number" | "string">> = {
  chunking: { chunk_tokens: "number", overlap_tokens: "number", chars_per_token: "number", boundary: "string" },
  verification: { engine: "string", min_confidence: "number", workers: "number", max_judgments: "number" },
};

/** Documented package defaults — what an agent-only project runs with. */
export const DEFAULTS: ChunkConfig = {
  // Section chunks capped at 512 tokens (docs/benchmarks/evidence-chunking-sections-2026-10-04.md). With Eos at
  // the 0.99 bar on 50 claims in two disjoint samples, support recall was 80 % for fixed 1,024-token windows,
  // 88 % for section chunks at 1,024 and 90 % at 512 (6 claims gained, 1 lost, against the fixed baseline);
  // a locator query then needs 5.0 judgments per claim (7.6 for fixed 1,024). 512 also keeps every chunk
  // (≤ 1,433 characters) inside the 1,500-character excerpt limit, so one chunk is one releasable passage and
  // the same chunks serve passage search and verification. No index-time overlap: a section is a unit, and a
  // continuation across a split is the neighbouring chunk. 2.8 chars/token: calibrated on the benchmark
  // corpus with the mmBERT tokenizer (median 4.1, densest paper 3.10; 0.9 headroom so a window never overflows).
  chunking: { chunk_tokens: 512, overlap_tokens: 0, chars_per_token: 2.8, boundary: "section" },
  // engine: Decision 2.0 Eos, local (owner decision 2026-10-04). 0.99: client policy, the
  // scientific-writing confidence bar. 4 lanes (one resident model serializes them) and 120
  // judgments per call: client policy — seconds locally, ≈ 7 minutes on a 20-requests/minute hosted tier.
  verification: { engine: "eos", min_confidence: 0.99, workers: 4, max_judgments: 120 },
};

function validate(parsed: unknown): ChunkConfig {
  if (typeof parsed !== "object" || parsed === null) throw new ConfigError("config must be a YAML mapping");
  const obj = parsed as Record<string, unknown>;
  for (const section of Object.keys(SHAPE)) {
    if (typeof obj[section] !== "object" || obj[section] === null) {
      throw new ConfigError(`missing required section "${section}"`);
    }
    const s = obj[section] as Record<string, unknown>;
    for (const [key, type] of Object.entries(SHAPE[section])) {
      const v = s[key];
      if (v === undefined) throw new ConfigError(`missing ${section}.${key}`);
      if (typeof v !== type) throw new ConfigError(`${section}.${key} must be ${type}, got ${typeof v}`);
    }
    for (const key of Object.keys(s)) {
      if (!(key in SHAPE[section])) throw new ConfigError(`unknown key ${section}.${key}`);
    }
  }
  const c = parsed as ChunkConfig;
  if (c.chunking.chunk_tokens < 256 || c.chunking.chunk_tokens > 1_000_000) {
    throw new ConfigError(`chunking.chunk_tokens out of range: ${c.chunking.chunk_tokens}`);
  }
  if (c.chunking.overlap_tokens < 0 || c.chunking.overlap_tokens >= c.chunking.chunk_tokens) {
    throw new ConfigError(`chunking.overlap_tokens must be 0..chunk_tokens-1`);
  }
  // Lower bound: below a quarter character per token a window rounds to nothing.
  if (!Number.isFinite(c.chunking.chars_per_token) || c.chunking.chars_per_token < 0.25 || c.chunking.chars_per_token > 20) {
    throw new ConfigError(`chunking.chars_per_token out of range: ${c.chunking.chars_per_token}`);
  }
  if (c.chunking.boundary !== "paragraph" && c.chunking.boundary !== "hard" && c.chunking.boundary !== "section") {
    throw new ConfigError(`chunking.boundary must be "paragraph", "hard" or "section"`);
  }
  validateVerification(c.verification);
  return c;
}

function validateVerification(v: ChunkConfig["verification"]): void {
  if (!(VERIFICATION_ENGINES as readonly string[]).includes(v.engine)) {
    throw new ConfigError(`unknown verification.engine "${v.engine}" (known: ${VERIFICATION_ENGINES.join(", ")})`);
  }
  if (!Number.isFinite(v.min_confidence) || v.min_confidence < 0.5 || v.min_confidence > 1) throw new ConfigError(`verification.min_confidence must be within 0.5..1`);
  if (!Number.isFinite(v.workers) || !Number.isInteger(v.workers) || v.workers < 1 || v.workers > 64) throw new ConfigError(`verification.workers must be an integer within 1..64`);
  // Upper bound: a call that long exceeds any host's patience even on a local engine.
  if (!Number.isInteger(v.max_judgments) || v.max_judgments < 1 || v.max_judgments > 100_000) {
    throw new ConfigError(`verification.max_judgments must be an integer within 1..100000`);
  }
}

/**
 * Load + validate the effective config. The file is `UKTUB_CHUNK_CONFIG` when
 * set (it must exist), else `config/chunking.yaml` under `base`; when the
 * default file is absent the package defaults apply unless `required`. Env
 * overrides (`UKTUB_VERIFY_ENGINE`, `UKTUB_VERIFY_MIN_CONFIDENCE`) apply to
 * whichever source supplied the values and are validated like file values.
 */
export function loadChunkConfig(base: string, opts: { env?: Record<string, string | undefined>; required?: boolean } = {}): ChunkConfig {
  const env = opts.env ?? {};
  const explicit = env[CHUNK_CONFIG_ENV];
  // A relative override is relative to the PROJECT, not to wherever the process started.
  const path = explicit !== undefined ? resolve(base, explicit) : join(base, DEFAULT_CHUNK_CONFIG_PATH);
  let c: ChunkConfig;
  if (!existsSync(path)) {
    if (explicit !== undefined || opts.required) throw new ConfigError(`chunk config not found at ${path}`);
    c = JSON.parse(JSON.stringify(DEFAULTS)) as ChunkConfig;
  } else {
    let parsed: unknown;
    try {
      parsed = yamlParse(readFileSync(path, "utf8"));
    } catch (e) {
      throw new ConfigError(`yaml parse failed for ${path}: ${e instanceof Error ? e.message : String(e)}`);
    }
    c = validate(parsed);
  }
  const engine = env[VERIFY_ENGINE_ENV];
  if (engine !== undefined && engine !== "") c.verification.engine = engine;
  const bar = env[VERIFY_MIN_CONFIDENCE_ENV];
  if (bar !== undefined && bar !== "") {
    const n = Number(bar);
    if (!Number.isFinite(n)) throw new ConfigError(`${VERIFY_MIN_CONFIDENCE_ENV} must be a number, got "${bar}"`);
    c.verification.min_confidence = n;
  }
  validateVerification(c.verification);
  return c;
}
