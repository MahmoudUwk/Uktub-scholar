/** JSON-safe normalization shared by every differential scenario. */
export type Norm = null | boolean | number | string | Norm[] | { [k: string]: Norm };

export function norm(value: unknown): Norm {
  if (value === null || value === undefined) return null;
  if (typeof value === "boolean" || typeof value === "number" || typeof value === "string") {
    if (typeof value === "number" && !Number.isFinite(value)) return { __num: String(value) } as unknown as Norm;
    return value;
  }
  if (typeof value === "bigint") return { __bigint: String(value) } as unknown as Norm;
  if (value instanceof Uint8Array) return { __u8: [...value] } as unknown as Norm;
  if (ArrayBuffer.isView(value)) {
    return { __u8: [...new Uint8Array(value.buffer, value.byteOffset, value.byteLength)] } as unknown as Norm;
  }
  if (value instanceof ArrayBuffer) return { __u8: [...new Uint8Array(value)] } as unknown as Norm;
  if (value instanceof Error) {
    const rec = value as unknown as Record<string, unknown>;
    const out: Record<string, Norm> = { __error: norm(value.constructor.name) as Norm };
    out["name"] = norm(value.name) as Norm;
    out["message"] = norm(value.message) as Norm;
    if (typeof rec["code"] === "string") out["code"] = rec["code"] as string;
    if (typeof rec["errcode"] === "number") out["errcode"] = rec["errcode"] as number;
    if (typeof rec["errno"] === "number") out["errno"] = rec["errno"] as number;
    return out as Norm;
  }
  if (Array.isArray(value)) return value.map(norm);
  if (typeof value === "object") {
    const out: Record<string, Norm> = {};
    for (const k of Object.keys(value)) out[k] = norm((value as Record<string, unknown>)[k]);
    return out;
  }
  return { __other: String(value) } as unknown as Norm;
}

/** Run one step, capturing either its normalized value or its thrown error. */
export function step(fn: () => unknown): Norm {
  try {
    return norm(fn());
  } catch (err) {
    return norm(err);
  }
}
