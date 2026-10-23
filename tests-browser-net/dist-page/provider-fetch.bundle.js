// src/browser/provider-fetch.ts
var API_KEY_ORIGINS = /* @__PURE__ */ new Set(["https://api.semanticscholar.org"]);
var BEARER_AUTH_ORIGINS = /* @__PURE__ */ new Set(["https://decision.vllm-sr.ai", "https://openrouter.ai"]);
function validateProviderUrl(raw) {
  if (typeof raw !== "string") {
    throw new Error("provider fetch requires a string URL");
  }
  let url;
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
function headerEntries(headers) {
  if (typeof Headers !== "undefined" && headers instanceof Headers) {
    const out = [];
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
    return Object.entries(headers);
  }
  throw new Error("unsupported headers shape");
}
function platformFetch() {
  return (url, init) => globalThis.fetch(url, {
    method: init?.method ?? "GET",
    headers: init?.headers,
    body: init?.body,
    signal: init?.signal,
    mode: "cors",
    credentials: "omit"
  }).then(async (res) => ({
    status: res.status,
    ok: res.ok,
    headers: { get: (name) => res.headers.get(name) },
    text: () => res.text(),
    json: () => res.json(),
    body: null
  }));
}
function createBrowserFetch(deps = {}) {
  const inner = deps.inner ?? platformFetch();
  return async (url, init) => {
    const parsed = validateProviderUrl(url);
    if (init?.headers === void 0) return inner(url, init);
    const allowBearer = BEARER_AUTH_ORIGINS.has(parsed.origin);
    const allowApiKey = API_KEY_ORIGINS.has(parsed.origin);
    const kept = {};
    for (const [k, v] of headerEntries(init.headers)) {
      const lower = k.toLowerCase();
      if (lower === "x-api-key" && !allowApiKey) continue;
      if (lower === "authorization" && !allowBearer) continue;
      kept[k] = v;
    }
    return inner(url, { ...init, headers: kept });
  };
}
export {
  createBrowserFetch
};
