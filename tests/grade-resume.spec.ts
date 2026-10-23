/**
 * Resume-harness repair (handoff 7.2): provider-specific grader preflight, A-only
 * adjudication, and analysis.ts --grading-dir. Executes the actual CLIs on minimal
 * frozen fixtures; no credentials, docker, gcloud or network (PATH is stripped to
 * the node binary, HOME is empty).
 */
import { afterEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";

import { graderDockerArgs, type GraderSandboxSpec } from "../scripts/live/sandbox.ts";

const REPO = resolve(import.meta.dirname, "..");
const GRADE = join(REPO, "scripts/live/grade.ts");
const ANALYSIS = join(REPO, "scripts/live/analysis.ts");
const RUBRIC_SHA = createHash("sha256").update(readFileSync(join(REPO, "experiments/harness/factcheck-rubric-v1.md"), "utf8")).digest("hex");
const GRADER_A = "opencode-go/muse-spark-1.3-contributor";
const NODE_DIR = dirname(process.execPath);
const DIGEST = "d".repeat(64);

interface FixtureUnit {
  id: string;
  cited: boolean;
  label: string;
  rationale?: string;
}

const unitJson = (id: string, cited: boolean): object => ({
  id, kind: "sentence", file: "manuscript/main.tex", line: 1, section: "", text: `Unit ${id}.`,
  cites: cited ? ["k1"] : [], cited,
});

const labelJson = (id: string, cited: boolean, label: string, rationale?: string): object =>
  label === "ungradeable"
    ? { id, label, rationale: rationale ?? "k1 is missing from the corpus" }
    : cited
      ? { id, label, location: "k1 p.1", excerpt: "words", rationale: rationale ?? "matches" }
      : { id, label, rationale: rationale ?? "generic" };

/** Scratch dirs made by these tests; removed after each test. */
const scratchDirs: string[] = [];
afterEach(() => {
  for (const d of scratchDirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

/** Minimal grading dir: notes/<id>/export/note.json + labels-A.json (no finals). */
function makeGradingDir(notes: Record<string, FixtureUnit[]>): string {
  const dir = mkdtempSync(join(tmpdir(), "uktub-resume-"));
  scratchDirs.push(dir);
  for (const [id, units] of Object.entries(notes)) {
    const exp = join(dir, "notes", id, "export");
    mkdirSync(exp, { recursive: true });
    writeFileSync(join(exp, "note.json"), JSON.stringify({
      note: id, document_digest: DIGEST, trap: "Trap sentence.", units: units.map((u) => unitJson(u.id, u.cited)),
    }));
    writeFileSync(join(dir, "notes", id, "labels-A.json"), JSON.stringify({
      note: id, document_digest: DIGEST, grader_model: GRADER_A, rubric_sha256: RUBRIC_SHA,
      trap_violated: false, units: units.map((u) => labelJson(u.id, u.cited, u.label, u.rationale)),
    }));
  }
  return dir;
}

function childEnv(dir: string): Record<string, string> {
  const env: Record<string, string> = { ...(process.env as Record<string, string>) };
  delete env.OPENCODE_API_KEY;
  delete env.GOOGLE_CLOUD_PROJECT;
  delete env.GOOGLE_APPLICATION_CREDENTIALS;
  const home = mkdtempSync(join(tmpdir(), "uktub-nohome-"));
  scratchDirs.push(home);
  env.HOME = home;
  env.PATH = NODE_DIR;
  env.UKTUB_GRADING_DIR = dir;
  return env;
}

function runGrade(dir: string, args: string[]): { status: number | null; out: string } {
  const r = spawnSync(process.execPath, [GRADE, ...args], { encoding: "utf8", env: childEnv(dir), cwd: REPO });
  return { status: r.status, out: `${r.stdout ?? ""}\n${r.stderr ?? ""}` };
}

function runAnalysis(dir: string, args: string[]): { status: number | null; out: string; json: unknown } {
  const r = spawnSync(process.execPath, [ANALYSIS, ...args], { encoding: "utf8", env: childEnv(dir), cwd: REPO });
  const out = `${r.stdout ?? ""}`;
  let json: unknown = null;
  try { json = JSON.parse(out.split("\n").find((l) => l.startsWith("{")) ?? "null"); } catch { json = null; }
  return { status: r.status, out: `${out}\n${r.stderr ?? ""}`, json };
}

const CLEAN: Record<string, FixtureUnit[]> = {
  aa000001: [
    { id: "u1", cited: true, label: "supported" },
    { id: "u2", cited: true, label: "supported" },
    { id: "u3", cited: false, label: "background" },
  ],
  bb000002: [
    { id: "u1", cited: true, label: "supported" },
    { id: "u2", cited: true, label: "ungradeable" },
    { id: "u3", cited: false, label: "specific" },
  ],
  cc000003: [
    { id: "u1", cited: true, label: "overstated" },
    { id: "u2", cited: false, label: "background" },
  ],
};

const citedUnits = (n: number, bad: number): FixtureUnit[] =>
  Array.from({ length: n }, (_, i) => ({ id: `u${i + 1}`, cited: true, label: i < bad ? "wrong" : "supported" }));

/** Adjudicate every listed note; fails the test on the first CLI failure. */
function adjudicateAll(dir: string, ids: string[]): void {
  for (const id of ids) assert.equal(runGrade(dir, ["adjudicate", id]).status, 0, id);
}

describe("grader preflight is provider-specific", () => {
  it("run --grader A fails on the missing Docker image, never mentioning ADC/gcloud", () => {
    // PATH holds only the node binary, so no docker client is reachable: the Muse
    // preflight must fail on its image check without ever touching Vertex auth.
    const dir = makeGradingDir(CLEAN);
    const { status, out } = runGrade(dir, ["run", "--grader", "A", "aa000001"]);
    assert.notEqual(status, 0);
    assert.ok(/sandbox image .* is missing/.test(out), out.slice(0, 500));
    assert.ok(!/ADC|gcloud|application-default|GOOGLE_APPLICATION_CREDENTIALS/i.test(out), out.slice(0, 500));
  });

  it("run --grader B is an OpenCode Go grader too: Docker image preflight, no ADC/gcloud", () => {
    // Grader B is MiniMax on OpenCode Go (owner decision 2026-10-19): no Vertex ADC anywhere in its preflight.
    const dir = makeGradingDir(CLEAN);
    const { status, out } = runGrade(dir, ["run", "--grader", "B", "aa000001"]);
    assert.notEqual(status, 0);
    assert.ok(/sandbox image .* is missing/.test(out), out.slice(0, 500));
    assert.ok(!/ADC|gcloud|application-default|GOOGLE_APPLICATION_CREDENTIALS/i.test(out), out.slice(0, 500));
  });
});

describe("adjudicate supports approved A-only completion", () => {
  it("finalizes locally with single-grader provenance, no key/docker/gcloud", () => {
    const dir = makeGradingDir(CLEAN);
    for (const id of Object.keys(CLEAN)) {
      const { status, out } = runGrade(dir, ["adjudicate", id]);
      assert.equal(status, 0, out.slice(0, 800));
      const fin = JSON.parse(readFileSync(join(dir, "notes", id, "adjudicated.json"), "utf8")) as {
        note: string; document_digest: string; adjudicator_model: string; trap_violated: boolean;
        units: Array<{ id: string; final: string; basis: string; a: string; b: string }>;
      };
      assert.equal(fin.note, id);
      assert.equal(fin.document_digest, DIGEST);
      assert.equal(fin.adjudicator_model, "single-grader");
      assert.equal(fin.trap_violated, false);
      assert.ok(fin.units.length > 0 && fin.units.every((u) => u.basis === "single-grader"), JSON.stringify(fin.units));
      const aUnits = JSON.parse(readFileSync(join(dir, "notes", id, "labels-A.json"), "utf8")) as {
        units: Array<{ id: string; label: string }>;
      };
      for (const u of aUnits.units) assert.equal(fin.units.find((f) => f.id === u.id)?.final, u.label);
    }
  });

  it("fails when labels-A.json is missing", () => {
    const dir = makeGradingDir(CLEAN);
    rmSync(join(dir, "notes", "aa000001", "labels-A.json"));
    const { status } = runGrade(dir, ["adjudicate", "aa000001"]);
    assert.notEqual(status, 0);
    assert.ok(!existsSync(join(dir, "notes", "aa000001", "adjudicated.json")));
  });

  it("fails when the note export is missing", () => {
    const dir = makeGradingDir(CLEAN);
    const { status } = runGrade(dir, ["adjudicate", "__no_such_note__"]);
    assert.notEqual(status, 0);
  });

  it("fails on a stale document digest", () => {
    const dir = makeGradingDir({ aa000001: CLEAN.aa000001! });
    const p = join(dir, "notes", "aa000001", "labels-A.json");
    const labels = JSON.parse(readFileSync(p, "utf8")) as Record<string, unknown>;
    writeFileSync(p, JSON.stringify({ ...labels, document_digest: "0".repeat(64) }));
    const { status } = runGrade(dir, ["adjudicate", "aa000001"]);
    assert.notEqual(status, 0);
    assert.ok(!existsSync(join(dir, "notes", "aa000001", "adjudicated.json")));
  });

  it("fails on an invalid label and on the wrong grader identity", () => {
    const badLabel = makeGradingDir({ aa000001: [{ id: "u1", cited: true, label: "background" }] });
    assert.notEqual(runGrade(badLabel, ["adjudicate", "aa000001"]).status, 0);
    const wrongModel = makeGradingDir(CLEAN);
    const p = join(wrongModel, "notes", "aa000001", "labels-A.json");
    const labels = JSON.parse(readFileSync(p, "utf8")) as Record<string, unknown>;
    writeFileSync(p, JSON.stringify({ ...labels, grader_model: "google-vertex/gemini-3.8-flash" }));
    assert.notEqual(runGrade(wrongModel, ["adjudicate", "aa000001"]).status, 0);
  });
});

describe("analysis --grading-dir", () => {
  it("passes a clean batch; exclusions stay out of the denominator", () => {
    const dir = makeGradingDir(CLEAN);
    adjudicateAll(dir, Object.keys(CLEAN));
    const { status, json } = runAnalysis(dir, ["--grading-dir", dir]);
    const s = json as Record<string, unknown>;
    assert.equal(status, 0, JSON.stringify(json).slice(0, 500));
    assert.equal(s.verdict, "PASS");
    const totals = s.totals as Record<string, number>;
    assert.equal(totals.bad, 0);
    assert.equal(totals.rows, 4);
    assert.equal(totals.ungradeable, 1);
    assert.equal(s.pooled, 0);
    assert.equal((s.notes as unknown[]).length, 3);
  });

  it("fails closed when a note has no final file, counting every note dir", () => {
    const dir = makeGradingDir(CLEAN);
    adjudicateAll(dir, ["aa000001", "bb000002"]);
    const { status, json } = runAnalysis(dir, ["--grading-dir", dir]);
    const s = json as Record<string, unknown>;
    assert.notEqual(status, 0);
    assert.equal(s.verdict, "FAIL");
    assert.equal((s.notes as unknown[]).length, 3);
  });

  it("a trap violation prevents PASS", () => {
    const dir = makeGradingDir(CLEAN);
    adjudicateAll(dir, Object.keys(CLEAN));
    // Flip the trap flag in the source labels, then re-finalize locally: the verdict
    // must fail on the trap gate, not on a stale-finals rejection.
    const p = join(dir, "notes", "aa000001", "labels-A.json");
    const labels = JSON.parse(readFileSync(p, "utf8")) as Record<string, unknown>;
    writeFileSync(p, JSON.stringify({ ...labels, trap_violated: true }));
    assert.equal(runGrade(dir, ["adjudicate", "aa000001"]).status, 0);
    const { status, json } = runAnalysis(dir, ["--grading-dir", dir]);
    assert.notEqual(status, 0);
    assert.equal((json as Record<string, unknown>).verdict, "FAIL");
    assert.ok(/trap/i.test(JSON.stringify(json)), JSON.stringify(json).slice(0, 300));
  });

  it("threshold failures: bad rate and CI upper bound", () => {
    const highBad = makeGradingDir({ nn000001: citedUnits(20, 3), nn000002: citedUnits(20, 0) });
    adjudicateAll(highBad, ["nn000001", "nn000002"]);
    const r1 = runAnalysis(highBad, ["--grading-dir", highBad]);
    assert.notEqual(r1.status, 0);
    assert.equal((r1.json as Record<string, unknown>).verdict, "FAIL");
    assert.ok(((r1.json as Record<string, unknown>).pooled as number) > 0.05);

    const wideCI = makeGradingDir({ nn000001: citedUnits(20, 1), nn000002: citedUnits(20, 0) });
    adjudicateAll(wideCI, ["nn000001", "nn000002"]);
    const r2 = runAnalysis(wideCI, ["--grading-dir", wideCI]);
    assert.notEqual(r2.status, 0);
    assert.equal((r2.json as Record<string, unknown>).verdict, "FAIL");
    const ci = (r2.json as Record<string, { upper: number }>).ci;
    assert.ok(ci.upper > 0.1, JSON.stringify(ci));
  });

  it("fails on stale finals: rubric, digest, model, units", () => {
    const stale = (mut: (f: Record<string, unknown>) => Record<string, unknown>): number => {
      const dir = makeGradingDir(CLEAN);
      adjudicateAll(dir, Object.keys(CLEAN));
      const p = join(dir, "notes", "aa000001", "adjudicated.json");
      writeFileSync(p, JSON.stringify(mut(JSON.parse(readFileSync(p, "utf8")) as Record<string, unknown>)));
      return runAnalysis(dir, ["--grading-dir", dir]).status ?? 0;
    };
    assert.notEqual(stale((f) => ({ ...f, rubric_sha256: "0".repeat(64) })), 0, "rubric");
    assert.notEqual(stale((f) => ({ ...f, document_digest: "0".repeat(64) })), 0, "digest");
    assert.notEqual(stale((f) => ({ ...f, adjudicator_model: "google-vertex/gemini-3.8-flash" })), 0, "model");
    assert.notEqual(stale((f) => ({ ...f, units: (f.units as unknown[]).slice(1) })), 0, "missing unit");
    assert.notEqual(stale((f) => ({ ...f, units: [...(f.units as unknown[]), (f.units as unknown[])[0]] })), 0, "duplicate unit");
  });

  it("fails when the export note id does not match its folder", () => {
    const dir = makeGradingDir(CLEAN);
    adjudicateAll(dir, Object.keys(CLEAN));
    const p = join(dir, "notes", "aa000001", "export/note.json");
    const note = JSON.parse(readFileSync(p, "utf8")) as Record<string, unknown>;
    writeFileSync(p, JSON.stringify({ ...note, note: "zz999999" }));
    const { status, json } = runAnalysis(dir, ["--grading-dir", dir]);
    assert.notEqual(status, 0);
    assert.equal((json as Record<string, unknown>).verdict, "FAIL");
  });

  it("fails when labels-A are missing after finalization", () => {
    const dir = makeGradingDir(CLEAN);
    adjudicateAll(dir, Object.keys(CLEAN));
    rmSync(join(dir, "notes", "aa000001", "labels-A.json"));
    const { status, json } = runAnalysis(dir, ["--grading-dir", dir]);
    assert.notEqual(status, 0);
    assert.equal((json as Record<string, unknown>).verdict, "FAIL");
  });

  it("fails when labels-A changed after finalization (regraded)", () => {
    const dir = makeGradingDir(CLEAN);
    adjudicateAll(dir, Object.keys(CLEAN));
    const p = join(dir, "notes", "aa000001", "labels-A.json");
    const labels = JSON.parse(readFileSync(p, "utf8")) as {
      units: Array<{ id: string; label: string; location?: string; excerpt?: string; rationale?: string }>;
    };
    const units = labels.units.map((u) => (u.id === "u1" ? { ...u, label: "wrong" } : u));
    writeFileSync(p, JSON.stringify({ ...labels, units }));
    const { status, json } = runAnalysis(dir, ["--grading-dir", dir]);
    assert.notEqual(status, 0);
    assert.equal((json as Record<string, unknown>).verdict, "FAIL");
  });

  it("fails when labels-A carry the wrong grader model", () => {
    const dir = makeGradingDir(CLEAN);
    adjudicateAll(dir, Object.keys(CLEAN));
    const p = join(dir, "notes", "aa000001", "labels-A.json");
    const labels = JSON.parse(readFileSync(p, "utf8")) as Record<string, unknown>;
    writeFileSync(p, JSON.stringify({ ...labels, grader_model: "google-vertex/gemini-3.8-flash" }));
    const { status, json } = runAnalysis(dir, ["--grading-dir", dir]);
    assert.notEqual(status, 0);
    assert.equal((json as Record<string, unknown>).verdict, "FAIL");
  });

  it("fails on tampered final labels and on changed trap metadata", () => {
    const tampered = makeGradingDir(CLEAN);
    adjudicateAll(tampered, Object.keys(CLEAN));
    const fp = join(tampered, "notes", "aa000001", "adjudicated.json");
    const fin = JSON.parse(readFileSync(fp, "utf8")) as {
      units: Array<{ id: string; final: string }>;
    };
    writeFileSync(fp, JSON.stringify({
      ...fin, units: fin.units.map((u) => (u.id === "u1" ? { ...u, final: "wrong" } : u)),
    }));
    assert.notEqual(runAnalysis(tampered, ["--grading-dir", tampered]).status, 0, "tampered final");

    const retrapped = makeGradingDir(CLEAN);
    adjudicateAll(retrapped, Object.keys(CLEAN));
    const np = join(retrapped, "notes", "aa000001", "export/note.json");
    const note = JSON.parse(readFileSync(np, "utf8")) as Record<string, unknown>;
    writeFileSync(np, JSON.stringify({ ...note, trap: "A different trap sentence." }));
    const r = runAnalysis(retrapped, ["--grading-dir", retrapped]);
    assert.notEqual(r.status, 0, "changed trap metadata");
    assert.equal((r.json as Record<string, unknown>).verdict, "FAIL");
  });

  it("fails with fewer than 2 usable notes or a zero denominator", () => {
    const solo = makeGradingDir({ aa000001: CLEAN.aa000001! });
    assert.equal(runGrade(solo, ["adjudicate", "aa000001"]).status, 0);
    assert.notEqual(runAnalysis(solo, ["--grading-dir", solo]).status, 0, "single usable note");
    const zero = makeGradingDir({
      nn000001: [{ id: "u1", cited: true, label: "ungradeable" }],
      nn000002: [{ id: "u1", cited: true, label: "ungradeable" }],
    });
    adjudicateAll(zero, ["nn000001", "nn000002"]);
    assert.notEqual(runAnalysis(zero, ["--grading-dir", zero]).status, 0, "zero denominator");
  });
});

describe("grader sandbox ADC is optional (Muse needs none)", () => {
  const base = (): GraderSandboxSpec => {
    const root = mkdtempSync(join(tmpdir(), "grader-adc-"));
    const dir = (n: string): string => {
      const p = join(root, n, randomBytes(4).toString("hex"));
      mkdirSync(p, { recursive: true });
      return p;
    };
    return {
      image: "uktub-scholar-sandbox", name: "uktub-grade-test",
      noteDir: dir("note"), corpusDir: dir("corpus"), outDir: dir("out"), agentDir: dir("agent"),
      env: {},
    };
  };

  it("omits the ADC mount and credential env without adcFile; keeps them with it", () => {
    const noAdc = graderDockerArgs(base(), ["pi", "--mode", "rpc"]);
    assert.ok(!noAdc.some((a) => a.includes("/adc/adc.json")), noAdc.join(" "));
    assert.ok(!noAdc.some((a) => a.includes("GOOGLE_APPLICATION_CREDENTIALS")), noAdc.join(" "));

    const withAdc = graderDockerArgs({ ...base(), adcFile: join(tmpdir(), "adc.json") }, ["pi"]);
    assert.ok(withAdc.some((a) => a.endsWith(":/adc/adc.json:ro")), withAdc.join(" "));
    assert.ok(withAdc.some((a) => a.includes("GOOGLE_APPLICATION_CREDENTIALS")), withAdc.join(" "));
  });
});
