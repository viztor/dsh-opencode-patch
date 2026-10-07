#!/usr/bin/env bash
# Capture the plugin's UI from a running DSH, for the README's Interface section.
#
# DSH serves on 127.0.0.1:3080 behind a token in the query string, and the token is
# generated at runtime — it is not in ~/.dsh/profiles, settings.yaml or storages, so
# it has to be passed in:
#
#   scripts/capture-ui.sh 'http://127.0.0.1:3080/?token=...'
#
# Requires `agent-browser` (npm i -g agent-browser && agent-browser install).
set -euo pipefail

URL="${1:-}"
if [ -z "$URL" ]; then
  echo "usage: $0 '<dsh url with ?token=...>'" >&2
  exit 2
fi

OUT="$(cd "$(dirname "$0")/.." && pwd)/docs"
mkdir -p "$OUT"

# The managed Node is x64 while this machine is arm64; agent-browser spawns Node
# internally, so the arm64 one from Homebrew has to win on PATH.
export PATH="/opt/homebrew/bin:$PATH"

echo "opening DSH…"
agent-browser open "$URL"
agent-browser wait --load load || true

# The composer dock: the meter sits beside the model selector.
echo "capturing the composer dock…"
agent-browser screenshot --path "$OUT/composer-dock.png" || \
  agent-browser screenshot "$OUT/composer-dock.png"

# The expanded panel is opened by clicking the trigger, not by hovering.
echo "opening the meter panel…"
agent-browser click ".dsh-oc-usage-trigger" || true
agent-browser wait --load load || true
agent-browser screenshot --path "$OUT/meter-panel.png" || \
  agent-browser screenshot "$OUT/meter-panel.png"

agent-browser close || true
echo "wrote $OUT/composer-dock.png and $OUT/meter-panel.png"
