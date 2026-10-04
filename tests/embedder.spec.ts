/**
 * Embedding client (roadmap step 3). One OpenAI-compatible `/v1/embeddings` client serves any
 * local server (llama-server, Ollama, vLLM): the package decides prefixes, batching, validation and
 * identity; the server decides nothing. Offline: a fake `fetch` plays the server.
 *
 * Contract:
 *  - queries and documents get the profile's task prefixes (EmbeddingGemma needs them);
 *  - vectors come back L2-normalised, finite and of one dimension, in INPUT order;
 *  - nothing malformed is ever returned (a bad vector would silently corrupt retrieval);
 *  - an error never quotes the passages that were sent (agent-visible text).
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { EMBED_PROFILES, EmbedError, MAX_EMBED_DIM, createHttpEmbedder, type Embedder } from "../src/core/embed/embedder.ts";

interface Seen {
  url: string;
  body: { input: string[]; model: string };
}

/** A fake server: each text maps to a deterministic vector derived from its length (and optional hooks). */
function fakeServer(over: { dim?: number; scale?: number; shuffle?: boolean; status?: number; body?: string; vectors?: (texts: string[]) => unknown } = {}): { fetch: typeof fetch; seen: Seen[] } {
  const seen: Seen[] = [];
  const dim = over.dim ?? 4;
  const fetchFn = (async (url: string | URL | Request, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body)) as Seen["body"];
    seen.push({ url: String(url), body });
    if (over.status !== undefined && over.status !== 200) return new Response(over.body ?? "boom", { status: over.status });
    const vectors = over.vectors?.(body.input) ?? body.input.map((t) => Array.from({ length: dim }, (_, i) => ((t.length + 1) * (i + 1)) * (over.scale ?? 1)));
    let data = (vectors as number[][]).map((embedding, index) => ({ index, embedding }));
    if (over.shuffle) data = [...data].reverse();
    return new Response(JSON.stringify({ data }), { status: 200, headers: { "content-type": "application/json" } });
  }) as typeof fetch;
  return { fetch: fetchFn, seen };
}

const make = (srv: { fetch: typeof fetch }, o: Partial<Parameters<typeof createHttpEmbedder>[0]> = {}): Embedder =>
  createHttpEmbedder({ url: "http://127.0.0.1:8123", model: "m1", profile: EMBED_PROFILES.embeddinggemma, fetch: srv.fetch, ...o });

const norm = (v: Float32Array): number => Math.sqrt([...v].reduce((a, b) => a + b * b, 0));

describe("createHttpEmbedder", () => {
  it("applies the profile's query and document prefixes and posts to /v1/embeddings", async () => {
    const srv = fakeServer();
    const e = make(srv, { url: "http://127.0.0.1:8123/" });
    await e.embedQuery("battery aging");
    await e.embedDocuments(["a passage"]);
    assert.equal(srv.seen[0].url, "http://127.0.0.1:8123/v1/embeddings", "a trailing slash is not doubled");
    assert.deepEqual(srv.seen[0].body.input, ["task: search result | query: battery aging"]);
    assert.deepEqual(srv.seen[1].body.input, ["title: none | text: a passage"]);
    assert.equal(srv.seen[0].body.model, "m1");
  });

  it("the none profile sends text unchanged", async () => {
    const srv = fakeServer();
    await make(srv, { profile: EMBED_PROFILES.none }).embedDocuments(["raw"]);
    assert.deepEqual(srv.seen[0].body.input, ["raw"]);
  });

  it("returns L2-normalised Float32 vectors even when the server does not normalise", async () => {
    const e = make(fakeServer({ scale: 7.5 }));
    const [v] = await e.embedDocuments(["x"]);
    assert.ok(v instanceof Float32Array);
    assert.ok(Math.abs(norm(v) - 1) < 1e-6);
  });

  it("batches large inputs, keeps INPUT order even when the server answers out of order, and sends no empty request", async () => {
    const srv = fakeServer({ shuffle: true });
    const e = make(srv, { batchSize: 16 });
    const texts = Array.from({ length: 40 }, (_, i) => "t".repeat(i + 1));
    const vecs = await e.embedDocuments(texts);
    assert.equal(srv.seen.length, 3);
    assert.deepEqual(srv.seen.map((s) => s.body.input.length), [16, 16, 8]);
    // each text's vector direction is a function of its length: identical lengths would collide, so compare to a one-by-one run
    const solo = await make(fakeServer()).embedDocuments(texts);
    vecs.forEach((v, i) => assert.deepEqual([...v], [...solo[i]], `vector ${i} belongs to text ${i}`));
    const none = fakeServer();
    assert.deepEqual(await make(none).embedDocuments([]), []);
    assert.equal(none.seen.length, 0);
  });

  it("refuses malformed server output instead of returning it", async () => {
    const cases: [string, ReturnType<typeof fakeServer>][] = [
      ["wrong count", fakeServer({ vectors: () => [[1, 2, 3, 4]] })],
      ["NaN component", fakeServer({ vectors: (t) => t.map(() => [1, null, 3, 4]) })],
      ["string component", fakeServer({ vectors: (t) => t.map(() => [1, "2", 3, 4]) })],
      ["zero vector", fakeServer({ vectors: (t) => t.map(() => [0, 0, 0, 0]) })],
      ["empty vector", fakeServer({ vectors: (t) => t.map(() => []) })],
      ["ragged dimensions", fakeServer({ vectors: () => [[1, 2, 3, 4], [1, 2, 3]] })],
    ];
    for (const [label, srv] of cases) await assert.rejects(make(srv).embedDocuments(["a", "b"]), (e) => e instanceof EmbedError, label);
  });

  it("a dimension that changes between calls is refused (a swapped model behind the same URL)", async () => {
    let dim = 4;
    const fetchFn = (async (_u: unknown, init?: RequestInit) => {
      const { input } = JSON.parse(String(init?.body)) as { input: string[] };
      return new Response(JSON.stringify({ data: input.map((_, index) => ({ index, embedding: Array.from({ length: dim }, () => 1) })) }));
    }) as typeof fetch;
    const e = createHttpEmbedder({ url: "http://127.0.0.1:1", model: "m", profile: EMBED_PROFILES.none, fetch: fetchFn });
    await e.embedDocuments(["a"]);
    dim = 8;
    await assert.rejects(e.embedDocuments(["b"]), (err) => err instanceof EmbedError && /dimension/.test(err.message));
  });

  it("HTTP errors become EmbedError; a body that quotes the submitted text is withheld, other bodies are bounded", async () => {
    const passage = "Capacity faded twelve percent over five hundred cycles at forty five degrees.";
    await assert.rejects(make(fakeServer({ status: 500, body: `context overflow for input: ${passage}` })).embedDocuments([passage]), (err) => {
      assert.ok(err instanceof EmbedError);
      assert.ok(!err.message.includes("Capacity faded"), err.message);
      assert.match(err.message, /withheld/);
      return true;
    });
    await assert.rejects(make(fakeServer({ status: 503, body: "x".repeat(5000) })).embedDocuments(["a"]), (err) => err instanceof EmbedError && err.message.length < 500 && /503/.test(err.message));
  });

  it("an error body that echoes the passage is withheld even when the passage has runs of whitespace the server collapsed (review finding)", async () => {
    const passage = "Secret  cycle-life   result of 4.2 percent  degradation per hundred cycles";
    const collapsed = passage.replace(/\s+/g, " ");
    await assert.rejects(make(fakeServer({ status: 400, body: `input rejected: ["${collapsed}"]` })).embedDocuments([passage]), (err) => {
      assert.ok(err instanceof EmbedError);
      assert.ok(!err.message.includes("cycle-life"), err.message);
      return true;
    });
  });

  it("extreme but finite components are scaled before normalising, so a valid vector never becomes NaN, Infinity or zero (review finding)", async () => {
    for (const comps of [[1e200, 1e200], [1e-50, 1e-50], [4e38, 1], [3e38, 3e38]]) {
      const [v] = await make(fakeServer({ vectors: (t) => t.map(() => comps) })).embedDocuments(["x"]);
      assert.ok([...v].every(Number.isFinite), `finite for ${comps}`);
      assert.ok(Math.abs(norm(v) - 1) < 1e-5, `unit length for ${comps}`);
    }
  });

  it("a vector wider than any real embedding model is refused rather than stored (review finding)", async () => {
    const huge = Array.from({ length: MAX_EMBED_DIM + 1 }, () => 1);
    await assert.rejects(make(fakeServer({ vectors: (t) => t.map(() => huge) })).embedDocuments(["x"]), (e) => e instanceof EmbedError && /dimension/.test(e.message));
  });

  it("a network failure or an abort is an EmbedError, never a raw exception", async () => {
    const down = (async () => {
      throw new TypeError("fetch failed: ECONNREFUSED");
    }) as typeof fetch;
    await assert.rejects(make({ fetch: down }).embedQuery("q"), (e) => e instanceof EmbedError);
    const ctl = new AbortController();
    const slow = ((_u: unknown, init?: RequestInit) =>
      new Promise((_res, rej) => init?.signal?.addEventListener("abort", () => rej(new DOMException("aborted", "AbortError"))))) as typeof fetch;
    const p = make({ fetch: slow }).embedQuery("q", ctl.signal);
    ctl.abort();
    await assert.rejects(p, (e) => e instanceof EmbedError && /cancel|abort|timed out/i.test(e.message));
  });

  it("identity names model and profile (a different prefix profile is a different vector space)", () => {
    const a = make(fakeServer(), { model: "gemma-q8" });
    const b = make(fakeServer(), { model: "gemma-q8", profile: EMBED_PROFILES.none });
    const c = make(fakeServer(), { model: "other" });
    assert.notEqual(a.id, b.id);
    assert.notEqual(a.id, c.id);
    assert.match(a.id, /gemma-q8/);
    assert.equal(a.id, make(fakeServer(), { model: "gemma-q8" }).id, "stable");
  });

  it("refuses a URL that is not http(s)", () => {
    for (const url of ["file:///etc/passwd", "ftp://x", "not a url", ""]) assert.throws(() => make(fakeServer(), { url }), (e) => e instanceof EmbedError, url);
  });
});
