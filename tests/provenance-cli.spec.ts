/** `uktub-scholar provenance`: the document's provenance view as a CLI command, for people. */
import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { runCli } from "../src/cli/main.ts";
import type { ChunkTextConfig } from "../src/core/chunk.ts";
import { createRegistry, openRegistry, registerPaper } from "../src/core/registry.ts";
import { createRun, markDelivered, publishSource, saveEvidence } from "../src/core/verify/store.ts";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";

const NOW = new Date("2026-10-04T00:00:00Z");
const CFG: ChunkTextConfig = { chunk_tokens: 300, overlap_tokens: 0, chars_per_token: 1, boundary: "paragraph" };
let root: string;

async function provenance(args: string[]): Promise<{ code: number; out: string[]; err: string[] }> {
  const out: string[] = [];
  const err: string[] = [];
  const code = await runCli(["provenance", ...args], { cwd: root, out: (l) => out.push(l), err: (l) => err.push(l), now: () => NOW, env: {} });
  return { code, out, err };
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "prov-cli-"));
  const db = createRegistry(root);
  registerPaper(db, { doi: "10.1000/dora", title: "DoRA", authors: [] }, { now: () => NOW });
  publishSource(db, "10.1000/dora", { kind: "local-file", ref: "x.pdf", license: null, digest: "a".repeat(64), extraction: "t@1", text: "DoRA reduces memory by 24.4%.", pageStarts: null }, CFG, NOW);
  const key = (db.prepare("SELECT citekey FROM papers").get() as { citekey: string }).citekey;
  db.close();
  mkdirSync(join(root, "manuscript"), { recursive: true });
  writeFileSync(join(root, "manuscript/main.tex"), String.raw`\begin{document}DoRA cuts memory by 24.4\% on an A100~\cite{${key}}.\end{document}`);
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

describe("provenance command", () => {
  it("prints the full view and exits 0 even when figures are open (it describes, it does not gate)", async () => {
    const r = await provenance([]);
    assert.equal(r.code, 0, r.err.join("\n"));
    const text = r.out.join("\n");
    assert.match(text, /# Provenance view/);
    assert.match(text, /A100/);
  });
  it("--json prints the audit as JSON", async () => {
    const r = await provenance(["--json"]);
    assert.equal(r.code, 0);
    const j = JSON.parse(r.out.join("\n")) as { summary: { figures: { open: number } } };
    assert.equal(j.summary.figures.open, 1);
  });
  it("exits 1 with a reason when there is nothing to audit", async () => {
    const r = await provenance(["manuscript/nope.tex"]);
    assert.equal(r.code, 1);
    assert.match(r.err.join("\n"), /error:/);
  });
  it("--json keeps entry, summary and items and adds only document_digest and units", async () => {
    const r = await provenance(["--json"]);
    assert.equal(r.code, 0);
    const j = JSON.parse(r.out.join("\n")) as Record<string, unknown>;
    assert.deepEqual(Object.keys(j).sort(), ["document_digest", "entry", "items", "summary", "units"]);
    assert.equal(j.entry, "manuscript/main.tex");
    const expanded = readFileSync(join(root, "manuscript/main.tex"), "utf8");
    assert.equal(j.document_digest, createHash("sha256").update(expanded, "utf8").digest("hex"));
    const units = j.units as { id: string; kind: string; file: string; line: number; section: string; text: string; cites: string[]; status: string; pointers: string[] }[];
    assert.equal(units.length, 1);
    assert.deepEqual(units[0], {
      id: "u1",
      kind: "sentence",
      file: "manuscript/main.tex",
      line: 1,
      section: "",
      text: "DoRA cuts memory by 24.4% on an A100.",
      cites: units[0]!.cites,
      status: "cited",
      pointers: [],
    });
    assert.equal(units[0]!.cites.length, 1, "the sentence cites the registered paper");
  });
  it("--json units lists every extracted unit, unaudited ones as uncited, while the summary still counts audited units only", async () => {
    const file = join(root, "manuscript/main.tex");
    writeFileSync(file, readFileSync(file, "utf8").replace(String.raw`\end{document}`, String.raw` Fine-tuning strictly requires a GPU.\end{document}`));
    const j = JSON.parse((await provenance(["--json"])).out.join("\n")) as { summary: { audited: number }; units: { text: string; status: string; cites: string[]; pointers: string[] }[] };
    assert.equal(j.units.length, 2, "the uncited sentence without a figure is a unit graders must label");
    const plain = j.units.find((u) => /strictly requires/.test(u.text));
    assert.deepEqual({ status: plain?.status, cites: plain?.cites, pointers: plain?.pointers }, { status: "uncited", cites: [], pointers: [] });
    assert.equal(j.summary.audited, 1, "the summary is unchanged: it counts statements that cite a paper or state a figure");
  });
  it("the digest is stable across runs and changes on a one-byte edit", async () => {
    const first = JSON.parse((await provenance(["--json"])).out.join("\n")) as { document_digest: string };
    const second = JSON.parse((await provenance(["--json"])).out.join("\n")) as { document_digest: string };
    assert.equal(first.document_digest, second.document_digest);
    const file = join(root, "manuscript/main.tex");
    writeFileSync(file, readFileSync(file, "utf8").replace("cuts", "cutss"));
    const third = JSON.parse((await provenance(["--json"])).out.join("\n")) as { document_digest: string; units: { text: string }[] };
    assert.notEqual(third.document_digest, first.document_digest, "one inserted byte changes the digest");
    assert.match(third.document_digest, /^[0-9a-f]{64}$/);
    assert.match(third.units[0]!.text, /cutss/);
  });
  it("a released wording surfaces as a verified unit with its pointers", async () => {
    const claim = "DoRA cuts memory by 24.4% on an A100.";
    const db = openRegistry(root);
    try {
      const doi = (db.prepare("SELECT doi FROM papers").get() as { doi: string }).doi;
      const revision = (db.prepare("SELECT revision FROM paper_sources WHERE doi = ?").get(doi) as { revision: string }).revision;
      createRun(db, "r1", claim, { mode: "query", query: null, requested: "all", papers: [], scopeKey: "all", selected: 1, candidateIds: null, selection: [] } as never, { unavailable: [], unresolved: [], staleDropped: 0 }, NOW);
      saveEvidence(db, "r1", [{ doi, revision, start: 0, end: 27, page: null, chunkId: "c", model: "m", protocol: "p", minConfidence: 0.99, pTrue: 0.999 }], NOW);
      markDelivered(db, "r1", [{ doi, revision, start: 0, end: 27, released: 27 }], { claim, now: NOW });
    } finally {
      db.close();
    }
    const r = await provenance(["--json"]);
    assert.equal(r.code, 0);
    const j = JSON.parse(r.out.join("\n")) as { summary: { verified: number }; units: { status: string; pointers: string[] }[] };
    assert.equal(j.summary.verified, 1);
    assert.equal(j.units[0]!.status, "verified");
    assert.equal(j.units[0]!.pointers.length, 1);
  });
});
