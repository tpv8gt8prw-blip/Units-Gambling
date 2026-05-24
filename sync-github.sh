#!/usr/bin/env bash
# GitHub sync — nach Änderungen ausfühhen:
#   ./sync-github.sh
#   ./sync-github.sh "feat: Predictions + Dock polish"

set -e
cd "$(dirname "$0")"

MSG="${1:-Update: $(date '+%Y-%m-%d %H:%M')}"

if [[ -z $(git status --porcelain) ]]; then
  echo "✓ Nichts zu committen — alles schon auf dem neuesten Stand."
  exit 0
fi

echo "→ Änderungen:"
git status -s

git add -A
git commit -m "$MSG"
git push -u origin HEAD

echo ""
echo "✓ Auf GitHub gepusht: $(git remote get-url origin)"
echo "  Branch: $(git branch --show-current)"
