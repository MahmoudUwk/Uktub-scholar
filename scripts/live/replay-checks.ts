/**
 * Read-only replay of the two conditional checks (`length-within-request`,
 * `sourced-numerics`) for a recorded iteration.
 *
 *   node scripts/live/replay-checks.ts <run-dir>
 *
 * It reads the same files the experiment reads — the entry manuscript, the
 * iteration's Uktub transcript (tool results plus user messages), and the
 * scenario prompt — recomputes ONLY these two checks, and prints the
 * verdicts as JSON. It never writes: no filesystem writes, no tools, no
 * network. A missing transcript or manuscript fails closed (a verdict of
 * `ok: false`), never a silent pass.
 */
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import {
  checkLengthWithinRequest,
  checkSourcedNumerics,
  parseScenarioSections,
} from "./deliverable-checks.ts";

const runDir = process.argv[2];
if (runDir === undefined || runDir === "") {
  console.error("usage: replay-checks.ts <run-dir>");
  process.exit(2);
}
const repo = resolve(import.meta.dirname, "../..");

const read = (path: string): string | null => {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return null;
  }
};

const safeJson = (value: unknown): string => {
  try {
    return JSON.stringify(value) ?? "";
  } catch {
    return "";
  }
};

/** Text the agent actually saw in one recorded turn: user prompt, tool ends, and any toolResult messages. */
function seenTextOfTurn(turn: unknown): string[] {
  if (typeof turn !== "object" || turn === null) return [];
  const t = turn as Record<string, unknown>;
  const parts: string[] = [];
  if (typeof t.prompt === "string") parts.push(t.prompt);
  if (Array.isArray(t.ends)) {
    for (const e of t.ends as Array<Record<string, unknown>>) {
      if (typeof e?.text === "string") parts.push(e.text);
      if (e?.structured !== undefined && e?.structured !== null) parts.push(safeJson(e.structured));
    }
  }
  if (Array.isArray(t.messages)) {
    for (const m of t.messages as Array<Record<string, unknown>>) {
      const content = m?.content;
      if (m?.role === "toolResult" || m?.role === "tool") {
        parts.push(typeof content === "string" ? content : safeJson(content));
      } else if (Array.isArray(content)) {
        for (const b of content as Array<Record<string, unknown>>) {
          if (b?.type === "toolResult" || b?.type === "tool_result") parts.push(safeJson(b));
        }
      }
    }
  }
  return parts;
}

const metricsRaw = read(join(runDir, "metrics.json"));
if (metricsRaw === null) {
  console.error(`no metrics.json in ${runDir}`);
  process.exit(2);
}
const metrics = JSON.parse(metricsRaw) as { scenario?: string; deliverable?: { texFiles?: string[] } };
const scenarioName = typeof metrics.scenario === "string" ? metrics.scenario : "";
const scenarioText = scenarioName === "" ? null : read(join(repo, "experiments/scenarios", `${scenarioName}.md`));
if (scenarioText === null) {
  console.error(`no scenario file for ${JSON.stringify(scenarioName)}`);
  process.exit(2);
}
const spec = parseScenarioSections(scenarioText);

const texFiles = metrics.deliverable?.texFiles;
const entryRel = Array.isArray(texFiles) && typeof texFiles[0] === "string" && texFiles[0] !== ""
  ? (texFiles[0] as string)
  : "manuscript/main.tex";
const entryTex = read(join(runDir, "deliverables", entryRel));

const turnsRaw = read(join(runDir, "evidence/uktub-turns.jsonl"));
const evidenceText = turnsRaw === null
  ? null
  : turnsRaw.split("\n").filter((l) => l.trim() !== "").flatMap((line) => {
    try {
      return seenTextOfTurn(JSON.parse(line));
    } catch {
      return [];
    }
  }).join("\n");

const length = checkLengthWithinRequest(entryTex, spec.prompt);
console.log(JSON.stringify({
  runDir,
  scenario: scenarioName,
  entry: entryRel,
  lengthWithinRequest: length ?? { id: "length-within-request", emitted: false, detail: "no word range in the scenario prompt" },
  sourcedNumerics: checkSourcedNumerics(entryTex, evidenceText, spec.prompt),
}, null, 2));
