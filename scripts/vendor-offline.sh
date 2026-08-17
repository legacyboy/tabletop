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
#   model_id defaults to gemma-3-4b-it-q4f16_1-MLC (~560 MB, q4f16 4-bit).
#   Other options: gemma-3-1b-it-q4f16_1-MLC (~150 MB, weaker DM).
#
# Output layout:
#   vendor/
#     webllm/            @mlc-ai/web-llm library (JS)
#     wasm/              the model's WebGPU WASM runtime
#     models/<model_id>/  weights + tokenizer + config
#
# After running, the app's WebLLM provider detects vendor/ and loads locally.
# NOTE: the in-browser model still requires a WebGPU-capable browser (Chrome/
# Edge). This script only vendors files; it does not test GPU execution.
set -euo pipefail

MODEL_ID="${1:-gemma-3-4b-it-q4f16_1-MLC}"
WEBLLM_VERSION="0.2.84"
HF="https://huggingface.co/mlc-ai/${MODEL_ID}/resolve/main"
WASM_URL="https://raw.githubusercontent.com/mlc-ai/binary-mlc-llm-libs/main/web-llm-models/${MODEL_ID}-webgpu.wasm"

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
VENDOR="$ROOT/vendor"
MODEL_DIR="$VENDOR/models/$MODEL_ID"

echo "Vendoring WebLLM $WEBLLM_VERSION + $MODEL_ID into $VENDOR"
mkdir -p "$VENDOR/webllm" "$VENDOR/wasm" "$MODEL_DIR"

# 1. WebLLM library
echo "==> WebLLM library"
if [ ! -f "$VENDOR/webllm/index.js" ]; then
  TMP="$(mktemp -d)"
  (cd "$TMP" && npm pack "@mlc-ai/web-llm@$WEBLLM_VERSION" >/dev/null 2>&1 && tar xzf ./*.tgz)
  cp "$TMP/package/lib/index.js" "$VENDOR/webllm/index.js"
  cp "$TMP/package/lib/index.js.map" "$VENDOR/webllm/index.js.map" 2>/dev/null || true
  rm -rf "$TMP"
  echo "   copied webllm/index.js"
else
  echo "   already present"
fi

# 2. WASM runtime
echo "==> WASM runtime"
if [ ! -f "$VENDOR/wasm/${MODEL_ID}-webgpu.wasm" ]; then
  curl -sL --fail "$WASM_URL" -o "$VENDOR/wasm/${MODEL_ID}-webgpu.wasm"
  echo "   downloaded ${MODEL_ID}-webgpu.wasm"
else
  echo "   already present"
fi

# 3. Model weights + config + tokenizer
echo "==> Model files"
for f in mlc-chat-config.json ndarray-cache.json tensor-cache.json tokenizer.json tokenizer.model tokenizer_config.json added_tokens.json; do
  if [ ! -f "$MODEL_DIR/$f" ]; then
    curl -sL --fail "$HF/$f" -o "$MODEL_DIR/$f" && echo "   $f" || echo "   (skip) $f"
  fi
done

# Weight shards
echo "==> Weight shards"
for i in $(seq 0 68); do
  f="params_shard_${i}.bin"
  if [ ! -f "$MODEL_DIR/$f" ]; then
    curl -sL --fail "$HF/$f" -o "$MODEL_DIR/$f" && echo "   $f" || { echo "   (stop at $f)"; break; }
  fi
done

# 4. Write the offline app config consumed by the WebLLM provider.
cat > "$VENDOR/offline-config.json" <<JSON
{
  "model_id": "$MODEL_ID",
  "library_url": "vendor/webllm/index.js",
  "app_config": {
    "model_list": [
      {
        "model": "vendor/models/$MODEL_ID/",
        "model_id": "$MODEL_ID",
        "model_lib": "vendor/wasm/${MODEL_ID}-webgpu.wasm"
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
