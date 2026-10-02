# Test sandbox for the uktub-scholar package — a clean, disposable Pi environment.
# NOT a product deployment artifact; dev-only tooling.
#
# Build:  docker build -t uktub-scholar-sandbox -f docker/test-sandbox.Dockerfile .
# Run:    scripts/test-sandbox.sh   (mounts the repo + your ADC credentials)
FROM node:26-slim

RUN apt-get update \
 && apt-get install -y --no-install-recommends git ca-certificates \
 && rm -rf /var/lib/apt/lists/* \
 && npm install -g @earendil-works/pi-coding-agent

# The package under test is mounted at /uktub-scholar (live source, not baked).
ENV GOOGLE_CLOUD_LOCATION=global
WORKDIR /workspace/project

COPY docker/sandbox-entrypoint.sh /usr/local/bin/uktub-sandbox-entrypoint
ENTRYPOINT ["uktub-sandbox-entrypoint"]
CMD ["pi", "--no-builtin-tools", "--provider", "google-vertex", "--model", "gemini-3.5-flash-lite"]
