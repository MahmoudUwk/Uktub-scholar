/**
 * W1: code-scoped papers for the section child (pure scope logic, no registry).
 * Invented citekeys/DOIs throughout; no paper text.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  checkSectionPapers,
  MAX_SECTION_PAPERS,
  outOfScopeMessage,
  scopeForwardArgs,
  scopeRegistryArgs,
  type SectionPaper,
  type SectionScope,
} from "../src/agent/section-scope.ts";

const ready = (citekey: string, doi: string, handle = citekey): SectionPaper => ({ handle, citekey, doi, state: "ready", detail: null });
const unready = (handle: string, citekey: string, doi: string, state: SectionPaper["state"], detail: string | null = null): SectionPaper => ({
  handle, citekey, doi, state, detail,
});

/** A scope over two ready papers; fails the test when the rows do not check. */
const scopeOf = (): SectionScope => {
  const keys = ["smith2024", "jones2023"];
  const r = checkSectionPapers(keys, keys.map((k) => ready(k, `10.1000/${k}`)));
  assert.equal(r.ok, true, "fixture rows are ready");
  return (r as { ok: true; scope: SectionScope }).scope;
};

const okArgs = (r: { ok: true; args: unknown } | { ok: false; message: string }): Record<string, unknown> => {
  assert.equal(r.ok, true);
  return (r as { ok: true; args: Record<string, unknown> }).args;
};
const refused = (r: { ok: false; message: string } | { ok: true; args?: unknown; scope?: unknown }): string => {
  assert.equal(r.ok, false, "expected a refusal");
  return (r as { ok: false; message: string }).message;
};

describe("scopeForwardArgs (papers forward)", () => {
  it("1.1 omitted papers resolves to the section's allowed list", () => {
    assert.deepEqual(okArgs(scopeForwardArgs({ query: "aging" }, scopeOf())), { query: "aging", papers: ["smith2024", "jones2023"] });
  });

  it('1.2 "all", "" and "[]" all resolve to the allowed list', () => {
    for (const papers of ["all", "", "[]"]) {
      assert.deepEqual(okArgs(scopeForwardArgs({ claim: "c", papers }, scopeOf())).papers, ["smith2024", "jones2023"], papers);
    }
  });

  it("1.3 an in-scope list passes, DOI maps to citekey case-insensitively, duplicates collapse", () => {
    const args = okArgs(scopeForwardArgs({ claim: "c", papers: "smith2024 10.1000/JONES2023 smith2024" }, scopeOf()));
    assert.deepEqual(args.papers, ["smith2024", "jones2023"]);
  });

  it("1.4 an out-of-scope handle refuses the whole call and names the allowed keys (a literal all inside a list too)", () => {
    for (const papers of ["smith2024 ghost9", "all smith2024"]) {
      const m = refused(scopeForwardArgs({ claim: "c", papers }, scopeOf()));
      assert.match(m, /ghost9|all/, papers);
      assert.match(m, /smith2024.*jones2023/, papers);
    }
  });

  it("1.5 query and token continuations pass through; a non-token continuation is dropped (pin on existing normalize behavior)", () => {
    const a = okArgs(scopeForwardArgs({ claim: "c", query: "q", continuation: "vfy1:abc" }, scopeOf()));
    assert.equal(a.query, "q");
    assert.equal(a.continuation, "vfy1:abc");
    const b = okArgs(scopeForwardArgs({ claim: "c", continuation: "Leave empty" }, scopeOf()));
    assert.ok(!("continuation" in b), "non-token continuation is dropped");
  });
});

describe("scopeRegistryArgs (D1 registry forward)", () => {
  it("handles omitted resolves to the allowed list with action read", () => {
    assert.deepEqual(okArgs(scopeRegistryArgs({ action: "read" }, scopeOf())), { action: "read", handles: ["smith2024", "jones2023"] });
  });

  it("an in-scope handle maps through keyOf; an out-of-scope handle refuses naming the allowed keys", () => {
    const args = okArgs(scopeRegistryArgs({ action: "read", handles: ["10.1000/SMITH2024"] }, scopeOf()));
    assert.deepEqual(args.handles, ["smith2024"]);
    const m = refused(scopeRegistryArgs({ action: "read", handles: ["smith2024", "ghost9"] }, scopeOf()));
    assert.match(m, /ghost9/);
    assert.match(m, /smith2024.*jones2023/);
  });

  it("an action other than read is refused", () => {
    assert.match(refused(scopeRegistryArgs({ action: "acquire", handles: ["smith2024"] }, scopeOf())), /read/);
  });

  it("an argument outside handles/fields/limit/cursor is refused", () => {
    assert.match(refused(scopeRegistryArgs({ action: "read", identifiers: ["10.1000/x"] }, scopeOf())), /identifiers/);
  });

  it("fields, limit and cursor pass through with the scoped handles", () => {
    assert.deepEqual(
      okArgs(scopeRegistryArgs({ action: "read", fields: ["title"], limit: 5, cursor: "tok" }, scopeOf())),
      { action: "read", handles: ["smith2024", "jones2023"], fields: ["title"], limit: 5, cursor: "tok" },
    );
  });
});

describe("checkSectionPapers", () => {
  it("1.6 twenty-one distinct papers are refused with the count and the limit; twenty pass", () => {
    assert.equal(MAX_SECTION_PAPERS, 20);
    const k21 = Array.from({ length: 21 }, (_, i) => `key${String(i).padStart(2, "0")}`);
    const m = refused(checkSectionPapers(k21, k21.map((k) => ready(k, `10.1000/${k}`))));
    assert.match(m, /21/);
    assert.match(m, /20/);
    const k20 = k21.slice(0, 20);
    const r = checkSectionPapers(k20, k20.map((k) => ready(k, `10.1000/${k}`)));
    assert.equal(r.ok, true);
  });

  it("1.7 a citekey plus its own DOI counts once", () => {
    const row = ready("smith2024", "10.1000/smith2024");
    const r = checkSectionPapers(["smith2024", "10.1000/smith2024"], [
      { ...row, handle: "smith2024" },
      { ...row, handle: "10.1000/smith2024" },
    ]);
    assert.equal(r.ok, true);
    assert.deepEqual([...(r as { ok: true; scope: SectionScope }).scope.keys], ["smith2024"]);
  });

  it("1.8 each unready paper is listed once with key, reason and next step; ready keys are absent", () => {
    const rows = [
      ready("smith2024", "10.1000/smith2024"),
      unready("jones2023", "jones2023", "10.1000/jones2023", "metadata_only"),
      unready("lee2022", "lee2022", "10.1000/lee2022", "acquiring"),
      unready("wu2021", "wu2021", "10.1000/wu2021", "failed", "ERR_TIMEOUT"),
    ];
    const m = refused(checkSectionPapers(["smith2024", "jones2023", "lee2022", "wu2021"], rows));
    assert.match(m, /jones2023.*metadata_only.*acquire/s);
    assert.match(m, /attach_source/);
    assert.match(m, /lee2022.*acquiring/s);
    assert.match(m, /wu2021.*failed.*ERR_TIMEOUT/s);
    assert.doesNotMatch(m, /smith2024/);
  });

  it("1.9 a handle with no row is unregistered", () => {
    assert.match(refused(checkSectionPapers(["ghost9"], [])), /ghost9.*not_registered/s);
  });

  it("outOfScopeMessage names the paper and the allowed keys", () => {
    assert.match(outOfScopeMessage("ghost9", scopeOf()), /ghost9.*smith2024.*jones2023/);
  });
});
