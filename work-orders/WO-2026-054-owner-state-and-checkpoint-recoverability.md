# WO-2026-054 — Owner state by row id + checkpoint recoverability (tfd process-controls R3, R4, R6)

### Metadata

- **work_order_id**: WO-2026-054
- **parent_plan_id**: tfd-process-controls-2026-10-19 (R3, R4, R6; family policy with R8, ruled 2026-10-08)
- **sequence_position**: 1 of 1 (single landing; R5 is a tfd-repo change, not ours)
- **routed_to**: implement
- **invariant_exhaustiveness**: implicit
- **priority**: critical
- **estimated_complexity**: complex
- **review_policy**: required

### Task Summary

Implement three owner rulings (tfd `docs/reviews/process-controls.md` R3/R4/R6, ruled 2026-10-19,
recorded at tfd `0d53f8f9`) in the pi-config harness: checkpoint recoverability for in-flight
subagents, an `owner_asks` registry-id field on completion reports with a gate that refuses free
text, and a bar on owner-state prose in checkpoint `nextSteps`.

**Goal**: an owner ruling can never be invented or lost at the three hand-off points — checkpoint
summary, completion report, status tool — and a checkpoint with work in flight is recoverable.

### Premise

The enforcement surfaces are pi-config's: `subagent-async` creates and cleans up subagent
worktrees (`createWorktree`, `postDeliveryCleanup`), extensions can wrap tools (worktree-guard
wraps `read`/`write`/`edit`/`find`/`grep`), and every completion report is delivered through
subagent-async's completion path. Falsifier: if worktree creation or completion delivery turns
out to live in pi core with no extension hook, stop and report `PREMISE FALSIFIED` per surface
— land what remains reachable, name what is not.

### Rejected alternatives

- **R3 option 2 — deliver pending completions before archiving** (tfd process-controls R3, owner
  2026-10-19: option 1 adopted instead). Do not build completion delivery into checkpoint.
- **R4 option 2 / R6 option 2 — leave completion reports and `nextSteps` free** (same ruling
  family: the field and the bar are adopted).
- **Text-heuristic enforcement** (tfd R8, owner 2026-10-08: mechanical registry-tool gate adopted
  "not a text heuristic"). Where a check must classify prose, prefer form-and-existence checks
  against the repo registry; a phrase list alone is the rejected shape. R5's phrase-list widening
  is tfd-side and is not this work order.

### Scope

**Invariants**:
- 027's orphan-adoption gating is preserved exactly: adopt a subagent socket only when the
  spawning process is this process or is gone (`ownerPid` + `ownerStartToken`); a live foreign
  owner is skipped; legacy metas without `ownerPid` are skipped. Reaping must respect this gate.
- 026's post-disposal event semantics unchanged.
- worktree-guard's denylist behavior unchanged (other sessions' worktrees blocked; own worktree,
  `/tmp`, home writable).
- Checkpoint resume round-trip unchanged: the summary the tool stores must still parse back via
  the `customInstructions`/MARKER path; the existing three-part summary format stays the base.
- `preCommitSteps` carry-filter and `postDeliveryCleanup` behavior (WO-2026-035) unchanged
  except where the completion gate explicitly hooks in.
- Existing tests pass unchanged: `bun test tests/`, `node extensions/subagent-async/test-*.cjs`,
  `node extensions/worktree-guard.test.mjs` (or `bun test`, whichever the file declares). An
  existing test that must change means behavior changed — stop and report it.

**Files expected to change** (guidance, not a limit):
- `extensions/checkpoint.ts` — (R3-1) summary auto-appends an "In-flight subagents" section
  (session id + branch per live subagent) sourced from the subagent-async meta registry, not
  from model memory; (R6) `nextSteps` validation per spec below.
- `extensions/subagent-async/index.ts` — (R3-2) worktree lock/reap lifecycle in
  `createWorktree`/cleanup; (R3-3) four-state status vocabulary; (R4) completion-report
  `owner_asks` validation in the delivery path.
- `agents/implement.md`, `agents/orchestrator.md` — (R4) completion-report schema gains
  `owner_asks: <registry-file>#<row-id> | none`.
- New/extended regression tests alongside the existing `test-*.cjs` / `*.test.mjs` files.
- `decisions/subagents/039-*.md` — mechanism record citing the tfd ruling record (see
  Completion Report Format; write it as part of the landing).

**Files to read (reference only, do not modify)**:
- `/Users/scott/Developer/tfd/docs/reviews/process-controls.md` — the ruling record R3/R4/R6 (and
  R8 for the family policy). Absolute path is the sibling checkout of the tfd repo; read-only.
- `/Users/scott/Developer/tfd/docs/investigations/registry-and-root-diagnosis-findings.md`
  §Mechanism — the designs the rulings adopt (worktree locking, four-state vocabulary,
  report-field gate). Read-only.
- `decisions/subagents/027-recovery-scan-ownership.md`, `decisions/subagents/026-*.md` —
  behaviors that must not regress.
- `extensions/owner-asks/lib.ts` — the registry-id shape (`<file>#<id>`) already in use; R4
  validation must accept exactly this shape.
- `extensions/subagent-async/test-completion-filter.cjs` — the test convention (mirror helpers,
  real temp repos, real git) to follow.

**Files NOT to modify**:
- `extensions/owner-asks/*` — status-bar counter; consume its id shape, don't change it.
- `extensions/worktree-guard.ts` — unless the reap needs one exported predicate; if so, add it
  without touching existing blocking logic and list it under `unexpected_changes` with why.
- `models.json`, `settings.json`, `agents/*.md` other than the two named — not part of this WO.

**Out of scope**: R5 (tfd `scripts/docs_validate.py` — a tfd work order); R8's registry-tool
gate itself (ruled 2026-10-08, separate landing — but R4/R6 checks must be shaped to slot into
it: registry-row existence checks over prose heuristics); any pi-core change.

### Implementation Specification

**Detailed requirements**:

1. **R3-1 — checkpoint summary records in-flight subagents.** When `checkpoint` (and
   `checkpoint_fork`) archives a summary, the tool appends a machine-built section listing every
   live subagent: session id, worktree branch (from the meta registry), and state from the same
   evidence the status tool uses. The section is appended regardless of what the model wrote;
   the model's three-part summary is not the source of truth for in-flight work. Empty registry
   → section omitted.
2. **R3-2 — worktree lock lifecycle.** In `createWorktree`, immediately after `git worktree
   add`, run `git worktree lock --reason "pi-subagent <sid>"`. Unlock in the extension's own
   cleanup only after the completion is recorded. Effect: `git worktree remove --force` on an
   unaccounted tree fails loudly (git refuses force-remove of a locked tree), so a hand reap of
   a live child cannot destroy its work. The harness's own reap path unlocks first and removes
   only when the child is provably finished (completion recorded, or log's terminal line present
   — the same evidence as the status vocabulary).
3. **R3-2 — reap orphan worktrees on resume.** On the session-start recovery scan (the
   `recoverOrphanedSubagents` path), for each discovered subagent worktree whose child is dead
   per 027's gating: if the tree is clean relative to the preserved branch/commits (the carry
   flow already committed or preserved the work), remove it (unlock-then-remove); if it holds
   uncommitted bytes, leave the tree and surface it as `orphaned-resumable` with the
   `subagent_resume` call in the status text. Never force-remove a tree with uncommitted work.
4. **R3-3 — four-state status vocabulary.** The `subagent_status` answer (wrapped or extended)
   classifies by child-side evidence and names the evidence read: **running** (attached socket or
   log mtime fresh), **complete** (log's last line is the `── Completed …` footer), **orphaned**
   (no completion line, session file exists — resumable; print the `subagent_resume` call),
   **dead/unmatched** (no meta, or owner gone with no session file). The current "No running
   subagent found … may have already finished or been stopped" merge of complete/killed goes
   away; each answer names its cause.
5. **R4 — `owner_asks` on completion reports.** `agents/implement.md` and `agents/orchestrator.md`
   completion-report schema gains `owner_asks:` — either `none` or one or more registry row ids
   in `<file>#<id>` form (the shape `owner-asks/lib.ts` keys on). In subagent-async's
   completion-delivery path, validate the field: free text (an ask not in row-id form) means the
   report is **refused** — the reporter receives a rejection naming the rule and the expected
   form, and must reissue the report with the ask registered as a row first (or `none`). A report
   with no `owner_asks` line at all is treated as non-conforming and refused the same way, so the
   field is mandatory where an ask is born. The review-status gate (`requires_parent_reviewers`
   flow) must not treat a refused report as delivered.
6. **R6 — `nextSteps` bar on owner-state prose.** `checkpoint`/`checkpoint_fork` `nextSteps` may
   state owner state only by registry row id. Mechanism mirroring R5's adopted shape: if the
   `nextSteps` text asserts owner state (a ruling/answer/decision attributed to the owner), the
   assertion must carry a same-paragraph `<file>#<id>` row reference; assertions without one
   cause the tool call to fail with a message naming the rule and asking for the row id (or the
   claim's removal). Validate row-id **form** mechanically; if the cwd repo exposes a registry
   (`scripts/reviews_status.py`), also validate **existence** and name the row in the error.

**Required test boundary**: the extensions' own runnable surfaces — the checkpoint tool handler's
summary assembly + `nextSteps` validation function, the status-classification function, and the
completion-delivery validation function, each exercised through the existing test convention
(`test-*.cjs` against real temp git repos / real worktrees, mirroring helpers per the KEEP IN
SYNC pattern). For the lock lifecycle, the boundary is real git behavior in a temp repo: after
`createWorktree`, `git worktree remove --force` fails; after recorded completion cleanup, it
succeeds. Characterization rows for pre-change behavior come first where these paths are not yet
pinned.

**Behavior and failure matrix**:
- checkpoint with 0 / 1 / 3 live subagents → section omitted / lists each with id+branch+state.
- checkpoint summary round-trip: archived summary still restores via the MARKER path (existing
  resume tests unchanged).
- lock: fresh worktree force-remove fails; post-completion cleanup removes; cleanup failure
  (git error) degrades loudly, never silently unlocks.
- reap on resume: clean-dead tree removed; uncommitted-work tree kept and surfaced
  `orphaned-resumable` with `subagent_resume` call; live foreign owner skipped (027) and its
  tree untouched; legacy meta (no `ownerPid`) skipped and untouched.
- status: running / complete / orphaned / dead each produced from evidence; the dead case names
  its cause (unmatched id vs owner-gone) without asserting "finished or stopped" for a
  distinguishable case.
- `owner_asks: none` → accepted; `owner_asks: emitir-transport.md#E2` (well-formed id) →
  accepted; free-text ask → refused with the rule named; **missing field → refused** (the novel
  exposure: pre-change, reports without the field were fine; validate both shapes).
- `nextSteps` with no owner-state claim → accepted; owner-state claim with same-paragraph row id
  → accepted; owner-state claim without → tool error naming the rule; malformed id (no `#`)
  → tool error.
- Registry-existence check: repo with `scripts/reviews_status.py` names a missing row in the
  error; repo without it falls back to form-only validation (documented in the decision file).

**Integration contract**: meta registry (session id, ownerPid/ownerStartToken, branch) is
subagent-async's; checkpoint reads it read-only. Completion delivery remains the single funnel
for reports — the gate hooks there, nowhere else. The status wrapper composes with (not
replaces) 027's recovery scan.

**Reference patterns**: `extensions/subagent-async/test-completion-filter.cjs` (test style);
`extensions/owner-asks/lib.ts` (id shape); findings §Mechanism rows 2–4 (the ruled mechanisms).

### Invariants

**Cross-file conventions**:
- Registry row id form is `<file>#<id>` everywhere (owner-asks, `owner_asks`, `nextSteps`) — one
  shape, one validator; extract a shared helper rather than three regexes.
- Extensions wrap tools the way worktree-guard does; no core edits.

**Default values to preserve**:
- Checkpoint's existing summary format hint and the `nextSteps ?? "Continue work"` default.
- 027's adoption predicate and the unref() of recovered client sockets.

**Ordering assumptions**:
- Lock runs immediately after `worktree add`, before any child process can touch the tree.
- Unlock runs only after the completion is recorded (the proof an irreversible reap needs).
- The `owner_asks` check runs at delivery time, after the WO-unstage block and carry filter
  ordering established in WO-2026-035.

**Error handling conventions**:
- Failures inside cleanup/reap degrade via `debugLog`, never abort a session start or a
  completion that has already been recorded; a *refusal* (R4/R6) is loud and names the rule.

**Unspecified invariants** (implementer must enumerate):
- All call sites that construct or deliver a completion report (rg the delivery path) — the R4
  rule must hold on every one; enumerate them in the report, negative result valid.
- All places that emit `nextSteps` (checkpoint, checkpoint_fork) — R6 must hold on each.

### Verification Criteria

**Entry points that must work**: `checkpoint` / `checkpoint_fork` calls (summary + nextSteps
paths); `subagent_status` on: a live child, a completed child, an orphaned child, an unknown id;
completion delivery of a conforming and a non-conforming report.

**Input shapes that must be accepted**: reports with `owner_asks: none`; with well-formed ids;
summaries with zero live subagents; repos with and without a registry script.

**Tests that must pass**: `bun test tests/`; `node extensions/subagent-async/test-*.cjs`
(including new rows); the worktree-guard test unchanged. New rows must cover every matrix row
above at the stated boundary.

**Build requirements**: no new dependencies; TypeScript compiles as the existing extensions do
(jiti/typebox constraints noted in the test files apply).

### Structural Risks

- [ ] **Route/path correctness**: the gate hooks the completion-delivery funnel (one path), not a
  second parallel check in the agent prompts alone.
- [ ] **Input validation scope**: `owner_asks` accepts every id shape owner-asks emits; `none`
  is accepted; the validation must not refuse legitimate multi-ask reports.
- [ ] **Test surface**: tests drive the tool handlers/delivery path, not helper functions alone.
- [ ] **Recovery logic**: reap never runs on a tree whose child is unaccounted for; no
  force-remove of uncommitted work; unlock-before-remove ordering enforced.
- [ ] **No unrequested changes**: no R5, no R8 gate, no owner-asks edits.
- [ ] **Build config untouched**.
- [ ] **No unsolicited features**.

Each applicable box must be exercised by a named matrix row or the report says why not.

### Context

**Prior work in this plan**: none — this is the first landing of the 2026-10-19 process-controls
rulings. R8's gate (ruled 2026-10-08) is the family's mechanical anchor and lands separately.

**Upcoming**: R5 lands in tfd (`scripts/docs_validate.py`); the reviewer-seat trial (separate
stream, WO pending owner go) touches only `agents/review-*.md` model lines — do not anticipate
it.

**Relevant decisions**: subagents/026, 027 (recovery semantics — must not regress);
checkpoint/001 (orphaned tool result repair — same recovery family); work-order-records/001
(mentioned by owner-asks/lib.ts, unruled departures). The ruling record is tfd
`docs/reviews/process-controls.md` R3–R6 (owner, 2026-10-19) with R8 (owner, 2026-10-08) as
family policy.

### Completion Report Format

Standard schema (status / invariant_exhaustiveness / files_modified / tests /
structural_checks / deviations_from_spec / notes_for_orchestrator / assumptions_made /
unexpected_changes / issues_encountered / test_coverage / adversarial_reviews /
review_cap_reached / accepted_notes), **plus** the field this very work order adds:

- **owner_asks**: `none`, or `<file>#<id>` row ids — free text will be refused by the gate this
  work order builds.

Also required: the enumeration deliverables (completion-report producers; `nextSteps` emitters),
and a `decisions/subagents/039-*.md` draft recording the mechanisms chosen (lock/unlock proof,
four-state vocabulary, delivery-funnel gate, R6's same-paragraph shape) with the tfd ruling as
cited authority and the rejected text-heuristic shape noted.
