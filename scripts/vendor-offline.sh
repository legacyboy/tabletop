#!/usr/bin/env bash
#
# Vendor the WebLLM runtime + a local Gemma model for a fully-offline,
# portable bundle of Executive Tabletop D20.
#
# Why: the app's "in-browser model" path normally pulls the WebLLM library
# (CDN) and the model weights (HuggingFace) at runtime. This script downloads
# all of it into ./vendor so the app can run with zero network access.
#
# Usage:
#   bash scripts/vendor-offline.sh [model_id]
#
#   model_id defaults to gemma3-1b-it-q4f16_1-MLC (~150 MB, the only Gemma 3
#   available in WebLLM v0.2.84). NOTE: the 4B Gemma (gemma-3-4b-it-q4f16_1-MLC)
#   is NOT available in WebLLM — only the 1B is. If you need a bigger model,
#   pick another from the WebLLM prebuilt set (e.g. Qwen3-4B-Instruct-2507).
#
# Output layout:
#   vendor/
#     webllm/            @mlc-ai/web-llm library (JS)
#     wasm/              the model's WebGPU WASM runtime
#     models/<model_id>/resolve/main/  weights + tokenizer + config
#
# NOTE: model files are stored under `resolve/main/` (not flat) because
# WebLLM's `cleanModelUrl()` appends "resolve/main/" to any model URL that
# isn't already a HuggingFace `.../resolve/.../` URL. The offline config
# points `model` at `/vendor/models/<model_id>/`, and WebLLM resolves the
# weights/config/tokenizer from `<model_id>/resolve/main/`. Mirroring HF's
# layout keeps WebLLM's URL construction working with no code hacks.
#
# After running, the app's WebLLM provider detects vendor/ and loads locally.
# NOTE: the in-browser model still requires a WebGPU-capable browser (Chrome/
# Edge). This script only vendors files; it does not test GPU execution.
set -euo pipefail

MODEL_ID="${1:-gemma3-1b-it-q4f16_1-MLC}"
WEBLLM_VERSION="0.2.84"
# WASM libs are versioned under web-llm-models/<v>/base/ in the binary repo.
WASM_BASENAME="gemma3-1b-it-q4f16_1_cs1k-webgpu.wasm"
HF="https://huggingface.co/mlc-ai/${MODEL_ID}/resolve/main"
WASM_URL="https://raw.githubusercontent.com/mlc-ai/binary-mlc-llm-libs/main/web-llm-models/v0_2_84/base/${WASM_BASENAME}"

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
VENDOR="$ROOT/vendor"
MODEL_DIR="$VENDOR/models/$MODEL_ID"
# See NOTE above: files live under resolve/main/ so WebLLM's cleanModelUrl()
# (which appends "resolve/main/") resolves to the real files.
MODEL_FILES_DIR="$MODEL_DIR/resolve/main"

echo "Vendoring WebLLM $WEBLLM_VERSION + $MODEL_ID into $VENDOR"
mkdir -p "$VENDOR/webllm" "$VENDOR/wasm" "$MODEL_FILES_DIR"

# 1. WebLLM library
# Fetched directly from a CDN (no npm required) so the script works on any
# machine without Node/npm installed.
echo "==> WebLLM library"
if [ ! -f "$VENDOR/webllm/index.js" ]; then
  curl -sL --fail "https://unpkg.com/@mlc-ai/web-llm@$WEBLLM_VERSION/lib/index.js" -o "$VENDOR/webllm/index.js"
  curl -sL --fail "https://unpkg.com/@mlc-ai/web-llm@$WEBLLM_VERSION/lib/index.js.map" -o "$VENDOR/webllm/index.js.map" 2>/dev/null || true
  echo "   downloaded webllm/index.js"
else
  echo "   already present"
fi

# 2. WASM runtime
echo "==> WASM runtime"
if [ ! -f "$VENDOR/wasm/$WASM_BASENAME" ]; then
  curl -sL --fail "$WASM_URL" -o "$VENDOR/wasm/$WASM_BASENAME"
  echo "   downloaded $WASM_BASENAME"
else
  echo "   already present"
fi

# 3. Model weights + config + tokenizer
echo "==> Model files"
for f in mlc-chat-config.json ndarray-cache.json tensor-cache.json tokenizer.json tokenizer.model tokenizer_config.json added_tokens.json; do
  if [ ! -f "$MODEL_FILES_DIR/$f" ]; then
    curl -sL --fail "$HF/$f" -o "$MODEL_FILES_DIR/$f" && echo "   $f" || echo "   (skip) $f"
  fi
done

# Weight shards (1B model has 15 shards: 0-14)
echo "==> Weight shards"
for i in $(seq 0 14); do
  f="params_shard_${i}.bin"
  if [ ! -f "$MODEL_FILES_DIR/$f" ]; then
    curl -sL --fail "$HF/$f" -o "$MODEL_FILES_DIR/$f" && echo "   $f" || { echo "   (stop at $f)"; break; }
  fi
done

# 4. Write the offline app config consumed by the WebLLM provider.
cat > "$VENDOR/offline-config.json" <<JSON
{
  "model_id": "$MODEL_ID",
  "library_url": "/vendor/webllm/index.js",
  "app_config": {
    "model_list": [
      {
        "model": "/vendor/models/$MODEL_ID/",
        "model_id": "$MODEL_ID",
        "model_lib": "/vendor/wasm/$WASM_BASENAME"
      }
    ]
  }
}
JSON
echo "==> Wrote vendor/offline-config.json"

echo ""
echo "Done. Total vendor size:"
du -sh "$VENDOR"
echo ""
echo "To use the offline bundle: open the app, go to DM/Keys, choose"
echo "'In-browser model (WebLLM)'. The app will detect vendor/ and load locally."
echo "Requires a WebGPU-capable browser (Chrome/Edge)."
