# Eos on ONNX Runtime vs the torch worker — parity and cost (2026-10-05)

**Question:** can `Decision-2.0-Eos-0.8B` run without PyTorch, so the claim verifier is installable without a 6.7 GB
environment? **Answer:** yes with the 8-bit export; no with the 4-bit one. Shipped as the additional engine `eos-onnx`
(`scripts/decision2_onnx.py`, `uktub-scholar eos install`); the default engine is unchanged.

## Method

- Reference: the shipped torch worker (`scripts/decision2_decide.py`, GPU, bf16) over its stdin protocol. Candidate: the Hugging
  Face export `onnx-community/Decision-2.0-Eos-0.8B-ONNX` @ `6369be38417e` (Apache-2.0), variants `model_quantized` (8-bit) and
  `model_q4f16`, on onnxruntime 1.30.0 (CPU, 24 threads, and CUDA).
- Inputs: 450 (claim, passage) judgments from the 135 claims of `benchmarks/datasets/claim-verification-v1` against the
  owner's PDFs: per claim the evidence window, the highest-overlap non-evidence window, a random window (1,204 characters, snapped to
  sentence ends), and for 45 claims a 4,000-character window around the evidence. 91 judgments sit at or above the 0.99 bar.
  The windows come from an experiment chunker, not the package's stage-1 chunks; both runtimes saw identical inputs.
- A torch-free re-implementation of the prompt encoder reproduced the worker's token ids, option positions and answer position
  on 450 of 450 rows. The shipped worker was then re-run on the first 90 pairs through its real protocol: mean |delta| 0.0047, max 0.047
  (CPU) / 0.048 (CUDA), 0 flips at the bar, matching the table below.

## Results (torch GPU worker as reference, n = 450)

| | 8-bit `model_quantized` | 4-bit `model_q4f16` |
|---|---|---|
| mean / max abs score delta | 0.0050 / 0.086 | 0.027 / 0.51 |
| decision agreement at p ≥ 0.5 | 99.33 % (3 flips, all within 0.05 of 0.5) | 96.9 % (CPU) |
| **decision agreement at the 0.99 bar** | **100 % (0 flips)** | 98.89 % (5 flips, 4 downward) |
| bias, torch p ≥ 0.9 (n = 120) | +0.0001 mean, max 0.008 | −0.002 mean, max 0.09 |
| bias, mid range 0.5–0.9 (n = 38) | +0.0001 | −0.047 |
| latency per judgment, CPU | p50 771 ms, p95 2,106 ms | p50 645 ms |
| latency per judgment, CUDA | p50 49 ms, p95 115 ms | p50 47 ms |
| model on disk | 665 MB + graph | 420 MB + graph |

Fresh control against fp32 torch on CPU (first 60 rows only): torch GPU bf16 mean |delta| 0.0017; ONNX 8-bit 0.0047; ONNX 4-bit 0.0275.
So the 8-bit export tracks fp32 about as well as the bf16 GPU worker does, and the 4-bit drift is real quantization error.
The 4-bit export is refused by the worker.

## Cost

| | torch worker | `eos-onnx` |
|---|---|---|
| Python environment | 6.7 GB (torch + CUDA libraries) | 198 MB CPU / 459 MB GPU |
| model | 1.9 GB | 684 MB |
| cold install (measured, real) | — | 1 m 40 s, 882 MB total |
| GPU p50 per judgment | 58 ms (p95 146 ms) | 49 ms (p95 115 ms) |
| CPU p50 per judgment | not practical | about 0.8 s (120 judgments ≈ 107 s) |

The torch worker sends one row per forward pass; batching several passages made it slower per judgment (57 ms at B = 1, 93 ms at B = 16)
and moved scores by up to 0.035 through padding, so no batching is used on either side.

## Limits of this evidence

- One Linux machine with one RTX 4060 laptop GPU; macOS and Windows are untested.
- Contexts above 1,728 tokens were not exercised (median 393); the worker refuses, never truncates, above 16,384.
- The pairs are experiment windows, not the package's stage-1 chunks, and 91 are at or above the bar: the bar-level claim is
  100 % of 91, not a population estimate.
- A Node-native runtime (onnxruntime-node plus a JS tokenizer) is not tested; the worker is Python.
- Reference-side ground truth is the torch worker, not human labels; the end-to-end quality of either engine is in
  `evidence-quality-end-to-end-2026-10-04.md`.
