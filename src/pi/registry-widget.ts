import { resolve } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

import { RegistryError, countPapers, listPapers, openRegistry } from "../core/registry.ts";

/**
 * Registry panel (R6 context parity): a persistent TUI widget under the editor
 * showing the paper registry state — total, citable, and the most recent
 * citekeys. Native Pi widget API (`ctx.ui.setWidget`); refreshes after every
 * tool result so registrations appear immediately. Degrades silently in
 * print/RPC/JSON modes (`ctx.hasUI`) and when no registry exists.
 */
export default function registryWidget(pi: ExtensionAPI): void {
  pi.on("session_start", (_event, ctx) => {
    if (!ctx.hasUI || typeof ctx.ui.setWidget !== "function") return;

    // Same one-time root rule as the tool adapter (documented there): the
    // first context fixes the project directory for the whole session.
    let root: string | null = null;
    const projectRoot = (cwd: unknown): string | null => {
      root ??= typeof cwd === "string" && cwd.length > 0 ? resolve(cwd) : null;
      return root;
    };

    const render = (cwd: unknown): void => {
      const project = projectRoot(cwd);
      if (project === null) return;
      try {
        const db = openRegistry(project);
        try {
          const total = countPapers(db);
          if (total === 0) {
            ctx.ui.setWidget("uktub-registry", [
              "📖 uktub registry: empty — register papers with paper_registry",
            ], { placement: "belowEditor" });
            return;
          }
          const rows = listPapers(db, Math.min(total, 6));
          const citable = rows.filter((row) => row.citable).length;
          const lines = [
            `📖 uktub registry: ${total} paper${total === 1 ? "" : "s"} · ${citable} citable`,
            ...rows.slice(-6).map((row) => `  ${row.citekey}${row.citable ? "" : "  (uncitable)"}`),
            ...(total > 6 ? [`  … ${total - 6} more`] : []),
          ];
          ctx.ui.setWidget("uktub-registry", lines, { placement: "belowEditor" });
        } finally {
          db.close();
        }
      } catch (err) {
        if (err instanceof RegistryError) return; // no registry / unsupported schema — panel stays hidden
        throw err;
      }
    };

    render(ctx.cwd);
    // Refresh after every tool result — registrations and removals show up
    // immediately; the read is two tiny SQLite queries.
    pi.on("tool_result", (event, toolCtx) => {
      render((toolCtx as { cwd?: unknown } | undefined)?.cwd);
      return undefined;
    });
  });
}
