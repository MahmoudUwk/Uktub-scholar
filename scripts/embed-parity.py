#!/usr/bin/env python3
"""
Parity gate for an embedding server: do its vectors reproduce the reference model's?

  python scripts/embed-parity.py http://127.0.0.1:8080 [--reference google/embeddinggemma-2]

Compares, on 20 sentences with the model's documented prompts, the server's /v1/embeddings output with sentence-transformers'
(`encode_document` / `encode_query`, normalised): per-sentence cosine, pairwise-similarity correlation, and top-1 retrieval
agreement. A GGUF without the sentence-transformers dense modules scores a mean cosine near 0.01 here while its pairwise
geometry still correlates ~0.97 — which is why the gate looks at the cosine, not at the geometry.

The reference model is gated on Hugging Face (accept the Gemma licence once; `hf auth login`). Needs numpy and
sentence-transformers (CPU torch is enough):  uv venv v && uv pip install --python v/bin/python sentence-transformers \
  --extra-index-url https://download.pytorch.org/whl/cpu --index-strategy unsafe-best-match

Pass bar used by this package (mean cosine, QAT Q8_0 against the full-precision reference): >= 0.98 and pairwise correlation >= 0.99.
Exit status 0 = pass, 1 = fail.
"""
import argparse, json, os, sys, urllib.request
import numpy as np

ap = argparse.ArgumentParser()
ap.add_argument("url")
ap.add_argument("--reference", default="google/embeddinggemma-2")
ap.add_argument("--model", default="x", help="model name sent in the request (llama-server ignores it)")
args = ap.parse_args()

sents = json.load(open(os.path.join(os.path.dirname(__file__), "embed-parity.sentences.json")))
from sentence_transformers import SentenceTransformer  # noqa: E402

ref = SentenceTransformer(args.reference, device="cpu")
ref_doc = ref.encode_document(sents, normalize_embeddings=True)
ref_q = ref.encode_query(sents, normalize_embeddings=True)
doc_prefix, query_prefix = ref.prompts["document"], ref.prompts["query"]


def served(texts):
    req = urllib.request.Request(args.url.rstrip("/") + "/v1/embeddings", data=json.dumps({"input": texts, "model": args.model}).encode(), headers={"Content-Type": "application/json"})
    data = json.load(urllib.request.urlopen(req, timeout=120))["data"]
    return np.array([d["embedding"] for d in sorted(data, key=lambda d: d["index"])])


srv_doc = served([doc_prefix + s for s in sents])
srv_q = served([query_prefix + s for s in sents])
cos = lambda a, b: np.sum(a * b, axis=1) / (np.linalg.norm(a, axis=1) * np.linalg.norm(b, axis=1))
cd, cq = cos(ref_doc, srv_doc), cos(ref_q, srv_q)
iu = np.triu_indices(len(sents), 1)
pearson = float(np.corrcoef((ref_doc @ ref_doc.T)[iu], (srv_doc @ srv_doc.T)[iu])[0, 1])
top = lambda Q, D: [int(np.argsort(-(Q[i] @ D.T) + np.eye(len(D))[i] * 9)[0]) for i in range(len(Q))]
agree = float(np.mean(np.array(top(ref_q, ref_doc)) == np.array(top(srv_q, srv_doc))))
print(f"document prompt: cosine min {cd.min():.4f} mean {cd.mean():.4f}")
print(f"query prompt:    cosine min {cq.min():.4f} mean {cq.mean():.4f}")
print(f"pairwise-similarity Pearson {pearson:.4f}   top-1 agreement {agree:.2f}")
ok = cd.mean() >= 0.98 and cq.mean() >= 0.98 and pearson >= 0.99
print("PASS" if ok else "FAIL")
sys.exit(0 if ok else 1)
