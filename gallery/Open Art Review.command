#!/bin/zsh
cd -- "${0:A:h}" || exit 1
export PATH="$PATH:/opt/homebrew/bin:/usr/local/bin:$HOME/.local/bin:$HOME/.local/miniforge3/envs/default/bin"
exec python3 art_review.py
