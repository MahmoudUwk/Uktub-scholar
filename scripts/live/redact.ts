/**
 * Evidence redaction for the live harness. Every text the harness writes into a run directory goes through `redact`: credential
 * shapes (Bearer tokens, Google access tokens and API keys, refresh tokens) and the exact values of the provider keys the run forwards
 * into the sandbox. The tested agent can read its own environment, so a key value can reach a transcript however the agent got it.
 */
import { appendFileSync } from "node:fs";

/** Harness policy: a shorter value would match unrelated evidence text more often than it would protect a real key. */
const MIN_SECRET_LENGTH = 8;

/** Text to replace -> variable name; longest first so a value that contains another is replaced whole. */
let secrets: [text: string, name: string][] = [];

/** Registers the values of secrets this process forwards; empty and very short values are ignored. */
export function registerSecrets(named: Record<string, string | undefined>): void {
  const known = new Map(secrets);
  for (const [name, value] of Object.entries(named)) {
    if (value === undefined || value.length < MIN_SECRET_LENGTH) continue;
    known.set(value, name);
    const escaped = JSON.stringify(value).slice(1, -1); // the form the value takes inside a JSON string
    if (escaped !== value) known.set(escaped, name);
  }
  secrets = [...known].sort((a, b) => b[0].length - a[0].length);
}

export function resetSecrets(): void {
  secrets = [];
}

export function redact(s: string): string {
  let out = s;
  for (const [text, name] of secrets) out = out.split(text).join(`[REDACTED:${name}]`);
  return out.replace(/Bearer\s+\S+/gi, "Bearer <REDACTED>").replace(/ya29\.[A-Za-z0-9_.-]+/g, "<REDACTED>").replace(/AIza[A-Za-z0-9_-]{20,}/g, "<REDACTED>").replace(/"refresh_token"\s*:\s*"[^"]+"/g, '"refresh_token":"<REDACTED>"');
}

export const appendRedacted = (file: string, text: string): void => appendFileSync(file, redact(text));
