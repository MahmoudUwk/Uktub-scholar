/**
 * Frozen live-acceptance cases for the CURRENT five tools (CASES_VERSION is part of the evidence; the runner records this file's sha256).
 *
 * Verdicts (decided here, before any run):
 *   PASS     every assertion held against real calls, real providers and real engines.
 *   FAIL     an assertion did not hold: a product defect or a wrong contract. Never retried, never weakened.
 *   BLOCKED  the attempt could not be validly made (provider outage, deadline, auth): reported with its cause, not a pass and not a defect.
 *   NOT_RUN  the path was not exercised (missing prerequisite, key, or case) and says why. Not a pass.
 *
 * Direct cases call the real stdio MCP server inside the sandbox (no model). Agent cases are in agent-cases.ts.
 */
import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export const CASES_VERSION = "2026-10-07.7";

export const D1 = "10.48550/arxiv.2411.09996";
export const D2 = "10.48550/arxiv.2511.15162";
export const NUMPY = "10.1038/s41586-020-2649-2";
export const HSD_CLAIM = "The HSD dataset provides CSI measurements for six distinct human activities, including running and boxing.";

export class Blocked extends Error {}
export class NotRun extends Error {}

export interface CallResult {
  isError?: boolean;
  content: Array<{ type: string; text?: string }>;
  // biome-ignore lint/suspicious/noExplicitAny: structured tool output is asserted field by field
  structuredContent?: any;
}
export interface Session {
  call(name: string, args: Record<string, unknown>, opts?: { signal?: AbortSignal }): Promise<CallResult>;
  close(): Promise<void>;
}
export interface Ctx {
  mcp: Session;
  /** A second MCP server process in its own container with extra environment (degradation and unavailable-engine cases). */
  open(label: string, env: Record<string, string>): Promise<Session>;
  /** A second real Pi session (agent suite only) whose MCP server runs with extra environment; the caller stops it. */
  openAgent?(label: string, env: Record<string, string>): Promise<{ agent: import("./agent.ts").Agent; stop(): Promise<void> }>;
  /** The disposable project on the host (bind-mounted read-write into the container). */
  project: string;
  /** Whitespace-normalized text of a corpus PDF, extracted on the host, for verbatim-excerpt checks. */
  sourceText(paper: "2411" | "2511"): string;
  /** Run a command inside the sandbox (project is the working directory). */
  shell(script: string, timeoutMs?: number): { status: number | null; stdout: string; stderr: string };
  hasKey(name: "SEMANTIC_SCHOLAR_API_KEY" | "OPENALEX_API_KEY"): boolean;
  /** Shared across cases (citekeys, pointers, tokens). */
  state: Map<string, unknown>;
  log(line: string): void;
}
export interface Case {
  id: string;
  tool: string;
  /** What documented behavior this case holds the product to. */
  contract: string;
  needs?: string[];
  run(ctx: Ctx): Promise<unknown>;
}

export const text = (r: CallResult): string => r.content.filter((c) => c.type === "text").map((c) => c.text ?? "").join("\n");
export const refused = (r: CallResult, code?: string): void => {
  assert.equal(r.isError, true, `expected a refusal, got: ${text(r).slice(0, 200)}`);
  assert.match(text(r), code === undefined ? /^Refused: [A-Z_]+/ : new RegExp(`^Refused: ${code}`), text(r).slice(0, 200));
};
export const ok = (r: CallResult) => {
  assert.notEqual(r.isError, true, text(r).slice(0, 400));
  assert.ok(r.structuredContent, "missing structuredContent");
  return r.structuredContent;
};
// The package strips C0 control characters (e.g. NUL that PDF extraction emits) from excerpts; whitespace is normalized on both sides.
const norm = (s: string): string => s.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, "").replace(/\s+/g, " ").trim();
const POINTER = /^10\.[^@\s]+@[0-9a-f]{16}#\d+-\d+$/;
const CITEKEY = /^[a-z][a-z0-9]+$/;
const bibKeys = (project: string): string[] => [...readFileSync(join(project, "refs/references.bib"), "utf8").matchAll(/^@\w+\{([^,\s]+),/gm)].map((m) => m[1] as string);
const providerDown = /UNAVAILABLE|PROVIDER|TIMEOUT|NETWORK|FETCH|HTTP/i;

/** An excerpt must be a verbatim span of the source (whitespace-normalized): quotation fidelity, not just shape. */
function assertVerbatim(ctx: Ctx, excerpt: string, doi: string): void {
  const src = norm(ctx.sourceText(doi === D1 ? "2411" : "2511"));
  assert.ok(src.includes(norm(excerpt)), `excerpt is not verbatim in the source PDF: "${norm(excerpt).slice(0, 120)}"`);
}

export const directCases: Case[] = [
  // ── paper_registry ───────────────────────────────────────────────────────────────────────────────────────────────
  {
    id: "registry.register-mixed",
    tool: "paper_registry",
    contract: "one ordered outcome per input; aliases register once (later ones duplicate); invalid input refused per item; provider-supplied citekeys; bibliography rendered",
    async run(ctx) {
      const r = ok(await ctx.mcp.call("paper_registry", { action: "register", identifiers: ["arxiv:2411.09996", "arxiv:2511.15162", `https://doi.org/${D1}`, "not-a-doi", NUMPY] }));
      const o = r.outcomes as Array<Record<string, any>>;
      assert.equal(o.length, 5);
      assert.deepEqual(o.map((x) => x.index), [0, 1, 2, 3, 4]);
      for (const i of [0, 1, 4]) if (o[i].status === "refused" && providerDown.test(String(o[i].refusalCode))) throw new Blocked(`provider unavailable for input ${i}: ${o[i].refusalCode}`);
      assert.deepEqual(o.map((x) => x.status), ["registered", "registered", "duplicate", "refused", "registered"]);
      assert.equal(o[2].duplicateOf, 0);
      assert.equal(typeof o[3].refusalCode, "string");
      assert.equal(o[3].citekey ?? null, null, "a refused input must not mint a citekey");
      for (const i of [0, 1, 4]) assert.match(o[i].citekey, CITEKEY);
      const keys = bibKeys(ctx.project);
      for (const i of [0, 1, 4]) assert.ok(keys.includes(o[i].citekey), `bibliography lacks ${o[i].citekey}`);
      ctx.state.set("citekeys", { [D1]: o[0].citekey, [D2]: o[1].citekey, [NUMPY]: o[4].citekey });
      return { citekeys: ctx.state.get("citekeys"), refusal: o[3].refusalCode };
    },
  },
  {
    id: "registry.register-refresh-stable",
    tool: "paper_registry",
    needs: ["registry.register-mixed"],
    contract: "a refresh keeps the pinned citekey and does not duplicate the bibliography entry",
    async run(ctx) {
      const keys = ctx.state.get("citekeys") as Record<string, string>;
      const r = ok(await ctx.mcp.call("paper_registry", { action: "register", identifiers: ["arxiv:2411.09996"] }));
      assert.notEqual(r.outcomes[0].status, "refused");
      assert.equal(r.outcomes[0].citekey, keys[D1]);
      assert.equal(bibKeys(ctx.project).filter((k) => k === keys[D1]).length, 1);
      return { status: r.outcomes[0].status };
    },
  },
  {
    id: "registry.read-fields-handles",
    tool: "paper_registry",
    needs: ["registry.register-mixed"],
    contract: "citekey-ordered records; requested fields only; unsupported fields refused; unknown handles reported unresolved",
    async run(ctx) {
      const all = ok(await ctx.mcp.call("paper_registry", { action: "read", fields: ["title", "authors", "abstract", "source"] }));
      assert.equal(all.total, 3);
      const ks = all.records.map((x: any) => x.citekey);
      assert.deepEqual(ks, [...ks].sort());
      for (const rec of all.records) { assert.equal(typeof rec.title, "string"); assert.ok(Array.isArray(rec.authors)); assert.equal(rec.bibtex, undefined, "an unrequested field was returned"); }
      refused(await ctx.mcp.call("paper_registry", { action: "read", fields: ["bogus"] }));
      const one = ok(await ctx.mcp.call("paper_registry", { action: "read", handles: [D1, "10.9999/not-registered"] }));
      assert.equal(one.records.length, 1);
      assert.equal(one.unresolved.length, 1);
      return { unresolved: one.unresolved };
    },
  },
  {
    id: "registry.attach-source",
    tool: "paper_registry",
    needs: ["registry.register-mixed"],
    contract: "attach a project PDF as a paper's source: readiness, revision and counts; the file is neither copied nor deleted; text never returned",
    async run(ctx) {
      const before = statSync(join(ctx.project, "papers/2411.09996.pdf")).size;
      const r = ok(await ctx.mcp.call("paper_registry", { action: "attach_source", attachments: [{ handle: D1, path: "papers/2411.09996.pdf" }, { handle: D2, path: "papers/2511.15162.pdf" }] }));
      for (const o of r.outcomes) { assert.equal(o.status, "attached"); assert.ok(o.source.revision && o.source.chunks > 0, JSON.stringify(o.source)); }
      assert.equal(statSync(join(ctx.project, "papers/2411.09996.pdf")).size, before);
      assert.ok(!text(await ctx.mcp.call("paper_registry", { action: "read", handles: [D1], fields: ["source"] })).includes("Masked Spectrogram Modeling (MSM)\nWe introduce"), "source text leaked through read");
      return r.outcomes.map((o: any) => ({ doi: o.doi, revision: o.source.revision, chunks: o.source.chunks }));
    },
  },
  {
    id: "registry.attach-refusals",
    tool: "paper_registry",
    needs: ["registry.attach-source"],
    contract: "attachment is confined to the project and identity-checked: outside paths, symlink escapes, missing files and a different paper's PDF are never attached",
    async run(ctx) {
      symlinkSync("/etc/passwd", join(ctx.project, "papers/escape.pdf"));
      const cases: Array<[string, string, string, string?]> = [
        ["absolute path", D1, "/etc/passwd", "PATH_REFUSED"],
        ["parent traversal", D1, "../outside.pdf", "PATH_REFUSED"],
        ["symlink escape", D1, "papers/escape.pdf", "PATH_REFUSED"],
        ["missing file", D1, "papers/missing.pdf"],
        ["other paper's pdf", D1, "papers/2511.15162.pdf"],
      ];
      const seen: Record<string, string> = {};
      for (const [label, handle, path, code] of cases) {
        const r = await ctx.mcp.call("paper_registry", { action: "attach_source", attachments: [{ handle, path }] });
        const o = r.structuredContent?.outcomes?.[0];
        assert.ok(r.isError === true || (o && o.status !== "attached"), `${label} was attached: ${text(r).slice(0, 200)}`);
        if (code !== undefined) assert.match(text(r) + JSON.stringify(o ?? {}), new RegExp(code), `${label}: ${text(r).slice(0, 200)}`);
        seen[label] = o?.refusalCode ?? o?.status ?? "refused";
      }
      return seen;
    },
  },
  {
    id: "registry.sync-bibliography-one-way",
    tool: "paper_registry",
    needs: ["registry.register-mixed"],
    contract: "sync re-renders refs/references.bib from the registry; human edits are never imported",
    async run(ctx) {
      const bib = join(ctx.project, "refs/references.bib");
      chmodSync(bib, 0o644); // the rendered file is read-only; a human edit is a deliberate chmod first
      writeFileSync(bib, `${readFileSync(bib, "utf8")}\n% HUMAN-EDIT-MARKER\n@misc{humanonly, title={Not in the registry}}\n`);
      const r = ok(await ctx.mcp.call("paper_registry", { action: "sync_bibliography" }));
      const after = readFileSync(bib, "utf8");
      assert.ok(!after.includes("HUMAN-EDIT-MARKER") && !after.includes("humanonly"), "a human edit was kept or imported");
      const keys = Object.values(ctx.state.get("citekeys") as Record<string, string>);
      assert.deepEqual(bibKeys(ctx.project).sort(), [...keys].sort());
      assert.equal(r.synced, keys.length);
      const again = readFileSync(bib, "utf8");
      ok(await ctx.mcp.call("paper_registry", { action: "sync_bibliography" }));
      assert.equal(readFileSync(bib, "utf8"), again, "sync is not idempotent");
      return { synced: r.synced };
    },
  },
  {
    id: "registry.unknown-action-refused",
    tool: "paper_registry",
    contract: "an unknown action is a typed refusal that names the valid actions",
    async run(ctx) {
      const r = await ctx.mcp.call("paper_registry", { action: "wipe" });
      refused(r, "ARGUMENT_INVALID");
      assert.match(text(r), /register, remove, read, attach_source, sync_bibliography/);
    },
  },

  // ── search_passages ──────────────────────────────────────────────────────────────────────────────────────────────
  {
    id: "passages.scoped-verbatim-pointers",
    tool: "search_passages",
    needs: ["registry.attach-source"],
    contract: "scoped retrieval: ≤ limit hits, only the scoped paper, exact doi@revision#start-end pointers, bounded verbatim excerpts, section metadata, labelled as retrieval not verification",
    async run(ctx) {
      const r = ok(await ctx.mcp.call("search_passages", { query: "masked spectrogram modeling", papers: [D1], limit: 3 }));
      assert.ok(r.hits.length >= 1 && r.hits.length <= 3);
      for (const h of r.hits) {
        assert.equal(h.doi, D1);
        assert.match(h.pointer, POINTER);
        assert.ok(h.excerpt === null || h.excerpt.length <= 1500);
        if (h.excerpt) assertVerbatim(ctx, h.excerpt, D1);
        assert.ok(h.section === null || typeof h.section === "string");
      }
      assert.ok(r.hits.some((h: any) => typeof h.section === "string" && h.section.length > 0), "no hit carried its section heading");
      assert.match(text(await ctx.mcp.call("search_passages", { query: "masked spectrogram modeling", papers: [D1], limit: 3 })), /not verification/i);
      ctx.state.set("passage-pointer", r.hits[0].pointer);
      return { mode: r.mode, hits: r.hits.length, first: r.hits[0].pointer };
    },
  },
  {
    id: "passages.all-papers-and-limits",
    tool: "search_passages",
    needs: ["registry.attach-source"],
    contract: "omitted scope searches the whole registry; limit bounds (1..10) are enforced as refusals",
    async run(ctx) {
      const r = ok(await ctx.mcp.call("search_passages", { query: "pretraining foundation model", limit: 10 }));
      assert.equal(r.coverage.papers.selected, 3);
      assert.equal(r.coverage.papers.searchable, 2, "the paper without a source is not searchable and must be reported as such");
      assert.equal(r.coverage.papers.notSearchable.length, 1);
      assert.ok(new Set(r.hits.map((h: any) => h.doi)).size >= 1);
      refused(await ctx.mcp.call("search_passages", { query: "x model", limit: 11 }));
      refused(await ctx.mcp.call("search_passages", { query: "x model", limit: 0 }));
      return { searchable: r.coverage.papers.searchable, notSearchable: r.coverage.papers.notSearchable };
    },
  },
  {
    id: "passages.hybrid-real-embeddings",
    tool: "search_passages",
    needs: ["registry.attach-source"],
    contract: "with the managed embedding runtime, search is hybrid (BM25 + vector fused)",
    async run(ctx) {
      const r = ok(await ctx.mcp.call("search_passages", { query: "how are radio signals tokenized for the transformer", papers: [D1, D2], limit: 5 }));
      assert.equal(r.mode, "hybrid", `mode ${r.mode}; limitations ${JSON.stringify(r.result.limitations)}`);
      assert.ok(r.hits.some((h: any) => h.found.includes("vector")), "no hit came from the vector ranking");
      return { found: r.hits.map((h: any) => h.found) };
    },
  },
  {
    id: "passages.embedding-failure-degrades",
    tool: "search_passages",
    needs: ["registry.attach-source"],
    contract: "a failing embedding server degrades to keyword results and says so",
    async run(ctx) {
      const s = await ctx.open("embed-down", { UKTUB_EMBED_URL: "http://127.0.0.1:9" });
      try {
        const r = ok(await s.call("search_passages", { query: "masked spectrogram modeling", papers: [D1], limit: 3 }));
        assert.notEqual(r.mode, "hybrid");
        assert.ok(r.hits.length > 0, "keyword results were not returned");
        assert.match(JSON.stringify(r.result.limitations) + text(await s.call("search_passages", { query: "masked spectrogram modeling", papers: [D1], limit: 3 })), /embed|keyword|lexical/i);
        return { mode: r.mode, limitations: r.result.limitations };
      } finally { await s.close(); }
    },
  },
  {
    id: "passages.no-match-and-unknown-handle",
    tool: "search_passages",
    needs: ["registry.attach-source"],
    contract: "no match is stated, not invented; an unknown handle is listed unresolved",
    async run(ctx) {
      const none = ok(await ctx.mcp.call("search_passages", { query: "zxqv blorptastic quuxification", papers: [D1], limit: 3 }));
      if (none.hits.length > 0) ctx.log(`nonsense query returned ${none.hits.length} hit(s) (hybrid retrieval may rank something); found=${none.result.found}`);
      assert.equal(none.result.found, none.hits.length > 0);
      const unk = ok(await ctx.mcp.call("search_passages", { query: "spectrogram", papers: [D1, "10.9999/not-registered"], limit: 2 }));
      assert.equal(unk.coverage.papers.unresolved.length, 1);
      return { nonsenseHits: none.hits.length };
    },
  },

  // ── verify_claim ─────────────────────────────────────────────────────────────────────────────────────────────────
  {
    id: "verify.argument-bounds",
    tool: "verify_claim",
    contract: "claim 8–2000 chars; empty scope refused (never read as all); papers and passages are exclusive; one of them is required",
    async run(ctx) {
      refused(await ctx.mcp.call("verify_claim", { claim: "short", papers: [D1] }));
      refused(await ctx.mcp.call("verify_claim", { claim: "x".repeat(2001), papers: [D1] }));
      refused(await ctx.mcp.call("verify_claim", { claim: HSD_CLAIM, papers: [] }));
      refused(await ctx.mcp.call("verify_claim", { claim: HSD_CLAIM }));
      refused(await ctx.mcp.call("verify_claim", { claim: HSD_CLAIM, papers: [D1], passages: [{ text: "something" }] }));
    },
  },
  {
    id: "verify.scoped-query-limited",
    tool: "verify_claim",
    needs: ["registry.attach-source"],
    contract: "an explicit scope with a query is reported query-limited (not exhaustive); supporting passages are verbatim with exact pointers; coverage keeps its four reports apart",
    async run(ctx) {
      const r = ok(await ctx.mcp.call("verify_claim", { claim: HSD_CLAIM, papers: [D1], query: "HSD dataset human activities" }));
      assert.notEqual(r.result.searched, "exhaustive");
      assert.match(text(await ctx.mcp.call("verify_claim", { claim: HSD_CLAIM, papers: [D1], query: "HSD dataset human activities" })), /query-limited/i);
      for (const k of ["sources", "candidates", "work", "output"]) assert.ok(r.coverage[k], `coverage.${k} missing`);
      assert.equal(r.result.supportFound, true, "the paper states six activities including running and boxing");
      for (const e of r.evidence) { assert.match(e.pointer, POINTER); assert.ok(e.excerpt === null || e.excerpt.length <= 1500); if (e.excerpt) assertVerbatim(ctx, e.excerpt, e.doi); assert.equal(e.doi, D1); }
      ctx.state.set("evidence-pointer", r.evidence[0].pointer);
      return { searched: r.result.searched, complete: r.result.complete, evidence: r.evidence.length, checked: r.coverage.work.checked };
    },
  },
  {
    id: "verify.exhaustive-continuation",
    tool: "verify_claim",
    needs: ["registry.attach-source"],
    contract: "all-papers verification is exhaustive; an interrupted run is resumed with its token until work completes; each evidence record is delivered once; a source-less paper is reported unavailable; a token cannot be reused for a changed claim/scope or invented",
    async run(ctx) {
      const base = { claim: HSD_CLAIM, papers: "all" } as const;
      let r = ok(await ctx.mcp.call("verify_claim", base));
      assert.equal(r.result.searched, "exhaustive");
      // Papers registered without an attached file are acquired automatically (OpenAlex) at verify time; whichever way each one
      // went, the source accounting must add up: selected = ready + unavailable + unresolved.
      const src = r.coverage.sources;
      assert.equal(src.selected, src.ready + src.unavailable.length + src.unresolved.length, JSON.stringify(src));
      assert.ok(src.selected >= 3, "all registered papers must be selected");
      for (const u of src.unavailable) assert.ok(u.reason ?? u.code, `an unavailable source lacks its reason: ${JSON.stringify(u)}`);
      const pointers: string[] = r.evidence.map((e: any) => e.pointer);
      let pages = 1;
      if (!r.continuation) throw new NotRun(`the first call completed all ${r.coverage.candidates.total} passages without interruption (max_judgments policy not binding), so continuation was not exercised`);
      {
        const token = r.continuation as string;
        refused(await ctx.mcp.call("verify_claim", { ...base, claim: `${HSD_CLAIM} Additionally it is large.`, continuation: token }));
        refused(await ctx.mcp.call("verify_claim", { ...base, papers: [D1, D2], continuation: token }));
        refused(await ctx.mcp.call("verify_claim", { ...base, continuation: "bogus-token" }));
        ctx.state.set("first-token", token);
      }
      while (r.continuation && pages < 8) {
        r = ok(await ctx.mcp.call("verify_claim", { ...base, continuation: r.continuation }));
        pages += 1;
        pointers.push(...r.evidence.map((e: any) => e.pointer));
      }
      assert.equal(r.coverage.work.complete, true, `work incomplete after ${pages} page(s): ${JSON.stringify(r.coverage.work.interruption)}`);
      assert.equal(r.coverage.work.unchecked, 0);
      assert.equal(new Set(pointers).size, pointers.length, "an evidence record was delivered twice");
      ctx.state.set("exhaustive-support", pointers.length);
      return { pages, evidenceTotal: pointers.length, candidates: r.coverage.candidates.total, sawInterruption: ctx.state.has("first-token") };
    },
  },
  {
    id: "verify.supplied-text",
    tool: "verify_claim",
    contract: "supplied text is judged without paper attribution; a mismatching claim finds no support (never a refutation)",
    async run(ctx) {
      const sentence = "The experiment uses exactly three antennas.";
      const yes = ok(await ctx.mcp.call("verify_claim", { claim: sentence, passages: [{ text: sentence }] }));
      assert.equal(yes.result.supportFound, true);
      for (const e of yes.evidence) assert.ok(!e.doi || e.attested === false, `supplied text was attributed to ${e.doi}`);
      const no = await ctx.mcp.call("verify_claim", { claim: "The experiment uses exactly seven antennas.", passages: [{ text: sentence }] });
      assert.equal(ok(no).result.supportFound, false);
      const sansDisclaimer = text(no).replace(/[^.\n]*not evidence that the claim is false[^.\n]*\.?/i, "");
      assert.match(text(no), /not evidence that the claim is false/i, "the no-support disclaimer is missing");
      assert.doesNotMatch(sansDisclaimer, /\brefut|\bcontradict|\bis false\b|\bdisproved?\b/i, "no-support was presented as refutation");
    },
  },
  {
    id: "verify.direct-pointer",
    tool: "verify_claim",
    needs: ["verify.scoped-query-limited"],
    contract: "a direct source must be a pointer this package issued, at its current revision; invented or altered pointers are refused",
    async run(ctx) {
      const pointer = ctx.state.get("evidence-pointer") as string;
      const good = ok(await ctx.mcp.call("verify_claim", { claim: HSD_CLAIM, passages: [{ source: pointer }] }));
      assert.equal(good.result.supportFound, true);
      const [doi, rest] = pointer.split("@") as [string, string];
      const [rev, span] = rest.split("#") as [string, string];
      const flipped = `${doi}@${rev.replace(/.$/, rev.endsWith("0") ? "1" : "0")}#${span}`;
      // A stale or unresolvable pointer must never be judged as if it were current text: it is refused, or reported "not judged".
      const notJudged: string[] = [];
      for (const source of [flipped, `${doi}@${rev}#0-99999999`]) {
        const r = await ctx.mcp.call("verify_claim", { claim: HSD_CLAIM, passages: [{ source }] });
        if (r.isError) { refused(r); notJudged.push("refused"); continue; }
        assert.equal(r.structuredContent.result.supportFound, false, `an altered pointer produced support: ${source}`);
        assert.match(text(r), /stale|not judged|unresolv|unknown/i, `an altered pointer was silently accepted: ${text(r).slice(0, 300)}`);
        notJudged.push(`reported: ${(/direct #0[^\n]*/.exec(text(r)) ?? [""])[0]}`);
      }
      ctx.log(`NOTE altered-pointer outcomes: ${JSON.stringify(notJudged)}`);
      return { alteredPointers: notJudged };
    },
  },
  {
    id: "verify.engine-unavailable",
    tool: "verify_claim",
    needs: ["registry.attach-source"],
    contract: "an unavailable verification engine is a typed refusal naming the cause, not a silent empty result",
    async run(ctx) {
      const s = await ctx.open("engine-down", { UKTUB_EOS_PYTHON: "/nonexistent/python" });
      try {
        // A claim no earlier case judged: a cached judgment is reused without starting any engine.
        const r = await s.call("verify_claim", { claim: "The masked autoencoder reconstructs spectrogram patches that were hidden from the encoder.", papers: [D1], query: "masked patches reconstruction" });
        refused(r);
        return { refusal: text(r).slice(0, 200) };
      } finally { await s.close(); }
    },
  },
  {
    id: "verify.cancellation-recovers",
    tool: "verify_claim",
    needs: ["registry.attach-source"],
    contract: "cancelling a long verification stops it and leaves the server usable",
    async run(ctx) {
      const ac = new AbortController();
      const claim = "Transformer encoders are pretrained on unlabeled radio spectrograms before fine-tuning.";
      const started = Date.now();
      const pending = ctx.mcp.call("verify_claim", { claim, papers: "all" }, { signal: ac.signal });
      setTimeout(() => ac.abort(), 6000);
      const outcome = await pending.then((r) => ({ finished: true as const, r }), (e: Error) => ({ finished: false as const, e }));
      if (outcome.finished) throw new NotRun(`the verification finished in ${Date.now() - started} ms before it could be cancelled`);
      const after = ok(await ctx.mcp.call("verify_claim", { claim: HSD_CLAIM, papers: [D1], query: "HSD dataset" }));
      assert.ok(after.coverage.work.checked >= 1);
      return { cancelledAfterMs: Date.now() - started, error: outcome.e.message.slice(0, 100) };
    },
  },

  // ── compile_document ─────────────────────────────────────────────────────────────────────────────────────────────
  {
    id: "compile.genuine-error",
    tool: "compile_document",
    contract: "a genuine LaTeX error is reported with its location and no PDF",
    async run(ctx) {
      writeFileSync(join(ctx.project, "manuscript/main.tex"), "\\documentclass{article}\n\\begin{document}\n\\undefinedlivecommand\n\\end{document}\n");
      const r = ok(await ctx.mcp.call("compile_document", {}));
      assert.equal(r.status, "errors");
      assert.equal(r.pdfPath, null);
      assert.ok(r.diagnostics.some((d: any) => d.severity === "error" && d.line === 3), JSON.stringify(r.diagnostics));
    },
  },
  {
    id: "compile.error-not-crowded-out-by-warnings",
    tool: "compile_document",
    contract: "a real error that follows more warnings than the diagnostics cap is still reported with its location; a failed compile never reads as '0 error(s)'",
    async run(ctx) {
      // Found live (experiment iter-12): >50 Overfull \\hbox warnings printed before the one error pushed it out of the result.
      const overfull = Array.from({ length: 70 }, (_, i) => `\\noindent\\hbox to 1pt{overfullwordnumber${i}}\\par`).join("\n");
      writeFileSync(join(ctx.project, "manuscript/main.tex"), `\\documentclass{article}\n\\begin{document}\n${overfull}\n\\undefinedlivecommand\n\\end{document}\n`);
      const call = await ctx.mcp.call("compile_document", {});
      const r = ok(call);
      assert.equal(r.status, "errors", JSON.stringify(r.diagnostics).slice(0, 300));
      const warnings = r.diagnostics.filter((d: any) => d.severity === "warning").length;
      assert.ok(warnings >= 40, `the scenario must exceed the cap with warnings first (got ${warnings} warnings)`);
      assert.ok(r.diagnostics.some((d: any) => d.severity === "error" && /Undefined control sequence/.test(d.message)), "the real error was dropped");
      assert.doesNotMatch(text(call), /\b0 error\(s\)/);
      return { diagnostics: r.diagnostics.length, warnings };
    },
  },
  {
    id: "compile.fix-recompile-warnings-disclosed",
    tool: "compile_document",
    needs: ["registry.sync-bibliography-one-way"],
    contract: "after the final edit the build produces a PDF; warnings are listed, never summarized as a clean build",
    async run(ctx) {
      const keys = Object.entries(ctx.state.get("citekeys") as Record<string, string>).filter(([d]) => d !== NUMPY).map(([, k]) => k);
      writeFileSync(join(ctx.project, "manuscript/main.tex"), `\\documentclass{article}\n\\begin{document}\nRelated work \\cite{${keys.join(",")}}.\n\\bibliographystyle{plain}\n\\bibliography{../refs/references}\n\\end{document}\n`);
      const call = await ctx.mcp.call("compile_document", {});
      const r = ok(call);
      assert.equal(r.status, "compiled", JSON.stringify(r.diagnostics));
      const pdf = join(ctx.project, r.pdfPath);
      assert.ok(existsSync(pdf));
      assert.equal(statSync(pdf).size, r.pdfSizeBytes);
      assert.ok(statSync(pdf).mtimeMs >= statSync(join(ctx.project, "manuscript/main.tex")).mtimeMs, "the PDF predates the final manuscript edit");
      const warnings = r.diagnostics.filter((d: any) => d.severity === "warning");
      if (warnings.length > 0) { assert.match(text(call), /warning/i); assert.doesNotMatch(text(call), /\bclean build\b|no warnings/i); }
      return { engine: r.engine, warnings: warnings.length, pdfBytes: r.pdfSizeBytes };
    },
  },
  {
    id: "compile.entry-selection",
    tool: "compile_document",
    contract: "an explicit entry compiles that file; an entry outside the project or missing is not compiled",
    async run(ctx) {
      writeFileSync(join(ctx.project, "manuscript/other.tex"), "\\documentclass{article}\n\\begin{document}\nOther entry.\n\\end{document}\n");
      const r = ok(await ctx.mcp.call("compile_document", { entry: "manuscript/other.tex" }));
      assert.equal(r.status, "compiled");
      assert.equal(r.entry, "manuscript/other.tex");
      for (const entry of ["../outside.tex", "manuscript/missing.tex"]) {
        const bad = await ctx.mcp.call("compile_document", { entry });
        assert.ok(bad.isError === true || bad.structuredContent?.status !== "compiled", `${entry} compiled`);
      }
    },
  },
  {
    id: "compile.ambiguous-entry-refusal",
    tool: "compile_document",
    contract: "with no manuscript/main.tex and several top-level .tex files, a call without entry is refused (naming the candidates) and writes nothing; an explicit entry still compiles",
    async run(ctx) {
      // Self-contained: whatever earlier cases left, end with manuscript/main.tex absent and two named candidates (other.tex may also exist).
      const main = join(ctx.project, "manuscript/main.tex");
      const moved = join(ctx.project, "manuscript/renamed-main.tex");
      const backup = join(ctx.project, "manuscript/main.tex.bak"); // not a .tex file, so never an entry candidate
      const hadMain = existsSync(main);
      if (hadMain) renameSync(main, backup);
      writeFileSync(moved, "\\documentclass{article}\n\\begin{document}\nRenamed entry.\n\\end{document}\n"); // always a valid document, whatever an earlier case left
      writeFileSync(join(ctx.project, "manuscript/other.tex"), "\\documentclass{article}\n\\begin{document}\nOther entry.\n\\end{document}\n");
      try {
        const pdfsBefore = existsSync(join(ctx.project, "build")) ? readdirSync(join(ctx.project, "build")).sort() : [];
        const r = await ctx.mcp.call("compile_document", {});
        refused(r, "COMPILE_NO_ENTRY");
        assert.match(text(r), /multiple \.tex entries/);
        assert.match(text(r), /renamed-main\.tex/);
        assert.match(text(r), /other\.tex/);
        const pdfsAfter = existsSync(join(ctx.project, "build")) ? readdirSync(join(ctx.project, "build")).sort() : [];
        assert.deepEqual(pdfsAfter, pdfsBefore, "a refused compile must not write to build/");
        const explicit = ok(await ctx.mcp.call("compile_document", { entry: "manuscript/renamed-main.tex" }));
        assert.equal(explicit.status, "compiled", JSON.stringify(explicit.diagnostics));
        return { refusal: text(r).split("\n")[0], explicitEntry: explicit.entry };
      } finally {
        rmSync(moved, { force: true });
        if (hadMain) renameSync(backup, main);
      }
    },
  },

  // ── search_papers ────────────────────────────────────────────────────────────────────────────────────────────────
  {
    id: "search.title-query",
    tool: "search_papers",
    contract: "free-text search returns normalized candidates within the requested limit; provider failures are warnings",
    async run(ctx) {
      const r = ok(await ctx.mcp.call("search_papers", { query: "Building 6G Radio Foundation Models with Transformer Architectures", limit: 5 }));
      assert.ok(r.candidates.length >= 1 && r.candidates.length <= 5);
      assert.equal(r.requested, 5);
      for (const c of r.candidates) { assert.equal(typeof c.title, "string"); assert.match(c.doi, /^10\./); }
      // Match on the title, not a DOI: the same paper is indexed under different DOIs by different providers (arXiv vs the IEEE version).
      const want = "building 6g radio foundation models with transformer";
      const found = r.candidates.some((c: any) => String(c.title).toLowerCase().startsWith(want));
      if (!found && r.warnings.length > 0) throw new Blocked(`the exact-title paper was not returned while ${r.warnings.map((w: any) => w.provider).join(", ")} failed (${r.warnings.map((w: any) => w.code).join(", ")}): relevance cannot be judged`);
      assert.ok(found, "the exact-title paper was not among the candidates");
      return { warnings: r.warnings.map((w: any) => `${w.provider}:${w.code}`), top: r.candidates[0].doi };
    },
  },
  {
    id: "search.limits-and-identifier",
    tool: "search_papers",
    needs: ["registry.register-mixed"],
    contract: "limit is clamped into 1..20; a DOI-shaped query searches (never registers)",
    async run(ctx) {
      // search_papers CLAMPS to [1, 20] (documented "cap 20"; scholarly.ts), unlike search_passages which refuses.
      const over = ok(await ctx.mcp.call("search_papers", { query: "radio foundation model", limit: 21 }));
      assert.ok(over.returned <= 20 && over.requested === 20, `requested ${over.requested}, returned ${over.returned}`);
      const under = ok(await ctx.mcp.call("search_papers", { query: "radio foundation model", limit: 0 }));
      assert.ok(under.returned <= 1 && under.requested === 1, `requested ${under.requested}, returned ${under.returned}`);
      ctx.log(`NOTE search_papers limit 21 is reported as "requested ${over.requested}": the caller's value is clamped silently`);
      const before = ok(await ctx.mcp.call("paper_registry", { action: "read" })).total;
      const r = await ctx.mcp.call("search_papers", { query: NUMPY, limit: 3 });
      assert.notEqual(r.isError, true, text(r).slice(0, 200));
      assert.equal(ok(await ctx.mcp.call("paper_registry", { action: "read" })).total, before, "a search changed the registry");
    },
  },
  {
    id: "search.nonsense-query",
    tool: "search_papers",
    contract: "a query with no real matches is answered honestly (no crash, counts consistent)",
    async run(ctx) {
      const r = await ctx.mcp.call("search_papers", { query: "zxqv blorptastic quuxification 77413", limit: 5 });
      if (r.isError) { refused(r, "SEARCH_UNAVAILABLE"); throw new Blocked("all providers failed for the nonsense query"); }
      assert.equal(r.structuredContent.returned, r.structuredContent.candidates.length);
      return { returned: r.structuredContent.returned };
    },
  },
  {
    id: "search.semantic-scholar-authenticated",
    tool: "search_papers",
    contract: "with SEMANTIC_SCHOLAR_API_KEY, three-way fusion answers without a semantic-scholar warning",
    async run(ctx) {
      if (!ctx.hasKey("SEMANTIC_SCHOLAR_API_KEY")) throw new NotRun("no SEMANTIC_SCHOLAR_API_KEY on this host: authenticated S2 path not exercised");
      const r = ok(await ctx.mcp.call("search_papers", { query: "masked spectrogram modeling wireless", limit: 5 }));
      assert.ok(!r.warnings.some((w: any) => w.provider === "semantic-scholar"), JSON.stringify(r.warnings));
    },
  },

  // ── registry state changes last (they invalidate earlier state) ──────────────────────────────────────────────────
  {
    id: "registry.cursors-paging-stale",
    tool: "paper_registry",
    needs: ["registry.register-mixed"],
    contract: "a cursor continues the same request; malformed, foreign-field and stale cursors are typed refusals",
    async run(ctx) {
      const first = ok(await ctx.mcp.call("paper_registry", { action: "read", limit: 1 }));
      assert.equal(first.records.length, 1);
      assert.ok(first.nextCursor);
      const second = ok(await ctx.mcp.call("paper_registry", { action: "read", limit: 1, cursor: first.nextCursor }));
      assert.notEqual(second.records[0].citekey, first.records[0].citekey);
      for (const bad of ["bnVsbA", "W10", "MTIz", "!!notbase64!!", ""]) refused(await ctx.mcp.call("paper_registry", { action: "read", limit: 1, cursor: bad }), "CONTINUATION_INVALID");
      refused(await ctx.mcp.call("paper_registry", { action: "read", limit: 1, fields: ["abstract"], cursor: first.nextCursor }), "CONTINUATION_INVALID");
      ok(await ctx.mcp.call("paper_registry", { action: "remove", handles: [NUMPY] }));
      refused(await ctx.mcp.call("paper_registry", { action: "read", limit: 1, cursor: first.nextCursor }), "CONTINUATION_INVALID");
      ctx.state.set("numpy-removed", true);
    },
  },
  {
    id: "registry.remove-explicit-only",
    tool: "paper_registry",
    needs: ["registry.cursors-paging-stale"],
    contract: "remove acts on explicit handles only (removed/duplicate/absent/refused per input); there is no remove-all; bibliography re-rendered",
    async run(ctx) {
      const keys = ctx.state.get("citekeys") as Record<string, string>;
      const before = ok(await ctx.mcp.call("paper_registry", { action: "read" })).total;
      refused(await ctx.mcp.call("paper_registry", { action: "remove", handles: [] }));
      const all = await ctx.mcp.call("paper_registry", { action: "remove", handles: ["all"] });
      assert.ok(all.isError === true || all.structuredContent.outcomes[0].status !== "removed", "'all' removed something");
      assert.equal(ok(await ctx.mcp.call("paper_registry", { action: "read" })).total, before);
      const r = ok(await ctx.mcp.call("paper_registry", { action: "remove", handles: [D2, keys[D2] as string, "not-registered"] }));
      assert.deepEqual(r.outcomes.map((o: any) => o.status), ["removed", "duplicate", "absent"]);
      assert.equal(ok(await ctx.mcp.call("paper_registry", { action: "read" })).total, before - 1);
      assert.ok(!bibKeys(ctx.project).includes(keys[D2] as string), "the removed paper is still in the bibliography");
      assert.ok(existsSync(join(ctx.project, "papers/2511.15162.pdf")), "remove deleted the user's PDF");
    },
  },

  // ── CLI / process surfaces ───────────────────────────────────────────────────────────────────────────────────────
  {
    id: "cli.exit-contracts-and-init",
    tool: "cli",
    contract: "unknown command exits non-zero with usage; init is idempotent and keeps the registry; nested projects are refused; list reads the registry",
    async run(ctx) {
      const cli = "node /opt/stage/node_modules/uktub-scholar/bin/uktub-scholar.js";
      const bad = ctx.shell(`${cli} nosuchcommand`);
      assert.notEqual(bad.status, 0);
      assert.match(bad.stdout + bad.stderr, /usage/i);
      const list = ctx.shell(`${cli} list`);
      assert.equal(list.status, 0, list.stderr);
      const keys = Object.values(ctx.state.get("citekeys") as Record<string, string>);
      assert.ok(list.stdout.includes(keys[0] as string));
      const reinit = ctx.shell(`${cli} init`);
      assert.equal(reinit.status, 0, reinit.stderr + reinit.stdout);
      assert.equal(ok(await ctx.mcp.call("paper_registry", { action: "read" })).total >= 1, true, "init emptied the registry");
      const nested = ctx.shell(`mkdir -p papers/sub && cd papers/sub && ${cli} init`);
      assert.notEqual(nested.status, 0, "a nested project was created");
      return { nestedRefusal: (nested.stderr + nested.stdout).trim().slice(0, 120) };
    },
  },
  {
    id: "cli.mcp-install-preserves-and-handshakes",
    tool: "cli",
    contract: "mcp install keeps other servers, is idempotent, and the written command completes a real MCP handshake",
    async run(ctx) {
      const cli = "node /opt/stage/node_modules/uktub-scholar/bin/uktub-scholar.js";
      const r = ctx.shell(`mkdir -p /tmp/h && cd /tmp/h && printf '%s' '{"mcpServers":{"other":{"command":"x","args":[]}},"keep":1}' > .mcp.json && ${cli} mcp install --host pi >/dev/null && cp .mcp.json first.json && ${cli} mcp install --host pi >/dev/null && cmp .mcp.json first.json && node -e 'const c=JSON.parse(require("fs").readFileSync(".mcp.json","utf8"));if(!c.mcpServers.other||c.keep!==1)process.exit(3);const s=c.mcpServers["uktub-scholar"];console.log(JSON.stringify([s.command,...s.args]))' > cmd.json && cat cmd.json`);
      assert.equal(r.status, 0, r.stderr + r.stdout);
      const [command, ...args] = JSON.parse(r.stdout.trim().split("\n").pop() as string) as string[];
      const hs = ctx.shell(`printf '%s\\n' '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"cli","version":"1"}}}' | timeout 20 ${command} ${args.map((a) => `'${a}'`).join(" ")}`);
      assert.match(hs.stdout, /"serverInfo"/, hs.stderr);
    },
  },
  {
    id: "process.embedding-server-cleanup",
    tool: "process",
    needs: ["registry.attach-source"],
    contract: "the supervised embedding server ends with its host process, including after SIGKILL",
    async run(ctx) {
      const cli = "node /opt/stage/node_modules/uktub-scholar/bin/uktub-scholar.js";
      const count = `count() { n=0; for p in /proc/[0-9]*; do tr '\\0' ' ' < $p/cmdline 2>/dev/null | grep -q '[l]lama-server' && n=$((n+1)); done; echo $n; }`;
      const r = ctx.shell(`${count}; ${cli} search "masked spectrogram" >/dev/null 2>&1; sleep 2; echo normal-exit-leftovers=$(count); (${cli} search "pretraining transformer" >/dev/null 2>&1 & p=$!; for i in $(seq 1 40); do [ "$(count)" -gt 0 ] && break; sleep 0.25; done; echo started=$(count); kill -9 $p; sleep 4; echo killed-leftovers=$(count))`, 180000);
      const n = (k: string) => Number(new RegExp(`${k}=(\\d+)`).exec(r.stdout)?.[1] ?? NaN);
      assert.equal(n("normal-exit-leftovers"), 0, r.stdout);
      if (n("started") === 0) throw new NotRun("the embedding server was not observed running before SIGKILL; kill-path cleanup unproven");
      assert.equal(n("killed-leftovers"), 0, r.stdout);
      return r.stdout.trim();
    },
  },
  {
    id: "verify.acquires-open-copies-beyond-openalex-pdf-url",
    tool: "verify_claim",
    contract: "papers whose OpenAlex record has no pdf_url still get a source from an arXiv copy or a Semantic Scholar preprint; a preprint of a differently-DOI'd work is disclosed",
    async run(ctx) {
      // The three papers that ended `no_open_copy` in experiment iter-12: an arXiv DOI with only a DOI landing page in OpenAlex, a gold-OA
      // IEEE Open Journal paper (landing page only), and a closed IEEE Letters paper whose arXiv preprint only Semantic Scholar names.
      const ARXIV = "10.48550/arxiv.2511.15162";
      const OJ = "10.1109/ojcoms.2025.3600616";
      const LWC = "10.1109/lwc.2026.3664439";
      const reg = ok(await ctx.mcp.call("paper_registry", { action: "register", identifiers: [ARXIV, OJ, LWC] }));
      for (const [i, o] of (reg.outcomes as Array<Record<string, any>>).entries()) if (o.status === "refused") throw new Blocked(`registration refused for input ${i}: ${o.refusalCode}`);
      const claim = "The paper concerns radio or wireless signal processing.";
      const r = ok(await ctx.mcp.call("verify_claim", { claim, papers: [ARXIV, OJ, LWC], query: "wireless" }));
      const read = ok(await ctx.mcp.call("paper_registry", { action: "read", handles: [ARXIV, OJ, LWC], fields: ["source"] }));
      const kind: Record<string, string> = {};
      for (const rec of read.records) kind[rec.doi] = `${rec.source?.status}:${rec.source?.kind}`;
      assert.equal(kind[ARXIV], "ready:arxiv-pdf", JSON.stringify(kind));
      const viaS2 = [OJ, LWC];
      if (!ctx.hasKey("SEMANTIC_SCHOLAR_API_KEY") && viaS2.some((d) => !String(kind[d]).startsWith("ready:"))) throw new NotRun(`no SEMANTIC_SCHOLAR_API_KEY: the Semantic Scholar tier was not reliably exercised (${JSON.stringify(kind)})`);
      for (const d of viaS2) assert.equal(kind[d], "ready:arxiv-preprint-pdf", `${d}: ${JSON.stringify(kind)}`);
      assert.equal(r.coverage.sources.ready, 3, JSON.stringify(r.coverage.sources));
      assert.equal(r.coverage.sources.preprint.length, 2, JSON.stringify(r.coverage.sources));
      assert.match(text(await ctx.mcp.call("verify_claim", { claim, papers: [OJ, LWC], query: "wireless" })), /preprint: [^\n]*may differ from the published version/);
      return kind;
    },
  },
  {
    id: "verify.acquires-pubmed-central-copy",
    tool: "verify_claim",
    contract: "a paper whose OpenAlex record has only a DOI landing page still gets its source from PubMed Central (found through Europe PMC, fetched from the PMC open-data bucket), keyless, with its licence",
    async run(ctx) {
      // eLife paper: OpenAlex lists no pdf_url and an oa_url that is a doi.org link; Europe PMC knows its PMCID and the PMC open-data bucket holds the PDF.
      // (europepmc.org's own ?pdf=render link answers scripted clients with a Cloudflare challenge, so it is never fetched.)
      const EL = "10.7554/elife.65360";
      const reg = ok(await ctx.mcp.call("paper_registry", { action: "register", identifiers: [EL] }));
      if (reg.outcomes[0].status === "refused") throw new Blocked(`registration refused: ${reg.outcomes[0].refusalCode}`);
      const r = ok(await ctx.mcp.call("verify_claim", { claim: "The study reports a result about cell biology.", papers: [EL], query: "cells" }));
      const read = ok(await ctx.mcp.call("paper_registry", { action: "read", handles: [EL], fields: ["source"] }));
      const src = read.records[0].source;
      assert.equal(src.status, "ready", JSON.stringify({ src, sources: r.coverage.sources }));
      assert.equal(src.kind, "pmc-pdf", JSON.stringify(src));
      assert.match(String(src.ref), /^https:\/\/pmc-oa-opendata\.s3\.amazonaws\.com\/PMC\d+\.\d+\/PMC\d+\.\d+\.pdf$/);
      assert.equal(src.license, "CC BY");
      assert.equal(r.coverage.sources.preprint.length, 0, "a PMC copy is not a preprint of another version");
      return { kind: src.kind, ref: src.ref };
    },
  },
  {
    id: "registry.bibliography-is-read-only-on-disk",
    tool: "paper_registry",
    contract: "the rendered refs/references.bib has no write bit, so an editor or agent write fails; the next registry write still replaces it",
    async run(ctx) {
      const bib = "refs/references.bib";
      const perms = ctx.shell(`stat -c %a ${bib}; echo invented >> ${bib}; echo write-exit=$?; stat -c %a ${bib}`);
      assert.match(perms.stdout, /^444\n/, perms.stdout + perms.stderr);
      assert.match(perms.stdout, /write-exit=[1-9]/, "the append must fail");
      assert.doesNotMatch(readFileSync(join(ctx.project, bib), "utf8"), /^invented$/m);
      const again = ok(await ctx.mcp.call("paper_registry", { action: "sync_bibliography" }));
      assert.ok(again.synced >= 1);
      assert.equal(ctx.shell(`stat -c %a ${bib}`).stdout.trim(), "444");
      return perms.stdout.trim().split("\n");
    },
  },
  {
    id: "registry.acquire-hook-and-action",
    tool: "paper_registry",
    contract: "registering a paper starts its open-access acquisition in the background (typed status acquiring, then ready, without another call); `acquire` is the explicit form and reports a typed status per paper",
    async run(ctx) {
      // Its own server process with the hook ON (the main session has it off so other cases see deterministic source states).
      const hook = await ctx.open("hook", { UKTUB_ACQUIRE_ON_REGISTER: "1" });
      try {
        const A = "10.48550/arxiv.1706.03762";
        const B = "10.1371/journal.pone.0255412";
        const reg = ok(await hook.call("paper_registry", { action: "register", identifiers: [A, B] }));
        for (const [i, o] of (reg.outcomes as Array<Record<string, any>>).entries()) if (o.status === "refused") throw new Blocked(`registration refused for input ${i}: ${o.refusalCode}`);
        assert.deepEqual(reg.outcomes.map((o: any) => o.source.status), ["acquiring", "acquiring"]);
        const started = Date.now();
        let kinds: Record<string, string> = {};
        while (Date.now() - started < 120000) {
          const read = ok(await hook.call("paper_registry", { action: "read", handles: [A, B], fields: ["source"] }));
          kinds = Object.fromEntries(read.records.map((r: any) => [r.doi, `${r.source.status}:${r.source.kind ?? ""}`]));
          if (Object.values(kinds).every((k) => k.startsWith("ready:"))) break;
          await new Promise((r) => setTimeout(r, 2000));
        }
        assert.ok(Object.values(kinds).every((k) => k.startsWith("ready:")), `the background acquisition did not finish in 120 s: ${JSON.stringify(kinds)}`);
        const again = ok(await hook.call("paper_registry", { action: "acquire", handles: [A, B, "10.9999/not-registered"] }));
        assert.deepEqual(again.outcomes.map((o: any) => o.status), ["ready", "ready", "absent"]);
        return { kinds, seconds: Math.round((Date.now() - started) / 1000) };
      } finally {
        await hook.close();
      }
    },
  },
  {
    id: "compile.multi-file-input",
    tool: "compile_document",
    contract: "a manuscript that \\input's a file in a subfolder compiles, and an error inside the included file is reported with that file and line",
    async run(ctx) {
      mkdirSync(join(ctx.project, "manuscript/multi/sections"), { recursive: true });
      writeFileSync(join(ctx.project, "manuscript/multi/main.tex"), "\\documentclass{article}\n\\begin{document}\nBefore.\n\\input{sections/intro}\nAfter.\n\\end{document}\n");
      writeFileSync(join(ctx.project, "manuscript/multi/sections/intro.tex"), "Introduction text from an included file.\n");
      const entry = "manuscript/multi/main.tex";
      const good = ok(await ctx.mcp.call("compile_document", { entry }));
      assert.equal(good.status, "compiled", JSON.stringify(good.diagnostics));
      writeFileSync(join(ctx.project, "manuscript/multi/sections/intro.tex"), "Line one.\n\\undefinedincludedcommand\n");
      const bad = ok(await ctx.mcp.call("compile_document", { entry }));
      assert.equal(bad.status, "errors");
      const err = bad.diagnostics.find((d: any) => d.severity === "error" && /Undefined control sequence/.test(d.message));
      assert.ok(err, JSON.stringify(bad.diagnostics));
      assert.match(String(err.file), /intro\.tex$/, `the error should name the included file, got ${err.file}`);
      assert.equal(err.line, 2);
      return { includedFile: err.file, line: err.line };
    },
  },
];
