/**
 * The supervised llama-server must not outlive its host, including when the host is killed uncatchably (SIGKILL, OOM-kill), where no
 * exit handler runs. POSIX only: a watcher process notices the parent is gone.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const FAKE = fileURLToPath(new URL("./helpers/fake-llama-server.mjs", import.meta.url));
const RUNTIME = fileURLToPath(new URL("../src/core/embed/runtime.ts", import.meta.url));
const alive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};
const until = async (cond: () => boolean, ms: number): Promise<boolean> => {
  for (let t = 0; t < ms; t += 100) {
    if (cond()) return true;
    await new Promise((r) => setTimeout(r, 100));
  }
  return cond();
};

describe("supervised server lifecycle", { skip: process.platform === "win32" }, () => {
  it("the child dies when the host is SIGKILLed (no exit handler can run)", async () => {
    const dir = mkdtempSync(join(tmpdir(), "uktub-orph-"));
    try {
      chmodSync(FAKE, 0o755);
      const parent = join(dir, "parent.ts");
      writeFileSync(
        parent,
        `import { startServer, readLock } from ${JSON.stringify(RUNTIME)};
         const s = await startServer({ paths: { server: ${JSON.stringify(FAKE)}, model: "/x/model.gguf" }, lock: readLock(), cacheDir: ${JSON.stringify(join(dir, "cache"))} });
         console.log("CHILD " + s.pid);
         setInterval(() => {}, 1000);`,
      );
      const host = spawn(process.execPath, [parent], { stdio: ["ignore", "pipe", "inherit"] });
      const childPid = await new Promise<number>((resolve, reject) => {
        let buf = "";
        host.stdout.on("data", (d) => {
          buf += d;
          const m = /CHILD (\d+)/.exec(buf);
          if (m) resolve(Number(m[1]));
        });
        host.on("exit", () => reject(new Error("host exited before starting the server: " + buf)));
      });
      assert.ok(alive(childPid), "the supervised server is running");
      host.kill("SIGKILL");
      const gone = await until(() => !alive(childPid), 8_000);
      if (!gone) process.kill(childPid, "SIGKILL"); // never leak from a failing test
      assert.ok(gone, "the server must not outlive a SIGKILLed host");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("a clean stop kills the child and leaves nothing behind", async () => {
    const dir = mkdtempSync(join(tmpdir(), "uktub-orph-"));
    try {
      const { startServer, readLock } = await import("../src/core/embed/runtime.ts");
      const s = await startServer({ paths: { server: FAKE, model: "/x/model.gguf" }, lock: readLock(), cacheDir: join(dir, "cache") });
      assert.ok(alive(s.pid));
      await s.stop();
      assert.ok(await until(() => !alive(s.pid), 3_000));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
