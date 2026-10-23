/**
 * In-page runner for UktubBrowserClient tests inside Chromium.
 */
import { createUktubClient, type InitArgs } from "../src/browser/client.ts";

(window as any).__runClientTest = async function ({
  workerUrl,
  nowIso,
  routes,
  providerConfig,
}: {
  workerUrl: string;
  nowIso: string;
  routes: any[];
  providerConfig: any;
}): Promise<{ ok: boolean; checks: Record<string, boolean> }> {
  const checks: Record<string, boolean> = {};

  const client = createUktubClient(workerUrl);
  await client.ready;
  checks.boot = true;

  const initRes = await client.init({
    projectId: "client-test-project",
    nowIso,
    fetchRoutes: routes,
    providerConfig,
  });
  checks.init = initRes.ok === true;

  // File store ops
  const writeRes = await client.writeFile("notes/scratch.txt", "hello client");
  checks.writeFile = writeRes.bytes === 12 && writeRes.path === "notes/scratch.txt";

  const readRes = await client.readFile("notes/scratch.txt");
  checks.readFile = readRes.text === "hello client" && readRes.bytes === 12 && readRes.path === "notes/scratch.txt";

  const delRes = await client.deleteFile("notes/scratch.txt");
  checks.deleteFile = delRes.deleted === true;

  // List files
  const list = await client.listFiles();
  checks.listFiles = Array.isArray(list.files);

  // Pre-aborted signal
  const ac = new AbortController();
  ac.abort();
  try {
    await client.callTool("doctor", {}, { signal: ac.signal });
    checks.preAborted = false;
  } catch (err: any) {
    checks.preAborted = err?.name === "AbortError";
  }

  // Tool execution
  const docRes = (await client.callTool("doctor", {})) as { structuredContent?: { checks?: unknown } };
  checks.doctorTool = docRes?.structuredContent !== undefined;

  // Export
  const exp = await client.exportProject();
  checks.exportProject = exp.files !== undefined && exp.zip instanceof Uint8Array;

  // Import
  const impRes = await client.importProject({ zip: exp.zip, registry: exp.registry });
  checks.importProject = impRes.ok === true;

  await client.close();

  // Request after close should reject
  try {
    await client.listFiles();
    checks.closedRejection = false;
  } catch (err: any) {
    checks.closedRejection = /UktubBrowserClient is closed/i.test(err?.message ?? "");
  }

  const allOk = Object.values(checks).every((v) => v === true);
  return { ok: allOk, checks };
};
