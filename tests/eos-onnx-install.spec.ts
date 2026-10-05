import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { RuntimeError } from "../src/core/embed/runtime.ts";
import { eosOnnxPaths, installedEosOnnx, readEosOnnxLock, validateEosOnnxLock, withManagedEosOnnx, type EosOnnxLock } from "../src/core/verify/eos-onnx.ts";
import { installEosOnnx, type Run } from "../src/core/verify/eos-onnx-install.ts";

const REV = "a".repeat(40);
const sha = (b: Buffer) => createHash("sha256").update(b).digest("hex");
const CONTENT: Record<string, Buffer> = {
  "config.json": Buffer.from('{"decision2":{"max_input_tokens":16384}}'),
  "tokenizer.json": Buffer.from("tokenizer bytes"),
  "onnx/model_quantized.onnx": Buffer.from("graph bytes"),
  "onnx/model_quantized.onnx_data": Buffer.from("weights bytes ".repeat(10)),
};
const WEIGHTS = "onnx/model_quantized.onnx_data";
const lockWith = (over: Partial<Record<string, Buffer>> = {}): EosOnnxLock =>
  validateEosOnnxLock({
    schema: 1,
    model: {
      id: "x/y",
      revision: REV,
      license: "apache-2.0",
      variant: "model_quantized",
      weights: WEIGHTS,
      files: Object.entries(CONTENT).map(([path, b]) => ({ path, url: `https://example.test/x/y/resolve/${REV}/${path}`, size: b.length, sha256: sha(over[path] ?? b) })),
    },
    python: { min: "3.10", cpu: ["onnxruntime==1.30.0", "numpy==2.5.3", "tokenizers==0.23.2"], gpu: ["onnxruntime-gpu==1.30.0", "numpy==2.5.3", "tokenizers==0.23.2"] },
  });
const serve = (): { fetch: typeof fetch; requests: string[] } => {
  const requests: string[] = [];
  const f = (async (url: string | URL | Request) => {
    const u = String(url);
    requests.push(u);
    const path = Object.keys(CONTENT).find((p) => u.endsWith(`/${REV}/${p}`));
    return path === undefined ? new Response("no", { status: 404 }) : new Response(CONTENT[path] as never, { status: 200, headers: { "content-length": String(CONTENT[path]?.length) } });
  }) as typeof fetch;
  return { fetch: f, requests };
};

let cache: string;
let calls: { file: string; args: string[] }[];
beforeEach(() => {
  cache = mkdtempSync(join(tmpdir(), "uktub-eoso-"));
  calls = [];
});
afterEach(() => rmSync(cache, { recursive: true, force: true }));

/** A runner that plays system python, venv creation, pip, and the worker's self-check. */
function runner(opts: { pyVersion?: string; pipFails?: boolean; ready?: Record<string, unknown>; countTokens?: number } = {}): Run {
  return async (file, args, o) => {
    calls.push({ file, args });
    const joined = args.join(" ");
    if (joined.includes("sys.version_info")) return { stdout: opts.pyVersion ?? "3.12", stderr: "", code: 0 };
    if (args[0] === "-m" && args[1] === "venv") {
      const venv = args[2] as string;
      const py = process.platform === "win32" ? join(venv, "Scripts", "python.exe") : join(venv, "bin", "python");
      mkdirSync(dirname(py), { recursive: true });
      writeFileSync(py, "#!/bin/sh\n");
      return { stdout: "", stderr: "", code: 0 };
    }
    if (args[0] === "-m" && args[1] === "pip") return opts.pipFails ? { stdout: "", stderr: "ERROR: no matching distribution for onnxruntime", code: 1 } : { stdout: "", stderr: "", code: 0 };
    if (args[0]?.endsWith("decision2_onnx.py")) {
      assert.ok(o?.input?.includes('"count"'), "the self-check sends a count row");
      const ready = { ready: true, model: "Decision-2.0-Eos-0.8B-ONNX", revision: o?.env?.UKTUB_DECISION2_REVISION, model_sha256: sha(CONTENT[WEIGHTS] as Buffer), ...opts.ready };
      return { stdout: `${JSON.stringify(ready)}\n${JSON.stringify({ tokens: opts.countTokens ?? 132, limit: 16384 })}\n`, stderr: "", code: 0 };
    }
    throw new Error(`unexpected command ${file} ${joined}`);
  };
}

describe("eos-onnx.lock.json", () => {
  it("is valid, pinned to a commit, and its pip pins are exact", () => {
    const lock = readEosOnnxLock();
    assert.match(lock.model.revision, /^[0-9a-f]{40}$/);
    assert.equal(lock.model.variant, "model_quantized", "the only variant that passed parity; q4f16 flipped 5 decisions at the bar");
    assert.ok(lock.model.files.every((f) => f.url.includes(lock.model.revision)));
    for (const spec of [...lock.python.cpu, ...lock.python.gpu]) assert.match(spec, /==/);
  });

  it("refuses a lock whose file URL is not pinned to the revision, or that points outside the model directory", () => {
    const good = JSON.parse(JSON.stringify(readEosOnnxLock()));
    good.model.files[0].url = "https://huggingface.co/x/y/resolve/main/config.json";
    assert.throws(() => validateEosOnnxLock(good), /pinned to the revision/);
    const trav = JSON.parse(JSON.stringify(readEosOnnxLock()));
    trav.model.files[0].path = "../escape";
    assert.throws(() => validateEosOnnxLock(trav), /unsafe file path/);
  });
});

describe("installEosOnnx", () => {
  it("downloads and verifies the files, builds the venv, pins pip exactly, self-checks the real worker, and commits", async () => {
    const lock = lockWith();
    const s = serve();
    const r = await installEosOnnx({ lock, cacheDir: cache, fetch: s.fetch, run: runner(), systemPython: "python3", gpu: false });
    assert.equal(r.downloaded, true);
    assert.equal(s.requests.length, 4);
    const have = installedEosOnnx(lock, cache);
    assert.ok(have !== null && existsSync(join(have.modelDir, WEIGHTS)));
    const pip = calls.find((c) => c.args[1] === "pip" && c.args[2] === "install");
    assert.ok(pip?.args.includes("--only-binary=:all:"), "wheels only: no compiling on a user's machine");
    for (const spec of lock.python.cpu) assert.ok(pip?.args.includes(spec), spec);
    assert.ok(!pip?.args.some((a) => a.startsWith("onnxruntime-gpu")));
  });

  it("--gpu installs the GPU pins instead", async () => {
    const lock = lockWith();
    await installEosOnnx({ lock, cacheDir: cache, fetch: serve().fetch, run: runner(), systemPython: "python3", gpu: true });
    assert.ok(calls.find((c) => c.args[1] === "pip" && c.args[2] === "install")?.args.includes("onnxruntime-gpu==1.30.0"));
  });

  it("is idempotent: a second run downloads and runs nothing", async () => {
    const lock = lockWith();
    await installEosOnnx({ lock, cacheDir: cache, fetch: serve().fetch, run: runner(), systemPython: "python3", gpu: false });
    const s = serve();
    calls.length = 0;
    const again = await installEosOnnx({ lock, cacheDir: cache, fetch: s.fetch, run: runner(), systemPython: "python3", gpu: false });
    assert.equal(again.downloaded, false);
    assert.equal(s.requests.length, 0);
    assert.equal(calls.length, 0);
  });

  it("switching builds (CPU then --gpu) redoes only pip and the self-check: no re-download, and the receipt records the build", async () => {
    const lock = lockWith();
    await installEosOnnx({ lock, cacheDir: cache, fetch: serve().fetch, run: runner(), systemPython: "python3", gpu: false });
    const s = serve();
    calls.length = 0;
    const r = await installEosOnnx({ lock, cacheDir: cache, fetch: s.fetch, run: runner(), systemPython: "python3", gpu: true });
    assert.equal(s.requests.length, 0, "the model files are kept");
    assert.equal(r.downloaded, false);
    const order = calls.filter((c) => c.args[1] === "pip").map((c) => c.args[2]);
    assert.deepEqual(order, ["uninstall", "install"], "the CPU package is removed first: onnxruntime and onnxruntime-gpu ship the same module and corrupt each other");
    assert.ok(calls.find((c) => c.args[2] === "uninstall")?.args.includes("onnxruntime"));
    assert.ok(calls.find((c) => c.args[2] === "install")?.args.includes("onnxruntime-gpu==1.30.0"));
    assert.ok(!calls.some((c) => c.args[1] === "venv"), "the environment is kept");
    assert.equal(JSON.parse(readFileSync(eosOnnxPaths(lock, cache).receipt, "utf8")).gpu, true);
    calls.length = 0;
    await installEosOnnx({ lock, cacheDir: cache, fetch: s.fetch, run: runner(), systemPython: "python3", gpu: true });
    assert.equal(calls.length, 0, "and the same build twice is a no-op");
  });

  it("refuses bytes that do not match the pinned digest and installs nothing", async () => {
    const lock = lockWith({ [WEIGHTS]: Buffer.from("different") });
    await assert.rejects(installEosOnnx({ lock, cacheDir: cache, fetch: serve().fetch, run: runner(), systemPython: "python3", gpu: false }), (e) => e instanceof RuntimeError && e.code === "checksum_mismatch");
    assert.equal(installedEosOnnx(lock, cache), null);
  });

  it("refuses a Python older than the minimum, before downloading anything", async () => {
    const s = serve();
    await assert.rejects(installEosOnnx({ lock: lockWith(), cacheDir: cache, fetch: s.fetch, run: runner({ pyVersion: "3.8" }), systemPython: "python3", gpu: false }), (e) => e instanceof RuntimeError && /3\.10/.test(e.message));
    assert.equal(s.requests.length, 0);
  });

  it("a failing pip is an install_failed refusal carrying pip's own message, with no receipt", async () => {
    const lock = lockWith();
    await assert.rejects(installEosOnnx({ lock, cacheDir: cache, fetch: serve().fetch, run: runner({ pipFails: true }), systemPython: "python3", gpu: false }), (e) => e instanceof RuntimeError && e.code === "install_failed" && /no matching distribution/.test(e.message));
    assert.equal(installedEosOnnx(lock, cache), null);
  });

  it("a worker that reports other weights, or cannot count tokens, is refused (the self-check)", async () => {
    const lock = lockWith();
    await assert.rejects(installEosOnnx({ lock, cacheDir: cache, fetch: serve().fetch, run: runner({ ready: { model_sha256: "0".repeat(64) } }), systemPython: "python3", gpu: false }), (e) => e instanceof RuntimeError && e.code === "start_failed");
    await assert.rejects(installEosOnnx({ lock, cacheDir: cache, fetch: serve().fetch, run: runner({ countTokens: 0 }), systemPython: "python3", gpu: false }), (e) => e instanceof RuntimeError && e.code === "start_failed");
    assert.equal(installedEosOnnx(lock, cache), null);
  });
});

describe("withManagedEosOnnx", () => {
  it("fills model dir and python from an installed copy, and never overrides the user's", async () => {
    const lock = readEosOnnxLock();
    const p = eosOnnxPaths(lock, cache);
    for (const f of lock.model.files) {
      mkdirSync(dirname(join(p.modelDir, f.path)), { recursive: true });
      writeFileSync(join(p.modelDir, f.path), "x");
    }
    mkdirSync(dirname(p.python), { recursive: true });
    writeFileSync(p.python, "#!/bin/sh\n");
    const weights = lock.model.files.find((f) => f.path === lock.model.weights);
    writeFileSync(p.receipt, JSON.stringify({ weights: weights?.sha256, revision: lock.model.revision }));
    const env = withManagedEosOnnx({ UKTUB_CACHE_DIR: cache });
    assert.equal(env.UKTUB_EOS_ONNX_DIR, p.modelDir);
    assert.equal(env.UKTUB_EOS_ONNX_PYTHON, p.python);
    assert.equal(withManagedEosOnnx({ UKTUB_CACHE_DIR: cache, UKTUB_EOS_ONNX_DIR: "/mine" }).UKTUB_EOS_ONNX_DIR, "/mine");
    assert.equal(withManagedEosOnnx({ UKTUB_CACHE_DIR: join(cache, "empty") }).UKTUB_EOS_ONNX_DIR, undefined);
  });
});
