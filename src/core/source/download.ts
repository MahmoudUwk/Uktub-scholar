/**
 * Safe acquisition transport (KTD3, R15). The only code in the package that
 * fetches document bytes from third-party hosts, so every control lives here:
 *
 *  - HTTPS only, no embedded credentials;
 *  - the host is resolved ONCE per hop and every answer must be a public
 *    address; the connection is then pinned to that address (no second DNS
 *    lookup, so DNS rebinding cannot swap in a private one);
 *  - redirects are followed by hand (≤ MAX_REDIRECTS) and each hop repeats the
 *    checks above;
 *  - a credential is attached only to requests whose origin it was minted for,
 *    and is stripped from everything reported;
 *  - received bytes are bounded while streaming, and a short body is
 *    `truncated`, never a smaller document;
 *  - failures are normalized `SourceError`s — raw exceptions can echo URLs and
 *    keys, so they never leave this module.
 *
 * Resolver and transport are injectable so the logic is tested offline.
 */

import { lookup } from "node:dns/promises";
import { request as httpsRequest } from "node:https";
import type { RequestOptions } from "node:https";
import { BlockList, isIP } from "node:net";

import { SourceError } from "./extract.ts";

export interface DownloadCredential {
  /** Origin the credential is valid for (e.g. https://content.openalex.org). */
  origin: string;
  /** Query parameter that carries it (the Content API's `api_key`). */
  param: string;
  value: string;
}

export interface DownloadInit {
  maxBytes: number;
  signal?: AbortSignal;
  credential?: DownloadCredential;
}

export interface DownloadResult {
  /** Final URL after redirects, credential removed. A nonsecret reference. */
  finalUrl: string;
  contentType: string | null;
  bytes: Uint8Array;
}

export type DownloadLike = (url: string, init: DownloadInit) => Promise<DownloadResult>;

export interface TransportRequest {
  url: URL;
  /** The validated address to connect to; the URL's host stays the SNI/Host. */
  address: string;
  maxBytes: number;
  signal?: AbortSignal;
}
export interface TransportResponse {
  status: number;
  /** Lower-cased header names. */
  headers: Record<string, string>;
  body: Uint8Array;
}
/** One HTTP hop. Never follows redirects. */
export type Transport = (req: TransportRequest) => Promise<TransportResponse>;
export type Resolver = (host: string) => Promise<string[]>;

/** Client policy: redirect hops followed (publisher → CDN chains are 1–3). */
export const MAX_REDIRECTS = 5;
/** Client policy: one whole download, all hops (a 64 MiB cap at ≥ 1 MB/s). */
export const DOWNLOAD_TIMEOUT_MS = 60_000;

// ── address policy ──────────────────────────────────────────────────────────

const blocked = new BlockList();
for (const [net, prefix] of [
  ["0.0.0.0", 8], // "this" network
  ["10.0.0.0", 8],
  ["100.64.0.0", 10], // carrier-grade NAT
  ["127.0.0.0", 8],
  ["169.254.0.0", 16], // link-local, cloud metadata
  ["172.16.0.0", 12],
  ["192.0.0.0", 24],
  ["192.0.2.0", 24],
  ["192.168.0.0", 16],
  ["198.18.0.0", 15],
  ["198.51.100.0", 24],
  ["203.0.113.0", 24],
  ["224.0.0.0", 4], // multicast
  ["240.0.0.0", 4], // reserved + broadcast
  ["192.88.99.0", 24], // 6to4 relay anycast
] as const) blocked.addSubnet(net, prefix, "ipv4");
for (const [net, prefix] of [
  ["::", 128],
  ["::1", 128],
  ["fc00::", 7], // unique local
  ["fe80::", 10], // link-local
  ["ff00::", 8], // multicast
  ["2001:db8::", 32], // documentation
  ["2001::", 32], // Teredo
  ["2002::", 16], // 6to4
  ["::", 96], // IPv4-compatible (deprecated): embeds an IPv4 address
  ["100::", 64], // discard-only
  ["64:ff9b:1::", 48], // local-use NAT64
  ["fec0::", 10], // site-local (deprecated)
  ["::ffff:0:0:0", 96], // IPv4-translated (SIIT, RFC 6052): embeds an IPv4 address, distinct from the v4-mapped ::ffff:a.b.c.d
] as const) blocked.addSubnet(net, prefix, "ipv6");

/** IPv4 embedded in an IPv6 address (v4-mapped ::ffff:a.b.c.d, NAT64 64:ff9b::/96), or null. */
function embeddedV4(ip: string): string | null {
  const m = /^(?:::ffff:|64:ff9b::)(\d+\.\d+\.\d+\.\d+)$/i.exec(ip);
  if (m) return m[1];
  const hex = /^(?:::ffff:|64:ff9b::)([0-9a-f]{1,4}):([0-9a-f]{1,4})$/i.exec(ip);
  if (hex) {
    const hi = parseInt(hex[1], 16);
    const lo = parseInt(hex[2], 16);
    return `${hi >> 8}.${hi & 255}.${lo >> 8}.${lo & 255}`;
  }
  return null;
}

/** True only for a globally routable unicast address. Anything unparseable is not public. */
export function isPublicAddress(ip: string): boolean {
  const family = isIP(ip);
  if (family === 0) return false;
  if (family === 6) {
    const v4 = embeddedV4(ip);
    if (v4 !== null) return isPublicAddress(v4);
    if (/^64:ff9b::/i.test(ip)) return false; // NAT64 range holds an embedded v4 that must itself be checked
  }
  return !blocked.check(ip, family === 4 ? "ipv4" : "ipv6");
}

const defaultResolve: Resolver = async (host) => (await lookup(host, { all: true })).map((r) => r.address);

// ── downloader ──────────────────────────────────────────────────────────────

function parseHttps(raw: string, code: "unsafe_destination" | "unsafe_redirect"): URL {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new SourceError(code, "the address is not a valid URL");
  }
  if (url.protocol !== "https:") throw new SourceError(code, "only https addresses are fetched");
  if (url.username !== "" || url.password !== "") throw new SourceError(code, "addresses with embedded credentials are refused");
  return url;
}

/** The reported reference carries NO query or fragment: a redirect target may be a signed
 *  URL (`?X-Amz-Signature=…`), and a reference must stay nonsecret (KTD3). */
const referenceOf = (url: URL): string => `${url.origin}${url.pathname}`;

export function createSafeDownloader(deps: { resolve?: Resolver; transport?: Transport } = {}): DownloadLike {
  const resolve = deps.resolve ?? defaultResolve;
  const transport = deps.transport ?? createHttpsTransport();

  return async (raw, init) => {
    init.signal?.throwIfAborted();
    const signal = AbortSignal.any([AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS), ...(init.signal ? [init.signal] : [])]);
    let url = parseHttps(raw, "unsafe_destination");
    for (let hop = 0; ; hop++) {
      const code = hop === 0 ? "unsafe_destination" : "unsafe_redirect";
      const host = url.hostname.replace(/^\[|\]$/g, "");
      let addresses: string[];
      try {
        addresses = isIP(host) !== 0 ? [host] : await resolve(host);
      } catch {
        throw new SourceError("download_failed", "the host could not be resolved");
      }
      if (addresses.length === 0) throw new SourceError("download_failed", "the host has no address");
      if (!addresses.every(isPublicAddress)) throw new SourceError(code, "the host resolves to a non-public address");

      const hopUrl = new URL(url.href);
      if (init.credential && hopUrl.origin === init.credential.origin) {
        hopUrl.searchParams.set(init.credential.param, init.credential.value);
      }
      // Every address was validated above; try them in order so a dual-stack
      // host without IPv6 routing still works. A size/format verdict from the
      // server is final; only an unreachable address moves on to the next.
      let res: TransportResponse | undefined;
      for (const address of addresses) {
        try {
          res = await transport({ url: hopUrl, address, maxBytes: init.maxBytes, signal });
          break;
        } catch (err) {
          if (err instanceof SourceError) throw err;
          if (init.signal?.aborted) throw err;
        }
      }
      if (res === undefined) throw new SourceError("download_failed", "the request failed");

      if (res.status >= 300 && res.status < 400 && res.headers["location"]) {
        if (hop >= MAX_REDIRECTS) throw new SourceError("unsafe_redirect", `more than ${MAX_REDIRECTS} redirects`);
        url = parseHttps(new URL(res.headers["location"], url).href, "unsafe_redirect");
        continue;
      }
      if (res.status !== 200) throw new SourceError("download_failed", `the host answered HTTP ${res.status}`);

      const declared = res.headers["content-length"] !== undefined ? Number(res.headers["content-length"]) : null;
      if (declared !== null && Number.isFinite(declared) && declared > init.maxBytes) {
        throw new SourceError("too_large", `the document is larger than ${init.maxBytes} bytes`);
      }
      if (res.body.byteLength > init.maxBytes) throw new SourceError("too_large", `the document is larger than ${init.maxBytes} bytes`);
      if (declared !== null && Number.isFinite(declared) && res.body.byteLength < declared) {
        throw new SourceError("truncated", "the body is shorter than the declared length");
      }
      return { finalUrl: referenceOf(url), contentType: res.headers["content-type"] ?? null, bytes: res.body };
    }
  };
}

// ── production transport ────────────────────────────────────────────────────

/** One hop over node:https, pinned to `req.address`, body bounded while streaming. */
export function createHttpsTransport(deps: { request?: typeof httpsRequest } = {}): Transport {
  const doRequest = deps.request ?? httpsRequest;
  return ({ url, address, maxBytes, signal }) =>
    new Promise<TransportResponse>((resolve, reject) => {
      const opts: RequestOptions = {
        host: address,
        servername: isIP(url.hostname) === 0 ? url.hostname : undefined,
        port: url.port === "" ? undefined : Number(url.port),
        path: `${url.pathname}${url.search}`,
        method: "GET",
        headers: { host: url.host, "accept-encoding": "identity", "user-agent": "uktub-scholar" },
        signal,
      };
      const req = doRequest(opts, (res) => {
        const headers: Record<string, string> = {};
        for (const [k, v] of Object.entries(res.headers)) if (v !== undefined) headers[k.toLowerCase()] = Array.isArray(v) ? v.join(", ") : v;
        if (res.statusCode !== undefined && res.statusCode >= 300 && res.statusCode < 400) {
          res.resume();
          resolve({ status: res.statusCode, headers, body: new Uint8Array() });
          return;
        }
        const chunks: Buffer[] = [];
        let size = 0;
        res.on("data", (c: Buffer) => {
          size += c.length;
          if (size > maxBytes) {
            req.destroy();
            reject(new SourceError("too_large", `the document is larger than ${maxBytes} bytes`));
            return;
          }
          chunks.push(c);
        });
        res.on("end", () => {
          if (!res.complete) reject(new SourceError("truncated", "the connection ended before the body was complete"));
          else resolve({ status: res.statusCode ?? 0, headers, body: new Uint8Array(Buffer.concat(chunks)) });
        });
        res.on("error", () => reject(new SourceError("truncated", "the connection ended before the body was complete")));
        res.on("aborted", () => reject(new SourceError("truncated", "the connection ended before the body was complete")));
      });
      req.on("error", (err) => reject(err));
      req.end();
    });
}
