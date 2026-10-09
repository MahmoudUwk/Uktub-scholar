# Web client and the general layer: decision record (2026-10-08)

Status: owner-delegated design decision, not built. Owner direction, in their words: "spawn a system designed hermes agent and have it decide everything for us. We can keep it to general, test on pu and later build a static web UI on pi sdk for 100% clientside to help nontechnical researchers use it out of box. maybe focus on that." ("pu" read as Pi.) Method: three Hermes research runs (Pi in the browser, component feasibility, data access and keys), our own verification of their load-bearing claims against the shipped packages and live CORS requests, then one Hermes "decider" run given only verified facts. Related: [host-adapter research](2026-10-08-host-adapter-layer-research.md), [codemode research](2026-10-08-codemode-concept-research.md).

## Verdict

- **"Static web UI on the Pi SDK, 100% client-side" is coherent only as renamed:** a static-hosted, bring-your-own-key browser app on the **browser-capable part of the Pi SDK** (`pi-ai`, `pi-agent-core`), with an optional local sidecar for what a tab cannot do. It is not 100% client-side: queries go to scholarly APIs, excerpts go to the chosen model provider, model and WASM files come from a CDN.
- **One isomorphic core, thin per-runtime adapters.** Two concrete consumers exist (the Node MCP/Pi tools and the browser client), which satisfies "no abstraction without a second consumer". MCP stdio stays the base for coding agents.
- **Not on `pi-coding-agent`, `pi-web-ui` or `pi-codemode`:** the first is a Node/Bun process, the second is stale against Pi 1.x, the third has a Node-only host.

## Verified by us (2026-10-08)

| Fact | How |
|---|---|
| `@earendil-works/pi-ai` 1.1.0 has an official "Browser Usage" section (pass `apiKey` or a `CredentialStore`; Bedrock and OAuth login are Node-only; subpath imports for small bundles) | Read from the package README |
| `@earendil-works/pi-agent-core` 1.1.0: deps are `pi-ai` and `typebox` only; no `node:` imports in `dist` | Package manifest and grep |
| `@earendil-works/pi-web-ui` 0.75.3 (2026-05-27) depends on `pi-ai ^0.75.3` and imports `pi-agent-core` without declaring it | Package manifest and `dist` imports |
| `@earendil-works/pi-codemode` 1.1.0 is a standalone sandbox (only dep `quickjs-wasi`); its host uses `node:worker_threads`; protocol is message-based; no documented browser host | README, manifest, `dist/runtime/host.js` |
| CORS from an arbitrary https origin: OpenAI, Anthropic (with `anthropic-dangerous-direct-browser-access`), OpenRouter, Gemini API (`x-goog-api-key`) allow browser calls; Vertex AI preflight allows `authorization` (a browser would still need an OAuth token; no real call made) | `curl` preflights |
| Scholarly sources: OpenAlex API, Crossref (use `mailto=`; no User-Agent in browsers), Europe PMC, NCBI E-utilities, `arxiv.org/pdf/<id>` all return `access-control-allow-origin: *`; `content.openalex.org` returns it on a 401 (keyed success path untested, costs money); Semantic Scholar keyless GET returned 429 with no ACAO, preflight with `x-api-key` allowed; `export.arxiv.org` API returns **no** ACAO | `curl` GET and preflights |
| Browser bundle audit: bundling `scholarly.ts`, `tools/search.ts`, `sections.ts`, `bibrender.ts` for the browser fails on exactly five Node imports in four files: `providers/http.ts` (`randomInt`), `chunk.ts` and `doi.ts` (`createHash`), `tools/context.ts` (`fs`, `path`) | esbuild 0.25.10, `--platform=browser` |
| `src/core` today: 23 files / 2850 lines import nothing Node-only; 31 files / 6951 lines do (`node:sqlite` in 11, `fs` in 12, `crypto` in 11, `child_process` in 3) | import scan |

Hermes claims **refuted** by these checks (they appear in its raw runs, kept outside the repository, and must not be reused): OpenAI cannot be called from a browser; arXiv PDFs and NCBI E-utilities are blocked by CORS; Vertex AI is blocked by CORS (the preflight is open; the real blocker is that a browser cannot mint the OAuth access token without a registered OAuth client). Still **unverified**: sizes and support for sqlite-wasm, Transformers.js v4, EmbeddingGemma ONNX, WebGPU, Safari eviction, TeXlyre/BusyTeX status, OpenRouter PKCE details.

## Decisions (Hermes decider, reviewed)

| Area | Decision | Rejected | Our review |
|---|---|---|---|
| Naming | Static-hosted BYOK browser app plus optional local sidecar | "100% client-side" | Agree |
| General layer | One isomorphic core (injected `fetch`, provider clients, chunker, bib writer, bounded result shapes; no fs, sqlite, child process or keys); Node adapters stay thin; MCP stdio stays base | Full rewrite; duplicated web clients; abstract SDK for unknown hosts | Agree; extraction cost measured above is small for search, sections and bib; verify, embed and registry stay Node (`node:sqlite`) |
| Node-only forever | `node:sqlite` registry and folder layout, publisher PDF fetch with SSRF/DNS checks, tectonic, llama.cpp management, Eos worker, GROBID/TEI pipeline | Porting them | Agree |
| Agent loop | `pi-agent-core` with direct tool calls (pin `pi-ai` and `pi-agent-core`, isolate in an adapter) | `pi-coding-agent`, `pi-codemode` in the tab, custom loop, LangChain | Agree |
| UI | Own minimal UI | `pi-web-ui` (stale), full design system now | Agree; revisit if `pi-web-ui` ships a 1.x release |
| Model access | Bring-your-own key only; `pi-ai` `CredentialStore`; memory-only mode plus opt-in `localStorage`; no shipped keys, no proxy of ours; explicit warning and clear button | Our proxy, embedded demo key | Agree on custody. **Default provider is an owner question** (see below) |
| Search and storage | MiniSearch index persisted to OPFS with IndexedDB fallback, zip export first class; FTS5 stays authoritative in Node | sqlite-wasm now (needs COOP/COEP or the sahpool VFS) | Agree with a caveat: ranking will differ between runtimes, so results must carry the engine label and the shared section chunker must be the only chunk source |
| Embeddings | Off by default; opt-in EmbeddingGemma 300M with the download size shown | Always on; server embeddings | Agree |
| PDF ingest | Upload first; fetch second only for hosts measured as CORS-open; keyed Content API PDFs via sidecar | Fetch-first crawler; proxy | Agree; the measured CORS table above replaces Hermes' wrong claims |
| `verify_claim` in the browser | "Supporting passages found" finder only, no refutation verdict; Eos 0.8B stays in the sidecar | 700 MB ONNX in a tab; LLM true/false verdict | Agree |
| LaTeX | No browser compile in v1; export `.tex` and `.bib` as a zip; compile through the sidecar's tectonic | SwiftLaTeX (frozen at TeX Live 2020), BusyTeX in v1 | Agree |
| Codemode in the web client | No | `pi-codemode` in the tab | Agree; direct calls keep writes and citations explicit |
| Sidecar | Yes: the existing MCP package over streamable HTTP on `127.0.0.1` with a token; explicit "Connect local" button, no port scanning; features degrade with a stated reason | Electron, Tauri now, public tunnel | Agree; this also is the ChatGPT Secure-MCP-Tunnel route from the host-adapter research |

## Roadmap

1. **Slice 1, static scholar shell:** BYOK chat with `pi-ai` + `pi-agent-core`, OpenAlex search, PDF upload with `unpdf`, MiniSearch passages, `references.bib` export, OPFS persistence and zip. Acceptance (headless browser, real calls, no mocks): a live OpenAlex query returns results; a fixture PDF yields a known title string; a passage query returns a bounded excerpt under the documented limit; the production bundle contains no `node:` import and no key; the key never reaches the host model's view of logs.
2. **Slice 2, support finder and lazy embeddings:** keyword support ranker with document offsets, opt-in embedding download with size shown, the "no refutation verdict" label.
3. **Slice 3, sidecar delegate:** streamable-HTTP transport with a token on loopback; compile, GROBID, Eos check and keyed PDF fetch delegated; disabled states with reasons when absent.
4. **Slice 4, persistence hardening:** zip round trip, Safari eviction warning, input limits shown with their sources.
5. **Before slice 1 (core extraction):** the five Node imports above, test-first (`createHash` to a maintained cross-runtime hash, `randomInt` to a cross-runtime source, `ToolContext` split from `fs`/`path`).
6. **Explicitly not built:** a custom agent framework, a `pi-web-ui` fork, in-browser Eos or tectonic, our own LLM or CORS proxy, a hosted key vault, a GROBID WASM port, an `export.arxiv.org` proxy, automatic filesystem access.

## Risks (ranked, from the decider, kept)

Key theft by XSS or a shared machine (memory-only default, strict CSP, no third-party scripts; kill if a feature needs a CSP bypass); CORS drift on a host (per-host capability table, upload fallback, sidecar; never add our proxy); data loss through Safari eviction and OPFS fragility (zip export first class, no silent-persistence claims); WASM and model weight on mobile (lazy, off by default, consent above 50 MB); TeX parity (sidecar authoritative); Semantic Scholar 429 and Content API cost (OpenAlex first); Pi 1.x churn (pin, adapter, bundle check).

## Owner questions that evidence cannot settle

1. **Acceptance model for the web client.** Our rule requires live acceptance on `google-vertex/gemini-3.8-flash` with user-minted ADC, which a browser cannot use (no token minting without an OAuth client) and which excludes the Gemini Developer API. The web client needs its own acceptance model (for example a Gemini API key or OpenRouter, labelled as such). Our lean: a labelled separate acceptance, never relaxing the Pi/MCP rule.
2. **Default provider for non-technical researchers.** Hermes says OpenAI first; we lean to a sign-in flow (OpenRouter OAuth PKCE) so researchers never paste a key, with paste-a-key as the advanced path. PKCE details are not yet verified by us.
3. **Retrieval divergence.** Accept MiniSearch in the browser and FTS5 in Node (labelled), and set the corpus size that would trigger sqlite-wasm parity work.

## Provenance

Three Hermes research runs plus one decider run given only verified facts; the CORS table and package facts were measured by us and overrule the research runs where they differ. Raw model output (untrusted, partly refuted above) is kept outside the repository: `~/.cache/uktub-bench/hermes-raw-2026-10-08/web-client-raw.md`.
