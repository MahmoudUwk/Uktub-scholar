# RF–LLM literature review

Scenario version: 1. Frozen: change it only by adding a new version (a new file), so iterations stay comparable.

## Prompt

Conduct a comprehensive literature review on **multimodal wireless foundation models connecting raw multi-antenna IQ signals to small language models (1–4B)**.

Evaluate existing architectures (e.g., IQFM, WirelessJEPA, RadioLLM) focusing on self-supervised complex IQ representation learning, fixed-token sequence compression, causal streaming inference, and edge quantization.

Identify key research gaps across synthetic-to-real transfer, grounded signal reasoning, and tool use, and provide an evidence-based novelty assessment for developing an end-to-end, streaming-capable RF-language system.

## Success

The user is satisfied when ALL of these hold (judge only from what the assistant says and what the project folder shows):

- The named architectures (IQFM, WirelessJEPA, RadioLLM) are each either evaluated from real papers the assistant found, or honestly reported as not found / not verifiable, with what was searched.
- The four focus areas (self-supervised complex IQ representation learning, fixed-token sequence compression, causal streaming inference, edge quantization) are each addressed with evidence from specific papers.
- The research gaps (synthetic-to-real transfer, grounded signal reasoning, tool use) are stated, each tied to evidence, and the novelty assessment says what is and is not novel, with the evidence behind it.
- Every claim attributed to a paper can be traced to that paper (a citation in a written document, and where the assistant quotes, an exact source pointer). Nothing is invented.
- A written review document exists in the project folder, cites only papers that were really found, and compiles.
- The assistant is honest about anything it could not do or check (provider failures, papers without usable full text, unchecked passages).
