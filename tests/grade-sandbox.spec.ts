/**
 * Grader sandbox boundary (scripts/live/sandbox.ts): a grader session sees the note export and the
 * corpus read-only, one writable output dir, the agent dir and ADC — nothing else. Secrets travel by
 * name only, and provider keys are never part of a grader spec (grade-lib.graderSecretsOnly builds it).
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { graderCommand, type GraderSandboxSpec } from "../scripts/live/sandbox.ts";

const SECRET = "oc-test-0123456789abcdefghijklmnopqrstuv";

function spec(over: Partial<GraderSandboxSpec> = {}): GraderSandboxSpec {
  const root = mkdtempSync(join(tmpdir(), "grader-spec-"));
  const dir = (name: string): string => {
    const p = join(root, name);
    mkdirSync(p, { recursive: true });
    return p;
  };
  return {
    image: "uktub-scholar-sandbox",
    name: "uktub-grade-test",
    noteDir: dir("note"),
    corpusDir: dir("corpus"),
    outDir: dir("out"),
    agentDir: dir("agent"),
    adcFile: join(root, "adc.json"),
    env: { GOOGLE_CLOUD_PROJECT: "p" },
    secretEnv: { OPENCODE_API_KEY: SECRET },
    ...over,
  };
}

describe("graderCommand", () => {
  it("mounts only note/corpus read-only plus writable out/agent dirs and read-only ADC", () => {
    const s = spec();
    const { args } = graderCommand(s, ["pi", "--mode", "rpc"]);
    const vols = args.filter((_, i) => args[i - 1] === "-v");
    assert.ok(vols.some((v) => v === `${s.noteDir}:/work/note:ro`), vols.join(" "));
    assert.ok(vols.some((v) => v === `${s.corpusDir}:/work/corpus:ro`), vols.join(" "));
    const out = vols.find((v) => v.startsWith(`${s.outDir}:`)) ?? "";
    assert.ok(out === `${s.outDir}:/work/out`, `out dir must be writable, got ${out}`);
    assert.ok(vols.some((v) => v === `${s.adcFile}:/adc/adc.json:ro`), vols.join(" "));
    assert.ok(!vols.some((v) => /stage|project|evidence|run|tectonic|uktub-scholar/i.test(v) && !v.startsWith(s.outDir)), vols.join(" "));
  });

  it("forwards secrets by name only: no value in argv (the client env carries it, as with sandboxCommand)", () => {
    const s = spec();
    const { args, env } = graderCommand(s, ["pi"]);
    assert.ok(args.includes("-e") && args.includes("OPENCODE_API_KEY"), args.join(" "));
    assert.ok(!args.some((a: string) => a.includes(SECRET)), "secret value in argv");
    assert.equal(env["OPENCODE_API_KEY"], SECRET, "client env must carry the value docker forwards by name");
  });

  it("carries no provider keys even when handed them (defence in depth)", () => {
    const s = spec({ secretEnv: { OPENCODE_API_KEY: SECRET } });
    const { args } = graderCommand(s, ["pi"]);
    for (const k of ["SEMANTIC_SCHOLAR_API_KEY", "OPENALEX_API_KEY", "CROSSREF_MAILTO"]) {
      assert.ok(!args.includes(k), `${k} must never reach a grader container`);
    }
  });

  it("keeps the hardening: read-only root, no capabilities, pipe-only, named container", () => {
    const s = spec();
    const { args } = graderCommand(s, ["pi"]);
    assert.deepEqual(args.slice(0, 4), ["run", "--rm", "-i", "--init"]);
    assert.ok(args.includes("--read-only"));
    assert.ok(args.includes("--cap-drop") && args.includes("ALL"));
    assert.equal(args[args.indexOf("--name") + 1], s.name);
    assert.equal(args.at(-2), s.image);
  });
});
