# Test sandbox for the uktub-scholar package — a clean, disposable Pi environment.
# NOT a product deployment artifact; dev-only tooling.
#
# Build:  docker build -t uktub-scholar-sandbox -f docker/test-sandbox.Dockerfile .
# Run:    scripts/test-sandbox.sh   (mounts the repo + your ADC credentials)
FROM node:26-slim

# Tectonic pinned to the tested floor (0.15.0) so sandbox users install nothing;
# the musl static binary runs on bookworm without extra dependencies.
ARG TECTONIC_VERSION=0.15.0
ADD --checksum=sha256:dfb82876f2986862996e564fa507a9e576e0c1e3bee63c2c1bd677c2543e6407 \
    https://github.com/tectonic-typesetting/tectonic/releases/download/tectonic%40${TECTONIC_VERSION}/tectonic-${TECTONIC_VERSION}-x86_64-unknown-linux-musl.tar.gz \
    /tmp/tectonic.tar.gz
RUN tar -xzf /tmp/tectonic.tar.gz -C /usr/local/bin tectonic \
 && rm /tmp/tectonic.tar.gz \
 && tectonic --version

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
