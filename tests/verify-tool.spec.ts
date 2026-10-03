/**
 * verify_claims tool spec: structured output mapping through a fake engine,
 * refusal envelopes (empty batch, oversized batch, dead engine, unknown DOI),
 * and the UKTUB_VERIFY_ENGINE config override — all offline.
 */
import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createRegistry, openRegistry } from "../src/core/registry.ts";
import { replaceChunks, claimHashOf } from "../src/core/verify/store.ts";
import { runVerifyClaims, verifyClaimsTool, MAX_CLAIMS_PER_CALL } from "../src/core/tools/verify.ts";
import type { ChunkTextConfig } from "../src/core/chunk.ts";
import type { ToolContext } from "../src/core/tools/context.ts";

let root: string;
const CFG: ChunkTextConfig = { chunk_tokens: 8192, overlap_tokens: 128, chars_per_token: 2.8, boundary: "paragraph" };

function fakeEngine(ps: number[]) {
  let i = 0;
  return { run: async () => [ps[i++ % ps.length]] };
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "uktub-vtool-"));
  mkdirSync(join(root, "config"), { recursive: true });
  writeFileSync(
    join(root, "config", "chunking.yaml"),
    "chunking:\n  chunk_tokens: 8192\n  overlap_tokens: 128\n  chars_per_token: 2.8\n  boundary: paragraph\nverification:\n  engine: openrouter\n  min_confidence: 0.99\n  workers: 2\n  record_negative_pointers: false\n",
  );
  createRegistry(root);
  const db = openRegistry(root);
  db.prepare(
    "INSERT INTO papers (doi, citekey, title, authors_json, year, venue, provider_bibtex, bibtex_source, citable, ingested_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
  ).run("10.1234/x", "x2026", "Paper X", '["A"]', 2026, null, "bibtex", "crossref", 1, "2026-10-03T00:00:00Z");
  db.close();
  const d = join(root, "ingest");
  mkdirSync(d, { recursive: true });
  writeFileSync(join(d, "x.md"), "The tower is in Paris.\n\nBattery chemistry limits cycle life.");
  replaceChunks(openRegistry(root), "10.1234/x", "The tower is in Paris.\n\nBattery chemistry limits cycle life.", CFG);
});
afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

function ctx(overrides: Partial<ToolContext> = {}): ToolContext {
  return {
    root,
    fetch: (async () => {
      throw new Error("no network in tests");
    }) as ToolContext["fetch"],
    env: {},
    now: () => new Date("2026-10-03T00:00:00Z"),
    queue: { runExclusive: async <T>(fn: () => T | Promise<T>) => await fn() },
    ...overrides,
  };
}

describe("runVerifyClaims", () => {
  it("maps fake-engine probabilities to verdicts with best chunk indices", async () => {
    const out = await runVerifyClaims(ctx(), { doi: "10.1234/x", claims: ["The tower is in Paris.", "The tower is in Berlin."] }, {
      createEngine: () => fakeEngine([0.997, 0.2]) as never,
    });
    assert.equal(out.engine, "openrouter"); // config default
    assert.equal(out.results[0].verdict, "supported");
    assert.equal(out.results[0].bestChunkIndex, 0);
    assert.equal(out.results[1].verdict, "unverified");
  });

  it("records fresh verdicts into the content-addressed cache (second run is fully cached)", async () => {
    let calls = 0;
    const first = await runVerifyClaims(ctx(), { doi: "10.1234/x", claims: ["The tower is in Paris."] }, {
      createEngine: () => { calls++; return fakeEngine([0.997]) as never; },
    });
    assert.equal(first.results[0].cached, 0);
    const second = await runVerifyClaims(ctx(), { doi: "10.1234/x", claims: ["The tower is in Paris."] }, {
      createEngine: () => { calls++; return fakeEngine([0.997]) as never; },
    });
    assert.equal(second.results[0].cached, 1);
    assert.equal(calls, 2); // engine constructed once per run, zero fresh rows on the second
  });

  it("refuses unknown DOIs with DOI_NOT_FOUND", async () => {
    await assert.rejects(
      runVerifyClaims(ctx(), { doi: "10.9999/missing", claims: ["The tower is in Paris."] }, { createEngine: () => fakeEngine([0.5]) as never }),
      (e: Error & { code?: string }) => e.code === "DOI_NOT_FOUND",
    );
  });

  it("honours the UKTUB_VERIFY_ENGINE override for the cache model label", async () => {
    const out = await runVerifyClaims({ root, env: { UKTUB_VERIFY_ENGINE: "llama-cpp" } }, { doi: "10.1234/x", claims: ["The tower is in Paris."] }, {
      createEngine: () => fakeEngine([0.997]) as never,
    });
    assert.equal(out.engine, "llama-cpp");
    assert.equal(out.model.startsWith("llama-cpp:"), true);
  });
});

describe("verifyClaimsTool refusals", () => {
  it("refuses an empty batch with QUERY_REQUIRED", async () => {
    const res = await verifyClaimsTool(ctx(), { doi: "10.1234/x", claims: [] });
    assert.equal(res.structuredContent, null);
    assert.equal((res.details.refused as { code: string }).code, "QUERY_REQUIRED");
  });

  it("refuses oversized batches with BATCH_TOO_LARGE", async () => {
    const claims = Array.from({ length: MAX_CLAIMS_PER_CALL + 1 }, (_, i) => `Claim number ${i} stands.`);
    const res = await verifyClaimsTool(ctx(), { doi: "10.1234/x", claims });
    assert.equal(res.structuredContent, null);
    assert.equal((res.details.refused as { code: string }).code, "BATCH_TOO_LARGE");
  });

  it("maps a dead engine (no API key) to VERIFY_ENGINE_MISSING", async () => {
    // ctx() has empty env: the default openrouter engine fails construction.
    const res = await verifyClaimsTool(ctx(), { doi: "10.1234/x", claims: ["The tower is in Paris."] });
    assert.equal(res.structuredContent, null);
    const refused = res.details.refused as { code: string; message: string };
    assert.equal(refused.code, "VERIFY_ENGINE_MISSING");
    assert.match(refused.message, /OPENROUTER_API_KEY/);
  });

  it("maps a live engine that is unreachable to VERIFY_ENGINE_MISSING", async () => {
    const res = await verifyClaimsTool({ ...ctx(), env: { UKTUB_VERIFY_ENGINE: "llama-cpp", UKTUB_VERIFY_URL: "http://127.0.0.1:9" } }, { doi: "10.1234/x", claims: ["The tower is in Paris."] });
    assert.equal(res.structuredContent, null);
    assert.equal((res.details.refused as { code: string }).code, "VERIFY_ENGINE_MISSING");
  });
});
