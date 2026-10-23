/**
 * `registry register` honours the call's cancellation: lookups run concurrently, an
 * abort cancels every in-flight provider request, keeps the registrations that
 * already committed, commits nothing for the identifiers that were cut, and
 * rejects with the caller's abort reason (never as per-item refusals). Offline: the provider is a fake that hangs until its signal aborts.
 */
import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { DatabaseSync } from "node:sqlite";

import { createRegistry, listPapers } from "../src/core/registry.ts";
import { paperRegistryTool, type PaperRegistryArgs } from "../src/core/tools/registry.ts";
import type { FetchLike } from "../src/core/providers/types.ts";
import { bib, crossrefFake, makeCtx } from "./helpers/registry-fakes.ts";

const ALPHA = "10.1001/aaa";
const BETA = "10.1001/bbb";
const GAMMA = "10.1001/ccc";

const delay = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));
type Outcome = { ok: true } | { ok: false; error: unknown };
const outcome = (p: Promise<unknown>): Promise<Outcome> =>
  p.then(
    () => ({ ok: true as const }),
    (error: unknown) => ({ ok: false as const, error }),
  );
/** Fails the test (instead of hanging it) when `p` is still pending after `ms`. */
async function within<T>(p: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const limit = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`still pending after ${ms} ms`)), ms);
  });
  try {
    return await Promise.race([p, limit]);
  } finally {
    clearTimeout(timer);
  }
}
const isAbort = (error: unknown): boolean => error instanceof Error && error.name === "AbortError";

/** ALPHA is answered like a provider; BETA and GAMMA hang until the request signal each was given aborts. */
function answersThenHangs(seen: AbortSignal[]): FetchLike {
  const answer = crossrefFake({ [ALPHA]: { title: "Alpha Grid", bibtex: bib("alpha2024", "Alpha Grid") } }).fetchFn;
  return (url, init) => {
    const decoded = decodeURIComponent(url);
    if (decoded.includes(`/works/${BETA}`) || decoded.includes(`/works/${GAMMA}`)) {
      const signal = init?.signal;
      if (signal !== undefined) seen.push(signal);
      return new Promise<never>((_, reject) => {
        signal?.addEventListener("abort", () => reject(signal.reason), { once: true });
      });
    }
    return answer(url, init);
  };
}

let root: string;
let db: DatabaseSync;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "uktub-regcancel-"));
  db = createRegistry(root);
});
afterEach(() => {
  db.close();
  rmSync(root, { recursive: true, force: true });
});

describe("registry register honours the call's cancellation", () => {
  it("an abort mid-batch cancels every in-flight lookup, keeps the earlier registration and rejects with the abort", async () => {
    const seen: AbortSignal[] = [];
    const ac = new AbortController();
    const ctx = makeCtx(root, answersThenHangs(seen), { signal: ac.signal });
    const args = { action: "register", identifiers: [ALPHA, BETA, GAMMA] } as unknown as PaperRegistryArgs;
    const p = outcome(paperRegistryTool(ctx, args));

    // Bounded wait (about 1 s) until the first identifier has committed.
    for (let i = 0; i < 200 && listPapers(db).length < 1; i++) await delay(5);
    assert.deepEqual(listPapers(db).map((paper) => paper.doi), [ALPHA], "the first identifier is registered before the abort");
    ac.abort();

    const r = await within(p, 100);
    assert.ok(!r.ok && isAbort(r.error), "the call rejects with the caller's abort reason, not per-item refusals");
    assert.equal(seen.length, 2, "both hanging lookups were issued");
    assert.ok(seen.every((signal) => signal.aborted), "every in-flight lookup's request signal was cancelled");
    assert.deepEqual(listPapers(db).map((paper) => paper.doi), [ALPHA], "the registry holds exactly the first paper");
  });
});
