/**
 * Blind grading pipeline, pure core (scripts/live/grade-lib.ts): neutral note ids, export stripping,
 * label-schema validation, disagreement selection and grader-secret separation. Fixture values only.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  BAD_LABELS,
  CITED_LABELS,
  UNCITED_LABELS,
  UNGRADEABLE_LABEL,
  adjudicationSeed,
  allowedCorpusHost,
  applyAdjudication,
  classOf,
  corpusFetchDelayMs,
  corpusFileName,
  graderSecretsOnly,
  isBadLabel,
  keyedOriginRefused,
  noteFromProvenance,
  noteIdForRun,
  selectDisagreements,
  sha256Text,
  shufflePair,
  splitExportArgs,
  tier2Counts,
  toBinaryLabels,
  validateLabels,
  type AdjudicatedFile,
  type LabelFile,
  type NoteJson,
} from "../scripts/live/grade-lib.ts";

const note = (over: Partial<NoteJson> = {}): NoteJson => ({
  note: "abcdef12",
  document_digest: "d".repeat(64),
  trap: "Our pilot halves training memory compared with LoRA.",
  units: [
    { id: "u1", kind: "sentence", file: "main.tex", line: 1, section: "S", text: "Cited one.", cites: ["k1"], cited: true },
    { id: "u2", kind: "sentence", file: "main.tex", line: 2, section: "S", text: "Plain background.", cites: [], cited: false },
  ],
  ...over,
});

const labels = (over: Partial<LabelFile> = {}): LabelFile => ({
  note: "abcdef12",
  document_digest: "d".repeat(64),
  grader_model: "opencode-go/muse-spark-1.3-contributor",
  rubric_sha256: "r".repeat(64),
  trap_violated: false,
  units: [
    { id: "u1", label: "supported", location: "k1 p.2", excerpt: "words", rationale: "matches" },
    { id: "u2", label: "background", rationale: "generic" },
  ],
  ...over,
});

describe("noteIdForRun", () => {
  it("is the first 8 hex of sha256('uktub-grading:' + run id)", () => {
    assert.equal(noteIdForRun("iter-06"), sha256Text("uktub-grading:iter-06").slice(0, 8));
    assert.match(noteIdForRun("iter-06"), /^[0-9a-f]{8}$/);
    assert.notEqual(noteIdForRun("iter-06"), noteIdForRun("iter-07"));
  });
});

describe("noteFromProvenance", () => {
  it("keeps the digest and strips status/pointers, marking cited from cites", () => {
    const raw = {
      document_digest: "d".repeat(64),
      units: [
        { id: "u1", kind: "sentence", file: "main.tex", line: 3, section: "S", text: "T.", cites: ["k1"], status: "cited", pointers: [{ x: 1 }] },
        { id: "u2", kind: "sentence", file: "main.tex", line: 4, section: "S", text: "U.", cites: [], status: "uncited", pointers: [] },
      ],
    };
    const n = noteFromProvenance("abcdef12", "trap", raw);
    assert.equal(n.document_digest, "d".repeat(64));
    assert.deepEqual(n.units[0], { id: "u1", kind: "sentence", file: "main.tex", line: 3, section: "S", text: "T.", cites: ["k1"], cited: true });
    assert.ok(!("status" in (n.units[0] as object)) && !("pointers" in (n.units[0] as object)));
    assert.equal(n.units[1]?.cited, false);
  });

  it("rejects a missing digest or unit list", () => {
    assert.throws(() => noteFromProvenance("n", "t", {}), /document_digest/);
    assert.throws(() => noteFromProvenance("n", "t", { document_digest: "x" }), /units/);
  });
});

describe("label classes", () => {
  it("accepts the five cited and two uncited labels, nothing else", () => {
    assert.deepEqual([...CITED_LABELS], ["supported", "overstated", "unsupported", "wrong", "misattributed"]);
    assert.deepEqual([...UNCITED_LABELS], ["background", "specific"]);
    assert.throws(() => classOf("specific", true), /cited/);
    assert.throws(() => classOf("supported", false), /uncited/);
  });

  it("maps unsupported|wrong|misattributed to bad, and only those", () => {
    assert.deepEqual([...BAD_LABELS], ["unsupported", "wrong", "misattributed"]);
    for (const l of CITED_LABELS) assert.equal(isBadLabel(l), (["unsupported", "wrong", "misattributed"] as string[]).includes(l));
    assert.equal(isBadLabel("specific"), false);
    assert.equal(classOf("overstated", true), "overstated");
    assert.equal(classOf("wrong", true), "bad");
    assert.equal(classOf("specific", false), "specific");
  });
});

describe("validateLabels", () => {
  const rubric = "r".repeat(64);
  it("accepts a complete valid file", () => {
    assert.deepEqual(validateLabels(note(), labels(), rubric), []);
  });

  it("reports digest/note mismatch, missing and duplicate units", () => {
    const bad = labels({ units: [{ id: "u1", label: "supported", location: "l", excerpt: "e" }, { id: "u1", label: "wrong", location: "l", excerpt: "e" }] });
    const errs = validateLabels(note(), bad, rubric);
    assert.ok(errs.some((e) => /u2.*once|missing/i.test(e)), errs.join("; "));
    assert.ok(errs.some((e: string) => /u1.*(twice|2 times)|duplicate/i.test(e)), errs.join("; "));
    assert.ok(validateLabels(note(), labels({ document_digest: "x" }), rubric).some((e) => /digest/i.test(e)));
    assert.ok(validateLabels(note(), labels({ note: "other" }), rubric).some((e) => /note/i.test(e)));
    assert.ok(validateLabels(note(), labels(), "other").some((e) => /rubric/i.test(e)));
  });

  it("rejects a label invalid for the cited flag", () => {
    const bad = labels({ units: [{ id: "u1", label: "background" }, { id: "u2", label: "supported" }] });
    const errs = validateLabels(note(), bad, rubric);
    assert.ok(errs.some((e) => e.includes("u1") && /cited unit/.test(e)), errs.join("; "));
    assert.ok(errs.some((e) => e.includes("u2") && /uncited unit/.test(e)), errs.join("; "));
  });

  it("requires location and a <=300-char excerpt on every cited unit", () => {
    const noLoc = labels({ units: [{ id: "u1", label: "supported", excerpt: "e" }, { id: "u2", label: "background" }] });
    assert.ok(validateLabels(note(), noLoc, rubric).some((e) => /location/i.test(e)));
    const long = labels({ units: [{ id: "u1", label: "supported", location: "l", excerpt: "e".repeat(301) }, { id: "u2", label: "background" }] });
    assert.ok(validateLabels(note(), long, rubric).some((e) => /300/i.test(e)));
  });

  it("requires a boolean trap flag", () => {
    assert.ok(validateLabels(note(), labels({ trap_violated: "no" as unknown as boolean }), rubric).some((e) => /trap/i.test(e)));
  });
});

describe("selectDisagreements", () => {
  it("counts only cross-class disagreements, never within bad", () => {
    const a = labels();
    const b = labels({ units: [{ id: "u1", label: "overstated", location: "l", excerpt: "e" }, { id: "u2", label: "specific" }] });
    const d = selectDisagreements(note(), a, b);
    assert.equal(d.cited.length, 1);
    assert.equal(d.uncited.length, 1);
    assert.equal(d.trap, false);
  });

  it("ignores unsupported vs wrong (both bad) but flags the trap gap", () => {
    const a = labels({ units: [{ id: "u1", label: "unsupported", location: "l", excerpt: "e" }, { id: "u2", label: "background" }] });
    const b = labels({ units: [{ id: "u1", label: "wrong", location: "l2", excerpt: "e2" }, { id: "u2", label: "background" }], trap_violated: true });
    const d = selectDisagreements(note(), a, b);
    assert.deepEqual([d.cited.length, d.uncited.length, d.trap], [0, 0, true]);
  });
});

describe("applyAdjudication", () => {
  it("keeps agreed labels and takes rulings for disagreements", () => {
    const a = labels();
    const b = labels({ units: [{ id: "u1", label: "overstated", location: "l", excerpt: "e" }, { id: "u2", label: "specific" }] });
    const out = applyAdjudication(note(), a, b, { u1: "overstated", u2: "specific" }, "model", "r".repeat(64), 42, true);
    assert.equal(out.units.find((u) => u.id === "u1")?.final, "overstated");
    assert.equal(out.units.find((u) => u.id === "u1")?.basis, "adjudicated");
    assert.equal(out.trap_violated, true);
  });

  it("refuses a ruling for an agreed unit or a missing ruling for a disagreement", () => {
    const a = labels();
    assert.throws(() => applyAdjudication(note(), a, a, { u1: "supported" }, "m", "r".repeat(64), 1, false), /agreed/);
    const b = labels({ units: [{ id: "u1", label: "wrong", location: "l", excerpt: "e" }, { id: "u2", label: "background" }] });
    assert.throws(() => applyAdjudication(note(), a, b, {}, "m", "r".repeat(64), 1, false), /missing ruling/);
  });
});

describe("adjudicationSeed + shufflePair", () => {
  it("is deterministic per note and splits orders across notes", () => {
    assert.equal(adjudicationSeed("abcdef12"), adjudicationSeed("abcdef12"));
    const orders = new Set(["n1", "n2", "n3", "n4", "n5", "n6"].map((n) => shufflePair(["A", "B"], adjudicationSeed(n)).join("")));
    assert.ok(orders.size === 2, "both orders occur");
  });
});

describe("toBinaryLabels", () => {
  it("maps cited units to bad/not-bad for analysis.ts agreement", () => {
    const got = toBinaryLabels("abcdef12", labels());
    assert.deepEqual(got, [{ note: "abcdef12", unit: "u1", bad: false }]);
  });
});

describe("corpus helpers", () => {
  it("names files by content hash and accepts any recorded non-keyed HTTPS origin the product acquired from", () => {
    assert.equal(corpusFileName("ab".repeat(32), "pdf"), `${"ab".repeat(32)}.pdf`);
    assert.ok(allowedCorpusHost("https://arxiv.org/pdf/2106.09685"));
    assert.ok(allowedCorpusHost("https://export.arxiv.org/pdf/2106.09685"));
    assert.ok(allowedCorpusHost("https://aclanthology.org/2024.acl-long.1.pdf"));
    assert.ok(allowedCorpusHost("https://www.ijcai.org/proceedings/2026/0486.pdf"), "RF pilot origin (was refused)");
    assert.ok(allowedCorpusHost("https://backoffice.biblio.ugent.be/download/01KC3GNFABAKVY9NHG56XY4FW5/01KC3GRQSD5BK01K5Y2"), "university repository origin (was refused)");
    assert.ok(!allowedCorpusHost("http://www.ijcai.org/proceedings/2026/0486.pdf"), "plain HTTP is never fetched");
    assert.ok(!allowedCorpusHost("not a url"));
    assert.ok(!allowedCorpusHost(""));
  });

  it("refuses keyed origins (credentials or key-like query)", () => {
    assert.ok(keyedOriginRefused("https://user:pass@arxiv.org/pdf/1"));
    assert.ok(keyedOriginRefused("https://example.com/api?api_key=abc"));
    assert.ok(keyedOriginRefused("https://content.openalex.org/works/x.pdf?api_key=abc"), "the Content API tier stays keyed");
    assert.ok(!keyedOriginRefused("https://arxiv.org/pdf/2106.09685"));
    assert.ok(!keyedOriginRefused("https://www.ijcai.org/proceedings/2026/0486.pdf"));
  });
});

describe("corpusFetchDelayMs", () => {
  it("spaces requests per host: first fetch and other hosts go immediately", () => {
    const last = new Map<string, number>();
    assert.equal(corpusFetchDelayMs("arxiv.org", 10_000, last, 3000), 0);
    last.set("arxiv.org", 10_000);
    assert.equal(corpusFetchDelayMs("arxiv.org", 11_000, last, 3000), 2000);
    assert.equal(corpusFetchDelayMs("arxiv.org", 13_000, last, 3000), 0);
    assert.equal(corpusFetchDelayMs("www.ijcai.org", 11_000, last, 3000), 0, "per-host spacing, not global");
  });
});

describe("ungradeable", () => {
  it("is valid for cited and uncited units alike", () => {
    assert.equal(UNGRADEABLE_LABEL, "ungradeable");
    assert.equal(classOf("ungradeable", true), "ungradeable");
    assert.equal(classOf("ungradeable", false), "ungradeable");
  });

  it("needs no location/excerpt (no paper to point at) but must record the reason", () => {
    const rubric = "r".repeat(64);
    const noReason = labels({
      units: [
        { id: "u1", label: "ungradeable" },
        { id: "u2", label: "background" },
      ],
    });
    const errs = validateLabels(note(), noReason, rubric);
    assert.ok(errs.some((e) => e.includes("u1") && /reason/i.test(e)), errs.join("; "));
    const withReason = labels({
      units: [
        { id: "u1", label: "ungradeable", rationale: "k1 is missing from the corpus" },
        { id: "u2", label: "background" },
      ],
    });
    assert.deepEqual(validateLabels(note(), withReason, rubric), []);
  });

  it("disagrees with every gradeable class and stays out of binary agreement labels", () => {
    const a = labels();
    const b = labels({
      units: [
        { id: "u1", label: "ungradeable", rationale: "k1 missing from the corpus" },
        { id: "u2", label: "background" },
      ],
    });
    const d = selectDisagreements(note(), a, b);
    assert.equal(d.cited.length, 1);
    assert.deepEqual(toBinaryLabels("abcdef12", b), [], "an ungradeable cited unit is not a bad/not-bad row");
    assert.deepEqual(toBinaryLabels("abcdef12", a), [{ note: "abcdef12", unit: "u1", bad: false }]);
  });

  it("is excluded from Tier 2 denominators and counted separately", () => {
    const n = note({
      units: [
        { id: "u1", kind: "sentence", file: "main.tex", line: 1, section: "S", text: "Cited one.", cites: ["k1"], cited: true },
        { id: "u2", kind: "sentence", file: "main.tex", line: 2, section: "S", text: "Cited two.", cites: ["k2"], cited: true },
        { id: "u3", kind: "sentence", file: "main.tex", line: 3, section: "S", text: "Plain background.", cites: [], cited: false },
      ],
    });
    const adj: AdjudicatedFile = {
      note: "abcdef12",
      document_digest: "d".repeat(64),
      rubric_sha256: "r".repeat(64),
      adjudicator_model: "m",
      seed: 1,
      trap_violated: false,
      units: [
        { id: "u1", final: "wrong", basis: "adjudicated", a: "supported", b: "wrong" },
        { id: "u2", final: "ungradeable", basis: "adjudicated", a: "supported", b: "ungradeable" },
        { id: "u3", final: "background", basis: "agreed", a: "background", b: "background" },
      ],
    };
    assert.deepEqual(tier2Counts(n, adj), { id: "abcdef12", bad: 1, rows: 1, ungradeable: 1 });
  });
});

describe("splitExportArgs", () => {
  it("keeps run dirs when no --trap flag is given (regression: they were dropped)", () => {
    assert.deepEqual(splitExportArgs(["a", "b"]), { runDirs: ["a", "b"], trap: "Our pilot halves training memory compared with LoRA." });
    assert.deepEqual(splitExportArgs(["a", "--trap", "T", "b"]), { runDirs: ["a", "b"], trap: "T" });
    assert.deepEqual(splitExportArgs(["--trap", ""]), { runDirs: [], trap: "" });
  });
});

describe("graderSecretsOnly", () => {
  it("keeps only the grader key, never provider keys", () => {
    const got = graderSecretsOnly({ OPENCODE_API_KEY: "g", SEMANTIC_SCHOLAR_API_KEY: "s", OPENALEX_API_KEY: "o", CROSSREF_MAILTO: "m" });
    assert.deepEqual(got, { OPENCODE_API_KEY: "g" });
    assert.deepEqual(graderSecretsOnly({}), {});
  });
});
