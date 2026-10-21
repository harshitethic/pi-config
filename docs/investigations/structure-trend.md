# Structure trend

Chunk-boundary structural snapshot for this repo. Convention: `APPEND_SYSTEM.md`
§Refactor-needed register, `decisions/subagents/024-structural-growth-checks.md`
and `040-refactor-first.md`. One entry per chunk
landing, newest first, under two lenses — **growth** (file/function size deltas,
candidate extractions) and **unification** (parallel mechanisms for one idea;
files unrelated work items all had to touch). Delta-based — no absolute
thresholds. Each audit runs as `scout-code` over the delta since the previous
entry. Each growth or parallel-mechanism finding is a strike on its area in the register below;
two strikes, or one `REFACTOR FIRST` refusal, close the area to feature work until its
refactor lands.

## Refactor-needed register

| area | strikes (landing or refusal) | state | refactor |
|---|---|---|---|
| `extensions/{checkpoint,auto-checkpoint}` read tracking | 1 (2026-10-21) | open — one duplicate copy remains in `auto-checkpoint.ts` (blocked: another session's WIP, migration order pending owner ruling) | fold `auto-checkpoint.ts` onto `extensions/lib/read-tracking.ts` |

## 2026-10-21 — chunk: WO-2026-055 checkpoint injection fix (`689de07..59655ec`)

2 commits (`af2733a` extract, `59655ec` change), 7 files: the shared read-tracking
helper, the `tool_result.input`/`toolCall` sourcing fix, the staleness guard +
snapshot label (per the utility evaluation in
`checkpoint-sanity-check-2026-10.md` §5.7), and honest injection coverage.
Review: review-code + review-tests APPROVED (2 rounds). Excluded as before:
another session's uncommitted `extensions/auto-checkpoint.ts` + its test.

### Growth

| file | now | base | Δ |
|---|---:|---:|---:|
| `extensions/checkpoint.ts` | 664 | 726 | **−62** |
| `extensions/lib/read-tracking.ts` | 217 | — | +217 (new; logic moved out of `checkpoint.ts`) |
| `tests/e2e-checkpoint.test.ts` | 952 | 601 | **+351** (deterministic injection rows M1–M14; vacuous describes deleted) |
| `tests/read-tracking.test.ts` | 299 | — | +299 (new) |

Production code shrank while gaining the staleness guard; all growth is test
coverage for a feature that previously could not fail. No growth strike.

### Unification

- **Resolved — read-region tracking had two diverging copies** (`checkpoint.ts`
  on `tool_execution_end.args`, `auto-checkpoint.ts` on `tool_result.input`).
  `extensions/lib/read-tracking.ts` is now the one ingestion/merge/normalize
  path; `checkpoint.ts` consumes it. **One copy remains** in
  `auto-checkpoint.ts` (grandfathered — another session's WIP): strike recorded
  above; closes when its migration order lands.
- Checked and not duplicated by this delta: the staleness guard lives only in
  `selectFreshRegions`; the snapshot label is one constant in `checkpoint.ts`.

## 2026-10-18 — chunk: seat-burn tracker (WO-2026-053, merge `4e7a00b`)

1 landing: `docs/data/seat_burn.py` (new, 1,397 lines) + 15 committed fixtures
(`docs/data/testdata/seat_burn/`), plus decision `model-tiers/005` (shared-allowance
mechanism) and its doc updates. Review: review-code APPROVED_WITH_NOTES, review-tests
APPROVED (2 rounds).

### Growth

| file | now | base | Δ |
|---|---:|---:|---:|
| `docs/data/seat_burn.py` | 1,397 | — | **+1,397** (new) |
| `docs/data/testdata/seat_burn/**` | 15 files | — | +~275 |

New file lands already large — the flag for the next audit is its *delta*, not the size.
Ranked extraction candidate if it grows: the price/limit table (the only table in the
repo that must stay in sync with OpenCode's catalog by hand).

### Unification

- **Price data now exists twice**: `docs/data/seat_burn.py`'s per-class price/limit table
  vs `docs/data/role_scores.py`'s blended $/M cost axis. Both cite decision records for
  provenance. If either updates, they drift apart silently — candidate to share one table.
- **Quota display vs quota projection**: `extensions/footer-session-id.ts` renders the
  server's plan-wide % (decisions/external-tools/006), `seat_burn.py` projects the same
  meter from logs. Complementary by design (006's boundary note anticipated this tool);
  no merge candidate, but the meter formula now lives in two places (`model-tiers/005`
  and the tool) — the decision is the source of truth.

## 2026-10-18 — chunk: OpenCode Go usage footer (`d4cd160..` this landing)

1 landing: OpenCode Go plan usage in the footer's provider-quota slot
(`extensions/footer-session-id.ts` Go section + `tests/footer-opencode-usage.test.ts`),
per `decisions/external-tools/006`.

### Growth

| file | now | base (`d4cd160`) | Δ |
|---|---|---|---|
| `extensions/footer-session-id.ts` | 1633 | 1456 | **+177** (file already on the large-file watchlist — see 2026-10-03 entry) |
| `tests/footer-opencode-usage.test.ts` | 240 | — | +240 (new) |

### Unification

- z.ai/MiniMax percent-color thresholds were two inline IIFEs; now one
  `colorUsedPct` helper at three call sites (the new Go renderer included).
- Go usage renders through the existing quota segment slot + refresh cycle
  (`refreshQuotaNow`) rather than a parallel footer mechanism; a standalone
  extension could not compose into the footer anyway (single `setFooter` owner).

**Extraction candidate carried forward:** the quota/z.ai/MiniMax/Go block
(~400 lines of fetch + normalize + render) is the natural split of
`footer-session-id.ts` into `extensions/lib/quota.ts` if the file keeps growing;
deferred until a second consumer or another provider lands.

## 2026-10-13 — chunk: todo extension retired (`126d9bf..` this landing)

1 landing: the `todo` tool, widget and `/todos` command removed
(`extensions/todo.ts` 530 lines, `tests/todo-injection.test.ts` 310,
`tests/todo-render.test.ts` 108, `docs/todo-injection-fix.md` 96), and the
instruction text that pointed agents at it now points at the session log's
state query (`decisions/todo/001`).

### Growth

| file | now | base (`126d9bf`) | Δ |
|---|---|---|---|
| `extensions/todo.ts` | — | 530 | **−530** (removed) |
| `tests/todo-injection.test.ts` | — | 310 | −310 (removed) |
| `tests/todo-render.test.ts` | — | 108 | −108 (removed) |
| `docs/todo-injection-fix.md` | — | 96 | −96 (removed) |
| `extensions/modes.ts` | 256 | 254 | +2 |
| `agents/bug-triage.md` | 121 | 120 | +1 |
| `docs/design/session-log-hooks.md` | 58 | 56 | +2 |

Net −1039 lines; no file grew beyond the instruction edits. `createPiStub`
copies 7 → 6 (`tests/todo-injection.test.ts:47` gone); bare `typebox`
importers 5 → 4 among top-level `extensions/*.ts` (7 → 6 across all extension
dirs, so `tests/setup.sh`'s typebox link stays). The top-1 file `extensions/subagent-async/index.ts` (4258
lines, 1082-line factory) is untouched this chunk.

### Unification

- **Landed — one work-list mechanism.** The in-session todo state (tool +
  widget + `/todos`) was a parallel record of what the session log already
  tracks; it is gone, and `summary --session <id> --current` is the single
  state query. The deletion is negative growth by construction.
- **Carried forward unchanged:** `createPiStub` extraction (now 6 copies),
  the `test-workorder-policy.cjs` mirror fold, the `review_policy` single
  resolver, the `model-tiers` `†` helper.

## 2026-10-08 — chunk: work-order grammar landing (`16eb6fe..` this landing)

2 commits, 1 work item: the audit artifact itself (`71bd902`) plus the
decision-032 work-order grammar (bare-bold `review_policy` accepted, one
resolver for all three gate sites, mirror synced, `implement` allowlist widened).
Measurements from git refs / `wc` / brace-matched spans. Excluded, as in the
entry below: another session's uncommitted `extensions/auto-checkpoint.ts` +
`tests/auto-checkpoint.test.ts`, `settings.json` (owner's model switch), and the
untracked `agents/scout-sweep.md` — the table covers only this chunk's files.

### Growth

| file | now | base (`71bd902`) | Δ |
|---|---|---|---|
| `extensions/subagent-async/index.ts` | 4258 | 4251 | **+7** |
| `extensions/subagent-async/test-workorder-policy.cjs` | 411 | 302 | **+109** |
| `tests/work-order-policy.test.ts` | 132 | 69 | +63 |
| `tests/work-order-policy-wiring.test.ts` | 268 | — | new |
| `tests/discover-agents-cache.test.ts` | 336 | 322 | +14 |

Functions: the top-1 file's factory is still **1082 lines** (3177–4258, shifted
+7) and `spawnSubagent` still **664** (1731–2394) — the +7 net landed in the
module-scope parser block, so the delta grew neither large function. The mirror's
+109 is the second implementation's tax, acknowledged in decision 032 with a
reopening trigger. One work item touched `index.ts` this chunk — no churn smell.

### Unification

- **Landed — previous candidate 3.** `review_policy` is now one dash-optional
  `POLICY_BOLD_RE` + one `POLICY_YAML_RE` + one `parseWorkOrderPolicy` + one
  `taskDeclaresPolicySkip`; the gate fallback and the injection detector call the
  detector instead of carrying byte-identical private regexes.
- **Half-landed — previous candidate 2.** The mirror learned the YAML
  alternative it had drifted away from (the stale claim in the entry below) and
  gained precedence/first-token rows; the fold onto shared logic stays open, and
  the mirror is still not wired into any runner — its filename matches none of
  bun's test patterns (`.test.*` / `_test_*` / `.spec.*`) and no runner
  references it.
- **Worsened — previous candidate 1.** `createPiStub` is now in **7** test files
  (the new wiring file adds a minimal copy). Extract before the next test-heavy
  chunk.
- **New seam worth watching (not yet a candidate).**
  `tests/work-order-policy-wiring.test.ts` spawns a stand-in `pi` script (holds
  the RPC pipe open, no model call) so the real `subagent.execute` gate and
  injection paths are assertable cheaply. First occurrence — generalize from it
  rather than copying it if a second file needs it.

### Extraction candidates (carried forward, ranked)

| # | candidate | status |
|---|---|---|
| 1 | shared test `createPiStub` helper, called from all test files | open — now 7 copies |
| 2 | fold `test-workorder-policy.cjs` onto shared logic | open — YAML drift closed by decision 032 |
| 3 | one `review_policy` resolver for the three sites | **landed** (decision 032) |
| 4 | model-tiers `†` mark + legend helper | open (details in the entry below) |

## 2026-10-08 — chunk: WO-2026-052 → decision 031 (`4cdce3b..16eb6fe`)

25 commits, 12 source files, **+2153/−314** lines (vendored code excluded;
`extensions/auto-checkpoint.ts` + its test excluded — another session's
uncommitted work). Measurements from git refs, spot-checked against `wc`/Node.
This is the baseline entry: there is no prior snapshot, so deltas are against
`4cdce3b` (the WO-2026-052 landing), not against a previous entry.

### Growth

Top 10 `.ts` files, current vs `4cdce3b` (`git show 4cdce3b:<path> | wc -l`):

| # | file | now | base | Δ |
|---|---|---|---|---|
| 1 | `extensions/subagent-async/index.ts` | 4251 | 4039 | **+212** |
| 2 | `extensions/subagent-async/watch-session-v2.ts` | 1675 | 1675 | 0 |
| 3 | `extensions/footer-session-id.ts` | 1456 | 1456 | 0 |
| 4 | `tests/subagent-id-resolution.test.ts` | 769 | 492 | **+277** |
| 5 | `extensions/checkpoint.ts` | 726 | 726 | 0 |
| 6 | `tests/activity-timeline.test.ts` | 716 | 716 | 0 |
| 7 | `extensions/model-tiers/index.ts` | 707 | 704 | +3 |
| 8 | `tests/peer-link.test.ts` | 621 | 621 | 0 |
| 9 | `tests/e2e-checkpoint.test.ts` | 601 | 601 | 0 |
| 10 | `extensions/rules.ts` | 600 | 520 | +80 |

Growth concentrated in the repo's top-1 file (+212) and its largest test file
(+277). Also grew >100 below the top 10: `tests/model-tiers-render.test.ts`
156→427, plus new files `tests/subagent-model-inheritance.test.ts` (431),
`tests/rules-refresh.test.ts` (311), `tests/subagent-resume-cwd.test.ts` (208).
The three already-top-5 files that did not move (`watch-session-v2.ts`,
`footer-session-id.ts`, `checkpoint.ts`) carry large functions — 422 and 306
lines in the two unchanged extensions — but no delta risk.

Functions over ~150 lines in the files the delta touched (brace-matched):

| function | span | lines | changed by delta? |
|---|---|---|---|
| `subagent-async/index.ts` `export default function (pi)` | 3170–4251 | **1082** | yes — 13 hunks land inside it |
| `subagent-async/index.ts` `spawnSubagent` | 1724–2387 | **664** | yes — 3 hunks (model resolution, args, prompt) |
| `subagent-async/index.ts` `processLine` (nested in `spawnSubagent`) | 1973–2262 | 290 | no |

The largest function in the repo is a single 1082-line extension factory; the
delta added to it rather than through it.

**Duplication introduced or still present inside the delta:**
- `review_policy` is matched by three separate regexes — `parseWorkOrderPolicy`
  (`index.ts:1656-1661`), the task-text gate fallback (`index.ts:1823`), and the
  skip-injection detector (`index.ts:3422`, byte-identical to 1823). See
  Unification below.
- `createPiStub` exists in 6 test files, 3 of them added by this delta:
  `tests/subagent-id-resolution.test.ts:409`, `tests/subagent-resume-cwd.test.ts:154`,
  `tests/subagent-model-inheritance.test.ts:188`, plus pre-existing copies in
  `tests/subagent-async-kill.test.ts:203`, `tests/todo-injection.test.ts:47`,
  `tests/subagent-session-lifetime.test.ts:90`.
- `extensions/model-tiers/index.ts`: the missing-axis `mark` ternary at `:468`
  and `:512`, with the same `†` legend dimmed at `:480` and `:522`.

**De-duplication the delta itself performed** (the counter-trend): one
`findRunningByQuery` replaces two identical running-map loops; one
`resolveChildModel` replaces two `effectiveModel` computations; one
`describeUnknownSession` replaces four copies of the not-found string; one
`scoreRows` replaces `scoreModels`/`scoreAllModels`; one `applyFreeCutoff`
replaces two inline cutoffs. Removed dead code: `UPCOMING_OPEN_WEIGHTS`,
`contextTier`, `paretoFilter3D`. No dead code found in the delta.

**Churn** (commits per file in the delta, max 4 in the whole range):

| file | commits | work items |
|---|---|---|
| `tests/model-tiers-render.test.ts` | 4 | one (model-tiers rework) |
| `extensions/subagent-async/index.ts` | 3 | **three distinct** — `f864339` id resolution, `65bef12` resume cwd, `ed1c0a4` decision 031 |
| `extensions/model-tiers/index.ts` | 3 | one (model-tiers rework) |
| `tests/subagent-nesting.test.ts` | 2 | two (same 028 topic) |
| `extensions/rules.ts` | 2 | two — line cap, re-read at injection |

Only `subagent-async/index.ts` served unrelated work items (3) — and it is also
the top-1 largest file and the largest function's home. That is the boundary
smell this audit exists to catch.

### Unification

**`review_policy` has three parse sites and two accepted grammars.** The sites
answer different questions, but the task-text pair is a literal duplicate:

- `index.ts:1656` `parseWorkOrderPolicy` — accepts the canonical bullet
  `/^\s*-\s*\*\*review_policy\*\*:\s*(\S+)/m` **or** the YAML line
  `/^review_policy:\s*(\S+)/m`; first token `=== "skip"`.
- `index.ts:1823` gate fallback — `/^\s*-\s*\*\*review_policy\*\*:\s*skip\b/m`
  on the task text, only when no WO is present.
- `index.ts:3422` injection detector — the same regex, deciding whether the task
  already carries the skip bullet.

Measured behavior (Node, one encoding per row):

| input | parse (`:1658`) | gate (`:1823`) | inject-detect (`:3422`) |
|---|---|---|---|
| `- **review_policy**: skip` | skip | true | true |
| `**review_policy**: skip` (no dash) | required | false | false |
| `review_policy: skip` (YAML) | **skip** | false | false |
| `- **review_policy**: required` | required | false | false |
| `- **review_policy**: required \| skip` | required | false | false |

The bare-bold row is a silent mis-read (a peer hit it in another repo: the WO
declared `skip`, the gate stayed live, and the tool param cannot override a
present WO by design — decision 014). The YAML row shows the gate and injection
sites do not accept the encoding the parser does; only the parser's first form
is mirrored by the task-text sites.

**Second implementation of the same logic:** `extensions/subagent-async/test-workorder-policy.cjs`
(302 lines) mirrors the parser (`:41`), the skip-bullet regex (`:49`), the gate
computation (`:56`) and the injector (`:70`) with `KEEP IN SYNC` contracts,
because plain `node` cannot import `index.ts` (typebox/`@earendil-works/*`
resolve only under jiti). It is a manual fixture (`node <file>`), referenced
only by WO-2026-033/035/037 as a required test boundary — no runner wires it in.
It is **already stale**: its parser has no YAML alternative, so it reads
`review_policy: skip` as `required` where production reads `skip`.

**Checked and not found duplicated** (recorded so the next audit does not redo
the search): model-spec splitting (`splitModelSpec` is the only
`lastIndexOf(":")` in `extensions/` + `apps/`); argv building
(`buildSubagentArgs`) and meta building (`buildSpawnMeta`); model resolution
(`resolveChildModel` is now the single source for both spawn args and
`meta.json`); resume validation (`validateResumeMeta`, module scope);
session-header reading (`readSessionCwd` is the only header-cwd parser —
`footer-session-id.ts` takes header/entries as arguments and `checkpoint.ts`
never parses a pi session header).

### Extraction candidates (ranked by lines-removed × risk)

| # | candidate | lines removed | risk | owner |
|---|---|---|---|---|
| 1 | Extract the shared test `createPiStub` into one `tests/` helper, called from all 6 files | ~25 (3 delta copies), ~44 if the 3 pre-existing copies collapse too | low — test-only, no production blast radius | test-infra cleanup |
| 2 | Fold `test-workorder-policy.cjs`'s mirrored parser/gate/injector onto shared logic (or at minimum sync its YAML gap) | ~35 mirrored lines | medium — node-only harness by design, cross-file coupling, no automated runner | review-policy harness |
| 3 | One `review_policy` resolver for the three sites (shared bullet regex + a `hasSkipBullet` used by `:1823`/`:3422`), which is also the single place the bare-bold gap closes | 1–3 regex lines; closes a silent mis-read | low — `tests/work-order-policy.test.ts` covers the parser | subagent review-policy |
| 4 | One helper for the `model-tiers` `†` mark + legend at `:468/:480/:512/:522` | ~2–3 | low — pure render, covered by `tests/model-tiers-render.test.ts` | model-tiers render |

Candidate 3 is coupled to the pending owner ruling on the work-order grammar
(bare-bold acceptance); candidate 2 rides with it.

### Limits

Negative claims are scoped to the files searched: `apps/changelog-gen`,
`extensions/peer-link` and `watch-session-v2.ts` were not read for duplication
beyond the searches above. Candidate 1's spans and candidate 3's regex lines
were counted; candidates 2 and 4 are structural estimates from matched spans.
The working tree was not read (another session's WIP excluded by instruction).
