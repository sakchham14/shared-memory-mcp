#!/usr/bin/env bash
# One-liner installer/updater for shared-memory-mcp.
# Usage:
#   curl -fsSL https://raw.githubusercontent.com/sakchham14/shared-memory-mcp/main/install.sh | bash
set -euo pipefail

REPO=https://github.com/sakchham14/shared-memory-mcp.git
DIR="${SHARED_MEM_DIR:-$HOME/.claude/mem}"

if [ -d "$DIR/.git" ]; then
  echo "Updating existing install at $DIR..."
  git -C "$DIR" pull --ff-only
else
  echo "Installing to $DIR..."
  mkdir -p "$(dirname "$DIR")"
  # Preserve any existing data/ db before cloning
  if [ -d "$DIR/data" ]; then mv "$DIR/data" "$DIR/data.bak.$(date +%s)"; fi
  if [ -d "$DIR/db" ]; then mv "$DIR/db" "$DIR/db.bak.$(date +%s)"; fi
  git clone "$REPO" "$DIR"
  # Restore preserved data
  for b in "$DIR"/data.bak.* "$DIR"/db.bak.*; do
    [ -e "$b" ] || continue
    base=$(basename "$b" | sed -E 's/\.bak\.[0-9]+//')
    mv "$b" "$DIR/$base"
  done
fi

cd "$DIR"
npm install --silent
echo "Done. DB path auto-detected at run time."
