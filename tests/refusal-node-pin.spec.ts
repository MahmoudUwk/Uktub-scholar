import { test } from "node:test";
import assert from "node:assert/strict";

import { REFUSALS, renderRefusal, type RefusalCode } from "../src/core/refusals.ts";
import { createConfiguredEngine } from "../src/core/verify/engines.ts";

const CODES = Object.keys(REFUSALS).sort() as RefusalCode[];

/**
 * Phase 9a item 1a pin: Node's rendered refusals are byte-stable per code.
 * A literal copy of every `next` — any table edit (or envelope change) fails
 * here first. The ONLY intended post-pin change is the hosted missing-key
 * MESSAGE (engines.ts), pinned separately below.
 */
const PINNED_NEXT: Record<RefusalCode, string> = {
  REGISTRY_NOT_INITIALIZED: "run `uktub-scholar init` in the project root, then retry",
  REGISTRY_CORRUPT:
    "the registry file is not a valid SQLite database; restore it from backup or delete it and run `uktub-scholar init` (papers are lost)",
  REGISTRY_SCHEMA_UNSUPPORTED:
    "the registry was created by a different schema version; upgrade the package or restore a matching registry",
  REGISTRY_BUSY: "another process holds the registry write lock; retry after it finishes",
  INVALID_DOI:
    "check the identifier — DOIs look like 10.xxxx/suffix; write arXiv papers as arxiv:YYMM.NNNNN or their 10.48550/arxiv.YYMM.NNNNN form",
  DOI_NOT_FOUND: "verify the DOI resolves (doi.org), or re-run papers and register that result with registry",
  QUERY_REQUIRED: "provide a search query — papers requires non-empty query text",
  PATH_REFUSED:
    "use a file inside the project directory; .registry and .git are protected system segments, and traversal, symlink escapes and non-files are refused",
  SEARCH_UNAVAILABLE: "retry later; no scholarly provider answered — check network connectivity or provider status",
  BATCH_TOO_LARGE: "split the batch into calls within the limit named in the message",
  COMPILE_ENGINE_MISSING:
    "tell the user to run `uktub-scholar tectonic install --yes` (a pinned, verified download), or install tectonic (tectonic-typesetting.github.io) / set UKTUB_TECTONIC_BIN, then retry",
  COMPILE_NO_ENTRY: "create manuscript/main.tex or pass entry with the project-relative .tex file to compile",
  COMPILE_TIMEOUT: "simplify the document or raise the budget via UKTUB_COMPILE_TIMEOUT_S (seconds), then retry",
  VERIFY_ENGINE_MISSING:
    "tell the user the verification engine is not available and how to enable it: the default eos engine needs a Python environment with torch, transformers>=5.17 and safetensors (point UKTUB_EOS_PYTHON at its interpreter; README \"Engines\"). Without PyTorch: run `uktub-scholar eos install --yes` (a pinned ONNX export plus a small environment) and select verification.engine: eos-onnx in config/chunking.yaml. Other alternatives are OpenRouter (OPENROUTER_API_KEY) or a local System One server (UKTUB_VERIFY_URL). Do not improvise a verdict; passages still works",
  CONFIG_INVALID: "fix the reported key in config/chunking.yaml (or the file named by UKTUB_CHUNK_CONFIG), then retry",
  ARGUMENT_INVALID: "fix the named argument and retry; the message lists what the action accepts",
  CONTINUATION_INVALID: "the continuation token does not match this request or the registry changed; repeat the request without a token",
  SOURCE_UNUSABLE:
    "attach a text-based PDF or GROBID TEI of this exact paper (image-only scans need OCR first), or retry once an open-access copy exists",
};

test("node refusal pin: table nexts are byte-stable (18 codes)", () => {
  assert.deepEqual(CODES.length, 18);
  for (const code of CODES) {
    assert.equal(REFUSALS[code].next, PINNED_NEXT[code], `${code} next changed`);
  }
});

test("node refusal pin: rendered envelope carries the pinned next per code", () => {
  for (const code of CODES) {
    const rendered = renderRefusal({ code, message: "probe message" });
    assert.equal(rendered, `Refused: ${code} — probe message. Next: ${PINNED_NEXT[code]}.`, code);
  }
});

test("hosted missing-key message keeps the key URL and env name, drops the eos alternative", () => {
  let message: string | null = null;
  try {
    createConfiguredEngine({}, "hosted");
  } catch (err) {
    message = err instanceof Error ? err.message : String(err);
  }
  assert.ok(message !== null && message.length > 0, "hosted without a key throws");
  assert.match(message, /the hosted verifier needs a free key: get one at https:\/\/decision\.vllm-sr\.ai\/ and set UKTUB_VERIFY_API_KEY/);
  assert.doesNotMatch(message, /eos/, "no local-engine alternative in the message (the table next already lists it)");
});
