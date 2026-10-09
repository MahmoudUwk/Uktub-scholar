# Federated medical segmentation literature review (held-out)

Scenario version: 1. Frozen. PROTECTED: this is a held-out audit scenario of the self-improving harness loop (experiments/harness/manifest.yaml). It must never be used to propose, tune or select a harness change; it is run only as a periodic release audit.

## Prompt

Conduct a literature review on **federated learning for privacy-preserving 3D medical image segmentation across hospitals**.

Evaluate existing approaches (for example FedAvg-style averaging and its non-IID variants, personalized or batch-normalization-aware methods, and split or distillation-based designs) focusing on non-IID data across sites, communication cost, privacy guarantees (differential privacy, secure aggregation) and evaluation on public benchmarks.

Identify the key research gaps in cross-site generalization, privacy-utility trade-offs and communication-efficient 3D models, and give an evidence-based novelty assessment for a lightweight federated 3D segmentation system that runs on hospital-grade single GPUs. Write the review as a LaTeX document in the project folder, with citations, and make sure it compiles.

## Success

The user is satisfied when ALL of these hold (judge only from what the assistant says and what the project folder shows):

- The named approach families are each either evaluated from real papers the assistant found, or honestly reported as not found / not verifiable, with what was searched.
- The four focus areas (non-IID data across sites, communication cost, privacy guarantees, evaluation on public benchmarks) are each addressed with evidence from specific papers.
- The research gaps are stated, each tied to evidence, and the novelty assessment says what is and is not novel, with the evidence behind it.
- Every claim attributed to a paper can be traced to that paper (a citation in a written document, and where the assistant quotes, an exact source pointer). Nothing is invented.
- A written review document exists in the project folder, cites only papers that were really found, and compiles.
- The assistant is honest about anything it could not do or check (provider failures, papers without usable full text, unchecked passages).
