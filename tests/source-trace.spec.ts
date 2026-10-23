/**
 * W3: the source trace (pure, invented text with real pointer syntax throughout).
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";

import type { AnnotatedClaim, StatedSource } from "../src/core/verify/annotations.ts";
import { createSourceTrace, unreadSources, type SourceTrace } from "../src/agent/source-trace.ts";

const DOI = "10.5555/calib1";
const REV = "cf7fcb9436071d8b";
const CITE = "calib2024";
const ptr = (start: number, end: number, doi = DOI, rev = REV): string => `${doi}@${rev}#${start}-${end}`;

/** A real-shaped passages outcome (double-nested tool payload) with invented excerpts. */
const passagesOutcome = (hits: unknown[]): unknown => ({
  toolCall: { toolCallId: "t1" },
  result: { structuredContent: { structuredContent: { hits } } },
  isError: false,
});
const hit = (over: Record<string, unknown>): Record<string, unknown> => ({
  rank: 1, doi: DOI, citekey: CITE, pointer: ptr(100, 200), section: "Lamp Methods", page: 3, found: true,
  excerpt: "Invented calibration sentence about steady cultures.",
  withheld: null, ...over,
});
/** A real-shaped verify outcome (double-nested evidence payload). */
const verifyOutcome = (evidence: unknown[]): unknown => ({
  toolCall: { toolCallId: "t2" },
  result: { structuredContent: { structuredContent: { evidence } } },
  isError: false,
});
const ev = (over: Record<string, unknown>): Record<string, unknown> => ({
  attested: true, doi: DOI, citekey: CITE, title: "Invented", citable: true, pointer: ptr(100, 200),
  revision: REV, span: { start: 100, end: 200, unit: "utf16" }, page: 3, chunkId: "c",
  excerpt: "Invented verification sentence about lamp light.", withheld: null,
  localized: true, judgment: { model: "m", protocol: "p", minConfidence: 0.99, score: 1 }, ...over,
});

const ptrSrc = (start: number, end: number, citekey = CITE, doi = DOI, rev = REV): StatedSource => ({
  citekey, ref: { kind: "pointer", pointer: ptr(start, end, doi, rev), doi, revision: rev, start, end }, line: 9,
});
const secSrc = (heading: string, citekey = CITE): StatedSource => ({ citekey, ref: { kind: "section", heading }, line: 9 });

describe("SourceTrace", () => {
  it("3.1 a delivered excerpt marks exact and contained spans seen, nothing else", () => {
    const trace = createSourceTrace();
    trace.record("passages", passagesOutcome([hit({})]));
    assert.equal(trace.isSeen(ptrSrc(100, 200)), true, "exact");
    assert.equal(trace.isSeen(ptrSrc(120, 180)), true, "contained");
    assert.equal(trace.isSeen(ptrSrc(50, 250)), false, "extended");
    assert.equal(trace.isSeen(ptrSrc(100, 200, CITE, DOI, "0000000000000000")), false, "other revision");
    assert.equal(trace.isSeen(ptrSrc(100, 200, CITE, "10.5555/other")), false, "other doi");
    assert.equal(trace.isSeen(ptrSrc(100, 200, "wrong2024")), false, "wrong citekey");
  });

  it("3.2 a withheld hit adds neither span nor heading, while a delivered sibling is seen", () => {
    const trace = createSourceTrace();
    trace.record("passages", passagesOutcome([
      hit({ pointer: ptr(300, 400), section: "Hidden Part", excerpt: null, withheld: { contained: true } }),
      hit({ section: "Shown Part" }),
    ]));
    assert.equal(trace.isSeen(ptrSrc(300, 400)), false);
    assert.equal(trace.isSeen(secSrc("Hidden Part")), false);
    assert.equal(trace.isSeen(ptrSrc(100, 200)), true);
    assert.equal(trace.isSeen(secSrc("Shown Part")), true);
    assert.deepEqual(trace.seen(), {
      spans: [{ doi: DOI, citekey: CITE, revision: REV, start: 100, end: 200 }],
      headings: [{ citekey: CITE, heading: "Shown Part" }],
    });
  });

  it("3.3 a heading is seen only for the same citekey after whitespace collapse; null sections are ignored", () => {
    const trace = createSourceTrace();
    trace.record("passages", passagesOutcome([hit({ section: "Lamp   Methods" }), hit({ section: null, pointer: ptr(500, 600) })]));
    assert.equal(trace.isSeen(secSrc("Lamp Methods")), true, "whitespace collapse");
    assert.equal(trace.isSeen(secSrc("Lamp\tMethods\nshaken")), false);
    assert.equal(trace.isSeen(secSrc("Lamp Methods", "other2024")), false, "citekey must match");
    assert.equal(trace.isSeen(secSrc("lamp methods")), false, "case is exact");
    assert.equal(trace.seen().headings.length, 1);
  });

  it("3.4 a verify evidence pointer is seen withheld or not; attested:false is ignored", () => {
    const trace = createSourceTrace();
    trace.record("verify", verifyOutcome([
      ev({ pointer: ptr(700, 800), excerpt: null, withheld: { contained: true } }),
      ev({}),
      ev({ pointer: ptr(900, 1000), attested: false }),
    ]));
    assert.equal(trace.isSeen(ptrSrc(700, 800)), true, "withheld evidence still counts (D2)");
    assert.equal(trace.isSeen(ptrSrc(100, 200)), true);
    assert.equal(trace.isSeen(ptrSrc(900, 1000)), false, "attested:false never counts");
    assert.equal(trace.seen().spans.length, 2);
  });

  it("3.5 shapes: double nesting and flat forms read; junk records nothing and never throws (pin: green on the stub by design)", () => {
    const flat = createSourceTrace();
    flat.record("passages", { structuredContent: { hits: [hit({})] } });
    assert.equal(flat.isSeen(ptrSrc(100, 200)), true, "flat form reads");
    const flatVerify = createSourceTrace();
    flatVerify.record("verify", { result: { structuredContent: { evidence: [ev({})] } } });
    assert.equal(flatVerify.isSeen(ptrSrc(100, 200)), true, "single nesting reads");
    for (const junk of [undefined, null, 42, "nope", { isError: true, content: [{ type: "text", text: "boom" }] }, { content: [{ type: "text", text: "refused" }] }, { result: { structuredContent: { structuredContent: "garbage" } } }]) {
      const t = createSourceTrace();
      t.record("passages", junk);
      t.record("verify", junk);
      t.record("registry", junk);
      assert.deepEqual(t.seen(), { spans: [], headings: [] });
    }
  });

  it("3.6 unreadSources lists only unread sources in claim order and never mutates the claims", () => {
    const trace = createSourceTrace();
    trace.record("passages", passagesOutcome([hit({ section: null })]));
    const claims: AnnotatedClaim[] = [
      { marker: 1, unitId: "u1", plain: "Read words.", cites: [CITE], sources: [{ ...ptrSrc(100, 200), line: 4 }] },
      { marker: 2, unitId: "u2", plain: "Unread words.", cites: [CITE], sources: [{ ...secSrc("Far Heading"), line: 6 }] },
      { marker: 3, unitId: "u3", plain: "More unread words.", cites: [CITE], sources: [{ ...ptrSrc(500, 600), line: 8 }] },
    ];
    const before = JSON.parse(JSON.stringify(claims)) as unknown;
    const unread = unreadSources(claims, trace);
    assert.deepEqual(unread.map((u) => [u.marker, u.citekey, u.ref]), [[2, CITE, "section=Far Heading"], [3, CITE, ptr(500, 600)]]);
    for (const u of unread) {
      assert.match(u.hint, /passages/);
      assert.match(u.hint, new RegExp(`c${u.marker}`));
      assert.match(u.hint, new RegExp(CITE));
    }
    assert.match(unread[0]!.hint, /Far Heading/);
    assert.deepEqual(claims, before, "report-only: the input claims are untouched");
  });
});

export type { SourceTrace };
