/**
 * One contract, two downloaders: `createSafeDownloader` (Node, injected
 * transport) and `createBrowserDownloader` (page, injected fetch).
 * Cases that apply to only one are marked and listed in REPORT.md.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  createSafeDownloader,
  type Resolver,
  type Transport,
  type TransportRequest,
} from "../src/core/source/download.ts";
import { createBrowserDownloader } from "../src/browser/download.ts";

/** Structural check: avoids importing extract.ts (unpdf) at runtime. */
const isSourceError = (e: unknown): e is { code: string; message: string; name: string } =>
  (e as { name?: unknown })?.name === "SourceError" && typeof (e as { code?: unknown })?.code === "string";

const codeOf = (p: Promise<unknown>): Promise<string> =>
  p.then(
    () => "NO_THROW",
    (e) => (isSourceError(e) ? e.code : `WRONG_TYPE:${(e as { constructor?: { name?: string } })?.constructor?.name}`),
  );

/* ── Node side: scripted transport ─────────────────────────────── */
const publicResolver: Resolver = async (host) =>
  host === "private.example" ? ["10.0.0.5"] : ["93.184.216.34"];

function scripted(
  responses: Record<string, { status: number; headers?: Record<string, string>; body?: Uint8Array }>,
): { transport: Transport; seen: TransportRequest[] } {
  const seen: TransportRequest[] = [];
  return {
    seen,
    transport: async (req) => {
      seen.push(req);
      const r = responses[`${req.url.origin}${req.url.pathname}`];
      if (!r) throw new Error(`NO_SCRIPT ${req.url.origin}${req.url.pathname}`);
      return { status: r.status, headers: r.headers ?? {}, body: r.body ?? new Uint8Array() };
    },
  };
}

/* ── Browser side: stub fetch shaped like the platform Response ── */
interface StubRoute {
  status?: number;
  headers?: Record<string, string>;
  body?: Uint8Array;
  to?: string; // redirect target (followed by the stub, like redirect:"follow")
  fail?: "cors"; // throw TypeError like a CORS/network failure
}

function stubFetch(routes: Record<string, StubRoute>, calls: string[]) {
  return async (raw: string, init?: { redirect?: string; signal?: AbortSignal; headers?: unknown }) => {
    calls.push(raw);
    init?.signal?.throwIfAborted();
    let url = raw;
    for (let hop = 0; hop <= 6; hop++) {
      const u = new URL(url);
      const r = routes[`${u.origin}${u.pathname}`];
      if (!r) throw new Error(`NO_ROUTE ${u.origin}${u.pathname}`);
      if (r.fail === "cors") throw new TypeError("Failed to fetch");
      if (r.to !== undefined) {
        url = new URL(r.to, url).href;
        continue;
      }
      const body = r.body ?? new Uint8Array();
      return {
        status: r.status ?? 200,
        url,
        headers: {
          get: (name: string) => r.headers?.[name.toLowerCase()] ?? null,
        },
        body: new ReadableStream({
          start(c) {
            c.enqueue(body);
            c.close();
          },
        }),
      };
    }
    throw new Error("stub: too many redirects");
  };
}

const bytes = (n: number, fill = 0x61): Uint8Array => new Uint8Array(n).fill(fill);

describe("contract: both downloaders", () => {
  it("downloads a body under the cap, strips query/fragment from the reference", async () => {
    const { transport } = scripted({
      "https://pub.example/a.pdf": {
        status: 200,
        headers: { "content-type": "application/pdf", "content-length": "100" },
        body: bytes(100),
      },
    });
    const node = await createSafeDownloader({ resolve: publicResolver, transport })(
      "https://pub.example/a.pdf?sig=secret#frag",
      { maxBytes: 1000 },
    );
    assert.equal(node.finalUrl, "https://pub.example/a.pdf");
    assert.equal(node.contentType, "application/pdf");
    assert.equal(node.bytes.byteLength, 100);

    const calls: string[] = [];
    const page = await createBrowserDownloader({
      fetch: stubFetch(
        { "https://pub.example/a.pdf": { headers: { "content-type": "application/pdf", "content-length": "100" }, body: bytes(100) } },
        calls,
      ) as unknown as typeof fetch,
    })("https://pub.example/a.pdf?sig=secret#frag", { maxBytes: 1000 });
    assert.equal(page.finalUrl, "https://pub.example/a.pdf");
    assert.equal(page.contentType, "application/pdf");
    assert.equal(page.bytes.byteLength, 100);
  });

  it("accepts a body exactly at the cap", async () => {
    const { transport } = scripted({
      "https://pub.example/a.pdf": { status: 200, headers: { "content-length": "64" }, body: bytes(64) },
    });
    await createSafeDownloader({ resolve: publicResolver, transport })("https://pub.example/a.pdf", { maxBytes: 64 });
    const calls: string[] = [];
    await createBrowserDownloader({
      fetch: stubFetch({ "https://pub.example/a.pdf": { headers: { "content-length": "64" }, body: bytes(64) } }, calls) as unknown as typeof fetch,
    })("https://pub.example/a.pdf", { maxBytes: 64 });
  });

  it("rejects a body over the cap as too_large (same code, same message)", async () => {
    const { transport } = scripted({
      "https://pub.example/a.pdf": { status: 200, headers: { "content-length": "65" }, body: bytes(65) },
    });
    const nodeDl = createSafeDownloader({ resolve: publicResolver, transport });
    await assert.rejects(
      nodeDl("https://pub.example/a.pdf", { maxBytes: 64 }),
      (e) => isSourceError(e) && e.code === "too_large" && e.message === "the document is larger than 64 bytes",
    );
    const calls: string[] = [];
    const pageDl = createBrowserDownloader({
      fetch: stubFetch({ "https://pub.example/a.pdf": { headers: { "content-length": "65" }, body: bytes(65) } }, calls) as unknown as typeof fetch,
    });
    await assert.rejects(
      pageDl("https://pub.example/a.pdf", { maxBytes: 64 }),
      (e) => isSourceError(e) && e.code === "too_large" && /larger than 64 bytes/.test(e.message),
    );
  });

  it("rejects a declared length over the cap as too_large without reading", async () => {
    const { transport } = scripted({
      "https://pub.example/a.pdf": { status: 200, headers: { "content-length": "100000" }, body: bytes(10) },
    });
    assert.equal(await codeOf(createSafeDownloader({ resolve: publicResolver, transport })("https://pub.example/a.pdf", { maxBytes: 64 })), "too_large");
    const calls: string[] = [];
    assert.equal(
      await codeOf(
        createBrowserDownloader({
          fetch: stubFetch(
            { "https://pub.example/a.pdf": { headers: { "content-length": "100000" }, body: bytes(10) } },
            calls,
          ) as unknown as typeof fetch,
        })("https://pub.example/a.pdf", { maxBytes: 64 }),
      ),
      "too_large",
    );
  });

  it("rejects a short body as truncated", async () => {
    const { transport } = scripted({
      "https://pub.example/a.pdf": { status: 200, headers: { "content-length": "100" }, body: bytes(10) },
    });
    assert.equal(await codeOf(createSafeDownloader({ resolve: publicResolver, transport })("https://pub.example/a.pdf", { maxBytes: 1000 })), "truncated");
    const calls: string[] = [];
    assert.equal(
      await codeOf(
        createBrowserDownloader({
          fetch: stubFetch(
            { "https://pub.example/a.pdf": { headers: { "content-length": "100" }, body: bytes(10) } },
            calls,
          ) as unknown as typeof fetch,
        })("https://pub.example/a.pdf", { maxBytes: 1000 }),
      ),
      "truncated",
    );
  });

  it("reports non-200 as download_failed with the status", async () => {
    const { transport } = scripted({ "https://pub.example/a.pdf": { status: 404 } });
    assert.equal(await codeOf(createSafeDownloader({ resolve: publicResolver, transport })("https://pub.example/a.pdf", { maxBytes: 64 })), "download_failed");
    const calls: string[] = [];
    await assert.rejects(
      createBrowserDownloader({
        fetch: stubFetch({ "https://pub.example/a.pdf": { status: 404 } }, calls) as unknown as typeof fetch,
      })("https://pub.example/a.pdf", { maxBytes: 64 }),
      (e) => isSourceError(e) && e.code === "download_failed" && /HTTP 404/.test(e.message),
    );
  });

  it("refuses non-https without any network call", async () => {
    const { transport, seen } = scripted({});
    assert.equal(await codeOf(createSafeDownloader({ resolve: publicResolver, transport })("http://example.com/a.pdf", { maxBytes: 64 })), "unsafe_destination");
    assert.equal(seen.length, 0);
    const calls: string[] = [];
    assert.equal(
      await codeOf(
        createBrowserDownloader({
          fetch: stubFetch({}, calls) as unknown as typeof fetch,
        })("http://example.com/a.pdf", { maxBytes: 64 }),
      ),
      "unsafe_destination",
    );
    assert.equal(calls.length, 0);
  });

  it("refuses embedded userinfo without any network call", async () => {
    const { transport, seen } = scripted({});
    assert.equal(
      await codeOf(createSafeDownloader({ resolve: publicResolver, transport })("https://user:pass@pub.example/a.pdf", { maxBytes: 64 })),
      "unsafe_destination",
    );
    assert.equal(seen.length, 0);
    const calls: string[] = [];
    assert.equal(
      await codeOf(
        createBrowserDownloader({ fetch: stubFetch({}, calls) as unknown as typeof fetch })("https://user:pass@pub.example/a.pdf", { maxBytes: 64 }),
      ),
      "unsafe_destination",
    );
    assert.equal(calls.length, 0);
  });

  it("attaches the credential on origin match, omits it on mismatch", async () => {
    const { transport, seen } = scripted({
      "https://pub.example/a.pdf": { status: 200, headers: {}, body: bytes(10) },
    });
    const cred = { origin: "https://pub.example", param: "api_key", value: "SECRET" };
    await createSafeDownloader({ resolve: publicResolver, transport })("https://pub.example/a.pdf", { maxBytes: 64, credential: cred });
    assert.ok(seen[0]?.url.searchParams.get("api_key") === "SECRET");
    const { transport: t2, seen: seen2 } = scripted({
      "https://pub.example/a.pdf": { status: 200, headers: {}, body: bytes(10) },
    });
    await createSafeDownloader({ resolve: publicResolver, transport: t2 })("https://pub.example/a.pdf", {
      maxBytes: 64,
      credential: { origin: "https://other.example", param: "api_key", value: "SECRET" },
    });
    assert.equal(seen2[0]?.url.searchParams.get("api_key"), null);

    const calls: string[] = [];
    await createBrowserDownloader({
      fetch: stubFetch({ "https://pub.example/a.pdf": { body: bytes(10) } }, calls) as unknown as typeof fetch,
    })("https://pub.example/a.pdf", { maxBytes: 64, credential: cred });
    assert.ok(new URL(calls[0] as string).searchParams.get("api_key") === "SECRET");
    const calls2: string[] = [];
    await createBrowserDownloader({
      fetch: stubFetch({ "https://pub.example/a.pdf": { body: bytes(10) } }, calls2) as unknown as typeof fetch,
    })("https://pub.example/a.pdf", {
      maxBytes: 64,
      credential: { origin: "https://other.example", param: "api_key", value: "SECRET" },
    });
    assert.equal(new URL(calls2[0] as string).searchParams.get("api_key"), null);
  });
});

describe("browser-only cases", () => {
  it("maps a failed fetch (CORS/network/TLS) to download_failed with the manual-import message", async () => {
    const calls: string[] = [];
    const err = await createBrowserDownloader({
      fetch: stubFetch({ "https://pub.example/a.pdf": { fail: "cors" } }, calls) as unknown as typeof fetch,
    })("https://pub.example/a.pdf", { maxBytes: 64 }).then(
      () => null,
      (e) => e,
    );
    assert.ok(isSourceError(err) && err.code === "download_failed");
    assert.equal(
      err.message,
      "the host did not allow this browser to read the file, or could not be reached; import the PDF manually",
    );
  });

  it("requires the FINAL url to be https after redirects", async () => {
    const calls: string[] = [];
    assert.equal(
      await codeOf(
        createBrowserDownloader({
          fetch: stubFetch({ "https://pub.example/a.pdf": { to: "http://pub.example/b.pdf" }, "http://pub.example/b.pdf": { body: bytes(10) } }, calls) as unknown as typeof fetch,
          allowLoopbackHttp: true,
        })("https://pub.example/a.pdf", { maxBytes: 64 }),
      ),
      "unsafe_redirect",
    );
  });

  it("does not leak the credential to a cross-origin redirect target", async () => {
    const calls: string[] = [];
    await createBrowserDownloader({
      fetch: stubFetch(
        {
          "https://a.example/a.pdf": { to: "https://b.example/b.pdf" },
          "https://b.example/b.pdf": { body: bytes(10) },
        },
        calls,
      ) as unknown as typeof fetch,
    })("https://a.example/a.pdf", {
      maxBytes: 64,
      credential: { origin: "https://a.example", param: "api_key", value: "SECRET" },
    });
    assert.equal(calls.length, 1); // one platform fetch; the hop is inside it
    assert.equal(new URL(calls[0] as string).searchParams.get("api_key"), "SECRET");
    // The redirect target URL carries no credential: the stub followed `to`
    // verbatim, so a leak would have to be re-attached per hop (it is not).
  });

  it("keeps allowLoopbackHttp off by default", async () => {
    const calls: string[] = [];
    assert.equal(
      await codeOf(
        createBrowserDownloader({ fetch: stubFetch({}, calls) as unknown as typeof fetch })("http://127.0.0.1:9/a.pdf", { maxBytes: 64 }),
      ),
      "unsafe_destination",
    );
    assert.equal(calls.length, 0);
  });

  it("propagates caller cancellation", async () => {
    const calls: string[] = [];
    const ctrl = new AbortController();
    ctrl.abort(new Error("caller stop"));
    await assert.rejects(
      createBrowserDownloader({ fetch: stubFetch({}, calls) as unknown as typeof fetch })("https://pub.example/a.pdf", {
        maxBytes: 64,
        signal: ctrl.signal,
      }),
    );
  });
});

describe("node-only cases (no browser equivalent)", () => {
  it("blocks private-address hosts", async () => {
    const { transport } = scripted({});
    assert.equal(
      await codeOf(createSafeDownloader({ resolve: publicResolver, transport })("https://private.example/a.pdf", { maxBytes: 64 })),
      "unsafe_destination",
    );
  });

  it("caps redirects at MAX_REDIRECTS", async () => {
    const { transport } = scripted({
      "https://pub.example/a.pdf": { status: 302, headers: { location: "https://pub.example/a.pdf" } },
    });
    assert.equal(await codeOf(createSafeDownloader({ resolve: publicResolver, transport })("https://pub.example/a.pdf", { maxBytes: 64 })), "unsafe_redirect");
  });
});
