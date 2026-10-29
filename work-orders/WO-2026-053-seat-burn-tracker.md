# Work Order

### Metadata

- **work_order_id**: WO-2026-053
- **parent_plan_id**: seat-burn-measurement (docs/TODO.md "Seat-burn measurement" entry)
- **sequence_position**: 1 of 1
- **routed_to**: implement
- **invariant_exhaustiveness**: implicit
- **priority**: normal
- **estimated_complexity**: moderate
- **review_policy**: required

### Task Summary

**One-sentence description**: Build `docs/data/seat_burn.py`, a read-only CLI that attributes pi session-log token usage to subagent seats and OpenCode Go plan buckets per day, so we can measure what share of fleet tokens the session/orchestrator seats burn.

**Goal**: A tested Python CLI that, over a date window, reports per-day and per-window raw tokens split by seat and by model/bucket (with cache/non-cache split and $ burn vs the Go Plus monthly buckets), and flags unattributed usage. Running it on real logs must produce the numbers quoted in the completion report.

### Premise

Pi session logs (`~/.pi/agent/sessions/**/*.jsonl`) record per-assistant-message `usage` (input/output/cacheRead/cacheWrite/totalTokens/cost) and `message.model`, and subagent spawns record `agentName` in `/tmp/pi-subagent-<session-id>.meta.json` — enough to attribute tokens to seats. Probe: inspect one session file's `message` entries and one `/tmp/pi-subagent-*.meta.json`. If usage or model is absent from assistant messages across the corpus, report `PREMISE FALSIFIED` with evidence and land nothing.

### Scope

**Invariants**:
- The tool is **read-only**: it must never write to session logs, `/tmp`, or anywhere except stdout/`--json` output. No state files.
- No behavior change anywhere in `extensions/`, `agents/`, `settings.json`, `models.json`, `docs/data/role_scores.py` outputs.
- Session-log parsing must tolerate the full real corpus shape (2,800+ files, entries of types `session`/`model_change`/`thinking_level_change`/`message`/`custom`, model ids recorded inconsistently bare vs provider-prefixed) without crashing.

**Files expected to change**:
- `docs/data/seat_burn.py` — new CLI (stdlib only)
- tests/fixtures for the selftest (co-located, e.g. `docs/data/testdata/seat_burn/`)
- `docs/data/README.md` or a short header docstring — usage + price-table provenance (only if such a doc exists or a docstring suffices)

**Files to read (reference only, do not modify)**:
- `docs/data/role_scores.py` — existing Python tool convention; if it exposes pricing/blended-rate helpers, import them instead of re-deriving (share code)
- `extensions/subagent-async/index.ts` (functions around the `/tmp/pi-subagent-*.meta.json` naming) — meta.json schema: `agentName`, `task`, `cwd`, `startedAt`
- `agents/*.md` frontmatter — seat → model:effort signatures for fallback attribution
- `decisions/model-tiers/004-monthly-cap-only-cost-metric.md` and `decisions/subagents/036-fleet-opencode-go.md` — the cost metric and bucket map

**Files NOT to modify**:
- `settings.json`, `extensions/auto-checkpoint.ts`, `tests/auto-checkpoint.test.ts`, `decisions/settings/README.md` — another session's uncommitted WIP
- `docs/data/role_scores.py` — unless extracting a genuinely shared helper, and then only with its existing outputs proven byte-identical before/after
- anything under `extensions/`, `agents/`, `models.json`

**Out of scope**: footer/quota-display work, any change to seat assignments or agent frontmatter, persisting measurement results into the repo, scheduling/automation of future runs.

### Implementation Specification

**Detailed requirements**:

1. **CLI**: `python3 docs/data/seat_burn.py [--since YYYY-MM-DD] [--until YYYY-MM-DD] [--sessions-dir DIR] [--json] [--selftest]`. Defaults: sessions dir `~/.pi/agent/sessions`, since = 45 days before the latest entry, until = now.
2. **Ingest**: walk `**/*.jsonl` under the sessions dir, excluding `*.pre-*` backup files. Parse `message` entries with `role == "assistant"` carrying a `usage` object; take `usage.totalTokens` as the raw-token count and `input`/`output`/`cacheRead`/`cacheWrite` for the class split. Take `message.model` as the model. Session identity from the filename/`session` entry.
3. **Dedupe**: pi replays/branching duplicate some entries (~3%, up to 4 copies of one entry id). Count each entry `id` once per session file (first occurrence wins).
4. **Bucket/model attribution** (primary axis, exact):
   - Canonicalize model ids: merge bare and provider-prefixed spellings of the same model (`deepseek-v4.1-flash` ≡ `deepseek/deepseek-v4.1-flash`), but keep the `-1017` checkpoint distinct. Enumerate every model-id spelling actually present in a real scan and list them in the completion report.
   - Route by provider (from `model_change`/model prefix): `opencode-go` models consume Go buckets; `openrouter`-routed models are pay-per-use and must be reported separately (excluded from bucket math).
5. **Seat attribution** (the headline axis):
   - Session files not named `subagent-*` = main-session seat. Files named `subagent-*` = subagent sessions.
   - Join `/tmp/pi-subagent-*.meta.json` on session id for `agentName` (orchestrator/implement/review-code/review-plan/review-tests/scout-code/scout-web/math-algo-oracle/…).
   - Fallback when meta.json is missing (tmp is ephemeral): map (model, thinking level from `model_change`/`thinking_level_change` entries) to a seat via `agents/*.md` frontmatter + `settings.json` defaultModel + decision-031 inheritance (orchestrator = caller model + `:max`). Enumerate this signature table from the actual config at implementation time and include it in the report. Ambiguous signatures (e.g. main session and orchestrator on the same model when the level is absent) must be reported as a named ambiguous group, not guessed.
   - Report the attributed share and the unattributed share explicitly.
6. **Pricing**: embed a per-model, per-class ($/M) price table for the current fleet (Go off-peak where known: DS V4.1 Flash 0.15/0.60/0.003 cacheRd; DS V4 Pro 0.66/1.98; GLM-5.3-Flash 0.15/0.50; MiMo-V2.6-Flash 0.14/0.28; GLM-5.3 1.40/4.40; MiMo-V2.6-Pro Go price unknown — use the Xiaomi/OpenRouter list 0.435/0.87/0.036 as a flagged placeholder). Each row carries a `source` string. Compute $ burn as Σ(class tokens × class price) — no blended-rate assumptions. Peak multiplier: ×2 for DS V4.1 Flash on weekdays 01–04 and 06–10 UTC (decision 036); mark other models' peak behavior as unknown in the table, don't invent it. Prices unknown → report tokens only, say "price unknown".
7. **Output** (`--json` gives the same data machine-readable):
   - per-day rows: raw tokens by seat, by bucket-model, cache/non-cache split
   - window summary: per-seat totals + share %, per-model totals
   - bucket ledger: $ burn per Go bucket for the window, month-projected at observed pace, vs the Go Plus monthly cap (GLM-5.3-Flash $180, DS V4.1 Flash $160, DS V4 Pro $60, MiMo-V2.6-Pro $60)
   - headline line: **session+orchestrator seats = X% of raw tokens, Y% of $ burn**, month-projected vs the MiMo-Pro bucket
   - data-quality notes: duplicate count, missing-usage count, unattributed share, ambiguous-signature groups
8. **Selftest**: `--selftest` runs the parser/attribution/pricing against small fixture session files + meta.json covering the behavior matrix below and exits 0/1. No network, no dependence on real logs.

**Required test boundary**: the CLI entry point, run as a subprocess over fixture directories (`--sessions-dir` pointing at fixture data) and `--selftest`. End-to-end golden output for a small fixture window is primary evidence; internal-helper tests are supplemental.

**Behavior and failure matrix** (each row needs a selftest fixture case):

| # | Case | Expected |
|---|---|---|
| 1 | Main-session file, messages before/after a `model_change` (compaction switches model mid-file) | per-message model attribution; all rows under the main-session seat |
| 2 | `subagent-*` file with matching `/tmp` meta.json | seat = meta `agentName` |
| 3 | `subagent-*` file, meta.json missing, unique (model, level) signature | seat inferred from signature table, confidence flagged |
| 4 | `subagent-*` file, meta.json missing, ambiguous signature | named ambiguous group in output, never a silent guess |
| 5 | Entry id duplicated 2–4× (replay/branching) | counted once |
| 6 | Same model spelled bare and provider-prefixed | merged under one canonical model |
| 7 | `-1017` checkpoint messages routed via openrouter provider | separate row, excluded from Go bucket math |
| 8 | Message with missing/empty `usage` | skipped, counted in data-quality notes |
| 9 | Timestamp inside DS-Flash peak window (weekday 06–10 UTC) vs outside | ×2 price applies only inside |
| 10 | Nonzero `cacheWrite` (old corpus rows) | priced as its own class or flagged, never silently folded into input |
| 11 | Empty window / sessions dir absent | clean error message, nonzero exit |
| 12 | Real-log smoke run | completes without error and prints a report |

### Invariants

**Cross-file conventions**:
- Python tooling convention matches `docs/data/role_scores.py` (stdlib, argparse, no third-party deps).
- The seat-signature table is derived from `agents/*.md` + `settings.json` at runtime or from a table the report proves was enumerated from them — no hand-typed model list that can drift silently.

**Error handling**: missing/odd entries are counted and reported, never fatal except for the invalid-CLI/dir cases (row 11). Never emit a number without its data-quality caveat attached.

**Unspecified invariants** (enumeration deliverable): (a) the full model-id spelling inventory found in a real corpus scan, (b) the full seat-signature table derived from current config, (c) any corpus entry shapes not in the matrix that the parser must tolerate. Negative results (none found) are valid answers.

### Verification Criteria

- `python3 docs/data/seat_burn.py --selftest` exits 0; every matrix row has a fixture case.
- `python3 docs/data/seat_burn.py --since 2026-10-17` on the real logs completes and its numbers are quoted in the completion report (per-seat shares + bucket ledger) — these are the first data points for the owner's question.
- `python3 docs/data/seat_burn.py --json …` parses as JSON and carries the same numbers as the text output.
- No files outside scope changed.

### Structural Risks

- [ ] **Route/path correctness**: the CLI lives at `docs/data/seat_burn.py` exactly
- [ ] **Test surface**: tests drive the CLI as a subprocess over fixtures (not internal functions only)
- [ ] **Input validation scope**: accepts the full real corpus shape, not just fixture shape
- [ ] **No unrequested changes**: nothing outside the scope list; the parent tree has another session's uncommitted WIP files that must not appear in the diff
- [ ] **Build config untouched**: no new dependencies, no config changes
- [ ] **No unsolicited features**: no scheduling, no footer work, no seat changes

### Context

**Prior work**: 2026-10-18 seat-sustainability analysis (this plan): fleet at 250M raw tokens/day × 3 heavy days/week fits every Go Plus bucket except possibly MiMo-V2.6-Pro ($60/mo ≈ 1.1B raw tokens at observed mix) — session+orchestrator seats ride that bucket via decision-031 model inheritance, and their true share of fleet tokens is currently an estimate (~25–35%, remapped from historical GLM traffic). This tool replaces the estimate with measurement.

**Upcoming**: a re-run ~2026-10-20 over the fresh-seat window decides whether the session/orchestrator seat changes bucket. Do not change any seat assignment.

**Relevant decisions**: `decisions/model-tiers/004` (cost metric: monthly cap only; effective volume = bucket ÷ blended $/M — this tool computes factual $ burn per class instead, which feeds that metric), `decisions/subagents/036` (Go fleet, buckets, peak windows), `decisions/subagents/031` (orchestrator model inheritance — why the session model carries orchestrator traffic), `decisions/subagents/037` (current seat map).

### Amendment 2026-10-18 (pre-landing) — shared-allowance mechanism

Research landed mid-implementation: Go enforcement is **one shared normalized allowance**, not per-model buckets (opencode `console` source: `quotaCost = round(cost × costMultiplier)` accumulates into a single per-workspace counter; support quote: github.com/anomalyco/opencode#54875 — "The 'Monthly limit' for each model is how much of that model alone you could use with the full allowance. It is not a separate budget"). Per-model monthly figures are **solo-capacity** illustrations. The plan-wide monthly meter is `Σ (real$ on model m ÷ listedLimit_m) ≤ 1` (the plan-wide constant cancels). Enforcement at limit = HTTP 429 hard block until window reset (no grace margin; optional console "Use balance" PAYG fallback). The 5h window is an anchored reset, not a sliding window.

Spec addition to step 7 output (steered to the implementer in-flight): keep the per-model ledger but label it **solo capacity**; add a **plan-wide meter** row: `Σ real$ ÷ listedLimit` for the window, month-projected at observed pace, vs 1.0, noting the `/zen/go/v1/usage` monthly % as the server-side cross-check. Price table gains `listedLimit` per model (Go Plus: DS V4.1 Flash 160, GLM-5.3-Flash 180, DS V4 Pro 60, MiMo-V2.6-Pro 60).

### Completion Report Format

Standard: status / invariant_exhaustiveness / files_modified / tests / structural_checks / deviations_from_spec / notes_for_orchestrator. Plus (review_policy: required): assumptions_made, unexpected_changes, issues_encountered, test_coverage, adversarial_reviews, review_cap_reached, accepted_notes. Include the real-run numbers (per-seat shares, bucket ledger) and the two enumeration deliverables verbatim.
