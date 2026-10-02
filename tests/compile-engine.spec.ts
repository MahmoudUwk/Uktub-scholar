/**
 * Engine location spec: resolution order (override > PATH), the version floor,
 * and every failure reason — all with a fake execFile, fully offline.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { ENGINE_ENV_OVERRIDE, ENGINE_MIN_VERSION, resolveEngine } from "../src/core/compile/engine.ts";

function fakeExec(responds: Record<string, { stdout?: string; stderr?: string; throws?: boolean }>) {
  return async (file: string, args: string[]) => {
    const r = responds[`${file} ${args.join(" ")}`] ?? { throws: true };
    if (r.throws) throw new Error("spawn failed");
    return { stdout: r.stdout ?? "", stderr: r.stderr ?? "" };
  };
}

const GOOD = { stdout: "Tectonic 0.15.0\n", stderr: "" };

const everythingExists = { exists: (_p: string) => true, executable: (_p: string) => true };

describe("engine resolution", () => {
  it("override wins over PATH and is version-probed", async () => {
    const r = await resolveEngine(
      { [ENGINE_ENV_OVERRIDE]: "/opt/tec/tectonic", PATH: "/usr/bin:/bin" },
      fakeExec({ "/opt/tec/tectonic --version": GOOD, "/usr/bin/tectonic --version": GOOD }),
      everythingExists,
    );
    assert.ok(r.ok && r.engine.path === "/opt/tec/tectonic" && r.engine.version === "0.15.0");
  });

  it("PATH order: first existing candidate that probes clean", async () => {
    const r = await resolveEngine(
      { PATH: "/bin:/usr/local/bin" },
      fakeExec({ "/usr/local/bin/tectonic --version": GOOD }),
      { exists: (p) => p === "/usr/local/bin/tectonic", executable: () => true },
    );
    assert.ok(r.ok && r.engine.path === "/usr/local/bin/tectonic");
  });

  it("not-found: empty PATH and no override", async () => {
    const r = await resolveEngine({}, async () => GOOD);
    assert.ok(!r.ok && r.reason === "not-found" && /no `tectonic` binary on PATH/.test(r.detail));
  });

  it("not-found: override names a missing file", async () => {
    const r = await resolveEngine({ [ENGINE_ENV_OVERRIDE]: "/nope/tectonic" }, async () => GOOD);
    assert.ok(!r.ok && r.reason === "not-found" && /does not exist/.test(r.detail));
  });

  it("not-executable: existing file without the exec bit", async () => {
    const r = await resolveEngine(
      { PATH: "/bin" },
      async () => GOOD,
      { exists: () => true, executable: () => false },
    );
    assert.ok(!r.ok && r.reason === "not-executable" && /not executable/.test(r.detail));
  });

  it("version-unsupported: below the tested floor", async () => {
    const r = await resolveEngine(
      { PATH: "/bin" },
      fakeExec({ "/bin/tectonic --version": { stdout: "Tectonic 0.14.1\n" } }),
      everythingExists,
    );
    assert.ok(!r.ok && r.reason === "version-unsupported");
    if (!r.ok) assert.match(r.detail, new RegExp(String(ENGINE_MIN_VERSION.minor)));
  });

  it("unparseable version output is refused, never guessed", async () => {
    const r = await resolveEngine(
      { PATH: "/bin" },
      fakeExec({ "/bin/tectonic --version": { stdout: "hello" } }),
      everythingExists,
    );
    assert.ok(!r.ok && r.reason === "version-unsupported" && /did not report/.test(r.detail));
  });
});
