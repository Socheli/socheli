#!/usr/bin/env bash
# Warm the local MusicGen cache — ONE-TIME, interactive, controlled download.
#
# Run this ONCE in a terminal you control to populate the HF cache so renders can
# use local MusicGen WITHOUT ever downloading in the render path (the render path
# is offline-only and will skip to the API / ambient bed if the model isn't here).
#
#   bash packages/engine/scripts/warm-musicgen.sh                 # default model
#   MUSICGEN_MODEL=facebook/musicgen-large bash …/warm-musicgen.sh
#
# Env:
#   MUSICGEN_MODEL   HF model id (default facebook/musicgen-medium)
#   HF_TOKEN         optional HF access token (only for gated/private models)
#   SOCHELI_EXT_VOLUME  if set, cache lands under $SOCHELI_EXT_VOLUME/Socheli/hf-cache
#
# This is NEVER auto-invoked. It downloads ~1.5-3.5GB depending on the model.
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO="$(cd "$HERE/../../.." && pwd)"
MODEL="${MUSICGEN_MODEL:-facebook/musicgen-medium}"

# Resolve the cache home the same way media.ts resolveHfCache() does:
# repo data/hf-cache symlink target → $SOCHELI_EXT_VOLUME/Socheli/hf-cache → repo path.
LINK="$REPO/data/hf-cache"
if [ -e "$LINK" ]; then
  CACHE_HOME="$(cd "$LINK" && pwd -P)"
elif [ -n "${SOCHELI_EXT_VOLUME:-}" ]; then
  CACHE_HOME="$SOCHELI_EXT_VOLUME/Socheli/hf-cache"
else
  CACHE_HOME="$LINK"
fi
mkdir -p "$CACHE_HOME/hub"

PY="${MUSICGEN_PYTHON:-$REPO/.venv-music/bin/python}"
if [ ! -x "$PY" ]; then
  echo "error: python not found at $PY (set MUSICGEN_PYTHON)" >&2
  exit 1
fi

echo "Warming MusicGen:"
echo "  model:      $MODEL"
echo "  cache home: $CACHE_HOME"
echo "  python:     $PY"
echo
echo "This downloads the model weights once (~1.5-3.5GB). Online for this run only."
echo

export HF_HOME="$CACHE_HOME"
export HF_HUB_CACHE="$CACHE_HOME/hub"
export MUSICGEN_MODEL="$MODEL"
# explicitly ONLINE for the warm-up (the render path is offline)
unset HF_HUB_OFFLINE || true
[ -n "${HF_TOKEN:-}" ] && export HF_TOKEN

"$PY" - <<'PYEOF'
import os, sys
model = os.environ.get("MUSICGEN_MODEL", "facebook/musicgen-medium")
print(f"downloading {model} into {os.environ.get('HF_HUB_CACHE')} ...", flush=True)
try:
    from transformers import AutoProcessor, MusicgenForConditionalGeneration
except Exception as e:
    print(f"musicgen stack unavailable: {e}", file=sys.stderr)
    sys.exit(1)
AutoProcessor.from_pretrained(model)
MusicgenForConditionalGeneration.from_pretrained(model)
print(f"OK — {model} cached under {os.environ.get('HF_HUB_CACHE')}", flush=True)
PYEOF

echo
echo "Done. Renders can now use MUSIC_PROVIDER=musicgen (or auto) with $MODEL."
