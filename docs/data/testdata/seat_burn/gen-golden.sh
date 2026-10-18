#!/bin/sh
# Regenerate golden/report.txt. Run from the repo root.
set -e
root=docs/data/testdata/seat_burn
python3 docs/data/seat_burn.py --sessions-dir "$root/logs" --meta-dir "$root/meta" \
  --since 2026-05-01 --until 2026-05-03 \
  | sed "s|$(pwd -P)/$root/logs|<SESSIONS>|; s|$(pwd -P)/$root/meta|<META>|" \
  > "$root/golden/report.txt"
