#!/bin/zsh
cd -- "${0:A:h}" || exit 1
# Finder does not always inherit the interactive shell's search path.
export PATH="$PATH:/opt/homebrew/bin:/usr/local/bin:$HOME/.local/bin:$HOME/.local/miniforge3/envs/default/bin"
if ! command -v gh >/dev/null || ! command -v node >/dev/null; then
  echo "Install GitHub CLI and Node.js 18 or later, then reopen Art Review."
  exit 1
fi
if ! gh auth status --active --hostname github.com >/dev/null 2>&1; then
  echo "Sign in to GitHub to sync your art reviews."
  gh auth login --hostname github.com --web || exit 1
fi
exec node review-launcher.cjs
