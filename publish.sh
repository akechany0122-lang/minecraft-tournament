#!/bin/bash
# GitHub へ公開(初回はリポジトリ作成、2回目以降は更新を push)
#   使い方:  ./publish.sh [リポジトリ名]      例: ./publish.sh minecraft-tournament
set -e
cd "$(dirname "$0")"
NAME="${1:-tournament-bracket}"

command -v gh >/dev/null || { echo "gh をインストールします..."; brew install gh; }
gh auth status >/dev/null 2>&1 || gh auth login

[ -d .git ] || git init -b main
git add -A
git diff --cached --quiet || git commit -m "Update tournament bracket"

if ! git remote get-url origin >/dev/null 2>&1; then
  gh repo create "$NAME" --public --source=. --remote=origin --push
else
  git push -u origin HEAD
fi

URL=$(gh repo view --json url -q .url)
echo ""
echo "✅ GitHub: $URL"
echo "🚀 Render で公開(初回のみ): https://render.com/deploy?repo=$URL"
echo "   → 管理者パスワードを入力してデプロイ。2回目以降は ./publish.sh だけで自動更新されます。"
