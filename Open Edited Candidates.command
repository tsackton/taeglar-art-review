#!/bin/zsh -il
exec python3 "${0:A:h}/art_review.py" --edited "$@"
