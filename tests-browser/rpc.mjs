/**
 * postMessage RPC between the test page and the dedicated worker under test.
 * The worker speaks { id, op, args } -> { id, ok, result } / { id, ok, error }.
 */

/** Call the page's worker (`window.__worker`) and await the reply. */
export function callWorker(page, op, args = {}, { timeoutMs = 60000 } = {}) {
  return page.evaluate(async ({ op, args, timeoutMs }) => {
    const w = window.__worker;
    if (!w) throw new Error(`no worker under test (page error: ${window.__workerError ?? "none"})`);
    const id = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
    const reply = new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        w.removeEventListener("message", onMsg);
        reject(new Error(`worker op timed out: ${op}`));
      }, timeoutMs);
      const onMsg = (ev) => {
        const m = ev.data;
        if (m && m.id === id) {
          clearTimeout(timer);
          w.removeEventListener("message", onMsg);
          if (m.ok) resolve(m.result);
          else reject(new Error(m.error));
        }
      };
      w.addEventListener("message", onMsg);
    });
    w.postMessage({ id, op, args });
    return reply;
  }, { op, args, timeoutMs });
}

/** Open a page that boots the worker bundle at `workerUrl`, failing loudly. */
export async function openWorkerPage(browser, pageUrl, workerUrl) {
  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  page.on("pageerror", () => {});
  await page.goto(pageUrl, { waitUntil: "load" });
  await page.evaluate(async (workerUrl) => {
    const w = new Worker(workerUrl, { type: "module" });
    window.__worker = w;
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("worker boot timeout")), 30000);
      const onMsg = (ev) => {
        if (ev.data && ev.data.boot) {
          clearTimeout(timer);
          w.removeEventListener("message", onMsg);
          if (ev.data.ok) resolve();
          else { window.__workerError = ev.data.error; reject(new Error(ev.data.error)); }
        }
      };
      w.addEventListener("message", onMsg);
    });
  }, workerUrl);
  return { ctx, page };
}
