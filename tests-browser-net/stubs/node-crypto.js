/** Page-only stub for `node:crypto` (esbuild alias). Page tests never hash. */
export const randomInt = (n) => Math.floor(Math.random() * (n ?? 256));
export const createHash = () => {
  throw new Error("hash unavailable in page stub");
};
