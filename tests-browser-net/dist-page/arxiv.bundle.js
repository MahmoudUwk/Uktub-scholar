// src/core/doi.ts
var ARXIV_ID_PATTERN = String.raw`\d{4}\.\d{4,5}(?:v\d+)?`;

// src/core/providers/http.ts
function defaultSleep(ms) {
  const { promise, resolve } = Promise.withResolvers();
  setTimeout(resolve, ms);
  return promise;
}

// src/core/providers/semantic-scholar.ts
function createStartSpacer(opts) {
  let lastStartMs = Number.NEGATIVE_INFINITY;
  let queue = Promise.resolve();
  return {
    wait() {
      const turn = queue.then(async () => {
        const elapsed = opts.now() - lastStartMs;
        if (elapsed < opts.minIntervalMs) await opts.sleep(opts.minIntervalMs - elapsed);
        lastStartMs = opts.now();
      });
      queue = turn.then(
        () => void 0,
        () => void 0
      );
      return turn;
    }
  };
}

// src/core/source/arxiv.ts
var MODERN_ID = /^\d{4}\.\d{4,5}(?:v\d+)?$/;
var OLD_ID = /^[a-z][a-z-]*(?:\.[a-z]{2})?\/\d{7}(?:v\d+)?$/i;
var isArxivId = (id) => MODERN_ID.test(id) || OLD_ID.test(id);
var arxivPdfUrl = (id) => `https://arxiv.org/pdf/${id}`;
var baseId = (id) => id.replace(/v\d+$/, "").toLowerCase();
var sameArxivWork = (a, b) => baseId(a) === baseId(b);
function arxivIdFromDoi(doi) {
  const m = /^10\.48550\/arxiv\.(.+)$/i.exec(doi.trim());
  return m !== null && isArxivId(m[1]) ? m[1] : null;
}
function arxivIdFromUrl(raw) {
  let url;
  try {
    url = new URL(raw);
  } catch {
    return null;
  }
  const host = url.hostname.toLowerCase().replace(/^www\./, "");
  const path = decodeURIComponent(url.pathname);
  if (host === "arxiv.org") {
    const m = /^\/(?:abs|pdf)\/(.+?)(?:\.pdf)?$/.exec(path);
    return m !== null && isArxivId(m[1]) ? m[1] : null;
  }
  if (host === "doi.org" || host === "dx.doi.org") return arxivIdFromDoi(path.replace(/^\//, ""));
  return null;
}
function isDoiResolver(raw) {
  try {
    return ["doi.org", "dx.doi.org"].includes(new URL(raw).hostname.toLowerCase().replace(/^www\./, ""));
  } catch {
    return false;
  }
}
function isArxivHost(raw) {
  try {
    return new URL(raw).hostname.toLowerCase().replace(/^www\./, "") === "arxiv.org";
  } catch {
    return false;
  }
}
var ARXIV_MIN_SPACING_MS = 3e3;
var ARXIV_COOLDOWN_START_MS = 6e4;
var ARXIV_COOLDOWN_MAX_MS = 6e5;
var cooldowns = /* @__PURE__ */ new WeakMap();
var arxivCoolingDown = (sleep) => Date.now() < (cooldowns.get(sleep ?? defaultSleep)?.until ?? 0);
function noteArxivRefusal(sleep) {
  const clock = sleep ?? defaultSleep;
  const ms = Math.min((cooldowns.get(clock)?.ms ?? ARXIV_COOLDOWN_START_MS / 2) * 2, ARXIV_COOLDOWN_MAX_MS);
  cooldowns.set(clock, { until: Date.now() + ms, ms });
}
var noteArxivSuccess = (sleep) => void cooldowns.delete(sleep ?? defaultSleep);
var spacers = /* @__PURE__ */ new WeakMap();
function arxivSpacer(sleep) {
  const clock = sleep ?? defaultSleep;
  let spacer = spacers.get(clock);
  if (spacer === void 0) {
    spacer = createStartSpacer({ minIntervalMs: ARXIV_MIN_SPACING_MS, sleep: clock, now: () => Date.now() });
    spacers.set(clock, spacer);
  }
  return spacer;
}
export {
  ARXIV_COOLDOWN_MAX_MS,
  ARXIV_COOLDOWN_START_MS,
  ARXIV_MIN_SPACING_MS,
  arxivCoolingDown,
  arxivIdFromDoi,
  arxivIdFromUrl,
  arxivPdfUrl,
  arxivSpacer,
  isArxivHost,
  isArxivId,
  isDoiResolver,
  noteArxivRefusal,
  noteArxivSuccess,
  sameArxivWork
};
