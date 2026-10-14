/**
 * Assembly of claim-verification-v2: only claims that pass the programmatic checks AND that the blind annotator labels as the author's type implies
 * are kept; everything dropped is counted with its reason. Offline.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { assemblePaper, blindInput, staleAnnotations, toRow, type Annotation, type DatasetClaim, type SourceInfo } from "../scripts/bench-v2-assemble.ts";
import type { Authored, ClaimType, Problem } from "../scripts/bench-v2-check.ts";

const mk = (type: ClaimType, claim: string, over: Partial<Authored> = {}): Authored => ({ type, kind: "method", claim, evidence: null, source_quote: null, changed: null, new_value: null, ...over });
const authored: Authored[] = [
  mk("reworded", "The encoder is trained for ninety epochs on the Alpha-Set corpus.", { evidence: "We train the encoder for 90 epochs on the Alpha-Set corpus" }),
  mk("numeric", "Training takes twelve hours on four graphics cards in total.", { kind: "numeric", evidence: "Training takes 12 hours on four GPUs." }),
  mk("perturbed", "Training takes thirty one hours on four graphics cards in total.", { kind: "numeric", source_quote: "Training takes 12 hours on four GPUs.", changed: "12 to 31", new_value: "31" }),
  mk("fabricated", "A cosine schedule with warmup was used during the pretraining of the encoder."),
  mk("contradiction", "Multilingual transfer was evaluated in depth across many languages.", { evidence: "We leave multilingual transfer to future work." }),
  mk("general", "Transformer encoders are widely used for representation learning across modalities."),
];
const map = Object.fromEntries(authored.map((_, i) => [`k${i + 1}`, i]));
const said = (labels: Array<"SUPPORTED" | "NOT_SUPPORTED">): Annotation[] => labels.map((label, i) => ({ id: `k${i + 1}`, label, quote: label === "SUPPORTED" ? "a quote" : null }));
const AGREES: Array<"SUPPORTED" | "NOT_SUPPORTED"> = ["SUPPORTED", "SUPPORTED", "NOT_SUPPORTED", "NOT_SUPPORTED", "NOT_SUPPORTED", "NOT_SUPPORTED"];

describe("what the annotator is shown", () => {
  const claims = authored.map((x, index) => ({ index, claim: x.claim }));
  it("is an id and the sentence, nothing else, in an order that is not the author's, the same for the same seed", () => {
    const a = blindInput(claims, 5);
    assert.equal(a.input.length, 6);
    assert.ok(a.input.every((x) => Object.keys(x).sort().join() === "claim,id"));
    assert.notDeepEqual(a.input.map((x) => x.claim), claims.map((x) => x.claim));
    assert.deepEqual(a, blindInput(claims, 5));
    assert.notDeepEqual(a.input.map((x) => x.claim), blindInput(claims, 6).input.map((x) => x.claim));
  });
  it("keeps a map back to the author's index, and the ids carry no information about the type or the position", () => {
    const { input, map: m } = blindInput(claims, 5);
    for (const x of input) assert.equal(authored[m[x.id] as number]?.claim, x.claim);
    assert.ok(input.every((x) => /^k\d\d$/.test(x.id)));
  });
});

describe("assembling a paper", () => {
  const noProblems: Problem[] = [];
  it("keeps every claim the annotator labels as its type implies, with TRUE for reworded and numeric and FALSE for the rest", () => {
    const r = assemblePaper("2609.00001v1", authored, noProblems, said(AGREES), map);
    assert.equal(r.claims.length, 6);
    assert.deepEqual(r.claims.map((c) => c.label), ["TRUE", "TRUE", "FALSE", "FALSE", "FALSE", "FALSE"]);
    assert.deepEqual(r.claims.map((c) => c.type), ["reworded", "numeric", "perturbed", "fabricated", "contradiction", "general"]);
    assert.equal(r.dropped.length, 0);
    assert.deepEqual(r.claims.map((c) => c.id), ["v2-2609.00001v1-01", "v2-2609.00001v1-02", "v2-2609.00001v1-03", "v2-2609.00001v1-04", "v2-2609.00001v1-05", "v2-2609.00001v1-06"]);
  });
  it("gives a general claim the kind `general` whatever the author wrote (null, or a kind of fact it is not about)", () => {
    const withNull = authored.map((x) => (x.type === "general" ? { ...x, kind: null as unknown as string } : x));
    const r = assemblePaper("p", withNull, noProblems, said(AGREES), map);
    assert.equal(r.claims.find((c) => c.type === "general")?.kind, "general");
    assert.equal(assemblePaper("p", authored, noProblems, said(AGREES), map).claims.find((c) => c.type === "general")?.kind, "general");
  });
  it("carries the quote a reader needs: the supporting quote, the original fact of a perturbed claim, the contradicted quote, and none for the rest", () => {
    const r = assemblePaper("p", authored, noProblems, said(AGREES), map);
    assert.deepEqual(r.claims.map((c) => c.evidence !== null), [true, true, true, false, true, false]);
    assert.equal(r.claims[2]?.evidence, "Training takes 12 hours on four GPUs.");
  });
  it("drops a claim the annotator disagrees with, in either direction, and says why", () => {
    const labels = [...AGREES];
    labels[0] = "NOT_SUPPORTED"; // a TRUE claim the annotator cannot find
    labels[3] = "SUPPORTED"; // a fabricated claim the annotator finds support for
    const r = assemblePaper("p", authored, noProblems, said(labels), map);
    assert.equal(r.claims.length, 4);
    assert.deepEqual(r.dropped.map((d) => [d.index, d.reason]), [[0, "annotator"], [3, "annotator"]]);
  });
  it("drops a claim that failed the checks before the annotator is asked, and never counts it as agreement", () => {
    const r = assemblePaper("p", authored, [{ index: 2, code: "new_value", message: "x" }], said(AGREES), map);
    assert.deepEqual(r.dropped.map((d) => [d.index, d.reason, d.detail]), [[2, "check", "new_value: x"]]);
    assert.equal(r.claims.length, 5);
    assert.equal(r.agreement.perturbed?.labelled ?? 0, 0);
  });
  it("drops a claim nobody annotated, and keeps the problems of the whole set apart from the claims", () => {
    const r = assemblePaper("p", authored, [{ index: null, code: "count", message: "11 claims" }], said(AGREES).slice(0, 5), map);
    assert.deepEqual(r.dropped.map((d) => [d.index, d.reason]), [[5, "unannotated"]]);
    assert.deepEqual(r.setProblems.map((p) => p.code), ["count"]);
    assert.equal(r.claims.length, 5);
  });
  it("counts the agreement per type over the claims the annotator labelled", () => {
    const labels = [...AGREES];
    labels[2] = "SUPPORTED";
    const r = assemblePaper("p", authored, noProblems, said(labels), map);
    assert.deepEqual(r.agreement.perturbed, { agreed: 0, labelled: 1 });
    assert.deepEqual(r.agreement.reworded, { agreed: 1, labelled: 1 });
  });
  it("treats a missing annotation file as every claim unannotated", () => {
    const r = assemblePaper("p", authored, noProblems, null, map);
    assert.equal(r.claims.length, 0);
    assert.equal(r.dropped.length, 6);
  });
});

describe("a row of the released dataset", () => {
  const source: SourceInfo = {
    license: "http://creativecommons.org/licenses/by/4.0/", pdfSha256: "ab".repeat(32), authorModel: "claude-haiku-5-5", annotatorModel: "claude-haiku-5-5",
    authoringProtocolSha256: "cd".repeat(32), annotationProtocolSha256: "ef".repeat(32),
  };
  const claim = (over: Partial<DatasetClaim> = {}): DatasetClaim => ({ id: "v2-2609.18631v1-03", paper: "2609.18631v1", claim: "A claim.", label: "TRUE", type: "reworded", kind: "method", evidence: "a quote of the paper", ...over });
  it("names its source paper by arXiv id and version, with the licence and the hash of the PDF it was written from", () => {
    const r = toRow(claim(), source);
    assert.deepEqual([r.arxiv_id, r.arxiv_version, r.license, r.pdf_sha256], ["2609.18631", 1, source.license, source.pdfSha256]);
  });
  it("records who wrote and who annotated it, the protocol each followed, and that it passed the checks and the blind annotator", () => {
    const r = toRow(claim(), source);
    assert.deepEqual([r.author_model, r.annotator_model, r.authoring_protocol_sha256, r.annotation_protocol_sha256], ["claude-haiku-5-5", "claude-haiku-5-5", source.authoringProtocolSha256, source.annotationProtocolSha256]);
    assert.match(r.verification, /programmatic checks.*blind annotator/);
  });
  it("keeps the supporting quote, the original fact of a perturbed claim and the contradicted quote in separate fields, and no quote for the rest", () => {
    assert.deepEqual([toRow(claim(), source).evidence_quote, toRow(claim(), source).altered_from_quote], ["a quote of the paper", null]);
    assert.deepEqual([toRow(claim({ type: "perturbed", label: "FALSE" }), source).evidence_quote, toRow(claim({ type: "perturbed", label: "FALSE" }), source).altered_from_quote], [null, "a quote of the paper"]);
    assert.deepEqual([toRow(claim({ type: "contradiction", label: "FALSE" }), source).evidence_quote, toRow(claim({ type: "contradiction", label: "FALSE" }), source).altered_from_quote], ["a quote of the paper", null]);
    for (const type of ["fabricated", "general"] as const) assert.deepEqual([toRow(claim({ type, label: "FALSE", evidence: null }), source).evidence_quote, toRow(claim({ type, label: "FALSE", evidence: null }), source).altered_from_quote], [null, null]);
  });
  it("is refused when its paper's licence is not one an open dataset can carry, or when a provenance field is missing", () => {
    assert.throws(() => toRow(claim(), { ...source, license: "http://arxiv.org/licenses/nonexclusive-distrib/1.0/" }), /licen[cs]e/);
    assert.throws(() => toRow(claim(), { ...source, license: "http://creativecommons.org/licenses/by-nc-nd/4.0/" }), /licen[cs]e/);
    assert.throws(() => toRow(claim(), { ...source, authorModel: "" }), /author/);
    assert.throws(() => toRow(claim(), { ...source, annotatorModel: "" }), /annotator/);
    assert.throws(() => toRow(claim(), { ...source, pdfSha256: "" }), /sha256/);
  });
});

describe("an annotation that no longer matches the authored claim", () => {
  const { input, map: m } = blindInput(authored.map((x, index) => ({ index, claim: x.claim })), 5);
  it("is none when every annotated sentence is the claim the author file holds now", () => {
    assert.deepEqual(staleAnnotations(authored, input, m), []);
  });
  it("names the annotated ids whose claim the author has since changed, or whose index no longer exists", () => {
    const changed = authored.map((x, i) => (i === 2 ? { ...x, claim: "A different sentence now." } : x));
    const staleId = input.find((x) => m[x.id] === 2)?.id as string;
    assert.deepEqual(staleAnnotations(changed, input, m), [staleId]);
    assert.deepEqual(staleAnnotations(authored.slice(0, 3), input, m).length, 3, "claims 3 to 5 are gone");
  });
  it("is ignored by assembly only when the caller drops those labels: a dropped label makes the claim unannotated, never agreed", () => {
    const labels = said(AGREES).filter((a) => a.id !== "k3");
    const r = assemblePaper("p", authored, [], labels, map);
    assert.deepEqual(r.dropped.map((d) => [d.index, d.reason]), [[2, "unannotated"]]);
  });
});

