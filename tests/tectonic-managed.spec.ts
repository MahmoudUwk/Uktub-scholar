import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readdirSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gzipSync } from "node:zlib";

import { RuntimeError } from "../src/core/embed/runtime.ts";
import { installTectonic, managedTectonicPath, readTectonicLock, validateTectonicLock, type TectonicLock } from "../src/core/compile/managed.ts";
import { resolveEngine } from "../src/core/compile/engine.ts";
import { makeTarGz } from "./helpers/tar.ts";

const FAKE = "#!/bin/sh\necho 'Tectonic 0.17.0'\n";
const URL_OF = "https://example.test/tectonic-0.17.0-x86_64-unknown-linux-musl.tar.gz";

function lockFor(archive: Uint8Array, over: Partial<{ sha256: string; size: number }> = {}): TectonicLock {
  return validateTectonicLock({
    schema: 1,
    tool: {
      name: "tectonic",
      version: "0.17.0",
      license: "MIT",
      assets: {
        "linux-x64": { name: "tectonic-0.17.0-x86_64-unknown-linux-musl.tar.gz", url: URL_OF, sha256: over.sha256 ?? createHash("sha256").update(archive).digest("hex"), size: over.size ?? archive.length, dir: "", binary: "tectonic" },
      },
    },
  });
}
const serve = (archive: Uint8Array): { fetch: typeof fetch; requests: string[] } => {
  const requests: string[] = [];
  const f = (async (url: string | URL | Request) => {
    requests.push(String(url));
    return String(url) === URL_OF ? new Response(Buffer.from(archive) as never, { status: 200, headers: { "content-length": String(archive.length) } }) : new Response("no", { status: 404 });
  }) as typeof fetch;
  return { fetch: f, requests };
};
const archiveOf = (script = FAKE): Uint8Array => makeTarGz([{ name: "tectonic", data: script, mode: 0o755 }]);
const probeBy = (out: string) => async () => out;

let cache: string;
beforeEach(() => void (cache = mkdtempSync(join(tmpdir(), "uktub-tec-"))));
afterEach(() => rmSync(cache, { recursive: true, force: true }));

describe("tectonic.lock.json", () => {
  it("is valid, pins a stable release, and names every supported platform with real digests", () => {
    const lock = readTectonicLock();
    assert.match(lock.tool.version, /^\d+\.\d+\.\d+$/, "a stable semver tag, not a rolling 'continuous' build");
    for (const p of ["linux-x64", "linux-arm64", "darwin-x64", "darwin-arm64", "win32-x64"]) {
      const a = lock.tool.assets[p];
      assert.ok(a, p);
      assert.ok(a.url.includes(`tectonic@${lock.tool.version}`) || a.url.includes(`/tectonic%40${lock.tool.version}/`) || a.url.includes(`/tectonic@${lock.tool.version}/`), `${p} must come from the ${lock.tool.version} release tag`);
      assert.match(a.sha256, /^[0-9a-f]{64}$/);
    }
    assert.equal(lock.tool.assets["win32-arm64"], undefined, "no official build exists; it must not be invented");
  });
});

describe("installTectonic", () => {
  it("downloads, verifies, self-checks and installs; the path then resolves", async () => {
    const a = archiveOf();
    const lock = lockFor(a);
    assert.equal(managedTectonicPath(lock, cache, "linux-x64"), null, "nothing installed yet");
    const r = await installTectonic({ lock, cacheDir: cache, platform: "linux-x64", fetch: serve(a).fetch, probe: probeBy("Tectonic 0.17.0") });
    assert.equal(r.downloaded, true);
    assert.ok(statSync(r.path).isFile());
    assert.equal(managedTectonicPath(lock, cache, "linux-x64"), r.path);
    assert.deepEqual(readdirSync(join(cache, "downloads")).filter((n) => n.endsWith(".part")), [], "no partial file left");
  });

  it("is idempotent: a second run downloads nothing", async () => {
    const a = archiveOf();
    const lock = lockFor(a);
    const s = serve(a);
    await installTectonic({ lock, cacheDir: cache, platform: "linux-x64", fetch: s.fetch, probe: probeBy("Tectonic 0.17.0") });
    const again = await installTectonic({ lock, cacheDir: cache, platform: "linux-x64", fetch: s.fetch, probe: probeBy("Tectonic 0.17.0") });
    assert.equal(again.downloaded, false);
    assert.equal(s.requests.length, 1);
  });

  it("refuses bytes that do not match the pinned digest, installing nothing", async () => {
    const a = archiveOf();
    const lock = lockFor(a, { sha256: "0".repeat(64) });
    await assert.rejects(installTectonic({ lock, cacheDir: cache, platform: "linux-x64", fetch: serve(a).fetch, probe: probeBy("Tectonic 0.17.0") }), (e) => e instanceof RuntimeError && e.code === "checksum_mismatch");
    assert.equal(managedTectonicPath(lock, cache, "linux-x64"), null);
  });

  it("refuses a binary that does not report the pinned version (the self-check), leaving no install and no receipt", async () => {
    const a = archiveOf();
    const lock = lockFor(a);
    await assert.rejects(installTectonic({ lock, cacheDir: cache, platform: "linux-x64", fetch: serve(a).fetch, probe: probeBy("Tectonic 0.15.0") }), (e) => e instanceof RuntimeError && e.code === "start_failed");
    assert.equal(managedTectonicPath(lock, cache, "linux-x64"), null);
    assert.equal(existsSync(join(cache, "tools")), false, "nothing committed");
  });

  it("a probe that throws is the same refusal, not a raw error", async () => {
    const a = archiveOf();
    await assert.rejects(installTectonic({ lock: lockFor(a), cacheDir: cache, platform: "linux-x64", fetch: serve(a).fetch, probe: async () => { throw new Error("exec format error"); } }), (e) => e instanceof RuntimeError && e.code === "start_failed");
  });

  it("refuses an archive without the binary", async () => {
    const a = makeTarGz([{ name: "README", data: "no engine here" }]);
    await assert.rejects(installTectonic({ lock: lockFor(a), cacheDir: cache, platform: "linux-x64", fetch: serve(a).fetch, probe: probeBy("Tectonic 0.17.0") }), (e) => e instanceof RuntimeError && e.code === "missing_binary");
  });

  it("an unsupported platform is refused before any download and names the bring-your-own route", async () => {
    const a = archiveOf();
    const s = serve(a);
    await assert.rejects(installTectonic({ lock: lockFor(a), cacheDir: cache, platform: "win32-arm64", fetch: s.fetch, probe: probeBy("") }), (e) => e instanceof RuntimeError && e.code === "unsupported_platform" && /UKTUB_TECTONIC_BIN/.test(e.message));
    assert.equal(s.requests.length, 0);
  });

  it("a gzip that is not a tar is an unsafe_archive refusal", async () => {
    const a = gzipSync(Buffer.from("not a tar"));
    await assert.rejects(installTectonic({ lock: lockFor(a), cacheDir: cache, platform: "linux-x64", fetch: serve(a).fetch, probe: probeBy("Tectonic 0.17.0") }), (e) => e instanceof RuntimeError && (e.code === "unsafe_archive" || e.code === "missing_binary"));
  });
});

describe("engine resolution order: UKTUB_TECTONIC_BIN, then PATH, then the managed copy", () => {
  const present = new Set<string>();
  const fs = { exists: (p: string) => present.has(p), executable: (p: string) => present.has(p) };
  const ver = (v: string) => async (file: string) => ({ stdout: `${file}|Tectonic ${v}`, stderr: "" });
  beforeEach(() => present.clear());

  it("falls back to the managed copy only when nothing else is found", async () => {
    present.add("/cache/tools/tectonic");
    const r = await resolveEngine({ PATH: "/usr/bin" }, ver("0.17.0"), fs, "/cache/tools/tectonic");
    assert.ok(r.ok && r.engine.path === "/cache/tools/tectonic");
  });

  it("a tectonic on PATH wins over the managed copy (the user owns their toolchain)", async () => {
    present.add("/usr/bin/tectonic").add("/cache/tools/tectonic");
    const r = await resolveEngine({ PATH: "/usr/bin" }, ver("0.15.0"), fs, "/cache/tools/tectonic");
    assert.ok(r.ok && r.engine.path === "/usr/bin/tectonic");
  });

  it("the explicit override wins over both, and a bad override does not silently fall back", async () => {
    present.add("/cache/tools/tectonic");
    const r = await resolveEngine({ UKTUB_TECTONIC_BIN: "/nope/tectonic", PATH: "/usr/bin" }, ver("0.17.0"), fs, "/cache/tools/tectonic");
    assert.equal(r.ok, false);
  });

  it("with no managed copy the not-found detail points at the install command", async () => {
    const r = await resolveEngine({ PATH: "/usr/bin" }, ver("0.17.0"), fs, null);
    assert.ok(!r.ok && /tectonic install/.test(r.detail));
  });
});

describe("engine resolution on Windows", () => {
  const present = new Set<string>();
  const fs = { exists: (p: string) => present.has(p), executable: (p: string) => present.has(p) };
  const ver = async () => ({ stdout: "Tectonic 0.17.0", stderr: "" });
  beforeEach(() => present.clear());

  it("splits PATH on ';' and finds tectonic.exe", async () => {
    present.add("C:\\tools\\bin\\tectonic.exe");
    const r = await resolveEngine({ PATH: "C:\\Windows;C:\\tools\\bin" }, ver, fs, null, "win32");
    assert.ok(r.ok, JSON.stringify(r));
    assert.equal(r.ok && r.engine.path, "C:\\tools\\bin\\tectonic.exe");
  });

  it("a Windows path with a drive colon is not cut in half (the ':' split would have)", async () => {
    present.add("D:\\tex\\tectonic.exe");
    assert.ok((await resolveEngine({ PATH: "D:\\tex" }, ver, fs, null, "win32")).ok);
  });

  it("POSIX behavior is unchanged", async () => {
    present.add("/usr/bin/tectonic");
    assert.ok((await resolveEngine({ PATH: "/bin:/usr/bin" }, ver, fs, null, "linux")).ok);
  });
});
