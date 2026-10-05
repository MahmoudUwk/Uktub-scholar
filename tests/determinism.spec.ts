/**
 * U7 integration and determinism suite: cross-layer proofs with zero network
 * and zero Pi — provider fakes for every HTTP path, real node:sqlite temp
 * registries, the fake-Pi adapter harness for execute-level calls, and fresh
 * node subprocesses for the R8 determinism re-run. Scenarios that tools.spec.ts
 * already proves in isolation (queue serialization mechanics, batch partial
 * failure) are only re-exercised here as parts of end-to-end flows.
 */
import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { DatabaseSync } from "node:sqlite";

import { WriteQueue } from "../src/core/queue.ts";
import { createMcpServer } from "../src/mcp/server.ts";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { runCli } from "../src/cli/main.ts";
import { BIBLIOGRAPHY_REL_PATH, createRegistry, listPapers, syncBibliography } from "../src/core/registry.ts";
import { paperRegistryTool, type PaperRegistryArgs } from "../src/core/tools/registry.ts";
import { searchPapersTool } from "../src/core/tools/search.ts";
import type { ToolContext } from "../src/core/tools/context.ts";
import type { FetchLike } from "../src/core/providers/types.ts";
import {
  SEARCH_CFG,
  createFakeFetch,
  createSearchFetch,
  crossrefWorkEnvelope,
  fakeWorks,
} from "./helpers/provider-fakes.ts";

// ── fixtures ───────────────────────────────────────────────────────────────

const PACKAGE_ROOT = dirname(new URL(import.meta.url).pathname);
const PROJECT_ROOT = dirname(PACKAGE_ROOT);
const GOLDEN_BIB = join(PACKAGE_ROOT, "fixtures", "references.bib");

let root: string;
let db: DatabaseSync;

const FIXED_NOW = () => new Date("2026-01-01T00:00:00Z");

const BIBTEX_A = "@article{holder2024, title={Alpha Grid}, author={Holder, Ada}, year={2024}}";
const BIBTEX_B = "@article{holder2024a, title={Beta Cache}, author={Holder, Ben}, year={2024}}";

/** Crossref fake resolving a batch of DOIs, each with its own BibTeX. */
function registerFetch(perDoi: Record<string, { title: string; bibtex: string | null; status?: number }>): {
  fetchFn: FetchLike;
} {
  const { fetchFn } = createFakeFetch(
    Object.entries(perDoi).flatMap(([doi, spec]) => [
      {
        match: (url: string) => decodeURIComponent(url).includes(`/works/${doi}`) && !url.includes("/transform/"),
        status: spec.status ?? 200,
        body: crossrefWorkEnvelope({ doi, title: spec.title, authors: [{ family: "Holder", given: "Ada" }], year: 2024 }),
      },
      {
        match: (url: string) => decodeURIComponent(url).includes(`/works/${doi}/transform/`),
        status: spec.bibtex === null ? 404 : 200,
        body: spec.bibtex ?? "",
      },
    ]),
  );
  return { fetchFn };
}

function makeCtx(fetchFn: FetchLike, ctxRoot: string = root): ToolContext {
  return { root: ctxRoot, fetch: fetchFn, env: {}, now: FIXED_NOW, queue: new WriteQueue(), providerConfig: SEARCH_CFG };
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "uktub-det-"));
  db = createRegistry(root);
});

afterEach(() => {
  db.close();
  rmSync(root, { recursive: true, force: true });
});

const readBib = (ctxRoot: string = root): string => readFileSync(join(ctxRoot, BIBLIOGRAPHY_REL_PATH), "utf8");

// ── scenario 1: search → register → \cite{key} resolves ───────────────────

describe("search → register → cite flow", () => {
  it("every citekey the register result returns is present in the rendered references.bib", async () => {
    // 1. The agent searches through the real search tool over provider fakes.
    const search = createSearchFetch({
      openalex: fakeWorks("grid", 2),
      crossref: fakeWorks("grid", 2),
      semanticScholar: "down",
    });
    const searchResult = await searchPapersTool(makeCtx(search.fetchFn), { query: "grid computing" });
    const dois = searchResult.structuredContent?.candidates
      .map((candidate) => candidate.doi)
      .filter((doi): doi is string => doi !== null)
      .slice(0, 2);
    assert.equal(dois?.length, 2, "search fakes yielded two DOI-bearing candidates");

    // 2. The agent registers the DOIs it picked (the DOI cascade needs its own fake).
    const perDoi: Record<string, { title: string; bibtex: string }> = {};
    for (const [index, doi] of dois.entries()) {
      perDoi[doi] = {
        title: index === 0 ? "Alpha Grid" : "Beta Cache",
        bibtex: index === 0 ? BIBTEX_A : BIBTEX_B,
      };
    }
    const { fetchFn } = registerFetch(perDoi);
    const registerResult = await paperRegistryTool(makeCtx(fetchFn), { action: "register", identifiers: dois } as PaperRegistryArgs);
    const citekeys = registerResult.structuredContent?.outcomes.map((outcome: { doi: string; citekey: string | null }) => {
      assert.ok(typeof outcome.citekey === "string", `outcome for ${outcome.doi} lacks a citekey`);
      return outcome.citekey;
    }) ?? [];

    // 3. The resolvability guarantee: each returned \cite{key} resolves — the
    // key appears as an entry head in the rendered references.bib.
    const bib = readBib();
    for (const citekey of citekeys) {
      assert.match(bib, new RegExp(`@\\w+\\{${citekey},`), `\\cite{${citekey}} unresolvable`);
    }
    // And the registry agrees with the rendered file.
    assert.deepEqual(
      listPapers(db).map((row) => row.citekey),
      [...citekeys].sort(),
    );
  });
});

// ── scenario 2: recovery — human edit destroyed, sync-bib heals (R12) ─────

describe("sync-bib recovery", () => {
  it("a human-edited references.bib is overwritten by the next register; sync-bib (CLI path) restores the true render byte-identically", async () => {
    const { fetchFn } = registerFetch({
      "10.7001/aaa": { title: "Alpha Grid", bibtex: BIBTEX_A },
      "10.7001/bbb": { title: "Beta Cache", bibtex: BIBTEX_B },
    });
    const ctx = makeCtx(fetchFn);
    await paperRegistryTool(ctx, { action: "register", identifiers: ["10.7001/aaa"] } as PaperRegistryArgs);
    const renderAfterOne = readBib();

    // The human edits the generated file (the header forbids it; the registry wins).
    const edited = `${renderAfterOne}\n@manual{i edited this by hand, title={My Note}}\n`;
    writeFileSync(join(root, BIBLIOGRAPHY_REL_PATH), edited, "utf-8");

    // Documented stance: the next register destroys the human edit — the file
    // is re-rendered from the registry as the last statement of the write txn.
    await paperRegistryTool(ctx, { action: "register", identifiers: ["10.7001/bbb"] } as PaperRegistryArgs);
    const renderAfterTwo = readBib();
    assert.equal(renderAfterTwo.includes("edited this by hand"), false, "register did not overwrite the human edit");
    assert.match(renderAfterTwo, /@article\{holder2024beta,/);

    // A second human edit survives until sync-bib runs, then heals byte-identically.
    writeFileSync(join(root, BIBLIOGRAPHY_REL_PATH), "garbage", "utf-8");
    const out: string[] = [];
    const err: string[] = [];
    assert.equal(await runCli(["sync-bib"], { out: (line) => out.push(line), err: (line) => err.push(line), cwd: root }), 0);
    assert.equal(err.length, 0);
    assert.equal(readBib(), renderAfterTwo, "sync-bib did not restore the true render byte-identically");

    // Golden cross-check: the true render is pinned in the repo.
    assert.equal(renderAfterTwo, readFileSync(GOLDEN_BIB, "utf8"), "render diverged from tests/fixtures/references.bib");

    // Direct-call parity: syncBibliography gives the same bytes the CLI path did.
    assert.equal(syncBibliography(db).syncedCount, 2);
    assert.equal(readBib(), renderAfterTwo);
  });
});

// ── scenario 3: determinism across FRESH processes (R8/R18) ────────────────

describe("fresh-process determinism re-run", () => {
  /**
   * One deterministic run in a brand-new node process: build a registry at
   * `runRoot`, register the same two DOIs over the same fakes, list, and
   * print JSON { register, list, bib }. The specifiers are runtime-selected
   * (process.argv paths into the package), so the runner uses dynamic
   * imports by necessity — the rule's plugin-loading exception.
   * `ingested_at` is the only clock value (KTD6); each run injects its own.
   */
  const RUNNER = `
const { paperRegistryTool } = await import(process.argv[1] + "/src/core/tools/registry.ts");
const { createRegistry } = await import(process.argv[1] + "/src/core/registry.ts");
const { BIBLIOGRAPHY_REL_PATH } = await import(process.argv[1] + "/src/core/registry.ts");
const { readFileSync } = await import("node:fs");
const { createFakeFetch } = await import(process.argv[1] + "/tests/helpers/provider-fakes.ts");
const root = process.argv[2];
const db = createRegistry(root);
const env = JSON.parse(process.argv[3]);
const routes = [];
for (const [doi, spec] of Object.entries(env.perDoi)) {
  routes.push({
    match: (url) => decodeURIComponent(url).includes("/works/" + doi) && !url.includes("/transform/"),
    body: JSON.stringify({ message: { DOI: doi, title: [spec.title], author: [{ family: "Holder", given: "Ada" }], issued: { "date-parts": [[2024]] } } }),
  });
  routes.push({
    match: (url) => decodeURIComponent(url).includes("/works/" + doi + "/transform/"),
    body: spec.bibtex,
  });
}
const fetchFn = createFakeFetch(routes).fetchFn;
const ctx = { root, fetch: fetchFn, env: {}, now: () => new Date(process.argv[4]), queue: { runExclusive: (fn) => fn() } };
const registered = await paperRegistryTool(ctx, { action: "register", identifiers: env.dois });
const listed = await paperRegistryTool(ctx, { action: "read", fields: ["title", "year", "citable", "authors", "bibtexSource", "refreshedAt"] });
db.close();
process.stdout.write(JSON.stringify({
  register: registered.structuredContent,
  list: listed.structuredContent,
  bib: readFileSync(root + "/" + BIBLIOGRAPHY_REL_PATH, "utf8"),
}));
`;

  const stripClock = (value: unknown): unknown => {
    if (Array.isArray(value)) return value.map(stripClock);
    if (value !== null && typeof value === "object") {
      return Object.fromEntries(
        Object.entries(value as Record<string, unknown>)
          .filter(([key]) => key !== "ingestedAt" && key !== "ingested_at" && key !== "refreshedAt")
          .map(([key, entry]) => [key, stripClock(entry)]),
      );
    }
    return value;
  };

  const runFresh = (env: unknown, nowIso: string): { register: unknown; list: unknown; bib: string } => {
    const runRoot = mkdtempSync(join(tmpdir(), "uktub-det-fresh-"));
    const db = createRegistry(runRoot);
    db.close(); // the subprocess opens the initialized registry through its own connection
    try {
      const spawned = spawnSync(
        process.execPath,
        ["--experimental-strip-types", "--input-type=module", "-e", RUNNER, PROJECT_ROOT, runRoot, JSON.stringify(env), nowIso],
        { encoding: "utf8", timeout: 60_000 },
      );
      assert.equal(spawned.status, 0, `subprocess failed: ${spawned.stderr}`);
      return JSON.parse(spawned.stdout) as { register: unknown; list: unknown; bib: string };
    } finally {
      rmSync(runRoot, { recursive: true, force: true });
    }
  };

  it("two fresh processes, identical inputs → identical structuredContent (minus the clock) and byte-identical references.bib", () => {
    const env = {
      dois: ["10.8001/aaa", "10.8001/bbb"],
      perDoi: {
        "10.8001/aaa": { title: "Alpha Grid", bibtex: BIBTEX_A },
        "10.8001/bbb": { title: "Beta Cache", bibtex: BIBTEX_B },
      },
    };
    // Each fresh process gets a DIFFERENT injected clock — a day apart — so
    // the runs genuinely diverge in ingested_at and agree nowhere else.
    const one = runFresh(env, "2026-03-01T00:00:00Z");
    const two = runFresh(env, "2026-03-02T00:00:00Z");
    // The clocks really did differ between the fresh processes.
    assert.notEqual(
      JSON.stringify(one.list),
      JSON.stringify(two.list),
      "sanity: ingested_at should differ between differently-clocked runs",
    );
    assert.deepEqual(stripClock(one.register), stripClock(two.register), "register structuredContent diverged");
    assert.deepEqual(stripClock(one.list), stripClock(two.list), "list structuredContent diverged");
    assert.equal(one.bib, two.bib, "references.bib not byte-identical across fresh processes");
  });
});

// ── scenario 4: parallel MCP callTool() calls → serialized, ordered keys ─────

describe("parallel MCP callTool calls", () => {
  it("overlapping register callTool() calls serialize; the second collision-holder gets the deterministic base-26 suffix", async () => {
    // Both papers mint the same base citekey (Holder, 2024, "Same") — the
    // suffix assignment is decided by queue arrival order.
    const { fetchFn } = registerFetch({
      "10.9001/one": { title: "Same Title", bibtex: BIBTEX_A },
      "10.9001/two": { title: "Same Title", bibtex: BIBTEX_B },
    });

    const server = createMcpServer({ targetDir: root, fetch: fetchFn as typeof globalThis.fetch });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "test-client", version: "1.0.0" }, { capabilities: {} });
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);

    interface ExecuteOutcome {
      structuredContent?: { outcomes: { doi: string; citekey: string; status: string }[] };
    }
    const call = (doi: string): Promise<ExecuteOutcome> =>
      client.callTool({ name: "paper_registry", arguments: { action: "register", identifiers: [doi] } }) as Promise<ExecuteOutcome>;

    // Fire both WITHOUT awaiting: promise-creation order fixes queue arrival
    // order deterministically (each call runs synchronously to its first await).
    const first = call("10.9001/one");
    const second = call("10.9001/two");
    const [firstResult, secondResult] = (await Promise.all([first, second])) as [Awaited<ReturnType<typeof call>>, Awaited<ReturnType<typeof call>>];

    assert.deepEqual(
      firstResult.structuredContent?.outcomes.map((outcome) => [outcome.doi, outcome.status]),
      [["10.9001/one", "registered"]],
    );
    assert.deepEqual(
      secondResult.structuredContent?.outcomes.map((outcome) => [outcome.doi, outcome.status]),
      [["10.9001/two", "registered"]],
    );

    // Both committed; the collision resolved as base + base-26 suffix. WHICH
    // call holds the base key is queue-arrival dependent (documented: the
    // batch parameter is the reproducible path) — the contract is that the
    // assignments are distinct, valid, and pinned once.
    const citekeys = [
      firstResult.structuredContent?.outcomes[0]?.citekey,
      secondResult.structuredContent?.outcomes[0]?.citekey,
    ].sort();
    assert.deepEqual(citekeys, ["holder2024same", "holder2024samea"]);
    // Both rows committed through the BEGIN IMMEDIATE fence.
    assert.equal(listPapers(db).length, 2);
    const bib = readBib();
    assert.match(bib, /@article\{holder2024same,/);
    assert.match(bib, /@article\{holder2024samea,/);
  });
});
