/**
 * Shared provenance helper: deterministic fingerprints and run-set validation
 * for the evolution controller. Offline; no providers, no docker, no network.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PROTOCOL_CHECK_IDS } from "../scripts/live/evolution.ts";
import {
  captureStagedProvenance, fingerprintFiles, sha256File, sha256Text, stagingSurfaceHashes, tarballHash, validateRunSet,
  type RunEvidence,
} from "../scripts/live/provenance.ts";

const sha = (s: string): string => createHash("sha256").update(s, "utf8").digest("hex");
const CHECKS = [...PROTOCOL_CHECK_IDS].map((id) => ({ id, ok: true, detail: "" }));

describe("provenance fingerprints", () => {
  it("hashes text and files deterministically and changes when bytes change", () => {
    const root = mkdtempSync(join(tmpdir(), "uktub-prov-"));
    try {
      writeFileSync(join(root, "a.txt"), "hello");
      assert.equal(sha256Text("hello"), sha("hello"));
      assert.equal(sha256File(join(root, "a.txt")), sha("hello"));
      assert.equal(sha256File(join(root, "missing.txt")), null);
      const before = fingerprintFiles(root, ["a.txt"]);
      writeFileSync(join(root, "a.txt"), "goodbye");
      assert.notEqual(fingerprintFiles(root, ["a.txt"]), before);
      assert.equal(fingerprintFiles(root, ["a.txt", "b.txt"]), fingerprintFiles(root, ["b.txt", "a.txt"]), "order-independent");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
  it("uses the real stage dir shape (stage/tar), not the consumer subdir", () => {
    const root = mkdtempSync(join(tmpdir(), "uktub-prov-"));
    const stage = mkdtempSync(join(tmpdir(), "uktub-stage-"));
    try {
      mkdirSync(join(stage, "tar"), { recursive: true });
      mkdirSync(join(stage, "consumer"), { recursive: true });
      writeFileSync(join(stage, "tar", "uktub-scholar-0.2.0.tgz"), "fake-tarball");
      writeFileSync(join(root, "notes.txt"), "not code");
      assert.equal(captureStagedProvenance(root, stage).packageHash, sha("fake-tarball"));
      assert.equal(captureStagedProvenance(root, join(stage, "consumer")).packageHash, null, "the tarball lives in stage/tar, not in the consumer subdir");
      assert.equal(tarballHash(mkdtempSync(join(tmpdir(), "uktub-empty-"))), null);
    } finally {
      rmSync(root, { recursive: true, force: true });
      rmSync(stage, { recursive: true, force: true });
    }
  });
  it("hashes every relevant untracked file with no size or count caps", () => {
    const root = mkdtempSync(join(tmpdir(), "uktub-prov-"));
    const stage = mkdtempSync(join(tmpdir(), "uktub-stage-"));
    try {
      spawnSync("git", ["init", "-q"], { cwd: root });
      mkdirSync(join(root, "src"), { recursive: true });
      writeFileSync(join(root, "src", "big.ts"), `x = "${"y".repeat(300 * 1024)}";\n`);
      for (let i = 0; i < 210; i++) writeFileSync(join(root, "src", `f${i}.ts`), `export const v${i} = ${i};\n`);
      const p = captureStagedProvenance(root, stage);
      assert.ok(p.untrackedSha256["src/big.ts"] !== undefined, "a 300KB code file is hashed, not skipped");
      assert.equal(Object.keys(p.untrackedSha256).length, 211, "all 211 code files are hashed, not capped at 200");
      assert.ok(!JSON.stringify(p).includes("y".repeat(64)), "hashes, never contents");
    } finally {
      rmSync(root, { recursive: true, force: true });
      rmSync(stage, { recursive: true, force: true });
    }
  });
  it("captures surface and protected content identity as hashes only", () => {
    const root = mkdtempSync(join(tmpdir(), "uktub-prov-"));
    const stage = mkdtempSync(join(tmpdir(), "uktub-stage-"));
    try {
      mkdirSync(join(root, "src/core"), { recursive: true });
      mkdirSync(join(root, "scripts/live"), { recursive: true });
      writeFileSync(join(root, "src/core/agent-rules.ts"), "export const R = 1;\n");
      writeFileSync(join(root, "scripts/live/behavior.ts"), "export const B = 1;\n");
      const p = captureStagedProvenance(root, stage);
      assert.match(p.surfaceHash, /^[0-9a-f]{64}$/);
      assert.match(p.protectedHash, /^[0-9a-f]{64}$/);
      assert.match(p.scopeHash, /^[0-9a-f]{64}$/);
      assert.ok(!JSON.stringify(p).includes("export const R"), "hashes, never bodies");
      const again = stagingSurfaceHashes(root);
      assert.equal(p.surfaceHash, again.surfaceHash);
      writeFileSync(join(root, "scripts/live/behavior.ts"), "export const B = 2;\n");
      assert.notEqual(stagingSurfaceHashes(root).protectedHash, p.protectedHash, "protected edits change the digest");
    } finally {
      rmSync(root, { recursive: true, force: true });
      rmSync(stage, { recursive: true, force: true });
    }
  });
  it("uses the same editable file set as snapshots when editable and protected globs overlap", () => {
    const root = mkdtempSync(join(tmpdir(), "uktub-prov-overlap-"));
    try {
      mkdirSync(join(root, "src/core"), { recursive: true });
      mkdirSync(join(root, "experiments/harness"), { recursive: true });
      writeFileSync(join(root, "src/core/editable.ts"), "editable\n");
      writeFileSync(join(root, "src/core/special.ts"), "protected\n");
      writeFileSync(join(root, "experiments/harness/manifest.yaml"), "components:\n  prompt:\n    - src/core/*.ts\nprotected:\n  - src/core/special.ts\n");
      assert.equal(stagingSurfaceHashes(root).surfaceHash, fingerprintFiles(root, ["src/core/editable.ts"]));
      assert.equal(stagingSurfaceHashes(root).protectedHash, fingerprintFiles(root, ["src/core/special.ts"]));
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("run-set validation for baseline/evaluate", () => {
  const root = mkdtempSync(join(tmpdir(), "uktub-prov-"));
  const scenarioText = "# Alpha\n\n## Prompt\n\nDo the thing.\n";
  const simText = "// simulator\n";
  const expText = "// experiment\n";
  const drvText = "// agent driver\n";
  mkdirSync(join(root, "experiments/scenarios"), { recursive: true });
  mkdirSync(join(root, "scripts/live"), { recursive: true });
  writeFileSync(join(root, "experiments/scenarios/alpha-scenario.md"), scenarioText);
  writeFileSync(join(root, "experiments/simulator.md"), simText);
  writeFileSync(join(root, "scripts/live/experiment.ts"), expText);
  writeFileSync(join(root, "scripts/live/agent.ts"), drvText);
  const surf = () => stagingSurfaceHashes(root);
  const manifest = (over: Record<string, unknown> = {}) => ({
    scenario: "alpha-scenario", iteration: 1,
    model: "google-vertex/gemini-3.8-flash (Vertex client, ADC; no fallback)",
    modelProfile: { agent: ["google-vertex/gemini-3.8-flash"], simulator: ["google-vertex/gemini-3.8-flash"] },
    commit: "c", workingTreeDiffSha256: "ab".repeat(32), packageHash: "p",
    surfaceHash: surf().surfaceHash, protectedHash: surf().protectedHash,
    image: "test-image", engineDevice: "test-engine",
    providerKeysPassed: [],
    scenarioSha256: sha(readFileSync(join(root, "experiments/scenarios/alpha-scenario.md"), "utf8")), simulatorSha256: sha(simText), experimentSha256: sha(expText), agentDriverSha256: sha(drvText),
    policy: { simulatedWindowTokens: null },
    ...over,
  });
  const ev = (ref: string, m: Record<string, unknown> | null, metrics: Record<string, unknown> = {}, raw?: string): RunEvidence => {
    const scenario = ref.split("/")[0] as string;
    const iteration = Number(ref.split("/")[1]?.replace("iter-", ""));
    const fullMetrics = { simulatedWindowTokens: null, scenario, iteration, checks: CHECKS, ...metrics };
    const rawText = raw ?? JSON.stringify(fullMetrics, null, 2);
    const withDigest = m === null ? null : { metricsSha256: sha(rawText), ...m };
    return {
      ref, scenario: ref.split("/")[0] as string, iteration: Number(ref.split("/")[1]?.replace("iter-", "")),
      metrics: fullMetrics, metricsRaw: rawText, manifest: withDigest,
    };
  };
  const policy = { evolve: ["alpha-scenario"], heldout: ["held-scenario"], ood: ["ood-scenario"], repo: root };
  it("accepts a consistent development set", () => {
    assert.deepEqual(validateRunSet([ev("alpha-scenario/iter-01", manifest()), ev("alpha-scenario/iter-02", { ...manifest(), iteration: 2 })], policy, "evaluate"), []);
  });
  it("refuses duplicate refs and held-out/OOD runs in development commands", () => {
    assert.match(validateRunSet([ev("alpha-scenario/iter-01", manifest()), ev("alpha-scenario/iter-01", manifest())], policy, "evaluate").join(";"), /duplicate/i);
    assert.match(validateRunSet([ev("held-scenario/iter-01", { ...manifest(), scenario: "held-scenario", scenarioSha256: "held" })], policy, "baseline").join(";"), /held-out/i);
    assert.match(validateRunSet([ev("alpha-scenario/iter-01", manifest())], { ...policy, evolve: ["other"] }, "evaluate").join(";"), /not an evolve scenario/);
  });
  it("refuses legacy runs without manifests and mismatched model, evaluator, window, key or package records", () => {
    assert.match(validateRunSet([ev("alpha-scenario/iter-01", null)], policy, "baseline").join(";"), /historical/);
    assert.match(validateRunSet([ev("alpha-scenario/iter-01", manifest({ modelProfile: { agent: ["other"], simulator: ["google-vertex/gemini-3.8-flash"] } }))], policy, "evaluate").join(";"), /model/);
    assert.match(validateRunSet([ev("alpha-scenario/iter-01", manifest()), ev("alpha-scenario/iter-02", { ...manifest(), iteration: 2, experimentSha256: "tampered" })], policy, "evaluate").join(";"), /evaluator/);
    assert.match(validateRunSet([ev("alpha-scenario/iter-01", manifest({ policy: { simulatedWindowTokens: 128000 } }))], policy, "evaluate").join(";"), /window/);
    assert.match(validateRunSet([ev("alpha-scenario/iter-01", manifest({ providerKeysPassed: ["BOGUS_KEY"] }))], policy, "evaluate").join(";"), /key names/);
    assert.match(validateRunSet([ev("alpha-scenario/iter-01", manifest({ SEMANTIC_SCHOLAR_API_KEY: "secret-value" }))], policy, "evaluate").join(";"), /never values/);
    assert.match(validateRunSet([ev("alpha-scenario/iter-01", manifest()), ev("alpha-scenario/iter-02", { ...manifest(), iteration: 2, packageHash: "other-pkg" })], policy, "evaluate").join(";"), /package/);
    assert.match(validateRunSet([ev("alpha-scenario/iter-01", manifest({ scenarioSha256: "wrong" }))], policy, "evaluate").join(";"), /evaluator/);
  });
  it("requires the fallback to be labelled when fallback turns are recorded", () => {
    const withFallback = ev("alpha-scenario/iter-01", manifest(), { fallbackTurns: { uktub: ["agent-2"], simulator: [] } });
    assert.match(validateRunSet([withFallback], policy, "evaluate").join(";"), /fallback/i);
  });
  it("refuses runs missing staged surface identity and surfaces that disagree across the set", () => {
    const { surfaceHash: _drop, ...noSurface } = manifest();
    assert.match(validateRunSet([ev("alpha-scenario/iter-01", noSurface as Record<string, unknown>)], policy, "evaluate").join(";"), /surfaceHash/);
    assert.match(validateRunSet([ev("alpha-scenario/iter-01", manifest()), ev("alpha-scenario/iter-02", { ...manifest(), iteration: 2, surfaceHash: "other-surface" })], policy, "evaluate").join(";"), /surface digest/);
  });
  it("requires the concrete protocol check set: legacy shorthand checks never pass by omission", () => {
    const legacy = ev("alpha-scenario/iter-01", manifest(), { checks: Array.from({ length: 9 }, (_, i) => ({ id: `c${i}`, ok: true })) });
    assert.match(validateRunSet([legacy], policy, "evaluate").join(";"), /protocol/);
  });
  it("requires the evidence-table check quad only for scenarios declaring that section, and rejects missing or unknown checks", () => {
    const path = join(root, "experiments/scenarios/alpha-scenario.md");
    const original = readFileSync(path, "utf8");
    try {
      writeFileSync(path, "# Alpha\n\n## Prompt\n\nDo the thing.\n\n## Evidence table\n\npath evidence/claims.json\n");
      const quad = [
        { id: "evidence-table-present", ok: true }, { id: "evidence-table-valid", ok: true },
        { id: "length-within-request", ok: true }, { id: "sourced-numerics", ok: true },
      ];
      const declared = ev("alpha-scenario/iter-01", manifest(), { checks: [...CHECKS, ...quad] });
      assert.deepEqual(validateRunSet([declared], { evolve: ["alpha-scenario"], heldout: [], ood: [], repo: root }, "baseline"), []);
      const missing = ev("alpha-scenario/iter-01", manifest(), { checks: CHECKS });
      assert.match(validateRunSet([missing], { evolve: ["alpha-scenario"], heldout: [], ood: [], repo: root }, "baseline").join(" "), /scenario protocol requires exactly/);
      const extra = ev("alpha-scenario/iter-01", manifest(), { checks: [...CHECKS, ...quad, { id: "invented-check", ok: true }] });
      assert.match(validateRunSet([extra], { evolve: ["alpha-scenario"], heldout: [], ood: [], repo: root }, "baseline").join(" "), /scenario protocol requires exactly/);
      const inconsistent = ev("alpha-scenario/iter-02", { ...manifest(), iteration: 2 }, { checks: [...CHECKS, quad[0]] });
      assert.match(validateRunSet([declared, inconsistent], { evolve: ["alpha-scenario"], heldout: [], ood: [], repo: root }, "baseline").join(" "), /scenario protocol requires exactly|check set differs/);
    } finally {
      writeFileSync(path, original);
    }
  });
  it("partitions different actual model profiles even when both mention the primary", () => {
    const a = ev("alpha-scenario/iter-01", manifest());
    const b = ev("alpha-scenario/iter-02", {
      ...manifest(),
      iteration: 2,
      modelProfile: { agent: ["google-vertex/gemini-3.8-flash", "google-vertex/gemini-3.5-flash-lite"], simulator: ["google-vertex/gemini-3.8-flash"] },
    }, { fallbackTurns: { uktub: ["agent-2"], simulator: [] } });
    assert.match(validateRunSet([a, b], policy, "evaluate").join(";"), /model profile/);
  });
  it("requires exact served profiles, not a substring of the manifest", () => {
    const evil = ev("alpha-scenario/iter-01", manifest({
      modelProfile: { agent: ["google-vertex/gemini-3.8-flash-evil"], simulator: ["google-vertex/gemini-3.8-flash"] },
    }));
    assert.match(validateRunSet([evil], policy, "evaluate").join(";"), /modelProfile|served/i);
  });
  it("refuses a fallback turn served on the fallback profile without a label", () => {
    const e = ev("alpha-scenario/iter-01", manifest({
      modelProfile: { agent: ["google-vertex/gemini-3.8-flash", "google-vertex/gemini-3.5-flash-lite"], simulator: ["google-vertex/gemini-3.8-flash"] },
    }));
    assert.match(validateRunSet([e], policy, "evaluate").join(";"), /fallback/i);
  });
  it("refuses a fallback id that is not exactly the allowed fallback", () => {
    const e = ev("alpha-scenario/iter-01", manifest({
      modelProfile: { agent: ["google-vertex/gemini-3.5-flash-lite-evil"], simulator: ["google-vertex/gemini-3.8-flash"] },
    }), { fallbackTurns: { uktub: ["agent-2"], simulator: [] } });
    assert.match(validateRunSet([e], policy, "evaluate").join(";"), /fallback|served/i);
  });
  it("refuses labelled fallback turns the served profile does not show", () => {
    const e = ev("alpha-scenario/iter-01", manifest({
      modelProfile: { agent: ["google-vertex/gemini-3.8-flash"], simulator: ["google-vertex/gemini-3.8-flash"] },
    }), { fallbackTurns: { uktub: ["agent-2"], simulator: [] } });
    assert.match(validateRunSet([e], policy, "evaluate").join(";"), /fallback/i);
  });
  it("refuses runs recorded before per-turn model profiles as historical", () => {
    const e = ev("alpha-scenario/iter-01", manifest());
    delete (e.manifest as Record<string, unknown>).modelProfile;
    assert.match(validateRunSet([e], policy, "evaluate").join(";"), /historical/);
  });
  it("fails closed when a referenced evaluator file is missing locally", () => {
    rmSync(join(root, "experiments/simulator.md"));
    try {
      assert.match(validateRunSet([ev("alpha-scenario/iter-01", manifest())], policy, "evaluate").join(";"), /missing locally/);
    } finally {
      writeFileSync(join(root, "experiments/simulator.md"), simText);
    }
  });
  it("refuses protected drift of the whole input set (e.g. behavior.ts), not only the four entrypoints", () => {
    const before = manifest();
    writeFileSync(join(root, "scripts/live/behavior.ts"), "// drifted\n");
    try {
      assert.match(validateRunSet([ev("alpha-scenario/iter-01", before)], policy, "evaluate").join(";"), /protected input set/);
    } finally {
      rmSync(join(root, "scripts/live/behavior.ts"), { force: true });
    }
  });
  it("refuses metrics replaced by favourable ones with the same check ids (metrics are bound to the manifest)", () => {
    const originalRaw = JSON.stringify({ simulatedWindowTokens: null, scenario: "alpha-scenario", iteration: 1, checks: CHECKS.map((c, i) => ({ ...c, ok: i < 7 })) }, null, 2);
    const tampered = ev("alpha-scenario/iter-01", manifest({ metricsSha256: sha(originalRaw) }), { checks: CHECKS });
    assert.match(validateRunSet([tampered], policy, "evaluate").join(";"), /metrics.*digest|digest.*metrics|do not match/i);
  });
  it("refuses manifests with no metrics digest as historical, never silently accepted", () => {
    const e = ev("alpha-scenario/iter-01", manifest());
    delete (e.manifest as Record<string, unknown>).metricsSha256;
    assert.match(validateRunSet([e], policy, "evaluate").join(";"), /historical/);
  });
  it("compares the metrics scenario/iteration with the manifest, not only the path", () => {
    const e = ev("alpha-scenario/iter-01", manifest(), { scenario: "alpha-scenario", iteration: 2 });
    assert.match(validateRunSet([e], policy, "evaluate").join(";"), /metrics.*manifest|manifest.*metrics/i);
  });
});

describe("large dirty diffs are hashed whole, never dropped", () => {
  it("the recorded hash equals the SHA-256 of the complete `git diff HEAD` output past 1.5 MB", () => {
    const repo = mkdtempSync(join(tmpdir(), "uktub-bigdiff-"));
    const stage = mkdtempSync(join(tmpdir(), "uktub-bigdiff-stage-"));
    try {
      spawnSync("git", ["init", "-q"], { cwd: repo });
      spawnSync("git", ["config", "user.email", "test@example.com"], { cwd: repo });
      spawnSync("git", ["config", "user.name", "test"], { cwd: repo });
      writeFileSync(join(repo, "seed.txt"), "seed\n");
      spawnSync("git", ["add", "seed.txt"], { cwd: repo });
      spawnSync("git", ["commit", "-qm", "seed"], { cwd: repo });
      writeFileSync(join(repo, "big.txt"), `${"dirty line of working-tree content\n".repeat(50000)}`); // ~1.7 MB of dirty diff
      spawnSync("git", ["add", "big.txt"], { cwd: repo }); // staged but uncommitted: still `git diff HEAD`, over the 1 MiB buffer
      const full = spawnSync("git", ["diff", "HEAD"], { cwd: repo, encoding: "buffer", maxBuffer: 64 * 1024 * 1024 });
      assert.equal(full.status, 0);
      assert.ok((full.stdout as Buffer).length > 1.5 * 1024 * 1024, `fixture diff is ${(full.stdout as Buffer).length} bytes, need > 1.5 MB`);
      const expected = createHash("sha256").update(full.stdout as Buffer).digest("hex");
      const p = captureStagedProvenance(repo, stage);
      assert.match(p.workingTreeDiffSha256 ?? "", /^[0-9a-f]{64}$/, "a large diff must hash whole, not record an empty string");
      assert.equal(p.workingTreeDiffSha256, expected);
    } finally {
      rmSync(repo, { recursive: true, force: true });
      rmSync(stage, { recursive: true, force: true });
    }
  });

  it("a diff that cannot be captured is an explicit null, never an empty string", () => {
    const repo = mkdtempSync(join(tmpdir(), "uktub-nogit-"));
    const stage = mkdtempSync(join(tmpdir(), "uktub-nogit-stage-"));
    try {
      const p = captureStagedProvenance(repo, stage);
      assert.equal(p.workingTreeDiffSha256, null);
    } finally {
      rmSync(repo, { recursive: true, force: true });
      rmSync(stage, { recursive: true, force: true });
    }
  });
});
