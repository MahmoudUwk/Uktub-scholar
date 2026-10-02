#!/usr/bin/env bash
# Sandbox entrypoint: install the mounted package into Pi, init the project
# registry if missing, then hand over to the requested command (Pi TUI by default).
set -euo pipefail

pi install /uktub-oa >/dev/null

if [ ! -f /workspace/project/.registry/registry.db ]; then
  node /uktub-oa/src/cli/main.ts init
  echo "[sandbox] registry initialized in /workspace/project"
fi

echo "[sandbox] package installed; project: /workspace/project"
exec "${@:-bash}"
