/**
 * claim-verification-v2 corpus selection: the same listing and seed always give the same papers, and only papers that fit the stated rules
 * are taken. Offline: the listing is a genuine arXiv API response, the inspection a fake.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { foldOf, parseListing, pickPapers as pickWith, RULES, type Entry, type Inspection } from "../scripts/bench-v2-corpus.ts";

const xml = readFileSync(resolve(import.meta.dirname, "fixtures/arxiv-listing-sample.xml"), "utf8");
const entry = (n: number, over: Partial<Entry> = {}): Entry => ({ id: `2609.${String(n).padStart(5, "0")}`, version: 1, authors: ["A. Author"], title: `A paper about topic ${n}`, primary: "cs.CL", published: "2026-09-01T00:00:00Z", pdfUrl: `https://arxiv.org/pdf/2609.${String(n).padStart(5, "0")}v1`, ...over });
const fits: Inspection = { pages: 12, chars: 70_000 };
const CC_BY = "http://creativecommons.org/licenses/by/4.0/";
/** The picker with every paper under CC BY unless a test says otherwise. */
const pickPapers = (entries: Entry[], category: string, inspect: (e: Entry) => Promise<Inspection | null>, seed: number, license: (e: Entry) => Promise<string | null> = async () => CC_BY) => pickWith(entries, category, { license, inspect }, seed);

describe("the arXiv listing", () => {
  const entries = parseListing(xml);
  it("is read into one entry per paper, with the version, the title and the PDF link", () => {
    assert.equal(entries.length, 3);
    assert.deepEqual([entries[0]?.id, entries[0]?.version, entries[0]?.primary, entries[0]?.published], ["2610.00840", 1, "cs.CL", "2026-09-30T23:56:18Z"]);
    assert.match(entries[0]?.title ?? "", /^Contextual trajectory and incremental contextual displacement/);
    assert.equal(entries[1]?.pdfUrl, "https://arxiv.org/pdf/2610.00833v1");
  });
  it("carries the authors in the order the listing gives them (the attribution a CC BY paper asks for)", () => {
    assert.deepEqual(entries[0]?.authors, ["Grayson Wycliffe Storer", "Julia Witte Zimmerman"]);
    assert.deepEqual(entries[1]?.authors, ["Sachin Gupta"]);
  });
  it("keeps a title that wraps over lines as one line", () => {
    const wrapped = xml.replace("<title>Verbalized and Internal Probabilities Are Coupled", "<title>Verbalized and\n    Internal Probabilities Are Coupled");
    assert.equal(parseListing(wrapped)[2]?.title, "Verbalized and Internal Probabilities Are Coupled in Large Language Models");
  });
});

describe("picking papers", () => {
  const entries = Array.from({ length: 40 }, (_, i) => entry(i + 1));
  it("takes the stated number of papers per category, the same ones for the same seed and different ones for another", async () => {
    const a = await pickPapers(entries, "cs.CL", async () => fits, RULES.seed);
    const b = await pickPapers(entries, "cs.CL", async () => fits, RULES.seed);
    const c = await pickPapers(entries, "cs.CL", async () => fits, RULES.seed + 1);
    assert.equal(a.length, RULES.perCategory);
    assert.deepEqual(a.map((x) => x.id), b.map((x) => x.id));
    assert.notDeepEqual(a.map((x) => x.id), c.map((x) => x.id));
  });
  it("does not depend on the order of the listing", async () => {
    const a = await pickPapers(entries, "cs.CL", async () => fits, RULES.seed);
    const b = await pickPapers([...entries].reverse(), "cs.CL", async () => fits, RULES.seed);
    assert.deepEqual(a.map((x) => x.id), b.map((x) => x.id));
  });
  it("skips another primary category, surveys and the like, and papers outside the page and length limits", async () => {
    const mixed = [
      entry(1, { primary: "cs.CV" }), entry(2, { title: "A survey of everything" }), entry(3, { title: "Tutorial on x" }), entry(4), entry(5), entry(6), entry(7), entry(8),
    ];
    const sizes: Record<string, Inspection> = { [mixed[3]!.id]: { pages: 4, chars: 70_000 }, [mixed[4]!.id]: { pages: 12, chars: 20_000 }, [mixed[5]!.id]: { pages: 60, chars: 70_000 }, [mixed[6]!.id]: { pages: 12, chars: 200_000 } };
    const picked = await pickPapers(mixed, "cs.CL", async (e) => sizes[e.id] ?? fits, RULES.seed);
    assert.deepEqual(picked.map((x) => x.id), [mixed[7]!.id], "only the last paper is acceptable");
  });
  it("skips a paper that cannot be inspected and goes on to the next, and takes fewer than asked when the listing runs out", async () => {
    const few = [entry(1), entry(2), entry(3)];
    const picked = await pickPapers(few, "cs.CL", async (e) => (e.id === few[0]!.id ? null : fits), RULES.seed);
    assert.equal(picked.length, 2);
    assert.ok(!picked.some((x) => x.id === few[0]!.id));
  });
  it("only inspects as many candidates as it needs, in the seeded order", async () => {
    const seen: string[] = [];
    await pickPapers(entries, "cs.CL", async (e) => { seen.push(e.id); return fits; }, RULES.seed);
    assert.equal(seen.length, RULES.perCategory);
  });
});

describe("the licence of a picked paper", () => {
  const entries = Array.from({ length: 30 }, (_, i) => entry(i + 1));
  const byId = (m: Record<string, string | null>) => async (e: Entry) => m[e.id] ?? CC_BY;
  it("must be one an open dataset can carry (CC BY of any version, CC0); share-alike, non-commercial, no-derivatives and arXiv's default licence are skipped", async () => {
    const bad = ["http://creativecommons.org/licenses/by-sa/4.0/", "http://creativecommons.org/licenses/by-nc-sa/4.0/", "http://creativecommons.org/licenses/by-nc-nd/4.0/", "http://arxiv.org/licenses/nonexclusive-distrib/1.0/", null];
    const ok = ["http://creativecommons.org/licenses/by/4.0/", "http://creativecommons.org/licenses/by/3.0/", "http://creativecommons.org/publicdomain/zero/1.0/"];
    for (const l of bad) assert.equal((await pickPapers(entries.slice(0, 1), "cs.CL", async () => fits, RULES.seed, async () => l)).length, 0, String(l));
    for (const l of ok) assert.equal((await pickPapers(entries.slice(0, 1), "cs.CL", async () => fits, RULES.seed, async () => l)).length, 1, l);
  });
  it("is checked before the paper is downloaded, so a paper that cannot be used is never fetched", async () => {
    const fetched: string[] = [];
    const lic = byId(Object.fromEntries(entries.slice(0, 10).map((e) => [e.id, "http://arxiv.org/licenses/nonexclusive-distrib/1.0/"])));
    const picked = await pickPapers(entries, "cs.CL", async (e) => { fetched.push(e.id); return fits; }, RULES.seed, lic);
    assert.equal(picked.length, RULES.perCategory);
    assert.ok(fetched.every((id) => !entries.slice(0, 10).some((e) => e.id === id)), "no skipped paper was inspected");
  });
  it("is recorded on the picked paper, and walking past other licences leaves the same papers first when they qualify", async () => {
    const all = await pickPapers(entries, "cs.CL", async () => fits, RULES.seed);
    assert.ok(all.every((p) => p.license === CC_BY));
    const keep = new Set(all.map((p) => p.id));
    const lic = byId(Object.fromEntries(entries.filter((e) => !keep.has(e.id)).slice(0, 5).map((e) => [e.id, "http://arxiv.org/licenses/nonexclusive-distrib/1.0/"])));
    const filtered = await pickPapers(entries, "cs.CL", async () => fits, RULES.seed, lic);
    assert.deepEqual(filtered.map((p) => p.id), all.map((p) => p.id), "papers that qualify keep their place when others are skipped");
  });
});

describe("folds", () => {
  it("are four of equal size over the 16 categories of 3 papers, and every category meets three different folds", () => {
    const counts = [0, 0, 0, 0];
    for (let c = 0; c < RULES.categories.length; c++) {
      const folds = Array.from({ length: RULES.perCategory }, (_, i) => foldOf(c, i));
      assert.equal(new Set(folds).size, RULES.perCategory);
      for (const f of folds) counts[f] = (counts[f] ?? 0) + 1;
    }
    assert.deepEqual(counts, [12, 12, 12, 12]);
  });
});

