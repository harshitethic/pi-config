# Work Order: Un-break checkpoint file injection, make it trustworthy, and make its coverage honest

### Metadata

- **work_order_id**: WO-2026-055
- **parent_plan_id**: checkpoint-sanity-check-2026-10 (see `docs/investigations/checkpoint-sanity-check-2026-10.md` §5.1, §5.3, §5.4, §5.7, §5.8, §6.1)
- **sequence_position**: 1 of 5 (2: summary-ownership fix, pending owner ruling; 3: drift decision record, pending owner ruling; 4: schema/observability upgrades; 5: pi upgrade evaluation)
- **routed_to**: implement
- **invariant_exhaustiveness**: explicit
- **priority**: critical
- **estimated_complexity**: moderate
- **review_policy**: required

### Task Summary

**One-sentence description**: Fix the checkpoint extension's dead file-injection data paths via one shared read-tracking helper, add a staleness guard and snapshot label to the injection (per the 2026-10-21 utility evaluation), and rewrite the tests so injection coverage can fail.

**Goal**: `relevantPaths` file injection and preserved-tail skipping work against pi 0.83.0, injected content cannot mislead after file edits, and tests fail when any of that breaks. No second read-tracking implementation remains in `checkpoint.ts`.

### Premise

Pi's finalized tool args arrive on `tool_result` events as `input` (`ToolResultEvent`, `dist/core/extensions/types.d.ts`), and assistant tool-call blocks in session entries are `{type:"toolCall", name, arguments}` (`pi-ai/dist/types.d.ts` — `tool_use`/`input` exists only in pi's Anthropic wire adapter, never in session entries). Falsify probe: `grep -n 'type: "toolCall"' node_modules/@earendil-works/pi-ai/dist/types.d.ts` and check `ToolExecutionEndEvent` in `node_modules/@earendil-works/pi-coding-agent/dist/core/extensions/types.d.ts` (it must NOT carry `args`). If either shape differs in the pinned pi version, stop, report `PREMISE FALSIFIED` with the evidence; nothing lands.

### Preparatory refactor

**Refactor commit:** extract the read-region tracking + region merging + path normalization currently duplicated in `extensions/checkpoint.ts` (module-level readRegions map, merge/normalize helpers) into one shared module (e.g. `extensions/lib/read-tracking.ts`). Characterization tests first: unit-pin the pure functions (region merge across overlapping/adjacent offsets, path normalization relative to cwd) and the event-ingestion behavior currently observable through the existing deterministic handler-table harness (`tests/e2e-checkpoint.test.ts`, "compaction trigger boundary (deterministic, ctx.compact spy)"). At the base commit both extensions carry the identical broken `tool_execution_end` sourcing; the refactor must preserve that behavior exactly (existing tests pass unchanged at the refactor commit), then the change commit switches the sourcing. Same implementer, two commits, one review.

Do **not** fold `extensions/auto-checkpoint.ts` into the helper in this order — it carries another session's uncommitted work (see `docs/investigations/structure-trend.md`) and its migration is a separate follow-up pending owner ruling. Note this explicitly in the completion report.

### Rejected alternatives

- **Remove injection and replace with "re-read these files" instructions.** Measured against on 2026-10-21 (harness on branch `pi-subagent-49f05403b984`, `experiments/checkpoint-eval/`): the re-read-instruction arm tied injection on success (5/5 vs 5/5) at slightly lower content cost, but depends on model compliance (observed checkpoint-call and no-tools violations), while injection is deterministic. Owner-adjacent evaluation concluded "keep with changes"; re-read instructions remain the fallback if the staleness guard proves insufficient later. Do not rebuild this alternative in this order.

### Scope

**Invariants**:
- The orphan-toolResult pairing invariant (compaction deferred to `turn_end`, never mid-`execute()`) must not change — `decisions/checkpoint/001-orphaned-tool-result-repair.md`; existing pairing/spy tests pass **unchanged**.
- Archive format and location (`.pi/checkpoints/*.jsonl` + `.meta.json`, thinking stripped) unchanged.
- `checkpoint_fork`, `/checkpoints`, `/checkpoint` command behavior unchanged.
- Trigger-boundary semantics unchanged: one compaction per turn, last request wins, failure clears pending.
- Injection budget remains 15% of `ctx.model.contextWindow`.

**Files expected to change**:
- `extensions/checkpoint.ts` — migrate read tracking to `tool_result` `input`; migrate `getPreservedPaths` to `toolCall`/`arguments` blocks and `branchEntries`; add the staleness guard + snapshot label to `buildFileInjection`; remove dead `StrippedAssistant`; route tracking through the new shared module.
- `extensions/lib/read-tracking.ts` (new) — the shared helper; tracks `{path, offset, limit, mtimeMs, size}` per region (see M11).
- `tests/e2e-checkpoint.test.ts` — honest injection assertions (see matrix), remove the `checkpoint_search` describe and the name from `TOOLS`.
- `tests/read-tracking.test.ts` (new) — characterization + unit rows for the helper.
- `README.md`, `agents/orchestrator.md`, `agents/implement.md` — remove `checkpoint_search` references; README's tool surface must describe the two tools that exist (`checkpoint` without `newCwd`, `checkpoint_fork` with it) and drop the nonexistent fork-entry recording claim.

**Files to read (reference only)**:
- `docs/investigations/checkpoint-sanity-check-2026-10.md` — findings and the utility evaluation this implements (§5.1, §5.3, §5.4, §5.7).
- `decisions/checkpoint/001-orphaned-tool-result-repair.md` — the pairing invariant and its history.
- `node_modules/@earendil-works/pi-coding-agent/dist/core/extensions/types.d.ts` — `ToolResultEvent`, `SessionBeforeCompactEvent` (`branchEntries`), `ToolExecutionEndEvent` (no `args`).
- Branch `pi-subagent-49f05403b984`, `experiments/checkpoint-eval/` — the evaluation harness; borrow its arm-A/A2 structure for the honest e2e assertions (how needles are kept out of the kept tail and out of pre-compaction assistant text). Do not merge the branch wholesale; it is throwaway experiment code.

**Files NOT to modify**:
- `extensions/auto-checkpoint.ts` — another session's uncommitted WIP; its migration is a follow-up order.
- `extensions/compaction-model.ts`, `settings.json` — summary-ownership collision is pending an owner ruling (WO 2 of this plan).
- `work-orders/**` — frozen records.
- `decisions/**` — decision writes are the orchestrator's job.

**Out of scope**: summary schema upgrades, token-delta observability, git-ref binding in archive meta (§6.4), pi version upgrade, `compaction-model` load-order fix, `context`/`message_end`-based injection delivery (the synthetic user turn stays).

### Implementation Specification

1. **Characterization step 0**: unit-pin the pure read-region logic (merge of overlapping/adjacent `[offset, limit)` regions, path normalization relative to cwd) as it exists today. These rows must pass at the refactor commit and after.
2. **Refactor**: extract tracking/merging/normalization into `extensions/lib/read-tracking.ts`; `checkpoint.ts` imports it. No behavior change. Existing suite passes unchanged.
3. **Fix sourcing**: the tracker ingests finalized args from `tool_result` events' `input` (matching `toolName === "read"`, `input.path`/`offset`/`limit`), not `tool_execution_end.args`.
4. **Fix block matching**: `getPreservedPaths` matches `{type:"toolCall", name:"read"}` with `arguments.path`; scope the scan to the `branchEntries` provided by `session_before_compact` where available (fall back to `getEntries()` only if the event lacks them — say so in the report).
5. **Staleness guard** (from §5.7): each tracked region records the file's `mtimeMs`+`size` at read time. At injection time (`buildFileInjection`, which re-reads disk), compare current `mtimeMs`/`size` to the recorded values: on mismatch, do NOT serve the old line window; instead name the file in the injection footnote as `changed since read — re-read if needed`. (Evaluated alternative, rejected for this order: serve the current full file within budget — more tokens, and re-derives what to show. The footnote keeps the agent's re-read targeted.)
6. **Snapshot label**: the injected block's header must state it is a disk snapshot taken at checkpoint time, with regions selected from an earlier read — line numbers may have shifted. Keep it one line.
7. **Honest injection tests** (see matrix): the deterministic harness drives `tool_result` events and a `session_before_compact`, asserting injection content directly. The e2e "partial read" assertion must not be conditional on model compliance: assert on the injected user-message text (or the deterministic equivalent), and use the eval harness's kept-tail discipline (needle content kept out of the retained tail and out of pre-compaction assistant text) so the "answer from context" e2e can only pass via injection.
8. **Remove `checkpoint_search`**: drop the describe block and `TOOLS` entry; scrub references from `README.md`, `agents/orchestrator.md`, `agents/implement.md`.
9. **README tool surface**: describe the actual registered tools and their params; remove the claim that a fork entry is recorded on the old session.

**Required test boundary**: the existing deterministic handler-table harness in `tests/e2e-checkpoint.test.ts` (real extension, captured `ctx.compact`) extended with injection rows, plus the existing e2e session-driven flows made non-vacuous. Unit tests for the helper supplement but do not replace these.

### Behavior and failure matrix

| # | Case | Expected |
|---|---|---|
| M1 | Read tracked via `tool_result` with `input.path` | Region recorded; injected on checkpoint with that file in `relevantPaths` |
| M2 | File in preserved tail (read after `firstKeptEntryId`) | Skipped — not double-injected |
| M3 | File in `relevantPaths` but never read | Not injected (current semantics preserved) |
| M4 | Partial read (offset/limit) | Only read regions injected, with `[Ln-m of N lines. offset=…]` annotations; content outside the region absent |
| M5 | Injection budget exceeded (15% of context window) | Omitted paths named in the footnote; included paths still correct |
| M6 | `tool_execution_end` arrives with no `args` (pi's actual shape) | No crash; no region recorded from it (regression pin for the old shape) |
| M7 | Branched session with off-branch reads | Preserved-tail scan uses `branchEntries` only — off-branch reads do not cause skips |
| M8 | `checkpoint_search` | No test claims it exists; no code/docs reference remains |
| M9 | Existing rows: orphan pairing, own-result persistence, two-checkpoint-one-compaction, failure-clears-pending, trigger boundary | Pass **unchanged** |
| M10 | E2E "answer from injected context" with kept-tail discipline | Passes only if injection actually delivered the needles; fails otherwise |
| M11 | File changed after read (mtime/size mismatch) | Old line window NOT served; file named in a "changed since read — re-read if needed" footnote; unchanged files still injected normally in the same run |
| M12 | Line insertions before a tracked region (eval S2) | Covered by M11's guard (insertion changes mtime/size) — assert the shifted window is never served as if it were the read-time view |
| M13 | Session switch (`checkpoint_fork`) | New session's tracking starts empty; old session's regions not carried across the cwd switch |
| M14 | Injection block label | Header states: snapshot taken at checkpoint time, regions selected from an earlier read |

Novel exposure note: M2/M7 are the halves that were trivially right while dead (empty set everywhere); once sourcing is fixed they become live and must be pinned in both shapes (in-tail skip and cross-branch skip). M11–M12 guard a defect only observable once injection works at all.

### Representation-level checks

- The shared helper is the only module in `extensions/` that maps tool events/blocks to read regions: `rg 'tool_execution_end|toolCall.*read|tool_result' extensions/*.ts extensions/lib/*.ts` shows ingestion only in the helper (plus `auto-checkpoint.ts`, grandfathered until its follow-up — list it explicitly in the report if so).

### Integration contract

- `checkpoint.ts` consumes the helper via import; no API change to the `checkpoint`/`checkpoint_fork` tool schemas.
- The helper must not import pi runtime modules beyond types (keep it unit-testable).

### Invariants

**Cross-file conventions**: extension code follows the existing `checkpoint.ts` style (typebox schemas, `pi.on(...)` handler registration); tests use `bun:test` (the suite is bun-run, not vitest).

**Default values preserved**: injection budget 15% of `ctx.model.contextWindow`; `continue` defaults to true; archive thinking-stripping unchanged.

**Ordering assumptions**: `turn_end` handler ordering and the `session_before_compact` summary return shape unchanged — this order does not touch when compaction fires or whose summary wins.

**Error handling**: handler failures stay non-fatal (notify + clear pending), matching existing behavior; helper functions throw only on programmer error.

### Verification Criteria

- `bun test tests/e2e-checkpoint.test.ts tests/read-tracking.test.ts` all green (run `bash tests/setup.sh` first in a fresh worktree).
- `bun test` (full suite) green — no other test's expectations change.
- M1–M14 each map to at least one named test row in the report.
- `rg checkpoint_search` over the repo (excluding `work-orders/`, `docs/investigations/`, `decisions/`) returns nothing.
- The M10 e2e row demonstrably fails when injection is stubbed out, and the M11 row demonstrably fails when the staleness guard is removed (state in the report how each was checked — a control that silently no-ops proves nothing).

### Structural Risks

- [x] **Test surface**: injection rows go through the real extension handlers, not helper internals.
- [x] **No parallel path**: the helper replaces both copies in `checkpoint.ts`; no third copy added.
- [x] **No unrequested changes**: `auto-checkpoint.ts`, `compaction-model.ts`, `settings.json` untouched.
- [x] **Build config untouched**: no `package.json`/`bun.lock` changes.
- [x] **Recovery logic**: failure-clears-pending behavior preserved (existing rows).
- [x] **No unsolicited features**: no summary schema, no observability additions, no `context`/`message_end` delivery change.

### Context

**Prior work**: sanity-check investigation `docs/investigations/checkpoint-sanity-check-2026-10.md` (findings + utility evaluation this implements). WO-2026-052 landed the `turn_end` deferral + pairing tests (preserve unchanged).

**Upcoming**: summary-ownership order (owner ruling pending), drift-decision order (owner ruling pending), schema/observability upgrades, pi upgrade evaluation. Do not pre-empt any of them.

**Relevant decisions**: `decisions/checkpoint/001-orphaned-tool-result-repair.md` (pairing invariant, upstream ask open).

### Completion Report Format

Standard: status / invariant_exhaustiveness / files_modified / tests / structural_checks / deviations_from_spec / notes_for_orchestrator, plus assumptions_made / unexpected_changes / issues_encountered / test_coverage / adversarial_reviews / review_cap_reached / accepted_notes.
