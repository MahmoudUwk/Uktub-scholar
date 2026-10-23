/**
 * The always-on document-writing workflow: the section of the research skill text that a host appends to the system prompt.
 * Runtime-neutral: the host reads the skill text (Pi from disk, a browser from its bundle) and passes it in.
 */
const WRITING_WORKFLOW_HEADING = "## Writing a document from the papers";

/** The document-writing section of the skill text (heading through the line before the next `## ` heading), trimmed; null when absent. */
export function writingWorkflowSection(skillText: string): string | null {
  const lines = skillText.split("\n");
  const start = lines.findIndex((line) => line.trimEnd() === WRITING_WORKFLOW_HEADING);
  if (start === -1) return null;
  let end = lines.findIndex((line, index) => index > start && line.startsWith("## "));
  if (end === -1) end = lines.length;
  return lines.slice(start, end).join("\n").trim();
}
