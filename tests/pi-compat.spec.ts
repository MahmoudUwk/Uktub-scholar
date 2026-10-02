import { test } from "node:test";
import assert from "node:assert/strict";
import uktubOaExtension from "../src/pi/extension.ts";

/**
 * Fake-Pi load harness (pattern: UktubAI_Agentic tests/contract/pi-extension-compat.spec.ts).
 * The extension imports Pi types only (type-only import, erased at runtime), so the
 * harness never needs the real package at runtime. U1 scope: the load guard.
 * U5 fills the full registration assertions.
 */

function makeFakePi(withRegisterTool: boolean) {
  const registered: { tools?: unknown[] } = {};
  const fakePi = {
    // registerTool omitted entirely when absent — the guard must key on its existence.
    ...(withRegisterTool
      ? {
          registerTool(def: unknown) {
            (registered.tools ??= []).push(def);
          },
        }
      : {}),
    on() {},
  };
  return { fakePi, registered };
}

test("load guard: Pi without registerTool throws the typed refusal, not a TypeError", () => {
  const { fakePi } = makeFakePi(false);
  assert.throws(
    () => uktubOaExtension(fakePi as never),
    (err: unknown) => {
      assert.ok(err instanceof Error);
      assert.match(err.message, /PI_EXTENSION_API_UNAVAILABLE/);
      assert.match(err.message, /upgrade Pi/);
      return true;
    },
  );
});

test("load guard: Pi with registerTool loads without throwing (U1 stub)", () => {
  const { fakePi } = makeFakePi(true);
  uktubOaExtension(fakePi as never); // must not throw
});
