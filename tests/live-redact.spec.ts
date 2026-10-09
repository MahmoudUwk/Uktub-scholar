/**
 * Evidence redaction in the live harness: what a run directory may contain after the tested agent printed its environment.
 * No providers; the secrets below are made up.
 */
import { describe, it, beforeEach, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { appendRedacted, redact, registerSecrets, resetSecrets } from "../scripts/live/redact.ts";

const OPENALEX = "oa-test-0123456789abcdef";
const SCHOLAR = "s2-test-AbCdEfGhIjKlMnOpQrStUvWxYz0123456789";
const dir = mkdtempSync(join(tmpdir(), "live-redact-"));
after(() => rmSync(dir, { recursive: true, force: true }));
beforeEach(() => {
  resetSecrets();
  registerSecrets({ OPENALEX_API_KEY: OPENALEX, SEMANTIC_SCHOLAR_API_KEY: SCHOLAR });
});

describe("live evidence redaction", () => {
  it("replaces a forwarded key value wherever it appears, naming the variable", () => {
    const env = `{"OPENALEX_API_KEY":"${OPENALEX}","SEMANTIC_SCHOLAR_API_KEY":"${SCHOLAR}","HOME":"/home/u"}`;
    const out = redact(`env dump: ${env}; again ${OPENALEX}`);
    assert.ok(!out.includes(OPENALEX) && !out.includes(SCHOLAR));
    assert.equal((out.match(/\[REDACTED:OPENALEX_API_KEY\]/g) ?? []).length, 2);
    assert.match(out, /\[REDACTED:SEMANTIC_SCHOLAR_API_KEY\]/);
    assert.match(out, /"HOME":"\/home\/u"/, "unrelated text is untouched");
  });

  it("keeps JSON valid: a redacted JSON line still parses", () => {
    const line = JSON.stringify({ toolName: "bash", result: { text: `OPENALEX_API_KEY=${OPENALEX}\nSEMANTIC_SCHOLAR_API_KEY=${SCHOLAR}` } });
    const parsed = JSON.parse(redact(line));
    assert.ok(!JSON.stringify(parsed).includes(OPENALEX));
  });

  it("redacts the JSON-escaped form of a value that JSON.stringify changes", () => {
    const odd = 'k"ey\\value-12345';
    registerSecrets({ ODD_KEY: odd });
    const out = redact(JSON.stringify({ v: odd }));
    assert.ok(!out.includes("value-12345"));
    assert.deepEqual(JSON.parse(out), { v: "[REDACTED:ODD_KEY]" });
  });

  it("treats a value as text, not a pattern", () => {
    registerSecrets({ DOTTED_KEY: "a.b+c*d(e)f[g]h" });
    assert.equal(redact("x a.b+c*d(e)f[g]h y aXb+c*d(e)f[g]h z"), "x [REDACTED:DOTTED_KEY] y aXb+c*d(e)f[g]h z");
  });

  it("ignores empty and very short values so unrelated evidence is not corrupted", () => {
    resetSecrets();
    registerSecrets({ EMPTY_KEY: "", SHORT_KEY: "abc", MISSING_KEY: undefined });
    assert.equal(redact("abc is a common substring; so is the empty string"), "abc is a common substring; so is the empty string");
  });

  it("still redacts credential shapes that carry no registered value", () => {
    const out = redact(`Authorization: Bearer abc.def.ghi and ya29.A0AbCdEf-gh_ij and AIza${"x".repeat(30)} and "refresh_token":"1//abc"`);
    assert.ok(!/abc\.def\.ghi|ya29\.A0|AIzax{30}|1\/\/abc/.test(out));
  });

  it("appendRedacted writes the redacted text, so the file never holds the value", () => {
    const file = join(dir, "transcript.jsonl");
    appendRedacted(file, `${JSON.stringify({ out: `key=${OPENALEX}` })}\n`);
    appendRedacted(file, `${JSON.stringify({ out: `key=${SCHOLAR}` })}\n`);
    const text = readFileSync(file, "utf8");
    assert.ok(!text.includes(OPENALEX) && !text.includes(SCHOLAR));
    assert.equal(text.trim().split("\n").length, 2);
  });
});
