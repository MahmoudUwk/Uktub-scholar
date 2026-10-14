/**
 * Browser globals for the browser typecheck program (`tsconfig.browser.json`,
 * `types: []`). `Buffer` and `process` are NOT available in a worker; the
 * bundles provide them at bundle time through esbuild `inject`
 * (`tests-browser/build.mjs` `GLOBAL_INJECT`), typed here with the shim
 * types so the core files the program reaches (through type-only imports)
 * check against the same surface that runs. Only shimmed globals are
 * declared here — anything else must fail the typecheck, not hide.
 */
import type { BrowserBuffer } from "./shims/buffer.ts";
import type { BrowserProcess } from "./shims/process.ts";

declare global {
  type Buffer = BrowserBuffer;
  const Buffer: typeof BrowserBuffer;
  const process: BrowserProcess;
}

export {};
