/** Differential scenario: node:crypto surface the core uses (sha256, random). */
import { createHash, randomBytes, randomInt } from "node:crypto";
import { norm, step, type Norm } from "./norm.ts";

export function runCryptoScenario(): Record<string, Norm> {
  const out: Record<string, Norm> = {};
  const hexOf = (b: unknown): string => norm(b) as unknown as string;

  out["empty"] = norm(createHash("sha256").update("").digest("hex"));
  out["oneByte"] = norm(createHash("sha256").update("a", "utf8").digest("hex"));
  out["abc"] = norm(createHash("sha256").update("abc").digest("hex"));
  const mib = "x".repeat(1024 * 1024);
  out["oneMib"] = norm(createHash("sha256").update(mib, "utf8").digest("hex"));
  out["multipart"] = norm(createHash("sha256").update("a").update("b").update("c").digest("hex"));
  out["multibyte"] = norm(createHash("sha256").update("héllo wörld 日本語", "utf8").digest("hex"));
  out["u8"] = norm(createHash("sha256").update(new Uint8Array([104, 105])).digest("hex"));
  out["u8view"] = norm(createHash("sha256").update(new DataView(new Uint8Array([104, 105]).buffer)).digest("hex"));
  out["base64"] = norm(createHash("sha256").update("abc").digest("base64"));
  out["digestBytes"] = norm(createHash("sha256").update("abc").digest());
  out["chained"] = step(() => {
    const h = createHash("sha256");
    const same = h.update("a") === h;
    return { same, hex: h.update("bc").digest("hex") };
  });
  out["doiStyle"] = norm(createHash("sha256").update("10.1/abc", "utf8").digest("hex"));
  out["hexUpdate"] = step(() => createHash("sha256").update("616263", "hex").digest("hex"));

  // randomBytes / randomInt: shape and range only (values differ by nature).
  out["randomBytes"] = step(() => {
    const b = randomBytes(8) as unknown as Uint8Array;
    let hex = "";
    for (const x of b) hex += x.toString(16).padStart(2, "0");
    return { len: b.length, isU8: b instanceof Uint8Array, hexLen: hex.length };
  });
  out["randomBytesZero"] = step(() => ({ len: randomBytes(0).length }));
  out["randomIntRange"] = step(() => {
    for (let i = 0; i < 200; i++) {
      const v = randomInt(250);
      if (!Number.isInteger(v) || v < 0 || v >= 250) return { ok: false, v };
    }
    for (let i = 0; i < 200; i++) {
      const v = randomInt(5, 10);
      if (!Number.isInteger(v) || v < 5 || v >= 10) return { ok: false, v };
    }
    return { ok: true };
  });
  out["randomIntBad"] = step(() => randomInt(10, 10));
  out["randomIntFloat"] = step(() => randomInt(1.5));
  out["unsupportedAlgo"] = step(() => (createHash("md5") as unknown as { digest(_e: string): string }).digest("hex"));
  void hexOf;
  return out;
}
