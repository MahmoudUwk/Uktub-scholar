/**
 * Provider keys for the live harness (scripts/live/keys.ts): the shell first, then a gitignored `.env` in this repository, and only
 * the three names the harness forwards (a stray secret in the same file must never be picked up). No other repository is read.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { KEY_NAMES, parseDotenv, providerKeys } from "../scripts/live/keys.ts";

describe("parseDotenv", () => {
  it("reads plain, exported and quoted assignments, skips comments and blank lines", () => {
    const text = ["# provider keys", "", "OPENALEX_API_KEY=oa-123", "export SEMANTIC_SCHOLAR_API_KEY='s2 456'", 'CROSSREF_MAILTO="me@example.org"'].join("\n");
    assert.deepEqual(parseDotenv(text, KEY_NAMES), { OPENALEX_API_KEY: "oa-123", SEMANTIC_SCHOLAR_API_KEY: "s2 456", CROSSREF_MAILTO: "me@example.org" });
  });

  it("returns only the requested names: another secret in the file is never read", () => {
    const parsed = parseDotenv("GITHUB_TOKEN=ghp_secret\nOPENALEX_API_KEY=oa-123\nVERTEX_KEY=zzz", KEY_NAMES);
    assert.deepEqual(Object.keys(parsed), ["OPENALEX_API_KEY"]);
  });

  it("ignores empty values and handles CRLF files", () => {
    assert.deepEqual(parseDotenv("OPENALEX_API_KEY=\r\nSEMANTIC_SCHOLAR_API_KEY=s2\r\n", KEY_NAMES), { SEMANTIC_SCHOLAR_API_KEY: "s2" });
  });
});

describe("providerKeys", () => {
  it("the shell wins over the file, per name", () => {
    const keys = providerKeys({ OPENALEX_API_KEY: "from-shell" }, "OPENALEX_API_KEY=from-file\nSEMANTIC_SCHOLAR_API_KEY=s2-file");
    assert.deepEqual(keys, { OPENALEX_API_KEY: "from-shell", SEMANTIC_SCHOLAR_API_KEY: "s2-file" });
  });

  it("with no file it is the shell alone; with nothing at all it is empty (a keyless run)", () => {
    assert.deepEqual(providerKeys({ CROSSREF_MAILTO: "a@b.org", PATH: "/usr/bin" }, null), { CROSSREF_MAILTO: "a@b.org" });
    assert.deepEqual(providerKeys({}, null), {});
    assert.deepEqual(providerKeys({ OPENALEX_API_KEY: "" }, ""), {});
  });
});
