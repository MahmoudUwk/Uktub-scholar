/**
 * Checks on authored claims for claim-verification-v2: a quote must be in the paper, a TRUE claim must not be a copy, a perturbed or fabricated
 * number must be absent from the paper, and the set must have the stated shape. Offline.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { checkAuthored, copiedRun, COUNTS, normalizeText, numbersIn, quoteInText, type Authored, type ClaimType } from "../scripts/bench-v2-check.ts";

const PAPER = [
  "We train the encoder for 90 epochs on the Alpha-Set corpus with a batch size of 1,024.",
  "The model reaches 78.4 percent top-1 accuracy, which is a gain over the base-\nline of 76.1 percent.",
  "Training takes 12 hours on four GPUs.\n\nWe leave multilingual transfer to future work.",
].join(" ");

const base = (type: ClaimType, over: Partial<Authored> = {}): Authored => ({ type, kind: "method", claim: "The encoder was trained for ninety epochs on the Alpha-Set corpus.", evidence: null, source_quote: null, changed: null, new_value: null, ...over });
const reworded = (over: Partial<Authored> = {}) => base("reworded", { claim: "The encoder was trained for ninety epochs on the Alpha-Set corpus.", evidence: "We train the encoder for 90 epochs on the Alpha-Set corpus with a batch size of 1,024.", ...over });
const full = (): Authored[] => [
  reworded(), reworded({ claim: "Optimisation used batches of 1,024 examples drawn from the Alpha-Set corpus.", evidence: "We train the encoder for 90 epochs on the Alpha-Set corpus with a batch size of 1,024." }),
  reworded({ claim: "Multilingual transfer is left for later investigation of the trained encoder.", evidence: "We leave multilingual transfer to future work." }),
  reworded({ claim: "Running the full training on four graphics cards occupies half a day of compute.", evidence: "Training takes 12 hours on four GPUs." }),
  base("numeric", { kind: "numeric", claim: "The model achieves a top-1 accuracy of 78.4 percent on its evaluation.", evidence: "The model reaches 78.4 percent top-1 accuracy, which is a gain over the baseline of 76.1 percent." }),
  base("numeric", { kind: "numeric", claim: "Training the encoder requires 12 hours of wall-clock time on four GPUs.", evidence: "Training takes 12 hours on four GPUs." }),
  base("perturbed", { kind: "numeric", claim: "The encoder was trained for 140 epochs on the Alpha-Set corpus with large batches.", source_quote: "We train the encoder for 90 epochs on the Alpha-Set corpus", changed: "90 epochs to 140", new_value: "140" }),
  base("perturbed", { kind: "numeric", claim: "Training the encoder takes 31 hours on four GPUs according to the schedule used.", source_quote: "Training takes 12 hours on four GPUs.", changed: "12 hours to 31", new_value: "31" }),
  base("fabricated", { claim: "Pretraining used a cosine learning-rate schedule with a peak value of 0.0007 and warmup." }),
  base("fabricated", { claim: "Ablations removing the projection head lowered downstream accuracy on every benchmark tested." }),
  base("contradiction", { claim: "The encoder was evaluated on multilingual transfer tasks across many languages.", evidence: "We leave multilingual transfer to future work." }),
  base("general", { claim: "Transformer encoders are widely used for representation learning across modalities." }),
];
const codes = (items: Authored[]) => checkAuthored(items, PAPER).map((p) => `${p.index ?? "set"}:${p.code}`);

describe("text helpers", () => {
  it("normalizes whitespace and joins a word broken over two lines by a hyphen", () => {
    assert.equal(normalizeText("a  b\n c"), "a b c");
    assert.equal(normalizeText("the base-\nline of"), "the baseline of");
  });
  it("finds a quote whatever the line breaks and hyphenation, and not a quote that is not there", () => {
    assert.equal(quoteInText(PAPER, "a gain over the baseline of 76.1 percent"), true);
    assert.equal(quoteInText(PAPER, "We leave multilingual   transfer to future work."), true);
    assert.equal(quoteInText(PAPER, "We leave transfer to future work"), false);
    assert.equal(quoteInText(PAPER, ""), false);
  });
  it("reports a run of consecutive words copied from the text, ignoring case and punctuation, and nothing shorter", () => {
    assert.ok(copiedRun("So we train the encoder for 90 epochs on the Alpha-Set corpus today", PAPER, 8));
    assert.equal(copiedRun("The encoder was trained for ninety epochs on the Alpha-Set corpus", PAPER, 8), null);
  });
  it("reads numbers without commas, signs and units", () => {
    assert.deepEqual(numbersIn("a batch of 1,024 and 78.4% at 12 hours"), ["1024", "78.4", "12"]);
  });
});

describe("the authored set", () => {
  it("accepts a well-formed set of 12 with the stated count per type", () => {
    assert.deepEqual(codes(full()), []);
    assert.equal(Object.values(COUNTS).reduce((a, b) => a + b, 0), 12);
  });
  it("rejects a set with the wrong number of claims of a type, and a duplicate claim", () => {
    assert.ok(codes(full().slice(1)).includes("set:count"));
    const dup = full();
    dup[1] = { ...dup[0] as Authored };
    assert.ok(codes(dup).includes("1:duplicate"));
  });
});

describe("every claim", () => {
  const withClaim = (i: number, over: Partial<Authored>): Authored[] => full().map((x, k) => (k === i ? { ...x, ...over } : x));
  it("is one sentence of 8 to 60 words that does not point at 'the paper'", () => {
    assert.ok(codes(withClaim(0, { claim: "Too short here." })).includes("0:shape"));
    assert.ok(codes(withClaim(0, { claim: "The paper trains the encoder for ninety epochs on the Alpha-Set corpus." })).includes("0:standalone"));
    assert.ok(codes(withClaim(0, { claim: "The encoder was trained for ninety epochs on the Alpha-Set corpus.\nIt was good." })).includes("0:shape"));
  });
  it("needs a quote that is in the paper wherever a type needs one", () => {
    assert.ok(codes(withClaim(0, { evidence: "We train the decoder for 90 epochs on the Alpha-Set corpus with a batch size of 1,024." })).includes("0:quote"));
    assert.ok(codes(withClaim(0, { evidence: null })).includes("0:quote"));
    assert.ok(codes(withClaim(6, { source_quote: "We train the encoder for 12 epochs" })).includes("6:source"));
    assert.ok(codes(withClaim(10, { evidence: null })).includes("10:quote"));
  });
  it("is not a sentence copied from the paper when it is a TRUE claim", () => {
    assert.ok(codes(withClaim(0, { claim: "We train the encoder for 90 epochs on the Alpha-Set corpus with a batch size of 1,024 today." })).includes("0:copied"));
  });
  it("is a numeric claim only with a number that its own quote contains", () => {
    assert.ok(codes(withClaim(4, { claim: "The model achieves a top-1 accuracy of 91.2 percent on its evaluation." })).includes("4:number"));
    assert.ok(codes(withClaim(4, { claim: "The model achieves strong top-1 accuracy on its evaluation set overall." })).includes("4:number"));
  });
  it("may carry a context number that is in the paper but not in its quote, as long as one of its numbers is in the quote", () => {
    assert.deepEqual(codes(withClaim(5, { claim: "Training the 90-epoch encoder takes 12 hours of wall-clock time on four GPUs overall." })), []);
  });
  it("needs at least one of its numbers in its own quote", () => {
    assert.ok(codes(withClaim(5, { claim: "Training the encoder for 90 epochs takes a long time on four GPUs overall." })).includes("5:number"));
  });
  it("does not read a version or a name as a value: the 2.2 of 'Wan2.2' is not a number the claim states", () => {
    assert.deepEqual(codes(withClaim(4, { claim: "The Wan2.2 variant reaches 78.4 percent top-1 accuracy on its evaluation overall." })), []);
  });
  it("is a perturbed claim only if it carries the new value and a numeric new value is nowhere in the paper", () => {
    assert.ok(codes(withClaim(6, { new_value: "90" })).includes("6:new_value"), "90 is in the paper");
    assert.ok(codes(withClaim(6, { new_value: "150" })).includes("6:new_value"), "the claim does not say 150");
    assert.ok(codes(withClaim(6, { changed: null })).includes("6:fields"));
  });
  it("may describe a change that is not a number (a swapped direction or ordering) without the claim containing those words", () => {
    assert.deepEqual(codes(withClaim(6, { changed: "the lower accuracy became the higher one", new_value: "the first model is better" })), []);
  });
  it("is a fabricated claim only if no number in it (two digits or a decimal) is in the paper, and has no quote", () => {
    assert.ok(codes(withClaim(8, { claim: "Pretraining used a learning rate of 78.4 with warmup over the first epochs of training." })).includes("8:number_in_paper"));
    assert.ok(codes(withClaim(8, { evidence: "We train the encoder for 90 epochs" })).includes("8:fields"));
  });
  it("does not count a digit inside a name as a number the paper has (a fabricated 'Alpha-90 ablation')", () => {
    assert.deepEqual(codes(withClaim(9, { claim: "An Alpha-90 style ablation removed the projection head and lowered accuracy across every benchmark tested." })), []);
  });
  it("has a kind from the protocol's list (method, dataset, finding, limitation, numeric), except a general claim, whose kind is set at assembly", () => {
    assert.ok(codes(withClaim(0, { kind: "banana" })).includes("0:kind"));
    assert.ok(codes(withClaim(8, { kind: "" })).includes("8:kind"));
    for (const kind of ["method", "dataset", "finding", "limitation", "numeric"]) assert.ok(!codes(withClaim(0, { kind })).includes("0:kind"), kind);
    assert.ok(!codes(withClaim(11, { kind: "whatever" })).includes("11:kind"));
  });
  it("is a general claim without any quote", () => {
    assert.ok(codes(withClaim(11, { evidence: "We train the encoder for 90 epochs" })).includes("11:fields"));
  });
});
