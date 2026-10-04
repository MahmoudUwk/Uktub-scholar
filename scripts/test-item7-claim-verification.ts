import { mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import assert from "node:assert/strict";

import { createRegistry, registerPaper } from "../src/core/registry.ts";
import { extractPdf } from "../src/core/source/extract.ts";
import { publishSource, resolvePointer } from "../src/core/verify/store.ts";
import { verifyClaimTool } from "../src/core/tools/verify.ts";
import { EXCERPT_MAX_CHARS } from "../src/core/verify/evidence.ts";
import { WriteQueue } from "../src/core/queue.ts";
import type { ToolContext } from "../src/core/tools/context.ts";

const CFG = {
  chunk_tokens: 512,
  overlap_tokens: 0,
  chars_per_token: 2.8,
  boundary: "section" as const,
};

interface Claim {
  id: string;
  paper: string;
  claim: string;
  label: "TRUE" | "FALSE";
  evidence: string;
  kind: string;
}

function pdfFor(paperId: string, pdfRoot: string): string {
  for (const d of readdirSync(pdfRoot, { withFileTypes: true })) {
    if (!d.isDirectory()) continue;
    for (const f of readdirSync(join(pdfRoot, d.name))) {
      if (f.endsWith(".pdf") && f.slice(0, -4).startsWith(paperId.slice(0, 38))) {
        return join(pdfRoot, d.name, f);
      }
    }
  }
  throw new Error(`no PDF for ${paperId}`);
}

async function run() {
  console.log("=== ITEM 7: CLAIM VERIFICATION WITH EOS ENGINE ===");

  const datasetPath = join(process.cwd(), "benchmarks", "datasets", "claim-verification-v1", "claims.json");
  const allClaims = JSON.parse(readFileSync(datasetPath, "utf8")).claims as Claim[];
  const trueClaims = allClaims.filter(c => c.label === "TRUE");
  const falseClaims = allClaims.filter(c => c.label === "FALSE");

  // Stratified sample: 40 TRUE, 30 FALSE claims distributed across papers
  const paperIds = [...new Set(allClaims.map(c => c.paper))].sort();
  const sampleTrue: Claim[] = [];
  const sampleFalse: Claim[] = [];

  for (const p of paperIds) {
    const pTrue = trueClaims.filter(c => c.paper === p);
    const pFalse = falseClaims.filter(c => c.paper === p);
    sampleTrue.push(...pTrue.slice(0, 3));
    sampleFalse.push(...pFalse.slice(0, 3));
  }
  // Pad to reach exactly 40 TRUE and 30 FALSE
  for (const c of trueClaims) {
    if (sampleTrue.length >= 40) break;
    if (!sampleTrue.some(x => x.id === c.id)) sampleTrue.push(c);
  }
  for (const c of falseClaims) {
    if (sampleFalse.length >= 30) break;
    if (!sampleFalse.some(x => x.id === c.id)) sampleFalse.push(c);
  }

  console.log(`Sampled ${sampleTrue.length} TRUE claims and ${sampleFalse.length} FALSE claims across ${paperIds.length} papers.`);

  const root = mkdtempSync(join(tmpdir(), "uktub-verify-test-"));
  mkdirSync(join(root, "config"), { recursive: true });
  writeFileSync(
    join(root, "config", "chunking.yaml"),
    `chunking:\n  chunk_tokens: 512\n  overlap_tokens: 0\n  chars_per_token: 2.8\n  boundary: section\nverification:\n  engine: eos\n  min_confidence: 0.99\n  workers: 4\n  max_judgments: 120\n`
  );

  const db = createRegistry(root);
  const pdfRoot = join(process.cwd(), "..", "test_papers");
  const paperToDoi = new Map<string, string>();

  console.log("Registering papers and publishing sources...");
  for (const [i, p] of paperIds.entries()) {
    const doi = `10.9999/paper-${String(i + 1).padStart(2, "0")}`;
    paperToDoi.set(p, doi);
    const pdfPath = pdfFor(p, pdfRoot);
    const bytes = readFileSync(pdfPath);
    const ext = await extractPdf(bytes);
    registerPaper(db, { doi, title: p, authors: ["Author"], year: 2026 });
    publishSource(db, doi, {
      kind: "local-file",
      ref: pdfPath.split("/").pop()!,
      license: null,
      digest: createHash("sha256").update(bytes).digest("hex"),
      extraction: ext.extraction,
      text: ext.text,
      pageStarts: ext.pageStarts,
      sections: ext.sections,
    }, CFG, new Date());
  }

  const ctx: ToolContext = {
    root,
    fetch,
    env: {
      UKTUB_CACHE_DIR: join(root, ".cache"),
      UKTUB_EOS_PYTHON: "/home/mahmoud/.cache/uktub-bench/decision2/venv/bin/python",
      UKTUB_EOS_MODEL: "/home/mahmoud/.cache/uktub-bench/decision2/models/eos",
      UKTUB_EOS_REVISION: "3594047d69f476f1d01cf84c593e213fc3a4dfe0",
    },
    now: () => new Date(),
    queue: new WriteQueue(),
  };

  console.log("\n--- Part A: Verifying 40 TRUE claims ---");
  let truePositives = 0;
  let falseNegatives = 0;
  const inspectedExcerpts: any[] = [];
  const allVerifiedPointers: string[] = [];

  const tTrue0 = performance.now();
  for (const [idx, c] of sampleTrue.entries()) {
    const doi = paperToDoi.get(c.paper)!;
    const res = await verifyClaimTool(ctx, {
      claim: c.claim,
      papers: [doi],
    });
    assert.ok(res.structuredContent !== null, `Claim ${c.id} failed with error: ${res.content[0]?.text}`);
    const out = res.structuredContent;
    const found = out.result.supportFound;
    if (found) {
      truePositives++;
      for (const ev of out.evidence) {
        allVerifiedPointers.push(ev.pointer);
        // Excerpt assertions
        assert.ok(ev.excerpt.length <= EXCERPT_MAX_CHARS, `Excerpt exceeds cap: ${ev.excerpt.length} > ${EXCERPT_MAX_CHARS}`);
        const resolved = resolvePointer(db, ev.pointer);
        assert.equal(resolved.status, "current", `Pointer ${ev.pointer} does not resolve as current`);
        assert.equal(resolved.text, ev.excerpt, `Resolved pointer text does not match excerpt`);

        if (inspectedExcerpts.length < 30) {
          inspectedExcerpts.push({
            claimId: c.id,
            claim: c.claim,
            doi: ev.doi,
            pointer: ev.pointer,
            score: ev.judgment.score,
            excerpt: ev.excerpt.trim(),
          });
        }
      }
    } else {
      falseNegatives++;
    }
    if ((idx + 1) % 10 === 0) {
      console.log(`  Processed ${idx + 1}/40 TRUE claims (TP: ${truePositives}, FN: ${falseNegatives})...`);
    }
  }
  const trueDurationMs = performance.now() - tTrue0;
  console.log(`Finished 40 TRUE claims in ${(trueDurationMs / 1000).toFixed(1)}s (TP: ${truePositives}/40, Recall: ${(truePositives / 40 * 100).toFixed(1)}%).`);

  console.log("\n--- Part B: Verifying 30 FALSE claims ---");
  let trueNegatives = 0;
  let falsePositives = 0;

  const tFalse0 = performance.now();
  for (const [idx, c] of sampleFalse.entries()) {
    const doi = paperToDoi.get(c.paper)!;
    const res = await verifyClaimTool(ctx, {
      claim: c.claim,
      papers: [doi],
    });
    assert.ok(res.structuredContent !== null, `Claim ${c.id} failed with error: ${res.content[0]?.text}`);
    const out = res.structuredContent;
    const found = out.result.supportFound;
    if (found) {
      falsePositives++;
    } else {
      trueNegatives++;
    }
    if ((idx + 1) % 10 === 0) {
      console.log(`  Processed ${idx + 1}/30 FALSE claims (TN: ${trueNegatives}, FP: ${falsePositives})...`);
    }
  }
  const falseDurationMs = performance.now() - tFalse0;
  console.log(`Finished 30 FALSE claims in ${(falseDurationMs / 1000).toFixed(1)}s (TN: ${trueNegatives}/30, Precision: ${truePositives / (truePositives + falsePositives) * 100}%).`);

  console.log("\n--- Part C: Judgment Reuse Cache (0 cost on repeat) ---");
  const testClaim = sampleTrue[0];
  const testDoi = paperToDoi.get(testClaim.paper)!;
  const repeatT0 = performance.now();
  const repeatRes = await verifyClaimTool(ctx, {
    claim: testClaim.claim,
    papers: [testDoi],
  });
  const repeatMs = performance.now() - repeatT0;
  const repeatWork = repeatRes.structuredContent!.coverage.work;
  console.log(`Repeat verification completed in ${repeatMs.toFixed(1)}ms`);
  console.log(`Work accounting: checked=${repeatWork.checked}, fresh=${repeatWork.fresh}, cached=${repeatWork.cached}`);
  assert.equal(repeatWork.fresh, 0, "Expected 0 fresh judgments on repeat");
  assert.ok(repeatWork.cached > 0, "Expected cached judgments to be reused");
  console.log("[PASS] Judgment cache reused 100% with 0 engine calls.");

  console.log("\n--- Part D: Source Change -> Stale Pointers ---");
  // Publish a new revision for the paper
  const oldPointer = allVerifiedPointers[0];
  assert.ok(oldPointer !== undefined, "Must have at least one verified pointer");
  console.log(`Testing pointer stale resolution for ${oldPointer}...`);
  const initialResolve = resolvePointer(db, oldPointer);
  assert.equal(initialResolve.status, "current");

  // Overwrite the paper's source with modified text
  const targetDoi = oldPointer.split("@")[0];
  publishSource(db, targetDoi, {
    kind: "local-file",
    ref: "modified.pdf",
    license: null,
    digest: "abcdef1234567890".repeat(4),
    extraction: "unpdf@1.8.1/pages-v1",
    text: "Completely new modified source text that replaces the previous revision entirely.",
    pageStarts: [0],
    sections: [],
  }, CFG, new Date());

  const staleResolve = resolvePointer(db, oldPointer);
  console.log(`Pointer resolution after source change: status = "${staleResolve.status}"`);
  assert.equal(staleResolve.status, "stale", "Pointer must resolve as stale after source modification");
  console.log("[PASS] Stale pointer handling confirmed.");

  console.log("\n--- Part E: Manual Inspection of 30 Excerpts ---");
  console.log(`Inspected ${inspectedExcerpts.length} verbatim excerpts:`);
  for (const [i, ex] of inspectedExcerpts.entries()) {
    console.log(`[Excerpt ${i + 1}] Claim ${ex.claimId}: "${ex.claim.slice(0, 70)}..."`);
    console.log(`  Paper: ${ex.doi} | Score: ${ex.score.toFixed(4)} | Ptr: ${ex.pointer}`);
    console.log(`  Text (${ex.excerpt.length} chars): "${ex.excerpt.slice(0, 120).replace(/\n/g, " ")}..."`);
    assert.ok(ex.excerpt.length <= EXCERPT_MAX_CHARS, "Must not exceed excerpt cap");
  }

  // Cleanup
  db.close();
  rmSync(root, { recursive: true, force: true });
  console.log("\nALL ITEM 7 CLAIM VERIFICATION TESTS COMPLETED SUCCESSFULLY!");
}

run().catch(err => {
  console.error("FATAL ERROR IN TEST:", err);
  process.exit(1);
});
