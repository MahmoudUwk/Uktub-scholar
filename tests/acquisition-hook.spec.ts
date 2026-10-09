/**
 * Explicit acquisition (`paper_registry acquire`), its typed per-paper source status, the registration hook and the shared in-flight map.
 * Offline: provider answers and downloads are fakes; SQLite and the filesystem are real.
 */
import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { Value } from "typebox/value";

import { createRegistry } from "../src/core/registry.ts";
import { PaperRegistryOutput, paperRegistryTool, type PaperRegistryArgs } from "../src/core/tools/registry.ts";
import type { ToolContext } from "../src/core/tools/context.ts";
import { SourceError } from "../src/core/source/extract.ts";
import type { DownloadLike } from "../src/core/source/download.ts";
import { isAcquiring, startBackgroundAcquisition } from "../src/core/verify/acquire.ts";
import { getSource } from "../src/core/verify/store.ts";
import { SEARCH_CFG, createFakeFetch } from "./helpers/provider-fakes.ts";
import { bib, crossrefFake, makeCtx } from "./helpers/registry-fakes.ts";
import { makePdf } from "./helpers/pdf.ts";
import type { FetchLike } from "../src/core/providers/types.ts";

let root: string;
let db: DatabaseSync;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "uktub-acq-"));
  db = createRegistry(root);
});
afterEach(() => {
  db.close();
  rmSync(root, { recursive: true, force: true });
});

const PAPERS = {
  "10.1001/aaa": { title: "Alpha Grid Aging", bibtex: bib("holder2024", "Alpha Grid Aging") },
  "10.1001/bbb": { title: "Beta Cache Layers", bibtex: bib("holder2024a", "Beta Cache Layers") },
};
const pdfFor = (title: string) => makePdf([[title, "Grids age slowly and caches fill with every request."]]);
const call = (ctx: ToolContext, args: Record<string, unknown>) => paperRegistryTool(ctx, args as unknown as PaperRegistryArgs);
const text = (r: { content: { text: string }[] }): string => r.content.map((c) => c.text).join("\n");

/** OpenAlex lookups answer `locations[0].pdf_url`; a missing entry is a 404 (unknown work). */
function acquisitionFetch(pdfUrls: Record<string, string | null>): { fetchFn: FetchLike; lookups: string[] } {
  const lookups: string[] = [];
  const { fetchFn } = createFakeFetch([
    {
      match: (u) => u.startsWith(`${SEARCH_CFG.openalexBaseUrl}/works/`),
      body: "",
    },
  ]);
  const wrapped: FetchLike = async (url, init) => {
    if (url.startsWith(`${SEARCH_CFG.openalexBaseUrl}/works/`)) {
      const doi = decodeURIComponent(url.slice(`${SEARCH_CFG.openalexBaseUrl}/works/`.length).split("?")[0] as string).replace("https://doi.org/", "");
      lookups.push(doi);
      const pdf = pdfUrls[doi];
      if (pdf === undefined) return new Response("{}", { status: 404 });
      return new Response(JSON.stringify({ doi: `https://doi.org/${doi}`, locations: pdf === null ? [] : [{ is_oa: true, pdf_url: pdf }] }), { status: 200 });
    }
    return fetchFn(url, init);
  };
  return { fetchFn: wrapped, lookups };
}

function fakeDownload(files: Record<string, Uint8Array>, delayMs = 0): { download: DownloadLike; calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    download: async (url) => {
      calls.push(url);
      if (delayMs > 0) await new Promise((r) => setTimeout(r, delayMs));
      const bytes = files[url];
      if (bytes === undefined) throw new SourceError("download_failed", "the host answered HTTP 404");
      return { finalUrl: url, contentType: null, bytes };
    },
  };
}

async function seed(): Promise<void> {
  const { fetchFn } = crossrefFake(PAPERS);
  const r = await call(makeCtx(root, fetchFn), { action: "register", identifiers: Object.keys(PAPERS) });
  assert.equal(r.structuredContent?.outcomes.every((o: { status: string }) => o.status === "registered"), true);
}
const acqCtx = (fetchFn: FetchLike, download: DownloadLike, extra: Partial<ToolContext> = {}): ToolContext => makeCtx(root, fetchFn, { download, ...extra });

describe("paper_registry acquire", () => {
  it("prepares the sources of papers that have none and reports a typed status per paper", async () => {
    await seed();
    const { fetchFn } = acquisitionFetch({ "10.1001/aaa": "https://repo.example/aaa.pdf", "10.1001/bbb": "https://repo.example/bbb.pdf" });
    const { download } = fakeDownload({ "https://repo.example/aaa.pdf": pdfFor("Alpha Grid Aging"), "https://repo.example/bbb.pdf": pdfFor("Beta Cache Layers") });
    const r = await call(acqCtx(fetchFn, download), { action: "acquire" });
    assert.equal(r.details.refused, undefined, text(r));
    const o = r.structuredContent!.outcomes;
    assert.deepEqual(o.map((x: { source: { status: string } }) => x.source.status), ["ready", "ready"]);
    assert.equal(o[0].source.kind, "openalex-pdf-url");
    assert.equal(getSource(db, "10.1001/aaa")?.status, "ready");
    assert.match(text(r), /acquire: 2 paper\(s\) — 2 ready/);
    assert.ok(Value.Check(PaperRegistryOutput, r.structuredContent), JSON.stringify([...Value.Errors(PaperRegistryOutput, r.structuredContent)].slice(0, 2)));
  });

  it("names the reason a paper has no source (unavailable or failed) and leaves the others ready; handles restrict the set", async () => {
    await seed();
    const { fetchFn } = acquisitionFetch({ "10.1001/aaa": "https://repo.example/aaa.pdf" }); // bbb: unknown to OpenAlex
    const { download } = fakeDownload({ "https://repo.example/aaa.pdf": pdfFor("Alpha Grid Aging") });
    const r = await call(acqCtx(fetchFn, download), { action: "acquire" });
    const [a, b] = r.structuredContent!.outcomes;
    assert.deepEqual([a.source.status, b.source.status, b.source.failureCode], ["ready", "unavailable", "no_open_copy"]);
    assert.match(text(r), /unavailable no_open_copy/);
    const one = await call(acqCtx(fetchFn, download), { action: "acquire", handles: ["10.1001/aaa", "10.9999/not-registered"] });
    assert.deepEqual(one.structuredContent!.outcomes.map((x: { status: string }) => x.status), ["ready", "absent"]);
  });

  it("two concurrent calls fetch each paper once: an in-flight acquisition is shared, not repeated", async () => {
    await seed();
    const { fetchFn, lookups } = acquisitionFetch({ "10.1001/aaa": "https://repo.example/aaa.pdf", "10.1001/bbb": "https://repo.example/bbb.pdf" });
    const dl = fakeDownload({ "https://repo.example/aaa.pdf": pdfFor("Alpha Grid Aging"), "https://repo.example/bbb.pdf": pdfFor("Beta Cache Layers") }, 40);
    const [x, y] = await Promise.all([call(acqCtx(fetchFn, dl.download), { action: "acquire" }), call(acqCtx(fetchFn, dl.download), { action: "acquire" })]);
    assert.deepEqual([x.structuredContent!.outcomes.map((o: { source: { status: string } }) => o.source.status), y.structuredContent!.outcomes.map((o: { source: { status: string } }) => o.source.status)], [["ready", "ready"], ["ready", "ready"]]);
    assert.equal(dl.calls.length, 2, "one download per paper, not per caller");
    assert.equal(lookups.length, 2);
  });

  it("does not repeat a lookup that found no open copy for an hour, then tries again", async () => {
    await seed();
    const { fetchFn, lookups } = acquisitionFetch({});
    const { download } = fakeDownload({});
    let clock = Date.parse("2026-10-04T00:00:00Z");
    const ctx = acqCtx(fetchFn, download, { now: () => new Date(clock) });
    await call(ctx, { action: "acquire" });
    const first = lookups.length;
    assert.ok(first >= 2);
    const again = await call(ctx, { action: "acquire" });
    assert.equal(lookups.length, first, "no new provider lookups inside the hour");
    assert.match(text(again), /no_open_copy/, "the stored reason is still reported");
    clock += 61 * 60 * 1000;
    await call(ctx, { action: "acquire" });
    assert.ok(lookups.length > first, "after the throttle the lookups run again");
  });

  it("with no document transport it says so instead of pretending", async () => {
    await seed();
    const r = await call(makeCtx(root, acquisitionFetch({}).fetchFn), { action: "acquire" });
    assert.deepEqual(r.structuredContent!.outcomes.map((o: { source: { failureCode: string } }) => o.source.failureCode), ["acquisition_disabled", "acquisition_disabled"]);
  });

  it("accepts no arguments other than handles", async () => {
    const r = await call(makeCtx(root, acquisitionFetch({}).fetchFn), { action: "acquire", identifiers: ["10.1001/aaa"] });
    assert.equal((r.details.refused as { code?: string }).code, "ARGUMENT_INVALID");
  });
});

describe("registration hook", () => {
  it("is told only about newly registered or refreshed papers, after the commit, and a failing hook never fails registration", async () => {
    const seen: string[][] = [];
    const { fetchFn } = crossrefFake({ ...PAPERS, "10.1001/ccc": { title: "Gone", status: 404 } });
    const ctx = makeCtx(root, fetchFn, { afterRegister: (dois) => { seen.push(dois); throw new Error("hook exploded"); } });
    const r = await call(ctx, { action: "register", identifiers: ["10.1001/aaa", "10.1001/AAA", "10.1001/bbb", "10.1001/ccc", "banana"] });
    assert.equal(r.details.refused, undefined, "a throwing hook must not turn a registration into an error");
    assert.deepEqual(seen, [["10.1001/aaa", "10.1001/bbb"]], "no duplicates, no refusals");
    assert.deepEqual(r.structuredContent!.outcomes.slice(0, 3).map((o: { status: string }) => o.status), ["registered", "duplicate", "registered"]);
  });

  it("reports the typed source status of what it registered: acquiring when a hook will run, metadata_only when not", async () => {
    const { fetchFn } = crossrefFake(PAPERS);
    const withHook = await call(makeCtx(root, fetchFn, { afterRegister: () => {} }), { action: "register", identifiers: ["10.1001/aaa"] });
    assert.equal(withHook.structuredContent!.outcomes[0].source.status, "acquiring");
    const without = await call(makeCtx(root, fetchFn), { action: "register", identifiers: ["10.1001/bbb"] });
    assert.equal(without.structuredContent!.outcomes[0].source.status, "metadata_only");
    assert.ok(Value.Check(PaperRegistryOutput, withHook.structuredContent));
  });

  it("the background acquisition prepares the sources, is visible as acquiring while it runs, and never throws into the caller", async () => {
    await seed();
    const { fetchFn } = acquisitionFetch({ "10.1001/aaa": "https://repo.example/aaa.pdf", "10.1001/bbb": "https://repo.example/bbb.pdf" });
    const { download } = fakeDownload({ "https://repo.example/aaa.pdf": pdfFor("Alpha Grid Aging"), "https://repo.example/bbb.pdf": pdfFor("Beta Cache Layers") }, 30);
    const ctx = acqCtx(fetchFn, download);
    const done = startBackgroundAcquisition(ctx, ["10.1001/aaa", "10.1001/bbb"]);
    await new Promise((r) => setTimeout(r, 10));
    assert.equal(isAcquiring(root, "10.1001/aaa"), true);
    const mid = await call(makeCtx(root, fetchFn), { action: "read", fields: ["source"] });
    assert.ok(mid.structuredContent!.records.some((rec: { source: { status: string } }) => rec.source.status === "acquiring"));
    await done;
    assert.equal(isAcquiring(root, "10.1001/aaa"), false);
    assert.deepEqual(["10.1001/aaa", "10.1001/bbb"].map((d) => getSource(db, d)?.status), ["ready", "ready"]);
    await startBackgroundAcquisition(acqCtx(fetchFn, async () => { throw new Error("transport exploded"); }), ["10.1001/zzz"]); // unknown paper, broken transport: resolves
  });
});
