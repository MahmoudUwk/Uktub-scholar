/**
 * Browser-safe `FetchLike` wrapper (per-host injectable; the core provider
 * modules are NOT changed — see PROVIDER-AUDIT.md).
 *
 * Audit result: every request the product sends keyless is already a simple
 * GET (no custom header, no preflight). The only custom header the product
 * sends is `x-api-key` on the Semantic Scholar routes when a key is
 * configured; a custom header forces a CORS preflight, and a provider may
 * refuse it (OpenAlex demonstrably does). This wrapper drops the listed
 * headers in the page, so a keyed call falls back to the provider's keyless
 * pool instead of dying on preflight. Forbidden headers (`User-Agent`,
 * `Accept-Encoding`, `Connection`, ...) are never set by the product's
 * `fetch` calls — the Node transport sets them at the `node:https` level,
 * which has no page equivalent — so there is nothing to strip there.
 */
import type { FetchLike } from "../core/providers/types.ts";

export interface BrowserFetchDeps {
  /** Defaults to a thin `globalThis.fetch` adapter (`cors`, credentials omitted). */
  inner?: FetchLike;
  /** Case-insensitive. Default `["x-api-key"]` (the product's only custom fetch header). */
  dropHeaders?: string[];
}

const DEFAULT_DROP = ["x-api-key"];

function platformFetch(): FetchLike {
  return (url, init) =>
    globalThis.fetch(url, {
      method: init?.method ?? "GET",
      headers: init?.headers,
      body: init?.body,
      signal: init?.signal,
      mode: "cors",
      credentials: "omit",
    }).then(async (res) => ({
      status: res.status,
      ok: res.ok,
      headers: { get: (name: string): string | null => res.headers.get(name) },
      text: (): Promise<string> => res.text(),
      body: null,
    }));
}

export function createBrowserFetch(deps: BrowserFetchDeps = {}): FetchLike {
  const inner = deps.inner ?? platformFetch();
  const drop = new Set((deps.dropHeaders ?? DEFAULT_DROP).map((h) => h.toLowerCase()));
  return (url, init) => {
    if (init?.headers === undefined) return inner(url, init);
    const kept: Record<string, string> = {};
    for (const [k, v] of Object.entries(init.headers)) {
      if (!drop.has(k.toLowerCase())) kept[k] = v;
    }
    return inner(url, { ...init, headers: kept });
  };
}
