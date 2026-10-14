/**
 * Tolerant deep comparison for differential results.
 *
 * Exact everywhere, except: non-integer numbers compare with relative
 * tolerance 1e-12 (bm25 floats may differ by 1 ulp between the Node-bundled
 * SQLite 3.53.1 and the WASM 3.53.4 build). Error objects compare on
 * name/code/errcode exactly; messages compare exactly unless the key is in
 * `messageExempt` (documented engine-message differences, e.g. fflate vs
 * zlib text). Key order in row objects is significant (column order).
 */
export const FLOAT_REL_TOL = 1e-12;

function isInt(x) {
  return typeof x === "number" && Number.isInteger(x);
}

function numEqual(a, b) {
  if (isInt(a) && isInt(b)) return a === b;
  if (typeof a !== "number" || typeof b !== "number") return false;
  if (a === b) return true;
  if (!Number.isFinite(a) || !Number.isFinite(b)) return false;
  const denom = Math.max(Math.abs(a), Math.abs(b), 1e-300);
  return Math.abs(a - b) / denom <= FLOAT_REL_TOL;
}

export function diffResults(expected, actual, { messageExempt = new Set() } = {}) {
  const diffs = [];
  const walk = (a, b, path) => {
    if (a === b) return;
    if (typeof a === "number" && typeof b === "number") {
      if (!numEqual(a, b)) diffs.push(`${path}: number ${a} !== ${b}`);
      return;
    }
    if (Array.isArray(a) && Array.isArray(b)) {
      if (a.length !== b.length) { diffs.push(`${path}: length ${a.length} !== ${b.length}`); return; }
      for (let i = 0; i < a.length; i++) walk(a[i], b[i], `${path}[${i}]`);
      return;
    }
    if (a && b && typeof a === "object" && typeof b === "object") {
      if (a.__error !== undefined || b.__error !== undefined) {
        for (const k of ["__error", "name", "code", "errcode", "errno"]) {
          if (a[k] !== b[k]) diffs.push(`${path}.${k}: ${JSON.stringify(a[k])} !== ${JSON.stringify(b[k])}`);
        }
        if (!messageExempt.has(path) && a.message !== b.message) {
          diffs.push(`${path}.message: ${JSON.stringify(a.message)} !== ${JSON.stringify(b.message)}`);
        }
        const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
        for (const k of keys) {
          if (["__error", "name", "message", "code", "errcode", "errno"].includes(k)) continue;
          walk(a[k], b[k], `${path}.${k}`);
        }
        return;
      }
      const ka = Object.keys(a);
      const kb = Object.keys(b);
      if (ka.length !== kb.length || ka.some((k, i) => k !== kb[i])) {
        diffs.push(`${path}: keys/order ${JSON.stringify(ka)} !== ${JSON.stringify(kb)}`);
      }
      for (const k of ka) {
        if (!(k in b)) continue;
        walk(a[k], b[k], path ? `${path}.${k}` : k);
      }
      return;
    }
    diffs.push(`${path}: ${JSON.stringify(a)?.slice(0, 160)} !== ${JSON.stringify(b)?.slice(0, 160)}`);
  };
  walk(expected, actual, "$");
  return diffs;
}
