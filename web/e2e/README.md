Phase 9c full-flow end-to-end tests for the browser MVP.

Scripts (all in this directory):

- `full-flow.mjs` — one first-time-researcher pass over the MVP (fresh
  profile): 1. silent guest -> create "FullFlow" -> main.tex opens ->
  template compiles with the Compile button; 2. assistant setup in the
  real UI (OpenRouter model key -> key test -> research keys -> verify
  engine); 3. Prompt A (papers search, register 3 by DOI, acquire);
  4. Prompt B (two write_section calls, save, input, agent compile,
  verify, resolve); 5. end state via the seam (reads only); 6. UI round
  trip: export modal (TeXlyre format) -> download -> delete from the
  Projects list (real delete UI) -> import modal with the downloaded zip
  -> open -> same registry, byte-identical bib, Compile button, same PDF
  text (helpers shared with `roundtrip-ui.mjs` via `ui-roundtrip.mjs`);
  7. Stop check; 8. network allowlist, console errors, model count.
- `ui-roundtrip.mjs` — the shared UI round-trip helpers (export modal ->
  download, list delete, import modal, fixed compile wait, seam reads
  plus the one labelled seam write: registry register).
- `roundtrip-ui.mjs` — model-free UI round trip on its own: create
  project -> seed 2 papers via the seam (labelled; needs research keys)
  -> cite through the editor -> Compile button -> export modal ->
  download (payload asserted inside the zip) -> UI delete -> import
  modal -> open -> same DOIs, byte-identical bib, same PDF text.
- `run-full-flow.mjs` / `run-roundtrip-ui.mjs` — launchers: read the
  needed keys from the repo `.env` into the child environment without
  echoing them.

How to run (from the repo root):

1. Build with seams: VITE_UKTUB_ACCEPTANCE_SEAMS=1 pnpm --dir web run build
2. Serve: pnpm --dir web exec vite preview --port 4318  (record the PID;
   kill that PID afterwards, never pkill -f)
3. Launch: node web/e2e/run-full-flow.mjs  (or run-roundtrip-ui.mjs)

Env variables (process.env only; never printed/logged/stored):

- full-flow: OPENROUTER_API_KEY, SEMANTIC_SCHOLAR_API_KEY, OPENALEX_API_KEY.
- roundtrip-ui: SEMANTIC_SCHOLAR_API_KEY, OPENALEX_API_KEY.
- FF_OUT (evidence dir; default the Phase 9c notes dir) and FF_MODEL (OpenRouter model id; default
  minimax/minimax-m3.1-flash:free, listed by pi-ai 1.4.0).
- FF_VERIFY_MODEL (Phase 9g; verification decision model selected through
  the new Verification-model UI control in step 2; default
  inception/mercury-decide:free, the core openrouter default; the paid
  inception/mercury-decide spends the key's USD budget). Recorded in the
  verdict as `verifyModel`; step 1 also asserts (model-free, no model
  call) that the control lists both mercury-decide variants.
- FF_MIN_USD (default 0.5, client policy): for a paid writer model or paid
  verification model (no `:free` suffix) the key's
  remaining USD limit must be at least this; the verdict records the key's usage/limit before and after.
- FF_MIN_FREE_REQUESTS (default 400, client policy: one 8b section used
  ~105 requests and the flow writes two sections plus
  search/acquire/verify). Screenshots avoid visible key values; the leak
  scan greps all JSON/text evidence for the values.

Quota preflight (full-flow only): before the first model step the script
GETs https://openrouter.ai/api/v1/key with the env key and records only
free_model_daily_requests {used, limit, remaining} in the verdict (never
the key or any other field); the same GET runs at the end. When
remaining < FF_MIN_FREE_REQUESTS, every model-dependent step including
the key test is skipped ("not run: free-model quota remaining N < M")
and only model-free steps run (1, 6 on whatever the project holds, 8).
The request log must then show zero openrouter.ai requests.
The free-request floor applies only when the writer (FF_MODEL) or the
verification model (FF_VERIFY_MODEL) ends in `:free` (Phase 9g); a paid
writer or paid verification model instead needs USD headroom
(remaining >= FF_MIN_USD).

Cost: with FF_MODEL=deepseek/deepseek-v4.1-flash-1017 and FF_VERIFY_MODEL=inception/mercury-decide (both paid)
one run cost US$0.04-0.08 on 2026-10-22 (1,800-4,200 OpenRouter requests, almost all verification decisions).
With :free models the spend is US$0.00, but verification alone exceeds the free tier's 1,000 requests/day. Free quota
is 1000 requests/day; on repeated 429s the script stops model steps, keeps
model-free steps, and records an honest verdict (never loops retries).

Evidence (all in the notes dir, default
/home/mahmoud/.cache/uktub-bench/hermes-web-phase9c-2026-10-22/):
ff-verdict.json (per step ok/failed + detail, openRouterQuotaFree
before/after, modelRequests), ff-transcript.json (every turn: messages,
every tool row with args summary/status/result head, gate messages),
ff-*.png screenshots, ff-requests.json + ff-console-errors.json
(redacted), ff-pdf-step*.txt, ff-main.pdf, ff-export.zip, rt-* (the
roundtrip-ui equivalents: rt-verdict.json, rt-pdf-before/after.txt,
rt-bib-after.bib, rt-export.zip, rt-*.png).
