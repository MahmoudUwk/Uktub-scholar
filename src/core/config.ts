/**
 * Typed loader for config/chunking.yaml (KTD6): the yaml file is the source
 * of chunking + verification knobs; env vars still override where an env
 * contract already exists (UKTUB_VERIFY_MIN_CONFIDENCE, UKTUB_CHUNK_CONFIG
 * for the file path). Malformed or unknown-key files are a typed refusal
 * (CONFIG_INVALID) — typos fail loudly instead of silently defaulting.
 */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { parse as yamlParse } from "yaml";

export const CHUNK_CONFIG_ENV = "UKTUB_CHUNK_CONFIG";
export const DEFAULT_CHUNK_CONFIG_PATH = "config/chunking.yaml";

export interface ChunkConfig {
  chunking: {
    chunk_tokens: number;
    overlap_tokens: number;
    chars_per_token: number;
    boundary: "paragraph" | "hard";
  };
  verification: {
    engine: string;
    min_confidence: number;
    workers: number;
    record_negative_pointers: boolean;
  };
}

export class ConfigError extends Error {
  readonly code = "CONFIG_INVALID";
  constructor(message: string) {
    super(message);
    this.name = "ConfigError";
  }
}

const SHAPE: Record<string, Record<string, "number" | "string" | "boolean">> = {
  chunking: { chunk_tokens: "number", overlap_tokens: "number", chars_per_token: "number", boundary: "string" },
  verification: { engine: "string", min_confidence: "number", workers: "number", record_negative_pointers: "boolean" },
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
  if (c.chunking.chars_per_token <= 0 || c.chunking.chars_per_token > 20) {
    throw new ConfigError(`chunking.chars_per_token out of range: ${c.chunking.chars_per_token}`);
  }
  if (c.chunking.boundary !== "paragraph" && c.chunking.boundary !== "hard") {
    throw new ConfigError(`chunking.boundary must be "paragraph" or "hard"`);
  }
  if (c.verification.min_confidence < 0.5 || c.verification.min_confidence > 1) {
    throw new ConfigError(`verification.min_confidence must be within 0.5..1`);
  }
  if (c.verification.workers < 1 || c.verification.workers > 64) {
    throw new ConfigError(`verification.workers must be within 1..64`);
  }
  return c;
}

/** Load + validate the chunk config. `path` defaults to the env override,
 * then `config/chunking.yaml` under `base`. Missing file is allowed only when
 * `required` is false (returns package defaults). */
export function loadChunkConfig(base: string, opts: { env?: Record<string, string | undefined>; required?: boolean } = {}): ChunkConfig {
  const path = opts.env?.[CHUNK_CONFIG_ENV] ?? join(base, DEFAULT_CHUNK_CONFIG_PATH);
  if (!existsSync(path)) {
    if (opts.required) throw new ConfigError(`chunk config not found at ${path}`);
    return validate(JSON.parse(JSON.stringify(DEFAULTS)));
  }
  let parsed: unknown;
  try {
    parsed = yamlParse(readFileSync(path, "utf8"));
  } catch (e) {
    throw new ConfigError(`yaml parse failed for ${path}: ${e instanceof Error ? e.message : String(e)}`);
  }
  return validate(parsed);
}

export const DEFAULTS: ChunkConfig = {
  chunking: { chunk_tokens: 8192, overlap_tokens: 128, chars_per_token: 4.0, boundary: "paragraph" },
  verification: { engine: "julia", min_confidence: 0.99, workers: 4, record_negative_pointers: false },
};


