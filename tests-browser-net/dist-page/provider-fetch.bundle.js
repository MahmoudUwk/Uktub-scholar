// src/browser/provider-fetch.ts
var DEFAULT_DROP = ["x-api-key"];
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
    body: null
  }));
}
function createBrowserFetch(deps = {}) {
  const inner = deps.inner ?? platformFetch();
  const drop = new Set((deps.dropHeaders ?? DEFAULT_DROP).map((h) => h.toLowerCase()));
  return (url, init) => {
    if (init?.headers === void 0) return inner(url, init);
    const kept = {};
    for (const [k, v] of Object.entries(init.headers)) {
      if (!drop.has(k.toLowerCase())) kept[k] = v;
    }
    return inner(url, { ...init, headers: kept });
  };
}
export {
  createBrowserFetch
};
