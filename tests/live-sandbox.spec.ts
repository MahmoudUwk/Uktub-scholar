/**
 * Sandbox boundary (scripts/live/sandbox.ts): the `docker run` argv a host or the interactive launcher gets. An interactive Pi needs a
 * terminal (`-t`); every other run stays pipe-only, and the hardening (no capabilities, read-only root, the host user, read-only
 * credentials, no repository mount) is the same either way.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { sandboxCommand, type SandboxSpec } from "../scripts/live/sandbox.ts";

function spec(over: Partial<SandboxSpec> = {}): SandboxSpec {
  const root = mkdtempSync(join(tmpdir(), "sandbox-spec-"));
  const dir = (name: string): string => {
    const p = join(root, name);
    mkdirSync(p, { recursive: true });
    return p;
  };
  return {
    image: "uktub-scholar-sandbox", name: "uktub-test", stageDir: dir("stage"), projectDir: dir("project"), agentDir: dir("agent"), runDir: dir("run"),
    adcFile: join(root, "adc.json"), tectonicCache: dir("tectonic"), uktubCache: dir("cache"),
    eos: { venv: dir("venv"), pythonStore: dir("python"), model: dir("model") },
    env: { GOOGLE_CLOUD_PROJECT: "p" },
    ...over,
  };
}

describe("sandboxCommand", () => {
  it("is pipe-only (-i, no terminal) unless the session is interactive", () => {
    const { args } = sandboxCommand(spec(), ["pi"]);
    assert.ok(args.includes("-i"));
    assert.ok(!args.includes("-t") && !args.includes("-it"));
  });

  it("allocates a terminal for an interactive session and keeps the whole boundary", () => {
    const s = spec({ tty: true });
    const { args } = sandboxCommand(s, ["pi"]);
    assert.deepEqual(args.slice(0, 4), ["run", "--rm", "-it", "--init"]);
    assert.ok(args.includes("--read-only"));
    assert.deepEqual(args.slice(args.indexOf("--cap-drop"), args.indexOf("--cap-drop") + 2), ["--cap-drop", "ALL"]);
    assert.equal(args[args.indexOf("--user") + 1], `${process.getuid?.() ?? 1000}:${process.getgid?.() ?? 1000}`);
    assert.ok(args.includes(`${s.adcFile}:/adc/adc.json:ro`), "ADC is mounted read-only");
    assert.equal(args.at(-2), s.image);
    assert.equal(args.at(-1), "pi");
  });
});
