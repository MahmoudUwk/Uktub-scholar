/**
 * The product skills the package ships (skills/<name>/SKILL.md): a host that cannot parse a skill's frontmatter silently leaves it
 * out of the model's skill list (found live: an unquoted colon in a description hid a skill from the agent). These checks hold the
 * limits of the Agent Skills format that Pi and the other hosts enforce.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { parse } from "yaml";

const SKILLS = resolve(import.meta.dirname, "../skills");
const names = readdirSync(SKILLS).filter((n) => statSync(join(SKILLS, n)).isDirectory());

function frontmatter(text: string): { data: Record<string, unknown>; body: string } {
  const m = /^---\n([\s\S]*?)\n---\n([\s\S]*)$/.exec(text);
  assert.ok(m, "no frontmatter block");
  return { data: parse(m[1]!) as Record<string, unknown>, body: m[2]! };
}

describe("shipped skills", () => {
  it("there is at least the research skill", () => assert.ok(names.includes("uktub-research")));
  for (const name of names) {
    it(`${name}: frontmatter parses and meets the format limits`, () => {
      const { data, body } = frontmatter(readFileSync(join(SKILLS, name, "SKILL.md"), "utf8"));
      assert.equal(data.name, name, "name must equal the directory name");
      assert.match(String(data.name), /^[a-z0-9]+(-[a-z0-9]+)*$/);
      assert.ok(String(data.name).length <= 64);
      assert.equal(typeof data.description, "string", "description must be a string");
      const d = data.description as string;
      assert.ok(d.length >= 1 && d.length <= 1024, `description is ${d.length} characters`);
      if (data.compatibility !== undefined) assert.ok(String(data.compatibility).length <= 500);
      assert.ok(body.trim().length > 0);
      assert.ok(body.split("\n").length <= 500, "SKILL.md body over 500 lines: move detail into references/");
    });
  }
});

describe("skills for coding agents stay internal", () => {
  const AGENT_SKILLS = resolve(import.meta.dirname, "../.agents/skills");
  const internal = readdirSync(AGENT_SKILLS).filter((n) => statSync(join(AGENT_SKILLS, n)).isDirectory());
  it("has skills to check", () => assert.ok(internal.length >= 1));
  for (const name of internal) {
    it(`.agents/skills/${name} is marked metadata.internal so \`npx skills add\` does not offer it to users`, () => {
      const { data } = frontmatter(readFileSync(join(AGENT_SKILLS, name, "SKILL.md"), "utf8"));
      assert.equal((data.metadata as { internal?: unknown } | undefined)?.internal, true);
    });
  }
  it("no shipped product skill is marked internal", () => {
    for (const name of names) assert.notEqual(((frontmatter(readFileSync(join(SKILLS, name, "SKILL.md"), "utf8")).data.metadata ?? {}) as { internal?: unknown }).internal, true, name);
  });
});
