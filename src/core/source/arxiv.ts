/**
 * arXiv identifiers and politeness. A PDF URL is only ever built from an arXiv identifier that a provider record or the paper's own
 * DOI carries (DataCite DOIs `10.48550/arXiv.<id>`, an `arxiv.org/abs/<id>` location, Semantic Scholar's `externalIds.ArXiv`), never
 * from a title or a guess.
 */
import { defaultSleep } from "../providers/http.ts";
import { createStartSpacer, type StartSpacer } from "../providers/semantic-scholar.ts";

const MODERN_ID = /^\d{4}\.\d{4,5}(?:v\d+)?$/;
const OLD_ID = /^[a-z][a-z-]*(?:\.[a-z]{2})?\/\d{7}(?:v\d+)?$/i;

/** Only well-formed arXiv identifiers become URL path segments. */
export const isArxivId = (id: string): boolean => MODERN_ID.test(id) || OLD_ID.test(id);

export const arxivPdfUrl = (id: string): string => `https://arxiv.org/pdf/${id}`;

const baseId = (id: string): string => id.replace(/v\d+$/, "").toLowerCase();
export const sameArxivWork = (a: string, b: string): boolean => baseId(a) === baseId(b);

/** `10.48550/arxiv.2511.15162` → `2511.15162` (the prefix is case-insensitive in a DOI). */
export function arxivIdFromDoi(doi: string): string | null {
  const m = /^10\.48550\/arxiv\.(.+)$/i.exec(doi.trim());
  return m !== null && isArxivId(m[1] as string) ? (m[1] as string) : null;
}

/** An arXiv id from an `arxiv.org/abs|pdf/<id>` URL or a `doi.org/10.48550/arxiv.<id>` link. */
export function arxivIdFromUrl(raw: string): string | null {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return null;
  }
  const host = url.hostname.toLowerCase().replace(/^www\./, "");
  const path = decodeURIComponent(url.pathname);
  if (host === "arxiv.org") {
    const m = /^\/(?:abs|pdf)\/(.+?)(?:\.pdf)?$/.exec(path);
    return m !== null && isArxivId(m[1] as string) ? (m[1] as string) : null;
  }
  if (host === "doi.org" || host === "dx.doi.org") return arxivIdFromDoi(path.replace(/^\//, ""));
  return null;
}

/** A DOI link redirects to the publisher's landing page; it is never a direct document. */
export function isDoiResolver(raw: string): boolean {
  try {
    return ["doi.org", "dx.doi.org"].includes(new URL(raw).hostname.toLowerCase().replace(/^www\./, ""));
  } catch {
    return false;
  }
}

export function isArxivHost(raw: string): boolean {
  try {
    return new URL(raw).hostname.toLowerCase().replace(/^www\./, "") === "arxiv.org";
  } catch {
    return false;
  }
}

/** arXiv's documented limit for programmatic access: one request every 3 seconds, one connection at a time
 *  (info.arxiv.org/help/api/tou.html). robots.txt asks crawlers for 15 s; this tool fetches the few papers a user asked about. */
export const ARXIV_MIN_SPACING_MS = 3000;

/** After an HTTP 429 or 403 arXiv is left alone for a while (it treats ignored 403s as abuse): 60 s, doubling to 10 min while it keeps refusing. */
export const ARXIV_COOLDOWN_START_MS = 60_000;
export const ARXIV_COOLDOWN_MAX_MS = 600_000;
const cooldowns = new WeakMap<(ms: number) => Promise<void>, { until: number; ms: number }>();

export const arxivCoolingDown = (sleep: ((ms: number) => Promise<void>) | undefined): boolean => Date.now() < (cooldowns.get(sleep ?? defaultSleep)?.until ?? 0);

export function noteArxivRefusal(sleep: ((ms: number) => Promise<void>) | undefined): void {
  const clock = sleep ?? defaultSleep;
  const ms = Math.min((cooldowns.get(clock)?.ms ?? ARXIV_COOLDOWN_START_MS / 2) * 2, ARXIV_COOLDOWN_MAX_MS);
  cooldowns.set(clock, { until: Date.now() + ms, ms });
}

export const noteArxivSuccess = (sleep: ((ms: number) => Promise<void>) | undefined): void => void cooldowns.delete(sleep ?? defaultSleep);

const spacers = new WeakMap<(ms: number) => Promise<void>, StartSpacer>();

/** One spacer per clock: production shares one for the process; a test that injects its own sleep gets a fresh one. */
export function arxivSpacer(sleep: ((ms: number) => Promise<void>) | undefined): StartSpacer {
  const clock = sleep ?? defaultSleep;
  let spacer = spacers.get(clock);
  if (spacer === undefined) {
    spacer = createStartSpacer({ minIntervalMs: ARXIV_MIN_SPACING_MS, sleep: clock, now: () => Date.now() });
    spacers.set(clock, spacer);
  }
  return spacer;
}
