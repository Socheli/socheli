#!/usr/bin/env bash
# Sync M4-generated content → the Socheli server (app.socheli.com / media.socheli.com).
#
# Architecture: the M4 generates + renders; the server hosts the dashboard online and
# serves rendered mp4s publicly for IG/TikTok posting. Run this after a generation run
# (or on a cron/launchd timer) to push the latest state up.
#
# Usage: ./scripts/sync-to-server.sh [--with-preview]
#   --with-preview  also sync packages/remotion/public (voice/music/broll) so the live
#                   in-browser editor preview works on the server (~big; usually not needed).

set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
KEY="${SOCHELI_KEY:-$HOME/.ssh/socheli_deploy_key}"
HOST="${SOCHELI_HOST:?set SOCHELI_HOST=user@host (your deploy target)}"
DEST="/opt/socheli"
SSH="ssh -i $KEY -o BatchMode=yes -o StrictHostKeyChecking=accept-new"

# ── Pull server-owned gate state DOWN first ──────────────────────────────────
# These three files are authored + edited on the server dashboard (concept board
# approve/reject, calendar plan approve/reject + scheduling, day notes). The M4
# is NOT authoritative for them but DOES read them — autopilot/missions decide
# what to generate from the plan + the board, so a stale local copy would make
# the device act on already-rejected concepts. Pull the server's truth down
# before the device does anything, then the push below skips them. Best-effort:
# a missing remote file or a transient failure must never abort the render sync.
SERVER_OWNED=(concepts.json content-plan.json calendar-meta.json copilot-model.json claude-oauth.json)
echo "▶ pulling server-owned gate state ← $HOST"
for f in "${SERVER_OWNED[@]}"; do
  # Plain rsync (macOS ships openrsync, which lacks --ignore-missing-args). If the
  # remote file doesn't exist yet, rsync exits non-zero and we just skip it.
  if rsync -az -e "$SSH" "$HOST:$DEST/data/$f" "$ROOT/data/$f" 2>/dev/null; then
    echo "  ↓ $f"
  else
    echo "  · $f (skipped — not on server yet or transient)"
  fi
done

echo "▶ syncing data/ (runs + renders → server) → $HOST"
# SERVER-OWNED STATE — never push these up. They are authored AND edited on the
# server dashboard (the concept board's approve/reject, the calendar plan's
# approve/reject + scheduling, day notes/reminders). The M4 only renders; its
# copies are stale. Pushing them clobbered the human's gate decisions — e.g.
# rejected concepts reappeared after every post-render sync. Excluding them makes
# the server authoritative for that state; the M4 still pushes everything else
# (rendered runs, learnings, research, broll usage).
rsync -az --stats -e "$SSH" \
  --exclude 'exports/' --exclude 'props/' --exclude '*.log' --exclude '.DS_Store' \
  --exclude 'hf-cache' --exclude 'bundle/' --exclude 'renders' --exclude 'logs/' \
  --exclude 'concepts.json' --exclude 'content-plan.json' --exclude 'calendar-meta.json' --exclude 'copilot-model.json' --exclude 'claude-oauth.json' --exclude 'ai-providers/' --exclude 'ai-tasks.json' \
  "$ROOT/data/" "$HOST:$DEST/data/"

# Rendered mp4s live on the external renders volume (RENDERS_DIR), NOT under repo/data/,
# so the sync above never carries them — that's why finished videos don't appear on the
# hub. Push the FINAL renders (skip per-chapter / preview / trimmed intermediates) into
# the server's renders dir, which the dashboard reads (REPO_ROOT/data/renders).
RENDERS_SRC="${SOCHELI_RENDERS_DIR:-${SOCHELI_EXT_VOLUME:+$SOCHELI_EXT_VOLUME/Socheli/renders}}"
RENDERS_SRC="${RENDERS_SRC:-$ROOT/data/renders}"
if [[ -d "$RENDERS_SRC" ]]; then
  echo "▶ syncing final renders ($RENDERS_SRC) → $HOST"
  # Best-effort: renders live on the external volume, which a launchd
  # context can't read without Full Disk Access (macOS TCC → "Operation not
  # permitted"). Don't let that abort the run — data/ above already synced, and
  # the per-render hook / a Terminal run pushes the videos. `|| true` keeps the
  # exit clean; the hint tells you how to enable timer-driven render sync.
  rsync -az --stats --partial -e "$SSH" \
    --exclude '*_c[0-9]*.mp4' --exclude '*_preview.mp4' --exclude '*_t.mp4' \
    --exclude '.DS_Store' \
    "$RENDERS_SRC/" "$HOST:$DEST/data/renders/" \
    || echo "⚠ render sync failed (likely macOS TCC on $RENDERS_SRC) — data/ synced OK. To enable timer-driven render sync, grant Full Disk Access to node."
else
  echo "⚠ renders dir not found ($RENDERS_SRC) — skipping video sync (set SOCHELI_RENDERS_DIR)"
fi

if [[ "${1:-}" == "--with-preview" ]]; then
  echo "▶ syncing packages/remotion/public (editor preview media)"
  rsync -az --stats -e "$SSH" --exclude '.DS_Store' \
    "$ROOT/packages/remotion/public/" "$HOST:$DEST/packages/remotion/public/"
fi

echo "✓ synced. Dashboard: https://app.socheli.com  ·  Media: https://media.socheli.com"
