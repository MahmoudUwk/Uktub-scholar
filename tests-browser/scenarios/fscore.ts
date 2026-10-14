/**
 * Differential scenario: REAL core code through the fs seam.
 *
 * Runs UNCHANGED against real `node:fs`/`node:sqlite` (Node, `root` = temp
 * dir) and against the browser shims (worker, `root` = `/proj`). It bundles
 * and calls the actual core functions the tools use for project files:
 * `resolveProjectFile` (confinement: dot-dot, absolute outside, directory,
 * missing, oversize, protected segment), `toolOwnedViolation`,
 * `loadChunkConfig` (absent/file/malformed/env-override), `syncBibliography`
 * (the 0444 + staged-rename `writeBibliography`), `reviewManuscript`
 * (report write + never-overwrite refusal) and the engine-free compile
 * probes `resolveEntry`/`projectPathOf`.
 *
 * Engine/download seams are NOT exercised: `compile()` itself (needs a
 * Tectonic binary via `./engine.ts` + `./managed.ts`) and anything that
 * downloads models or calls providers are skipped, named in REMAINING.md.
 * `migrateLegacy` (needs a legacy-version registry file) is skipped too.
 */
import { DatabaseSync } from "node:sqlite";
import { chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { resolveProjectFile } from "../../src/core/tools/context.ts";
import { toolOwnedViolation } from "../../src/core/tool-owned.ts";
import { loadChunkConfig } from "../../src/core/config.ts";
import { syncBibliography } from "../../src/core/registry.ts";
import { reviewManuscript } from "../../src/core/review/run.ts";
import { projectPathOf, resolveEntry } from "../../src/core/compile/run.ts";
import { norm, step, type Norm } from "./norm.ts";

const MAIN_TEX = [
  "\\documentclass{article}",
  "\\begin{document}",
  "Prior work shows nothing yet \\cite{doe2024}.",
  "\\bibliographystyle{plain}",
  "\\bibliography{../refs/references}",
  "\\end{document}",
  "",
].join("\n");

const BIB_A = "@article{doe2024,\n author={Doe, Jane},\n title={On things},\n journal={J},\n year={2024}\n}";
const BIB_B = "@article{roe2023,\n author={Roe, R.},\n title={Other things},\n journal={J},\n year={2023},\n month={jan}\n}";

const CHUNK_YAML = [
  "chunking:",
  "  chunk_tokens: 400",
  "  overlap_tokens: 40",
  "  chars_per_token: 4",
  "  boundary: section",
  "verification:",
  "  engine: eos",
  "  min_confidence: 0.75",
  "  workers: 2",
  "  max_judgments: 100",
  "",
].join("\n");

function scrub(value: Norm, root: string): Norm {
  if (typeof value === "string") return value.split(root).join("$ROOT");
  if (Array.isArray(value)) return value.map((v) => scrub(v, root));
  if (value !== null && typeof value === "object") {
    const out: Record<string, Norm> = {};
    for (const k of Object.keys(value)) out[k] = scrub((value as Record<string, Norm>)[k], root);
    return out;
  }
  return value;
}

export function runFscoreScenario(root: string): Record<string, Norm> {
  const out: Record<string, Norm> = {};
  const S = (fn: () => unknown): Norm => scrub(step(fn), root);
  const R = (rel: string): string => `${root}/${rel}`;

  // Fixture tree (built through the same fs surface on both sides).
  mkdirSync(R("paper"), { recursive: true });
  mkdirSync(R("manuscript"), { recursive: true });
  mkdirSync(R("config"), { recursive: true });
  mkdirSync(R("empty"), { recursive: true });
  mkdirSync(R("evidence"), { recursive: true });
  mkdirSync(R(".registry"), { recursive: true });
  writeFileSync(R("paper/main.tex"), MAIN_TEX, "utf-8");
  writeFileSync(R("manuscript/main.tex"), MAIN_TEX, "utf-8");
  writeFileSync(R("config/chunking.yaml"), CHUNK_YAML, "utf-8");
  writeFileSync(R("config/broken.yaml"), "chunking: [unclosed\n  bad indent:\n x", "utf-8");
  writeFileSync(R(".registry/dummy.txt"), "x");
  out["fixture"] = norm(((readdirSync(root) as string[]).slice().sort()));

  // resolveProjectFile confinement.
  out["ctxOk"] = S(() => {
    const r = resolveProjectFile(root, "paper/main.tex", 4_000_000);
    return r.ok ? { ok: 1, rel: r.rel, bytes: r.bytes } : r;
  });
  out["ctxDotDot"] = S(() => resolveProjectFile(root, "../outside.tex", 4_000_000));
  out["ctxAbsOutside"] = S(() => resolveProjectFile(root, "/etc/hostname-outside", 4_000_000));
  out["ctxDir"] = S(() => resolveProjectFile(root, "paper", 4_000_000));
  out["ctxMissing"] = S(() => resolveProjectFile(root, "paper/nope.tex", 4_000_000));
  out["ctxOversize"] = S(() => resolveProjectFile(root, "paper/main.tex", 10));
  out["ctxProtected"] = S(() => resolveProjectFile(root, ".registry/dummy.txt", 4_000_000));

  // Tool-owned paths.
  out["own"] = S(() => ({
    registry: toolOwnedViolation(root, ".registry/registry.db"),
    bib: toolOwnedViolation(root, "refs/references.bib"),
    plain: toolOwnedViolation(root, "paper/main.tex"),
    escape: toolOwnedViolation(root, "../escape.txt"),
  }));

  // Config file reading.
  out["cfgDefault"] = S(() => loadChunkConfig(R("empty"), { env: {} }));
  out["cfgFile"] = S(() => loadChunkConfig(root, { env: {} }));
  out["cfgBroken"] = S(() => loadChunkConfig(root, { env: { UKTUB_CHUNK_CONFIG: "config/broken.yaml" } }));
  out["cfgMissingExplicit"] = S(() => loadChunkConfig(root, { env: { UKTUB_CHUNK_CONFIG: "config/nope.yaml" } }));
  out["cfgEnv"] = S(() =>
    loadChunkConfig(R("empty"), { env: { UKTUB_VERIFY_ENGINE: "openrouter", UKTUB_VERIFY_MIN_CONFIDENCE: "0.9" } }),
  );
  out["cfgEnvBad"] = S(() => loadChunkConfig(R("empty"), { env: { UKTUB_VERIFY_ENGINE: "nope" } }));

  // Bibliography render: real syncBibliography against a live registry with
  // two citable papers (minimal papers table: the only columns it reads).
  out["bibSync"] = S(() => {
    const db = new DatabaseSync(R(".registry/registry.db"));
    try {
      db.exec("CREATE TABLE papers(citekey TEXT, provider_bibtex TEXT, citable INTEGER)");
      db.prepare("INSERT INTO papers(citekey, provider_bibtex, citable) VALUES(?, ?, ?)").run("doe2024", BIB_A, 1);
      db.prepare("INSERT INTO papers(citekey, provider_bibtex, citable) VALUES(?, ?, ?)").run("roe2023", BIB_B, 1);
      const r = syncBibliography(db);
      const content = readFileSync(R("refs/references.bib"), "utf8");
      const st = statSync(R("refs/references.bib"));
      return {
        syncedCount: r.syncedCount,
        content,
        writable: (st.mode & 0o200) !== 0 ? 1 : 0,
        stagedLeft: ((readdirSync(R("refs")) as string[]).filter((n) => n.includes(".tmp")).length as number),
      };
    } finally {
      db.close();
    }
  });

  // Review report write (wx) + never-overwrite refusal.
  const now = (): Date => new Date("2026-01-02T03:04:05.000Z");
  out["reviewWrite"] = S(() => {
    const r = reviewManuscript({ root, entry: "paper/main.tex", now });
    if (!r.ok) return r;
    return { ok: 1, entry: r.entry, reportRel: r.reportRel, summary: r.summary, bytes: readFileSync(`${root}/${r.reportRel}`, "utf8").length };
  });
  out["reviewAgain"] = S(() => reviewManuscript({ root, entry: "paper/main.tex", now }));
  out["reviewMissing"] = S(() => reviewManuscript({ root, entry: "paper/nope.tex", now }));

  // Engine-free compile probes.
  out["compileEntry"] = S(() => resolveEntry(root, "paper/main.tex"));
  out["compileDiscover"] = S(() => resolveEntry(root));
  out["compileMissing"] = S(() => resolveEntry(root, "paper/nope.tex"));
  out["compilePathOf"] = S(() => projectPathOf(root, R("paper"), "main"));

  // Registry visibility through fs (exists/stat only; bytes stay in sqlite).
  out["registryVisible"] = S(() => ({
    exists: existsSync(R(".registry/registry.db")),
    isFile: statSync(R(".registry/registry.db")).isFile(),
    regDir: ((readdirSync(R(".registry")) as string[]).slice().sort()),
  }));
  out["caseKeys"] = norm("v1");
  return out;
}
