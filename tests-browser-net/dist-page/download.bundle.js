// src/browser/download.ts
var BROWSER_DOWNLOAD_TIMEOUT_MS = 6e4;
var BrowserSourceError = class extends Error {
  code;
  constructor(code, message) {
    super(message);
    this.name = "SourceError";
    this.code = code;
  }
};
var MANUAL_IMPORT = "the host did not allow this browser to read the file, or could not be reached; import the PDF manually";
function isLoopback(host) {
  const h = host.toLowerCase().replace(/^\[|\]$/g, "");
  return h === "localhost" || h === "::1" || h === "127.0.0.1" || /^127\./.test(h) || h === "::ffff:127.0.0.1" || /^::ffff:127\./.test(h);
}
function parseUrl(raw, code, allowLoopbackHttp) {
  let url;
  try {
    url = new URL(raw);
  } catch {
    throw new BrowserSourceError(code, "the address is not a valid URL");
  }
  if (url.protocol === "http:" && allowLoopbackHttp && isLoopback(url.hostname)) {
  } else if (url.protocol !== "https:") {
    throw new BrowserSourceError(code, "only https addresses are fetched");
  }
  if (url.username !== "" || url.password !== "") {
    throw new BrowserSourceError(code, "addresses with embedded credentials are refused");
  }
  return url;
}
var referenceOf = (url) => `${url.origin}${url.pathname}`;
function credentialedUrl(raw, credential) {
  const url = new URL(raw.href);
  if (credential !== void 0 && url.origin === credential.origin) {
    url.searchParams.set(credential.param, credential.value);
  }
  return url;
}
function createBrowserDownloader(deps = {}) {
  const doFetch = deps.fetch ?? globalThis.fetch.bind(globalThis);
  const setTimer = deps.setTimeoutFn ?? ((fn, ms) => setTimeout(fn, ms));
  const clearTimer = deps.clearTimeoutFn ?? ((h) => clearTimeout(h));
  const allowLoopbackHttp = deps.allowLoopbackHttp ?? false;
  const timeoutMs = deps.timeoutMs ?? BROWSER_DOWNLOAD_TIMEOUT_MS;
  return async (raw, init) => {
    init.signal?.throwIfAborted();
    const startUrl = parseUrl(raw, "unsafe_destination", allowLoopbackHttp);
    const requestUrl = credentialedUrl(startUrl, init.credential);
    const ctrl = new AbortController();
    const timeoutState = { timedOut: false };
    const onCallerAbort = () => ctrl.abort(init.signal?.reason);
    if (init.signal !== void 0) init.signal.addEventListener("abort", onCallerAbort, { once: true });
    const timer = setTimer(() => {
      timeoutState.timedOut = true;
      ctrl.abort(new Error("download timeout"));
    }, timeoutMs);
    let res;
    try {
      res = await doFetch(requestUrl.href, {
        method: "GET",
        redirect: "follow",
        credentials: "omit",
        signal: ctrl.signal
      });
    } catch (err) {
      if (init.signal?.aborted) throw err;
      if (timeoutState.timedOut) throw new BrowserSourceError("download_failed", "the download exceeded the time limit");
      throw new BrowserSourceError("download_failed", MANUAL_IMPORT);
    }
    try {
      return await readBody(res, init, timeoutState);
    } finally {
      clearTimer(timer);
      init.signal?.removeEventListener("abort", onCallerAbort);
    }
  };
  async function readBody(res, init, timeout) {
    if (init.signal?.aborted) init.signal.throwIfAborted();
    const finalUrl = parseUrl(res.url, "unsafe_redirect", allowLoopbackHttp);
    if (res.status !== 200) {
      throw new BrowserSourceError("download_failed", `the host answered HTTP ${res.status}`);
    }
    const rawLength = res.headers.get("content-length");
    const declared = rawLength !== null ? Number(rawLength) : null;
    if (declared !== null && Number.isFinite(declared) && declared > init.maxBytes) {
      throw new BrowserSourceError("too_large", `the document is larger than ${init.maxBytes} bytes`);
    }
    const chunks = [];
    let size = 0;
    if (res.body !== null) {
      const reader = res.body.getReader();
      try {
        for (; ; ) {
          const { done, value } = await reader.read();
          if (init.signal?.aborted) {
            await reader.cancel().catch(() => void 0);
            init.signal.throwIfAborted();
          }
          if (done) break;
          size += value.byteLength;
          if (size > init.maxBytes) {
            await reader.cancel().catch(() => void 0);
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
  }
  ;
}
var isBrowserSourceError = (err) => err instanceof BrowserSourceError;
export {
  BROWSER_DOWNLOAD_TIMEOUT_MS,
  BrowserSourceError,
  createBrowserDownloader
};
