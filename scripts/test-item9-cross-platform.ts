import { readFileSync, rmSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import assert from "node:assert/strict";
import { zipSync } from "fflate";

import { readLock, validateLock, installRuntime, installedPaths, type RuntimeLock } from "../src/core/embed/runtime.ts";
import { makeTarGz } from "../tests/helpers/tar.ts";

async function run() {
  console.log("=== ITEM 9: CROSS-PLATFORM VERIFICATION ===");

  const lock = readLock();
  console.log(`Lock file schema: ${lock.schema}, version: ${lock.runtime.version}`);

  const EXPECTED_PLATFORMS = [
    "linux-x64",
    "linux-arm64",
    "darwin-arm64",
    "darwin-x64",
    "win32-x64",
    "win32-arm64"
  ];

  console.log("\n--- Part A: Platform Asset Declarations ---");
  for (const plat of EXPECTED_PLATFORMS) {
    const asset = lock.runtime.assets[plat];
    assert.ok(asset !== undefined, `Platform ${plat} missing from lock`);
    assert.match(asset.sha256, /^[0-9a-f]{64}$/, `${plat} sha256 invalid`);
    assert.ok(asset.size > 10_000_000, `${plat} size suspiciously small (${asset.size})`);
    if (plat.startsWith("win32")) {
      assert.ok(asset.name.endsWith(".zip"), `${plat} must be a .zip archive`);
      assert.equal(asset.binary, "llama-server.exe", `${plat} binary must be llama-server.exe`);
      assert.equal(asset.dir, "", `${plat} dir must be empty string (root-level)`);
    } else {
      assert.ok(asset.name.endsWith(".tar.gz"), `${plat} must be a .tar.gz archive`);
      assert.equal(asset.binary, "llama-server", `${plat} binary must be llama-server`);
      assert.equal(asset.dir, "llama-b11398", `${plat} dir must be llama-b11398`);
    }
    console.log(`[PASS] ${plat}: ${asset.name} (${(asset.size / 1024 / 1024).toFixed(1)} MB, ${asset.binary})`);
  }

  console.log("\n--- Part B: Upstream Release Asset HTTP HEAD Verification ---");
  for (const plat of EXPECTED_PLATFORMS) {
    const asset = lock.runtime.assets[plat];
    const res = await fetch(asset.url, { method: "HEAD", redirect: "follow" });
    assert.equal(res.status, 200, `${plat} HEAD request failed with HTTP ${res.status}`);
    const cl = Number(res.headers.get("content-length"));
    assert.equal(cl, asset.size, `${plat} upstream content-length (${cl}) does not match pinned size (${asset.size})`);
    console.log(`[PASS] ${plat}: upstream HTTP 200, Content-Length exactly matches pinned ${asset.size} bytes.`);
  }

  console.log("\n--- Part C: Windows ZIP Extraction & Path Safety ---");
  const cacheDir = mkdtempSync(join(tmpdir(), "uktub-plat-"));
  const MODEL_BYTES = Buffer.from("model-bytes-dummy ".repeat(30));

  // Construct Windows-style zip archive
  const winZipData = zipSync({
    "llama-server.exe": new TextEncoder().encode("MZ WIN32 EXECUTABLE"),
    "ggml.dll": new TextEncoder().encode("GGML DLL"),
    "sub/extra.dll": new TextEncoder().encode("SUB DLL"),
  });

  const winLock: RuntimeLock = {
    schema: 1,
    runtime: {
      name: "llama.cpp",
      version: "btest",
      license: "MIT",
      assets: {
        "win32-x64": {
          name: "llama-test-win.zip",
          url: "https://example.test/llama-test-win.zip",
          sha256: (await import("node:crypto")).createHash("sha256").update(winZipData).digest("hex"),
          size: winZipData.length,
          dir: "",
          binary: "llama-server.exe",
        },
      },
    },
    embedding: {
      id: "test-embed",
      file: "model.gguf",
      url: "https://example.test/model.gguf",
      sha256: (await import("node:crypto")).createHash("sha256").update(MODEL_BYTES).digest("hex"),
      size: MODEL_BYTES.length,
      license: "gemma",
      terms: "https://ai.google.dev/gemma/terms",
      profile: "none",
      serverArgs: ["--embeddings"],
    },
  };

  const mockFetch = (async (url: string | URL | Request) => {
    const u = String(url);
    if (u.includes("zip")) return new Response(winZipData, { status: 200 });
    return new Response(MODEL_BYTES, { status: 200 });
  }) as typeof fetch;

  const installed = await installRuntime({
    lock: winLock,
    cacheDir,
    platform: "win32-x64",
    fetch: mockFetch,
  });

  assert.ok(installed.paths.server.endsWith("llama-server.exe"), "Server path must end with llama-server.exe");
  assert.equal(readFileSync(installed.paths.server, "utf8"), "MZ WIN32 EXECUTABLE");
  console.log(`[PASS] Windows ZIP archive extracted root-level llama-server.exe and DLLs successfully.`);

  // Test unsafe zip entry rejection
  const unsafeZips = [
    { name: "backslash", files: { "sub\\evil.exe": "x" } },
    { name: "parent-traversal", files: { "../evil.exe": "x" } },
    { name: "absolute-path", files: { "/evil.exe": "x" } },
    { name: "drive-letter", files: { "C:evil.exe": "x" } },
  ];

  for (const { name, files } of unsafeZips) {
    const badZip = zipSync(Object.fromEntries(Object.entries(files).map(([k, v]) => [k, new TextEncoder().encode(v)])));
    const badLock = {
      ...winLock,
      runtime: {
        ...winLock.runtime,
        assets: {
          "win32-x64": {
            ...winLock.runtime.assets["win32-x64"],
            sha256: (await import("node:crypto")).createHash("sha256").update(badZip).digest("hex"),
            size: badZip.length,
          }
        }
      }
    };
    const badFetch = (async (url: string | URL | Request) => {
      const u = String(url);
      if (u.includes("zip")) return new Response(badZip, { status: 200 });
      return new Response(MODEL_BYTES, { status: 200 });
    }) as typeof fetch;

    await assert.rejects(
      installRuntime({ lock: badLock, cacheDir, platform: "win32-x64", fetch: badFetch }),
      (err: any) => err.message.includes("refused") || err.message.includes("unsafe") || err.code === "unsafe_archive",
      `Expected refusal for unsafe zip entry: ${name}`
    );
  }
  console.log("[PASS] Unsafe zip entry names (backslashes, parent traversal, absolute paths, drive letters) correctly rejected.");

  rmSync(cacheDir, { recursive: true, force: true });
  console.log("\nALL ITEM 9 CROSS-PLATFORM TESTS COMPLETED SUCCESSFULLY!");
}

run().catch(err => {
  console.error("FATAL ERROR IN TEST:", err);
  process.exit(1);
});
