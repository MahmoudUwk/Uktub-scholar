/**
 * Canonical MCP identity for uktub-scholar: the short server id and tool
 * names every host sees, plus the hidden legacy aliases that keep existing
 * callers working. Pure (no imports): the MCP, Pi and CLI adapters and the
 * notices layer share it, so a rename touches names in one place. Nothing
 * Node-backed lives here — implementations stay in their adapters.
 */

/** The server id hosts register and Pi exposes (`mcp__uktub__<tool>`). */
export const MCP_SERVER_NAME = "uktub" as const;
/** Legacy server key in host MCP configuration files, renamed on install. */
export const LEGACY_SERVER_KEY = "uktub-scholar" as const;
/** The six canonical public tool names, in listing order. */
export const TOOL_NAMES = ["papers", "registry", "compile", "verify", "passages", "doctor"] as const;
export type ToolName = (typeof TOOL_NAMES)[number];
/** Namespaced spelling used by MCP hosts such as Pi and Claude Code. */
export const MCP_TOOL_PREFIX = `mcp__${MCP_SERVER_NAME}__` as const;
/**
 * Hidden compatibility aliases: legacy public names to canonical ones.
 * Accepted on invocation, never listed in the model surface.
 */
export const TOOL_ALIASES: Record<string, ToolName> = {
  search_papers: "papers",
  paper_registry: "registry",
  compile_document: "compile",
  verify_claim: "verify",
  search_passages: "passages",
};

const KNOWN_TOOLS = new Set<string>([...TOOL_NAMES, ...Object.keys(TOOL_ALIASES)]);

/**
 * Normalize a host-namespaced or legacy tool identifier to the canonical
 * short name (`mcp__uktub__verify`, `uktub-scholar/search_papers` and bare
 * `search_papers` all become `verify`/`papers`). Only the known server ids
 * (`uktub`, `uktub-scholar`, `uktub_scholar`) are stripped, and only when
 * the remainder is a known tool — anything else (including unrelated
 * prefixes such as `mcp__other__papers`) passes through untouched so a
 * mistyped call still fails loudly as an unknown tool.
 */
export function normalizeToolName(name: string): string {
  const m = /^(?:mcp__)?(uktub-scholar|uktub_scholar|uktub)(?:_{1,2}|[/:])/.exec(name);
  if (m !== null) {
    const rest = name.slice(m[0].length);
    if (!KNOWN_TOOLS.has(rest)) return name;
    return TOOL_ALIASES[rest] ?? rest;
  }
  return KNOWN_TOOLS.has(name) ? (TOOL_ALIASES[name] ?? name) : name;
}

/** Whether a normalized name is one of the six canonical tools. */
export function isCanonicalToolName(name: string): name is ToolName {
  return (TOOL_NAMES as readonly string[]).includes(name);
}
