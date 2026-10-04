---
title: "Uktub-scholar — paper registry and supporting evidence"
created_at: "2026-10-04"
resume_focus: "Decide the llama.cpp/embedding runtime packaging; review section chunking and passage search"
---
# Handoff

Owner direction: minimal CLI-first scholarly package; Pi first, other adapters later. No cloud-product
cutover. Everything is committed and pushed to `main` (owner directive: push directly to `main`); nothing is deployed.

Read `AGENTS.md` for rules, `README.md` for shipped behavior, `docs/DECISIONS.md` (2026-10-04 entry) for
the measured choices, `docs/BACKLOG.md` for verified limits. The plan is
`docs/plans/2026-10-04-0746-feat-paper-registry-evidence-plan.md`.

## What exists

Five Pi tools (`search_papers`, `paper_registry`, `compile_document`, `verify_claim`, `search_passages`) and a CLI whose
`register`, `attach`, `verify` and `search` call the same tool functions. Registry schema v5 (v1–v4 migrate).
Chunks are **section chunks** capped at 512 tokens (default); `search_passages` is hybrid keyword + semantic
when `UKTUB_EMBED_URL` names an embedding server, keyword-only otherwise.
`paper_registry` registers, removes, reads (projected, paged), attaches a local source, and syncs the
bibliography. `verify_claim` checks one claim over all or selected papers: it prepares sources, retrieves,
judges, localizes, and returns only supporting passages with `doi@revision#start-end` pointers plus four
separate coverage reports. Retired: `register_papers`, `list_papers`, `verify_claims`, `trace`, the two-sided
verdict helpers.

## Evidence exercised on this checkout (2026-10-04)

Method: behavior-first TDD. Each unit's tests were written and run red against stubs or old code, then
green (red observations are in the session record; the migration spec first showed the old code flipping a
foreign WAL database to journal mode DELETE before refusing it).

- `pnpm exec tsc --noEmit` clean; `node --test "tests/*.spec.ts"`: 432 tests, 430 passed, 0 failed, 2
  env-gated runtime tests skipped (Julia worker). All offline.
- **Real CLI** (disposable project, live free-tier DataCite/OpenAlex metadata, local PDFs from the owner's
  library): `init`; `register arxiv:2411.09996 arxiv:2504.14100 …` (alias collapsed, `banana` refused);
  `attach` of the right PDFs; `attach` of the wrong PDF refused `identity_mismatch` with the existing ready
  source kept; path escape refused; `verify` against the real local Eos 0.8B engine behind the `llama-cpp`
  path: 3 supporting passages with exact pointers; a repeat took 0.19 s with 0 new judgments (cache by
  served-model identity); a 12-judgment budget gave an interrupted page with a continuation and a
  completing second page.
- **Real Pi host** (Pi 1.0.0, Vertex `google-vertex/gemini-3.5-flash-lite`, `GOOGLE_CLOUD_LOCATION=global`,
  env-only): a 7-step `paper_registry` session (register, projected reads, subset read, attach, source
  read, remove, sync) — every tool result was actionable text with identities and requested fields and no
  source text; `verify_claim` through Pi against the same Eos endpoint returned the same pointer as the
  CLI.
- **Live acquisition** (free, no key): a J-STAGE `pdf_url` was downloaded through the SSRF-safe path,
  parsed (7 pages) and identity-checked; a JBC download was refused by the publisher; a gold-OA paper and an
  arXiv preprint had landing pages only (`no_open_copy`).
- **Real-corpus extraction**: all 14 owner PDFs extract in 21–239 ms.
- **Locator retrieval, end-to-end evidence, independent review**: `docs/benchmarks/evidence-retrieval-*`,
  `evidence-quality-end-to-end-*`, `evidence-review-*`. Eos 0.8B, bar 0.99, papers split by source.
  Held-out: support recall 64.9 % (8,192-token windows) / 78.4 % (2,048), gold-hit precision ≈ 88 %,
  14–15 fresh judgments per claim (≈ 9 with a locator at 2,048), own-paper false supports 1/30 and 2/30.
  Blind LLM review of 94 returned excerpts: gold-hit 45/45 support; other same-paper support 26 support,
  18 partial, 0 unsupported; 4 of 5 supports returned for fabricated claims were not supporting.
- **Decision 2.0** (Kai 0.6B, Eos 0.8B) on all 135 claims, pinned revisions:
  `docs/benchmarks/decision2-evaluation-status-2026-10-04.md`. Neither is adopted.
- **Independent code review** (fresh read-only agent) found 14 issues; the reproducible ones are fixed with
  regression tests (see DECISIONS); the low ones are accepted in BACKLOG.
- **Bugs the live smokes found that the offline suite missed** (all fixed, with tests): title-word identity
  admitted a related paper; an identifier in a reference list attested identity; chunk ids collided when one
  document backs two papers; the experiment runner crashed on a schema change made mid-run.

## Not exercised — do not assume

- The OpenAlex **Content API tier and the TEI path** live (needs `OPENALEX_API_KEY`, ~$0.01 per download).
- The default **OpenRouter Mercury** engine (no key; no quota spent). All real-engine evidence is Eos.
- The Pi **TUI registry widget**, the Docker sandbox image, and `search_passages` **inside a live Pi session** (the CLI
  smoke and the unit tests exercise the same tool function; Pi registration is covered by the compatibility test only).
- The vector leg on a **corpus beyond 14 papers**, other embedding models, and weighted/reranked fusion.
- A human review of returned excerpts (the review above is an LLM).
- Other prompt wordings, CPU/ROCm, and Eos's optimized kernels (the runs used the PyTorch fallback).
- Cross-platform behavior (Linux only).

## Owner decisions taken (2026-10-04)

- **Default engine is local Eos** (in-package resident worker; needs your Python env — README). Mercury remains
  selectable and is still the best measured engine.
- **Default chunking** was a 1,024-token fixed window (recall 84 % vs 52 % at 8,192); superseded the same day by
  section chunks capped at 512 tokens (see the second-session section; owner delegated the choice to measurement).
- **Full-text download for OA papers is deferred**; the local `test_papers` library plus `attach_source` is the
  working path.
- **Git: commit and push directly to `main`** (documented in AGENTS.md).

## Section chunking and passage search (2026-10-04, second session)

Method as before (test first, red then green, mutation checks on the splitter, real-corpus verification).
- Suite: 528+ tests, all offline; `tsc` clean. Splitter: 13 tests including a 3,000-document property run.
- Real evidence: 50 claims in two disjoint samples with Eos — pooled support recall 90 % (section 512) vs 80 %
  (fixed 1,024, the previous default); 6 gains / 1 loss, not conclusive, not worse
  ([report](benchmarks/evidence-chunking-sections-2026-10-04.md)). Default changed to section/512.
- Passage search measured on 74 claims × 3 query styles ([report](benchmarks/rag-search-section-512-2026-10-04.md));
  live CLI smoke on two real PDFs: keyword, hybrid (EmbeddingGemma on `llama-server`, 2.5 s first call, 0.19 s
  cached) and server-down fallback all behaved as specified.
- Findings that would have bitten silently: the owner-named EmbeddingGemma GGUF lacks the dense modules
  (cosine ≈ 0.01 vs the reference); `llama-server` needs `-b/-ub` ≥ the chunk size.

## Managed embedding runtime and independent review (2026-10-04, third pass)

- Owner decisions taken: a pinned `llama-server` fetched on first use and supervised (not bundled, not in-process);
  the cduk dense-modules GGUF, sha256-pinned.
- Built test-first: lock-file validation, verified streaming downloads with a size gate, safe extraction (`tar` strict
  mode plus validated same-directory symlinks), health-checked supervised child (log capture, retry on port races,
  killed on parent exit), resident per cache directory, `embed status` and `embed install --yes` (consent before any
  download), `embedderFromEnv` choosing explicit URL, then the installed runtime, then keyword only.
- **Live install found a defect the unit tests missed** (the real archive's symlink chains); fixed with a test that
  mirrors the real layout. Real run: install (17 MB + 334 MB, hashes verified), cold managed hybrid search in 14 s
  (server start plus embedding 77 passages), no server process left after the CLI exited.
- An independent review of the whole session's diff verified 12 findings (one high: section labels bypassed output
  containment); all are fixed with regression tests — listed in [DECISIONS](DECISIONS.md). The reviewer's own fuzzers
  (200k cases each) pass on the final splitter.

## Open for the owner

1. The managed runtime is pinned for **linux-x64 only** (BACKLOG item 2): tell me which other platforms matter.
2. The pinned embedding GGUF is a third-party conversion (hash-pinned, parity-gated). A first-party conversion needs
   your Hugging Face licence acceptance for Google's gated weights.
3. The "citation node-like system" is logged for the very end; please confirm the intended scope (BACKLOG).
4. The workspace-root `AGENTS.md` push rule was changed in the first session; confirm the wording suits you.
