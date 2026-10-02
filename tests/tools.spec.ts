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
import { ListPapersOutput, listPapersTool, LIST_PAPERS_CAP } from "../src/core/tools/list.ts";
import { registerPapersTool } from "../src/core/tools/register.ts";
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
    const first = registerPapersTool(ctx, { dois: ["10.1111/one"] });
    const second = registerPapersTool(ctx, { dois: ["10.2222/two"] });
    const [firstResult, secondResult] = await Promise.all([first, second]);
    assert.equal(firstResult.structuredContent?.outcomes[0]?.status, "registered");
    assert.equal(secondResult.structuredContent?.outcomes[0]?.status, "registered");
    // Both committed; the BEGIN IMMEDIATE fence kept the sections apart.
    assert.equal(listPapers(db).length, 2);
  });
});

// ── register: batch partial failure, cap, mismatch ─────────────────────────

describe("register_papers", () => {
  it("middle DOI 404 → per-DOI refusal, good DOIs committed, bib reflects exactly those", async () => {
    const { fetchFn } = registerFetch({
      "10.1001/aaa": { title: "Alpha", bibtex: BIBTEX_A },
      "10.1001/missing": { title: "Ghost", bibtex: null, status: 404 },
      "10.1001/ccc": { title: "Gamma", bibtex: BIBTEX_B },
    });
    const result = await registerPapersTool(makeCtx(fetchFn), {
      dois: ["10.1001/aaa", "10.1001/missing", "10.1001/ccc"],
    });
    const outcomes = result.structuredContent?.outcomes ?? [];
    assert.deepEqual(
      outcomes.map((outcome) => [outcome.doi, outcome.status]),
      [
        ["10.1001/aaa", "registered"],
        ["10.1001/missing", "refused"],
        ["10.1001/ccc", "registered"],
      ],
    );
    assert.equal(outcomes[1]?.refusalCode, "DOI_NOT_FOUND");
    // A per-DOI refusal never fails the whole batch call (R5).
    assert.match(result.content[0]?.text ?? "", /2 of 3/);
    assert.deepEqual(
      listPapers(db).map((row) => row.doi),
      ["10.1001/aaa", "10.1001/ccc"],
    );
    const bib = readFileSync(join(root, BIBLIOGRAPHY_REL_PATH), "utf8");
    assert.match(bib, /holder2024/);
    assert.equal(bib.match(/@article/g)?.length, 2);
  });

  it("over the 50-DOI cap the whole call refuses BATCH_TOO_LARGE (client policy, R19)", async () => {
    const { fetchFn } = registerFetch({});
    const result = await registerPapersTool(makeCtx(fetchFn), {
      dois: Array.from({ length: 51 }, (_, i) => `10.9001/b${i}`),
    });
    assert.match(result.content[0]?.text ?? "", /Refused: BATCH_TOO_LARGE/);
    assert.match(result.content[0]?.text ?? "", /Next: split the batch/);
    assert.equal(listPapers(db).length, 0);
  });

  it("malformed DOI → INVALID_DOI per-DOI refusal without touching providers", async () => {
    const { fetchFn } = registerFetch({});
    const result = await registerPapersTool(makeCtx(fetchFn), { dois: ["1234.5678"] });
    assert.equal(result.structuredContent?.outcomes[0]?.refusalCode, "INVALID_DOI");
  });

  it("BibTeX-less registration → BIBTEX_UNAVAILABLE warning on the successful outcome", async () => {
    const { fetchFn } = registerFetch({ "10.2001/bib": { title: "No Bib", bibtex: null } });
    const result = await registerPapersTool(makeCtx(fetchFn), { dois: ["10.2001/bib"] });
    assert.equal(result.structuredContent?.outcomes[0]?.status, "registered");
    assert.equal(result.structuredContent?.outcomes[0]?.citable, false);
    assert.deepEqual(result.structuredContent?.outcomes[0]?.warnings, ["BIBTEX_UNAVAILABLE"]);
    assert.deepEqual(
      result.structuredContent?.warnings.map((warning) => warning.code),
      ["BIBTEX_UNAVAILABLE"],
    );
  });

  it("OpenAlex and Crossref disagree on the title → DOI_TITLE_MISMATCH warning", async () => {
    const { fetchFn } = createFakeFetch([
      {
        match: (url: string) => decodeURIComponent(url).includes("/works/10.3001/mm") && !url.includes("/transform/"),
        body: crossrefWorkEnvelope({ doi: "10.3001/mm", title: "Crossref Title", year: 2024 }),
      },
      { match: (url: string) => decodeURIComponent(url).includes("/works/10.3001/mm/transform/"), body: BIBTEX_A },
      {
        match: (url: string) => decodeURIComponent(url).includes("api.openalex"),
        body: JSON.stringify({ title: "OpenAlex Title" }),
      },
    ]);
    const result = await registerPapersTool(makeCtx(fetchFn), { dois: ["10.3001/mm"] });
    assert.equal(result.structuredContent?.outcomes[0]?.status, "registered");
    assert.deepEqual(
      result.structuredContent?.warnings.map((warning) => warning.code),
      ["DOI_TITLE_MISMATCH"],
    );
    assert.match(result.structuredContent?.warnings[0]?.message ?? "", /OpenAlex and Crossref disagree/);
  });
});

// ── list ───────────────────────────────────────────────────────────────────

describe("list_papers", () => {
  it("orders citekey ASC and reports truncation with a remaining count", async () => {
    // Three papers, two colliding on author+year+title-word; registration
    // order is pinned (KTD6) and list returns citekey ASC (R6).
    const { fetchFn } = registerFetch({
      "10.4001/aaa": { title: "Zebra", bibtex: BIBTEX_A },
      "10.4001/bbb": { title: "Zebra", bibtex: BIBTEX_B },
      "10.4001/ccc": { title: "Aardvark", bibtex: null },
    });
    await registerPapersTool(makeCtx(fetchFn), { dois: ["10.4001/aaa", "10.4001/bbb", "10.4001/ccc"] });
    const rows = listPapers(db);
    const citekeys = rows.map((row) => row.citekey);
    assert.deepEqual([...citekeys].sort(), citekeys, "citekey ASC");

    const result = listPapersTool(makeCtx(NO_FETCH), { limit: 2 });
    const structured = result.structuredContent;
    assert.ok(structured);
    assert.equal(structured.papers.length, 2);
    assert.equal(structured.truncated, true);
    assert.equal(structured.remaining, rows.length - 2);
    assert.deepEqual(
      structured.papers.map((paper) => paper.citekey),
      citekeys.slice(0, 2),
    );
    assert.ok(Value.Check(ListPapersOutput, structured), "list output schema validates");
  });

  it("at or under the cap: not truncated; the cap is the R19 client policy 200", () => {
    const result = listPapersTool(makeCtx(NO_FETCH));
    assert.equal(result.structuredContent?.truncated, false);
    assert.equal(result.structuredContent?.remaining, 0);
    assert.equal(LIST_PAPERS_CAP, 200);
  });

  it("uninitialized registry → REGISTRY_NOT_INITIALIZED refusal", () => {
    const bare = mkdtempSync(join(tmpdir(), "uktub-bare-"));
    try {
      const ctx: ToolContext = { root: bare, fetch: NO_FETCH, env: {}, now: FIXED_NOW, queue };
      const result = listPapersTool(ctx);
      assert.match(result.content[0]?.text ?? "", /Refused: REGISTRY_NOT_INITIALIZED/);
      assert.equal(result.structuredContent, null);
    } finally {
      rmSync(bare, { recursive: true, force: true });
    }
  });
});

// ── search ─────────────────────────────────────────────────────────────────

describe("search_papers", () => {
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

  it("a DOI-shaped query searches anyway and carries the hint in details", async () => {
    const { fetchFn } = createSearchFetch({
      openalex: fakeWorks("oa", 1),
      crossref: fakeWorks("cr", 1),
      semanticScholar: fakeWorks("s2", 1),
    });
    const result = await searchPapersTool(makeCtx(fetchFn), { query: "10.1234/xyz" });
    assert.match(String(result.details.hint ?? ""), /register_papers/);
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
        const registered = await registerPapersTool(ctx, { dois: ["10.5001/aaa", "10.5001/bbb"] });
        const listed = listPapersTool(ctx, {});
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
      if (!check.ok) assert.match(check.message, /\.registry|\.git/);
    }
  });

  it("accepts a plain project root and the tools write only inside it", async () => {
    assert.equal(validateContext(makeCtx(NO_FETCH)).ok, true);
    const { fetchFn } = registerFetch({ "10.6001/ok": { title: "Okay", bibtex: BIBTEX_A } });
    await registerPapersTool(makeCtx(fetchFn), { dois: ["10.6001/ok"] });
    assert.ok(existsSync(join(root, BIBLIOGRAPHY_REL_PATH)));
  });
});
