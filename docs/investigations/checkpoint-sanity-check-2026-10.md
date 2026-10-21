# Checkpoint extension sanity check — 2026-10-21

Three-way comparison: the checkpoint extension vs. current (Aug–Oct 2026) best practice, and vs. pi's compaction system as it is now (0.83.0) versus when the extension was built (2026-04-13, pi 0.67.1).

Sources: extension audit + pi then-vs-now diff (both against installed pi 0.83.0 at `/opt/homebrew/lib/node_modules/@earendil-works/pi-coding-agent`; 0.67.1 pulled from npm as the April baseline) + web survey. Scout reports in session history; evidence citations inline.

## 1. Executive summary

**The design holds up; the implementation has rotted in two silent places.** The load-bearing choices — archive before compact, defer compaction to `turn_end`, never cut inside a tool group, hand the summarizer a verbatim summary — all match current best practice and are still correct against pi 0.83.0. The file-injection feature, however, is **silently inert**: both of its data-gathering paths read shapes pi never emitted (and one never had, even in 0.67.1), so `relevantPaths` injects nothing and preserved-tail de-duplication never fires. The e2e suite is green anyway because the assertions are doubly guarded and the needles survive in pi's kept tail. Two other live issues: `compaction-model.ts` overrides the checkpoint summary depending on fleet-auth availability, and the suite's `checkpoint_search` test passes vacuously for a tool that no longer exists.

Against best practice the extension is well-aimed — its injection mechanism *is* the "fresh minimal view" pattern the newest evidence favors — but the summary schema, dual-state binding, and observability fields current practice recommends are absent.

## 2. What the extension does (as built)

- `checkpoint` tool (`extensions/checkpoint.ts:414`): archives the session to `.pi/checkpoints/session-<id>-<ISO>.jsonl` + `.meta.json` (thinking stripped — archives are grep material, not replay material), stashes the request, and compacts from `turn_end` via `ctx.compact({customInstructions:"[CHECKPOINT]\n<summary>"})`. `session_before_compact` returns the agent's summary verbatim with `firstKeptEntryId` from `preparation`. On completion, optionally continues with `nextSteps` + file injection as a follow-up message.
- `checkpoint_fork` (`:504`): archive + switch to a new session in `newCwd` via a staged `/go`, appending a hand-built assistant message.
- `session_before_compact` (`:364`): for non-`[CHECKPOINT]` compactions (auto/threshold/overflow), archives silently instead.
- `auto-checkpoint.ts`: context-pressure nudger (thresholds, cooldowns, steer mid-run). Uncommitted working-tree changes add `tool_result.input` read tracking, a cross-run turn counter, and steer-mid-run.

## 3. Against current best practice (Aug–Oct 2026)

| # | Field rule | Status |
|---|---|---|
| 1 | Restore ≠ replay: project a fresh window (checkpoint ref + summary + preserved-recent) | **Mostly aligned.** Archives are non-replayable by construction (thinking stripped); restore = fresh compaction window + summary. Exception: `checkpoint_fork` fabricates an assistant message (`:600-616`) with invented `api`/`provider`/`model` fields — a schema assumption with no validation. |
| 2 | Append-only transcript; boundaries marked, patched at read time | **Aligned.** Pi's compaction appends a `CompactionEntry`; the extension never rewrites history. |
| 3 | Tool-call groups atomic by construction | **Aligned and load-bearing.** Pi never cuts at a `toolResult` (`dist/core/compaction/compaction.js:262-278`) and the `turn_end` deferral keeps the batch pairing intact (decisions/checkpoint/001). |
| 4 | Bind context state to environment state by shared id (dual-state alignment) | **Gap.** Archives capture messages only — no git ref / worktree state binding. Fork records `newCwd` but no environment snapshot. |
| 5 | Fixed summary schema incl. "tried and failed, and why" | **Gap.** `summary` is freeform; `nextSteps` optional. Nothing carries failed approaches; the field evidence says the fresh window will cheerfully retry them. |
| 6 | Drop, don't summarize, re-derivable state | **Aligned in intent** — file injection re-injects file regions as fresh views (Study K's winning pattern), and thinking/raw output is dropped. But the feature is inert (§5.1). |
| 7 | Idempotent restore + validity checks (TRAP) | **Partial.** Injection is additive and repeatable; no validity binding of restored content to its originating execution. |
| 8 | Observable compaction/restore (before/after token counts + summary) | **Partial.** `ui.notify` with archive path exists; no structured event/record of token delta or summary. |
| 9 | Exact facts live in files, not summary prose | **Aligned.** Archives + injected file regions carry exact content; summary is short. |

Field notes:
- Graduated compaction (cheap passes first, LLM summary last) is the consensus architecture; trigger thresholds diverge wildly (Gemini 0.5 vs Claude Code/Codex ~0.95) — no consensus to defer to for auto-checkpoint's threshold choice.
- Structured summaries beat freeform everywhere (Codex field list, Gemini XML, Microsoft typed message groups).
- Summary fidelity at small budgets is near-random for exact facts (arXiv 2608.01326: 15k items → random-guess recall at 14 kbit) — rule 9 is not optional.
- Compaction lifecycle hooks: Claude Code has `PreCompact`/`PostCompact`; MCP does not. Pi's `session_before_compact` / `session_compact` is comparable to Claude's hook pair and is used correctly in shape.

## 4. Pi compaction: then (0.67.1, 2026-04-13) vs now (0.83.0, 2026-07-29)

Pi's model is unchanged in shape: an entry-tree session log where a `CompactionEntry` (`summary`, `firstKeptEntryId`, `tokensBefore`) marks the boundary; context rebuild walks the leaf path and prepends a summary message. `CompactionPreparation`, `CompactOptions` (`customInstructions`/`onComplete`/`onError`), and the extension-provided-summary path are **byte-identical** between the two versions. No native checkpoint/restore/fork tool exists in either — the `checkpoint` tool family is ours alone.

Changes that matter to the extension:

| # | Change | Since | Impact |
|---|---|---|---|
| 1 | `reason: "manual"/"threshold"/"overflow"` + `willRetry` on compaction events | 0.79.10 | Our `[CHECKPOINT]` string-marker inference is now a redundant workaround; `reason` is a first-class discriminator. |
| 2 | `message_end` may replace the finalized message; `context` hook can replace the message array per call | post-April | Native injection seams exist; our synthetic user-turn injection is functional but suboptimal (it costs a fake user turn in the transcript). |
| 3 | Summary calls retry transient failures | 0.81.1 | Fewer half-archived aborted compactions. |
| 4 | Empty compactions refused (`prepareCompaction` → `undefined`) | 0.79.8 | `ctx.compact()` can now no-op where it used to "succeed" — `onComplete` semantics worth re-checking. |
| 5 | Queued messages during compaction flush correctly | 0.81.0 | The `onComplete` follow-up injection is no longer at queue-stick risk. |
| 6 | Cut points generalized (custom/branchSummary/compaction summaries count; split turns) | post-April | A restore/truncate assuming "cut = message entry" mismatches; we use `preparation.firstKeptEntryId`, so fine. |
| 7 | Context-visible custom messages count toward retained-token accounting | 0.80.4 | Injection budget math must account for injected text. |
| 8 | `ctx.compact()` mutates `agent.state.messages` in place — no session reload | same | The extension's "ctx stale after reload" guards defend against something that doesn't happen on this path (harmless belt-and-braces). |
| 9 | `turn_end` fires after all tool results persist | unchanged | The orphan-fix deferral remains correct and **necessary** — pi still has no orphaned-`toolResult` detection or repair in 0.83.0. |

Not present in installed 0.83.0 despite being documented in its own `docs/session-format.md`: `retainedTail`. The shipped docs describe a newer mainline than the shipped code. Installed tree is ~5 weeks behind npm latest (1.3.0). **Don't design against `retainedTail` until an upgrade is on the table.**

## 5. Findings

### 5.1 Live bug — file injection is silently inert (two dead paths)

1. `checkpoint.ts:308-311` reads `event.args?.path` from `tool_execution_end`. That event carries only `{toolCallId, toolName, result, isError}` — **in 0.83.0 and also in 0.67.1** (the emit site constructs exactly those four fields in both). Finalized args live on `tool_result.input` (`types.d.ts:691-698`). → read-region tracking records nothing → `buildFileInjection` hits its empty-regions guard (`:184-186`) and injects nothing for every `relevantPaths` entry.
2. `checkpoint.ts:125-127` (`getPreservedPaths`) matches `block.type === "tool_use"` with `input.path`. Pi's assistant block shape is `{type:"toolCall", name, arguments}` (`pi-ai/dist/types.d.ts:254`; `tool_use` exists only in pi's Anthropic wire adapter). → preserved-tail skip never fires.

Both are silent (empty set, not an error), which is why they persist unnoticed. The uncommitted `auto-checkpoint.ts` diff already migrated path 1 to `tool_result.input` — so the working tree ships one extension fixed and one broken against the same reality, and their duplicated read-region logic (`checkpoint.ts:70-99` vs `auto-checkpoint.ts:255-300`) has diverged. **Fix = one shared helper, migrate both (share code, don't parallel it).**

### 5.2 Live hazard — checkpoint summary can be overridden by `compaction-model`

`settings.json` loads `checkpoint.ts` before `compaction-model.ts`; pi's extension runner lets the **last non-null `session_before_compact` result win** (`runner.js:576-605`). `compaction-model.ts` returns the fleet model's own `{compaction}`, replacing the agent's verbatim summary and its `firstKeptEntryId`; the `[CHECKPOINT]` text degrades to a summarizer hint. If fleet auth fails, `compaction-model` returns `undefined` and checkpoint's result stands — **behavior flips on auth availability**. (Reasoned from runner/SDK source; not yet observed at runtime.) Use `reason` (change 1 above) and decide explicitly which extension owns the summary.

### 5.3 Green suite, inert coverage

`bun test tests/e2e-checkpoint.test.ts tests/auto-checkpoint.test.ts` → 21 pass. But:

- The injection assertion (`tests/e2e-checkpoint.test.ts:359-386`) is doubly conditional (`if (compactionCount === 0) return; if (injectedMessages.length > 0) …`) and **cannot fail** when injection emits nothing. "Compaction succeeds with file injection" asserts only compaction + archive + pairing.
- The "agent answers from injected context" needle test passes because the 5 haystack reads survive in pi's **kept recent tail** (`keepRecentTokens`) — the model answers from retained history, not from injection. Same for the `checkpoint_search` test's `found.length >= 1` (needles leak from setup chatter/kept tail).
- The `checkpoint_search` describe (`:392-427`) exercises a tool removed in `dd89c68`; `TOOLS` (`:43`) still lists it and unknown names are silently ignored.

The suite pins the orphan-pairing invariant well (`assertBranchToolCallPairing`, spy-boundary tests) — that part is real.

### 5.4 Fragile assumption — `getEntries()` vs `branchEntries`

`getPreservedPaths` and the archive sites scan `sessionManager.getEntries()` (all entries incl. abandoned branches) where `session_before_compact` provides `branchEntries`. On branched sessions, preserved-paths can over-skip and archives can include off-branch entries. Archive-everything is defensible for grep archives; preserved-paths should use `branchEntries`.

### 5.5 Doc/code drift

- `README.md:64` documents `checkpoint(summary, nextSteps?, continue?, newCwd?)` + a fork entry recording on the old session — neither exists (two tools; fork stages `/go`, appends nothing to the old session).
- `doCheckpoint()`, `checkpoint-continue`/`checkpoint-stop`, `isAbnormalStop`, context strip existed in `4611f42` and were removed by stash-recovery commit `9925257` (2026-07-10) with **no decision record**.
- `checkpoint_search` removed (`dd89c68`) but referenced in `tests/e2e-checkpoint.test.ts:43,392`, `agents/orchestrator.md:6`, `agents/implement.md:7`, `WO-2026-031:95`.
- Decision 001's orphan re-anchor repair is procedural only — no script implements it.
- `StrippedAssistant` (`checkpoint.ts:45-48`) is dead type residue.

### 5.6 Pipeline notes

- WO-2026-054's implementation (`f8bbbe6`) is on an unmerged side branch; `docs/TODO.md:216` correctly says "in flight".
- Installed pi 0.83.0 is ~5 weeks behind npm latest (1.3.0); the package's own docs describe features (`retainedTail`) its code lacks.

## 6. Verdict + recommended actions

The architecture is sound and, on the points that matter most (tool-group atomicity, append-only boundaries, archive-before-compact, informed continuation), at or ahead of field consensus. It is not safe to trust today because its second-most-important feature (informed file injection) is dead and untested.

Priority order:

1. **Un-break injection via one shared read-tracking helper** (characterization tests first): track reads from `tool_result.input`, match `toolCall`/`arguments`, use `branchEntries`. Migrate `checkpoint.ts` and `auto-checkpoint.ts` to it — the divergence is exactly the parallel-implementation failure the repo rules forbid. [addresses 5.1, 5.4]
2. **Make the injection tests able to fail**: assert injected-message content directly (deterministic spy path exists already for trigger boundaries), or shrink `keepRecentTokens` so needles cannot survive in the kept tail. Delete or revive the `checkpoint_search` block; drop the name from `TOOLS`, `agents/*.md`. [addresses 5.3]
3. **Resolve the summary-ownership collision** with `compaction-model.ts` (load order vs explicit `reason`-based dispatch) and replace the `[CHECKPOINT]` marker inference with `event.reason`. [addresses 5.2]
4. **Drift cleanup + decision record** for the `9925257` removals; fix README's tool surface. [addresses 5.5]
5. **Cheap best-practice upgrades** (one small order): summary schema for `checkpoint` (`goal / files touched / decisions / tried-and-failed / next steps / constraints`), token-delta + summary in the completion notify (observability), and bind the archive meta to the git HEAD at checkpoint time (dual-state alignment). [addresses §3 rows 4, 5, 8]
6. **Separately: pi upgrade evaluation** (0.83.0 → 1.3.x) — unlocks `reason`-era APIs (`message_end` replacement, possibly `retainedTail`), retires workarounds. Own work order; not a checkpoint fix.

Suggested sequencing: 1+2 as one work order (refactor-first: the shared helper is the preparatory refactor), then 3, then 4+5.

## 7. Open questions

- Does `compaction-model.ts`'s override actually fire in production (fleet auth normally succeeds)? Needs one observed live checkpoint before deciding between "checkpoint wins" vs "fleet summary wins" semantics.
- Should checkpoint summaries be verbatim (current design) or fleet-model-summarized with the agent's summary as instruction? The two extensions encode opposite philosophies; that's a design call, not a bug.
- Is upgrading pi (and designing against `retainedTail`) on the roadmap? It gates how much of §6.5 is worth doing vs. waiting.
