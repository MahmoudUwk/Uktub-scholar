import { test } from "node:test";
import assert from "node:assert/strict";
import { directCases, NotRun, type Ctx } from "../scripts/live/cases.ts";

test("a live fallback-route fixture that now has a direct PDF is reported unexercised, not as a product failure", async () => {
  const ids = ["10.48550/arxiv.2511.15162", "10.1109/ojcoms.2025.3600616", "10.1109/lwc.2026.3664439"];
  const kinds = ["arxiv-pdf", "arxiv-preprint-pdf", "openalex-pdf-url"];
  const ctx = {
    hasKey: () => true,
    mcp: { call: async (_name: string, args: Record<string, unknown>) => ({
      content: [],
      structuredContent: args.action === "register"
        ? { outcomes: ids.map(() => ({ status: "registered" })) }
        : args.action === "read"
          ? { records: ids.map((doi, i) => ({ doi, source: { status: "ready", kind: kinds[i] } })) }
          : { coverage: { sources: { ready: 3, preprint: [ids[1]] } } },
    }) },
  } as unknown as Ctx;
  const c = directCases.find((c) => c.id === "verify.acquires-open-copies-beyond-openalex-pdf-url")!;
  await assert.rejects(c.run(ctx), (e: unknown) => e instanceof NotRun && /fixture|direct PDF/i.test(e.message));
});
