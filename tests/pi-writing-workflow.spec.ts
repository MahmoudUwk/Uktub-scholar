import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import uktubScholarExtension, { bundledSkillPath, readWritingWorkflow, writingWorkflowSection } from "../src/pi/index.ts";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const SKILL = join(ROOT, "skills", "uktub-research", "SKILL.md");
const HEADING = "## Writing a document from the papers";
const SECTION_WRITER_TEXT = "For multi-section documents, draft each prose section with `write_section`";

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

describe("writingWorkflowSection", () => {
  it("returns exactly the document-writing section of the current skill (heading through the step before the next ## heading)", () => {
    const section = writingWorkflowSection(readFileSync(SKILL, "utf8"));
    assert.ok(section !== null, "the current skill has the section");
    assert.ok(section.startsWith(HEADING), "starts with its heading");
    assert.ok(!/^## /m.test(section.slice(HEADING.length)), "stops before the next ## heading");
    assert.match(section, /manuscript\/sections\/NN-name\.tex/);
    assert.match(section, /unverified/);
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
  it("keeps the existing rules and adds the workflow section exactly once, also when the run starts again", () => {
    const onStart = startHandler();
    const options: { promptGuidelines?: string[] } = { promptGuidelines: ["existing rule"] };
    onStart({ systemPromptOptions: options });
    onStart({ systemPromptOptions: options });
    const guidelines = options.promptGuidelines ?? [];
    assert.equal(guidelines[0], "existing rule", "keeps other contributors' guidelines");
    assert.match(guidelines.join("\n"), /Never fabricate data, results, quotations, references/, "agent rules still present");
    const workflow = guidelines.filter((g) => g.startsWith(HEADING));
    assert.equal(workflow.length, 1, "workflow appended once");
    assert.equal(workflow[0], writingWorkflowSection(readFileSync(SKILL, "utf8")), "verbatim section text");
  });

  it("injects the workflow even when the section writer is disabled (it is the document workflow, not the section-writer rule)", () => {
    const saved = process.env.UKTUB_SECTION_WRITER;
    try {
      process.env.UKTUB_SECTION_WRITER = "off";
      const onStart = startHandler();
      const options: { promptGuidelines?: string[] } = {};
      onStart({ systemPromptOptions: options });
      const joined = (options.promptGuidelines ?? []).join("\n");
      assert.ok((options.promptGuidelines ?? []).some((g) => g.startsWith(HEADING)), "workflow present");
      assert.ok(!joined.includes(SECTION_WRITER_TEXT), "section-writer rule absent when off");
    } finally {
      if (saved === undefined) delete process.env.UKTUB_SECTION_WRITER;
      else process.env.UKTUB_SECTION_WRITER = saved;
    }
  });
});
