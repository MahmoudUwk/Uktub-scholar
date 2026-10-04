/**
 * The managed embedding server as the configured embedder (owner decision 2026-10-04). With no UKTUB_EMBED_URL, an
 * INSTALLED pinned runtime is started on demand as a resident child process and used; nothing is ever downloaded by a search
 * (installing is an explicit CLI step). Offline: the fake llama-server script stands in for the binary.
 */
import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { embedderFromEnv, managedCacheDir } from "../src/core/embed/config.ts";
import { EmbedError } from "../src/core/embed/embedder.ts";
import { installRuntime, stopManagedServers, type RuntimeLock } from "../src/core/embed/runtime.ts";
import { makeTarGz } from "./helpers/tar.ts";

const HERE = dirname(fileURLToPath(import.meta.url));
const FAKE_SERVER = readFileSync(join(HERE, "helpers", "fake-llama-server.mjs"));
const sha = (b: Uint8Array): string => createHash("sha256").update(b).digest("hex");
const MODEL = Buffer.from("tiny model bytes ".repeat(30));

function setup(): { lock: RuntimeLock; fetch: typeof fetch } {
  const archive = makeTarGz([{ name: "llama-test/llama-server", data: FAKE_SERVER, mode: 0o755 }]);
  const lock: RuntimeLock = {
    schema: 1,
    runtime: { name: "llama.cpp", version: "btest", license: "MIT", assets: { "linux-x64": { name: "llama-test.tar.gz", url: "https://example.test/rt.tar.gz", sha256: sha(archive), size: archive.length, dir: "llama-test", binary: "llama-server" } } },
    embedding: { id: "test-embed", file: "model.gguf", url: "https://example.test/m.gguf", sha256: sha(MODEL), size: MODEL.length, license: "gemma", terms: "https://ai.google.dev/gemma/terms", profile: "none", serverArgs: ["--embeddings", "--pooling", "mean"] },
  };
  const bodies: Record<string, Uint8Array> = { [lock.runtime.assets["linux-x64"].url]: archive, [lock.embedding.url]: MODEL };
  const f = (async (url: string | URL | Request) => new Response(Buffer.from(bodies[String(url)]) as unknown as ConstructorParameters<typeof Response>[0], { status: 200 })) as typeof fetch;
  return { lock, fetch: f };
}

let cache: string;
beforeEach(() => {
  cache = mkdtempSync(join(tmpdir(), "uktub-managed-"));
});
afterEach(async () => {
  delete process.env.FAKE_MODE;
  await stopManagedServers();
  rmSync(cache, { recursive: true, force: true });
});

const platform = "linux-x64";
const env = (extra: Record<string, string | undefined> = {}): Record<string, string | undefined> => ({ UKTUB_CACHE_DIR: cache, ...extra });
/** The host's real transport (loopback traffic to the managed child). */
const real = ((url: string, init?: RequestInit) => fetch(url, init)) as unknown as Parameters<typeof embedderFromEnv>[1];
const never = (async () => {
  throw new Error("no network in this test");
}) as unknown as Parameters<typeof embedderFromEnv>[1];

describe("managedCacheDir", () => {
  it("UKTUB_CACHE_DIR wins, then XDG_CACHE_HOME, then ~/.cache", () => {
    assert.equal(managedCacheDir({ UKTUB_CACHE_DIR: "/a", XDG_CACHE_HOME: "/b", HOME: "/c" }), "/a");
    assert.equal(managedCacheDir({ XDG_CACHE_HOME: "/b", HOME: "/c" }), "/b/uktub-scholar");
    assert.equal(managedCacheDir({ HOME: "/c" }), "/c/.cache/uktub-scholar");
  });
});

describe("embedderFromEnv — managed runtime", () => {
  it("nothing installed and no URL: no embedder, and nothing is downloaded", async () => {
    const { lock } = setup();
    assert.equal(await embedderFromEnv(env(), never, undefined, { lock, platform }), null);
  });

  it("an installed runtime is started on demand and embeds through the real HTTP path; the identity is the pinned model", async () => {
    const { lock, fetch: f } = setup();
    await installRuntime({ lock, cacheDir: cache, platform, fetch: f });
    const e = await embedderFromEnv(env(), real, undefined, { lock, platform });
    assert.ok(e !== null);
    assert.equal(e.id, `test-embed~${lock.embedding.sha256.slice(0, 12)}|none`);
    const [sunny, other] = await e.embedDocuments(["a solar panel", "a wind turbine"]);
    assert.ok(sunny[0] > other[0], "the fake server's vectors came back through the OpenAI-compatible path");
  });

  it("the server is resident: a second call reuses it, and a dead one is restarted", async () => {
    const { lock, fetch: f } = setup();
    await installRuntime({ lock, cacheDir: cache, platform, fetch: f });
    const a = await embedderFromEnv(env(), real, undefined, { lock, platform });
    const b = await embedderFromEnv(env(), real, undefined, { lock, platform });
    assert.ok(a && b);
    const ports = new Set<string>();
    const lockOf = (await import("../src/core/embed/runtime.ts")).residentServers;
    for (const s of lockOf().values()) ports.add(new URL(s.url).port);
    assert.equal(ports.size, 1, "one server for one cache");
    // kill it behind the package's back
    const [only] = [...lockOf().values()];
    process.kill(only.pid, "SIGKILL");
    await new Promise((r) => setTimeout(r, 300));
    const c = await embedderFromEnv(env(), real, undefined, { lock, platform });
    const [v] = await c!.embedDocuments(["solar"]);
    assert.ok(v.length > 0, "restarted and answering");
    assert.notEqual([...lockOf().values()][0].pid, only.pid);
  });

  it("an explicit UKTUB_EMBED_URL wins over an installed runtime (nothing is started)", async () => {
    const { lock, fetch: f } = setup();
    await installRuntime({ lock, cacheDir: cache, platform, fetch: f });
    const probe = (async () => new Response(JSON.stringify({ data: [{ id: "byo.gguf" }] }))) as unknown as Parameters<typeof embedderFromEnv>[1];
    const e = await embedderFromEnv(env({ UKTUB_EMBED_URL: "http://127.0.0.1:1" }), probe, undefined, { lock, platform });
    assert.match(e!.id, /byo\.gguf/);
    const residents = (await import("../src/core/embed/runtime.ts")).residentServers;
    assert.equal(residents().size, 0, "no managed server was started");
  });

  it("a runtime that cannot start is an EmbedError the search turns into a stated limitation, never a crash", async () => {
    const { lock, fetch: f } = setup();
    await installRuntime({ lock, cacheDir: cache, platform, fetch: f });
    process.env.FAKE_MODE = "exit";
    await assert.rejects(embedderFromEnv(env(), never, undefined, { lock, platform }), (err) => err instanceof EmbedError && /could not start/.test(err.message));
  });

  it("an unsupported platform with nothing installed is simply no embedder", async () => {
    const { lock } = setup();
    assert.equal(await embedderFromEnv(env(), never, undefined, { lock, platform: "sunos-sparc" }), null);
  });
});
