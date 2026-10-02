# NOTICE — per-file provenance

This package is licensed under AGPL-3.0-only. Third-party provenance is recorded per file or directory below.

## Project-internal extraction (same author, UktubAI workspace)

- `src/core/registry.ts`, `src/core/citekey.ts`, `src/core/bibrender.ts` — ported from the
  UktubAI workspace (`UktubAI_Agentic/deploy/sandbox-image/pi-registry.js` and related sandbox
  modules, same author and licence origin). Behaviors and BibTeX normalizers are ported; the
  schema is trimmed to this package's v0 contract.
- `src/core/providers/*`, `src/core/scholarly.ts` — ported from
  `UktubAI_Agentic/apps/control-api/src/tools/providers*` and `scholarly.ts` (same author).
- `src/core/doi.ts` — DOI normalization inlined from `UktubAI_Agentic/packages/shared/src/doi.ts`
  (same author).

## Feynman (MIT, Copyright (c) 2026 Companion, Inc.)

- Methods adopted, not code: incident-derived payload caps (search default 5 / max 20),
  endpoint provenance on search candidates, DOI-shaped-query hint, two-source title
  cross-check at registration. Source: https://github.com/Companion-Inc/feynman
  (commit e17f5fd0ea57775def66ebd2b16b40b39d3dc867 inspected read-only).
- No Feynman source files are copied into this package in v0. If a future version copies
  Feynman code, list each file here with its upstream path and commit.

## OpenScience (Apache-2.0, Synthetic Sciences)

- Design reference only in v0 (RRF merge shape, per-host HTTP-layer patterns). No
  Apache-2.0 code is included in v0; `NOTICE` obligations would attach to any future copied
  file, which must be listed here. Source: https://github.com/synthetic-sciences/openscience
  (commit 10e03a984313cae78424cf798e316e81ad4433fc inspected read-only).
