/**
 * DataCite is the registration agency for arXiv's 10.48550 DOI prefix.
 * Metadata and BibTeX both come from DataCite; neither is inferred from the
 * arXiv identifier or synthesized from the other response (R13).
 *
 * Ported from `UktubAI_Agentic/apps/control-api/src/tools/providers/datacite.ts`;
 * `endpoint` provenance added (Feynman, KTD3). DataCite uses its published
 * public endpoints (fixed hosts, not configurable — the config carries no
 * DataCite base URL for the same reason).
 *
 * https://support.datacite.org/docs/api-get-doi
 * https://support.datacite.org/docs/datacite-content-resolver
 */

import {
  asArray,
  asInteger,
  asRecord,
  asString,
  doiOrNull,
  fetchWithRetry,
  parseJsonBody,
  plainText,
  retryOpts,
} from "./http.ts";
import { dedupKey, ProviderRequestError, type FetchLike, type PaperRecord, type ProviderConfig } from "./types.ts";

const DATACITE_API = "https://api.datacite.org";
const DATACITE_CONTENT = "https://data.crosscite.org";

function firstTitle(value: unknown): string | null {
  for (const entry of asArray(value)) {
    const title = plainText(asString(asRecord(entry)?.["title"]));
    if (title !== null) return title;
  }
  return null;
}

function creatorNames(value: unknown): string[] {
  return asArray(value)
    .map((entry) => plainText(asString(asRecord(entry)?.["name"])))
    .filter((name): name is string => name !== null);
}

function abstractText(value: unknown): string | null {
  for (const entry of asArray(value)) {
    const description = asRecord(entry);
    if (description?.["descriptionType"] !== "Abstract") continue;
    const text = plainText(asString(description["description"]));
    if (text !== null) return text;
  }
  return null;
}

/** Resolve an arXiv DOI through its registration agency. A 404 is an unknown
 *  DOI; a missing BibTeX response leaves the metadata visible but uncitable
 *  (`bibtex: null, citable: false` — R13, never synthesized). */
export async function fetchArxivPaperByDoi(
  fetchFn: FetchLike,
  cfg: ProviderConfig,
  doi: string,
): Promise<PaperRecord | null> {
  const recordUrl = `${DATACITE_API}/dois/${encodeURI(doi)}`;
  const record = await fetchWithRetry(fetchFn, recordUrl, retryOpts(cfg));
  if (record.status === 404) return null;
  if (record.status !== 200) throw new ProviderRequestError("datacite", record.status, "DOI lookup failed");

  const attributes = asRecord(asRecord(parseJsonBody(record.body, "datacite"))?.["data"]);
  const metadata = asRecord(attributes?.["attributes"]);
  if (metadata === null || doiOrNull(metadata["doi"]) !== doi) {
    throw new ProviderRequestError("datacite", record.status, "DOI metadata missing or mismatched");
  }

  const bibUrl = `${DATACITE_CONTENT}/application/x-bibtex/${encodeURI(doi)}`;
  const bib = await fetchWithRetry(fetchFn, bibUrl, retryOpts(cfg));
  if (bib.status !== 200 && bib.status !== 204 && bib.status !== 404) {
    throw new ProviderRequestError("datacite", bib.status, "BibTeX lookup failed");
  }
  const bibtex = bib.status === 200 && bib.body.trim().length > 0 ? bib.body.trim() : null;
  const publisher = metadata["publisher"];
  const venue = plainText(asString(publisher) ?? asString(asRecord(publisher)?.["name"]));
  const title = firstTitle(metadata["titles"]) ?? "";

  return {
    dedupKey: dedupKey({ doi, title }),
    title,
    doi,
    authors: creatorNames(metadata["creators"]),
    venue,
    year: asInteger(metadata["publicationYear"]),
    abstract: abstractText(metadata["descriptions"]),
    citationCount: asInteger(metadata["citationCount"]),
    bibtex,
    citable: bibtex !== null,
    provider: "datacite",
    endpoint: recordUrl,
  };
}
