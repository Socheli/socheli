#!/usr/bin/env bash
# Deploy Socheli CODE (not data — that's sync-to-server.sh) to the server:
# rsync the source, rebuild the dashboard, restart the services. The box runs the
# monorepo straight from source (tsx for api/bridge, `next start` for the
# dashboard), so a deploy = push source + `next build` + restart.
#
# Usage: ./scripts/deploy.sh [--no-build]
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
KEY="${SOCHELI_KEY:-$HOME/.ssh/socheli_deploy_key}"
HOST="${SOCHELI_HOST:?set SOCHELI_HOST=user@host (your deploy target)}"
DEST="/opt/socheli"
SSH="ssh -i $KEY -o BatchMode=yes -o StrictHostKeyChecking=accept-new"

EXCLUDES=(--exclude 'node_modules/' --exclude '.next/' --exclude '.DS_Store'
          --exclude '*.log' --exclude '.env' --exclude '.env.*'
          # remotion/public holds ~5GB of b-roll + per-render music/wavs — render
          # assets the server never needs (rendering runs on the M4). Skip it; the
          # in-browser editor preview is pushed separately by sync-to-server.sh.
          --exclude 'remotion/public/')

echo "▶ pushing source → $HOST"
for d in apps/dashboard packages docs scripts tools; do
  echo "  · $d"
  rsync -az --delete "${EXCLUDES[@]}" -e "$SSH" "$ROOT/$d/" "$HOST:$DEST/$d/"
done
# top-level manifests (workspace + TS config), never the local .env
rsync -az -e "$SSH" "$ROOT/package.json" "$ROOT/pnpm-workspace.yaml" \
  "$ROOT/tsconfig.base.json" "$ROOT/pnpm-lock.yaml" "$HOST:$DEST/"

if [[ "${1:-}" == "--no-build" ]]; then
  echo "▶ skipping build (--no-build); restarting services"
else
  echo "▶ install (frozen) + build dashboard on the server"
  $SSH "$HOST" "cd $DEST && pnpm install --frozen-lockfile --prefer-offline 2>&1 | tail -3 && cd apps/dashboard && pnpm build 2>&1 | tail -6"
fi

echo "▶ restarting services"
$SSH "$HOST" "systemctl restart socheli-dashboard socheli-api socheli-bridge && sleep 3 && systemctl is-active socheli-dashboard socheli-api socheli-bridge"
echo "✓ deployed. https://app.socheli.com"
