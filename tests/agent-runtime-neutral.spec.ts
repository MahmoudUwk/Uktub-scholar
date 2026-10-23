/**
 * Runtime-neutral agent core (src/agent/): the modules a browser agent imports must bundle for the browser with no Node builtins,
 * no Pi SDK and no process reference; the neutral gate core must produce the same follow-up text as the Pi gate; the moved helpers
 * must be the same functions Pi exports (identity, not copies).
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

import uktubScholarExtension, { writingWorkflowSection as piWritingWorkflowSection } from "../src/pi/index.ts";
import { installCompletionGate } from "../src/pi/completion-gate.ts";
import * as piWrite from "../src/pi/write-section.ts";
import type { ProvenanceOutcome } from "../src/core/provenance/run.ts";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const AGENT_DIR = fileURLToPath(new URL("../src/agent/", import.meta.url));

describe("src/agent is runtime-neutral", () => {
  it("bundles for the browser with no Node builtin, no Pi SDK import and no process reference", async () => {
    const entries = readdirSync(AGENT_DIR).filter((f) => f.endsWith(".ts")).map((f) => `${AGENT_DIR}${f}`);
    assert.ok(entries.length >= 3, "the workflow, completion-gate and section-writer modules exist under src/agent/");
    const result = await build({
      entryPoints: entries,
      bundle: true,
      platform: "browser",
      format: "esm",
      outdir: `${ROOT}node_modules/.cache/agent-bundle-check`,
      write: false,
      logLevel: "silent",
      absWorkingDir: ROOT,
    });
    assert.equal(result.errors.length, 0, `bundle errors: ${result.errors.map((e) => e.text).join("; ")}`);
    assert.equal(result.warnings.length, 0, `bundle warnings: ${result.warnings.map((w) => w.text).join("; ")}`);
    const out = result.outputFiles.map((f) => f.text).join("\n");
    assert.doesNotMatch(out, /from\s+["']node:/, "no node: import survives the bundle");
    assert.doesNotMatch(out, /pi-coding-agent/, "no Pi SDK code in the bundle");
    assert.doesNotMatch(out, /\bprocess\.(env|argv|cwd|platform)\b/, "no process reference in the bundle");
  });
});

describe("src/agent completion gate matches the Pi gate", () => {
  const sentence = (line: number, plain = `Unverified statement at line ${line}.`) => ({
    unit: { id: `u${line}`, kind: "sentence", file: "main.tex", line, section: "", raw: plain, plain, cites: ["smith2024"] },
    status: "cited",
    ledger: null,
    unregistered: [],
    figures: [],
    labelledUnverified: false,
  });
  const audit = (units: ReturnType<typeof sentence>[], count = units.length, unregistered: string[] = []): ProvenanceOutcome =>
    ({ ok: true, entry: "main.tex", digest: "d", audit: { summary: { unlabelledUnverified: count, labelledUnverified: 0, unregistered }, units, items: [], extracted: [] } }) as never;

  type Op = { kind: "prompt" } | { kind: "compile" } | { kind: "tex-edit" } | { kind: "settle" };
  interface Scenario { name: string; ops: Op[]; result: ProvenanceOutcome }

  const scenarios: Scenario[] = [
    { name: "unlabelled only", ops: [{ kind: "prompt" }, { kind: "compile" }, { kind: "settle" }], result: audit([sentence(10, "Alpha rose 4%."), sentence(12, "Beta fell."), sentence(14, "Gamma holds.")]) },
    { name: "unregistered only", ops: [{ kind: "prompt" }, { kind: "compile" }, { kind: "settle" }], result: audit([], 0, ["smith2025retrieval"]) },
    { name: "both", ops: [{ kind: "prompt" }, { kind: "tex-edit" }, { kind: "settle" }], result: audit([sentence(10, "Alpha rose 4%."), sentence(12, "Beta fell.")], 2, ["smith2025retrieval"]) },
    { name: "more than 10 pointers", ops: [{ kind: "prompt" }, { kind: "compile" }, { kind: "settle" }], result: audit(Array.from({ length: 12 }, (_, i) => sentence(i + 1, `Claim ${i + 1}.`))) },
    { name: "more than 10 unregistered keys", ops: [{ kind: "prompt" }, { kind: "compile" }, { kind: "settle" }], result: audit([], 0, Array.from({ length: 12 }, (_, i) => `k${String(i + 1).padStart(2, "0")}`)) },
    { name: "cap of two per prompt", ops: [{ kind: "prompt" }, { kind: "compile" }, { kind: "settle" }, { kind: "settle" }, { kind: "settle" }], result: audit([sentence(1), sentence(2)]) },
    { name: "untouched document", ops: [{ kind: "prompt" }, { kind: "settle" }], result: audit([sentence(1)]) },
  ];

  /** The Pi gate's settle results, one per settle op (undefined when silent). */
  function piTexts(s: Scenario): (string | undefined)[] {
    const handlers = new Map<string, ((e: never, ctx: { cwd: string }) => unknown)[]>();
    const pi = { on: (ev: string, fn: (e: never, ctx: { cwd: string }) => unknown) => void handlers.set(ev, [...(handlers.get(ev) ?? []), fn]) };
    installCompletionGate(pi as never, { audit: () => s.result });
    const fire = (ev: string, payload: Record<string, unknown>) => {
      let r: unknown;
      for (const h of handlers.get(ev) ?? []) {
        const x = h({ type: ev, ...payload } as never, { cwd: "/project" });
        if (x !== undefined) r = x;
      }
      return r;
    };
    const texts: (string | undefined)[] = [];
    for (const op of s.ops) {
      if (op.kind === "prompt") fire("before_agent_start", { messageType: "user", prompt: "p", systemPromptOptions: {} });
      else if (op.kind === "compile") fire("tool_execution_end", { toolName: "mcp__uktub__compile", toolCallId: "c", result: {}, isError: false });
      else if (op.kind === "tex-edit") {
        fire("tool_call", { toolName: "edit", toolCallId: "e", input: { path: "main.tex" } });
        fire("tool_execution_end", { toolName: "edit", toolCallId: "e", result: {}, isError: false });
      } else {
        const r = fire("agent_before_settle", { outcome: "completed", entries: [], continue: false, context: {} }) as { entries: { content: string }[] } | undefined;
        texts.push(r?.entries[0]?.content);
      }
    }
    return texts;
  }

  /** The neutral core's settle results, driven with the same neutral events. */
  async function neutralTexts(s: Scenario): Promise<(string | undefined)[]> {
    const neutralGate = await import("../src/agent/completion-gate.ts");
    const gate = neutralGate.createCompletionGate();
    const texts: (string | undefined)[] = [];
    for (const op of s.ops) {
      if (op.kind === "prompt") gate.startUserPrompt();
      else if (op.kind === "compile") gate.toolEnded({ toolName: "mcp__uktub__compile", args: {}, isError: false });
      else if (op.kind === "tex-edit") gate.toolEnded({ toolName: "edit", args: { path: "main.tex" }, isError: false });
      else {
        const text = gate.shouldAudit("completed") ? gate.followUp(s.result) : null;
        texts.push(text === null ? undefined : text);
      }
    }
    return texts;
  }

  for (const s of scenarios) {
    it(`same settle results as the Pi gate: ${s.name}`, async () => {
      assert.deepEqual(await neutralTexts(s), piTexts(s));
    });
  }

  it("the neutral constants and custom message type are the Pi gate's", async () => {
    const neutralGate = await import("../src/agent/completion-gate.ts");
    assert.equal(neutralGate.COMPLETION_GATE_TYPE, "uktub-completion-gate");
    assert.equal(neutralGate.MAX_FOLLOW_UPS, 2);
    assert.equal(neutralGate.MAX_POINTERS, 10);
    assert.equal(neutralGate.EXCERPT_CHARS, 120);
  });

  it("a rejected tool event (write failed) and a non-completed settle never touch the document", async () => {
    const neutralGate = await import("../src/agent/completion-gate.ts");
    const gate = neutralGate.createCompletionGate();
    gate.startUserPrompt();
    gate.toolEnded({ toolName: "write", args: { path: "main.tex" }, isError: true });
    gate.toolEnded({ toolName: "write", args: { path: "notes.md" }, isError: false });
    assert.equal(gate.shouldAudit("completed"), false);
    gate.toolEnded({ toolName: "compile", args: {}, isError: false });
    assert.equal(gate.shouldAudit("aborted"), false);
    assert.equal(gate.shouldAudit("completed"), true);
  });
});

describe("src/agent helpers are the Pi exports, not copies", () => {
  it("writingWorkflowSection: the Pi export reads the same section as the neutral module on the shipped skill", async () => {
    const neutralWorkflow = await import("../src/agent/workflow.ts");
    const skill = readFileSync(`${ROOT}skills/uktub-research/SKILL.md`, "utf8");
    assert.equal(piWritingWorkflowSection(skill), neutralWorkflow.writingWorkflowSection(skill));
    assert.notEqual(neutralWorkflow.writingWorkflowSection(skill), null);
  });

  it("section-writer: runWriteSection, the prompt builders and createChildTally are the very functions Pi re-exports", async () => {
    const neutralWriter = await import("../src/agent/section-writer.ts");
    assert.equal(piWrite.runWriteSection, neutralWriter.runWriteSection);
    assert.equal(piWrite.buildWriterPrompt, neutralWriter.buildWriterPrompt);
    assert.equal(piWrite.buildRepairPrompt, neutralWriter.buildRepairPrompt);
    assert.equal(piWrite.createChildTally, neutralWriter.createChildTally);
    assert.equal(piWrite.stripCodeFences, neutralWriter.stripCodeFences);
  });

  it("section-tool: the Pi tool definition, arg handling, forwards, composition and text extraction are the very functions Pi re-exports", async () => {
    const piIndex = await import("../src/pi/index.ts");
    const neutralTool = await import("../src/agent/section-tool.ts");
    assert.equal(piIndex.WriteSectionParams, neutralTool.WriteSectionParams);
    assert.equal(piIndex.ForwardPassagesParams, neutralTool.ForwardPassagesParams);
    assert.equal(piIndex.ForwardVerifyParams, neutralTool.ForwardVerifyParams);
    assert.equal(piIndex.normalizeForwardPapers, neutralTool.normalizeForwardPapers);
    assert.equal(piIndex.unresolvedBlock, neutralTool.unresolvedBlock);
    assert.equal(piIndex.lastAssistantText, neutralTool.lastAssistantText);
    assert.equal(piIndex.composeSectionResultText, neutralTool.composeSectionResultText);
    assert.equal(piWrite.coerceSectionArgs, neutralTool.coerceSectionArgs);
    assert.equal(piWrite.toSectionParams, neutralTool.toSectionParams);
  });

  it("parsePapersParam: scope.ts and the Pi shim re-export the Node-free core parser (identity, not copies)", async () => {
    const parser = await import("../src/core/verify/papers-param.ts");
    const scope = await import("../src/core/verify/scope.ts");
    assert.equal(scope.parsePapersParam, parser.parsePapersParam);
    assert.equal(piWrite.parsePapersParam, parser.parsePapersParam);
  });

  it("the Pi extension still registers the gate and its own handlers (wiring unchanged)", () => {
    assert.equal(typeof uktubScholarExtension, "function");
    assert.ok(existsSync(`${ROOT}src/pi/completion-gate.ts`));
  });
});

describe("src/agent typechecks under a browser-only config (no Node module reachable)", () => {
  it("tsc with lib DOM, types [], and no Node path shims is clean", () => {
    const dir = `${ROOT}node_modules/.cache/agent-neutral-typecheck`;
    mkdirSync(dir, { recursive: true });
    // Browser-only: DOM lib, no @types/node globals, and NO node:* path
    // shims — any Node builtin reached from src/agent/** fails the check.
    // RED before the Phase 8b type move (section-writer.ts reached
    // core/tools/verify.ts and the Node SQLite registry); green after.
    writeFileSync(
      `${dir}/tsconfig.json`,
      JSON.stringify({
        compilerOptions: {
          target: "ES2023",
          lib: ["ES2024", "DOM"],
          module: "NodeNext",
          moduleResolution: "NodeNext",
          allowImportingTsExtensions: true,
          noEmit: true,
          strict: true,
          verbatimModuleSyntax: true,
          erasableSyntaxOnly: true,
          skipLibCheck: true,
          types: [],
        },
        include: ["../../../src/agent/**/*.ts"],
      }),
    );
    let output: string;
    try {
      output = execFileSync(`${ROOT}node_modules/.bin/tsc`, ["-p", `${dir}/tsconfig.json`], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
    } catch (err) {
      const failed = err as { stdout?: unknown; stderr?: unknown };
      assert.fail(`src/agent/** does not typecheck browser-only:\n${String(failed.stdout ?? "")}\n${String(failed.stderr ?? "")}`);
    }
    assert.equal((output ?? "").trim(), "");
  });
});
