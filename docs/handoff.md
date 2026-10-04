---
title: "Uktub-scholar — reviewer handoff"
created_at: "2026-10-04"
audience: "an independent reviewer agent (fresh context)"
mission: "Verify everything the package claims, with real, non-trivial tests on real papers; fix what breaks, test first"
---
# Handoff — independent verification

You are the reviewer. The previous agent built and tested this package, found problems itself and via one earlier
reviewer, and reports it as working. **Do not trust that.** Your job is to try to prove it wrong with real data, and to
leave the repository more correct than you found it.

Read first, in this order: `AGENTS.md` (rules — they bind you), `README.md` (what is claimed), `docs/DECISIONS.md` (the
2026-10-04 entries: what was measured and decided), `docs/BACKLOG.md` (what is known to be open), then this file.

## What the package is

A local-first scholarly toolkit for coding agents (Pi first, CLI included): find papers, keep a registry and bibliography,
prepare full-text sources, **search the registered papers' passages**, and **verify one claim at a time** with exact
`doi@revision#start-end` pointers. Five Pi tools: `search_papers`, `paper_registry`, `compile_document`, `verify_claim`,
`search_passages`; the CLI mirrors `register`, `attach`, `verify`, `search`, plus `embed status|install`.
Core flow: registry (SQLite, schema v5) → source (PDF via `unpdf` / TEI) → section marks → section chunks (≤ 512 tokens) →
FTS5 index + optional vectors → search / claim verification (decision engine, default local Decision 2.0 Eos) → contained
output (excerpt ≤ 1,500 chars, < 50 % of a source, ≤ 25 % of a source per call, pointer always kept).

## State at hand-off (git `main`, own repo at this directory; everything committed and pushed)

- `pnpm exec tsc --noEmit` clean; `node --test "tests/*.spec.ts"`: 593 tests, 591 pass, 2 skipped (Julia engine, env-gated).
  Tests are offline by design — they prove contracts, **not** that the real world behaves. That is your job.
- Shipped this week: section-aware splitter + PDF heading detector; schema v4/v5 migrations; `search_passages` (hybrid
  FTS5 + vector, RRF k = 60); embedder client; **managed llama.cpp runtime** pinned for six platforms; default chunking
  `section` / 512 tokens (measured, see DECISIONS); two independent reviews already fixed (12 + 14 findings).
- Platforms: the managed runtime is pinned for linux/darwin/win32 × x64/arm64 (`src/core/embed/models.lock.json`, llama.cpp
  `b11398`). **Only linux-x64 has run the server.** The other five were downloaded, digest-verified and extracted by the
  real code path only.

## Environment (this machine; verify, don't assume)

| Need | Where / how |
|---|---|
| Real papers | `../test_papers/{RF,smarthome}/*.pdf` (14 PDFs; `Papaers_overview.pdf` is the owner's notes, not a paper) |
| Claims dataset | `benchmarks/datasets/claim-verification-v1/claims.json` (135 claims, 74 TRUE with gold quotes), `rag-queries.json` (independent paraphrases/questions for the 74) |
| Eos engine (local GPU, RTX 4060 8 GB) | `UKTUB_EOS_PYTHON=$HOME/.cache/uktub-bench/decision2/venv/bin/python`, `UKTUB_EOS_MODEL=$HOME/.cache/uktub-bench/decision2/models/eos` |
| Hosted engine / Pi model | Vertex `google-vertex/gemini-3.5-flash-lite`, `GOOGLE_CLOUD_LOCATION=global`, owner-minted ADC (verify with a token print before spending); Pi 1.0.0 |
| OpenAlex | `OPENALEX_API_KEY` is in `../UktubAI_Agentic/.env` — **never print it**; the Content API costs ≈ $0.01 per download: cap yourself at ≈ $0.10 and say what you spent |
| Embedding reference | `google/embeddinggemma-300m` is gated (an HF token is in `~/.cache/huggingface`); `scripts/embed-parity.py` needs `sentence-transformers` — recipe in its header |
| Embedding GGUFs in the HF cache | the owner-named `ggml-org/embeddinggemma-300m-qat-q8_0-GGUF` and the pinned `cduk/...-with-dense-modules` file |
| llama.cpp | the managed runtime installs into `UKTUB_CACHE_DIR` (use a fresh temp dir for clean-install tests) |

Rules that bind you: all work on `main`; push directly (owner works alone); **stage explicit paths only**, never
`.mcp.json` or `opencode.json`; no deploy or production mutation; do not use `pkill -f <pattern>` (it kills your own shell —
kill by PID); do not edit `src/` or `schema.sql` while a benchmark that starts fresh processes is running; fix bugs **test
first** (red, then green) and keep the suite green; record what you did in a dated report (below).

## Mission — verify each of these on real data (not mocks)

For every item: run it, record the exact command and the observed output, and say PASS / FAIL / NOT RUN with the reason.
"Non-trivial" means real PDFs, real network, real engines, adversarial inputs — not a fixture a test file generated.

1. **Baseline.** Typecheck and the offline suite on a clean checkout; confirm the numbers above.
2. **Real paper search.** Exercise `search_papers` for real (OpenAlex + Crossref + Semantic Scholar; keys optional) with
   at least 10 varied queries (a DOI-shaped one, an arXiv id, a misspelling, a non-English query, a very broad one, a
   nonsense one). Check merging/ranking sanity, provider-failure degradation (block one provider), result limits.
   Through a **real Pi session** if you can drive one (`pi` 1.0.0, text mode, the Vertex model above); otherwise call the
   tool function directly and say so.
3. **Registration and sources, real.** In a disposable project (`init`), register real DOIs and arXiv ids live (DataCite
   resolves arXiv DOIs), refuse bad ones, attach the 14 PDFs, attach a wrong PDF (must be refused `identity_mismatch`, the
   old source kept), path escape (must be refused). Try OA acquisition without a key (expect mostly `no_open_copy`) and, within
   the budget, one with the key (Content API TEI path has **never been exercised live** — do it; check the section marks it
   yields and that a TEI source chunks and verifies like a PDF).
4. **Extraction and structure on all 14 real PDFs.** For each: extraction time, chunk tiling (every character in exactly one
   chunk or in a dropped < 20-char chunk, offsets slice back exactly), no chunk above the cap, heading detection vs the
   paper's real outline (read the PDFs; report misses and false positives per paper — the known residue is ≈ 7 false
   positives in ≈ 300; find what else is wrong), no section label above 200 characters. Try hostile PDFs: encrypted, huge,
   scanned (must refuse `no_text_layer`), two-column, mathematics-heavy, a PDF whose text layer is garbage.
5. **Passage search (RAG), real.**
   - Keyword path: 30 real queries over the corpus; do the top results make sense to a human reader? Verify every returned
     pointer resolves to exactly the excerpt shown.
   - Hybrid path with **your own server** (`UKTUB_EMBED_URL`) and with the **managed runtime**: clean cache → `embed status`
     → `embed install` without `--yes` (must download nothing) → with `--yes` → search. Then break it: kill the server mid-session
     (it must restart), kill the parent (child must die), occupy ports, go offline after install (search must still work), corrupt
     a cached file (install must repair it), delete the cache, interrupt an install, run two searches concurrently, a cold index larger
     than 256 passages (partial-index message, then completion).
   - Re-run the retrieval measurement: `node scripts/bench-rag.ts --embed-url <url> --queries benchmarks/datasets/claim-verification-v1/rag-queries.json --query-fields claim,paraphrase,question --out <dir>`
     and compare with `docs/benchmarks/rag-search-section-512-2026-10-04.md` (numbers should reproduce within noise).
   - Containment: try to reassemble a paper by many searches; report how much text leaves in N calls (the guarantee is per
     call — say honestly what a determined caller can do).
6. **The ggml-org embedding file (owner asked you to address this).** The owner says
   `https://huggingface.co/ggml-org/embeddinggemma-300m-qat-q8_0-GGUF` needs no acceptance. **Confirmed by the previous
   agent** on 2026-10-04 (anonymous download answers HTTP 200; `gated: false`). The open problem is not access: the file has **no
   dense-module tensors** (`token_embd.weight`, `output_norm.weight` and the blocks only), and its vectors have mean cosine
   ≈ 0.013 with the reference model (`scripts/embed-parity.py` prints FAIL; the pinned cduk file prints PASS at ≈ 0.990).
   Your tasks: (a) re-confirm both facts yourself; (b) find out whether an **ungated first-party** route exists that passes the
   gate — e.g. other `ggml-org` EmbeddingGemma files, a newer llama.cpp that loads the dense layers separately, a
   `--sentence-transformers-dense-modules` conversion (needs Google's gated weights; the HF token on this machine can read them),
   or a different pooling/normalisation setting; (c) run every candidate through the parity gate and a real retrieval
   measurement; (d) if one passes, propose the pin change (new `models.lock.json` entry with sha256 + size, parity output) and make it
   test-first; if none does, document why in DECISIONS. Do not widen what the package downloads without a passing gate.
7. **Claim verification, real engine, real claims.** With Eos (and, if budget allows, Vertex or OpenRouter): run `verify`
   over a stratified sample of the dataset (≥ 40 TRUE and ≥ 30 FALSE claims, own-paper and all-papers scope, with and without
   `--query`). Check: recall/precision in the same ballpark as `docs/benchmarks/evidence-chunking-sections-2026-10-04.md`;
   every pointer resolves; excerpts ≤ 1,500 chars and withheld when the rules say; repeat run costs 0 judgments (cache); a
   changed source makes old pointers `stale`; budget → continuation → completion; killing the engine mid-run keeps completed
   work. Read 30 returned excerpts yourself (a human-grade check — the earlier review was an LLM).
8. **Resilience and security.** SSRF/redirect/size/credential-scoping behaviour of the downloader against hostile servers
   you stand up locally; FTS5 operator injection; SQL injection through handles; oversize and malformed inputs to every tool;
   concurrent processes writing one registry; a corrupted or future-version registry (must be refused, untouched);
   migration from a v3 and v4 database that holds real data.
9. **Cross-platform honesty.** On Linux you cannot run the macOS/Windows servers. Do verify what you can: the lock digests
   against GitHub's published digests, extraction of each archive, path handling in the code for `win32` (backslashes,
   `.exe`, drive letters, `child.kill` semantics). If a Mac, a Windows host or an arm64 box is reachable, run `embed install
   --yes`, a search and `scripts/embed-parity.py` there. List exactly what remains unverified.
10. **Docs vs reality.** Every behavioural claim in `README.md` and the 2026-10-04 `DECISIONS.md` entries: spot-check at
    least 25 of them against actual behavior; fix the doc or the code.

## Where the previous agent expects weakness (attack here first)

- PDF heading detection on layouts not in the 14 papers; TEI path (never run live).
- The 25 %-per-call release budget is per call; many calls can export a lot. Is that acceptable? Quantify.
- Exhaustive verification cost at 512 tokens (≈ 1.7× the judgments of 1,024) on a large corpus.
- Managed runtime on non-Linux systems; zip extraction; child cleanup on SIGKILL of the parent (known gap).
- Evidence from only 50 claims for the chunking default (not conclusive); the embedding gate uses only 20 sentences.
- The claim "no support found" must never read as "false": check every output string.

## Deliverable

Write `docs/review-<date>.md`: a table of the ten items (PASS/FAIL/NOT RUN, command, evidence), every defect found with its
reproduction and the commit that fixed it (test first), measurements you re-ran next to the recorded ones, and what is still
unverified. Update `docs/BACKLOG.md` for anything you defer. Commit and push by explicit path. Do not edit this file except to
mark items done.
