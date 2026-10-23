/**
 * Compile lifecycle: cancellation reaches the engine child, a cancelled compile
 * is never reported as a timeout, and a maxBuffer overflow is named as such.
 * Offline: the engine is a fake spawn, or a real Node child (never tectonic).
 */
import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { compileDocument, prodSpawn, type EngineSpawn } from "../src/core/compile/run.ts";

let root: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "uktub-compile-life-"));
  mkdirSync(join(root, "manuscript"), { recursive: true });
  writeFileSync(join(root, "manuscript", "main.tex"), "\\begin{document}x\\end{document}");
});
afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

const ENGINE_ENV = { UKTUB_TECTONIC_BIN: "/fake/tectonic", PATH: "" };
const engineFs = { exists: () => true, executable: () => true };
const DONE = { stdout: "", stderr: "", code: 0, timedOut: false };

/** Resolve with `value` or reject with `error` after `ms`, bounded so a hang fails the test instead of stalling it. */
function within<T>(p: Promise<T>, ms: number, what: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const limit = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${what} did not settle within ${ms} ms`)), ms);
  });
  return Promise.race([p, limit]).finally(() => clearTimeout(timer));
}

/** A fake engine: answers --version, then runs a compile that lasts `ms` unless the signal aborts it. */
function longCompile(ms: number, seen: { aborted: boolean }): EngineSpawn {
  return async (_file, args, opts) => {
    if (args[0] === "--version") return { stdout: "Tectonic 0.15.0\n", stderr: "", code: 0, timedOut: false };
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(resolve, ms);
      opts.signal?.addEventListener(
        "abort",
        () => {
          seen.aborted = true;
          clearTimeout(timer);
          reject(opts.signal?.reason);
        },
        { once: true },
      );
    });
    return DONE;
  };
}

describe("cancellation reaches the engine child", () => {
  it("an abort during a running compile kills the child and settles promptly as cancelled (not after the 120 s budget)", async () => {
    const seen = { aborted: false };
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 50);
    const started = Date.now();
    await assert.rejects(
      within(
        compileDocument({ root, env: ENGINE_ENV, fs: engineFs, spawn: longCompile(5_000, seen), signal: controller.signal }),
        1_500,
        "the cancelled compile",
      ),
      (err: unknown) => (err as Error).name === "AbortError",
    );
    assert.equal(seen.aborted, true, "the engine child received the abort");
    assert.ok(Date.now() - started < 1_000, "the call settled once the abort fired");
  });

  it("an already-aborted signal never spawns the engine", async () => {
    let compileSpawned = false;
    const controller = new AbortController();
    controller.abort();
    await assert.rejects(
      compileDocument({
        root,
        env: ENGINE_ENV,
        fs: engineFs,
        spawn: async (_f, args) => {
          if (args[0] !== "--version") compileSpawned = true;
          return DONE;
        },
        signal: controller.signal,
      }),
      (err: unknown) => (err as Error).name === "AbortError",
    );
    assert.equal(compileSpawned, false);
  });

  it("prodSpawn kills a real child when its signal aborts, and the abort is not a timeout", async () => {
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 50);
    await assert.rejects(
      within(
        prodSpawn(process.execPath, ["-e", "setTimeout(() => {}, 10000)"], { cwd: root, timeoutMs: 60_000, signal: controller.signal }),
        1_500,
        "the aborted child",
      ),
      (err: unknown) => (err as Error).name === "AbortError",
      "an abort must reject as cancelled, never resolve as timedOut",
    );
  });
});

describe("a timeout stays a timeout", () => {
  it("prodSpawn reports timedOut when the budget elapses on a real child", async () => {
    const r = await within(
      prodSpawn(process.execPath, ["-e", "setTimeout(() => {}, 10000)"], { cwd: root, timeoutMs: 200 }),
      5_000,
      "the timed-out child",
    );
    assert.equal(r.timedOut, true);
  });
});

describe("maxBuffer overflow is named, not a bare exit code", () => {
  it("prodSpawn marks an output overflow (a real child printing more than the 16 MiB cap)", async () => {
    const r = await within(
      prodSpawn(process.execPath, ["-e", "process.stdout.write('x'.repeat(17 * 1024 * 1024))"], { cwd: root, timeoutMs: 60_000 }),
      15_000,
      "the overflowing child",
    );
    assert.equal(r.timedOut, false, "an overflow is not a timeout");
    assert.equal(r.outputOverflow, true, "the overflow is reported explicitly");
  });

  it("compileDocument says the engine output exceeded the 16 MiB client-policy cap, not a bare exit code 1", async () => {
    const outcome = await compileDocument({
      root,
      env: ENGINE_ENV,
      fs: engineFs,
      spawn: async (_f, args) => {
        if (args[0] === "--version") return { stdout: "Tectonic 0.15.0\n", stderr: "", code: 0, timedOut: false };
        return { stdout: "", stderr: "", code: 1, timedOut: false, outputOverflow: true };
      },
    });
    assert.equal(outcome.kind, "errors");
    if (outcome.kind === "errors") {
      const message = outcome.diagnostics.map((d) => d.message).join("\n");
      assert.match(message, /16 MiB/);
      assert.match(message, /client policy/i);
      assert.match(message, /output/i);
      assert.doesNotMatch(message, /without printing an error line/, "the overflow is not a generic exit code");
    }
  });
});
