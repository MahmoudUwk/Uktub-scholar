/**
 * The two conditional evaluator checks missing per the w12/w13 independent
 * factual reviews (adapter-literature-workflow-v1): `length-within-request`
 * (the 900-1,200 word ask, exceeded by every iteration) and
 * `sourced-numerics` (table hardware and figures the agent never saw in any
 * tool result, e.g. QA-LoRA "A100 80GB" vs the paper's Tesla V100, BitFit
 * ">=95%"). Both are emitted only for scenarios declaring
 * `## Evidence table`, like the evidence-table pair. TDD: these fail first.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  checkLengthWithinRequest,
  checkSourcedNumerics,
  countManuscriptBodyWords,
  parseWordRange,
} from "../scripts/live/deliverable-checks.ts";
import { EVIDENCE_TABLE_CHECK_IDS, LENGTH_SOURCED_CHECK_IDS, PROTOCOL_CHECK_IDS } from "../scripts/live/evolution.ts";
import { validateRunSet, stagingSurfaceHashes } from "../scripts/live/provenance.ts";

// ── fixtures ────────────────────────────────────────────────────────────────

const PROMPT_1200 = "Write a useful 900–1,200 word research note in LaTeX, with a compiled PDF.";

const texDoc = (body: string): string =>
  `\\documentclass{article}\n\\title{Note}\n\\begin{document}\n${body}\n\\bibliography{refs}\n\\end{document}\n`;

const words = (n: number): string => Array(n).fill("word").join(" ");

// Evidence is the text the agent SAW: tool result texts plus user messages.
// A token that occurs only in an assistant message is absent here by design.
const seenEvidence = (toolTexts: string[], userTexts: string[] = []): string =>
  [...toolTexts, ...userTexts].join("\n");

const TABLE = (row: string): string =>
  `\\begin{tabular}{ll}\nMethod & Result \\\\\n${row} \\\\\n\\end{tabular}\n`;

// ── check 1: length-within-request ───────────────────────────────────────────

describe("parseWordRange", () => {
  it("reads an en-dash range like the frozen scenario prompt", () => {
    assert.deepEqual(parseWordRange(PROMPT_1200), { min: 900, max: 1200 });
  });
  it("tolerates hyphen, the word to, and thousands commas", () => {
    assert.deepEqual(parseWordRange("a 900-1200 word note"), { min: 900, max: 1200 });
    assert.deepEqual(parseWordRange("a 900 to 1200 words note"), { min: 900, max: 1200 });
    assert.deepEqual(parseWordRange("a 1,000 to 2,000 word note"), { min: 1000, max: 2000 });
  });
  it("returns null when the prompt states no range", () => {
    assert.equal(parseWordRange("Write a research note."), null);
  });
});

describe("checkLengthWithinRequest", () => {
  it("passes inside the range and counts table cells and captions as a reader sees them", () => {
    const body = `${words(890)}\n${TABLE("alpha beta gamma")}\n\\caption{delta epsilon}\n`;
    assert.equal(countManuscriptBodyWords(texDoc(body)), 890 + 5 + 2);
    const c = checkLengthWithinRequest(texDoc(words(900)), PROMPT_1200);
    assert.equal(c?.ok, true);
    assert.match(c?.detail ?? "", /900 words/);
  });
  it("passes exactly on both boundaries", () => {
    assert.equal(checkLengthWithinRequest(texDoc(words(900)), PROMPT_1200)?.ok, true);
    assert.equal(checkLengthWithinRequest(texDoc(words(1200)), PROMPT_1200)?.ok, true);
  });
  it("fails one word outside on either side", () => {
    const low = checkLengthWithinRequest(texDoc(words(899)), PROMPT_1200);
    assert.equal(low?.ok, false);
    assert.match(low?.detail ?? "", /899/);
    const high = checkLengthWithinRequest(texDoc(words(1201)), PROMPT_1200);
    assert.equal(high?.ok, false);
    assert.match(high?.detail ?? "", /1201/);
  });
  it("is not emitted when the prompt states no range", () => {
    assert.equal(checkLengthWithinRequest(texDoc(words(5000)), "Write a research note."), null);
  });
  it("fails closed when the manuscript is missing", () => {
    const c = checkLengthWithinRequest(null, PROMPT_1200);
    assert.equal(c?.ok, false);
    assert.match(c?.detail ?? "", /no manuscript/i);
  });
});

// ── check 2: sourced-numerics ────────────────────────────────────────────────

describe("checkSourcedNumerics", () => {
  it("passes a table token the agent saw in a tool result", () => {
    const tex = texDoc(TABLE("QLoRA & 65B tuned on a single 48GB GPU"));
    const ev = seenEvidence(["finetune a 65B parameter model on a single 48GB GPU while preserving performance"]);
    const c = checkSourcedNumerics(tex, ev, PROMPT_1200);
    assert.equal(c.ok, true);
    assert.match(c.detail, /all 2 numeric/);
  });
  it("fails tokens that occur only in assistant messages (the QA-LoRA A100 80GB case)", () => {
    const tex = texDoc(TABLE("QA-LoRA & LLaMA-7B on Alpaca (NVIDIA A100 80GB)"));
    const ev = seenEvidence(["All experiments are conducted on Tesla V100 GPUs", "LLaMA-7B on Alpaca"]);
    const c = checkSourcedNumerics(tex, ev, PROMPT_1200);
    assert.equal(c.ok, false);
    assert.match(c.detail, /A100/);
    assert.match(c.detail, /80GB/);
  });
  it("passes a token that occurs only in the scenario prompt", () => {
    const prompt = "Compare a 0.3M budget against full fine-tuning. Write a note.";
    const tex = texDoc(TABLE("AdaLoRA & 0.3M budget on RTE"));
    const c = checkSourcedNumerics(tex, seenEvidence(["unrelated tool output"]), prompt);
    assert.equal(c.ok, true);
  });
  it("matches a token followed by a new word, but never inside a longer figure", () => {
    const tex = texDoc(TABLE("M & runs on 80GB GPUs"));
    const longer = checkSourcedNumerics(tex, seenEvidence(["from >780GB of GPU memory to <48GB"]), PROMPT_1200);
    assert.equal(longer.ok, false);
    assert.match(longer.detail, /80GB/);
    const exact = checkSourcedNumerics(tex, seenEvidence(["runs on a single 80GB GPU."]), PROMPT_1200);
    assert.equal(exact.ok, true);
  });
  it("ignores a lone \\times with no quantity attached", () => {
    const tex = texDoc("Scales as $a\\times b$ \\citep{x2024}.");
    const c = checkSourcedNumerics(tex, seenEvidence(["unrelated tool output"]), PROMPT_1200);
    assert.equal(c.ok, true);
    assert.match(c.detail, /nothing to source/);
  });
  it("treats \\% and % as the same token", () => {
    const tex = texDoc(TABLE("DoRA & cuts VRAM by 24.4\\%"));
    const c = checkSourcedNumerics(tex, seenEvidence(["a reduction of 24.4% in fine-tuning"]), PROMPT_1200);
    assert.equal(c.ok, true);
  });
  it("treats 10{,}000, 10,000 and 10000 as the same token", () => {
    const tex = texDoc("LoRA cuts params by 10{,}000 times \\citep{hu2021lora}.");
    const c = checkSourcedNumerics(tex, seenEvidence(["reduce the number of trainable parameters by 10000 times"]), PROMPT_1200);
    assert.equal(c.ok, true);
  });
  it("matches hardware names case-insensitively", () => {
    const tex = texDoc(TABLE("LoRA & trained on a100 GPUs"));
    const c = checkSourcedNumerics(tex, seenEvidence(["trained on A100 GPUs"]), PROMPT_1200);
    assert.equal(c.ok, true);
  });
  it("does not flag years, arXiv ids, citekeys or label/ref arguments", () => {
    const tex = texDoc(
      `The 2024 release improved things \\citep{liu2024dora} (see arxiv:2402.09353).\n\\label{gpu:A100}\nTable~\\ref{tab:cmp} holds.\n`,
    );
    const c = checkSourcedNumerics(tex, seenEvidence(["unrelated tool output"]), PROMPT_1200);
    assert.equal(c.ok, true);
  });
  it("does not examine a prose sentence without a cite command", () => {
    const tex = texDoc("Our cluster has 80GB GPUs. The method works \\citep{ok2024}.");
    const c = checkSourcedNumerics(tex, seenEvidence(["unrelated tool output"]), PROMPT_1200);
    assert.equal(c.ok, true);
  });
  it("examines a cited prose sentence, including bare decimals", () => {
    const tex = texDoc("Double quantization saves about 0.37 bits per parameter \\citep{dettmers2023qlora}.");
    assert.equal(checkSourcedNumerics(tex, seenEvidence(["saving an average of about 0.37 bits per parameter"]), PROMPT_1200).ok, true);
    const missing = checkSourcedNumerics(tex, seenEvidence(["unrelated tool output"]), PROMPT_1200);
    assert.equal(missing.ok, false);
    assert.match(missing.detail, /0\.37/);
  });
  it("lists at most 8 failing tokens with their unit and the total count", () => {
    const row = ["11GB", "22GB", "33GB", "44GB", "55GB", "66GB", "77GB", "88GB", "99GB", "111GB"].join(" ");
    const c = checkSourcedNumerics(texDoc(TABLE(`M & ${row}`)), seenEvidence(["nothing numeric here"]), PROMPT_1200);
    assert.equal(c.ok, false);
    assert.match(c.detail, /10\D*token/);
    assert.match(c.detail, /table row/);
  });
  it("fails closed when the transcript is missing", () => {
    const c = checkSourcedNumerics(texDoc(TABLE("M & 48GB GPU")), null, PROMPT_1200);
    assert.equal(c.ok, false);
    assert.match(c.detail, /transcript|evidence.*unavailable/i);
  });
  it("fails closed when the manuscript is missing", () => {
    const c = checkSourcedNumerics(null, seenEvidence(["48GB GPU"]), PROMPT_1200);
    assert.equal(c.ok, false);
  });
});

// ── protocol: old check sets are historical ──────────────────────────────────

describe("protocol version for the two new conditional checks", () => {
  const root = mkdtempSync(join(tmpdir(), "uktub-proto-"));
  const scenarioText = "# Alpha\n\n## Prompt\n\nDo the thing.\n";
  const simText = "// simulator\n";
  const expText = "// experiment\n";
  const drvText = "// agent driver\n";
  const sha = (s: string): string => createHash("sha256").update(s, "utf8").digest("hex");
  const surf = (): { surfaceHash: string; protectedHash: string } => stagingSurfaceHashes(root);
  const manifest = (over: Record<string, unknown> = {}) => ({
    scenario: "alpha-scenario", iteration: 1,
    model: "google-vertex/gemini-3.8-flash (Vertex client, ADC; no fallback)",
    modelProfile: { agent: ["google-vertex/gemini-3.8-flash"], simulator: ["google-vertex/gemini-3.8-flash"] },
    commit: "c", workingTreeDiffSha256: "ab".repeat(32), packageHash: "p",
    surfaceHash: surf().surfaceHash, protectedHash: surf().protectedHash,
    image: "test-image", engineDevice: "test-engine",
    providerKeysPassed: [],
    scenarioSha256: sha(readFileSync(join(root, "experiments/scenarios/alpha-scenario.md"), "utf8")),
    simulatorSha256: sha(simText), experimentSha256: sha(expText), agentDriverSha256: sha(drvText),
    policy: { simulatedWindowTokens: null },
    ...over,
  });
  const ev = (ref: string, m: Record<string, unknown>, checks: Array<{ id: string; ok: boolean }>) => {
    const fullMetrics = { simulatedWindowTokens: null, scenario: "alpha-scenario", iteration: 1, checks };
    const rawText = JSON.stringify(fullMetrics, null, 2);
    return {
      ref, scenario: "alpha-scenario", iteration: 1,
      metrics: fullMetrics, metricsRaw: rawText,
      manifest: { metricsSha256: sha(rawText), ...m },
    };
  };
  const policy = { evolve: ["alpha-scenario"], heldout: [] as string[], ood: [] as string[], repo: root };
  const OLD_IDS = [...PROTOCOL_CHECK_IDS, ...EVIDENCE_TABLE_CHECK_IDS];
  const NEW_IDS = [...OLD_IDS, ...LENGTH_SOURCED_CHECK_IDS];

  try {
    mkdirSync(join(root, "experiments/scenarios"), { recursive: true });
    mkdirSync(join(root, "scripts/live"), { recursive: true });
    writeFileSync(join(root, "experiments/scenarios/alpha-scenario.md"), scenarioText);
    writeFileSync(join(root, "experiments/simulator.md"), simText);
    writeFileSync(join(root, "scripts/live/experiment.ts"), expText);
    writeFileSync(join(root, "scripts/live/agent.ts"), drvText);
  } catch { /* setup once */ }

  it("refuses an 11-check run for an evidence-table scenario once the pair joins the protocol", () => {
    const path = join(root, "experiments/scenarios/alpha-scenario.md");
    const original = readFileSync(path, "utf8");
    try {
      writeFileSync(path, "# Alpha\n\n## Prompt\n\nDo the thing.\n\n## Evidence table\n\npath evidence/claims.json\n");
      const oldRun = ev("alpha-scenario/iter-01", manifest(), OLD_IDS.map((id) => ({ id, ok: true, detail: "" })));
      assert.match(validateRunSet([oldRun], policy, "evaluate").join(" "), /scenario protocol requires exactly/);
      const newRun = ev("alpha-scenario/iter-01", manifest(), NEW_IDS.map((id) => ({ id, ok: true, detail: "" })));
      assert.deepEqual(validateRunSet([newRun], { evolve: ["alpha-scenario"], heldout: [], ood: [], repo: root }, "baseline"), []);
    } finally {
      writeFileSync(path, original);
    }
  });
});
