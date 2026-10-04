import { readFileSync } from "node:fs";
import { join } from "node:path";
import { searchPapersTool } from "../src/core/tools/search.ts";
import { WriteQueue } from "../src/core/queue.ts";
import type { ToolContext } from "../src/core/tools/context.ts";

function loadEnv(): Record<string, string> {
  const env: Record<string, string> = {};
  try {
    const lines = readFileSync("../UktubAI_Agentic/.env", "utf8").split("\n");
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#")) continue;
      const idx = trimmed.indexOf("=");
      if (idx !== -1) {
        env[trimmed.slice(0, idx).trim()] = trimmed.slice(idx + 1).trim();
      }
    }
  } catch {}
  return env;
}

const baseEnv = loadEnv();

function makeContext(fetchImpl: typeof fetch = fetch, extraEnv: Record<string, string> = {}): ToolContext {
  return {
    root: "/tmp",
    fetch: fetchImpl as unknown as ToolContext["fetch"],
    env: { ...baseEnv, ...extraEnv },
    now: () => new Date(),
    queue: new WriteQueue(),
  };
}

async function runTest() {
  console.log("=== Item 2: Real paper search ===");

  const queries = [
    { name: "DOI-shaped", q: "10.1038/s41586-020-2649-2" },
    { name: "arXiv ID", q: "arxiv:2411.09996" },
    { name: "Misspelling", q: "reciporcal rank fusoin retreival" },
    { name: "Non-English (French)", q: "apprentissage par renforcement profond" },
    { name: "Non-English (Arabic)", q: "شبكات عصبية عميقة" },
    { name: "Very broad", q: "artificial intelligence" },
    { name: "Nonsense", q: "xyzqwekjlasd9871234zxczxc" },
    { name: "Author + Title", q: "Vaswani Attention is all you need" },
    { name: "Technical / niche", q: "RISC-V formal verification CHERI" },
    { name: "Punctuation & symbols", q: "C++20 coroutines vs Go channels: throughput & latency" },
    { name: "Long natural query", q: "Deep residual learning for image recognition with convolutional neural networks" },
  ];

  console.log("\n--- Testing 11 varied live queries ---");
  for (const { name, q } of queries) {
    const t0 = Date.now();
    const res = await searchPapersTool(makeContext(), { query: q });
    const ms = Date.now() - t0;
    const structured = res.structuredContent!;
    console.log(`[${name}] query="${q}" in ${ms}ms -> ${structured.returned} candidates, ${structured.warnings.length} warnings`);
    if (structured.candidates.length > 0) {
      const top = structured.candidates[0];
      console.log(`   Top: "${top.title}" (${top.year ?? "no-year"}) DOI=${top.doi ?? "none"} [${top.endpoint}]`);
    }
    if (structured.warnings.length > 0) {
      console.log(`   Warnings: ${structured.warnings.map(w => `${w.provider}: ${w.code}`).join(", ")}`);
    }
  }

  console.log("\n--- Testing result limits ---");
  for (const limit of [1, 5, 10, 20]) {
    const res = await searchPapersTool(makeContext(), { query: "machine learning", limit });
    const structured = res.structuredContent!;
    console.log(`Requested limit=${limit} -> returned ${structured.returned}, truncated=${structured.truncated}`);
    if (structured.returned > limit) {
      console.error(`ERROR: returned ${structured.returned} exceeds limit ${limit}`);
    }
  }

  console.log("\n--- Testing provider degradation ---");
  // 1. Block OpenAlex
  const blockOpenAlexFetch: typeof fetch = async (url, init) => {
    if (String(url).includes("openalex.org")) {
      throw new Error("simulated network error to openalex");
    }
    return fetch(url, init);
  };
  const resBlockOA = await searchPapersTool(makeContext(blockOpenAlexFetch), { query: "reinforcement learning" });
  console.log(`Blocked OpenAlex -> returned ${resBlockOA.structuredContent?.returned} candidates, warnings: ${JSON.stringify(resBlockOA.structuredContent?.warnings)}`);

  // 2. Block Semantic Scholar
  const blockS2Fetch: typeof fetch = async (url, init) => {
    if (String(url).includes("semanticscholar.org")) {
      throw new Error("simulated network error to semantic scholar");
    }
    return fetch(url, init);
  };
  const resBlockS2 = await searchPapersTool(makeContext(blockS2Fetch), { query: "reinforcement learning" });
  console.log(`Blocked Semantic Scholar -> returned ${resBlockS2.structuredContent?.returned} candidates, warnings: ${JSON.stringify(resBlockS2.structuredContent?.warnings)}`);

  // 3. Block all 3 providers
  const blockAllFetch: typeof fetch = async (url, init) => {
    throw new Error("simulated network outage");
  };
  const resBlockAll = await searchPapersTool(makeContext(blockAllFetch), { query: "reinforcement learning" });
  console.log(`Blocked all providers -> isError=${resBlockAll.isError}, content: ${JSON.stringify(resBlockAll.content)}`);
}

runTest().catch((e) => {
  console.error("FAIL:", e);
  process.exit(1);
});
