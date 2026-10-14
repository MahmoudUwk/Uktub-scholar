/**
 * The scripted user (PLAN §4.4): a pure state machine on file state that replaces the simulator in measured runs.
 * No providers; file state comes from temp dirs below.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  lastTexEditMtime,
  nextScriptedMessage,
  parseScriptedTexts,
  pdfIsCurrent,
  texEditedSince,
  type ScriptedTexts,
} from "../scripts/live/scripted-user.ts";

const TEXTS: ScriptedTexts = {
  request: "REQUEST",
  revision: "REVISION",
  nudge: "Please continue until the note is complete and compiled. I have no further input.",
};

const fresh = (pdfCurrent: boolean, revisionRequested = false, texEditedSinceRevision = false) => ({
  pdfCurrent,
  revisionRequested,
  texEditedSinceRevision,
});

describe("nextScriptedMessage", () => {
  it("first message is the scenario request, whatever the file state", () => {
    for (const files of [fresh(false), fresh(true, true, true)]) {
      const next = nextScriptedMessage(0, TEXTS, files);
      assert.deepEqual(next, { done: false, message: "REQUEST" });
    }
  });

  it("with no current PDF after an assistant turn, sends the fixed nudge", () => {
    const next = nextScriptedMessage(1, TEXTS, fresh(false));
    assert.deepEqual(next, { done: false, message: TEXTS.nudge });
  });

  it("a stale PDF (older than the last .tex edit) also nudges, even after the revision", () => {
    const next = nextScriptedMessage(3, TEXTS, fresh(false, true, true));
    assert.deepEqual(next, { done: false, message: TEXTS.nudge });
  });

  it("with a current PDF and no revision requested yet, sends the revision text", () => {
    const next = nextScriptedMessage(2, TEXTS, fresh(true));
    assert.deepEqual(next, { done: false, message: "REVISION" });
  });

  it("with a current PDF but no .tex edit since the revision request, repeats the revision", () => {
    const next = nextScriptedMessage(3, TEXTS, fresh(true, true, false));
    assert.deepEqual(next, { done: false, message: "REVISION" });
  });

  it("ends only when the PDF is current and the .tex changed since the revision request", () => {
    assert.deepEqual(nextScriptedMessage(4, TEXTS, fresh(true, true, true)), { done: true });
  });
});

describe("parseScriptedTexts", () => {
  const SCENARIO = [
    "# Scenario",
    "",
    "## Prompt",
    "",
    "Do the thing.",
    "",
    "## Request",
    "",
    "```text",
    "Do the thing, request form.",
    "```",
    "",
    "## Revision",
    "",
    "Revise the table and sharpen the controls.",
    "",
    "## Nudge",
    "",
    "```text",
    "Please continue until the note is complete and compiled. I have no further input.",
    "```",
    "",
  ].join("\n");

  it("parses the three texts, stripping one surrounding fence", () => {
    assert.deepEqual(parseScriptedTexts(SCENARIO), {
      request: "Do the thing, request form.",
      revision: "Revise the table and sharpen the controls.",
      nudge: "Please continue until the note is complete and compiled. I have no further input.",
    });
  });

  it("throws naming the missing section", () => {
    assert.throws(() => parseScriptedTexts("## Request\n\nx\n"), /revision/i);
    assert.throws(() => parseScriptedTexts(""), /request/i);
  });
});

describe("scripted file state", () => {
  const dir = mkdtempSync(join(tmpdir(), "live-scripted-"));
  const tex = join(dir, "manuscript", "main.tex");
  const pdf = join(dir, "build", "main.pdf");
  mkdirSync(join(dir, "manuscript"), { recursive: true });
  mkdirSync(join(dir, "build"), { recursive: true });
  const t0 = Date.now() - 60_000;
  const setTimes = (p: string, ms: number): void => utimesSync(p, new Date(ms), new Date(ms));

  it("pdfIsCurrent is true only when a PDF is strictly newer than the last .tex edit", () => {
    rmSync(dir, { recursive: true, force: true });
    mkdirSync(join(dir, "manuscript"), { recursive: true });
    mkdirSync(join(dir, "build"), { recursive: true });
    assert.equal(pdfIsCurrent(dir), false, "no files at all");
    writeFileSync(tex, "hello");
    setTimes(tex, t0);
    assert.equal(pdfIsCurrent(dir), false, "tex but no pdf");
    writeFileSync(pdf, "pdf");
    setTimes(pdf, t0);
    assert.equal(pdfIsCurrent(dir), false, "same mtime is not newer");
    setTimes(pdf, t0 + 1000);
    assert.equal(pdfIsCurrent(dir), true, "pdf newer than tex");
    setTimes(tex, t0 + 2000);
    assert.equal(pdfIsCurrent(dir), false, "tex edited after the pdf");
  });

  it("lastTexEditMtime is null without .tex, else the newest .tex mtime; texEditedSince compares against it", () => {
    assert.equal(typeof lastTexEditMtime(dir), "number");
    assert.equal(texEditedSince(dir, t0 + 3000), false);
    assert.equal(texEditedSince(dir, t0 + 1000), true);
    rmSync(join(dir, "manuscript"), { recursive: true, force: true });
    assert.equal(lastTexEditMtime(dir), null);
  });
});
