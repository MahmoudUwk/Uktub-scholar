/**
 * paper_registry (R1–R6, R14–R15; AE1, AE2): one tool for batch registration,
 * batch removal, projected reads, local-source attachment and bibliography
 * synchronisation. Provider traffic is faked; SQLite and the filesystem are real.
 */
import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { Value } from "typebox/value";

import { BIBLIOGRAPHY_REL_PATH, createRegistry, listPapers, openRegistry } from "../src/core/registry.ts";
import { PaperRegistryOutput, READ_PAGE_MAX_HEAVY, READ_PAGE_MAX_LIGHT, paperRegistryTool, type PaperRegistryArgs } from "../src/core/tools/registry.ts";
import type { ToolContext } from "../src/core/tools/context.ts";
import { getSource, chunksOf } from "../src/core/verify/store.ts";
import { createFakeFetch } from "./helpers/provider-fakes.ts";
import { NO_FETCH, bib, crossrefFake, makeCtx } from "./helpers/registry-fakes.ts";
import { makePdf } from "./helpers/pdf.ts";

let root: string;
let db: DatabaseSync;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "uktub-reg-"));
  db = createRegistry(root);
});
afterEach(() => {
  db.close();
  rmSync(root, { recursive: true, force: true });
});

const call = (ctx: ToolContext, args: Record<string, unknown>) => paperRegistryTool(ctx, args as unknown as PaperRegistryArgs);
const text = (r: { content: { text: string }[] }): string => r.content.map((c) => c.text).join("\n");
const refusedCode = (r: { details: Record<string, unknown> }): string | undefined => (r.details.refused as { code?: string } | undefined)?.code;

const FIVE = {
  "10.1001/aaa": { title: "Alpha Grid", bibtex: bib("holder2024", "Alpha Grid"), abstract: "<jats:p>Grids <jats:italic>age</jats:italic> slowly.</jats:p>" },
  "10.1001/bbb": { title: "Beta Cache", bibtex: bib("holder2024a", "Beta Cache") },
  "10.1001/ccc": { title: "Gamma Ray", bibtex: null },
  "10.1001/ddd": { title: "Delta Wave", bibtex: bib("holder2024b", "Delta Wave") },
  "10.1001/eee": { title: "Epsilon Net", bibtex: bib("holder2024c", "Epsilon Net") },
};
async function seed(dois: string[] = Object.keys(FIVE)) {
  const { fetchFn } = crossrefFake(FIVE);
  const r = await call(makeCtx(root, fetchFn), { action: "register", identifiers: dois });
  assert.equal(r.structuredContent?.outcomes.every((o: { status: string }) => o.status === "registered"), true);
}

describe("register", () => {
  it("AE1: aliases share one canonical identity and one mutation; invalid inputs do not undo valid ones", async () => {
    const { fetchFn, requests } = createFakeFetchWithArxiv();
    const r = await call(makeCtx(root, fetchFn), {
      action: "register",
      identifiers: ["https://doi.org/10.1001/AAA", "10.1001/aaa", "arxiv:2301.00001", "banana"],
    });
    const o = r.structuredContent!.outcomes;
    assert.deepEqual(o.map((x: { index: number; status: string }) => [x.index, x.status]), [[0, "registered"], [1, "duplicate"], [2, "registered"], [3, "refused"]]);
    assert.equal(o[1].duplicateOf, 0);
    assert.equal(o[1].doi, o[0].doi);
    assert.equal(o[1].citekey, o[0].citekey);
    assert.equal(o[2].doi, "10.48550/arxiv.2301.00001");
    assert.equal(o[3].refusalCode, "INVALID_DOI");
    assert.deepEqual(o.map((x: { input: string }) => x.input), ["https://doi.org/10.1001/AAA", "10.1001/aaa", "arxiv:2301.00001", "banana"]);
    assert.equal(listPapers(db).length, 2);
    assert.equal(requests.map(decodeURIComponent).filter((u) => u.includes("crossref.test") && u.includes("/works/10.1001/aaa") && !u.includes("transform")).length, 1, "the alias pair resolved once");
    assert.ok(Value.Check(PaperRegistryOutput, r.structuredContent));
  });

  it("re-registration refreshes metadata, keeps the pinned citekey and provider BibTeX, and does not erase a stored abstract", async () => {
    await seed(["10.1001/aaa"]);
    const first = listPapers(db)[0];
    const { fetchFn } = crossrefFake({ "10.1001/aaa": { title: "Alpha Grid Revised", bibtex: null } });
    const r = await call(makeCtx(root, fetchFn), { action: "register", identifiers: ["10.1001/aaa"] });
    assert.equal(r.structuredContent!.outcomes[0].status, "updated");
    const after = listPapers(db)[0];
    assert.equal(after.citekey, first.citekey);
    assert.equal(after.title, "Alpha Grid Revised");
    assert.equal(after.citable, true, "provider BibTeX is kept when the refresh brings none");
    const read = await call(makeCtx(root, NO_FETCH), { action: "read", fields: ["abstract"] });
    assert.match(text(read), /Grids age slowly\./);
  });

  it("refuses an oversized or empty batch as a whole", async () => {
    const big = await call(makeCtx(root, NO_FETCH), { action: "register", identifiers: Array.from({ length: 51 }, (_, i) => `10.9001/b${i}`) });
    assert.equal(refusedCode(big), "BATCH_TOO_LARGE");
    for (const args of [{ action: "register", identifiers: [] }, { action: "register" }]) {
      assert.equal(refusedCode(await call(makeCtx(root, NO_FETCH), args)), "ARGUMENT_INVALID");
    }
    assert.equal(listPapers(db).length, 0);
  });

  it("keeps the per-DOI refusal, BibTeX and title-mismatch warnings", async () => {
    const { fetchFn } = crossrefFake({ "10.1001/ok": { title: "Okay", bibtex: null }, "10.1001/gone": { title: "Ghost", status: 404 } });
    const r = await call(makeCtx(root, fetchFn), { action: "register", identifiers: ["10.1001/ok", "10.1001/gone"] });
    assert.deepEqual(r.structuredContent!.outcomes.map((o: { status: string; refusalCode: string | null }) => [o.status, o.refusalCode]), [["registered", null], ["refused", "DOI_NOT_FOUND"]]);
    assert.deepEqual(r.structuredContent!.warnings.map((w: { code: string }) => w.code), ["BIBTEX_UNAVAILABLE"]);
    assert.match(text(r), /10\.1001\/gone/);
    assert.match(text(r), /DOI_NOT_FOUND/);
  });

  it("two overlapping calls serialize their write sections and both commit", async () => {
    const { fetchFn } = crossrefFake(FIVE);
    const ctx = makeCtx(root, fetchFn);
    const [a, b] = await Promise.all([call(ctx, { action: "register", identifiers: ["10.1001/aaa"] }), call(ctx, { action: "register", identifiers: ["10.1001/bbb"] })]);
    assert.equal(a.structuredContent!.outcomes[0].status, "registered");
    assert.equal(b.structuredContent!.outcomes[0].status, "registered");
    assert.equal(listPapers(db).length, 2);
  });
});

describe("remove", () => {
  it("removes by DOI, citekey and alias in one batch; reports absent and duplicate inputs in order", async () => {
    await seed();
    const keys = Object.fromEntries(listPapers(db).map((p) => [p.doi, p.citekey]));
    const r = await call(makeCtx(root, NO_FETCH), {
      action: "remove",
      handles: ["https://doi.org/10.1001/AAA", keys["10.1001/bbb"], "10.1001/aaa", keys["10.1001/aaa"], "10.9999/never", "  "],
    });
    const o = r.structuredContent!.outcomes;
    assert.deepEqual(o.map((x: { status: string }) => x.status), ["removed", "removed", "duplicate", "duplicate", "absent", "refused"]);
    assert.equal(o[2].duplicateOf, 0);
    assert.equal(o[3].duplicateOf, 0);
    assert.deepEqual(listPapers(db).map((p) => p.doi).sort(), ["10.1001/ccc", "10.1001/ddd", "10.1001/eee"]);
    const bibText = readFileSync(join(root, BIBLIOGRAPHY_REL_PATH), "utf8");
    assert.ok(!bibText.includes("Alpha Grid") && !bibText.includes("Beta Cache"));
    assert.ok(Value.Check(PaperRegistryOutput, r.structuredContent));
  });

  it("refuses an empty batch, a missing handle list and an oversized batch; there is no delete-all selector", async () => {
    await seed();
    for (const args of [{ action: "remove" }, { action: "remove", handles: [] }, { action: "remove", handles: ["*"] }]) {
      const r = await call(makeCtx(root, NO_FETCH), args);
      if (args.handles?.[0] === "*") assert.equal(r.structuredContent!.outcomes[0].status, "absent");
      else assert.equal(refusedCode(r), "ARGUMENT_INVALID");
    }
    assert.equal(refusedCode(await call(makeCtx(root, NO_FETCH), { action: "remove", handles: Array.from({ length: 51 }, (_, i) => `10.9001/b${i}`) })), "BATCH_TOO_LARGE");
    assert.equal(listPapers(db).length, 5);
  });

  it("removal takes the paper's source, chunks, index and evidence with it, and leaves the human's file alone", async () => {
    await seed(["10.1001/aaa"]);
    const file = join(root, "alpha.pdf");
    writeFileSync(file, makePdf([["Alpha Grid", "Grids age slowly under sustained thermal cycling in the field."]]));
    const att = await call(makeCtx(root, NO_FETCH), { action: "attach_source", attachments: [{ handle: "10.1001/aaa", path: "alpha.pdf" }] });
    assert.equal(att.structuredContent!.outcomes[0].status, "attached");
    await call(makeCtx(root, NO_FETCH), { action: "remove", handles: ["10.1001/aaa"] });
    const check = openRegistry(root);
    for (const t of ["paper_sources", "chunks", "claim_evidence"]) assert.equal((check.prepare(`SELECT COUNT(*) n FROM ${t}`).get() as { n: number }).n, 0, t);
    check.close();
    assert.ok(existsSync(file));
  });
});

describe("read", () => {
  it("default projection carries DOI, citekey, title, year, citable only", async () => {
    await seed();
    const r = await call(makeCtx(root, NO_FETCH), { action: "read" });
    const rec = r.structuredContent!.records[0];
    assert.deepEqual(Object.keys(rec).sort(), ["citable", "citekey", "doi", "title", "year"]);
    assert.equal(r.structuredContent!.total, 5);
    assert.deepEqual(r.structuredContent!.records.map((x: { citekey: string }) => x.citekey), listPapers(db).map((p) => p.citekey));
    for (const p of listPapers(db)) assert.ok(text(r).includes(p.citekey) && text(r).includes(p.doi), "identities are in the model-visible text");
    assert.match(text(r), /\[uncitable\]/);
    assert.ok(Value.Check(PaperRegistryOutput, r.structuredContent));
  });

  it("returns exactly the requested optional fields, with explicit unavailable abstracts and bounded BibTeX", async () => {
    await seed();
    const r = await call(makeCtx(root, NO_FETCH), { action: "read", handles: ["10.1001/aaa", "10.1001/bbb"], fields: ["authors", "venue", "abstract", "source", "refreshedAt", "bibtex", "bibtexSource"] });
    const [a, b] = r.structuredContent!.records;
    assert.deepEqual(a.abstract, { kind: "provider_abstract", provider: "crossref", text: "Grids age slowly.", truncated: false });
    assert.deepEqual(b.abstract, { kind: "unavailable" }, "a missing abstract is stated, not invented");
    assert.deepEqual(a.source, { status: "metadata_only" });
    assert.equal(a.refreshedAt, "2026-10-04T00:00:00Z");
    assert.ok(Array.isArray(a.authors) && a.bibtexSource === "crossref" && typeof a.bibtex === "string");
    assert.match(text(r), /Grids age slowly\./, "requested abstract text is visible to the model");
    assert.match(text(r), /metadata_only/);
  });

  it("rejects unknown fields instead of ignoring them, naming the allowed ones", async () => {
    await seed();
    const r = await call(makeCtx(root, NO_FETCH), { action: "read", fields: ["title", "fulltext"] });
    assert.equal(refusedCode(r), "ARGUMENT_INVALID");
    assert.match(text(r), /fulltext/);
    assert.match(text(r), /abstract/);
  });

  it("AE2: traverses a registry larger than one page with a title/year/source projection, reaching every record once", async () => {
    await seed();
    const seen: string[] = [];
    let cursor: string | undefined;
    let pages = 0;
    do {
      const r = await call(makeCtx(root, NO_FETCH), { action: "read", fields: ["source"], limit: 2, ...(cursor ? { cursor } : {}) });
      assert.ok(r.structuredContent!.records.length <= 2);
      seen.push(...r.structuredContent!.records.map((x: { doi: string }) => x.doi));
      cursor = r.structuredContent!.nextCursor ?? undefined;
      pages++;
      assert.equal(r.structuredContent!.total, 5);
      if (cursor) assert.match(text(r), /cursor/i, "the continuation is visible to the model");
    } while (cursor);
    assert.equal(pages, 3);
    assert.deepEqual(seen, listPapers(db).map((p) => p.doi));
  });

  it("an explicit subset never expands to all; unknown handles are reported; aliases collapse; an empty list is refused", async () => {
    await seed();
    const key = listPapers(db).find((p) => p.doi === "10.1001/ccc")!.citekey;
    const r = await call(makeCtx(root, NO_FETCH), { action: "read", handles: ["https://doi.org/10.1001/AAA", "10.1001/aaa", key, "10.9999/never"] });
    assert.deepEqual(r.structuredContent!.records.map((x: { doi: string }) => x.doi).sort(), ["10.1001/aaa", "10.1001/ccc"]);
    assert.equal(r.structuredContent!.total, 2);
    assert.deepEqual(r.structuredContent!.unresolved, [{ handle: "10.9999/never", reason: "not_registered" }]);
    assert.match(text(r), /10\.9999\/never/);
    assert.equal(refusedCode(await call(makeCtx(root, NO_FETCH), { action: "read", handles: [] })), "ARGUMENT_INVALID");
  });

  it("rejects stale or mismatched continuations", async () => {
    await seed();
    const first = await call(makeCtx(root, NO_FETCH), { action: "read", limit: 2 });
    const cursor = first.structuredContent!.nextCursor as string;
    assert.equal((await call(makeCtx(root, NO_FETCH), { action: "read", limit: 2, cursor, handles: ["10.1001/aaa"] })).structuredContent, null, "different selection");
    assert.equal(refusedCode(await call(makeCtx(root, NO_FETCH), { action: "read", limit: 2, cursor, fields: ["authors"] })), "CONTINUATION_INVALID", "different fields");
    assert.equal(refusedCode(await call(makeCtx(root, NO_FETCH), { action: "read", limit: 2, cursor: "garbage" })), "CONTINUATION_INVALID");
    await call(makeCtx(root, NO_FETCH), { action: "remove", handles: ["10.1001/eee"] });
    assert.equal(refusedCode(await call(makeCtx(root, NO_FETCH), { action: "read", limit: 2, cursor })), "CONTINUATION_INVALID", "registry changed since the cursor was issued");
  });

  it("a cursor that decodes to JSON null, an array, a primitive or malformed JSON is refused as invalid, not thrown", async () => {
    await seed();
    const bibBefore = readFileSync(join(root, BIBLIOGRAPHY_REL_PATH), "utf8");
    const papersBefore = listPapers(db).map((p) => p.citekey);
    for (const decoded of ["null", "[]", "1", '"string"', "{}", "{not json"]) {
      const cursor = Buffer.from(decoded, "utf8").toString("base64url");
      assert.equal(refusedCode(await call(makeCtx(root, NO_FETCH), { action: "read", limit: 2, cursor })), "CONTINUATION_INVALID", decoded);
    }
    assert.deepEqual(listPapers(db).map((p) => p.citekey), papersBefore);
    assert.equal(readFileSync(join(root, BIBLIOGRAPHY_REL_PATH), "utf8"), bibBefore);
  });

  it("caps page size by weight: light projections 100, abstract/BibTeX projections 25", async () => {
    await seed();
    const light = await call(makeCtx(root, NO_FETCH), { action: "read", limit: 5000 });
    assert.equal(light.structuredContent!.records.length, 5);
    assert.ok(READ_PAGE_MAX_LIGHT > READ_PAGE_MAX_HEAVY);
    assert.equal(light.details.pageLimit, READ_PAGE_MAX_LIGHT);
    const heavy = await call(makeCtx(root, NO_FETCH), { action: "read", limit: 5000, fields: ["abstract"] });
    assert.equal(heavy.details.pageLimit, READ_PAGE_MAX_HEAVY);
  });

  it("an empty registry is a valid empty read; an uninitialised project refuses", async () => {
    const r = await call(makeCtx(root, NO_FETCH), { action: "read" });
    assert.deepEqual([r.structuredContent!.total, r.structuredContent!.records], [0, []]);
    assert.match(text(r), /empty/i);
    const bare = mkdtempSync(join(tmpdir(), "uktub-bare-"));
    try {
      assert.equal(refusedCode(await call(makeCtx(bare, NO_FETCH), { action: "read" })), "REGISTRY_NOT_INITIALIZED");
    } finally {
      rmSync(bare, { recursive: true, force: true });
    }
  });
});

describe("attach_source", () => {
  const ALPHA = "Alpha Grid";
  const writeProjectPdf = (rel: string, lines: string[]) => {
    const abs = join(root, rel);
    mkdirSync(join(abs, ".."), { recursive: true });
    writeFileSync(abs, makePdf([lines]));
    return abs;
  };
  const BODY = "Grids age slowly under sustained thermal cycling in the field, and the distinctive sentence about harmonic resonance stays inside.";

  it("prepares a local PDF into a ready source with derived chunks, never echoing text, leaving the file in place", async () => {
    await seed();
    const abs = writeProjectPdf("papers/alpha.pdf", [ALPHA, BODY]);
    const r = await call(makeCtx(root, NO_FETCH), { action: "attach_source", attachments: [{ handle: "10.1001/aaa", path: "papers/alpha.pdf" }] });
    const o = r.structuredContent!.outcomes[0];
    assert.deepEqual([o.status, o.doi, o.source.status], ["attached", "10.1001/aaa", "ready"]);
    assert.match(o.source.revision, /^[0-9a-f]{16}$/);
    const src = getSource(db, "10.1001/aaa")!;
    assert.deepEqual([src.status, src.kind, src.ref], ["ready", "local-file", "papers/alpha.pdf"]);
    assert.ok(chunksOf(db, "10.1001/aaa").length >= 1);
    assert.ok(!JSON.stringify(r).includes("harmonic resonance"), "R5: no source text in any response surface");
    assert.ok(existsSync(abs));
    const again = await call(makeCtx(root, NO_FETCH), { action: "attach_source", attachments: [{ handle: "10.1001/aaa", path: "papers/alpha.pdf" }] });
    assert.equal(again.structuredContent!.outcomes[0].source.reused, true);
  });

  it("refuses paths outside the project, protected segments, symlink escapes, directories and missing files — per item, mutating nothing", async () => {
    await seed();
    const outside = mkdtempSync(join(tmpdir(), "uktub-outside-"));
    writeFileSync(join(outside, "x.pdf"), makePdf([[ALPHA, BODY]]));
    symlinkSync(join(outside, "x.pdf"), join(root, "link.pdf"));
    mkdirSync(join(root, "adir"));
    const paths = [join(outside, "x.pdf"), "../x.pdf", ".registry/registry.db", ".git/config", "link.pdf", "adir", "missing.pdf"];
    const r = await call(makeCtx(root, NO_FETCH), { action: "attach_source", attachments: paths.map((p) => ({ handle: "10.1001/aaa", path: p })) });
    assert.deepEqual(r.structuredContent!.outcomes.map((o: { status: string; refusalCode: string }) => [o.status, o.refusalCode]), paths.map(() => ["refused", "PATH_REFUSED"]));
    assert.equal(getSource(db, "10.1001/aaa"), null);
    rmSync(outside, { recursive: true, force: true });
  });

  it("accepts a file whose name merely starts with two dots (review finding)", async () => {
    await seed();
    writeProjectPdf("..notes.pdf", [ALPHA, BODY]);
    const r = await call(makeCtx(root, NO_FETCH), { action: "attach_source", attachments: [{ handle: "10.1001/aaa", path: "..notes.pdf" }] });
    assert.equal(r.structuredContent!.outcomes[0].status, "attached");
  });

  it("refuses a file that is another paper, an image-only PDF, and non-documents, recording truthful readiness", async () => {
    await seed();
    writeProjectPdf("other.pdf", ["Federated learning for wireless foundation models and their encoder architecture."]);
    writeFileSync(join(root, "notes.txt"), "just some notes");
    const r = await call(makeCtx(root, NO_FETCH), { action: "attach_source", attachments: [{ handle: "10.1001/aaa", path: "other.pdf" }, { handle: "10.1001/bbb", path: "notes.txt" }] });
    const [a, b] = r.structuredContent!.outcomes;
    assert.deepEqual([a.status, a.refusalCode, a.source.failureCode], ["refused", "SOURCE_UNUSABLE", "identity_mismatch"]);
    assert.equal(b.source.failureCode, "not_a_document");
    assert.equal(getSource(db, "10.1001/aaa")!.status, "failed");
    assert.equal(getSource(db, "10.1001/aaa")!.failureCode, "identity_mismatch");
  });

  it("reports unknown handles per item and refuses oversized or empty batches", async () => {
    await seed();
    writeProjectPdf("alpha.pdf", [ALPHA, BODY]);
    const r = await call(makeCtx(root, NO_FETCH), { action: "attach_source", attachments: [{ handle: "10.9999/never", path: "alpha.pdf" }] });
    assert.equal(r.structuredContent!.outcomes[0].refusalCode, "DOI_NOT_FOUND");
    const many = Array.from({ length: 11 }, () => ({ handle: "10.1001/aaa", path: "alpha.pdf" }));
    assert.equal(refusedCode(await call(makeCtx(root, NO_FETCH), { action: "attach_source", attachments: many })), "BATCH_TOO_LARGE");
    assert.equal(refusedCode(await call(makeCtx(root, NO_FETCH), { action: "attach_source", attachments: [] })), "ARGUMENT_INVALID");
  });

  it("the read action shows the source state without any text", async () => {
    await seed();
    writeProjectPdf("alpha.pdf", [ALPHA, BODY]);
    await call(makeCtx(root, NO_FETCH), { action: "attach_source", attachments: [{ handle: "10.1001/aaa", path: "alpha.pdf" }] });
    const r = await call(makeCtx(root, NO_FETCH), { action: "read", handles: ["10.1001/aaa"], fields: ["source"] });
    const s = r.structuredContent!.records[0].source;
    assert.deepEqual([s.status, s.kind, s.ref], ["ready", "local-file", "alpha.pdf"]);
    assert.match(s.revision, /^[0-9a-f]{16}$/);
    assert.ok(!JSON.stringify(r).includes("harmonic resonance"));
  });
});

describe("sync_bibliography", () => {
  it("re-renders the derived bibliography from the registry, never importing human edits", async () => {
    await seed();
    const bibPath = join(root, BIBLIOGRAPHY_REL_PATH);
    chmodSync(bibPath, 0o644); // the rendered file is read-only; the human makes it writable on purpose
    writeFileSync(bibPath, "@article{human, title={Hand edit}}\n");
    const r = await call(makeCtx(root, NO_FETCH), { action: "sync_bibliography" });
    assert.equal(r.structuredContent!.synced, 4);
    const content = readFileSync(bibPath, "utf8");
    assert.ok(!content.includes("Hand edit") && content.includes("holder2024"));
    assert.match(text(r), /4/);
    assert.equal(listPapers(db).length, 5);
    assert.ok(Value.Check(PaperRegistryOutput, r.structuredContent));
  });
});

describe("argument contract", () => {
  it("refuses an unknown action and arguments belonging to another action", async () => {
    assert.equal(refusedCode(await call(makeCtx(root, NO_FETCH), { action: "explode" })), "ARGUMENT_INVALID");
    assert.equal(refusedCode(await call(makeCtx(root, NO_FETCH), { action: "read", identifiers: ["10.1001/aaa"] })), "ARGUMENT_INVALID");
    assert.equal(refusedCode(await call(makeCtx(root, NO_FETCH), { action: "register", identifiers: ["10.1001/aaa"], cursor: "x" })), "ARGUMENT_INVALID");
  });
});

/** Crossref for 10.1001/aaa plus DataCite for one arXiv id. */
function createFakeFetchWithArxiv() {
  const crossref = crossrefFake({ "10.1001/aaa": FIVE["10.1001/aaa"] });
  const requests: string[] = [];
  const datacite = createFakeFetch([
    { match: (u) => u.startsWith("https://api.datacite.org/dois/"), body: JSON.stringify({ data: { attributes: { doi: "10.48550/arxiv.2301.00001", titles: [{ title: "Arxiv Paper" }], creators: [{ name: "Doe, Jane" }], publicationYear: 2023, publisher: "arXiv" } } }) },
    { match: (u) => u.startsWith("https://data.crosscite.org/"), body: "@misc{doe2023, title={Arxiv Paper}, author={Doe, Jane}, year={2023}}" },
  ]);
  const fetchFn: typeof crossref.fetchFn = (url, init) => {
    requests.push(url);
    return url.includes("datacite.org") || url.includes("crosscite.org") ? datacite.fetchFn(url, init) : crossref.fetchFn(url, init);
  };
  return { fetchFn, requests };
}
