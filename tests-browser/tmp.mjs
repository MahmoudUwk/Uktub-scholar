/**
 * Temp directories for the browser tests, removed when the test process exits
 * (`node --test` runs each spec file in its own process). Every spec used to
 * `mkdtempSync` into the OS temp dir and leave it behind (about 6 MB of bundle
 * per bundle call, hundreds of MB per day of runs).
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const made = new Set();
let hooked = false;

export function tmpDir(prefix) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  made.add(dir);
  if (!hooked) {
    hooked = true;
    process.on("exit", () => {
      for (const d of made) {
        try {
          fs.rmSync(d, { recursive: true, force: true });
        } catch {
          // best effort: a profile still locked by a closing browser is left for the OS temp cleaner
        }
      }
    });
  }
  return dir;
}
