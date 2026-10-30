# Work Order: Checkpoint summary schema, compaction observability, git-ref binding

### Metadata

- **work_order_id**: WO-2026-056
- **parent_plan_id**: checkpoint-sanity-check-2026-10 (see `docs/investigations/checkpoint-sanity-check-2026-10.md` §3 rows 4/5/8, §6 item 4)
- **sequence_position**: 4 of 5 (1 landed: WO-2026-055; 2 and 3 blocked on owner rulings; 5 blocked on owner ruling)
- **routed_to**: implement
- **invariant_exhaustiveness**: explicit
- **priority**: normal
- **estimated_complexity**: moderate
- **review_policy**: required

### Task Summary

**One-sentence description**: Give the checkpoint tools a fixed summary schema (goal / files touched / decisions / tried-and-failed / next steps / constraints), record token counts and the git ref at checkpoint time, and surface both in the completion notify and archive meta.

**Goal**: The `summary` the compaction window receives is schema-shaped (including a required tried-and-failed field), and every archive carries an observability record (summary + token delta) and an environment binding (git HEAD), per the best-practice rows the sanity-check found unmet.

### Premise

Pi's `CompactionEntry` carries `tokensBefore` (stated in `docs/investigations/checkpoint-sanity-check-2026-10.md` §4). Falsify probe: `rg -n "tokensBefore" node_modules/@earendil-works/pi-coding-agent/dist -g '*.d.ts'`. If it does not exist in the pinned pi, stop, report `PREMISE FALSIFIED` with the evidence; nothing lands.

Post-compaction token count: **discover, don't assume** — probe `session_compact` event fields, the `ctx.compact()` result/`onComplete` signature, and `agent.state` for a retained/post count (`rg -n "tokensAfter|retainedTokens|tokens" node_modules/@earendil-works/pi-coding-agent/dist/core/extensions/types.d.ts`). If no post count is reachable anywhere, record `tokensBefore` alone, say so in the notify text and meta (`tokensAfter: null`), and name the gap in the completion report. Do not fabricate or estimate a number.

### Preparatory refactor

**`none`** — the meta object is written at one site (`archiveSession`), the notify at one site (`onComplete` in the `turn_end` handler), and the tool schemas at two `registerTool` sites that each need their own change. The one new shared piece (a summary renderer) has exactly one definition and its three consumers (compaction `customInstructions`, meta, fork message) are specified below — that is one path by construction, not a copy.

### Rejected alternatives

None from owner rulings. Note: the **summary-ownership question (verbatim agent summary vs fleet-summarized via `compaction-model`) is an open owner question** (sanity-check §7, asked 2026-10-21) — this order must not pre-empt it either way.

### Scope

**Invariants** (the blast radius):
- The compaction trigger boundary and orphan-toolResult pairing semantics are untouched (`decisions/checkpoint/001-orphaned-tool-result-repair.md`): `turn_end` deferral, one compaction per turn, last-request-wins, failure-clears-pending. The existing trigger/pairing rows pass unchanged.
- `[CHECKPOINT]` marker semantics unchanged — the marker still prefixes the summary text in `customInstructions`. (Reason-based dispatch is order 2, pending the owner ruling.)
- Archive `.jsonl` format unchanged (message entries, thinking stripped). Only the **meta** object gains fields, additively.
- The `checkpoint_fork` flow (stage + `/go`) and `/checkpoints` display keep working.
- Injection budget (15% of `ctx.model.contextWindow`) and injection behavior untouched (WO-2026-055).
- `continue`/`nextSteps` kickoff behavior unchanged: `continue` defaults true; the kickoff prompt is the `nextSteps` param, default "Continue work", delivered as the follow-up message.

**Files expected to change**:
- `extensions/checkpoint.ts` — summary schema on both tools; one `renderSummary()` helper; meta gains summary fields + observability + git binding; notify gains the token delta; `/checkpoints` adapts to the richer meta.
- `tests/e2e-checkpoint.test.ts` — tool call sites updated to the new schema (expected — see matrix row S10); new rows for the schema, observability, and git binding.
- `README.md` — tool surface documents the new `summary` schema.

**Files to read (reference only)**:
- `docs/investigations/checkpoint-sanity-check-2026-10.md` — §3 rows 4/5/8 (what best practice requires), §6 item 4 (the approved scope).
- `node_modules/@earendil-works/pi-coding-agent/dist/core/extensions/types.d.ts` — `session_compact`/compaction types for the token-count discovery.

**Files NOT to modify**:
- `extensions/compaction-model.ts` — summary ownership is an open owner question (order 2).
- `extensions/auto-checkpoint.ts` + `tests/auto-checkpoint.test.ts` — another session's uncommitted WIP.
- `settings.json`, `decisions/settings/**` — another session's uncommitted work.
- `work-orders/**`, `decisions/**` — frozen; decision writes are the orchestrator's job.

**Out of scope**: summary ownership (`compaction-model` / load order / `[CHECKPOINT]` reason-based dispatch — order 2); `context`/`message_end`-based injection delivery; `checkpoint_fork`'s fabricated assistant message's invented `api`/`provider`/`model` fields (§3 row 1 exception — a separate item, do not fix here); pi upgrade.

### Implementation Specification

1. **Summary schema**: both tools' `summary: Type.String` becomes `summary: Type.Object` with required fields — `goal` (one paragraph: what this checkpoint is accomplishing), `filesTouched` (array of repo-relative paths), `decisions` (array; `["none"]` when none), `triedAndFailed` (array entries naming an approach tried, what happened, and why it failed; `["none"]` when none), `constraints` (string; `"none"` when none). The existing `nextSteps` string param stays as the kickoff prompt — it covers the schema's "next steps" slot; do not add a second next-steps field. All fields are **required** (the typebox schema enforces presence — that is the rule-5 point: the fresh window must see tried-and-failed, and a field the model can omit is a field it will omit). Empty means the literal `"none"`/`["none"]`, not an absent key.
2. **One renderer**: a single `renderSummary(fields, nextSteps)` function produces the canonical text (sectioned: `Goal:`, `Files touched:`, `Decisions:`, `Tried and failed (and why):`, `Constraints:`, `Next: …`). Its three consumers: `customInstructions` (prepended by `${MARKER}\n`, unchanged shape), `meta.summary` (so `/checkpoints`'s first-line display and the fork message keep working), and `checkpoint_fork`'s sent text message. No consumer formats its own copy.
3. **Observability**: at `archiveSession` time the meta gains `summaryFields` (the structured object), `summary` (rendered text — keep the field for `/checkpoints` back-compat), and `tokens: { before, after }` (`after` null when pi exposes nothing — see Premise). The `Checkpoint complete` notify includes the delta when `after` exists (`before → after (±N)`), otherwise just `before`.
4. **Git binding**: meta gains `git: { head, branch, dirty }` captured at checkpoint time via `git rev-parse HEAD` / `git rev-parse --abbrev-ref HEAD` / `git status --porcelain` in the session cwd (cap the porcelain output at, say, checking emptiness for `dirty`). Non-git cwd or any git failure → `git: null`; never fail or delay the checkpoint for git (tolerance matches the existing archive-failure path). `checkpoint_fork`'s archive binds the **source** cwd's ref and records `newCwd` in meta.
5. **`/checkpoints`**: display adapts to the richer meta (first line still the summary's first line — the rendered `Goal:` line reads fine; optionally show the git short-hash). Keep output compact.

**Required test boundary**: the deterministic handler harness in `tests/e2e-checkpoint.test.ts` (real extension, captured `ctx.compact`/notify) calling the real `checkpoint`/`checkpoint_fork` tool schemas and reading the real written meta files. Unit rows may supplement (e.g. `renderSummary` output) but the schema enforcement, meta content, and notify text are asserted through the real tool path.

### Behavior and failure matrix

| # | Case | Expected |
|---|---|---|
| S1 | All summary fields provided | `customInstructions` = `[CHECKPOINT]` + rendered sections incl. `Tried and failed (and why):`; meta carries `summaryFields` + rendered `summary` |
| S2 | `triedAndFailed: ["none"]`, `decisions: ["none"]`, `constraints: "none"` | Accepted; rendered as-is |
| S3 | A required summary field omitted from the tool call | Typebox schema rejects the call — pin that the schema (not a runtime check) enforces presence |
| S4 | `nextSteps` omitted | Kickoff defaults to "Continue work" (unchanged) |
| S5 | `continue: true` with fields set | Follow-up message = injection + rendered `Next:` kickoff + archive line — content-identical in shape to today's (regression pin for the kickoff contract) |
| S6 | Token delta in notify | `after` exposed by pi → notify shows `before → after (±N)`; not exposed → notify shows before only, `meta.tokens.after` is null (and the report names the gap) |
| S7 | Meta observability | `meta.tokens.before` always recorded when pi exposes it; summary in meta readable by `/checkpoints` first-line display |
| S8 | Git cwd | `meta.git = { head, branch, dirty }` matches `git rev-parse` at checkpoint time |
| S9 | Non-git cwd (or git binary failure) | `meta.git = null`; archive still written; checkpoint proceeds |
| S10 | Existing e2e rows | Trigger/pairing/injection rows pass unchanged; tool **call sites** updated to the new `summary` object shape is expected and is not a behavior change — if any assertion (not call site) must change, stop and report why |
| S11 | Fork archive | Meta binds source cwd's git ref and records `newCwd`; fork message text = rendered summary |
| S12 | Marker/ownership untouched | `customInstructions` still starts with `[CHECKPOINT]` and carries the summary text; `compaction-model.ts` behavior unchanged (its override still keyed on `session_before_compact` results) — pin with a row asserting the marker prefix |

Novel exposure note: S3 is the row that makes the schema load-bearing (pre-change, a missing field was just a thinner string); S6/S7/S9 exercise meta fields that never existed, so both the populated and null shapes need rows — the null path is the one that will silently regress.

### Representation-level checks

- One renderer, three consumers: `rg -n "renderSummary|Goal:|Tried and failed" extensions/` shows the section formatting only in the renderer.
- Meta keys additive only: the old keys (`timestamp`, `sessionId`, `archivePath`, `summary`, `entryCount`) all still present (asserted in rows).

### Integration contract

- `pendingCheckpoint.summary` becomes the structured fields + rendered text as needed by `customInstructions` and the follow-up message; `PendingCheckpoint`'s shape may grow but its lifecycle (set in `execute`, consumed in `session_before_compact`/`onComplete`, cleared on success/failure) is unchanged.
- `archiveSession`'s signature may grow a meta-extras parameter; it stays the single archive writer.

### Invariants

**Cross-file conventions**: typebox `Type.Object` schemas (existing style); `bun:test` tests; README's tool surface updated in the same change as the schema (WO-2026-055 established that discipline).

**Default values preserved**: `continue` defaults true; `nextSteps` default "Continue work"; injection budget 15%; archive thinking-stripping.

**Ordering assumptions**: `archiveSession` runs before `ctx.compact()` (entries captured in full) — the git/tokens capture happens in the same `execute` call, before compaction, at the time the archive is written.

**Error handling**: git and archive failures are non-fatal (notify `warning`, checkpoint proceeds) — match the existing archive-failure tolerance. Schema violations are the model's error and surface as tool-call rejection.

### Verification Criteria

- `bash tests/setup.sh` then `bun test tests/e2e-checkpoint.test.ts` — all green including S1–S12 rows.
- `bun test` full suite — the same pre-existing failure set as at `59655ec` (11 env failures in `subagent-model-inheritance`/`work-order-policy-wiring`/`work-record-capture`, handed to `bug-triage`); nothing new fails.
- S3 demonstrably rejects (a hand-built call without `triedAndFailed` fails validation) — state in the report how it was checked.
- S6's two shapes both exercised (or, if pi exposes no post count, the single shape + the named gap).
- `rg "Tried and failed" extensions/` — formatting only in the renderer.

### Structural Risks

- [x] **Route/path correctness**: both `checkpoint` and `checkpoint_fork` get the schema (two producers of summaries — both must render through the one renderer; assert via both tools' rows).
- [x] **Input validation scope**: required-but-"none"-able fields — accept `["none"]`, reject absent (S2/S3).
- [x] **Test surface**: rows drive the real tool schemas and real meta files (S1–S12).
- [x] **Recovery logic**: git/archive failure tolerance (S9) — no crash, no block.
- [x] **No unrequested changes**: listed NOT-to-modify files untouched.
- [x] **Build config untouched**: no `package.json`/`bun.lock` changes.
- [x] **No unsolicited features**: no ownership changes, no injection changes, no fork-message fabrication fix.
- [x] **No parallel path**: one renderer; meta written at one site.

### Context

**Prior work**: WO-2026-055 (landed `af2733a`+`59655ec`) — injection works and is guarded; read tracking lives in `extensions/lib/read-tracking.ts`. WO-2026-052 (`776ed7f`) — the `turn_end` deferral + pairing; preserve.

**Upcoming**: order 2 (summary ownership — owner ruling pending; it changes *whose* summary lands in the window, not the schema this order defines), order 3 (drift decision record — owner ruling pending), order 5 (pi upgrade evaluation — owner ruling pending). Do not pre-empt any.

**Relevant decisions**: `decisions/checkpoint/001-orphaned-tool-result-repair.md`; the field list is owner-approved via the sanity-check report §6 item 4 (user: "start any work needed", 2026-10-21).

### Completion Report Format

Standard: status / invariant_exhaustiveness / files_modified / tests / structural_checks / deviations_from_spec / notes_for_orchestrator, plus assumptions_made / unexpected_changes / issues_encountered / test_coverage / adversarial_reviews / review_cap_reached / accepted_notes. Name the S-rows in the tests section.

---

**Landing stamp (2026-10-21, `f2cbcbc`)**: landed as specified with one recorded
re-derivation — the ordering assumption "git/tokens capture in `execute`" holds
for `git` and `tokens.before`, but `tokens.after` is patched into the meta from
`ctx.compact(...).onComplete` because pi exposes it only as
`CompactionResult.estimatedTokensAfter` there. Do not "fix" the patch back into
`execute` in a future order: the timing is pi's API shape, not a defect.
