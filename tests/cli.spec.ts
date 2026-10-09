/**
 * U6 CLI spec: `init` (idempotent), `deregister` (by citekey and by DOI,
 * removed|missing outcomes, bibliography re-render), `list` (citekey order),
 * and the error path (refusal code on stderr, exit 1). `runCli(argv, io)` is
 * imported directly — the bin shim stays thin.
 */
import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, existsSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join } from "node:path";
import { DatabaseSync } from "node:sqlite";

import { runCli } from "../src/cli/main.ts";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { chunksOf, getSource } from "../src/core/verify/store.ts";
import { makePdf } from "./helpers/pdf.ts";
import { bib, crossrefFake } from "./helpers/registry-fakes.ts";
import type { CliIo } from "../src/cli/main.ts";
import {
  BIBLIOGRAPHY_REL_PATH,
  createRegistry,
  listPapers,
  openRegistry,
  registerPaper,
} from "../src/core/registry.ts";

let root: string;
let db: DatabaseSync;

function io(extra: Partial<CliIo> = {}) {
  const out: string[] = [];
  const err: string[] = [];
  return {
    cwd: root,
    lines: { out, err },
    ...extra,
    env: { UKTUB_CACHE_DIR: join(root, ".cache"), ...(extra.env ?? {}) },
    out: (line: string): void => {
      out.push(line);
    },
    err: (line: string): void => {
      err.push(line);
    },
  };
}

const BIBTEX_A = "@article{holder2024, title={Alpha Grid}, author={Holder, Ada}, year={2024}}";
const BIBTEX_B = "@article{miles2023, title={Beta Cache}, author={Miles, Ben}, year={2023}}";

function registerFixture(): { citekeyA: string; doiB: string } {
  const a = registerPaper(db, {
    doi: "10.1234/alpha",
    title: "Alpha Grid",
    authors: ["Ada Holder"],
    year: 2024,
    venue: "Journal of Grids",
    bibtex: BIBTEX_A,
    bibtexSource: "crossref",
  });
  registerPaper(db, {
    doi: "10.5678/beta",
    title: "Beta Cache",
    authors: ["Ben Miles"],
    year: 2023,
    venue: null,
    bibtex: BIBTEX_B,
    bibtexSource: "crossref",
  });
  return { citekeyA: a.citekey, doiB: "10.5678/beta" };
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "uktub-cli-"));
  db = createRegistry(root);
});

afterEach(() => {
  try {
    db.close();
  } catch {
    // The test may have closed it (runCli scenarios re-open their own handles).
  }
  rmSync(root, { recursive: true, force: true });
});

describe("uktub-scholar init", () => {
  it("is idempotent: the second init keeps the existing registry and bibliography", async () => {
    db.close();
    const first = await runCli(["init"], io());
    assert.equal(first, 0);
    const bibPath = join(root, BIBLIOGRAPHY_REL_PATH);
    assert.ok(existsSync(bibPath));
    const rowsAfterFirst = listPapers(openRegistry(root)).length;
    const bibAfterFirst = readFileSync(bibPath, "utf8");
    const second = await runCli(["init"], io());
    assert.equal(second, 0);
    assert.equal(listPapers(openRegistry(root)).length, rowsAfterFirst);
    assert.equal(readFileSync(bibPath, "utf8"), bibAfterFirst);
  });

  it("refuses a foreign-schema registry with the refusal code on stderr, exit 1", async () => {
    db.close();
    // Hand-craft a foreign user_version the same way the registry spec does.
    const foreign = new DatabaseSync(join(root, ".registry", "registry.db"));
    foreign.exec("PRAGMA user_version = 99;");
    foreign.close();
    const capture = io();
    const code = await runCli(["init"], capture);
    assert.equal(code, 1);
    assert.match(capture.lines.err.join("\n"), /REGISTRY_SCHEMA_UNSUPPORTED/);
  });

  it("refuses init inside an existing project (nested registries), exit 1", async () => {
    db.close();
    const subdir = join(root, "manuscript", "chapters");
    mkdirSync(subdir, { recursive: true });
    const capture = io();
    capture.cwd = subdir;
    const code = await runCli(["init"], capture);
    assert.equal(code, 1);
    assert.ok(!existsSync(join(subdir, ".registry")));
  });
});

describe("uktub-scholar deregister", () => {
  it("removes by citekey and by DOI, re-renders the bibliography, reports removed|missing", async () => {
    const { citekeyA, doiB } = registerFixture();
    db.close();
    const bibPath = join(root, BIBLIOGRAPHY_REL_PATH);
    assert.match(readFileSync(bibPath, "utf8"), /holder2024/);
    assert.match(readFileSync(bibPath, "utf8"), /miles2023/);

    const capture = io();
    const code = await runCli(["deregister", citekeyA, doiB, "not-a-registered-thing"], capture);
    assert.equal(code, 0);
    const text = capture.lines.out.join("\n");
    assert.match(text, new RegExp(`removed ${citekeyA}`));
    assert.match(text, /removed .*10\.5678\/beta/);
    assert.match(text, /missing not-a-registered-thing/);

    const reopened = openRegistry(root);
    assert.deepEqual(listPapers(reopened), []);
    // Cascade + re-render: both entries are gone from the file.
    assert.doesNotMatch(readFileSync(bibPath, "utf8"), /holder2024|miles2023/);
    reopened.close();
  });

  it("refuses with a usage error when no handle is given", async () => {
    db.close();
    const capture = io();
    assert.equal(await runCli(["deregister"], capture), 1);
    assert.match(capture.lines.err.join("\n"), /usage/i);
  });
});

describe("uktub-scholar list", () => {
  it("prints rows in citekey order with citekey, year, title, venue, citable, and provenance", async () => {
    registerFixture();
    db.close();
    const capture = io();
    const code = await runCli(["list"], capture);
    assert.equal(code, 0);
    const rows = capture.lines.out.filter((line) => line.includes("\t") && !line.startsWith("citekey\t"));
    const expectedOrder = listPapers(openRegistry(root)).map((row) => row.citekey);
    assert.equal(rows.length, 2);
    assert.deepEqual(
      rows.map((row) => row.split("\t")[0]),
      [...expectedOrder].sort(),
    );
    const text = capture.lines.out.join("\n");
    assert.match(text, /2024/);
    assert.match(text, /Alpha Grid/);
    assert.match(text, /Journal of Grids/);
    for (const row of rows) {
      assert.match(row, /\tyes\t/);
      assert.match(row, /\tvia crossref$/);
    }
  });

  it("lists an empty registry successfully", async () => {
    db.close();
    const capture = io();
    assert.equal(await runCli(["list"], capture), 0);
  });
});

describe("uktub-scholar error paths", () => {
  it("list without a registry prints the refusal code and exits 1", async () => {
    db.close();
    rmSync(join(root, ".registry", "registry.db"));
    const capture = io();
    const code = await runCli(["list"], capture);
    assert.equal(code, 1);
    assert.match(capture.lines.err.join("\n"), /REGISTRY_NOT_INITIALIZED/);
    assert.match(capture.lines.err.join("\n"), /uktub-scholar init/);
  });

  it("unknown command prints usage and exits 1", async () => {
    db.close();
    const capture = io();
    assert.equal(await runCli(["explode"], capture), 1);
    assert.match(capture.lines.err.join("\n"), /usage/i);
  });

  it("sync-bib heals a hand-deleted bibliography byte-stably", async () => {
    registerFixture();
    db.close();
    const bibPath = join(root, BIBLIOGRAPHY_REL_PATH);
    const before = readFileSync(bibPath, "utf8");
    rmSync(bibPath);
    const capture = io();
    assert.equal(await runCli(["sync-bib"], capture), 0);
    assert.equal(readFileSync(bibPath, "utf8"), before);
  });
});

describe("uktub-scholar compile (offline paths)", () => {
  it("refuses with COMPILE_ENGINE_MISSING when no engine can be found, before touching any entry", async () => {
    // Engine resolution happens first (detect before touch). The environment is injected through the CLI's env seam: no PATH to search and an
    // empty cache, so a managed Tectonic installed on the developer's machine cannot make the test pass or fail.
    const capture = io({ env: { PATH: "/uktub/no/such/bin", UKTUB_CACHE_DIR: join(root, ".empty-cache") } });
    const code = await runCli(["compile"], capture);
    assert.equal(code, 1);
    assert.match(capture.lines.err.join("\n"), /COMPILE_ENGINE_MISSING/);
  });

  it("compile appears in the usage text", async () => {
    const capture = io();
    assert.equal(await runCli(["explode"], capture), 1);
    assert.match(capture.lines.err.join("\n"), /compile \[entry\.tex\]/);
  });
});

describe("uktub-scholar register / attach / verify (same tools as the agent)", () => {
  const SUPPORT = "Experiments show that cells age faster at high temperature than at room temperature, with capacity loss reaching twelve percent.";
  const CLAIM = "Cells age faster at high temperature.";
  const fakeEngine = {
    createEngine: () => ({ run: async (rows: { state: string; instructions: string }[]) => rows.map((r) => (r.state.toLowerCase().includes("cells age faster at high temperature") ? 0.999 : 0.05)) }),
    fetchImpl: (async () => new Response("nope", { status: 404 })) as unknown as typeof fetch,
  };
  const body = Array.from({ length: 60 }, (_, i) => (i === 31 ? `Para ${i}. ${SUPPORT}` : `Para ${i}. ` + "The experiment records many independent measurements of the cell. ".repeat(5))).join("\n\n");
  const lines = [ "Cycle Life of Cells", ...body.split("\n\n").flatMap((p) => p.match(/.{1,88}(\s|$)/g) ?? []) ];
  const pages = Array.from({ length: Math.ceil(lines.length / 45) }, (_, i) => lines.slice(i * 45, i * 45 + 45));

  it("register: resolves identifiers through the registry tool and prints one outcome per input", async () => {
    db.close();
    const { fetchFn } = crossrefFake({ "10.1001/cells": { title: "Cycle Life of Cells", bibtex: bib("cells2024", "Cycle Life of Cells") } });
    const capture = io({ fetch: fetchFn, env: {} });
    assert.equal(await runCli(["register", "10.1001/cells", "banana"], capture), 0);
    const text = capture.lines.out.join("\n");
    assert.match(text, /\[0\] registered .*10\.1001\/cells/);
    assert.match(text, /\[1\] refused INVALID_DOI/);
    assert.equal(listPapers(openRegistry(root)).length, 1);
  });

  it("register without identifiers is a usage error", async () => {
    db.close();
    const capture = io();
    assert.equal(await runCli(["register"], capture), 1);
    assert.match(capture.lines.err.join("\n"), /usage/i);
  });

  it("attach + verify: a local PDF becomes a ready source; the claim is verified with a reconstructable passage; the file is untouched", async () => {
    registerPaper(db, { doi: "10.1001/cells", title: "Cycle Life of Cells", authors: ["Ada Holder"], year: 2024, bibtex: bib("cells2024", "Cycle Life of Cells"), bibtexSource: "crossref" });
    db.close();
    const pdfPath = join(root, "cells.pdf");
    writeFileSync(pdfPath, makePdf(pages));

    const attach = io();
    assert.equal(await runCli(["attach", "10.1001/cells", "cells.pdf"], attach), 0);
    assert.match(attach.lines.out.join("\n"), /attached .*source ready, revision [0-9a-f]{16}/);
    assert.ok(existsSync(pdfPath));
    const dbAfter = openRegistry(root);
    assert.equal(getSource(dbAfter, "10.1001/cells")!.status, "ready");
    assert.ok(chunksOf(dbAfter, "10.1001/cells").length >= 1);
    dbAfter.close();

    const verify = io({ env: { UKTUB_VERIFY_MODEL_ID: "test-model" }, verifyHooks: fakeEngine });
    assert.equal(await runCli(["verify", CLAIM], verify), 0);
    const out = verify.lines.out.join("\n");
    assert.match(out, /SUPPORT FOUND/);
    const pointer = /pointer: (\S+)/.exec(out)![1];
    // CLI parity: the pointer reconstructs exactly the excerpt the CLI printed.
    const reopened = openRegistry(root);
    const { resolvePointer } = await import("../src/core/verify/store.ts");
    const back = resolvePointer(reopened, pointer);
    reopened.close();
    assert.equal(back.status, "current");
    assert.ok(out.includes((back as { text: string }).text.slice(0, 80)));
  });

  it("verify options: --papers narrows scope, --query makes the search query-limited", async () => {
    registerPaper(db, { doi: "10.1001/cells", title: "Cycle Life of Cells", authors: [], bibtex: bib("cells2024", "Cycle Life of Cells"), bibtexSource: "crossref" });
    db.close();
    writeFileSync(join(root, "cells.pdf"), makePdf(pages));
    assert.equal(await runCli(["attach", "10.1001/cells", "cells.pdf"], io()), 0);
    const limited = io({ env: { UKTUB_VERIFY_MODEL_ID: "test-model" }, verifyHooks: fakeEngine });
    assert.equal(await runCli(["verify", CLAIM, "--papers", "10.1001/cells", "--query", "quantum chromodynamics"], limited), 0);
    assert.match(limited.lines.out.join("\n"), /query-limited/);
    const none = io({ env: { UKTUB_VERIFY_MODEL_ID: "test-model" }, verifyHooks: fakeEngine });
    assert.equal(await runCli(["verify", CLAIM, "--papers", "10.9999/never"], none), 0);
    assert.match(none.lines.out.join("\n"), /10\.9999\/never/);
  });

  it("search: prints ranked passages with pointers that resolve to the printed excerpt; --papers and --limit apply", async () => {
    registerPaper(db, { doi: "10.1001/cells", title: "Cycle Life of Cells", authors: [], bibtex: bib("cells2024", "Cycle Life of Cells"), bibtexSource: "crossref" });
    db.close();
    writeFileSync(join(root, "cells.pdf"), makePdf(pages));
    assert.equal(await runCli(["attach", "10.1001/cells", "cells.pdf"], io()), 0);
    const found = io({ env: {} });
    assert.equal(await runCli(["search", "cells", "age", "faster", "temperature", "--limit", "2"], found), 0);
    const out = found.lines.out.join("\n");
    assert.match(out, /PASSAGE\(S\) from 1 paper\(s\)/);
    assert.match(out, /lexical search/);
    const pointer = /pointer: (\S+)/.exec(out)![1];
    const reopened = openRegistry(root);
    const { resolvePointer } = await import("../src/core/verify/store.ts");
    const back = resolvePointer(reopened, pointer);
    reopened.close();
    assert.equal(back.status, "current");
    assert.ok((out.match(/pointer: /g) ?? []).length <= 2, "--limit bounds the passages");
    const none = io({ env: {} });
    assert.equal(await runCli(["search", "cells", "--papers", "10.9999/never"], none), 0);
    assert.match(none.lines.out.join("\n"), /not registered|none of the named papers/i);
  });

  it("search without a query is a usage error; a refusal prints its code on stderr", async () => {
    db.close();
    const usage = io();
    assert.equal(await runCli(["search"], usage), 1);
    assert.match(usage.lines.err.join("\n"), /search needs a query/);
    const refused = io();
    assert.equal(await runCli(["search", "cells", "--limit", "99"], refused), 1);
    assert.match(refused.lines.err.join("\n"), /ARGUMENT_INVALID/);
  });

  it("verify refusals print the refusal code on stderr and exit 1; missing claim is a usage error", async () => {
    db.close();
    const noClaim = io();
    assert.equal(await runCli(["verify"], noClaim), 1);
    assert.match(noClaim.lines.err.join("\n"), /usage/i);
    const bad = io();
    assert.equal(await runCli(["verify", "short"], bad), 1);
    assert.match(bad.lines.err.join("\n"), /ARGUMENT_INVALID/);
  });

  it("the retired claim-array verify and trace commands are gone, and usage names the new ones", async () => {
    db.close();
    const t = io();
    assert.equal(await runCli(["trace", "doc"], t), 1);
    const u = io();
    await runCli(["explode"], u);
    const usage = u.lines.err.join("\n");
    for (const cmd of ["register <id>", "attach <doi|citekey> <file>", "verify <claim>"]) assert.ok(usage.includes(cmd), cmd);
    assert.doesNotMatch(usage, /trace|<doi> <claim>/);
  });
});

describe("uktub-scholar embed install / status (managed embedding runtime)", async () => {
  const { createHash } = await import("node:crypto");
  const { makeTarGz } = await import("./helpers/tar.ts");
  const sha = (b: Uint8Array): string => createHash("sha256").update(b).digest("hex");
  const MODEL = Buffer.from("tiny model bytes ".repeat(30));
  const archive = makeTarGz([{ name: "llama-test/llama-server", data: "#!/bin/sh\nexit 0\n", mode: 0o755 }]);
  const lock = {
    schema: 1 as const,
    runtime: { name: "llama.cpp", version: "btest", license: "MIT", assets: { "linux-x64": { name: "llama-test.tar.gz", url: "https://example.test/rt.tar.gz", sha256: sha(archive), size: archive.length, dir: "llama-test", binary: "llama-server" } } },
    embedding: { id: "test-embed", file: "model.gguf", url: "https://example.test/m.gguf", sha256: sha(MODEL), size: MODEL.length, license: "gemma", terms: "https://ai.google.dev/gemma/terms", profile: "none", serverArgs: ["--embeddings"] },
  };
  const bodies: Record<string, Uint8Array> = { [lock.runtime.assets["linux-x64"].url]: archive, [lock.embedding.url]: MODEL };
  let fetched: string[] = [];
  const embedFetch = (async (url: string | URL | Request) => {
    fetched.push(String(url));
    return new Response(Buffer.from(bodies[String(url)]) as unknown as ConstructorParameters<typeof Response>[0], { status: 200 });
  }) as typeof fetch;
  let cacheDir: string;
  beforeEach(() => {
    fetched = [];
    cacheDir = mkdtempSync(join(tmpdir(), "uktub-cli-cache-"));
  });
  afterEach(() => rmSync(cacheDir, { recursive: true, force: true }));
  const embedIo = (): ReturnType<typeof io> => io({ env: { UKTUB_CACHE_DIR: cacheDir }, embedLock: lock, embedFetch, embedPlatform: "linux-x64" } as never);

  it("status before install: says it is not installed, and names the cache, the pinned model, its size and its terms", async () => {
    const c = embedIo();
    assert.equal(await runCli(["embed", "status"], c), 0);
    const out = c.lines.out.join("\n");
    assert.match(out, /not installed/i);
    assert.ok(out.includes(cacheDir));
    assert.match(out, /test-embed/);
    assert.match(out, /gemma/i);
    assert.deepEqual(fetched, []);
  });

  it("install without --yes only shows the plan (sizes, source, terms) and downloads nothing", async () => {
    const c = embedIo();
    assert.equal(await runCli(["embed", "install"], c), 1);
    const text = [...c.lines.out, ...c.lines.err].join("\n");
    assert.match(text, /--yes/);
    assert.match(text, /ai\.google\.dev\/gemma\/terms/);
    assert.match(text, /example\.test/);
    assert.deepEqual(fetched, [], "consent comes before any download");
  });

  it("install --yes downloads, verifies and installs; status then says installed; a second install fetches nothing", async () => {
    const c = embedIo();
    assert.equal(await runCli(["embed", "install", "--yes"], c), 0);
    assert.match(c.lines.out.join("\n"), /installed/i);
    assert.equal(fetched.length, 2);
    const s = embedIo();
    assert.equal(await runCli(["embed", "status"], s), 0);
    assert.match(s.lines.out.join("\n"), /installed/);
    assert.doesNotMatch(s.lines.out.join("\n"), /not installed/);
    fetched = [];
    assert.equal(await runCli(["embed", "install", "--yes"], embedIo()), 0);
    assert.deepEqual(fetched, []);
  });

  it("an unsupported platform refuses with the bring-your-own-server alternative", async () => {
    const c = io({ env: { UKTUB_CACHE_DIR: cacheDir }, embedLock: lock, embedFetch, embedPlatform: "sunos-sparc" } as never);
    assert.equal(await runCli(["embed", "install", "--yes"], c), 1);
    assert.match(c.lines.err.join("\n"), /no llama\.cpp btest build is pinned for sunos-sparc.*UKTUB_EMBED_URL/);
    assert.deepEqual(fetched, []);
  });

  it("a failed verification is reported and exits 1", async () => {
    const tampered = (async () => new Response("wrong bytes", { status: 200 })) as unknown as typeof fetch;
    const c = io({ env: { UKTUB_CACHE_DIR: cacheDir }, embedLock: lock, embedFetch: tampered, embedPlatform: "linux-x64" } as never);
    assert.equal(await runCli(["embed", "install", "--yes"], c), 1);
    assert.match(c.lines.err.join("\n"), /checksum_mismatch|size_mismatch|pinned/);
  });

  it("an unknown embed subcommand is a usage error", async () => {
    const c = embedIo();
    assert.equal(await runCli(["embed", "frobnicate"], c), 1);
    assert.match(c.lines.err.join("\n"), /embed (install|status)/);
  });
});

/** What a host can actually run: `node <absolute bin that exists> mcp` — never a bare `uktub-scholar`, which is on no PATH for a checkout or a project-local install. */
function assertSpawnable(command: string, args: string[], label: string): void {
  assert.equal(command, "node", label);
  assert.ok(isAbsolute(args[0] ?? "") && /bin[\\/]uktub-scholar\.js$/.test(args[0] ?? "") && existsSync(args[0] ?? ""), `${label}: ${args[0]} must be this package's bin`);
  assert.deepEqual(args.slice(1), ["mcp"], label);
}

describe("mcp command", () => {
  it("mcp install defaults to claude and writes .mcp.json", async () => {
    const c = io();
    assert.equal(await runCli(["mcp", "install"], c), 0);
    assert.match(c.lines.out.join("\n"), /\.mcp\.json/);

    const content = JSON.parse(readFileSync(join(root, ".mcp.json"), "utf8"));
    assertSpawnable(content.mcpServers["uktub-scholar"].command, content.mcpServers["uktub-scholar"].args, "mcpServers");
  });

  it("mcp install --host pi writes .mcp.json", async () => {
    const c = io();
    assert.equal(await runCli(["mcp", "install", "--host", "pi"], c), 0);
    assert.match(c.lines.out.join("\n"), /\.mcp\.json/);

    const content = JSON.parse(readFileSync(join(root, ".mcp.json"), "utf8"));
    assertSpawnable(content.mcpServers["uktub-scholar"].command, content.mcpServers["uktub-scholar"].args, "mcpServers");
  });

  it("mcp install --host agy writes .agents/mcp_config.json", async () => {
    const c = io();
    assert.equal(await runCli(["mcp", "install", "--host", "agy"], c), 0);
    assert.match(c.lines.out.join("\n"), /\.agents\/mcp_config\.json/);

    const content = JSON.parse(readFileSync(join(root, ".agents", "mcp_config.json"), "utf8"));
    assertSpawnable(content.mcpServers["uktub-scholar"].command, content.mcpServers["uktub-scholar"].args, "mcpServers");
  });

  it("mcp install --host cursor writes .cursor/mcp.json", async () => {
    const c = io();
    assert.equal(await runCli(["mcp", "install", "--host", "cursor"], c), 0);
    assert.match(c.lines.out.join("\n"), /\.cursor\/mcp\.json/);

    const content = JSON.parse(readFileSync(join(root, ".cursor", "mcp.json"), "utf8"));
    assertSpawnable(content.mcpServers["uktub-scholar"].command, content.mcpServers["uktub-scholar"].args, "mcpServers");
  });

  it("mcp install --host opencode writes opencode.json", async () => {
    const c = io();
    assert.equal(await runCli(["mcp", "install", "--host", "opencode"], c), 0);
    assert.match(c.lines.out.join("\n"), /opencode\.json/);

    const content = JSON.parse(readFileSync(join(root, "opencode.json"), "utf8"));
    assert.equal(content.mcp["uktub-scholar"].type, "local");
    const [command, ...args] = content.mcp["uktub-scholar"].command as string[];
    assertSpawnable(command, args, "opencode");
  });

  it("mcp install --host codex writes .codex/config.toml and outputs TOML snippet", async () => {
    const c = io();
    assert.equal(await runCli(["mcp", "install", "--host", "codex"], c), 0);
    assert.match(c.lines.out.join("\n"), /\.codex\/config\.toml/);
    assert.match(c.lines.out.join("\n"), /\[mcp_servers\.uktub-scholar\]/);

    const toml = readFileSync(join(root, ".codex", "config.toml"), "utf8");
    assert.match(toml, /\[mcp_servers\.uktub-scholar\]/);
    const parsed = /command = "([^"]+)"\nargs = \[([^\]]*)\]/.exec(toml);
    assert.ok(parsed, "codex table has command and args");
    assertSpawnable(parsed[1], JSON.parse(`[${parsed[2]}]`) as string[], "codex");
  });

  it("mcp install with unknown host fails with code 1", async () => {
    const c = io();
    assert.equal(await runCli(["mcp", "install", "--host", "unknown_host"], c), 1);
    assert.match(c.lines.err.join("\n"), /unknown host/);
  });

  it("mcp with invalid target directory refuses with code 1 and PATH_REFUSED", async () => {
    const c = io();
    assert.equal(await runCli(["mcp", "--dir", `${root}/../outside`], c), 1);
    assert.match(c.lines.err.join("\n"), /PATH_REFUSED/);
  });

  it("mcp install refuses to overwrite corrupted or invalid JSON in config files", async () => {
    const c = io();
    const mcpFile = join(root, ".mcp.json");
    writeFileSync(mcpFile, "{ malformed json", "utf8");

    assert.equal(await runCli(["mcp", "install", "--host", "claude"], c), 1);
    assert.match(c.lines.err.join("\n"), /failed to parse/);
    assert.equal(readFileSync(mcpFile, "utf8"), "{ malformed json", "corrupt file must not be clobbered");
  });

  it("mcp install refuses, and leaves the file byte-identical, when the server table exists but is not an object", async () => {
    const hosts: [string, string, string][] = [
      ["claude", ".mcp.json", "mcpServers"],
      ["pi", ".mcp.json", "mcpServers"],
      ["cursor", ".cursor/mcp.json", "mcpServers"],
      ["agy", ".agents/mcp_config.json", "mcpServers"],
      ["opencode", "opencode.json", "mcp"],
    ];
    for (const [host, file, key] of hosts) {
      for (const wrong of [[1, 2], "oops", 7, null]) {
        const path = join(root, file);
        mkdirSync(dirname(path), { recursive: true });
        const before = JSON.stringify({ [key]: wrong, keep: true });
        writeFileSync(path, before, "utf8");
        const c = io();
        assert.equal(await runCli(["mcp", "install", "--host", host], c), 1, `${host} with ${key}=${JSON.stringify(wrong)}`);
        assert.match(c.lines.err.join("\n"), new RegExp(`"${key}".*not an object`), host);
        assert.equal(readFileSync(path, "utf8"), before, `${host}: a user's ${key}=${JSON.stringify(wrong)} must not be silently replaced`);
      }
    }
  });

  it("tectonic status reports the pin and whether it is installed; install refuses without --yes and downloads nothing", async () => {
    const cache = mkdtempSync(join(tmpdir(), "uktub-cli-tec-"));
    try {
      const status = io();
      assert.equal(await runCli(["tectonic", "status"], { ...status, env: { UKTUB_CACHE_DIR: cache } }), 0);
      assert.match(status.lines.out.join("\n"), /tectonic 0\.\d+\.\d+/i);
      assert.match(status.lines.out.join("\n"), /not installed/);
      let fetched = 0;
      const refuse = io();
      assert.equal(await runCli(["tectonic", "install"], { ...refuse, env: { UKTUB_CACHE_DIR: cache }, embedFetch: (async () => void fetched++) as never }), 1);
      assert.match(refuse.lines.err.join("\n"), /--yes/);
      assert.equal(fetched, 0, "no download without explicit consent");
    } finally {
      rmSync(cache, { recursive: true, force: true });
    }
  });

  it("eos status reports the pin and install state; eos install refuses without --yes, names the sizes, and runs nothing", async () => {
    const cache = mkdtempSync(join(tmpdir(), "uktub-cli-eos-"));
    try {
      const status = io();
      assert.equal(await runCli(["eos", "status"], { ...status, env: { UKTUB_CACHE_DIR: cache } }), 0);
      const out = status.lines.out.join("\n");
      assert.match(out, /Decision-2\.0-Eos/);
      assert.match(out, /not installed/);
      assert.match(out, /eos install --yes/);
      let fetched = 0;
      const refuse = io();
      assert.equal(await runCli(["eos", "install"], { ...refuse, env: { UKTUB_CACHE_DIR: cache }, embedFetch: (async () => void fetched++) as never }), 1);
      const err = refuse.lines.err.join("\n");
      assert.match(err, /--yes/);
      assert.match(err, /MB/, "the user is told what will be downloaded");
      assert.equal(fetched, 0, "no download without explicit consent");
      const bad = io();
      assert.equal(await runCli(["eos", "frobnicate"], bad), 1);
    } finally {
      rmSync(cache, { recursive: true, force: true });
    }
  });

  it("--help, -h and help print the usage and exit 0, also for subcommands", async () => {
    for (const argv of [["--help"], ["-h"], ["help"], ["mcp", "install", "--help"], ["eos", "--help"], ["tectonic", "-h"]]) {
      const c = io();
      assert.equal(await runCli(argv, c), 0, argv.join(" "));
      assert.match(c.lines.out.join("\n"), /usage: uktub-scholar/, argv.join(" "));
      assert.equal(c.lines.err.length, 0, argv.join(" "));
    }
  });

  it("mcp install treats a zero-byte or blank config file as empty, not as corrupt", async () => {
    for (const blank of ["", "  \n\t\n"]) {
      writeFileSync(join(root, ".mcp.json"), blank, "utf8");
      const c = io();
      assert.equal(await runCli(["mcp", "install", "--host", "claude"], c), 0, JSON.stringify(blank));
      assert.ok(JSON.parse(readFileSync(join(root, ".mcp.json"), "utf8")).mcpServers["uktub-scholar"]);
    }
  });

  it("mcp install --host codex says so when the entry is already there and leaves the file alone", async () => {
    const first = io();
    await runCli(["mcp", "install", "--host", "codex"], first);
    const before = readFileSync(join(root, ".codex", "config.toml"), "utf8");
    const second = io();
    assert.equal(await runCli(["mcp", "install", "--host", "codex"], second), 0);
    assert.match(second.lines.out.join("\n"), /already/i);
    assert.doesNotMatch(second.lines.out.join("\n"), /^Wrote/m);
    assert.equal(readFileSync(join(root, ".codex", "config.toml"), "utf8"), before);
  });

  it("register and attach exit 1 when EVERY item was refused (a script must not read success), and 0 when any item succeeded", async () => {
    const allBad = io();
    assert.equal(await runCli(["register", "not-a-doi"], allBad), 1);
    assert.match(allBad.lines.err.join("\n") + allBad.lines.out.join("\n"), /INVALID_DOI/);
    const attachBad = io();
    assert.equal(await runCli(["attach", "no-such-handle", "nope.pdf"], attachBad), 1);
  });

  it("mcp install --host without argument errors with clear message", async () => {
    const c = io();
    assert.equal(await runCli(["mcp", "install", "--host"], c), 1);
    assert.match(c.lines.err.join("\n"), /option "--host" requires an argument/);
  });

  it("mcp --dir without argument errors with clear message", async () => {
    const c = io();
    assert.equal(await runCli(["mcp", "--dir"], c), 1);
    assert.match(c.lines.err.join("\n"), /option "--dir" requires an argument/);
  });

  it("mcp with relative target directory without traversal (e.g. '.') resolves against cwd and succeeds", async () => {
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const c = io({ mcpTransport: serverTransport });
    assert.equal(await runCli(["mcp", "."], c), 0);
    await clientTransport.close();
  });

  it("mcp runs server with custom transport", async () => {
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const c = io({ mcpTransport: serverTransport });
    assert.equal(await runCli(["mcp"], c), 0);
    await clientTransport.close();
  });

  it("mcp reports the host's handshake on stderr only when UKTUB_MCP_TRACE is set", async () => {
    const handshakes = async (env: Record<string, string>): Promise<string[]> => {
      const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
      const c = io({ mcpTransport: serverTransport, env });
      assert.equal(await runCli(["mcp"], c), 0);
      const client = new Client({ name: "cli-trace-host", version: "2.0.0" }, { capabilities: {} });
      await client.connect(clientTransport);
      await client.listTools();
      await client.close();
      return c.lines.err.filter((l) => l.startsWith("uktub-scholar: handshake"));
    };
    const traced = await handshakes({ UKTUB_MCP_TRACE: "1" });
    assert.equal(traced.length, 1);
    assert.match(traced[0] as string, /client=cli-trace-host 2\.0\.0 requested=\S+ negotiated=\S+/);
    assert.deepEqual(await handshakes({}), []);
  });
});


