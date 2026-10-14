/** Page-side holder for the two-page project-lock test (bundled for Chromium). */
import { acquireProjectLock, lockNameForProject, type ProjectLockResult } from "../src/browser/lock.ts";

declare global {
  interface Window {
    __acquire: (projectId: string, ifAvailable: boolean) => Promise<{ held: boolean; reason?: string }>;
    __release: () => Promise<string>;
    __lockName: (projectId: string) => string;
  }
}

let held: ProjectLockResult | null = null;

window.__lockName = (projectId: string): string => lockNameForProject(projectId);
window.__acquire = async (projectId: string, ifAvailable: boolean): Promise<{ held: boolean; reason?: string }> => {
  const r = await acquireProjectLock(projectId, { ifAvailable });
  if (r.held) {
    held = r;
    return { held: true };
  }
  return { held: false, reason: r.reason };
};
window.__release = async (): Promise<string> => {
  if (held !== null && held.held) {
    await held.release();
    held = null;
    return "released";
  }
  return "nothing-held";
};
