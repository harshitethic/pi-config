# seat_burn selftest fixtures

`python3 docs/data/seat_burn.py --selftest` drives the CLI as a subprocess over
these directories — one case per row of WO-2026-053's behavior matrix, plus an
end-to-end golden. No real logs, no network.

| dir | matrix row | pins |
|---|---|---|
| `sessions/case01` | 1 | one main-session file, `model_change` mid-file (compaction switches model): per-message model attribution, every row on the main-session seat; also the in-peak `$` for a DS-Flash message |
| `sessions/case02` + `meta/` | 2 | `subagent-*` file joined to `pi-subagent-<sid>.meta.json`: seat = `agentName` (`implement`), even though its `:low` signature would infer the scout seats |
| `sessions/case03` | 3 | `subagent-*` file with no meta and a unique signature (`deepseek-v4-pro:max`) → `math-algo-oracle`, attribution `signature` |
| `sessions/case04` | 4 | `subagent-*` file with no meta and an ambiguous signature (`glm-5.3-flash:high` = the three reviewer seats) → named ambiguous group, never a guess |
| `sessions/case05` | 5 | entry id replayed 3× and another 2×: each counted once, `duplicate_ids_dropped` = 3 |
| `sessions/case06` | 6 | `deepseek/deepseek-v4.1-flash` (openrouter) and `deepseek-v4.1-flash` (opencode-go) → one canonical model id, two routes; plus a message with no envelope `provider`, routed by its `model_change` (`zai`) |
| `sessions/case07` | 7 | `-1017` checkpoint via openrouter: its own model row, no solo capacity, excluded from the plan meter; also the caller-model inheritance rule seating a meta-less `:max` subagent as `orchestrator` |
| `sessions/case08` | 8 | assistant messages with no `usage`, empty `usage`, and no `totalTokens` → skipped and counted |
| `sessions/case09` | 9 | identical usage on Fri 02:30 (in peak, ×2), Sat 07:00 (peak hours, weekend, ×1), Sun 12:00 (out, ×1) → `$` 0.00048 / 0.00024 / 0.00024 |
| `sessions/case10` | 10 | nonzero `cacheWrite` priced as its own class: reported, flagged unpriced, not folded into input |
| `golden/report.txt` | — | end-to-end text report over the whole fixture tree (primary evidence; sessions/meta paths normalized to `<SESSIONS>` / `<META>`) |

Rows 11 (absent dir / empty window / bad date) and 12 (real-log smoke run) are
CLI invocations in the selftest, not fixtures.

The signature table is derived from the live `agents/*.md` + `settings.json`, so
a seat repick (e.g. decision 036/037-style model moves) changes case 3/4
attribution and the golden — regenerate with the command in
`gen-golden.sh` and re-check that each case still pins what the table above says.
