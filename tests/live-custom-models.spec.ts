/**
 * Custom Pi models for the live harness (owner decision 2026-10-19): MiniMax M3.1 Flash on OpenCode Go as the
 * assistant option and as grader B (the free variant was deprecated upstream on 2026-10-23: 410 ModelDeprecated). Every agent dir gets a models.json that Pi's own loader accepts, with no key in it.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

import { parseModelSetting } from "../scripts/live/agent.ts";
import { assistantSecretsForProvider } from "../scripts/live/env.ts";
import { graderModel, graderModelId } from "../scripts/live/grade-lib.ts";
import { writePiSettings } from "../scripts/live/sandbox.ts";

const ROOT = resolve(import.meta.dirname, "..");
const MINIMAX = { provider: "opencode-go", id: "minimax-m3.1-flash" };

/** Pi's own models.json validator (the exact schema the running Pi enforces). Not exported from the package index, so it is loaded by file path. */
async function piModelConfig(): Promise<{ load(path: string): Promise<{ getError(): string | undefined; getProvider(id: string): { models?: Array<Record<string, unknown>>; apiKey?: unknown } | undefined }> }> {
  const mod = await import(pathToFileURL(resolve(ROOT, "node_modules/@earendil-works/pi-coding-agent/dist/core/model-config.js")).href);
  return mod.ModelConfig;
}

async function withDir<T>(fn: (dir: string) => T | Promise<T>): Promise<T> {
  const dir = mkdtempSync(join(tmpdir(), "uktub-models-"));
  try {
    return await fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

describe("models.json for the live harness", () => {
  it("writePiSettings writes a models.json that Pi's loader accepts, with the MiniMax model on opencode-go", async () => {
    await withDir(async (dir) => {
      writePiSettings(dir);
      const cfg = await (await piModelConfig()).load(join(dir, "models.json"));
      assert.equal(cfg.getError(), undefined, cfg.getError());
      const model = cfg.getProvider("opencode-go")?.models?.find((m) => m.id === MINIMAX.id);
      assert.ok(model, "minimax-m3.1-flash is registered under opencode-go");
      assert.equal(model.name, "MiniMax M3.1 Flash");
      assert.equal(model.api, "anthropic-messages");
      assert.equal(model.baseUrl, "https://opencode.ai/inference/go");
      assert.equal(typeof model.contextWindow, "number");
      assert.equal(typeof model.maxTokens, "number");
    });
  });

  it("writePiSettings puts models.json into the agent dir next to settings.json", async () => {
    await withDir((dir) => {
      writePiSettings(dir);
      const models = JSON.parse(readFileSync(join(dir, "models.json"), "utf8")) as { providers: Record<string, { models: Array<{ id: string }> }> };
      assert.ok(models.providers["opencode-go"]?.models.some((m) => m.id === MINIMAX.id));
    });
  });

  it("never writes a credential: no apiKey field and no key name in models.json", async () => {
    await withDir((dir) => {
      writePiSettings(dir);
      const text = readFileSync(join(dir, "models.json"), "utf8");
      assert.ok(!/apiKey|OPENCODE_API_KEY|Bearer|sk-/i.test(text), "no key field or key-like value");
      const parsed = JSON.parse(text) as { providers: Record<string, Record<string, unknown>> };
      for (const [id, provider] of Object.entries(parsed.providers)) assert.ok(!("apiKey" in provider), `${id} has no apiKey`);
    });
  });
});

describe("grader B and the opencode-go assistant", () => {
  it("parses the MiniMax setting and gives an opencode-go assistant its key by name", () => {
    assert.deepEqual(parseModelSetting("opencode-go/minimax-m3.1-flash"), MINIMAX);
    const secrets = assistantSecretsForProvider("opencode-go", (name) => (name === "OPENCODE_API_KEY" ? "fake-test-value" : undefined));
    assert.deepEqual(Object.keys(secrets), ["OPENCODE_API_KEY"]);
  });

  it("makes grader B the MiniMax model on OpenCode Go; grader A stays Muse", () => {
    assert.deepEqual(graderModel("B"), MINIMAX);
    assert.equal(graderModelId("B"), "opencode-go/minimax-m3.1-flash");
    assert.equal(graderModelId("A"), "opencode-go/muse-spark-1.3-contributor");
  });
});
