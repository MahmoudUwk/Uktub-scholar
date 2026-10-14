/** Differential scenario: node:zlib gunzipSync surface the core uses. */
import { gunzipSync } from "node:zlib";
import { norm, step, type Norm } from "./norm.ts";

export interface ZlibFixtures {
  /** Gzip bytes of the payload (built by the harness; the shim has no gzip). */
  gz: number[];
  payloadLen: number;
  payloadHead: number[];
  payloadText: string;
}

const td = new TextDecoder();

const u8 = (n: number[]): Uint8Array => new Uint8Array(n);

export function runZlibScenario(fx: ZlibFixtures): Record<string, Norm> {
  const out: Record<string, Norm> = {};
  const gz = u8(fx.gz);

  out["roundtrip"] = step(() => td.decode(gunzipSync(gz) as Uint8Array) === fx.payloadText);
  out["roundtripHead"] = step(() => [...(gunzipSync(gz) as Uint8Array)].slice(0, 8));
  out["payloadHead"] = norm(fx.payloadHead);
  out["limitOk"] = step(() => (gunzipSync(gz, { maxOutputLength: fx.payloadLen }) as Uint8Array).length);
  out["limitOneShort"] = step(() => gunzipSync(gz, { maxOutputLength: fx.payloadLen - 1 }));
  out["overLimit"] = step(() => gunzipSync(gz, { maxOutputLength: 1000 }));
  out["overLimitZero"] = step(() => gunzipSync(gz, { maxOutputLength: 0 }));
  out["corrupt"] = step(() => gunzipSync(u8([1, 2, 3, 4])));
  out["truncated"] = step(() => gunzipSync(gz.subarray(0, 10)));
  out["emptyInput"] = step(() => gunzipSync(u8([])));
  out["notGzip"] = step(() => gunzipSync(new TextEncoder().encode("plain text, not gzip at all")));
  out["limitHuge"] = step(() => (gunzipSync(gz, { maxOutputLength: 100 * 1024 * 1024 }) as Uint8Array).length);
  return out;
}
