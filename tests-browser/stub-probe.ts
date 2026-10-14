/**
 * Probe entry for the stub contract: stubbed node:* modules must import
 * cleanly and throw "not implemented in the browser build: <mod>.<export>"
 * only when called. Aliased modules must resolve to the shims.
 */
import { readFileSync } from "node:fs";
import { spawn } from "node:child_process";
import { DatabaseSync } from "node:sqlite";

export function probeFs(): string {
  return readFileSync("/nonexistent-uktub-probe", "utf8") as unknown as string;
}

export function probeChild(): string {
  return (spawn as unknown as () => string)();
}

export function probeSqliteAlias(): string {
  try {
    new (DatabaseSync as unknown as new (p: string) => unknown)("/probe.db");
    return "constructed (unexpected without boot)";
  } catch (err) {
    return err instanceof Error ? err.message : String(err);
  }
}
