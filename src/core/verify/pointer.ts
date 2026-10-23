/**
 * Evidence pointers (W2 preliminary move): `doi@revision#start-end`, zero-based
 * end-exclusive UTF-16 offsets into the captured text. Moved out of `store.ts`
 * (which imports Node builtins) so the browser-bundled annotation parser can
 * use them. Pure: no imports.
 */

/** `doi@revision#start-end`: zero-based, end-exclusive UTF-16 offsets into the captured text. */
export const formatPointer = (doi: string, revision: string, start: number, end: number): string => `${doi}@${revision}#${start}-${end}`;

export function parsePointer(pointer: string): { doi: string; revision: string; start: number; end: number } | null {
  const m = /^(.+)@([0-9a-f]{16})#(\d+)-(\d+)$/.exec(pointer);
  if (m === null) return null;
  const start = Number(m[3]);
  const end = Number(m[4]);
  return Number.isSafeInteger(start) && Number.isSafeInteger(end) && start < end ? { doi: m[1]!, revision: m[2]!, start, end } : null;
}
