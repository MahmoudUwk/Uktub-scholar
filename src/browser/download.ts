/**
 * Browser implementation of the core `DownloadLike` contract
 * (`src/core/source/download.ts`), injected by the host through the tool
 * context. The core's Node downloader is NOT rewritten: this is the page-side
 * variant for the static, client-only app.
 *
 * Host-independent: no `node:*` import (only type-only imports, erased at
 * compile); `fetch`, the timer and the clock are injectable. Acquisition
 * rules kept: HTTPS public addresses only (the page cannot resolve or pin
 * DNS — see GUARDS.md), no URL userinfo, byte cap enforced while streaming
 * with the SAME verdicts/messages as `createSafeDownloader`, a whole-call
 * time cap, `redirect: "follow"` with the FINAL `response.url` required to
 * be `https:`, `credentials: "omit"`, and a `DownloadInit` credential sent
 * only to its own origin (never re-attached after a cross-origin redirect:
 * the credential rides the first request's query and the platform follows
 * redirects without re-attaching it).
 *
 * A failed `fetch` (`TypeError`: CORS refusal, redirect hop, network, TLS —
 * indistinguishable to a page) maps to the existing `download_failed` code
 * with a message that claims no cause.
 */
import type {
  DownloadCredential,
  DownloadInit,
  DownloadLike,
  DownloadResult,
} from "../core/source/download.ts";
import type { SourceFailureCode } from "../core/source/extract.ts";

/** Mirrors core `DOWNLOAD_TIMEOUT_MS` (one whole download, all hops). */
export const BROWSER_DOWNLOAD_TIMEOUT_MS = 60_000;

export interface BrowserDownloaderDeps {
  fetch?: typeof fetch;
  /** Injectable timer so tests drive the time cap without waiting. */
  setTimeoutFn?: (fn: () => void, ms: number) => unknown;
  clearTimeoutFn?: (handle: unknown) => void;
  /** Test-only: allow `http:` to loopback hosts (local servers). Off by default. */
  allowLoopbackHttp?: boolean;
  /** Test-only: override the whole-call time cap. */
  timeoutMs?: number;
}

/**
 * Structurally a `SourceError` (same `name`, same `code` union): the browser
 * module cannot import `../core/source/extract.ts` at runtime (it pulls
 * `node:zlib`/parsers), so the class is repeated here rather than widened.
 */
export class BrowserSourceError extends Error {
  readonly code: SourceFailureCode;
  constructor(code: SourceFailureCode, message: string) {
    super(message);
    this.name = "SourceError";
    this.code = code;
  }
}

const MANUAL_IMPORT =
  "the host did not allow this browser to read the file, or could not be reached; import the PDF manually";

function isLoopback(host: string): boolean {
  const h = host.toLowerCase().replace(/^\[|\]$/g, "");
  return (
    h === "localhost" ||
    h === "::1" ||
    h === "127.0.0.1" ||
    /^127\./.test(h) ||
    h === "::ffff:127.0.0.1" ||
    /^::ffff:127\./.test(h)
  );
}

function parseUrl(raw: string, code: "unsafe_destination" | "unsafe_redirect", allowLoopbackHttp: boolean): URL {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new BrowserSourceError(code, "the address is not a valid URL");
  }
  if (url.protocol === "http:" && allowLoopbackHttp && isLoopback(url.hostname)) {
    // Test-server escape hatch only; production stays https-only.
  } else if (url.protocol !== "https:") {
    throw new BrowserSourceError(code, "only https addresses are fetched");
  }
  if (url.username !== "" || url.password !== "") {
    throw new BrowserSourceError(code, "addresses with embedded credentials are refused");
  }
  return url;
}

/** The reported reference carries NO query or fragment (same as core `referenceOf`). */
const referenceOf = (url: URL): string => `${url.origin}${url.pathname}`;

function credentialedUrl(raw: URL, credential: DownloadCredential | undefined): URL {
  const url = new URL(raw.href);
  if (credential !== undefined && url.origin === credential.origin) {
    url.searchParams.set(credential.param, credential.value);
  }
  return url;
}

export function createBrowserDownloader(deps: BrowserDownloaderDeps = {}): DownloadLike {
  const doFetch = deps.fetch ?? globalThis.fetch.bind(globalThis);
  const setTimer = deps.setTimeoutFn ?? ((fn: () => void, ms: number) => setTimeout(fn, ms));
  const clearTimer = deps.clearTimeoutFn ?? ((h: unknown) => clearTimeout(h as ReturnType<typeof setTimeout>));
  const allowLoopbackHttp = deps.allowLoopbackHttp ?? false;
  const timeoutMs = deps.timeoutMs ?? BROWSER_DOWNLOAD_TIMEOUT_MS;

  return async (raw: string, init: DownloadInit): Promise<DownloadResult> => {
    init.signal?.throwIfAborted();
    const startUrl = parseUrl(raw, "unsafe_destination", allowLoopbackHttp);
    const requestUrl = credentialedUrl(startUrl, init.credential);

    const ctrl = new AbortController();
    const timeoutState = { timedOut: false };
    const onCallerAbort = (): void => ctrl.abort(init.signal?.reason);
    if (init.signal !== undefined) init.signal.addEventListener("abort", onCallerAbort, { once: true });
    const timer = setTimer(() => {
      timeoutState.timedOut = true;
      ctrl.abort(new Error("download timeout"));
    }, timeoutMs);

    try {
      let res: Response;
      try {
        // No Range header is ever sent; no credentials are ever attached by the
        // platform (`credentials: "omit"`); redirects are followed by the
        // platform because manual hops are opaque to a page.
        res = await doFetch(requestUrl.href, {
          method: "GET",
          redirect: "follow",
          credentials: "omit",
          signal: ctrl.signal,
        });
      } catch (err) {
        if (init.signal?.aborted) throw err;
        if (timeoutState.timedOut) throw new BrowserSourceError("download_failed", "the download exceeded the time limit");
        throw new BrowserSourceError("download_failed", MANUAL_IMPORT);
      }
      return await readBody(res, init, timeoutState);
    } finally {
      // The cap covers the whole call (headers AND body); the timer dies here.
      clearTimer(timer);
      if (init.signal !== undefined) init.signal.removeEventListener("abort", onCallerAbort);
    }
  };

  /** Everything after the fetch resolves: status, caps, streaming body. */
  async function readBody(res: Response, init: DownloadInit, timeout: { timedOut: boolean }): Promise<DownloadResult> {
    // Every exit before the streaming loop discards the unread body, so the
    // connection is released rather than left open until garbage collection.
    const discard = async (): Promise<void> => {
      await res.body?.cancel().catch(() => undefined);
    };
    if (init.signal?.aborted) {
      await discard();
      init.signal.throwIfAborted();
    }

    let finalUrl: URL;
    try {
      finalUrl = parseUrl(res.url, "unsafe_redirect", allowLoopbackHttp);
    } catch (err) {
      await discard();
      throw err;
    }
    if (res.status !== 200) {
      await discard();
      throw new BrowserSourceError("download_failed", `the host answered HTTP ${res.status}`);
    }

    const rawLength = res.headers.get("content-length");
    const declared = rawLength !== null ? Number(rawLength) : null;
    if (declared !== null && Number.isFinite(declared) && declared > init.maxBytes) {
      await discard();
      throw new BrowserSourceError("too_large", `the document is larger than ${init.maxBytes} bytes`);
    }

    // Streamed byte cap: same verdict as the core transport, which rejects
    // mid-stream rather than buffering past the cap.
    const chunks: Uint8Array[] = [];
    let size = 0;
    if (res.body !== null) {
      const reader = res.body.getReader();
      try {
        for (;;) {
          const { done, value } = await reader.read();
          if (init.signal?.aborted) {
            await reader.cancel().catch(() => undefined);
            init.signal.throwIfAborted();
          }
          if (done) break;
          size += value.byteLength;
          if (size > init.maxBytes) {
            await reader.cancel().catch(() => undefined);
            throw new BrowserSourceError("too_large", `the document is larger than ${init.maxBytes} bytes`);
          }
          chunks.push(value);
        }
      } catch (err) {
        if (isBrowserSourceError(err) || init.signal?.aborted) throw err;
        if (timeout.timedOut) throw new BrowserSourceError("download_failed", "the download exceeded the time limit");
        throw new BrowserSourceError("truncated", "the connection ended before the body was complete");
      } finally {
        reader.releaseLock();
      }
    }
    if (declared !== null && Number.isFinite(declared) && size < declared) {
      throw new BrowserSourceError("truncated", "the body is shorter than the declared length");
    }
    const bytes = new Uint8Array(size);
    let at = 0;
    for (const c of chunks) {
      bytes.set(c, at);
      at += c.byteLength;
    }
    return { finalUrl: referenceOf(finalUrl), contentType: res.headers.get("content-type"), bytes };
  };
}

const isBrowserSourceError = (err: unknown): err is BrowserSourceError =>
  err instanceof BrowserSourceError;
