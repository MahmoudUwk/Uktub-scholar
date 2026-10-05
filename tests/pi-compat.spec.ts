import { test } from "node:test";
import assert from "node:assert/strict";

import uktubScholarExtension from "../src/pi/index.ts";

test("pi extension registers uktub-scholar MCP server via pi.registerMcpServer", () => {
  let registeredName: string | undefined;
  let registeredConfig: unknown;

  const fakePi = {
    registerMcpServer(name: string, config: unknown) {
      registeredName = name;
      registeredConfig = config;
    },
  };

  uktubScholarExtension(fakePi as never);

  assert.equal(registeredName, "uktub-scholar");
  assert.deepEqual(registeredConfig, {
    command: "uktub-scholar",
    args: ["mcp"],
  });
});
