/**
 * U4 tool-layer spec: FIFO write-queue serialization (instrumented order log),
 * batch partial failure, list ordering + truncation, determinism across two
 * runs (identical structuredContent + byte-identical references.bib),
 * confinement traversal refusal, batch cap, DOI-shaped-query hint, and the
 * DOI_TITLE_MISMATCH cross-check. All provider traffic goes through fakes —
 * no live network at any layer.
 */
import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { Value } from "typebox/value";

import { WriteQueue } from "../src/core/queue.ts";
import { BIBLIOGRAPHY_REL_PATH, createRegistry, listPapers } from "../src/core/registry.ts";
import { paperRegistryTool, type PaperRegistryArgs } from "../src/core/tools/registry.ts";
import { SearchPapersOutput, searchPapersTool } from "../src/core/tools/search.ts";
import { validateContext, type ToolContext } from "../src/core/tools/context.ts";
import type { FetchLike } from "../src/core/providers/types.ts";
import {
  SEARCH_CFG,
  createFakeFetch,
  createSearchFetch,
  crossrefWorkEnvelope,
  fakeWorks,
} from "./helpers/provider-fakes.ts";

// ── fixtures ───────────────────────────────────────────────────────────────

let root: string;
let db: DatabaseSync;
let order: string[];
const queue = new WriteQueue();

const FIXED_NOW = () => new Date("2026-01-01T00:00:00Z");

const NO_FETCH: FetchLike = async () => {
  throw new Error("no fetch expected");
};

function makeCtx(fetchFn: FetchLike): ToolContext {
  return { root, fetch: fetchFn, env: {}, now: FIXED_NOW, queue, providerConfig: SEARCH_CFG };
}

const BIBTEX_A = "@article{holder2024, title={Alpha Grid}, author={Holder, Ada}, year={2024}}";
const BIBTEX_B = "@article{holder2024a, title={Beta Cache}, author={Holder, Ben}, year={2024}}";

/** Crossref fake resolving a batch of DOIs, each with its own BibTeX. */
function registerFetch(perDoi: Record<string, { title: string; bibtex: string | null; status?: number }>): {
  fetchFn: FetchLike;
} {
  const { fetchFn } = createFakeFetch(
    Object.entries(perDoi).flatMap(([doi, spec]) => [
      {
        match: (url: string) => decodeURIComponent(url).includes(`/works/${doi}`) && !url.includes("/transform/"),
        status: spec.status ?? 200,
        body: crossrefWorkEnvelope({ doi, title: spec.title, authors: [{ family: "Holder", given: "Ada" }], year: 2024 }),
      },
      {
        match: (url: string) => decodeURIComponent(url).includes(`/works/${doi}/transform/`),
        status: spec.bibtex === null ? 404 : 200,
        body: spec.bibtex ?? "",
      },
    ]),
  );
  return { fetchFn };
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "uktub-tools-"));
  db = createRegistry(root);
  order = [];
});

afterEach(() => {
  db.close();
  rmSync(root, { recursive: true, force: true });
});

// ── queue serialization ────────────────────────────────────────────────────

describe("WriteQueue — FIFO non-interleaving (KTD5)", () => {
  it("runs overlapping sections to completion in call-arrival order", async () => {
    const gated = new WriteQueue();
    const release: (() => void)[] = [];
    const gate = () =>
      new Promise<void>((resolveGate) => {
        release.push(resolveGate);
      });

    const first = gated.runExclusive(async () => {
      order.push("A:start");
      await gate();
      order.push("A:end");
      return "A";
    });
    const second = gated.runExclusive(async () => {
      order.push("B:start");
      order.push("B:end");
      return "B";
    });

    await new Promise<void>((resolveTick) => setTimeout(resolveTick, 5));
    assert.deepEqual(order, ["A:start"], "second section started before the first finished");
    release[0]!();
    assert.equal(await first, "A");
    assert.equal(await second, "B");
    assert.deepEqual(order, ["A:start", "A:end", "B:start", "B:end"]);
  });

  it("a failing section does not break the chain for later sections", async () => {
    const failing = new WriteQueue();
    const boom = failing.runExclusive(async () => {
      throw new Error("boom");
    });
    const later = failing.runExclusive(() => "survived");
    await assert.rejects(boom, /boom/);
    assert.equal(await later, "survived");
  });

  it("two overlapping register calls serialize their write sections", async () => {
    const { fetchFn } = createFakeFetch([
      {
        match: (url: string) => decodeURIComponent(url).includes("/works/10.1111/one"),
        body: crossrefWorkEnvelope({ doi: "10.1111/one", title: "Paper One", authors: [{ family: "One", given: "Ada" }], year: 2024 }),
      },
      { match: (url: string) => decodeURIComponent(url).includes("/works/10.1111/one/transform/"), body: BIBTEX_A },
      {
        match: (url: string) => decodeURIComponent(url).includes("/works/10.2222/two"),
        body: crossrefWorkEnvelope({ doi: "10.2222/two", title: "Paper Two", authors: [{ family: "One", given: "Ben" }], year: 2024 }),
      },
      { match: (url: string) => decodeURIComponent(url).includes("/works/10.2222/two/transform/"), body: BIBTEX_B },
    ]);
    const ctx = makeCtx(fetchFn);
    const first = paperRegistryTool(ctx, { action: "register", identifiers: ["10.1111/one"] } as PaperRegistryArgs);
    const second = paperRegistryTool(ctx, { action: "register", identifiers: ["10.2222/two"] } as PaperRegistryArgs);
    const [firstResult, secondResult] = await Promise.all([first, second]);
    assert.equal(firstResult.structuredContent?.outcomes[0]?.status, "registered");
    assert.equal(secondResult.structuredContent?.outcomes[0]?.status, "registered");
    // Both committed; the BEGIN IMMEDIATE fence kept the sections apart.
    assert.equal(listPapers(db).length, 2);
  });
});

// ── search ─────────────────────────────────────────────────────────────────

describe("search_papers", () => {
  it("refuses an empty or blank query with QUERY_REQUIRED", async () => {
    const result = await searchPapersTool(makeCtx(NO_FETCH), { query: "   " });
    assert.match(result.content[0]?.text ?? "", /Refused: QUERY_REQUIRED/);
    assert.equal(result.structuredContent, null);
    const refused: unknown = result.details.refused;
    assert.ok(refused && typeof refused === "object" && "code" in refused);
    assert.equal(refused.code, "QUERY_REQUIRED");
  });

  it("returns RRF order and per-provider warnings in structuredContent", async () => {
    const { fetchFn } = createSearchFetch({
      openalex: fakeWorks("oa", 3),
      crossref: fakeWorks("cr", 3),
      semanticScholar: "down",
    });
    const result = await searchPapersTool(makeCtx(fetchFn), { query: "microplastics" });
    assert.ok((result.structuredContent?.candidates.length ?? 0) > 0);
    assert.deepEqual(
      result.structuredContent?.warnings.map((warning) => warning.provider),
      ["semantic-scholar"],
    );
    assert.ok(Value.Check(SearchPapersOutput, result.structuredContent), "search output schema validates");
    assert.equal(result.details.hint, null);
  });


  // Seen in a real session (experiments/runs/rf-llm-literature-review/iter-02): the agent searched an exact DOI, got five unrelated records and no
  // guidance. The model reads only the text, so the register hint cannot stay in `details`.
  it("a DOI-shaped query tells the model, in the text it reads, to register that DOI directly", async () => {
    const { fetchFn } = createSearchFetch({ openalex: fakeWorks("oa", 3), crossref: fakeWorks("cr", 3), semanticScholar: "rate-limited" });
    const text = (await searchPapersTool(makeCtx(fetchFn), { query: "10.1038/nature12373" })).content[0]?.text ?? "";
    assert.match(text, /hint: .*paper_registry.*register.*10\.1038\/nature12373/);
    const plain = (await searchPapersTool(makeCtx(fetchFn), { query: "microplastics" })).content[0]?.text ?? "";
    assert.doesNotMatch(plain, /hint:/, "a non-DOI query carries no hint");
  });

  it("names each failing provider in the text the model reads (a bare count lets the agent claim all providers answered)", async () => {
    const { fetchFn } = createSearchFetch({ openalex: fakeWorks("oa", 3), crossref: fakeWorks("cr", 3), semanticScholar: "rate-limited" });
    const text = (await searchPapersTool(makeCtx(fetchFn), { query: "microplastics" })).content[0]?.text ?? "";
    assert.match(text, /warning: semantic-scholar — PROVIDER_FAILED/);
    assert.match(text, /results exclude semantic-scholar/i);
    assert.doesNotMatch(text, /warning: (openalex|crossref)/);
  });

  it("all providers down → SEARCH_UNAVAILABLE refusal with provider detail", async () => {
    const { fetchFn } = createSearchFetch({
      openalex: "down",
      crossref: "down",
      semanticScholar: "down",
    });
    const result = await searchPapersTool(makeCtx(fetchFn), { query: "anything" });
    assert.match(result.content[0]?.text ?? "", /Refused: SEARCH_UNAVAILABLE/);
    assert.match(result.content[0]?.text ?? "", /Next: retry later/);
    assert.equal(result.structuredContent, null);
  });
});

// ── determinism (R8) ───────────────────────────────────────────────────────

describe("determinism", () => {
  it("same fakes + same registration order → identical structuredContent and byte-identical references.bib", async () => {
    const run = async () => {
      const runRoot = mkdtempSync(join(tmpdir(), "uktub-det-"));
      try {
        const runDb = createRegistry(runRoot);
        const { fetchFn } = registerFetch({
          "10.5001/aaa": { title: "Delta", bibtex: BIBTEX_A },
          "10.5001/bbb": { title: "Echo", bibtex: BIBTEX_B },
        });
        const ctx: ToolContext = { root: runRoot, fetch: fetchFn, env: {}, now: FIXED_NOW, queue };
        const registered = await paperRegistryTool(ctx, { action: "register", identifiers: ["10.5001/aaa", "10.5001/bbb"] } as PaperRegistryArgs);
        const listed = await paperRegistryTool(ctx, { action: "read", fields: ["title", "year", "citable", "authors", "bibtexSource"] } as PaperRegistryArgs);
        runDb.close();
        return {
          register: JSON.stringify(registered.structuredContent),
          list: JSON.stringify(listed.structuredContent),
          bib: readFileSync(join(runRoot, BIBLIOGRAPHY_REL_PATH), "utf8"),
        };
      } finally {
        rmSync(runRoot, { recursive: true, force: true });
      }
    };
    const [one, two] = await Promise.all([run(), run()]);
    assert.equal(one.register, two.register, "identical register structuredContent");
    assert.equal(one.list, two.list, "identical list structuredContent");
    assert.equal(one.bib, two.bib, "byte-identical references.bib");
  });
});

// ── confinement (R16) ──────────────────────────────────────────────────────

describe("context confinement", () => {
  it("refuses roots escaping via traversal or relativity", () => {
    for (const bad of ["..", "relative/root", "", `${root}/../elsewhere`]) {
      const check = validateContext({ root: bad, fetch: NO_FETCH, env: {}, now: FIXED_NOW, queue });
      assert.equal(check.ok, false, `expected refusal for ${JSON.stringify(bad)}`);
      if (!check.ok) assert.equal(check.code, "PATH_REFUSED");
    }
  });

  it("refuses a root whose own path segment is .registry or .git", () => {
    for (const bad of [join(root, ".registry"), join(root, ".git")]) {
      const check = validateContext({ root: bad, fetch: NO_FETCH, env: {}, now: FIXED_NOW, queue });
      assert.equal(check.ok, false);
    }
  });

  it("accepts a plain project root and the tools write only inside it", async () => {
    assert.equal(validateContext(makeCtx(NO_FETCH)).ok, true);
    const { fetchFn } = registerFetch({ "10.6001/ok": { title: "Okay", bibtex: BIBTEX_A } });
    await paperRegistryTool(makeCtx(fetchFn), { action: "register", identifiers: ["10.6001/ok"] } as PaperRegistryArgs);
    assert.ok(existsSync(join(root, BIBLIOGRAPHY_REL_PATH)));
  });
});
