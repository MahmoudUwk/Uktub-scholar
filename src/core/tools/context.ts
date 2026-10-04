/**
 * Shared tool plumbing (R7, R8, R16): the injected context every tool takes,
 * root confinement validation, and the refusal/warning result envelope.
 *
 * Nothing here reads `process.env`, a global `fetch`, or the real clock — the
 * host injects all three (KTD6). src/core imports only node:* and
 * package-internal modules (KTD1).
 */

import { realpathSync, statSync } from "node:fs";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";

import type { FetchLike, ProviderConfig } from "../providers/types.ts";
import type { DownloadLike } from "../source/download.ts";
import { renderRefusal, type RefusalCode, type WarningCode } from "../refusals.ts";

/** The context a host hands each tool call — injected, never global (KTD6). */
export interface ToolContext {
  /** Project root; every path a tool touches is validated against it (R16). */
  root: string;
  fetch: FetchLike;
  /** Optional provider keys (e.g. S2 key, OpenAlex key, CROSSREF_MAILTO). */
  env: Record<string, string | undefined>;
  /** Clock injection; `ingested_at` is the only consumer (KTD6). */
  now: () => Date;
  /** The write queue serializing registry transactions (KTD5). */
  queue: { runExclusive<T>(fn: () => T | Promise<T>): Promise<T> };
  /** Test/fake seam: overrides the default live provider endpoints. */
  providerConfig?: Partial<ProviderConfig>;
  /** Document acquisition transport (SSRF-safe in production). Absent: no
   *  network acquisition is attempted and papers report no usable source. */
  download?: DownloadLike;
  /** Cancellation from the host; checked between units of work. */
  signal?: AbortSignal;
}

/** Provider config assembled from the injected context — no env reads here. */
export function providerConfigOf(ctx: ToolContext): ProviderConfig {
  return {
    openalexBaseUrl: "https://api.openalex.org",
    crossrefBaseUrl: "https://api.crossref.org",
    semanticScholarBaseUrl: "https://api.semanticscholar.org/graph/v1",
    semanticScholarApiKey: ctx.env.SEMANTIC_SCHOLAR_API_KEY,
    openalexApiKey: ctx.env.OPENALEX_API_KEY,
    crossrefMailto: ctx.env.CROSSREF_MAILTO,
    ...ctx.providerConfig,
  };
}

/** Blocked path segments under the root (R16): registry-owned state and VCS metadata. */
const BLOCKED_SEGMENTS: Record<string, true> = { ".registry": true, ".git": true };

export type Confinement = { ok: true } | { ok: false; code: RefusalCode; message: string };

/**
 * R16 enforcement: validate that the context's root itself, and any relative
 * path the tool would touch under it, stays inside the root and never enters a
 * blocked segment. v0 tools take no path parameters, so this guards the
 * root/context construction — a traversal (`..`) or an absolute path outside
 * the root is refused before anything is read or written.
 */
export function validateContext(ctx: ToolContext): Confinement {
  if (typeof ctx.root !== "string" || ctx.root.length === 0) {
    return { ok: false, code: "PATH_REFUSED", message: "tool context carries no project root" };
  }
  // A relative root resolves against the process cwd — an ambient path the
  // host never declared; the context must name the root absolutely.
  if (!isAbsolute(ctx.root)) {
    return { ok: false, code: "PATH_REFUSED", message: "tool context root is not an absolute path" };
  }
  // Traversal is checked on the RAW path: a host that hands down a `..`
  // segment is escaping the project it declared, wherever it happens to land.
  if (ctx.root.split(/[\\/]/).includes("..")) {
    return { ok: false, code: "PATH_REFUSED", message: "tool context root escapes the project via '..' traversal" };
  }
  const absRoot = resolve(ctx.root);
  const rel = absRoot.slice(dirname(absRoot).length).replace(/^[/\\]+/, "");
  for (const segment of (rel.length > 0 ? rel : "").split(sep)) {
    if (BLOCKED_SEGMENTS[segment]) {
      return {
        ok: false,
        code: "PATH_REFUSED",
        message: `tool context points at the protected path segment "${segment}" — the root must be the project directory, not ${segment}`,
      };
    }
  }
  return { ok: true };
}

export type ProjectFile = { ok: true; abs: string; rel: string; bytes: number } | { ok: false; message: string };

/**
 * Confine a file the caller names to the project (R16): lexical `..` escapes,
 * symlink escapes, protected segments, non-files and oversize files are all
 * refused before anything is read. `rel` is the project-relative path stored
 * as the nonsecret source reference.
 */
export function resolveProjectFile(root: string, requested: string, maxBytes: number): ProjectFile {
  if (typeof requested !== "string" || requested.trim().length === 0) return { ok: false, message: "the path is empty" };
  const candidate = isAbsolute(requested) ? resolve(requested) : resolve(root, requested);
  const lexical = relative(resolve(root), candidate);
  const escapes = (rel: string): boolean => rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel);
  if (escapes(lexical)) return { ok: false, message: "the path is outside the project" };
  let realRoot: string;
  let real: string;
  try {
    realRoot = realpathSync(root);
    real = realpathSync(candidate);
  } catch {
    return { ok: false, message: "the file does not exist" };
  }
  const rel = relative(realRoot, real);
  if (escapes(rel)) return { ok: false, message: "the path leaves the project (symlink escape)" };
  for (const segment of [...rel.split(sep), ...lexical.split(sep)]) {
    if (BLOCKED_SEGMENTS[segment]) return { ok: false, message: `the path enters the protected segment "${segment}"` };
  }
  const info = statSync(real);
  if (!info.isFile()) return { ok: false, message: "the path is not a regular file" };
  if (info.size > maxBytes) return { ok: false, message: `the file is larger than ${maxBytes} bytes` };
  return { ok: true, abs: real, rel: rel.split(sep).join("/"), bytes: info.size };
}

/** SQLite's lock wait ran out inside a store write: report the typed refusal, not a raw error. */
export function busyRefusal(err: unknown): ToolResult<never> | null {
  const message = err instanceof Error ? err.message : String(err);
  return /database is locked|database table is locked|SQLITE_BUSY/i.test(message)
    ? refusalResult({ code: "REGISTRY_BUSY", message: "another process held the registry write lock and the wait was exhausted" })
    : null;
}

/** A `content`-only failure result carrying the rendered refusal text (R7). */
export function refusalResult(refused: { code: RefusalCode; message: string }): ToolResult<never> {
  return {
    content: [{ type: "text", text: renderRefusal(refused) }],
    structuredContent: null,
    details: { refused },
  };
}

/** One rendered warning attached to a successful outcome (KTD6). */
export interface RenderedWarning {
  code: WarningCode;
  message: string;
  next: string;
}

/** The envelope every tool returns (KTD6): text content + structured + details. */
export interface ToolResult<T> {
  content: { type: "text"; text: string }[];
  structuredContent: T | null;
  details: Record<string, unknown>;
}
