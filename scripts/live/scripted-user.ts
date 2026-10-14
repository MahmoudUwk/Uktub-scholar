/**
 * The scripted user for measured runs (PLAN §4.4): a pure state machine on file state.
 * First message is the scenario request; after each assistant turn a stale/missing PDF nudges,
 * otherwise the revision text goes out once and repeats until a .tex edit follows it; then end.
 */
import { readdirSync, statSync } from "node:fs";
import { join } from "node:path";

export interface ScriptedTexts {
  request: string;
  revision: string;
  nudge: string;
}

export interface ScriptedFileState {
  /** A PDF exists that is newer than the last .tex edit. */
  pdfCurrent: boolean;
  /** The revision text has been sent before. */
  revisionRequested: boolean;
  /** A .tex edit happened after the revision request was sent. */
  texEditedSinceRevision: boolean;
}

export type ScriptedNext = { done: true } | { done: false; message: string };

/**
 * The next scripted user message from file state (PLAN §4.4):
 * the request first; then the nudge while no PDF is newer than the last .tex edit;
 * then the revision until a .tex edit follows it; then end.
 */
export function nextScriptedMessage(
  assistantTurns: number,
  texts: ScriptedTexts,
  files: ScriptedFileState,
): ScriptedNext {
  if (assistantTurns === 0) return { done: false, message: texts.request };
  if (!files.pdfCurrent) return { done: false, message: texts.nudge };
  if (!files.revisionRequested || !files.texEditedSinceRevision) return { done: false, message: texts.revision };
  return { done: true };
}

const section = (scenarioText: string, name: string): string =>
  new RegExp(`^## ${name}\\s*\\n([\\s\\S]*?)(?=^## |$(?![\\s\\S]))`, "m").exec(scenarioText)?.[1]?.trim() ?? "";

/** One surrounding ``` fence, when the section body is fenced. */
const unfenced = (body: string): string => {
  const m = /^```\w*\n([\s\S]*?)\n```$/.exec(body.trim());
  return (m?.[1] ?? body).trim();
};

/** The three exact texts the scripted user sends, parsed from the scenario file. */
export function parseScriptedTexts(scenarioText: string): ScriptedTexts {
  const texts = {
    request: unfenced(section(scenarioText, "Request")),
    revision: unfenced(section(scenarioText, "Revision")),
    nudge: unfenced(section(scenarioText, "Nudge")),
  };
  for (const [name, text] of Object.entries(texts)) {
    if (text === "") throw new Error(`scripted scenario needs a non-empty ## ${name[0]!.toUpperCase()}${name.slice(1)} section`);
  }
  return texts;
}

const walk = (dir: string): string[] =>
  readdirSync(dir, { recursive: true, withFileTypes: true })
    .filter((e) => e.isFile())
    .map((e) => join(e.parentPath, e.name));

const mtimes = (projectDir: string, ext: string): number[] =>
  walk(projectDir)
    .filter((f) => f.endsWith(ext))
    .map((f) => statSync(f).mtimeMs);

/** Newest .tex mtime (ms epoch) under the project dir, or null when there is none. */
export function lastTexEditMtime(projectDir: string): number | null {
  const ts = mtimes(projectDir, ".tex");
  return ts.length === 0 ? null : Math.max(...ts);
}

/** True when a PDF under the project dir is strictly newer than the last .tex edit. */
export function pdfIsCurrent(projectDir: string): boolean {
  const lastTex = lastTexEditMtime(projectDir);
  if (lastTex === null) return false;
  return mtimes(projectDir, ".pdf").some((t) => t > lastTex);
}

/** True when a .tex file under the project dir was modified after `sinceMs`. */
export function texEditedSince(projectDir: string, sinceMs: number): boolean {
  return mtimes(projectDir, ".tex").some((t) => t > sinceMs);
}
