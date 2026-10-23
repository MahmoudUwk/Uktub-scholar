/**
 * Browser-safe `FetchLike` wrapper (per-host injectable; the core provider
 * modules are NOT changed — see PROVIDER-AUDIT.md).
 *
 * Audit result: every request the product sends keyless is already a simple
 * GET (no custom header, no preflight). The only custom header the product
 * sends is `x-api-key` on the Semantic Scholar routes when a key is
 * configured. Measured 2026-10-21 (curl with `Origin`): S2's preflight allows
 * `x-api-key` and a keyed 200 carries `access-control-allow-origin: *`, so the
 * key is kept for the Semantic Scholar API origin and dropped for every other
 * origin (credentials scoped to their origin). S2's 401/403/429 replies carry
 * no `access-control-allow-origin`, so a page sees a TypeError for them and
 * the core's keyed → public-pool fallback cannot run in the browser.
 * `authorization` is likewise kept only for the verifier origins. Forbidden
 * headers (`User-Agent`, `Accept-Encoding`, `Connection`, ...) are never set
 * by the product's `fetch` calls — the Node transport sets them at the
 * `node:https` level, which has no page equivalent — so there is nothing to
 * strip there.
 */
import type { FetchLike } from "../core/providers/types.ts";

export interface BrowserFetchDeps {
  /** Defaults to a thin `globalThis.fetch` adapter (`cors`, credentials omitted). */
  inner?: FetchLike;
}

/** The only origin permitted to receive a researcher-supplied `x-api-key` (Semantic Scholar's key header). */
const API_KEY_ORIGINS = new Set(["https://api.semanticscholar.org"]);
/** Verifier API origins permitted to receive a researcher-supplied Bearer token. */
const BEARER_AUTH_ORIGINS = new Set(["https://decision.vllm-sr.ai", "https://openrouter.ai"]);

function validateProviderUrl(raw: unknown): URL {
  if (typeof raw !== "string") {
    throw new Error("provider fetch requires a string URL");
  }
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error("the address is not a valid URL");
  }
  if (url.protocol !== "https:") {
    throw new Error("only https addresses are fetched");
  }
  if (url.username !== "" || url.password !== "") {
    throw new Error("addresses with embedded credentials are refused");
  }
  return url;
}

function headerEntries(headers: unknown): [string, string][] {
  if (typeof Headers !== "undefined" && headers instanceof Headers) {
    const out: [string, string][] = [];
    headers.forEach((value, key) => {
      out.push([key, value]);
    });
    return out;
  }
  if (Array.isArray(headers)) {
    return headers.map((pair) => {
      if (!Array.isArray(pair) || pair.length !== 2 || typeof pair[0] !== "string" || typeof pair[1] !== "string") {
        throw new Error("invalid header tuple");
      }
      return [pair[0], pair[1]];
    });
  }
  if (headers !== null && typeof headers === "object") {
    return Object.entries(headers as Record<string, string>);
  }
  throw new Error("unsupported headers shape");
}

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
      json: (): Promise<unknown> => res.json(),
      body: null,
    }));
}

export function createBrowserFetch(deps: BrowserFetchDeps = {}): FetchLike {
  const inner = deps.inner ?? platformFetch();
  return async (url, init) => {
    const parsed = validateProviderUrl(url);
    if (init?.headers === undefined) return inner(url, init);
    const allowBearer = BEARER_AUTH_ORIGINS.has(parsed.origin);
    const allowApiKey = API_KEY_ORIGINS.has(parsed.origin);
    const kept: Record<string, string> = {};
    for (const [k, v] of headerEntries(init.headers)) {
      const lower = k.toLowerCase();
      if (lower === "x-api-key" && !allowApiKey) continue;
      if (lower === "authorization" && !allowBearer) continue;
      kept[k] = v;
    }
    return inner(url, { ...init, headers: kept });
  };
}
