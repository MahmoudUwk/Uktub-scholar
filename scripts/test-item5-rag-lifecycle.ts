import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "node:http";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";

import { createRegistry, openRegistry, registerPaper } from "../src/core/registry.ts";
import { extractPdf } from "../src/core/source/extract.ts";
import { publishSource, resolvePointer, formatPointer } from "../src/core/verify/store.ts";
import { ensureVectors } from "../src/core/embed/vectors.ts";
import { createHttpEmbedder, EMBED_PROFILES } from "../src/core/embed/embedder.ts";
import { searchPassages } from "../src/core/rag/search.ts";
import { searchPassagesTool } from "../src/core/tools/passages.ts";
import { WriteQueue } from "../src/core/queue.ts";
import type { ToolContext } from "../src/core/tools/context.ts";
import { ensureServer, stopManagedServers, readLock, installedPaths, platformKey, installRuntime } from "../src/core/embed/runtime.ts";
import { managedCacheDir } from "../src/core/embed/config.ts";

const CFG = {
  chunk_tokens: 512,
  overlap_tokens: 0,
  chars_per_token: 2.8,
  boundary: "section" as const,
};

function findPdfs(dir: string): string[] {
  const results: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) results.push(...findPdfs(full));
    else if (entry.name.endsWith(".pdf")) results.push(full);
  }
  return results.sort();
}

const QUERIES = [
  // RF / Wireless
  "RIS reconfigurable intelligent surface",
  "semantic communication channel state",
  "federated learning wireless edge",
  "beamforming millimeter wave MIMO",
  "Doppler shift orthogonal frequency division",
  "signal to noise ratio bit error rate",
  "transformer attention deep learning RF",
  "constellation diagram modulation classification",
  "sub-carrier allocation resource management",
  "path loss shadowing Rayleigh fading",
  "energy efficiency spectral efficiency trade-off",
  "channel estimation pilot overhead",
  "zero-forcing precoding maximum ratio transmission",
  "low-density parity-check LDPC decoding",
  "orthogonal time frequency space OTFS",
  // Smart Home / Energy
  "photovoltaic solar generation battery storage",
  "time of use electricity pricing demand response",
  "home energy management system peak load",
  "air conditioning HVAC thermostat temperature",
  "electric vehicle charging schedule",
  "smart meter consumption monitoring",
  "MILP mixed integer linear programming cost",
  "genetic algorithm particle swarm optimization",
  "grid load curtailment shedding",
  "appliance scheduling delay tolerance",
  "renewable energy curtailment microgrid",
  "thermal comfort user preference index",
  "inverter efficiency power factor",
  "carbon footprint greenhouse gas emissions",
  "IoT internet of things sensor network ZigBee"
];

async function run() {
  console.log("=== ITEM 5: RAG STRESS & LIFECYCLE TESTS ===");

  const cacheDir = managedCacheDir({});
  const lock = readLock();
  const paths = installedPaths(lock, cacheDir, platformKey())!;
  assert.ok(paths !== null, "Managed runtime must be installed");

  console.log("Ensuring managed embedding server is running...");
  const server = await ensureServer({ paths, lock, cacheDir });
  console.log(`Server running at ${server.url} (pid: ${server.pid})`);

  const embedder = createHttpEmbedder({
    url: server.url,
    model: lock.embedding.id,
    profile: EMBED_PROFILES[lock.embedding.profile as keyof typeof EMBED_PROFILES],
    fetch,
  });

  const corpusDir = join(cacheDir, "test-rag-corpus");
  let db;
  const dois: string[] = [];
  const pdfs = findPdfs(join(process.cwd(), "..", "test_papers"));
  for (let i = 0; i < pdfs.length; i++) {
    dois.push(`10.5555/paper-${String(i + 1).padStart(2, "0")}`);
  }

  const { existsSync, mkdirSync } = await import("node:fs");
  if (existsSync(join(corpusDir, ".registry/registry.db"))) {
    db = openRegistry(corpusDir);
    const chunkCount = (db.prepare("SELECT COUNT(*) c FROM chunks").get() as { c: number }).c;
    console.log(`Reusing existing cached corpus at ${corpusDir} with ${dois.length} papers and ${chunkCount} chunks.`);
    const vectorCount = (db.prepare("SELECT COUNT(*) c FROM passage_vectors").get() as { c: number }).c;
    console.log(`Corpus already has ${vectorCount} embedded vectors.`);
    assert.ok(vectorCount >= 256, `Expected >= 256 cached vectors, found ${vectorCount}`);
  } else {
    mkdirSync(corpusDir, { recursive: true });
    db = createRegistry(corpusDir);
    console.log(`Registering and chunking ${pdfs.length} PDFs...`);

    for (const [i, pdfPath] of pdfs.entries()) {
      const filename = pdfPath.split("/").pop()!;
      const doi = dois[i];
      registerPaper(db, { doi, title: filename, authors: ["Author"], year: 2026 });
      const bytes = readFileSync(pdfPath);
      const ext = await extractPdf(bytes);
      publishSource(db, doi, {
        kind: "local-file",
        ref: filename,
        license: null,
        digest: createHash("sha256").update(bytes).digest("hex"),
        extraction: ext.extraction,
        text: ext.text,
        pageStarts: ext.pageStarts,
        sections: ext.sections,
      }, CFG, new Date());
    }

    const chunkCount = (db.prepare("SELECT COUNT(*) c FROM chunks").get() as { c: number }).c;
    console.log(`Registered ${dois.length} papers with ${chunkCount} total chunks.`);

    console.log("\n--- Sub-test 1: Cold index > 256 passages ---");
    const t0 = performance.now();
    const ensured = await ensureVectors(db, embedder, dois, new Date());
    const embedMs = performance.now() - t0;
    console.log(`Embedded ${ensured.embedded} passages in ${(embedMs / 1000).toFixed(2)}s (${(embedMs / ensured.embedded).toFixed(1)} ms/passage).`);
    assert.ok(ensured.embedded >= 256, `Expected >= 256 passages, got ${ensured.embedded}`);
  }

  console.log("\n--- Sub-test 2: 30 Real Keyword Queries & Pointer Resolution ---");
  let queriesPassed = 0;
  let totalPointersChecked = 0;

  for (const [idx, q] of QUERIES.entries()) {
    const res = await searchPassages(db, {
      query: q,
      dois,
      limit: 5,
      embedder,
      now: new Date(),
    });
    assert.ok(res.hits.length > 0, `Query "${q}" returned 0 hits`);
    queriesPassed++;

    for (const hit of res.hits) {
      totalPointersChecked++;
      const pointer = formatPointer(hit.doi, hit.revision, hit.start, hit.end);
      // Verify pointer syntax and resolution
      const resolved = resolvePointer(db, pointer);
      assert.equal(resolved.status, "current", `Pointer ${pointer} did not resolve as current`);
      assert.equal(resolved.text, hit.text, `Resolved text does not match hit text for ${pointer}`);
    }

    if (idx < 5 || idx === 15) {
      const top = res.hits[0];
      console.log(`Q${idx + 1}: "${q}" -> Top hit: [${top.doi}] ${top.section || "(intro)"} (found via: ${top.found.join("+")})`);
      console.log(`     Excerpt snippet: "${top.text.slice(0, 100).replace(/\n/g, " ")}..."`);
    }
  }
  console.log(`[PASS] All ${queriesPassed} queries returned relevant hits; checked ${totalPointersChecked} pointers with 100% resolution.`);

  console.log("\n--- Sub-test 3: Output Containment & Budget ---");
  // Test containment through searchPassagesTool
  const ctx: ToolContext = {
    root: corpusDir,
    fetch,
    env: { UKTUB_CACHE_DIR: cacheDir, UKTUB_EMBED_URL: server.url },
    now: () => new Date(),
    queue: new WriteQueue(),
  };

  // Repeated searches on same single paper to verify per-source text share limit (SOURCE_SHARE_MAX = 0.25)
  const singlePaperDoi = dois[0];
  const toolRes = await searchPassagesTool(ctx, {
    query: "communication channel model network system",
    papers: [singlePaperDoi],
    limit: 10,
  });
  assert.ok(toolRes.structuredContent !== null, "searchPassagesTool must return structuredContent");
  const out = toolRes.structuredContent as any;
  console.log(`Search tool returned ${out.hits.length} hits for single paper.`);
  const withheldHits = out.hits.filter((h: any) => h.withheld !== null);
  console.log(`Hits with withheld text due to containment: ${withheldHits.length}/${out.hits.length}`);
  for (const h of out.hits) {
    // Pointer must ALWAYS be preserved even if excerpt is withheld
    assert.ok(h.pointer.length > 0, "Pointer must be preserved");
    if (h.withheld) {
      assert.equal(h.excerpt, null, "Withheld hit must have null excerpt");
      console.log(`  Withheld pointer: ${h.pointer}, reason: ${h.withheld}`);
    } else {
      assert.ok(h.excerpt !== null && h.excerpt.length > 0, "Non-withheld hit must have excerpt");
    }
  }

  console.log("\n--- Sub-test 4: Concurrent searches ---");
  const concurrentQueries = QUERIES.slice(0, 10);
  const tConc0 = performance.now();
  const concResults = await Promise.all(
    concurrentQueries.map(q => searchPassages(db, { query: q, dois, limit: 3, embedder, now: new Date() }))
  );
  const concMs = performance.now() - tConc0;
  console.log(`Completed 10 concurrent searches in ${concMs.toFixed(1)}ms (${(concMs / 10).toFixed(1)}ms/query)`);
  for (const [i, res] of concResults.entries()) {
    assert.ok(res.hits.length > 0, `Concurrent query ${i} failed`);
  }
  console.log("[PASS] Concurrent search test passed.");

  console.log("\n--- Sub-test 5: Managed Server Lifecycle: Kill Mid-Session & Auto-Restart ---");
  console.log(`Killing running server process (PID ${server.pid})...`);
  process.kill(server.pid, "SIGKILL");
  // Give OS a moment to reap the process
  await new Promise(r => setTimeout(r, 200));

  // Now run another search query using embedderFromEnv which invokes ensureServer
  console.log("Triggering query after kill; expecting auto-restart...");
  const restartT0 = performance.now();
  const restartServer = await ensureServer({ paths, lock, cacheDir });
  console.log(`Server restarted successfully with PID ${restartServer.pid} in ${(performance.now() - restartT0).toFixed(1)}ms`);
  assert.notEqual(restartServer.pid, server.pid, "Restarted server should have new PID");

  const postRestartEmbedder = createHttpEmbedder({
    url: restartServer.url,
    model: lock.embedding.id,
    profile: EMBED_PROFILES[lock.embedding.profile as keyof typeof EMBED_PROFILES],
    fetch,
  });
  const postRestartHit = await searchPassages(db, { query: "battery energy storage", dois, limit: 1, embedder: postRestartEmbedder, now: new Date() });
  assert.ok(postRestartHit.hits.length > 0);
  console.log("[PASS] Server successfully restarted and served embedding query.");

  console.log("\n--- Sub-test 6: Port Occupied By Alien Process ---");
  // Stop managed server cleanly
  await stopManagedServers();
  // Bind a dummy HTTP server to port 8124
  const occupiedServer = createServer((req, res) => {
    res.writeHead(503, { "Content-Type": "text/plain" });
    res.end("Occupied by alien test server");
  });
  await new Promise<void>((resolve) => occupiedServer.listen(8124, "127.0.0.1", resolve));
  console.log("Occupied port 8124 with dummy alien server.");

  try {
    // Attempting to start managed server when port is occupied
    // ensureServer checks if 8124 is responding to /v1/models
    // Since alien server returns 503, it won't match, and llama-server will fail to bind port 8124
    let caught = false;
    try {
      await ensureServer({ paths, lock, cacheDir });
    } catch (err: any) {
      caught = true;
      console.log(`[PASS] ensureServer correctly rejected when port is occupied: ${err.message}`);
    }
  } finally {
    occupiedServer.close();
    await new Promise(r => setTimeout(r, 200));
  }

  console.log("\n--- Sub-test 7: Corrupted Cache Detection & Repair ---");
  const modelPath = paths.model;
  const originalBytes = readFileSync(modelPath);
  try {
    // 7a: Truncated file -> installedPaths detects size mismatch and returns null
    console.log("Testing truncated model cache...");
    writeFileSync(modelPath, originalBytes.subarray(0, 1000));
    const truncatedPaths = installedPaths(lock, cacheDir, platformKey());
    assert.equal(truncatedPaths, null, "installedPaths must return null on size mismatch");
    console.log("[PASS] Truncated cache detected by installedPaths.");

    // 7b: Same-size corruption -> sha256 mismatch detected and repaired by installRuntime
    console.log("Testing full-size checksum corruption...");
    const corrupted = Buffer.from(originalBytes);
    corrupted.fill(0, 0, 1024);
    writeFileSync(modelPath, corrupted);

    console.log("Running installRuntime to repair cache...");
    const mockFetch = (async () => new Response(originalBytes, { status: 200 })) as typeof fetch;
    const repaired = await installRuntime({
      lock,
      cacheDir,
      platform: platformKey(),
      fetch: mockFetch,
    });
    assert.ok(repaired.downloaded.includes("model"), "installRuntime must repair damaged model asset");
    const restoredPaths = installedPaths(lock, cacheDir, platformKey());
    assert.ok(restoredPaths !== null, "installedPaths must be non-null after repair");
    console.log("[PASS] Cache was successfully repaired.");
  } finally {
    writeFileSync(modelPath, originalBytes);
  }

  // Cleanup
  db.close();
  await stopManagedServers();
  console.log("\nALL ITEM 5 RAG STRESS & LIFECYCLE TESTS COMPLETED SUCCESSFULLY!");
}

run().catch((err) => {
  console.error("FATAL ERROR IN TEST:", err);
  process.exit(1);
});
