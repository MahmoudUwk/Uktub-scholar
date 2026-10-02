#!/usr/bin/env bash
# Interactive test sandbox for uktub-oa: clean Pi environment, your ADC creds
# mounted read-only, the live package source mounted at /uktub-oa, and a
# persistent-but-isolated project directory holding the registry.
#
#   scripts/test-sandbox.sh            # Pi TUI against the project
#   scripts/test-sandbox.sh bash       # shell inside the sandbox instead
#   scripts/test-sandbox.sh --fresh    # wipe the isolated project volume first
set -euo pipefail
cd "$(dirname "$0")/.."

ADC="$HOME/.config/gcloud/application_default_credentials.json"
[ -f "$ADC" ] || { echo "No ADC credentials at $ADC — run: gcloud auth application-default login" >&2; exit 1; }

if [ "${1:-}" = "--fresh" ]; then
  docker volume rm uktub-oa-sandbox-project >/dev/null 2>&1 || true
  shift
fi

docker volume create uktub-oa-sandbox-project >/dev/null

if [ -z "${GOOGLE_CLOUD_PROJECT:-}" ]; then
  echo "Set GOOGLE_CLOUD_PROJECT (your GCP project for Vertex) before running the sandbox." >&2
  exit 1
fi

exec docker run --rm -it \
  -e GOOGLE_CLOUD_PROJECT \
  -e GOOGLE_APPLICATION_CREDENTIALS=/adc/adc.json \
  -e TERM="${TERM:-xterm-256color}" \
  -v "$(pwd)":/uktub-oa \
  -v "$ADC":/adc/adc.json:ro \
  -v uktub-oa-sandbox-project:/workspace/project \
  -v uktub-oa-sandbox-sessions:/root/.pi/agent/sessions \
  uktub-oa-sandbox "$@"
