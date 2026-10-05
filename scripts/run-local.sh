#!/usr/bin/env bash
#
# Local tabletop launcher — runs against a local Ollama.
#
# Usage:
#   bash scripts/run-local.sh [model]
#
#   model  Ollama model id (default: gemma3:4b, a fast local model)
#
# Starts the app server on :8000 using the LOCAL Ollama as the DM source.
# Open http://localhost:8000, then in Settings pick:
#   Provider: OpenAI-compatible
#   Base URL: http://localhost:11434/v1
#   Model:    <the same model you passed here>
#   API key:  (leave blank)
#
# NOTE: context window. The DM system prompt is ~4-5k tokens. Ollama's
# default num_ctx is 4096, which TRUNCATES replies mid-sentence. This script
# sets NUM_CTX=8192 so the model has room for the prompt + the JSON turn.
set -euo pipefail

cd "$(dirname "$0")/.."

MODEL="${1:-gemma3:4b}"
export OLLAMA_URL="${OLLAMA_URL:-http://localhost:11434/v1}"
export OLLAMA_API_KEY="${OLLAMA_API_KEY:-}"
export MODEL
export NUM_CTX="${NUM_CTX:-16384}"
export PORT="${PORT:-8000}"

echo "== Executive Tabletop D20 — LOCAL (Ollama) =="
echo "  DM model : $MODEL"
echo "  Ollama   : $OLLAMA_URL"
echo "  num_ctx  : $NUM_CTX"
echo "  App      : http://localhost:$PORT"
echo ""

if ! curl -sf http://localhost:11434/api/version >/dev/null 2>&1; then
  echo "WARNING: Ollama does not look reachable at :11434." >&2
  echo "         Start it with:  ollama serve" >&2
fi

node server/serve.js "$PORT"
