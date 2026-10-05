import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { isAbsolute, join } from "node:path";
import { fileURLToPath } from "node:url";

import uktubScholarExtension from "../src/pi/index.ts";

const ROOT = fileURLToPath(new URL("..", import.meta.url));

type StartHandler = (event: { systemPromptOptions: { promptGuidelines?: string[] } }) => unknown;
type CallHandler = (event: { toolName: string; input: { path?: string } }, ctx: { cwd: string }) => { block?: boolean; reason?: string } | undefined;

function register(): { name: string | undefined; config: { command: string; args: string[]; exposure?: string; description?: string }; onStart?: StartHandler; onCall?: CallHandler } {
  let name: string | undefined;
  let config: unknown;
  let onStart: StartHandler | undefined;
  let onCall: CallHandler | undefined;
  uktubScholarExtension({
    registerMcpServer: (n: string, c: unknown) => ((name = n), (config = c)),
    on: (event: string, handler: never) => void (event === "before_agent_start" ? (onStart = handler) : event === "tool_call" && (onCall = handler)),
  } as never);
  return { name, config: config as never, onStart, onCall };
}

test("pi extension registers the uktub-scholar MCP server", () => {
  assert.equal(register().name, "uktub-scholar");
});

test("the registered command is spawnable wherever the package is installed (no PATH, no linked bin)", () => {
  const { command, args } = register().config;
  assert.ok(isAbsolute(command) && statSync(command).isFile(), `command ${command} must be an absolute executable`);
  assert.ok(isAbsolute(args[0]) && existsSync(args[0]), `entry ${args[0]} must exist`);
  assert.deepEqual(args.slice(1), ["mcp"]);
});

test("the server is exposed directly to the model and described for the system prompt", () => {
  const { exposure, description } = register().config;
  assert.equal(exposure, "direct", "five small tools: declare them, do not hide them behind codemode");
  assert.match(description ?? "", /paper|scholar/i);
});

test("the package manifest ships the research skill beside the extension", () => {
  const manifest = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8")).pi as { extensions: string[]; skills?: string[] };
  assert.ok(manifest.extensions.length > 0);
  assert.ok(manifest.skills?.length, "pi.skills must name the skills directory, or Pi never loads uktub-research");
  for (const dir of manifest.skills ?? []) assert.ok(existsSync(join(ROOT, dir, "uktub-research", "SKILL.md")), `${dir}/uktub-research/SKILL.md`);
});

test("the agent rules reach the Pi model as system-prompt guidelines (Pi shows only one line of MCP server instructions)", () => {
  const { onStart } = register();
  assert.ok(onStart, "extension must subscribe to before_agent_start");
  const options: { promptGuidelines?: string[] } = { promptGuidelines: ["existing rule"] };
  onStart({ systemPromptOptions: options });
  assert.equal(options.promptGuidelines?.[0], "existing rule", "keeps other contributors' guidelines");
  const joined = (options.promptGuidelines ?? []).join("\n");
  assert.match(joined, /verbatim/);
  assert.match(joined, /warning/i);
  assert.match(joined, /Refused/);
  onStart({ systemPromptOptions: options });
  assert.equal((options.promptGuidelines ?? []).filter((g) => /verbatim/.test(g)).length, 1, "idempotent: no duplicates when a run starts again");
});

test("the agent cannot edit the two tool-owned paths: refs/references.bib and .registry/ (agent read-only, human writable)", () => {
  const { onCall } = register();
  assert.ok(onCall, "extension must subscribe to tool_call");
  const root = mkdtempSync(join(tmpdir(), "uktub-pi-guard-"));
  try {
    mkdirSync(join(root, ".registry"));
    const call = (toolName: string, path: string) => onCall({ toolName, input: { path } }, { cwd: root });
    for (const tool of ["edit", "write"]) {
      for (const path of ["refs/references.bib", "./refs/references.bib", join(root, "refs", "references.bib"), "manuscript/../refs/references.bib", ".registry/registry.db"]) {
        const r = call(tool, path);
        assert.equal(r?.block, true, `${tool} ${path} must be blocked`);
        assert.match(r?.reason ?? "", /paper_registry/, "the reason points at the legitimate route");
        assert.match(r?.reason ?? "", /user/i, "and at what the user can do");
        assert.match(r?.reason ?? "", /do not (create|write|invent)/i, "and says plainly not to route around the block");
      }
      for (const path of ["manuscript/main.tex", "refs/extra.bib", "notes/references.bib", "refs/references.bib.md"]) assert.equal(call(tool, path)?.block, undefined, `${tool} ${path} stays allowed`);
    }
    assert.equal(call("read", "refs/references.bib")?.block, undefined, "reading is fine");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("the guard also holds from a subdirectory of the project", () => {
  const { onCall } = register();
  const root = mkdtempSync(join(tmpdir(), "uktub-pi-guard-"));
  try {
    mkdirSync(join(root, ".registry"));
    mkdirSync(join(root, "manuscript"));
    assert.equal(onCall?.({ toolName: "write", input: { path: "../refs/references.bib" } }, { cwd: join(root, "manuscript") })?.block, true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
