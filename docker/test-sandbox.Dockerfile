# Test sandbox for the uktub-scholar package — a clean, disposable Pi environment.
# NOT a product deployment artifact; dev-only tooling.
#
# Build:  docker build -t uktub-scholar-sandbox -f docker/test-sandbox.Dockerfile .
# Run:    pnpm sandbox (interactive Pi) or the live tiers; scripts/live/sandbox.ts defines the container boundary and
#         sets its own entrypoint, so this image carries only Pi, Tectonic and git.
FROM node:26-slim

# Tectonic pinned to the tested floor (0.15.0) so sandbox users install nothing;
# the musl static binary runs on bookworm without extra dependencies.
ARG TECTONIC_VERSION=0.15.0
# Pi pinned to the version the live-acceptance evidence is recorded against.
ARG PI_VERSION=1.1.0
ADD --checksum=sha256:dfb82876f2986862996e564fa507a9e576e0c1e3bee63c2c1bd677c2543e6407 \
    https://github.com/tectonic-typesetting/tectonic/releases/download/tectonic%40${TECTONIC_VERSION}/tectonic-${TECTONIC_VERSION}-x86_64-unknown-linux-musl.tar.gz \
    /tmp/tectonic.tar.gz
RUN tar -xzf /tmp/tectonic.tar.gz -C /usr/local/bin tectonic \
 && rm /tmp/tectonic.tar.gz \
 && tectonic --version

RUN apt-get update \
 && apt-get install -y --no-install-recommends git ca-certificates libgomp1 \
 && rm -rf /var/lib/apt/lists/* \
 && npm install -g @earendil-works/pi-coding-agent@${PI_VERSION}

# The package under test is a staged consumer install mounted at run time; Vertex needs a location.
ENV GOOGLE_CLOUD_LOCATION=global
