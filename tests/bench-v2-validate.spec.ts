/**
 * The release check of claim-verification-v2: every rule can fail on a synthetic dataset, and the committed dataset passes. Offline.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { validateDataset, type Files } from "../scripts/bench-v2-validate.ts";

const BY = "http://creativecommons.org/licenses/by/4.0/";
const H = (c: string) => c.repeat(64);
const row = (n: number, type: string, over: Record<string, unknown> = {}) => {
  const positive = type === "reworded" || type === "numeric";
  const q = "a verbatim quote of six words here";
  return {
    id: `v2-2609.00001v1-${String(n).padStart(2, "0")}`, paper: "2609.00001v1", arxiv_id: "2609.00001", arxiv_version: 1, license: BY, pdf_sha256: H("a"), claim: `Claim number ${n} says something specific about the paper.`,
    label: positive ? "TRUE" : "FALSE", type, kind: type === "general" ? "general" : "finding",
    evidence_quote: positive || type === "contradiction" ? q : null, altered_from_quote: type === "perturbed" ? q : null,
    author_model: "claude-haiku-5-5", annotator_model: "claude-haiku-5-5", authoring_protocol_sha256: H("c"), annotation_protocol_sha256: H("d"), verification: "passed",
    ...over,
  };
};
const good = (): Files => {
  const claims = ["reworded", "numeric", "perturbed", "fabricated", "contradiction", "general"].map((t, i) => row(i + 1, t));
  return {
    claims,
    corpus: { papers: [{ id: "2609.00001v1", category: "cs.CL", fold: 0, title: "T", authors: ["A. Author"], license: BY, sha256: H("a") }] },
    manifest: { size: 6, labels: { TRUE: 2, FALSE: 4 }, types: { reworded: 1, numeric: 1, perturbed: 1, fabricated: 1, contradiction: 1, general: 1 }, papers: 1, licenses: { [BY]: 6 } },
    protocolHashes: { authoring: H("c"), annotation: H("d") },
  };
};
const with_ = (mutate: (f: Files) => void): string[] => { const f = good(); mutate(f); return validateDataset(f); };
const has = (problems: string[], re: RegExp) => assert.ok(problems.some((p) => re.test(p)), JSON.stringify(problems));

describe("the release check", () => {
  it("passes a consistent dataset", () => assert.deepEqual(validateDataset(good()), []));
  it("rejects a row with a missing field or a wrong label for its type", () => {
    has(with_((f) => delete f.claims[0]!.license), /license/);
    has(with_((f) => (f.claims[0]!.label = "FALSE")), /label/);
    has(with_((f) => (f.claims[2]!.label = "TRUE")), /label/);
  });
  it("rejects an id that does not follow the paper, and a repeated id or claim", () => {
    has(with_((f) => (f.claims[0]!.id = "v2-2609.99999v1-01")), /id/);
    has(with_((f) => (f.claims[1]!.id = f.claims[0]!.id)), /duplicate id/);
    has(with_((f) => (f.claims[1]!.claim = f.claims[0]!.claim)), /duplicate claim/);
  });
  it("rejects a row whose paper, licence or PDF hash is not the corpus's, and a licence an open dataset cannot carry", () => {
    has(with_((f) => (f.claims[0]!.paper = "2609.77777v1")), /not in the corpus/);
    has(with_((f) => (f.claims[0]!.pdf_sha256 = H("b"))), /sha256/);
    has(with_((f) => { f.claims[0]!.license = "http://creativecommons.org/licenses/by-nc/4.0/"; f.corpus.papers[0]!.license = "http://creativecommons.org/licenses/by-nc/4.0/"; }), /licen[cs]e/);
  });
  it("rejects quotes that do not belong to the type, and a quote outside 6 to 80 words", () => {
    has(with_((f) => (f.claims[3]!.evidence_quote = "a fabricated claim has no quote at all here")), /quote/);
    has(with_((f) => (f.claims[0]!.evidence_quote = null)), /quote/);
    has(with_((f) => (f.claims[2]!.altered_from_quote = null)), /quote/);
    has(with_((f) => (f.claims[0]!.evidence_quote = "too short")), /words/);
  });
  it("rejects a kind outside the protocol's list, and a general claim whose kind is not `general`", () => {
    has(with_((f) => (f.claims[0]!.kind = "banana")), /kind/);
    has(with_((f) => (f.claims[5]!.kind = "finding")), /kind/);
  });
  it("rejects a manifest whose counts are not those of the rows", () => {
    has(with_((f) => (f.manifest.size = 7)), /size/);
    has(with_((f) => (f.manifest.labels = { TRUE: 3, FALSE: 3 })), /labels/);
    has(with_((f) => (f.manifest.types.numeric = 2)), /types/);
    has(with_((f) => (f.manifest.papers = 2)), /papers/);
  });
  it("rejects rows that name a protocol file that has changed since, a missing model, and a corpus paper without authors or with a bad hash", () => {
    has(with_((f) => (f.protocolHashes.authoring = H("e"))), /protocol/);
    has(with_((f) => (f.claims[0]!.author_model = "")), /model/);
    has(with_((f) => (f.corpus.papers[0]!.authors = [])), /authors/);
    has(with_((f) => (f.corpus.papers[0]!.sha256 = "xyz")), /sha256/);
  });
});

describe("the committed dataset", () => {
  const dir = resolve(import.meta.dirname, "../benchmarks/datasets/claim-verification-v2");
  const read = (f: string) => readFileSync(resolve(dir, f), "utf8");
  const sha = (f: string) => createHash("sha256").update(readFileSync(resolve(dir, f))).digest("hex");
  it("is consistent: rows, corpus, manifest and protocol files agree", () => {
    const problems = validateDataset({ claims: JSON.parse(read("claims.json")).claims, corpus: JSON.parse(read("corpus.json")), manifest: JSON.parse(read("manifest.json")), protocolHashes: { authoring: sha("AUTHORING.md"), annotation: sha("ANNOTATION.md") } });
    assert.deepEqual(problems, []);
  });
});
