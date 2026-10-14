/**
 * Tier 1 differential: on copies of iter-04 … iter-20, T1.1–T1.3 equal the
 * old verdicts exactly, and every T1.5 vs `sourced-numerics` difference is
 * the listed one. Old verdicts were saved before the rewrite in
 * tests/fixtures/tier1-differential/old-verdicts.json (cites/bib recomputed
 * with the old functions, compiled/sourced recorded from metrics.json: the
 * old compile check needed live snapshots and the transcript is absent from
 * the archive). T1.5 differences with one-line explanations live in
 * t1.5-differences.json.
 *
 * The archive is never opened in place: each run's `evidence/project` is
 * copied to a temp dir (the audit migrates and sweeps the registry copy)
 * while T1.3 mtimes and T1.4 paper texts are read from the archive
 * read-only. No network, no models.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, cpSync, existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { runProvenance } from "../src/core/provenance/run.ts";
import {
  checkBibliography,
  checkCitationsInRegistry,
  checkTierBibliography,
  checkTierCitations,
  checkTierFigures,
  checkTierPdfCurrent,
  checkTierPointers,
  parseCitedKeys,
  provenanceCitedKeys,
  readTierPaperTexts,
  type RegistryRecord,
  type TierProvenanceDoc,
} from "../scripts/live/deliverable-checks.ts";

const here = dirname(fileURLToPath(import.meta.url));
/** The archived runs' evidence is git-ignored, so this one-time migration check runs only where that evidence exists. */
const archive = resolve(here, "..", "experiments", "runs", "adapter-literature-workflow-v1");
const archivePresent = existsSync(join(archive, "iter-04", "evidence", "project", ".registry", "registry.db"));
const fixtureDir = join(here, "fixtures", "tier1-differential");
const old = JSON.parse(readFileSync(join(fixtureDir, "old-verdicts.json"), "utf8")) as {
  iters: Record<string, {
    citedKeys: string[];
    citationsInRegistry: { ok: boolean };
    bibliographyMatchesRegistry: { ok: boolean };
    compiledAfterLastEdit: { ok: boolean };
    sourcedNumerics: { ok: boolean } | null;
  }>;
};
const diffs = JSON.parse(readFileSync(join(fixtureDir, "t1.5-differences.json"), "utf8")) as {
  differs: Record<string, { oldSourcedNumerics: boolean; newT15: boolean; why: string }>;
};
const ITERS = Object.keys(old.iters).sort();

/** Archive copies are read-only; the audit copy must be writable. */
const makeWritable = (dir: string): void => {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) {
      chmodSync(p, 0o755);
      makeWritable(p);
    } else if (!e.isSymbolicLink()) {
      chmodSync(p, 0o644);
    }
  }
};

const tier1Of = (iter: string): { doc: TierProvenanceDoc; checks: { id: string; ok: boolean }[] } => {
  const project = join(archive, iter, "evidence", "project");
  const tmp = mkdtempSync(join(tmpdir(), "tier1-diff-"));
  try {
    const copy = join(tmp, "project");
    cpSync(project, copy, { recursive: true });
    makeWritable(copy);
    const outcome = runProvenance({ root: copy, now: () => new Date() });
    assert.equal(outcome.ok, true, `${iter}: provenance audit must succeed on the copy`);
    if (!outcome.ok) throw new Error("unreachable");
    const doc: TierProvenanceDoc = {
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
    };
    const records = JSON.parse(readFileSync(join(archive, iter, "deliverables", "registry.json"), "utf8")) as RegistryRecord[];
    const bib = readFileSync(join(project, "refs", "references.bib"), "utf8");
    const papers = readTierPaperTexts(project) ?? [];
    return {
      doc,
      checks: [
        checkTierCitations(doc, records),
        checkTierBibliography(doc, bib, records),
        checkTierPdfCurrent(project, doc.entry),
        checkTierPointers(doc, papers),
        checkTierFigures(doc),
      ],
    };
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
};

describe("Tier 1 differential over iter-04 … iter-20", { skip: archivePresent ? false : "archived run evidence (git-ignored) is not present" }, () => {
  for (const iter of ITERS) {
    it(`${iter}: T1.1–T1.3 equal the old verdicts exactly`, () => {
      const { doc, checks } = tier1Of(iter);
      const want = old.iters[iter]!;
      // The mechanism behind the equality: provenance cites are the tex cites.
      assert.deepEqual(provenanceCitedKeys(doc), want.citedKeys, `${iter}: provenance cites match the old tex cites`);
      // The old pure checks, recomputed live, still match the saved fixture.
      const tex = readFileSync(join(archive, iter, "deliverables", "manuscript", "main.tex"), "utf8");
      const bib = readFileSync(join(archive, iter, "deliverables", "refs", "references.bib"), "utf8");
      const records = JSON.parse(readFileSync(join(archive, iter, "deliverables", "registry.json"), "utf8")) as RegistryRecord[];
      const cited = parseCitedKeys(tex);
      assert.equal(checkCitationsInRegistry(cited, records).ok, want.citationsInRegistry.ok, `${iter}: fixture cites verdict is honest`);
      assert.equal(checkBibliography(bib, cited, records).ok, want.bibliographyMatchesRegistry.ok, `${iter}: fixture bib verdict is honest`);
      // The differential itself.
      const byId = new Map(checks.map((c) => [c.id, c.ok]));
      assert.equal(byId.get("citations-in-registry"), want.citationsInRegistry.ok, `${iter}: T1.1`);
      assert.equal(byId.get("bibliography-matches-registry"), want.bibliographyMatchesRegistry.ok, `${iter}: T1.2`);
      assert.equal(byId.get("compiled-after-last-edit"), want.compiledAfterLastEdit.ok, `${iter}: T1.3`);
    });

    it(`${iter}: T1.5 vs sourced-numerics is the listed difference or no difference`, () => {
      const { checks } = tier1Of(iter);
      const t15 = checks.find((c) => c.id === "figures-supported")!.ok;
      const oldSourced = old.iters[iter]!.sourcedNumerics?.ok ?? null;
      assert.notEqual(oldSourced, null, `${iter}: archived sourced-numerics verdict exists`);
      const listed = diffs.differs[iter];
      if (listed === undefined) {
        assert.equal(t15, oldSourced, `${iter}: no listed difference, verdicts agree`);
      } else {
        assert.equal(oldSourced, listed.oldSourcedNumerics, `${iter}: fixture old verdict is honest`);
        assert.equal(t15, listed.newT15, `${iter}: fixture new verdict is honest`);
        assert.notEqual(t15, oldSourced, `${iter}: a listed difference really differs`);
        assert.ok(listed.why.length > 0, `${iter}: one-line explanation present`);
      }
    });
  }
});
