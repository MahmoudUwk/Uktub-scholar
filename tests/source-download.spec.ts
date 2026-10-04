/**
 * Safe acquisition transport (KTD3, R15): HTTPS-only, public-address-only with
 * revalidation after every redirect, DNS pinned to the validated address,
 * credentials scoped to their origin, bounded bodies, and normalized failures
 * that never carry a secret. Offline: resolver and transport are injected.
 */
import { describe, it, after } from "node:test";
import assert from "node:assert/strict";
import { createServer, request as httpRequest } from "node:http";
import type { AddressInfo } from "node:net";

import {
  MAX_REDIRECTS,
  createHttpsTransport,
  createSafeDownloader,
  isPublicAddress,
  type Resolver,
  type Transport,
  type TransportRequest,
} from "../src/core/source/download.ts";
import { SourceError } from "../src/core/source/extract.ts";

const PDF = new TextEncoder().encode("%PDF-1.4 body %%EOF");
const ok = (body: Uint8Array = PDF, headers: Record<string, string> = { "content-type": "application/pdf" }) => ({ status: 200, headers, body });
const redirect = (to: string) => ({ status: 302, headers: { location: to }, body: new Uint8Array() });

const publicResolver: Resolver = async (host) => (host === "private.example" ? ["10.0.0.5"] : host === "mixed.example" ? ["93.184.216.34", "127.0.0.1"] : ["93.184.216.34"]);

function scripted(responses: Record<string, ReturnType<typeof ok>>): { transport: Transport; seen: TransportRequest[] } {
  const seen: TransportRequest[] = [];
  return {
    seen,
    transport: async (req) => {
      seen.push(req);
      const key = `${req.url.origin}${req.url.pathname}`;
      const r = responses[key];
      if (!r) throw new Error(`NO_SCRIPT ${key}`);
      return r;
    },
  };
}

const refused = (p: Promise<unknown>, code: string) =>
  assert.rejects(p, (e) => e instanceof SourceError && e.code === code, `expected ${code}`);

describe("isPublicAddress", () => {
  const blocked = ["::127.0.0.1", "::7f00:1", "100::1", "64:ff9b:1::1", "fec0::1", "192.88.99.1", "0.0.0.0", "10.1.2.3", "100.64.0.1", "127.0.0.1", "169.254.169.254", "172.16.0.1", "172.31.255.255", "192.168.1.1", "198.18.0.1", "224.0.0.1", "255.255.255.255", "::", "::1", "fc00::1", "fd12::1", "fe80::1", "ff02::1", "::ffff:127.0.0.1", "::ffff:10.0.0.1", "2001:db8::1", "64:ff9b::7f00:1"];
  const allowed = ["93.184.216.34", "8.8.8.8", "172.32.0.1", "1.1.1.1", "2606:4700:4700::1111", "::ffff:8.8.8.8"];
  for (const ip of blocked) it(`blocks ${ip}`, () => assert.equal(isPublicAddress(ip), false));
  for (const ip of allowed) it(`allows ${ip}`, () => assert.equal(isPublicAddress(ip), true));
  it("treats unparseable input as not public", () => assert.equal(isPublicAddress("not-an-ip"), false));
});

describe("createSafeDownloader", () => {
  it("downloads over https and connects to the validated address (DNS pinned)", async () => {
    const { transport, seen } = scripted({ "https://pub.example/a.pdf": ok() });
    const dl = createSafeDownloader({ resolve: publicResolver, transport });
    const res = await dl("https://pub.example/a.pdf", { maxBytes: 1000 });
    assert.deepEqual([...res.bytes], [...PDF]);
    assert.equal(res.contentType, "application/pdf");
    assert.equal(seen[0].address, "93.184.216.34");
  });

  for (const [label, url, code] of [
    ["plain http", "http://pub.example/a.pdf", "unsafe_destination"],
    ["embedded credentials", "https://user:pw@pub.example/a.pdf", "unsafe_destination"],
    ["a host resolving to a private address", "https://private.example/a.pdf", "unsafe_destination"],
    ["a host with any private address among its answers", "https://mixed.example/a.pdf", "unsafe_destination"],
    ["a private IP literal", "https://127.0.0.1/a.pdf", "unsafe_destination"],
    ["a bracketed IPv6 loopback literal", "https://[::1]/a.pdf", "unsafe_destination"],
    ["a non-URL", "not a url", "unsafe_destination"],
  ] as const) {
    it(`refuses ${label} without any request`, async () => {
      const { transport, seen } = scripted({});
      await refused(createSafeDownloader({ resolve: async (h) => (h === "127.0.0.1" ? ["127.0.0.1"] : h === "[::1]" || h === "::1" ? ["::1"] : publicResolver(h)), transport })(url, { maxBytes: 1000 }), code);
      assert.equal(seen.length, 0);
    });
  }

  it("follows redirects, resolving relative Locations and revalidating every hop", async () => {
    const { transport, seen } = scripted({
      "https://a.example/start": redirect("/next"),
      "https://a.example/next": redirect("https://b.example/final.pdf"),
      "https://b.example/final.pdf": ok(),
    });
    const res = await createSafeDownloader({ resolve: publicResolver, transport })("https://a.example/start", { maxBytes: 1000 });
    assert.equal(res.finalUrl, "https://b.example/final.pdf");
    assert.equal(seen.length, 3);
  });

  it("refuses a redirect to a private address or to plain http, after the first hop was fine", async () => {
    for (const target of ["https://private.example/x", "http://pub.example/x"]) {
      const { transport } = scripted({ "https://a.example/start": redirect(target) });
      await refused(createSafeDownloader({ resolve: publicResolver, transport })("https://a.example/start", { maxBytes: 1000 }), "unsafe_redirect");
    }
  });

  it("refuses redirect loops beyond the hop limit", async () => {
    const { transport, seen } = scripted({ "https://a.example/loop": redirect("https://a.example/loop") });
    await refused(createSafeDownloader({ resolve: publicResolver, transport })("https://a.example/loop", { maxBytes: 1000 }), "unsafe_redirect");
    assert.equal(seen.length, MAX_REDIRECTS + 1);
  });

  it("sends the credential only to its own origin and never reports it", async () => {
    const { transport, seen } = scripted({
      "https://content.example/w.pdf": redirect("https://cdn.other.example/w.pdf"),
      "https://cdn.other.example/w.pdf": ok(),
    });
    const res = await createSafeDownloader({ resolve: publicResolver, transport })("https://content.example/w.pdf", {
      maxBytes: 1000,
      credential: { origin: "https://content.example", param: "api_key", value: "SECRET-KEY" },
    });
    assert.equal(seen[0].url.searchParams.get("api_key"), "SECRET-KEY", "own origin gets the key");
    assert.equal(seen[1].url.searchParams.get("api_key"), null, "the redirect target does not");
    assert.ok(!res.finalUrl.includes("SECRET-KEY"));
  });

  it("reports no query string at all: a redirect to a signed URL must not become a persisted reference", async () => {
    const { transport } = scripted({
      "https://content.example/w.pdf": redirect("https://r2.example.net/obj.pdf?X-Amz-Signature=SECRETSIG&token=abc#frag"),
      "https://r2.example.net/obj.pdf": ok(),
    });
    const res = await createSafeDownloader({ resolve: publicResolver, transport })("https://content.example/w.pdf", { maxBytes: 1000 });
    assert.equal(res.finalUrl, "https://r2.example.net/obj.pdf");
  });

  it("strips the credential from the reported final URL even when it stays on origin", async () => {
    const { transport } = scripted({ "https://content.example/w.pdf": ok() });
    const res = await createSafeDownloader({ resolve: publicResolver, transport })("https://content.example/w.pdf", {
      maxBytes: 1000,
      credential: { origin: "https://content.example", param: "api_key", value: "SECRET-KEY" },
    });
    assert.equal(res.finalUrl, "https://content.example/w.pdf");
  });

  it("normalizes transport exceptions: no raw message (it may echo the URL and key)", async () => {
    const transport: Transport = async (req) => {
      throw new Error(`connect ECONNRESET ${req.url.href}`);
    };
    await assert.rejects(
      createSafeDownloader({ resolve: publicResolver, transport })("https://content.example/w.pdf", {
        maxBytes: 1000,
        credential: { origin: "https://content.example", param: "api_key", value: "SECRET-KEY" },
      }),
      (e) => e instanceof SourceError && e.code === "download_failed" && !/SECRET-KEY|content\.example/.test(e.message),
    );
  });

  it("refuses non-200 answers as download_failed", async () => {
    const { transport } = scripted({ "https://a.example/gone.pdf": { status: 404, headers: {}, body: new Uint8Array() } });
    await refused(createSafeDownloader({ resolve: publicResolver, transport })("https://a.example/gone.pdf", { maxBytes: 1000 }), "download_failed");
  });

  it("refuses bodies over the byte cap and bodies shorter than declared", async () => {
    const big = scripted({ "https://a.example/big.pdf": ok(new Uint8Array(2000)) });
    await refused(createSafeDownloader({ resolve: publicResolver, transport: big.transport })("https://a.example/big.pdf", { maxBytes: 1000 }), "too_large");
    const declared = scripted({ "https://a.example/cut.pdf": ok(new Uint8Array(10), { "content-length": "500" }) });
    await refused(createSafeDownloader({ resolve: publicResolver, transport: declared.transport })("https://a.example/cut.pdf", { maxBytes: 1000 }), "truncated");
    const overDeclared = scripted({ "https://a.example/huge.pdf": ok(new Uint8Array(10), { "content-length": "999999" }) });
    await refused(createSafeDownloader({ resolve: publicResolver, transport: overDeclared.transport })("https://a.example/huge.pdf", { maxBytes: 1000 }), "too_large");
  });

  it("falls back to the next validated address when one cannot be reached (dual-stack hosts without IPv6 routing)", async () => {
    const tried: string[] = [];
    const transport: Transport = async (req) => {
      tried.push(req.address);
      if (req.address === "2606:4700:4700::1111") throw new Error("connect ENETUNREACH");
      return ok();
    };
    const dl = createSafeDownloader({ resolve: async () => ["2606:4700:4700::1111", "93.184.216.34"], transport });
    const res = await dl("https://pub.example/a.pdf", { maxBytes: 1000 });
    assert.deepEqual(tried, ["2606:4700:4700::1111", "93.184.216.34"]);
    assert.equal(res.bytes.length, PDF.length);
  });

  it("does not fall back after a size or truncation verdict, and fails normalized when every address fails", async () => {
    let calls = 0;
    const big: Transport = async () => { calls++; throw new SourceError("too_large", "x"); };
    await refused(createSafeDownloader({ resolve: async () => ["93.184.216.34", "93.184.216.35"], transport: big })("https://a.example/x.pdf", { maxBytes: 10 }), "too_large");
    assert.equal(calls, 1);
    const down: Transport = async () => { throw new Error("ECONNREFUSED secret-host"); };
    await assert.rejects(
      createSafeDownloader({ resolve: async () => ["93.184.216.34", "93.184.216.35"], transport: down })("https://a.example/x.pdf", { maxBytes: 10 }),
      (e) => e instanceof SourceError && e.code === "download_failed" && !/secret-host/.test(e.message),
    );
  });

  it("an already-aborted signal stops before any request", async () => {
    const { transport, seen } = scripted({ "https://a.example/a.pdf": ok() });
    await assert.rejects(createSafeDownloader({ resolve: publicResolver, transport })("https://a.example/a.pdf", { maxBytes: 1000, signal: AbortSignal.abort() }));
    assert.equal(seen.length, 0);
  });
});

describe("createHttpsTransport (single hop, bounded stream)", () => {
  const servers: ReturnType<typeof createServer>[] = [];
  after(() => servers.forEach((s) => s.close()));
  const serve = async (handler: Parameters<typeof createServer>[1]): Promise<URL> => {
    const s = createServer(handler);
    servers.push(s);
    await new Promise<void>((r) => s.listen(0, "127.0.0.1", r));
    return new URL(`http://localhost:${(s.address() as AddressInfo).port}/doc.pdf`);
  };
  // The unit uses plain http locally; production passes node:https.request.
  const transport = createHttpsTransport({ request: httpRequest });

  it("returns status, lower-cased headers and the body, and does not follow redirects", async () => {
    const url = await serve((req, res) => {
      if (req.url === "/doc.pdf") res.writeHead(302, { Location: "/elsewhere", "X-Thing": "1" }).end();
    });
    const out = await transport({ url, address: "127.0.0.1", maxBytes: 1000 });
    assert.equal(out.status, 302);
    assert.equal(out.headers["location"], "/elsewhere");
  });

  it("sends the original Host while connecting to the pinned address", async () => {
    let host = "";
    const url = await serve((req, res) => {
      host = String(req.headers.host);
      res.end("hi");
    });
    await transport({ url, address: "127.0.0.1", maxBytes: 1000 });
    assert.equal(host, url.host);
  });

  it("aborts and reports too_large once the stream passes the cap", async () => {
    const url = await serve((_req, res) => res.end(Buffer.alloc(5000)));
    await assert.rejects(transport({ url, address: "127.0.0.1", maxBytes: 1000 }), (e) => e instanceof SourceError && e.code === "too_large");
  });

  it("reports truncated when the connection drops before the body completes", async () => {
    const url = await serve((_req, res) => {
      res.writeHead(200, { "content-length": "5000" });
      res.write(Buffer.alloc(100));
      setTimeout(() => res.destroy(), 20);
    });
    await assert.rejects(transport({ url, address: "127.0.0.1", maxBytes: 100000 }), (e) => e instanceof SourceError && e.code === "truncated");
  });
});
