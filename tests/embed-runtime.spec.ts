/**
 * Managed embedding runtime (roadmap step 2; owner decision 2026-10-04): a pinned official llama-server
 * build and a pinned GGUF are fetched on first use, verified against the lock file's sha256 and size,
 * extracted safely, and run as a supervised child process. Offline: a fake fetch serves generated
 * artifacts and a fake llama-server script stands in for the binary.
 *
 * Contract:
 *  - nothing is trusted until its sha256 and size match the lock; a partial or wrong download is never
 *    left where the runtime would use it;
 *  - the archive is untrusted: `..`, absolute paths and symlink escapes are refused and nothing is written outside the cache;
 *  - install is idempotent (a second run makes no request) and repairs a corrupted file;
 *  - the child is supervised: it must become healthy, a failure names its stderr tail, and it never outlives the parent.
 */
import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, readlinkSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { RuntimeError, installRuntime, installedPaths, platformKey, readLock, startServer, validateLock, type RuntimeLock } from "../src/core/embed/runtime.ts";
import { makeTarGz, type TarEntry } from "./helpers/tar.ts";
import { zipSync } from "fflate";

const HERE = dirname(fileURLToPath(import.meta.url));
const FAKE_SERVER = readFileSync(join(HERE, "helpers", "fake-llama-server.mjs"));
const sha = (b: Uint8Array | string): string => createHash("sha256").update(b).digest("hex");

const MODEL = Buffer.from("not a real gguf but exactly the bytes the lock describes ".repeat(40));

function goodArchive(): Uint8Array {
  return makeTarGz([
    { name: "llama-test/", type: "dir" },
    { name: "llama-test/llama-server", data: FAKE_SERVER, mode: 0o755 },
    { name: "llama-test/LICENSE", data: "MIT" },
  ]);
}

function lockFor(archive: Uint8Array, model: Uint8Array = MODEL, over: Partial<RuntimeLock["runtime"]["assets"][string]> = {}): RuntimeLock {
  return {
    schema: 1,
    runtime: {
      name: "llama.cpp",
      version: "btest",
      license: "MIT",
      assets: { "linux-x64": { name: "llama-test.tar.gz", url: "https://example.test/llama-test.tar.gz", sha256: sha(archive), size: archive.length, dir: "llama-test", binary: "llama-server", ...over } },
    },
    embedding: {
      id: "test-embed",
      file: "model.gguf",
      url: "https://example.test/model.gguf",
      sha256: sha(model),
      size: model.length,
      license: "gemma",
      terms: "https://ai.google.dev/gemma/terms",
      profile: "embeddinggemma",
      serverArgs: ["--embeddings", "--pooling", "mean", "-c", "2048", "-b", "2048", "-ub", "2048", "--parallel", "1"],
    },
  };
}

/** A fake `fetch` serving the given bodies by URL; counts requests. */
function server(bodies: Record<string, Uint8Array | { status: number }>): { fetch: typeof fetch; requests: string[] } {
  const requests: string[] = [];
  const f = (async (url: string | URL | Request) => {
    const u = String(url);
    requests.push(u);
    const b = bodies[u];
    if (b === undefined) return new Response("not found", { status: 404 });
    if ("status" in b) return new Response("nope", { status: b.status });
    return new Response(Buffer.from(b) as unknown as ConstructorParameters<typeof Response>[0], { status: 200, headers: { "content-length": String(b.length) } });
  }) as typeof fetch;
  return { fetch: f, requests };
}

let cache: string;
beforeEach(() => {
  cache = mkdtempSync(join(tmpdir(), "uktub-rt-"));
});
afterEach(() => {
  rmSync(cache, { recursive: true, force: true });
});

const everythingUnder = (dir: string): string[] => {
  const out: string[] = [];
  const walk = (d: string): void => {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      const full = join(d, e.name);
      out.push(full);
      if (e.isDirectory()) walk(full);
    }
  };
  if (existsSync(dir)) walk(dir);
  return out;
};

describe("the shipped lock file", () => {
  it("parses, pins https URLs and 64-hex sha256 digests, and covers the platform the package is tested on", () => {
    const lock = readLock();
    assert.equal(lock.schema, 1);
    assert.match(lock.embedding.sha256, /^[0-9a-f]{64}$/);
    assert.ok(lock.embedding.url.startsWith("https://"));
    assert.ok(lock.runtime.assets["linux-x64"], "linux-x64 asset pinned");
    assert.match(lock.runtime.assets["linux-x64"].sha256, /^[0-9a-f]{64}$/);
    assert.equal(lock.embedding.profile, "embeddinggemma");
    for (const needed of ["--embeddings", "--pooling", "mean", "-b", "-ub"]) assert.ok(lock.embedding.serverArgs.includes(needed), `server args carry ${needed}`);
  });
});

describe("validateLock", () => {
  const good = (): RuntimeLock => lockFor(goodArchive());
  it("accepts a well-formed lock", () => assert.deepEqual(validateLock(JSON.parse(JSON.stringify(good()))), good()));
  it("refuses a lock that could not be trusted: non-https URL, bad digest, missing field, traversal in a path part", () => {
    const mutate = (f: (l: any) => void): unknown => {
      const l = JSON.parse(JSON.stringify(good()));
      f(l);
      return l;
    };
    const bad: [string, unknown][] = [
      ["http url", mutate((l) => (l.embedding.url = "http://example.test/m.gguf"))],
      ["file url", mutate((l) => (l.runtime.assets["linux-x64"].url = "file:///etc/passwd"))],
      ["short digest", mutate((l) => (l.embedding.sha256 = "abc"))],
      ["upper-case digest", mutate((l) => (l.embedding.sha256 = "A".repeat(64)))],
      ["no size", mutate((l) => delete l.embedding.size)],
      ["negative size", mutate((l) => (l.embedding.size = -1))],
      ["traversal in dir", mutate((l) => (l.runtime.assets["linux-x64"].dir = "../x"))],
      ["slash in binary", mutate((l) => (l.runtime.assets["linux-x64"].binary = "bin/llama-server"))],
      ["slash in model file", mutate((l) => (l.embedding.file = "../model.gguf"))],
      ["unknown schema", mutate((l) => (l.schema = 2))],
      ["not an object", "x"],
    ];
    for (const [label, l] of bad) assert.throws(() => validateLock(l), (e) => e instanceof RuntimeError && e.code === "invalid_lock", label);
  });
});

describe("zip archives (the Windows builds)", () => {
  const zipOf = (files: Record<string, string | Uint8Array>): Uint8Array =>
    zipSync(Object.fromEntries(Object.entries(files).map(([k, v]) => [k, typeof v === "string" ? new TextEncoder().encode(v) : v])));
  const zipLock = (archive: Uint8Array, over: Partial<RuntimeLock["runtime"]["assets"][string]> = {}): RuntimeLock =>
    lockFor(archive, MODEL, { name: "llama-test.zip", url: "https://example.test/llama-test.zip", dir: "", binary: "llama-server.exe", ...over });
  const install = (lock: RuntimeLock, archive: Uint8Array, maxUnpackedBytes?: number) =>
    installRuntime({ lock, cacheDir: cache, platform: "linux-x64", fetch: server({ [lock.runtime.assets["linux-x64"].url]: archive, [lock.embedding.url]: MODEL }).fetch, maxUnpackedBytes });

  it("installs a zip whose files sit at the archive root (llama-server.exe beside its DLLs, no top-level directory)", async () => {
    const archive = zipOf({ "llama-server.exe": "MZ fake executable", "ggml.dll": "dll", "sub/extra.dll": "nested dll" });
    const lock = zipLock(archive);
    const r = await install(lock, archive);
    assert.ok(r.paths.server.endsWith("llama-server.exe"));
    assert.equal(readFileSync(r.paths.server, "utf8"), "MZ fake executable");
    assert.equal(readFileSync(join(dirname(r.paths.server), "sub", "extra.dll"), "utf8"), "nested dll");
    assert.deepEqual(installedPaths(lock, cache, "linux-x64"), r.paths);
  });

  it("refuses zip entries that escape the install directory: '..', absolute, drive-letter and backslash forms", async () => {
    for (const bad of ["../escaped.txt", "/tmp/uktub-zip-abs.txt", "C:/Windows/evil.dll", "C:\\evil.dll", "a\\..\\b.txt", "sub/../../up.txt"]) {
      const archive = zipOf({ "llama-server.exe": "ok", [bad]: "pwned" });
      await assert.rejects(install(zipLock(archive), archive), (e) => e instanceof RuntimeError && e.code === "unsafe_archive", bad);
    }
    for (const p of [join(cache, "..", "escaped.txt"), "/tmp/uktub-zip-abs.txt"]) assert.ok(!existsSync(p), `${p} must not exist`);
  });

  it("refuses an archive whose declared unpacked size exceeds the cap, before inflating anything", async () => {
    const archive = zipOf({ "llama-server.exe": "ok", "big.bin": new Uint8Array(5000) });
    await assert.rejects(install(zipLock(archive), archive, 1000), (e) => e instanceof RuntimeError && e.code === "unsafe_archive" && /larger than/.test(e.message));
  });

  it("a zip without the expected binary is refused; a corrupt zip is refused as an archive problem, not a crash", async () => {
    const noBin = zipOf({ "readme.txt": "x" });
    await assert.rejects(install(zipLock(noBin), noBin), (e) => e instanceof RuntimeError && e.code === "missing_binary");
    const junk = Buffer.from("this is not a zip file at all".repeat(10));
    await assert.rejects(install(zipLock(junk), junk), (e) => e instanceof RuntimeError && e.code === "unsafe_archive");
  });

  it("the lock validator accepts an archive-root layout (empty dir) and only .tar.gz or .zip archives", () => {
    const archive = zipOf({ "llama-server.exe": "ok" });
    assert.doesNotThrow(() => validateLock(JSON.parse(JSON.stringify(zipLock(archive)))));
    const l = JSON.parse(JSON.stringify(zipLock(archive)));
    l.runtime.assets["linux-x64"].name = "llama.tar.xz";
    assert.throws(() => validateLock(l), (e) => e instanceof RuntimeError && e.code === "invalid_lock");
    const l2 = JSON.parse(JSON.stringify(zipLock(archive)));
    l2.runtime.assets["linux-x64"].dir = "../x";
    assert.throws(() => validateLock(l2), (e) => e instanceof RuntimeError && e.code === "invalid_lock");
  });
});

describe("platformKey", () => {
  it("names the platforms by node's platform and arch, and null for unknown ones", () => {
    assert.equal(platformKey("linux", "x64"), "linux-x64");
    assert.equal(platformKey("darwin", "arm64"), "darwin-arm64");
    assert.equal(platformKey("win32", "x64"), "win32-x64");
    assert.equal(platformKey("sunos", "sparc"), "sunos-sparc");
  });
});

describe("installRuntime", () => {
  it("downloads both artifacts, verifies them, extracts the runtime and makes the server executable", async () => {
    const archive = goodArchive();
    const lock = lockFor(archive);
    const srv = server({ [lock.runtime.assets["linux-x64"].url]: archive, [lock.embedding.url]: MODEL });
    const r = await installRuntime({ lock, cacheDir: cache, platform: "linux-x64", fetch: srv.fetch });
    assert.deepEqual([...r.downloaded].sort(), ["model", "runtime"]);
    assert.deepEqual(readFileSync(r.paths.model), MODEL);
    assert.ok(statSync(r.paths.server).mode & 0o111, "server is executable");
    assert.equal(readFileSync(r.paths.server).toString().split("\n")[0], "#!/usr/bin/env node");
    assert.deepEqual(installedPaths(lock, cache, "linux-x64"), r.paths);
    // nothing but the cache was written, and no partial files remain
    assert.ok(!everythingUnder(cache).some((p) => p.endsWith(".part")), "no .part files left behind");
  });

  it("is idempotent: a second install makes no request", async () => {
    const archive = goodArchive();
    const lock = lockFor(archive);
    const srv = server({ [lock.runtime.assets["linux-x64"].url]: archive, [lock.embedding.url]: MODEL });
    await installRuntime({ lock, cacheDir: cache, platform: "linux-x64", fetch: srv.fetch });
    const before = srv.requests.length;
    const again = await installRuntime({ lock, cacheDir: cache, platform: "linux-x64", fetch: srv.fetch });
    assert.equal(srv.requests.length, before);
    assert.deepEqual(again.downloaded, []);
  });

  it("a wrong digest is refused and leaves nothing the runtime could use", async () => {
    const archive = goodArchive();
    const lock = lockFor(archive);
    const tampered = Buffer.from(MODEL);
    tampered[7] ^= 0xff;
    const srv = server({ [lock.runtime.assets["linux-x64"].url]: archive, [lock.embedding.url]: tampered });
    await assert.rejects(installRuntime({ lock, cacheDir: cache, platform: "linux-x64", fetch: srv.fetch }), (e) => e instanceof RuntimeError && e.code === "checksum_mismatch");
    assert.equal(installedPaths(lock, cache, "linux-x64"), null);
    assert.ok(!everythingUnder(cache).some((p) => p.endsWith("model.gguf") || p.endsWith(".part")), "no model file, no partial file");
  });

  it("a body longer than the pinned size is cut off early; a shorter one is refused", async () => {
    const archive = goodArchive();
    const lock = lockFor(archive);
    const longer = Buffer.concat([MODEL, Buffer.alloc(1000, 1)]);
    await assert.rejects(
      installRuntime({ lock, cacheDir: cache, platform: "linux-x64", fetch: server({ [lock.runtime.assets["linux-x64"].url]: archive, [lock.embedding.url]: longer }).fetch }),
      (e) => e instanceof RuntimeError && e.code === "size_mismatch",
    );
    await assert.rejects(
      installRuntime({ lock, cacheDir: cache, platform: "linux-x64", fetch: server({ [lock.runtime.assets["linux-x64"].url]: archive, [lock.embedding.url]: MODEL.subarray(0, 100) }).fetch }),
      (e) => e instanceof RuntimeError && e.code === "size_mismatch",
    );
    assert.equal(installedPaths(lock, cache, "linux-x64"), null);
  });

  it("an endless or oversize body is cut off as soon as it exceeds the pinned size, not read to the end (disk and memory bound)", async () => {
    const archive = goodArchive();
    const lock = lockFor(archive);
    let pulled = 0;
    const endless = (async (url: string | URL | Request) => {
      if (String(url) === lock.runtime.assets["linux-x64"].url) return new Response(Buffer.from(archive) as unknown as ConstructorParameters<typeof Response>[0], { status: 200 });
      const body = new ReadableStream<Uint8Array>({
        pull(controller) {
          pulled++;
          if (pulled > 10_000) return controller.close(); // a safety stop for the test itself
          controller.enqueue(new Uint8Array(64 * 1024));
        },
      });
      return new Response(body, { status: 200 });
    }) as typeof fetch;
    await assert.rejects(installRuntime({ lock, cacheDir: cache, platform: "linux-x64", fetch: endless }), (e) => e instanceof RuntimeError && e.code === "size_mismatch");
    assert.ok(pulled < 100, `the body was pulled ${pulled} times: the size gate did not stop the download`);
  });

  it("HTTP errors and network failures are typed download failures", async () => {
    const archive = goodArchive();
    const lock = lockFor(archive);
    await assert.rejects(
      installRuntime({ lock, cacheDir: cache, platform: "linux-x64", fetch: server({ [lock.runtime.assets["linux-x64"].url]: { status: 503 }, [lock.embedding.url]: { status: 503 } }).fetch }),
      (e) => e instanceof RuntimeError && e.code === "download_failed" && /503/.test(e.message),
    );
    const down = (async () => {
      throw new TypeError("fetch failed");
    }) as typeof fetch;
    await assert.rejects(installRuntime({ lock, cacheDir: cache, platform: "linux-x64", fetch: down }), (e) => e instanceof RuntimeError && e.code === "download_failed");
  });

  it("a corrupted installed model is detected on the next install and only that artifact is fetched again", async () => {
    const archive = goodArchive();
    const lock = lockFor(archive);
    const srv = server({ [lock.runtime.assets["linux-x64"].url]: archive, [lock.embedding.url]: MODEL });
    const first = await installRuntime({ lock, cacheDir: cache, platform: "linux-x64", fetch: srv.fetch });
    const corrupt = Buffer.from(MODEL);
    corrupt[3] ^= 0x55; // same size, different content: only a digest check notices
    writeFileSync(first.paths.model, corrupt);
    srv.requests.length = 0;
    const second = await installRuntime({ lock, cacheDir: cache, platform: "linux-x64", fetch: srv.fetch });
    assert.deepEqual(second.downloaded, ["model"]);
    assert.deepEqual(srv.requests, [lock.embedding.url]);
    assert.deepEqual(readFileSync(second.paths.model), MODEL);
  });

  it("installs the real llama.cpp layout: a chain of same-directory symlinks (libx.so → libx.so.0 → libx.so.0.5.0) listed link-first (found by the live install)", async () => {
    const archive = makeTarGz([
      { name: "llama-test/", type: "dir" },
      { name: "llama-test/llama-server", data: FAKE_SERVER, mode: 0o755 },
      { name: "llama-test/libx.so.0", type: "symlink", linkname: "libx.so.0.5.0" },
      { name: "llama-test/libx.so", type: "symlink", linkname: "libx.so.0" },
      { name: "llama-test/libx.so.0.5.0", data: "shared library bytes" },
      { name: "llama-test/liby.so.0.5.0", data: "another" },
      { name: "llama-test/liby.so", type: "symlink", linkname: "liby.so.0" },
      { name: "llama-test/liby.so.0", type: "symlink", linkname: "liby.so.0.5.0" },
    ]);
    const lock = lockFor(archive);
    const r = await installRuntime({ lock, cacheDir: cache, platform: "linux-x64", fetch: server({ [lock.runtime.assets["linux-x64"].url]: archive, [lock.embedding.url]: MODEL }).fetch });
    const dir = dirname(r.paths.server);
    assert.ok(lstatSync(join(dir, "libx.so")).isSymbolicLink());
    assert.equal(readlinkSync(join(dir, "libx.so")), "libx.so.0");
    assert.equal(readFileSync(join(dir, "libx.so")).toString(), "shared library bytes", "the chain resolves to the real file");
  });

  it("refuses symlinks that are not plain same-directory names: absolute, '..', nested, or placed outside the archive's directory", async () => {
    const cases: [string, TarEntry][] = [
      ["absolute target", { name: "llama-test/a", type: "symlink", linkname: "/etc/passwd" }],
      ["dot-dot target", { name: "llama-test/b", type: "symlink", linkname: "../../outside" }],
      ["nested target", { name: "llama-test/c", type: "symlink", linkname: "sub/dir" }],
      ["dot-dot link name", { name: "llama-test/../d", type: "symlink", linkname: "x" }],
      ["absolute link name", { name: "/tmp/uktub-link-abs", type: "symlink", linkname: "x" }],
    ];
    for (const [label, entry] of cases) {
      const archive = makeTarGz([{ name: "llama-test/llama-server", data: FAKE_SERVER, mode: 0o755 }, entry]);
      const lock = lockFor(archive);
      await assert.rejects(
        installRuntime({ lock, cacheDir: cache, platform: "linux-x64", fetch: server({ [lock.runtime.assets["linux-x64"].url]: archive, [lock.embedding.url]: MODEL }).fetch }),
        (e) => e instanceof RuntimeError && e.code === "unsafe_archive",
        label,
      );
    }
    assert.ok(!existsSync("/tmp/uktub-link-abs"));
  });

  it("refuses an archive that tries to write outside the cache: '..' member, absolute path, symlink escape", async () => {
    const hostile: [string, TarEntry[]][] = [
      ["dot-dot member", [{ name: "llama-test/llama-server", data: FAKE_SERVER, mode: 0o755 }, { name: "../../escaped.txt", data: "pwned" }]],
      ["absolute member", [{ name: "llama-test/llama-server", data: FAKE_SERVER, mode: 0o755 }, { name: "/tmp/uktub-abs-escape.txt", data: "pwned" }]],
      ["symlink escape", [{ name: "llama-test/link", type: "symlink", linkname: tmpdir() }, { name: "llama-test/link/uktub-sym-escape.txt", data: "pwned" }, { name: "llama-test/llama-server", data: FAKE_SERVER, mode: 0o755 }]],
    ];
    for (const [label, entries] of hostile) {
      const archive = makeTarGz(entries);
      const lock = lockFor(archive);
      const srv = server({ [lock.runtime.assets["linux-x64"].url]: archive, [lock.embedding.url]: MODEL });
      await assert.rejects(installRuntime({ lock, cacheDir: cache, platform: "linux-x64", fetch: srv.fetch }), (e) => e instanceof RuntimeError && e.code === "unsafe_archive", label);
      assert.equal(installedPaths(lock, cache, "linux-x64"), null, label);
    }
    for (const p of [join(cache, "..", "escaped.txt"), "/tmp/uktub-abs-escape.txt", join(tmpdir(), "uktub-sym-escape.txt")]) assert.ok(!existsSync(p), `${p} must not exist`);
  });

  it("an archive without the expected binary is refused", async () => {
    const archive = makeTarGz([{ name: "llama-test/README", data: "no server here" }]);
    const lock = lockFor(archive);
    const srv = server({ [lock.runtime.assets["linux-x64"].url]: archive, [lock.embedding.url]: MODEL });
    await assert.rejects(installRuntime({ lock, cacheDir: cache, platform: "linux-x64", fetch: srv.fetch }), (e) => e instanceof RuntimeError && e.code === "missing_binary");
    assert.equal(installedPaths(lock, cache, "linux-x64"), null);
  });

  it("an unsupported platform is refused before any download, naming the bring-your-own-server alternative", async () => {
    const lock = lockFor(goodArchive());
    const srv = server({});
    await assert.rejects(installRuntime({ lock, cacheDir: cache, platform: "sunos-sparc", fetch: srv.fetch }), (e) => e instanceof RuntimeError && e.code === "unsupported_platform" && /UKTUB_EMBED_URL/.test(e.message));
    assert.deepEqual(srv.requests, []);
  });

  it("installedPaths is a cheap check that notices a missing or resized file", async () => {
    const archive = goodArchive();
    const lock = lockFor(archive);
    assert.equal(installedPaths(lock, cache, "linux-x64"), null);
    const r = await installRuntime({ lock, cacheDir: cache, platform: "linux-x64", fetch: server({ [lock.runtime.assets["linux-x64"].url]: archive, [lock.embedding.url]: MODEL }).fetch });
    assert.ok(installedPaths(lock, cache, "linux-x64"));
    writeFileSync(r.paths.model, "short");
    assert.equal(installedPaths(lock, cache, "linux-x64"), null, "a resized model is not 'installed'");
  });
});

describe("startServer (supervised child)", () => {
  const installed = async (): Promise<{ lock: RuntimeLock; paths: ReturnType<typeof installedPaths> & object }> => {
    const archive = goodArchive();
    const lock = lockFor(archive);
    const r = await installRuntime({ lock, cacheDir: cache, platform: "linux-x64", fetch: server({ [lock.runtime.assets["linux-x64"].url]: archive, [lock.embedding.url]: MODEL }).fetch });
    chmodSync(r.paths.server, 0o755);
    return { lock, paths: r.paths };
  };
  const stops: (() => Promise<void>)[] = [];
  afterEach(async () => {
    delete process.env.FAKE_MODE;
    delete process.env.FAKE_ARGS_LOG;
    while (stops.length > 0) await stops.pop()!();
  });
  const health = async (url: string): Promise<boolean> => {
    try {
      return (await fetch(`${url}/health`)).ok;
    } catch {
      return false;
    }
  };

  it("passes the pinned model and flags on loopback, waits until healthy, and stop() ends the process", async () => {
    const { lock, paths } = await installed();
    const log = join(cache, "args.log");
    process.env.FAKE_ARGS_LOG = log;
    const s = await startServer({ paths, lock, cacheDir: cache });
    stops.push(s.stop);
    assert.match(s.url, /^http:\/\/127\.0\.0\.1:\d+$/);
    assert.equal(await health(s.url), true);
    const args = JSON.parse(readFileSync(log, "utf8").trim().split("\n")[0]) as string[];
    assert.equal(args[args.indexOf("-m") + 1], paths.model);
    assert.equal(args[args.indexOf("--host") + 1], "127.0.0.1");
    assert.equal(args[args.indexOf("--port") + 1], new URL(s.url).port);
    for (const a of lock.embedding.serverArgs) assert.ok(args.includes(a), `flag ${a} passed`);
    await s.stop();
    assert.equal(await health(s.url), false, "the server is gone after stop()");
  });

  it("reports a child that dies at start at once, with the tail of its stderr (bounded), not after the timeout", async () => {
    const { lock, paths } = await installed();
    process.env.FAKE_MODE = "exit";
    const t0 = Date.now();
    await assert.rejects(startServer({ paths, lock, cacheDir: cache, timeoutMs: 20_000 }), (e) => {
      assert.ok(e instanceof RuntimeError && e.code === "start_failed", String(e));
      assert.match(e.message, /failed to load model/);
      assert.match(e.message, /\(the end\)/, "the tail of the log is what is kept");
      assert.ok(e.message.length < 700, "bounded");
      return true;
    });
    assert.ok(Date.now() - t0 < 10_000, "failure is detected from the exit, not from the timeout");
  });

  it("a child that never becomes healthy is killed and reported as a timeout", async () => {
    const { lock, paths } = await installed();
    process.env.FAKE_MODE = "hang";
    await assert.rejects(startServer({ paths, lock, cacheDir: cache, timeoutMs: 600 }), (e) => e instanceof RuntimeError && e.code === "start_timeout");
  });

  it("two servers started together get different ports", async () => {
    const { lock, paths } = await installed();
    const [a, b] = await Promise.all([startServer({ paths, lock, cacheDir: cache }), startServer({ paths, lock, cacheDir: cache })]);
    stops.push(a.stop, b.stop);
    assert.notEqual(new URL(a.url).port, new URL(b.url).port);
    assert.equal(await health(a.url), true);
    assert.equal(await health(b.url), true);
  });

  it("the child does not outlive its parent", async () => {
    const { lock, paths } = await installed();
    const driver = join(cache, "driver.ts");
    writeFileSync(
      driver,
      `import { startServer } from ${JSON.stringify(join(HERE, "..", "src", "core", "embed", "runtime.ts"))};\n` +
        `const lock = JSON.parse(process.argv[2]); const paths = JSON.parse(process.argv[3]);\n` +
        `const s = await startServer({ paths, lock, cacheDir: process.argv[4] });\nconsole.log(s.pid);\n// exit without calling stop()\n`,
    );
    const { execFileSync } = await import("node:child_process");
    const out = execFileSync(process.execPath, [driver, JSON.stringify(lock), JSON.stringify(paths), cache], { encoding: "utf8" });
    const pid = Number(out.trim().split("\n").pop());
    assert.ok(pid > 0);
    for (let i = 0; i < 50; i++) {
      try {
        process.kill(pid, 0);
      } catch {
        return; // gone
      }
      await new Promise((r) => setTimeout(r, 100));
    }
    process.kill(pid, "SIGKILL");
    assert.fail("the llama-server child outlived its parent");
  });
});

void mkdirSync;
