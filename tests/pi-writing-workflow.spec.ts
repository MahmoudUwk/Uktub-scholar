/**
 * W6.1: the parent writes the abstract, introduction and conclusion itself,
 * last, from the saved section files (structural assertions only).
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import uktubScholarExtension, { bundledSkillPath, readWritingWorkflow, SECTION_WRITER_RULE, writingWorkflowSection } from "../src/pi/index.ts";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const SKILL = join(ROOT, "skills", "uktub-research", "SKILL.md");
const HEADING = "## Writing a document from the papers";

type StartHandler = (event: { systemPromptOptions: { promptGuidelines?: string[] } }) => unknown;

function startHandler(): StartHandler {
  let onStart: StartHandler | undefined;
  uktubScholarExtension({
    registerMcpServer: () => {},
    on: (event: string, handler: never) => void (event === "before_agent_start" && (onStart = handler)),
  } as never);
  assert.ok(onStart, "extension must subscribe to before_agent_start");
  return onStart;
}

const skillSection = (): string => {
  const section = writingWorkflowSection(readFileSync(SKILL, "utf8"));
  assert.ok(section !== null, "the current skill has the section");
  return section;
};

describe("writingWorkflowSection", () => {
  it("returns exactly the document-writing section of the current skill (heading through the step before the next ## heading)", () => {
    const section = skillSection();
    assert.ok(section.startsWith(HEADING), "starts with its heading");
    assert.ok(!/^## /m.test(section.slice(HEADING.length)), "stops before the next ## heading");
    assert.ok(section.endsWith("."), "trimmed");
  });

  it("returns null when the heading is missing", () => {
    assert.equal(writingWorkflowSection("# Skill\n\n## Other section\n\ntext\n"), null);
  });
});

describe("readWritingWorkflow", () => {
  it("returns null, without throwing, when the skill file is missing", () => {
    const dir = mkdtempSync(join(tmpdir(), "uktub-workflow-"));
    try {
      assert.equal(readWritingWorkflow(join(dir, "absent", "SKILL.md")), null);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("bundledSkillPath (one relative layout for a checkout and an installed package)", () => {
  it("resolves the shipped skill from src/pi in a checkout", () => {
    const resolved = bundledSkillPath(pathToFileURL(join(ROOT, "src", "pi", "index.ts")).href);
    assert.equal(resolved, SKILL);
  });

  it("resolves the shipped skill from dist/pi in an installed package copy", () => {
    const dir = mkdtempSync(join(tmpdir(), "uktub-installed-"));
    try {
      mkdirSync(join(dir, "dist", "pi"), { recursive: true });
      mkdirSync(join(dir, "skills", "uktub-research"), { recursive: true });
      writeFileSync(join(dir, "dist", "pi", "index.js"), "");
      writeFileSync(join(dir, "skills", "uktub-research", "SKILL.md"), "## Writing a document from the papers\n\nx\n");
      const resolved = bundledSkillPath(pathToFileURL(join(dir, "dist", "pi", "index.js")).href);
      assert.equal(resolved, join(dir, "skills", "uktub-research", "SKILL.md"));
      assert.match(readWritingWorkflow(resolved) ?? "", /^## Writing a document from the papers/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("before_agent_start injects the writing workflow", () => {
  it("contains SECTION_WRITER_RULE once and the workflow once", () => {
    const onStart = startHandler();
    const options: { promptGuidelines?: string[] } = {};
    onStart({ systemPromptOptions: options });
    const guidelines = options.promptGuidelines ?? [];
    assert.equal(guidelines.filter((g) => g === SECTION_WRITER_RULE).length, 1, "the section-writer rule rides once");
    const workflow = guidelines.filter((g) => g.startsWith(HEADING));
    assert.equal(workflow.length, 1, "workflow appended once");
    assert.equal(workflow[0], skillSection(), "verbatim section text");
  });

  it("injects the workflow even when the section writer is disabled (it is the document workflow, not the section-writer rule)", () => {
    const saved = process.env.UKTUB_SECTION_WRITER;
    try {
      process.env.UKTUB_SECTION_WRITER = "off";
      const onStart = startHandler();
      const options: { promptGuidelines?: string[] } = {};
      onStart({ systemPromptOptions: options });
      assert.ok((options.promptGuidelines ?? []).some((g) => g.startsWith(HEADING)), "workflow present");
      assert.ok(!(options.promptGuidelines ?? []).includes(SECTION_WRITER_RULE), "section-writer rule absent when off");
    } finally {
      if (saved === undefined) delete process.env.UKTUB_SECTION_WRITER;
      else process.env.UKTUB_SECTION_WRITER = saved;
    }
  });
});

describe("W6.1 abstract, introduction and conclusion last", () => {
  it("the rule sends the three parts to the parent, written from saved sections with no passages", () => {
    assert.match(SECTION_WRITER_RULE, /abstract, introduction and conclusion/);
    assert.match(SECTION_WRITER_RULE, /passages/);
  });

  it("the workflow orders save sections before abstract/introduction/conclusion last before verify document", () => {
    const section = skillSection();
    const saveAt = section.indexOf("Save each section as soon as it is written");
    const lastAt = section.indexOf("from the saved section files alone");
    const verifyAt = section.indexOf("Run `verify` with `document` on the whole manuscript");
    assert.ok(saveAt !== -1 && lastAt !== -1 && verifyAt !== -1, "all three steps present");
    assert.ok(saveAt < lastAt && lastAt < verifyAt, "save sections, then abstract/introduction/conclusion last, then verify document");
  });
});
