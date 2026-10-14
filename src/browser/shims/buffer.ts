/**
 * Browser implementation of the Node `Buffer` surface the core uses.
 *
 * A `Uint8Array` subclass, so every ES `Uint8Array` member (`length`,
 * indexing, `byteLength`, iteration) works natively in a worker. On top:
 * `Buffer.from` (string with `utf8|latin1|ascii|hex|base64|base64url`,
 * ArrayBuffer with offset/length, typed arrays, number arrays),
 * `Buffer.concat`, `Buffer.alloc`, `Buffer.isBuffer`, and instance
 * `subarray` (same kind, shared memory), `indexOf`/`includes` (string and
 * byte needles like Node — plain `Uint8Array` only takes a byte),
 * `toString(enc)` and `equals`. Anything else Node-only throws a clear
 * "not implemented in the browser build: Buffer.<name>" at CALL time.
 *
 * Byte semantics match Node for the covered subset; differential tests in
 * `tests-browser/scenarios/buffer.ts` pin them against the real Buffer.
 */

function normEncoding(enc: string | undefined, dflt: string): string {
  const e = (enc ?? dflt).toLowerCase().replace(/-/g, "");
  if (e === "utf8") return "utf8";
  if (e === "latin1" || e === "binary") return "latin1";
  if (e === "ascii") return "ascii";
  if (e === "hex") return "hex";
  if (e === "base64") return "base64";
  if (e === "base64url") return "base64url";
  throw new TypeError(`Unknown encoding: ${enc}`);
}

function decodeString(s: string, enc: string): Uint8Array {
  if (enc === "utf8") return new TextEncoder().encode(s);
  if (enc === "latin1") {
    const out = new Uint8Array(s.length);
    for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i) & 0xff;
    return out;
  }
  if (enc === "ascii") {
    const out = new Uint8Array(s.length);
    for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i) & 0x7f;
    return out;
  }
  if (enc === "hex") {
    if (s.length % 2 !== 0 || /[^0-9a-fA-F]/.test(s)) throw new TypeError("Invalid hex string");
    const out = new Uint8Array(s.length / 2);
    for (let i = 0; i < out.length; i++) out[i] = parseInt(s.slice(i * 2, i * 2 + 2), 16);
    return out;
  }
  // base64 / base64url: tolerate missing padding and whitespace like Node.
  const std = s.replace(/-/g, "+").replace(/_/g, "/").replace(/\s+/g, "");
  const padded = std + "=".repeat((4 - (std.length % 4)) % 4);
  let bin: string;
  try {
    bin = atob(padded);
  } catch {
    throw new TypeError("Invalid base64 string");
  }
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

function encodeBytes(bytes: Uint8Array, enc: string): string {
  if (enc === "utf8") return new TextDecoder().decode(bytes);
  if (enc === "latin1" || enc === "ascii") {
    let s = "";
    const CH = 0x8000;
    for (let i = 0; i < bytes.length; i += CH) s += String.fromCharCode(...bytes.subarray(i, i + CH));
    return s;
  }
  if (enc === "hex") {
    let s = "";
    for (const b of bytes) s += b.toString(16).padStart(2, "0");
    return s;
  }
  let bin = "";
  const CH = 0x8000;
  for (let i = 0; i < bytes.length; i += CH) bin += String.fromCharCode(...bytes.subarray(i, i + CH));
  const b64 = btoa(bin);
  if (enc === "base64url") return b64.replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  return b64;
}

function wrap(u: Uint8Array): BrowserBuffer {
  if (u instanceof BrowserBuffer) return u;
  if (u.buffer instanceof ArrayBuffer) return new BrowserBuffer(u.buffer, u.byteOffset, u.byteLength);
  const out = new BrowserBuffer(u.byteLength);
  out.set(u);
  return out;
}

function nonNegInt(name: string, value: number): void {
  if (!Number.isInteger(value) || value < 0) {
    throw new RangeError(`The value of "${name}" is out of range. It must be a non-negative integer. Received ${String(value)}`);
  }
}

export class BrowserBuffer extends Uint8Array {
  static from(data: string, encoding?: string): BrowserBuffer;
  static from(data: ArrayBufferLike, byteOffset?: number, length?: number): BrowserBuffer;
  static from(data: ArrayBufferView): BrowserBuffer;
  static from(data: ArrayLike<number>): BrowserBuffer;
  static from(data: Iterable<number>): BrowserBuffer;
  static from<T>(data: ArrayLike<T> | Iterable<T>, mapfn: (v: T, k: number) => number, thisArg?: unknown): BrowserBuffer;
  static from(data: unknown, ...rest: unknown[]): BrowserBuffer {
    const [second, third] = rest;
    if (typeof data === "string") return new BrowserBuffer(decodeString(data, normEncoding(second as string | undefined, "utf8")));
    const sab: unknown = typeof SharedArrayBuffer !== "undefined" ? SharedArrayBuffer : undefined;
    if (data instanceof ArrayBuffer || (typeof sab === "function" && (data as unknown) instanceof (sab as new () => object))) {
      const ab = data as unknown as ArrayBufferLike;
      const off = (second as number | undefined) ?? 0;
      const len = (third as number | undefined) ?? (ab.byteLength - (off as number));
      if (ab instanceof ArrayBuffer) return new BrowserBuffer(ab, off as number, len);
      // SharedArrayBuffer-backed: copy out (DataView accepts ArrayBufferLike).
      const src = new DataView(ab, off as number, len);
      const out = new BrowserBuffer(len);
      for (let i = 0; i < len; i++) out[i] = src.getUint8(i);
      return out;
    }
    if (typeof second === "function") {
      const mapfn = second as (this: unknown, v: unknown, k: number) => number;
      const arr = Array.from(data as ArrayLike<unknown>, (v, k) => (mapfn.call(third, v, k) as number) & 0xff);
      return BrowserBuffer.from(arr);
    }
    if (ArrayBuffer.isView(data)) {
      const v = new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
      return new BrowserBuffer(v);
    }
    if (data !== null && typeof data === "object" && typeof (data as ArrayLike<number>).length === "number") {
      const arr = data as ArrayLike<number>;
      const out = new BrowserBuffer(arr.length);
      for (let i = 0; i < arr.length; i++) out[i] = (arr[i] as number) & 0xff;
      return out;
    }
    if (data !== null && typeof data === "object" && typeof (data as Iterable<number>)[Symbol.iterator] === "function") {
      return BrowserBuffer.from([...(data as Iterable<number>)]);
    }
    throw new TypeError("The first argument must be of type string or an instance of Buffer, ArrayBuffer, or Array or an Array-like Object");
  }

  static alloc(size: number, fill?: number | string | Uint8Array, encoding?: string): BrowserBuffer {
    nonNegInt("size", size);
    const out = new BrowserBuffer(size);
    if (fill === undefined || fill === 0) return out;
    if (typeof fill === "number") {
      out.fill(fill & 0xff);
      return out;
    }
    const pattern = typeof fill === "string" ? decodeString(fill, normEncoding(encoding, "utf8")) : new Uint8Array(fill.buffer, fill.byteOffset, fill.byteLength);
    if (pattern.length === 0) return out;
    for (let i = 0; i < out.length; i++) out[i] = pattern[i % pattern.length] as number;
    return out;
  }

  static concat(list: readonly Uint8Array[], totalLength?: number): BrowserBuffer {
    let sum = 0;
    for (const b of list) {
      if (!(b instanceof Uint8Array)) throw new TypeError("concat list must contain only Uint8Array/Buffer values");
      sum += b.byteLength;
    }
    const len = totalLength ?? sum;
    nonNegInt("totalLength", len);
    const out = new BrowserBuffer(len);
    let off = 0;
    for (const b of list) {
      if (off >= len) break;
      const n = Math.min(b.byteLength, len - off);
      out.set(b.subarray(0, n), off);
      off += n;
    }
    return out;
  }

  static isBuffer(b: unknown): boolean {
    return b instanceof BrowserBuffer;
  }

  /** Same kind, shared memory (Node's subarray semantics). */
  subarray(begin?: number, end?: number): BrowserBuffer {
    return wrap(super.subarray(begin, end));
  }

  /** Copying slice, same kind. */
  slice(begin?: number, end?: number): BrowserBuffer {
    return wrap(super.slice(begin, end));
  }

  indexOf(needle: string | number | Uint8Array, byteOffset?: number | string, encoding?: string): number {
    let off: number;
    let enc = encoding;
    if (typeof byteOffset === "string") {
      off = 0;
      enc = byteOffset;
    } else {
      off = byteOffset === undefined || Number.isNaN(byteOffset) ? 0 : Math.trunc(byteOffset);
    }
    if (off < 0) off = Math.max(0, this.length + off);
    if (typeof needle === "number") return super.indexOf(needle & 0xff, off);
    const n = typeof needle === "string" ? decodeString(needle, normEncoding(enc, "utf8")) : needle;
    if (!(n instanceof Uint8Array)) throw new TypeError("needle must be a string, number or Buffer/Uint8Array");
    if (n.length === 0) return Math.min(off, this.length);
    outer: for (let i = off; i + n.length <= this.length; i++) {
      for (let j = 0; j < n.length; j++) {
        if (this[i + j] !== n[j]) continue outer;
      }
      return i;
    }
    return -1;
  }

  includes(needle: string | number | Uint8Array, byteOffset?: number | string, encoding?: string): boolean {
    return this.indexOf(needle, byteOffset as number | undefined, encoding) !== -1;
  }

  toString(encoding?: string, start?: number, end?: number): string {
    const enc = normEncoding(encoding, "utf8");
    let s = start ?? 0;
    let e = end ?? this.length;
    s = Math.max(0, Math.min(this.length, Math.trunc(s)));
    e = Math.max(0, Math.min(this.length, Math.trunc(e)));
    if (e <= s) return "";
    return encodeBytes(this.subarray(s, e), enc);
  }

  equals(other: Uint8Array): boolean {
    if (!(other instanceof Uint8Array)) throw new TypeError('The "other" argument must be an instance of Buffer or Uint8Array');
    if (other.length !== this.length) return false;
    for (let i = 0; i < this.length; i++) {
      if (this[i] !== other[i]) return false;
    }
    return true;
  }
}

/**
 * Node-only members with no worker equivalent (and no `Uint8Array`
 * counterpart): throw at call time instead of silently diverging.
 */
const UNSUPPORTED = [
  "write", "copy", "swap16", "swap32", "swap64", "toJSON",
  "readUIntLE", "readUIntBE", "readIntLE", "readIntBE",
  "readUInt8", "readUInt16LE", "readUInt16BE", "readUInt32LE", "readUInt32BE",
  "readInt8", "readInt16LE", "readInt16BE", "readInt32LE", "readInt32BE",
  "readFloatLE", "readFloatBE", "readDoubleLE", "readDoubleBE",
  "readBigUInt64LE", "readBigUInt64BE", "readBigInt64LE", "readBigInt64BE",
  "writeUIntLE", "writeUIntBE", "writeIntLE", "writeIntBE",
  "writeUInt8", "writeUInt16LE", "writeUInt16BE", "writeUInt32LE", "writeUInt32BE",
  "writeInt8", "writeInt16LE", "writeInt16BE", "writeInt32LE", "writeInt32BE",
  "writeFloatLE", "writeFloatBE", "writeDoubleLE", "writeDoubleBE",
  "writeBigUInt64LE", "writeBigUInt64BE", "writeBigInt64LE", "writeBigInt64BE",
];
for (const name of UNSUPPORTED) {
  Object.defineProperty(BrowserBuffer.prototype, name, {
    value: (..._args: never[]): never => {
      throw new Error(`not implemented in the browser build: Buffer.${name}`);
    },
    writable: true,
    configurable: true,
  });
}

/**
 * The bundle-time global (esbuild `inject` in tests-browser/build.mjs maps
 * bare `Buffer` uses to this export); the type-level global lives in
 * `src/browser/globals.d.ts`.
 */
export const Buffer: typeof BrowserBuffer = BrowserBuffer;
