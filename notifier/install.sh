#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
NOTIFY_JS="$SCRIPT_DIR/notify.js"
LABEL="com.github-pr-dashboard.notifier"
PLIST_SRC="$SCRIPT_DIR/$LABEL.plist"
DEST_DIR="$HOME/Library/LaunchAgents"
DEST="$DEST_DIR/$LABEL.plist"

NODE_BIN="$(command -v node || true)"
GH_BIN="$(command -v gh || true)"
CLAUDE_BIN="$(command -v claude || true)"
TN_BIN="$(command -v terminal-notifier || true)"

[ -n "$NODE_BIN" ] || { echo "error: node not found in PATH"; exit 1; }
[ -n "$GH_BIN" ] || { echo "error: gh not found in PATH"; exit 1; }
[ -n "$CLAUDE_BIN" ] || echo "warning: claude not found in PATH (AI review will fail until installed)"
[ -n "$TN_BIN" ] || echo "warning: terminal-notifier not found in PATH; notifications will use osascript (clicking won't open the dashboard)"

# launchd gives jobs a minimal PATH, so the agent must carry the dirs of the
# tools it shells out to. Resolve them here at install time.
LAUNCH_PATH="$(dirname "$NODE_BIN"):$(dirname "$GH_BIN")"
[ -n "$CLAUDE_BIN" ] && LAUNCH_PATH="$LAUNCH_PATH:$(dirname "$CLAUDE_BIN")"
[ -n "$TN_BIN" ] && LAUNCH_PATH="$LAUNCH_PATH:$(dirname "$TN_BIN")"
LAUNCH_PATH="$LAUNCH_PATH:/usr/bin:/bin:/usr/sbin:/sbin:/opt/homebrew/bin"

mkdir -p "$DEST_DIR" "$REPO_ROOT/data"

sed -e "s#__NODE__#$NODE_BIN#g" \
  -e "s#__NOTIFY_JS__#$NOTIFY_JS#g" \
  -e "s#__REPO_ROOT__#$REPO_ROOT#g" \
  -e "s#__PATH__#$LAUNCH_PATH#g" \
  "$PLIST_SRC" >"$DEST"

echo "Wrote $DEST"
echo
echo "Load (or reload) the agent:"
echo "  launchctl unload \"$DEST\" 2>/dev/null || true"
echo "  launchctl load \"$DEST\""
echo
echo "Status:    launchctl list | grep $LABEL"
echo "Logs:      tail -f \"$REPO_ROOT/data/notifier.log\""
echo "Uninstall: launchctl unload \"$DEST\" && rm \"$DEST\""
