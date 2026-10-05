/**
 * Effective configuration (KTD8, plan "Implementation Freedom"): one resolution
 * path whether or not project YAML exists. Absent YAML → documented package
 * defaults plus env overrides; malformed or unknown supplied configuration
 * fails explicitly.
 */
import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { VERIFICATION_ENGINES } from "../src/core/verify/engines.ts";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { ConfigError, DEFAULTS, loadChunkConfig } from "../src/core/config.ts";

let root: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "uktub-cfg-"));
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

const writeYaml = (body: string, path = join(root, "config", "chunking.yaml")) => {
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, body);
  return path;
};
const FULL = (engine = "openrouter", extra = "") =>
  `chunking:\n  chunk_tokens: 8192\n  overlap_tokens: 128\n  chars_per_token: 2.8\n  boundary: paragraph\nverification:\n  engine: ${engine}\n  min_confidence: 0.99\n  workers: 4\n  max_judgments: 120\n${extra}`;

describe("the shipped template", () => {
  it("config/chunking.yaml loads and agrees with the documented defaults (it is what users copy)", () => {
    const repoRoot = new URL("..", import.meta.url).pathname;
    assert.deepEqual(loadChunkConfig(repoRoot, { env: {}, required: true }), DEFAULTS);
  });
});

describe("loadChunkConfig", () => {
  it("without any YAML the agent-only path works: documented defaults, no setup required", () => {
    const c = loadChunkConfig(root, { env: {} });
    assert.deepEqual(c, DEFAULTS);
    assert.equal(c.chunking.chars_per_token, 2.8, "the calibrated factor, so a default chunk fits the engine window");
    assert.deepEqual([c.chunking.chunk_tokens, c.chunking.overlap_tokens, c.chunking.boundary], [512, 0, "section"], "the measured policy: section chunks capped at 512 tokens (docs/benchmarks/evidence-chunking-sections-2026-10-04.md)");
    assert.equal(c.verification.engine, "eos", "the owner's default engine (decision 2026-10-04)");
  });

  it("accepts boundary: section and refuses any other boundary word, naming the three that exist", () => {
    writeYaml(FULL().replace("boundary: paragraph", "boundary: section"));
    assert.equal(loadChunkConfig(root, { env: {} }).chunking.boundary, "section");
    writeYaml(FULL().replace("boundary: paragraph", "boundary: semantic"));
    assert.throws(() => loadChunkConfig(root, { env: {} }), (e) => e instanceof ConfigError && /"paragraph", "hard" or "section"/.test(e.message));
  });

  it("env overrides apply identically with and without a YAML file", () => {
    const env = { UKTUB_VERIFY_ENGINE: "llama-cpp", UKTUB_VERIFY_MIN_CONFIDENCE: "0.95" };
    const without = loadChunkConfig(root, { env });
    assert.deepEqual([without.verification.engine, without.verification.min_confidence], ["llama-cpp", 0.95]);
    writeYaml(FULL());
    const withFile = loadChunkConfig(root, { env });
    assert.deepEqual([withFile.verification.engine, withFile.verification.min_confidence], ["llama-cpp", 0.95]);
    assert.equal(loadChunkConfig(root, { env: {} }).verification.min_confidence, 0.99);
  });

  it("UKTUB_CHUNK_CONFIG points at another file; a named-but-missing file is refused, not defaulted", () => {
    const other = writeYaml(FULL("k2"), join(root, "other.yaml"));
    assert.equal(loadChunkConfig(root, { env: { UKTUB_CHUNK_CONFIG: other } }).verification.engine, "k2");
    assert.throws(() => loadChunkConfig(root, { env: { UKTUB_CHUNK_CONFIG: join(root, "nope.yaml") } }), (e) => e instanceof ConfigError);
  });

  it("required:true still refuses a missing file (benchmark runner contract)", () => {
    assert.throws(() => loadChunkConfig(root, { env: {}, required: true }), (e) => e instanceof ConfigError);
  });

  it("refuses malformed YAML, unknown keys, wrong types, out-of-range values and unknown engines", () => {
    const cases: [string, RegExp][] = [
      ["chunking: [", /yaml parse failed/],
      [FULL("openrouter", "  bogus_key: 1\n"), /unknown key verification\.bogus_key/],
      [FULL().replace("workers: 4", "workers: four"), /verification\.workers must be number/],
      [FULL().replace("min_confidence: 0.99", "min_confidence: 0.2"), /min_confidence/],
      [FULL().replace("max_judgments: 120", "max_judgments: 0"), /max_judgments/],
      [FULL("not-an-engine"), /not-an-engine/],
    ];
    for (const [yaml, re] of cases) {
      writeYaml(yaml);
      assert.throws(() => loadChunkConfig(root, { env: {} }), (e) => e instanceof ConfigError && re.test(e.message), re.source);
    }
  });

  it("refuses values that would hang or silently disable verification (review findings)", () => {
    const cases: [string, RegExp][] = [
      [FULL().replace("chars_per_token: 2.8", "chars_per_token: 0.001"), /chars_per_token/],
      [FULL().replace("chars_per_token: 2.8", "chars_per_token: .nan"), /chars_per_token/],
      [FULL().replace("min_confidence: 0.99", "min_confidence: .nan"), /min_confidence/],
      [FULL().replace("workers: 4", "workers: .inf"), /workers/],
    ];
    for (const [yaml, re] of cases) {
      writeYaml(yaml);
      assert.throws(() => loadChunkConfig(root, { env: {} }), (e) => e instanceof ConfigError && re.test(e.message), re.source);
    }
  });

  it("a relative UKTUB_CHUNK_CONFIG is resolved against the project root, not the process directory", () => {
    writeYaml(FULL("k2"), join(root, "conf", "mine.yaml"));
    assert.equal(loadChunkConfig(root, { env: { UKTUB_CHUNK_CONFIG: "conf/mine.yaml" } }).verification.engine, "k2");
  });

  it("an engine override naming an unknown engine is refused even without a YAML file", () => {
    assert.throws(() => loadChunkConfig(root, { env: { UKTUB_VERIFY_ENGINE: "mystery" } }), (e) => e instanceof ConfigError && /mystery/.test(e.message));
  });

  it("an out-of-range min-confidence override is refused rather than silently replaced", () => {
    assert.throws(() => loadChunkConfig(root, { env: { UKTUB_VERIFY_MIN_CONFIDENCE: "0.1" } }), (e) => e instanceof ConfigError);
    assert.throws(() => loadChunkConfig(root, { env: { UKTUB_VERIFY_MIN_CONFIDENCE: "abc" } }), (e) => e instanceof ConfigError);
  });
});

describe("verification engines", () => {
  it("eos-onnx is a known engine name", () => {
    assert.ok((VERIFICATION_ENGINES as readonly string[]).includes("eos-onnx"));
  });
});
