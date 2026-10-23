/**
 * Node-free papers-parameter parser: split a `papers` value on spaces,
 * commas or semicolons; accept arrays and JSON-string arrays too. No
 * registry, no Node builtin, so `src/agent/` (and the browser) can import
 * it. Re-exported from `src/core/verify/scope.ts` unchanged.
 */
export function parsePapersParam(input: unknown): string[] {
  let items: unknown = input;
  if (typeof items === "string") {
    const t = items.trim();
    if (t.startsWith("[") && t.endsWith("]")) {
      try {
        items = JSON.parse(t) as unknown;
      } catch {
        items = t;
      }
    }
  }
  const list = Array.isArray(items) ? items : typeof items === "string" ? items.split(/[\s,;]+/) : [];
  const out: string[] = [];
  for (const item of list) {
    if (typeof item !== "string") continue;
    for (const k of item.split(/[\s,;]+/)) {
      const key = k.trim();
      if (key !== "" && !out.includes(key)) out.push(key);
    }
  }
  return out;
}
