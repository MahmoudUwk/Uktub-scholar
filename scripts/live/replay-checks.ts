/**
 * Read-only Tier 1 replay for a recorded iteration.
 *
 *   node scripts/live/replay-checks.ts <run-dir>
 *
 * It reads the same files the experiment reads — the recorded project copy
 * (`evidence/project`), the deliverable registry and bibliography — reruns
 * the six Tier 1 checks plus the reported provenance counts, and prints the
 * verdicts as JSON. It never writes to the run dir: the provenance audit
 * runs on a copy under the OS temp dir (opening a registry migrates and
 * sweeps it), and the run dir itself is only read (mtimes included). No
 * tools, no network. A missing project or registry fails closed (a verdict
 * of `ok: false`), never a silent pass.
 */
import { chmodSync, cpSync, existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runProvenance } from "../../src/core/provenance/run.ts";
import {
  checkTierBibliography,
  checkTierCitations,
  checkTierFigures,
  checkTierPdfCurrent,
  checkTierPointers,
  checkTierProseVerifiedOrLabelled,
  readTierPaperTexts,
  resolveExpectedEntry,
  tierReport,
  type RegistryRecord,
  type TierProvenanceDoc,
} from "./deliverable-checks.ts";
import { walkFiles } from "./files.ts";

const runDir = process.argv[2];
if (runDir === undefined || runDir === "") {
  console.error("usage: replay-checks.ts <run-dir>");
  process.exit(2);
}

const read = (path: string): string | null => {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return null;
  }
};

/** Archive copies are read-only; the audit copy must be writable. */
const makeWritable = (dir: string): void => {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) {
      chmodSync(p, 0o755);
      makeWritable(p);
    } else {
      try {
        if (!e.isSymbolicLink()) chmodSync(p, 0o644);
      } catch {
        // a chmod failure surfaces as a failed check below, never a crash
      }
    }
  }
};

const projectDir = join(runDir, "evidence", "project");
const deliverDir = join(runDir, "deliverables");
if (!existsSync(projectDir)) {
  console.error(`no evidence/project in ${runDir}`);
  process.exit(2);
}

// The provenance audit opens the registry writable (migration + expiry
// sweep), so it runs on a temp copy; T1.3 mtimes are read from the run dir.
const scratch = mkdtempSync(join(tmpdir(), "uktub-replay-"));
const projCopy = join(scratch, "project");
try {
  cpSync(projectDir, projCopy, { recursive: true });
  void statSync(projCopy);
  makeWritable(projCopy);
} catch (err) {
  console.error(`cannot copy ${projectDir}: ${(err as Error).message}`);
  process.exit(2);
}

const outcome = runProvenance({ root: projCopy, now: () => new Date() });
const doc: TierProvenanceDoc | null = outcome.ok
  ? {
    entry: outcome.entry,
    summary: outcome.audit.summary,
    items: outcome.audit.items,
    document_digest: outcome.digest,
    units: outcome.audit.units.map((u) => ({
      id: u.unit.id,
      kind: u.unit.kind,
      file: u.unit.file,
      line: u.unit.line,
      section: u.unit.section,
      text: u.unit.plain,
      cites: u.unit.cites,
      status: u.status,
      pointers: u.ledger?.pointers ?? [],
    })),
  }
  : null;

const registryRaw = read(join(deliverDir, "registry.json"));
const records: RegistryRecord[] = registryRaw === null ? [] : (JSON.parse(registryRaw) as RegistryRecord[]);
const bibText = read(join(projectDir, "refs", "references.bib"));
let projectFiles: string[] = [];
try {
  projectFiles = walkFiles(projectDir);
} catch {
  projectFiles = [];
}
const papers = readTierPaperTexts(projectDir) ?? [];

const failClosed = (detail: string): { id: string; ok: boolean; detail: string }[] =>
  (["citations-in-registry", "bibliography-matches-registry", "compiled-after-last-edit", "pointers-resolve", "figures-supported", "prose-verified-or-labelled"] as const)
    .map((id) => ({ id, ok: false, detail }));

const tierChecks = doc === null
  ? failClosed(outcome.ok ? "unexpected" : `no provenance audit: ${(outcome as { ok: false; message: string }).message}`)
  : [
    checkTierCitations(doc, records),
    checkTierBibliography(doc, bibText, records),
    checkTierPdfCurrent(projectDir, resolveExpectedEntry(null, projectFiles)),
    checkTierPointers(doc, papers),
    checkTierFigures(doc),
    checkTierProseVerifiedOrLabelled(doc),
  ];

console.log(JSON.stringify({
  runDir,
  entry: doc?.entry ?? null,
  documentDigest: doc?.document_digest ?? null,
  tier1: tierChecks,
  report: doc === null ? null : tierReport(doc),
}, null, 2));

rmSync(scratch, { recursive: true, force: true });
