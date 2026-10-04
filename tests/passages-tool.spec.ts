/**
 * search_passages (roadmap step 3): exploratory retrieval over the registered papers for the writing
 * agent. Hybrid FTS5 + vector search over the SAME chunks claim verification judges, returned as bounded
 * passages with exact pointers, section labels and pages, under the same output containment as evidence.
 * Offline: real SQLite, fake embedding server.
 */
import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { Value } from "typebox/value";

import { WriteQueue } from "../src/core/queue.ts";
import { createRegistry, registerPaper } from "../src/core/registry.ts";
import type { ChunkTextConfig } from "../src/core/chunk.ts";
import { EmbedError, type Embedder } from "../src/core/embed/embedder.ts";
import type { ToolContext } from "../src/core/tools/context.ts";
import { MAX_SEARCH_HITS, SearchPassagesOutput, searchPassagesTool, type SearchPassagesArgs } from "../src/core/tools/passages.ts";
import { chunksOf, publishSource, resolvePointer } from "../src/core/verify/store.ts";

const NOW = () => new Date("2026-10-04T12:00:00Z");
const BIB = "@article{x, title={T}, author={Holder, Ada}, year={2024}}";
const FIXED: ChunkTextConfig = { chunk_tokens: 8192, overlap_tokens: 0, chars_per_token: 2.8, boundary: "paragraph" };

let root: string;
let db: DatabaseSync;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "uktub-pt-"));
  db = createRegistry(root);
});
afterEach(() => {
  db.close();
  rmSync(root, { recursive: true, force: true });
});

const ctx = (env: Record<string, string | undefined> = {}, fetchImpl?: typeof fetch): ToolContext => ({
  root,
  fetch: (fetchImpl ?? (async () => new Response("nope", { status: 404 }))) as unknown as ToolContext["fetch"],
  env,
  now: NOW,
  queue: new WriteQueue(),
});

function writeConfig(boundary: "paragraph" | "section" = "section", chunkTokens = 256): void {
  mkdirSync(join(root, "config"), { recursive: true });
  writeFileSync(
    join(root, "config", "chunking.yaml"),
    `chunking:\n  chunk_tokens: ${chunkTokens}\n  overlap_tokens: 0\n  chars_per_token: 1\n  boundary: ${boundary}\nverification:\n  engine: k2\n  min_confidence: 0.99\n  workers: 2\n  max_judgments: 120\n`,
  );
}

let digestN = 0;
function addPaper(doi: string, title: string, text: string | null, heads: string[] = [], cfg: ChunkTextConfig = FIXED, pageStarts: number[] | null = [0]): void {
  registerPaper(db, { doi, title, authors: ["Holder, Ada"], year: 2024, bibtex: BIB.replace("x,", `${doi.slice(-3)},`), bibtexSource: "crossref" }, { now: NOW });
  if (text === null) return;
  const sections = heads.map((h) => ({ start: text.indexOf(h), heading: h, level: 1 }));
  publishSource(db, doi, { kind: "local-file", ref: `${doi.slice(-3)}.pdf`, license: null, digest: String(++digestN).padStart(64, "0"), extraction: "unpdf@1.8.1/pages-v1", text, pageStarts, sections }, cfg, NOW());
}

const sentence = "The measured outcome improved over the baseline in every configuration we tried. ";
const body = (n: number): string => sentence.repeat(n).trim();
/** n sections "k. Name\n<body>" about a topic word, each ≈ 260 chars so a 256-char cap keeps one section per chunk. */
function sectioned(topic: string, n: number): { text: string; heads: string[] } {
  const heads = Array.from({ length: n }, (_, i) => `${i + 1}. ${topic} part ${i + 1}`);
  return { text: heads.map((h) => `${h}\n${body(3)} ${topic}.`).join("\n"), heads };
}

const run = (args: SearchPassagesArgs, c: ToolContext = ctx(), hooks = {}) => searchPassagesTool(c, args, hooks);
const hitsOf = (r: Awaited<ReturnType<typeof run>>): Record<string, any>[] => (r.structuredContent as any).hits;

describe("search_passages — refusals", () => {
  it("refuses an empty query, one with no searchable words, an over-long one, a bad scope and a bad limit", async () => {
    addPaper("10.1234/aaa", "A", sectioned("alpha", 3).text);
    const cases: [Partial<SearchPassagesArgs>, RegExp][] = [
      [{ query: "" }, /query/],
      [{ query: "   " }, /query/],
      [{ query: "!!! ??? ***" }, /searchable words/],
      [{ query: "x".repeat(501) }, /query/],
      [{ query: "alpha", papers: [] }, /papers/],
      [{ query: "alpha", limit: 0 }, /limit/],
      [{ query: "alpha", limit: MAX_SEARCH_HITS + 1 }, /limit/],
      [{ query: "alpha", limit: 2.5 }, /limit/],
    ];
    for (const [args, re] of cases) {
      const r = await run(args as SearchPassagesArgs);
      assert.equal(r.structuredContent, null, JSON.stringify(args));
      assert.equal((r.details.refused as { code: string }).code, "ARGUMENT_INVALID", JSON.stringify(args));
      assert.match(r.content[0].text, re);
    }
  });

  it("refuses a project that has no registry", async () => {
    const empty = mkdtempSync(join(tmpdir(), "uktub-pt-empty-"));
    try {
      const r = await searchPassagesTool({ ...ctx(), root: empty }, { query: "alpha" }, {});
      assert.equal((r.details.refused as { code: string }).code, "REGISTRY_NOT_INITIALIZED");
    } finally {
      rmSync(empty, { recursive: true, force: true });
    }
  });
});

describe("search_passages — results", () => {
  it("returns ranked passages with pointer, section, page and verbatim excerpt; no score anywhere", async () => {
    writeConfig();
    const s = sectioned("battery", 4);
    addPaper("10.1234/aaa", "Battery paper", s.text, s.heads, { chunk_tokens: 256, overlap_tokens: 0, chars_per_token: 1, boundary: "section" });
    const r = await run({ query: "battery part 2" });
    const out = r.structuredContent as any;
    assert.ok(Value.Check(SearchPassagesOutput, out), JSON.stringify([...Value.Errors(SearchPassagesOutput, out)].slice(0, 2)));
    assert.equal(out.mode, "lexical");
    assert.ok(out.hits.length >= 1);
    const top = out.hits[0];
    assert.equal(top.rank, 1);
    assert.equal(top.section, "2. battery part 2");
    assert.match(top.pointer, /^10\.1234\/aaa@[0-9a-f]{16}#\d+-\d+$/);
    assert.equal(top.page, 1);
    assert.ok(top.excerpt!.startsWith("2. battery part 2"));
    assert.ok(!JSON.stringify(out).match(/score|bm25|rrf/i), "no ranking scores in the output");
    const text = r.content[0].text;
    assert.ok(text.includes(top.pointer) && text.includes("2. battery part 2"), "the model reads pointers and sections in the text content");
  });

  it("every pointer resolves to exactly its excerpt", async () => {
    writeConfig();
    const s = sectioned("battery", 6);
    addPaper("10.1234/aaa", "Battery paper", s.text, s.heads, { chunk_tokens: 256, overlap_tokens: 0, chars_per_token: 1, boundary: "section" });
    const hits = hitsOf(await run({ query: "battery", limit: 3 }));
    assert.ok(hits.length > 0);
    for (const h of hits.filter((x) => x.excerpt !== null)) {
      const res = resolvePointer(db, h.pointer);
      assert.equal(res.status, "current");
      assert.equal((res as { text: string }).text, h.excerpt);
    }
  });

  it("rechunks a paper stored under another policy to the configured section policy before searching", async () => {
    writeConfig("section");
    const s = sectioned("battery", 4);
    addPaper("10.1234/aaa", "Battery paper", s.text, s.heads, FIXED); // stored with paragraph chunks: no labels
    assert.ok(chunksOf(db, "10.1234/aaa").every((c) => c.section === null));
    const out = (await run({ query: "battery" })).structuredContent as any;
    assert.ok(out.hits.every((h: any) => typeof h.section === "string" && h.section.length > 0), "hits carry the section labels of the new policy");
  });

  it("scopes by handle, reports unresolved handles and papers without a usable source, and bounds the hits", async () => {
    writeConfig();
    const a = sectioned("battery", 5);
    const b = sectioned("battery", 5);
    const sec: ChunkTextConfig = { chunk_tokens: 256, overlap_tokens: 0, chars_per_token: 1, boundary: "section" };
    addPaper("10.1234/aaa", "Paper A", a.text, a.heads, sec);
    addPaper("10.1234/bbb", "Paper B", b.text, b.heads, sec);
    addPaper("10.1234/ccc", "Paper C (metadata only)", null);
    const all = (await run({ query: "battery", limit: 4 })).structuredContent as any;
    assert.equal(all.hits.length, 4);
    assert.deepEqual(all.coverage.papers.notSearchable.map((p: any) => p.doi), ["10.1234/ccc"]);
    const onlyB = (await run({ query: "battery", papers: ["10.1234/bbb", "no-such-handle"] })).structuredContent as any;
    assert.ok(onlyB.hits.every((h: any) => h.doi === "10.1234/bbb"));
    assert.deepEqual(onlyB.coverage.papers.unresolved, ["no-such-handle"]);
    assert.equal((await run({ query: "battery" })).structuredContent && ((await run({ query: "battery" })).structuredContent as any).hits.length, 5, "the default limit is 5");
  });

  it("an empty registry and a registry with no searchable source are said plainly, not as 'nothing matched'", async () => {
    assert.match((await run({ query: "battery" })).content[0].text, /no registered papers/i);
    addPaper("10.1234/ccc", "Paper C", null);
    const r = await run({ query: "battery" });
    assert.match(r.content[0].text, /usable source/i);
    assert.equal((r.structuredContent as any).result.found, false);
  });
});

describe("search_passages — output containment (same rules as evidence)", () => {
  it("withholds the text of a passage that is half the source or more, keeps its pointer", async () => {
    writeConfig("section", 800);
    const s = sectioned("solo", 1); // one chunk = the whole source
    addPaper("10.1234/aaa", "Solo", s.text, s.heads, { chunk_tokens: 800, overlap_tokens: 0, chars_per_token: 1, boundary: "section" });
    const [h] = hitsOf(await run({ query: "solo" }));
    assert.equal(h.excerpt, null);
    assert.equal(h.withheld, "whole_source");
    assert.match(h.pointer, /^10\.1234\/aaa@/);
  });

  it("spends one source's release budget in RANK order and withholds the rest as source_share", async () => {
    writeConfig("section", 300);
    const s = sectioned("battery", 12); // 12 sections of ≈ 272 characters, each one whole chunk under the 300-character cap
    addPaper("10.1234/aaa", "Big", s.text, s.heads, { chunk_tokens: 300, overlap_tokens: 0, chars_per_token: 1, boundary: "section" });
    const hits = hitsOf(await run({ query: "battery", limit: 8 }));
    const released = hits.filter((h) => h.excerpt !== null);
    const withheld = hits.filter((h) => h.excerpt === null);
    assert.equal(hits.length, 8);
    assert.ok(released.length >= 2 && released.length <= 3, `released ${released.length}`);
    assert.ok(withheld.length > 0 && withheld.every((h) => h.withheld === "source_share"));
    assert.deepEqual(hits.map((h) => h.rank), hits.map((_, i) => i + 1), "output stays in rank order");
    assert.ok(hits.slice(0, released.length).every((h) => h.excerpt !== null), "the best-ranked passages are the ones released");
    const total = released.reduce((n, h) => n + h.excerpt.length, 0);
    assert.ok(total <= 0.25 * s.text.length, "no more than a quarter of the source leaves in one call");
  });

  it("withholds a passage longer than the excerpt cap (a section of 1,800 characters fits a 2,000-character chunk but cannot leave whole)", async () => {
    writeConfig("section", 2000);
    const longHead = "1. Longsection";
    const others = Array.from({ length: 6 }, (_, i) => `${i + 2}. Other part ${i}\n${body(12)}`);
    const text = [`${longHead}\n${body(22)}`, ...others].join("\n");
    assert.ok(text.indexOf("2. Other part 0") > 1500, "the long section is longer than the excerpt cap");
    addPaper("10.1234/aaa", "Long", text, [longHead, ...others.map((o) => o.split("\n")[0])], { chunk_tokens: 2000, overlap_tokens: 0, chars_per_token: 1, boundary: "section" });
    const hits = hitsOf(await run({ query: "longsection" }));
    const long = hits.find((h) => h.section === longHead);
    assert.ok(long !== undefined, "the long section is found");
    assert.equal(long.excerpt, null);
    assert.equal(long.withheld, "excerpt_cap");
    assert.ok(hits.every((h) => h.excerpt === null || h.excerpt.length <= 1500));
  });
});

describe("search_passages — hybrid and fallback", () => {
  const concept = (over: { failQuery?: boolean } = {}): Embedder => {
    const vec = (t: string): Float32Array => {
      const sunny = /solar|sun/i.test(t); // one concept axis for solar and sun
      const v = [sunny ? 1 : 0.05, 0.05];
      const n = Math.hypot(...v);
      return Float32Array.from(v.map((x) => x / n));
    };
    return {
      id: "concept|none",
      async embedQuery(t) {
        if (over.failQuery) throw new EmbedError("embedding server answered HTTP 503");
        return vec(t.replace("daylight", "sun"));
      },
      async embedDocuments(ts) {
        return ts.map(vec);
      },
    };
  };

  function twoTopics(): void {
    writeConfig();
    const heads = ["1. Methods", "2. Results"];
    const text = `1. Methods\n${body(3)} We cycled cells in a climate chamber.\n2. Results\n${body(3)} Solar panels cut consumption.`;
    addPaper("10.1234/aaa", "Mixed", text, heads, { chunk_tokens: 256, overlap_tokens: 0, chars_per_token: 1, boundary: "section" });
  }

  it("without an embedder configured the search is lexical, by choice (no limitation reported)", async () => {
    twoTopics();
    const out = (await run({ query: "solar" })).structuredContent as any;
    assert.equal(out.mode, "lexical");
    assert.deepEqual(out.result.limitations, []);
  });

  it("an injected embedder gives hybrid search that finds a passage sharing no word with the query", async () => {
    twoTopics();
    const out = (await run({ query: "daylight" }, ctx(), { createEmbedder: () => concept() })).structuredContent as any;
    assert.equal(out.mode, "hybrid");
    assert.equal(out.hits[0].section, "2. Results");
  });

  it("an embedder failure degrades to lexical results and says so in the text the model reads", async () => {
    twoTopics();
    const r = await run({ query: "solar" }, ctx(), { createEmbedder: () => concept({ failQuery: true }) });
    const out = r.structuredContent as any;
    assert.equal(out.mode, "lexical");
    assert.ok(out.hits.length > 0);
    assert.match(r.content[0].text, /vector search unavailable/);
  });

  it("builds the embedder from UKTUB_EMBED_URL: probes the served model, embeds through the OpenAI-compatible endpoint, keys vectors by the served model", async () => {
    twoTopics();
    const seen: string[] = [];
    const server = (async (url: string | URL | Request, init?: RequestInit) => {
      const u = String(url);
      seen.push(`${init?.method ?? "GET"} ${new URL(u).pathname}`);
      if (u.endsWith("/v1/models")) return new Response(JSON.stringify({ data: [{ id: "gemma-served.gguf", meta: { n_embd: 2, size: 12345, ftype: "Q8_0" } }] }));
      const { input } = JSON.parse(String(init?.body)) as { input: string[] };
      return new Response(JSON.stringify({ data: input.map((t, index) => ({ index, embedding: [t.toLowerCase().includes("solar") ? 1 : 0.05, 0.05] })) }));
    }) as unknown as typeof fetch;
    const out = (await run({ query: "solar" }, ctx({ UKTUB_EMBED_URL: "http://127.0.0.1:9999", UKTUB_EMBED_PROFILE: "none" }, server))).structuredContent as any;
    assert.equal(out.mode, "hybrid");
    assert.ok(seen.includes("GET /v1/models") && seen.includes("POST /v1/embeddings"));
    const ids = (db.prepare("SELECT DISTINCT embed_id FROM passage_vectors").all() as { embed_id: string }[]).map((r) => r.embed_id);
    assert.equal(ids.length, 1);
    assert.match(ids[0], /gemma-served\.gguf/);
    assert.match(ids[0], /12345/, "the served model's size fingerprints the identity");
  });

  it("an unknown UKTUB_EMBED_PROFILE is a configuration refusal, not a silent default", async () => {
    twoTopics();
    const r = await run({ query: "solar" }, ctx({ UKTUB_EMBED_URL: "http://127.0.0.1:9999", UKTUB_EMBED_PROFILE: "bogus" }));
    assert.equal((r.details.refused as { code: string }).code, "CONFIG_INVALID");
  });
});
