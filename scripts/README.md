# scripts/

Flat on purpose: the engine workers are resolved by file name at run time, and the dated benchmark reports cite these paths. Four groups:

| Group | Files |
|---|---|
| **Engine workers** (resident Python processes the verifier engines start; one JSONL protocol) | `decision2_decide.py` (Eos/Kai on PyTorch), `decision2_onnx.py` (Eos on ONNX Runtime), `vela_decide.py`, `julia_decide.py`, `laya_decide.py` |
| **Build** | `build-assets.mjs` (copies the non-TypeScript files the code reads into `dist/`) |
| **Benchmarks** (protocol in [`benchmarks/`](../benchmarks/README.md), reports in [`docs/benchmarks/`](../docs/benchmarks/)) | `bench-claim-verify.ts` and its helpers `bench-metrics.ts`, `bench-report.ts`, `bench-bootstrap-auc.ts`, `bench-recompute-historical.ts`; `bench-rag.ts` (passage search); `bench-evidence.ts`, `bench-evidence-metrics.ts` (evidence quality); `decision2-client.ts`, `system-one-server.ts` (clients for the benchmark runner); `decision2_smoke.py` (checkpoint smoke); `embed-parity.py` with `embed-parity.sentences.json` (embedding parity gate) |
| **Cross-platform check** | `test-item9-cross-platform.ts` |

Packaging (`package.json` `files`): every `scripts/*.py`, every `scripts/*.json` and `build-assets.mjs` ship, nothing else here does.

[`live/`](live/) is the live test harness (probe, acceptance, simulation experiments, `pnpm sandbox`); see [docs/testing.md](../docs/testing.md).
