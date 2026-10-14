/**
 * Browser implementation of the `node:crypto` surface the core uses:
 * `createHash("sha256")`, `randomBytes`, `randomInt`.
 *
 * SHA-256 is computed by `@noble/hashes` (SHA-2, CPU). Randomness comes from
 * `crypto.getRandomValues` (CSPRNG in workers). Anything else throws at call
 * time.
 */
import { sha256 } from "@noble/hashes/sha2.js";
import { BrowserBuffer } from "./buffer.ts";

type HashInput = string | Uint8Array | ArrayBufferView | ArrayBuffer;

const te = new TextDecoder();

function toBytes(data: HashInput, encoding?: string): Uint8Array {
  if (typeof data === "string") {
    const enc = (encoding ?? "utf8").toLowerCase().replace(/-/g, "");
    if (enc === "utf8" || enc === "utf8") return new TextEncoder().encode(data);
    if (enc === "ascii" || enc === "latin1" || enc === "binary") {
      const out = new Uint8Array(data.length);
      for (let i = 0; i < data.length; i++) out[i] = data.charCodeAt(i) & 0xff;
      return out;
    }
    if (enc === "hex") {
      if (data.length % 2 !== 0 || /[^0-9a-fA-F]/.test(data)) {
        throw new TypeError("Invalid hex string for hash update");
      }
      const out = new Uint8Array(data.length / 2);
      for (let i = 0; i < out.length; i++) out[i] = parseInt(data.slice(i * 2, i * 2 + 2), 16);
      return out;
    }
    if (enc === "base64" || enc === "base64url") {
      const bin = atob(data.replace(/-/g, "+").replace(/_/g, "/"));
      const out = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
      return out;
    }
    throw new TypeError(`Unknown encoding for hash update: ${encoding}`);
  }
  if (data instanceof Uint8Array) return new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
  if (ArrayBuffer.isView(data)) {
    return new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
  }
  if (data instanceof ArrayBuffer) {
    return new Uint8Array(data);
  }
  const sab: unknown = typeof SharedArrayBuffer !== "undefined" ? SharedArrayBuffer : undefined;
  if (typeof sab === "function" && (data as unknown) instanceof (sab as new () => object)) {
    return new Uint8Array(data as unknown as ArrayBuffer);
  }
  throw new TypeError("Hash update data must be a string or a Buffer/TypedArray/ArrayBuffer");
}

function fromBytes(digest: Uint8Array, encoding: string): string {
  if (encoding === "hex") {
    let s = "";
    for (const b of digest) s += b.toString(16).padStart(2, "0");
    return s;
  }
  if (encoding === "base64" || encoding === "base64url") {
    let bin = "";
    const CH = 0x8000;
    for (let i = 0; i < digest.length; i += CH) {
      bin += String.fromCharCode(...digest.subarray(i, i + CH));
    }
    let b64 = btoa(bin);
    if (encoding === "base64url") b64 = b64.replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
    return b64;
  }
  if (encoding === "binary" || encoding === "latin1") {
    return te.decode(digest);
  }
  throw new TypeError(`Unknown digest encoding: ${encoding}`);
}

/**
 * Node-compatible overloads: an encoding returns a string, no encoding
 * returns the bytes (a `BrowserBuffer`, so `.toString("hex")` keeps working
 * the way core code like `verify/workflow.ts` uses Node's Buffer).
 */
export interface BrowserHash {
  update(data: HashInput, encoding?: string): BrowserHash;
  digest(): BrowserBuffer;
  digest(encoding: string): string;
  copy(): BrowserHash;
}

type NobleCtx = ReturnType<typeof sha256.create>;

function makeHash(ctx: NobleCtx): BrowserHash {
  function digest(): BrowserBuffer;
  function digest(encoding: string): string;
  function digest(encoding?: string): BrowserBuffer | string {
    const out = (ctx as NobleCtx).digest();
    if (encoding === undefined) return BrowserBuffer.from(out);
    return fromBytes(out, encoding);
  }
  const h: BrowserHash = {
    update(data: HashInput, encoding?: string): BrowserHash {
      ctx.update(toBytes(data, encoding));
      return h;
    },
    digest,
    copy(): BrowserHash {
      return makeHash((ctx as unknown as { clone(): NobleCtx }).clone());
    },
  };
  return h;
}

/** Only `sha256` is implemented; every other algorithm throws at call time. */
export function createHash(algorithm: string): BrowserHash {
  if (typeof algorithm !== "string" || algorithm.toLowerCase().replace(/-/g, "") !== "sha256") {
    throw new TypeError(`not implemented in the browser build: node:crypto.createHash(${JSON.stringify(algorithm)})`);
  }
  return makeHash(sha256.create());
}

function randValues(n: number): BrowserBuffer {
  if (!Number.isInteger(n) || n < 0) throw new RangeError("randomBytes size must be a non-negative integer");
  const out = new BrowserBuffer(n);
  if (n > 0) crypto.getRandomValues(out);
  return out;
}

/** CSPRNG bytes (a `BrowserBuffer`, matching Node's Buffer return). */
export function randomBytes(size: number): BrowserBuffer {
  return randValues(size);
}

function randBelow(bound: number): number {
  // Rejection sampling over 48-bit values: uniform on [0, bound).
  const range = 0x1000000000000;
  const limit = range - (range % bound);
  const w = new Uint8Array(6);
  for (;;) {
    crypto.getRandomValues(w);
    let v = 0;
    for (let i = 0; i < 6; i++) v = v * 256 + w[i];
    if (v < limit) return v % bound;
  }
}

function intArg(name: string, value: number): void {
  if (!Number.isSafeInteger(value)) {
    throw Object.assign(
      new TypeError(`The "${name}" argument must be a safe integer. Received type number (${String(value)})`),
      { code: "ERR_INVALID_ARG_TYPE" },
    );
  }
}

/** `randomInt(max)` / `randomInt(min, max)`, matching Node's range semantics. */
export function randomInt(min: number, max?: number): number {
  let lo: number, hi: number;
  if (max === undefined) { lo = 0; hi = min; intArg("max", hi); }
  else { lo = min; hi = max; intArg("min", lo); intArg("max", hi); }
  if (hi <= lo) {
    throw Object.assign(
      new RangeError(`The value of "max" is out of range. It must be greater than the value of "min" (${String(lo)}). Received ${String(hi)}`),
      { code: "ERR_OUT_OF_RANGE" },
    );
  }
  if (hi - lo > 0x1000000000000) {
    throw Object.assign(new RangeError("randomInt range exceeds 2^48 in this build"), { code: "ERR_OUT_OF_RANGE" });
  }
  return lo + randBelow(hi - lo);
}

const unsupported = (name: string) => (..._args: never[]): never => {
  throw new Error(`not implemented in the browser build: node:crypto.${name}`);
};

export const createHmac = unsupported("createHmac");
export const createCipheriv = unsupported("createCipheriv");
export const createDecipheriv = unsupported("createDecipheriv");
export const randomUUID = unsupported("randomUUID");
export const timingSafeEqual = unsupported("timingSafeEqual");
export const scryptSync = unsupported("scryptSync");
export const pbkdf2Sync = unsupported("pbkdf2Sync");
