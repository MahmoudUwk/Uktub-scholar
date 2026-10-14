/**
 * Differential scenario: the Buffer shim vs Node's Buffer over edge cases,
 * the exact core expressions that use Buffer, and the real core extractors.
 * Bare `Buffer` here is Node's global in Node and the injected shim in the
 * worker bundle. `write` is unsupported BY DESIGN (throws in the worker);
 * real-PDF parsing needs `unpdf` (stubbed in the worker).
 */
import { extractPdf, extractTei } from "../../src/core/source/extract.ts";
import { norm, step, type Norm } from "./norm.ts";

const TEI =
  `<?xml version="1.0" encoding="UTF-8"?>` +
  `<TEI><teiHeader><titleStmt><title>Attention Is All You Need</title></titleStmt></teiHeader>` +
  `<text><body>` +
  `<p>We propose a new simple network architecture, the Transformer, based solely on attention mechanisms, dispensing with recurrence and convolutions entirely for sequence transduction tasks.</p>` +
  `<p>Experiments on machine translation show superior quality while requiring significantly less time to train than recurrent architectures.</p>` +
  `</body></text></TEI>`;

/** Same TEI gzipped (node:zlib gzipSync, embedded so the worker needs no gzip). */
const TEI_GZ_B64 =
  "H4sIAAAAAAAAA1WRMU8DMQyF/4rVufRgY7ge6lAECwtFiDHNuT2LxL7aTq/99yhthWByhveeP7+0T6ec4IhqJLycPSzuZ4AcpSfeL2cfm+e7x9lT127Wr13rSC8YetSudfKE75799uxW7shOwvBqsEoJvqTAG2LfNlfBbV49zd8oPHnXbqU/d+3YfSKMKqMYQgDGCYzymBAYfRL9hqBxIMfoRXEOPiBsNLDtRDPqHLbBsAeThOkMwhB+sTLGITBZtjn0ZCOyEe9hIh9AMRZV5IgQuIcofJRUqs2g2rWm7UTB8FAuMq9L+xIv0R7s2xZtM9YD1qcRlTKyWwXIIQ7EN0MKF70NMoGVqhOFQwmJ/AzTQAlB8VBIK5nRnmlHMbCnMyQ0A6eM4FLDiMGHwL/o/q+ZG01zbbW5VtzUT/wBSC6t9vABAAA=";

const enc = (s: string): Uint8Array => new TextEncoder().encode(s);

async function astep(fn: () => unknown): Promise<Norm> {
  try {
    return norm(await fn());
  } catch (err) {
    return norm(err);
  }
}

export async function runBufferScenario(): Promise<Record<string, Norm>> {
  const out: Record<string, Norm> = {};
  const B = Buffer;

  out["empty"] = norm(B.from("", "utf8").toString("hex"));
  out["emptyLen"] = norm(B.from("", "utf8").length);
  out["binary"] = norm(B.from([0x00, 0xff, 0x01, 0x80]).toString("hex"));
  out["multibyte"] = norm(B.from("héllo wörld 日本語", "utf8").toString("hex"));
  out["latin1"] = norm(B.from("café", "latin1").toString("hex"));
  out["hexRound"] = norm(B.from("deadbeef", "hex").toString("hex"));
  out["b64"] = norm(B.from("hello world", "utf8").toString("base64"));
  out["b64url"] = norm(B.from("hello world", "utf8").toString("base64url"));
  out["b64urlNoPad"] = norm(B.from("YWI", "base64url").toString("utf8"));
  out["b64urlPadded"] = norm(B.from("YWI=", "base64url").toString("utf8"));
  out["offset"] = norm(B.from(enc("xxabcyy").buffer, 2, 3).toString("utf8"));
  out["offsetView"] = norm(B.from(new Uint8Array([1, 2, 3, 4]).subarray(1, 3)).toString("hex"));
  out["subarrayShared"] = step(() => {
    const b = B.from("abcdef", "utf8");
    const s = b.subarray(1, 4);
    s[0] = 0x5a;
    return { sub: s.toString("utf8"), parent: b.toString("utf8") };
  });
  out["subarrayKind"] = step(() => {
    const s = B.from("abc").subarray(0, 2);
    return { isBuffer: B.isBuffer(s), hex: s.toString("hex"), sub2: s.subarray(1).toString("utf8") };
  });
  out["indexOfStart"] = norm(B.from("abcabc").indexOf(B.from("abc")));
  out["indexOfEnd"] = norm(B.from("abcabc").indexOf("bc", 2));
  out["indexOfAbsent"] = norm(B.from("abcdef").indexOf(B.from("xyz")));
  out["indexOfByte"] = norm(B.from([1, 2, 3, 2, 1]).indexOf(2));
  out["includesStr"] = norm(B.from("xx%PDF-yy", "latin1").includes("%PDF-"));
  out["includesMissing"] = norm(B.from("abcdef").includes("xyz"));
  out["concat"] = norm(B.concat([B.from("ab"), B.from("cd")]).toString("utf8"));
  out["concatTotal"] = norm(B.concat([B.from("abcdef")], 4).toString("utf8"));
  out["alloc"] = norm(B.alloc(4).toString("hex"));
  out["allocFill"] = norm(B.alloc(4, 0x61).toString("utf8"));
  out["isBuffer"] = step(() => ({ buf: B.isBuffer(B.from("x")), u8: B.isBuffer(new Uint8Array(1)), str: B.isBuffer("x") }));
  out["equals"] = step(() => ({
    same: B.from("abc").equals(B.from("abc")),
    diff: B.from("abc").equals(B.from("abd")),
    len: B.from("abc").equals(B.from("abcd")),
  }));
  out["toStringSlice"] = norm(B.from("abcdef").toString("utf8", 1, 4));
  out["unsupported"] = step(() => (B.from("ab") as unknown as { write(_s: string): number }).write("cd"));

  // Exact core expressions (verbatim bodies from src/core).
  out["extractIndexOf"] = step(() => {
    const bytes = enc("%PDF-1.7 test");
    const n = B.from("%PDF-", "latin1");
    return B.from(bytes.buffer, bytes.byteOffset, bytes.byteLength).subarray(0, 8).indexOf(n);
  });
  out["workflowToken"] = step(() => {
    const runId = "r-9f2c";
    const token = B.from(JSON.stringify({ v: 2, r: runId })).toString("base64url");
    const t = JSON.parse(B.from(token, "base64url").toString("utf8")) as { v?: number; r?: unknown };
    return { token, ok: t.v === 2 && t.r === runId };
  });
  out["registryCursor"] = step(() => {
    const token = { v: 1, s: "aa", f: "bb", g: 3 };
    const cursor = B.from(JSON.stringify({ ...token, a: "smith2020" })).toString("base64url");
    const parsed = JSON.parse(B.from(cursor, "base64url").toString("utf8")) as typeof token & { a?: string };
    return { ok: parsed.v === 1 && parsed.a === "smith2020", cursorLen: cursor.length };
  });

  // Real core functions (extractPdf error paths stay client-side; a real PDF
  // needs unpdf, which is stubbed in the worker — asserted in buffer.spec.ts).
  out["extractTei"] = await astep(async () => {
    const r = extractTei(enc(TEI));
    return { textLen: r.text.length, extraction: r.extraction, head: r.text.slice(0, 40) };
  });
  out["extractTeiGz"] = await astep(async () => {
    const r = extractTei(new Uint8Array(B.from(TEI_GZ_B64, "base64")));
    return { textLen: r.text.length, extraction: r.extraction, head: r.text.slice(0, 40) };
  });
  out["extractPdfNonPdf"] = await astep(async () => extractPdf(enc("hello, not a pdf")));
  out["extractPdfTruncated"] = await astep(async () => extractPdf(enc("%PDF-1.4\n1 0 obj\n<<>>\n")));
  out["extractPdfGarbageMarkers"] = await astep(async () => extractPdf(enc("%PDF-1.4\ngarbage no objects here\n%%EOF\n")));
  return out;
}
