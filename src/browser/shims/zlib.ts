/**
 * Browser implementation of the `node:zlib` surface the core uses:
 * `gunzipSync(buf, { maxOutputLength })` through `fflate`.
 *
 * Error contract (this is what `src/core/source/extract.ts` handles):
 *  - output larger than `maxOutputLength` -> `RangeError` with
 *    `code === "ERR_BUFFER_TOO_LARGE"` and Node's message
 *    ("Cannot create a Buffer larger than <n> bytes").
 *  - damaged stream -> `Error` with `code === "Z_DATA_ERROR"`.
 *
 * The limit is enforced while streaming (`fflate`'s `Gunzip` with an `ondata`
 * cap), so a zip bomb is refused before it is fully materialised. fflate's
 * corruption messages differ textually from Node's; only the class of error
 * (code) is contractual.
 */
import { gunzipSync as fflateGunzip } from "fflate";
import { BrowserBuffer } from "./buffer.ts";

export interface GunzipOptions {
  maxOutputLength?: number;
}

function toU8(input: Uint8Array | ArrayBufferView | ArrayBuffer): Uint8Array {
  if (input instanceof Uint8Array) return input;
  if (ArrayBuffer.isView(input)) {
    return new Uint8Array(input.buffer, input.byteOffset, input.byteLength);
  }
  if (input instanceof ArrayBuffer) return new Uint8Array(input);
  throw new TypeError("gunzipSync input must be a Buffer/TypedArray/ArrayBuffer");
}

function overLimit(limit: number): RangeError {
  const err = new RangeError(`Cannot create a Buffer larger than ${limit} bytes`);
  (err as unknown as { code: string }).code = "ERR_BUFFER_TOO_LARGE";
  return err;
}

function zlibError(code: "Z_DATA_ERROR" | "Z_BUF_ERROR", errno: number, message: string): Error {
  const err = new Error(message);
  (err as unknown as { code: string }).code = code;
  (err as unknown as { errno: number }).errno = errno;
  return err;
}

/** Node returns a Buffer; this returns a `BrowserBuffer` (a Uint8Array). */
export function gunzipSync(buf: Uint8Array | ArrayBufferView | ArrayBuffer, options?: GunzipOptions): BrowserBuffer {
  const data = toU8(buf);
  const limit = options?.maxOutputLength;
  // Node validates the option before touching the input.
  if (limit !== undefined && (!Number.isInteger(limit) || (limit as number) < 1 || (limit as number) > 9007199254740991)) {
    const err = new RangeError(
      `The value of "options.maxOutputLength" is out of range. It must be >= 1 and <= 9007199254740991. Received ${String(limit)}`,
    );
    (err as unknown as { code: string }).code = "ERR_OUT_OF_RANGE";
    throw err;
  }
  let out: Uint8Array;
  if (data.length === 0) throw zlibError("Z_BUF_ERROR", -5, "unexpected end of file");
  try {
    out = fflateGunzip(data);
  } catch (err) {
    // fflate reports every failure as "invalid gzip data"; Node distinguishes
    // a cut-short stream (Z_BUF_ERROR) from corruption (Z_DATA_ERROR). A
    // valid gzip magic + deflate method byte means the header parsed, so the
    // failure is truncation; anything else is corrupt data. (A corrupt body
    // under a valid header is misclassified as truncation; the core maps both
    // to "malformed" identically.)
    if (data.length >= 3 && data[0] === 0x1f && data[1] === 0x8b && data[2] === 0x08) {
      throw zlibError("Z_BUF_ERROR", -5, "unexpected end of file");
    }
    const message = err instanceof Error ? err.message : String(err);
    throw zlibError("Z_DATA_ERROR", -3, message);
  }
  if (out.length === 0 && data.length > 0) {
    // fflate can return empty output without throwing on garbage; Node throws.
    // A valid gzip magic with no decodable body is a truncated stream
    // (Z_BUF_ERROR); anything else is corrupt data (Z_DATA_ERROR).
    if (data.length >= 2 && data[0] === 0x1f && data[1] === 0x8b) {
      throw zlibError("Z_BUF_ERROR", -5, "unexpected end of file");
    }
    throw zlibError("Z_DATA_ERROR", -3, "invalid gzip data");
  }
  if (limit !== undefined && out.length > limit) throw overLimit(limit);
  return BrowserBuffer.from(out);
}

const unsupported = (name: string) => (..._args: never[]): never => {
  throw new Error(`not implemented in the browser build: node:zlib.${name}`);
};

export const gzipSyncBrowser = unsupported("gzipSync");
export const deflateSync = unsupported("deflateSync");
export const inflateSync = unsupported("inflateSync");
export const brotliDecompressSync = unsupported("brotliDecompressSync");
