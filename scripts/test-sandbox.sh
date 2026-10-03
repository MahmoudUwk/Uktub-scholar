#!/usr/bin/env bash
# Interactive test sandbox for uktub-scholar: clean Pi environment, your ADC creds
# mounted read-only, the live package source mounted at /uktub-scholar, and a
# persistent-but-isolated project directory holding the registry.
#
#   scripts/test-sandbox.sh            # Pi TUI against the project
#   scripts/test-sandbox.sh bash       # shell inside the sandbox instead
#   scripts/test-sandbox.sh --fresh    # wipe the isolated project volume first
set -euo pipefail
cd "$(dirname "$0")/.."

# Sandbox data (registry, references.bib, session transcripts) persists on the
# HOST, one level above the repo — inspect files directly; nothing is hidden in
# Docker volumes. `--fresh` wipes these two directories.
DATA_DIR="$(cd .. && pwd)/uktub-sandbox"

ADC="$HOME/.config/gcloud/application_default_credentials.json"
[ -f "$ADC" ] || { echo "No ADC credentials at $ADC — run: gcloud auth application-default login" >&2; exit 1; }

if [ "${1:-}" = "--fresh" ]; then
  rm -rf "$DATA_DIR/project" "$DATA_DIR/sessions"
  shift
fi

mkdir -p "$DATA_DIR/project" "$DATA_DIR/sessions"

# Project: env wins, else the gcloud CLI's configured project (no hardcoding).
if [ -z "${GOOGLE_CLOUD_PROJECT:-}" ] && command -v gcloud >/dev/null 2>&1; then
  GOOGLE_CLOUD_PROJECT="$(gcloud config get-value project 2>/dev/null)"
fi
if [ -z "${GOOGLE_CLOUD_PROJECT:-}" ]; then
  echo "Set GOOGLE_CLOUD_PROJECT (your GCP project for Vertex), or configure 'gcloud config set project'." >&2
  exit 1
fi

exec docker run --rm -it \
  -e GOOGLE_CLOUD_PROJECT \
  -e GOOGLE_APPLICATION_CREDENTIALS=/adc/adc.json \
  -e TERM="${TERM:-xterm-256color}" \
  -v "$(pwd)":/uktub-scholar \
  -v "$ADC":/adc/adc.json:ro \
  -v "$DATA_DIR/project":/workspace/project \
  -v "$DATA_DIR/sessions":/root/.pi/agent/sessions \
  uktub-scholar-sandbox "$@"