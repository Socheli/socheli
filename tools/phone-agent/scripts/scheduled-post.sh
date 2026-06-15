#!/bin/bash
# Scheduled posting, run by launchd a few times/day while the phone is docked +
# unlocked. Posts every PACKAGED Socheli run that still has un-posted platforms,
# human-paced, with a per-run cap. Safe to fire when nothing is ready (it exits).
#
# launchd has a minimal PATH and the Android SDK lives on an external volume,
# so everything is referenced by absolute path here.

set -uo pipefail

# All paths are discovered dynamically so this runs on any machine. Override any
# of them via env (NODE_BIN / ADB_BIN) when launchd's minimal PATH can't find them.
AGENT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
NODE="${NODE_BIN:-$(command -v node)}"
ADB_BIN_PATH="${ADB_BIN:-$(command -v adb)}"
LIMIT="${SOCHELI_POST_LIMIT:-3}"

export ADB_BIN="$ADB_BIN_PATH"
export PATH="$(dirname "$NODE"):/usr/local/bin:/usr/bin:/bin"

ts() { date -u +%Y-%m-%dT%H:%M:%SZ; }
echo "$(ts) scheduled-post start (limit=$LIMIT)"

# Bail quietly if the SDK drive isn't mounted or adb is missing.
if [ ! -x "$ADB_BIN_PATH" ]; then
  echo "$(ts) adb not found at $ADB_BIN_PATH (drive unmounted?) — skipping"
  exit 0
fi

"$NODE" "$AGENT_DIR/src/run.mjs" publish --send --limit "$LIMIT"
echo "$(ts) scheduled-post done"
