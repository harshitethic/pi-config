# seat_burn selftest fixtures

`python3 docs/data/seat_burn.py --selftest` drives the CLI as a subprocess over
these directories — one case per row of WO-2026-053's behavior matrix, plus an
end-to-end golden. No real logs, no network.

| dir | matrix row | pins |
|---|---|---|
| `logs/case01` | 1 | one main-session file, `model_change` mid-file (compaction switches model): per-message model attribution, every row on the main-session seat; also the in-peak `$` for a DS-Flash message. Beside it a `*.pre-*` backup with a distinct entry id and 999,999 input tokens: ingestion must skip it, or every case-01 number inflates |
| `logs/case02` + `meta/` | 2 | `subagent-*` file joined to `pi-subagent-<sid>.meta.json`: seat = `agentName` (`implement`), even though its `:low` signature would infer the scout seats |
| `logs/case03` | 3 | `subagent-*` file with no meta and a unique signature (`deepseek-v4-pro:max`) → `math-algo-oracle`, attribution `signature` |
| `logs/case04` | 4 | `subagent-*` file with no meta and an ambiguous signature (`glm-5.3-flash:high` = the three reviewer seats) → named ambiguous group, never a guess |
| `logs/case05` | 5 | entry id replayed 3× and another 2× with *larger* usage on the later copies: each counted once (first copy wins), `duplicate_ids_dropped` = 3 |
| `logs/case06` | 6 | `deepseek/deepseek-v4.1-flash` (openrouter) and `deepseek-v4.1-flash` (opencode-go) → one canonical model id, two routes; plus a message with no envelope `provider`, routed by its `model_change` (`zai`) |
| `logs/case07` | 7 | `-1017` checkpoint via openrouter: its own model row, no solo capacity, excluded from the plan meter; also the caller-model inheritance rule seating a meta-less `:max` subagent as `orchestrator` |
| `logs/case08` | 8 | assistant messages with no `usage`, empty `usage`, and no `totalTokens` → skipped and counted; plus entry types the matrix does not enumerate (`custom`, `custom_message`, `session_info`), a model id with no price row (tokens reported, `$` 0, unpriced classes flagged), and a timestamp unparseable past the day part (peak multiplication left off and counted) |
| `logs/case09` | 9 | identical usage on Fri 02:30 (in peak, ×2), Sat 07:00 (peak hours, weekend, ×1), Sun 12:00 (out, ×1) → `$` 0.00048 / 0.00024 / 0.00024, plus an unparseable-timestamp message at ×1 and a hand-computed plan-meter value (0.00120 ÷ 160 = 7.5e-06) |
| `logs/case10` | 10 | nonzero `cacheWrite` priced as its own class: reported, flagged unpriced, not folded into input |
| `golden/report.txt` | — | end-to-end text report over the whole fixture tree (primary evidence; sessions/meta paths normalized to `<SESSIONS>` / `<META>`) |

Rows 11 (absent dir / empty window / bad date) and 12 (real-log smoke run) are
CLI invocations in the selftest, not fixtures.

The signature table is derived from the live `agents/*.md` + `settings.json`, so
a seat repick (e.g. decision 036/037-style model moves) changes case 3/4
attribution and the golden — regenerate with the command in
`gen-golden.sh` and re-check that each case still pins what the table above says.

The fixture tree is `logs/`, not `sessions/`: `.gitignore` carries a bare
`sessions/` pattern (for the real log root), which silently swallows fixtures
added under that name. Keep fixture dirs out of that pattern's way.
