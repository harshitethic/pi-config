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
| 6 | Drop, don't summarize, re-derivable state | **Aligned, empirically validated (2026-10-21).** Injection reads disk at injection time (`checkpoint.ts:182`) — a fresh minimal view (Study K's winning pattern), not carried state. Measured: 5/5 needle retrieval with injection vs 0/4 summary-only. Caveat: the region *selection* is carried read-time state and goes stale (§5.7). |
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

Not present in installed 0.83.0 despite being documented in its own `docs/session-format.md`: `retainedTail`. The shipped docs describe a newer mainline than the shipped code. Installed tree is ~5 weeks behind npm latest (1.3.0). **Correction (2026-10-21, `docs/investigations/pi-upgrade-2026-10.md` §2): `retainedTail` never shipped in *any* version — 1.3.0 replaces it with `CompactionEntry.systemMessage`.**

## 5. Findings

### 5.1 Live bug — file injection is silently inert (two dead paths)

1. `checkpoint.ts:308-311` reads `event.args?.path` from `tool_execution_end`. That event carries only `{toolCallId, toolName, result, isError}` — **in 0.83.0 and also in 0.67.1** (the emit site constructs exactly those four fields in both). Finalized args live on `tool_result.input` (`types.d.ts:691-698`). → read-region tracking records nothing → `buildFileInjection` hits its empty-regions guard (`:184-186`) and injects nothing for every `relevantPaths` entry.
2. `checkpoint.ts:125-127` (`getPreservedPaths`) matches `block.type === "tool_use"` with `input.path`. Pi's assistant block shape is `{type:"toolCall", name, arguments}` (`pi-ai/dist/types.d.ts:254`; `tool_use` exists only in pi's Anthropic wire adapter). → preserved-tail skip never fires.

Both are silent (empty set, not an error), which is why they persist unnoticed. The uncommitted `auto-checkpoint.ts` diff already migrated path 1 to `tool_result.input` — so the working tree ships one extension fixed and one broken against the same reality, and their duplicated read-region logic (`checkpoint.ts:70-99` vs `auto-checkpoint.ts:255-300`) has diverged. **Fix = one shared helper, migrate both (share code, don't parallel it).**

### 5.2 Live hazard — checkpoint summary can be overridden by `compaction-model` (observed 2026-10-21)

`settings.json` loads `checkpoint.ts` before `compaction-model.ts`; pi's extension runner takes the **last non-null `session_before_compact` result** (`runner.js:576-605` — overwrite per non-null, `cancel` short-circuits, throws don't reset). Verified by harness (real runner + real extension modules, fleet `compact()` mocked) and one live run:

- Fleet `compact()` **succeeds** → `compaction-model`'s rewritten summary wins; the agent's `[CHECKPOINT]` text is demoted to a summarizer hint.
- Fleet `compact()` **fails for any reason** → `compaction-model` returns `undefined`, checkpoint's verbatim summary stands. The trigger is *any* failure (auth, routing, quota, network, 5xx) — not just auth.
- Boundary is identical either way (`firstKeptEntryId`/`tokensBefore` copied from `preparation` in both paths); only summary text flips. Checkpoint's side effects (archive, injection, continuation) run regardless, since its handler executes first.

**In this environment the override never fires**: fleet `compact()` deterministically 400s with `MissingSessionID` — `opencode-go` requires an `x-opencode-session` header `getApiKeyAndHeaders` doesn't supply (`model-registry.js:30-46`) — and `compaction-model.ts:58-65` swallows the error. The verbatim summary wins today by accident of a silently swallowed provider failure. That swallow is itself a defect: a reproducible config/routing bug plus silent semantic fallback on transient errors.

### 5.3 Green suite, inert coverage

`bun test tests/e2e-checkpoint.test.ts tests/auto-checkpoint.test.ts` → 21 pass. But:

- The injection assertion (`tests/e2e-checkpoint.test.ts:359-386`) is doubly conditional (`if (compactionCount === 0) return; if (injectedMessages.length > 0) …`) and **cannot fail** when injection emits nothing. "Compaction succeeds with file injection" asserts only compaction + archive + pairing.
- The "agent answers from injected context" needle test passes because the 5 haystack reads survive in pi's **kept recent tail** (`keepRecentTokens`) — the model answers from retained history, not from injection. Same for the `checkpoint_search` test's `found.length >= 1` (needles leak from setup chatter/kept tail).
- The `checkpoint_search` describe (`:392-427`) exercises a tool removed in `dd89c68`; `TOOLS` (`:43`) still lists it and unknown names are silently ignored.

The suite pins the orphan-pairing invariant well (`assertBranchToolCallPairing`, spy-boundary tests) — that part is real.

### 5.4 Fragile assumption — `getEntries()` vs `branchEntries`

`getPreservedPaths` and the archive sites scan `sessionManager.getEntries()` (all entries incl. abandoned branches) where `session_before_compact` provides `branchEntries`. On branched sessions, preserved-paths can over-skip and archives can include off-branch entries. Archive-everything is defensible for grep archives; preserved-paths should use `branchEntries`.

### 5.7 Injection utility — measured (2026-10-21)

A/B evaluation (real model trials, e2e-style haystack/needle tasks; harness on branch `pi-subagent-49f05403b984`, `experiments/checkpoint-eval/`). Verdict: **keep with changes**.

- **Benefit**: injection (arm A) 5/5 needles, zero post-compaction reads, answers provably from injected blocks; summary-only (A2) 0/4. But re-read-allowed (A1) and re-read-instructed (D) also 5/5 — injection's advantage over re-read is determinism (D had a checkpoint-call compliance failure; A2 had a no-tools violation), not success rate.
- **Cost**: injection ≈ one targeted re-read (~1.0–1.1k tokens for 5 regions) and ~3× cheaper than the model's free re-read (~3.1k). Paid unconditionally at every checkpoint; re-read pays only when needed. The 15% budget was never a constraint in trials.
- **Staleness**: content is fresh (re-read at injection), but **region selection is stale carried state**. S1: file edited after read → injected fresh content (good). S2: 20 lines inserted before the needle → injection served the shifted window and silently omitted the needle (agent answered UNKNOWN). Misleading by omission.
- **Tension ruled**: injection is a *fresh view*, not carried re-derivable state (bytes re-read from disk) — consistent with rule 6 and Study K once the viewport is validated.

Required changes folded into WO-2026-055: (1) validity guard — record file mtime/size with each region; at injection time, if changed, drop the stale window and name the file in a "changed since read — re-read if needed" note; (2) label the injected block as a checkpoint-time disk snapshot with regions selected from an earlier read.

### 5.8 Doc/code drift

- `README.md:64` documents `checkpoint(summary, nextSteps?, continue?, newCwd?)` + a fork entry recording on the old session — neither exists (two tools; fork stages `/go`, appends nothing to the old session).
- `doCheckpoint()`, `checkpoint-continue`/`checkpoint-stop`, `isAbnormalStop`, context strip existed in `4611f42` and were removed by stash-recovery commit `9925257` (2026-07-10) with **no decision record**.
- `checkpoint_search` removed (`dd89c68`) but referenced in `tests/e2e-checkpoint.test.ts:43,392`, `agents/orchestrator.md:6`, `agents/implement.md:7`, `WO-2026-031:95`.
- Decision 001's orphan re-anchor repair is procedural only — no script implements it.
- `StrippedAssistant` (`checkpoint.ts:45-48`) is dead type residue.

### 5.6 Pipeline notes
- WO-2026-054's implementation (`f8bbbe6`) is on an unmerged side branch; `docs/TODO.md:216` correctly says "in flight".
- Installed pi 0.83.0 is ~5 weeks behind npm latest (1.3.0); the package's own docs describe features (`retainedTail`) its code lacks.

## 6. Verdict + recommended actions

The architecture is sound and, on the points that matter most (tool-group atomicity, append-only boundaries, archive-before-compact, informed continuation), at or ahead of field consensus. Its second-most-important feature (informed file injection) was dead and untested; it is now empirically validated as worth having (§5.7), with a stale-viewport defect that WO-2026-055 fixes alongside the dead paths.

Priority order:

1. ✅ **Landed (2026-10-21, `af2733a` + `59655ec`, WO-2026-055): un-break injection via one shared read-tracking helper** (`extensions/lib/read-tracking.ts`): reads tracked from `tool_result.input`, `toolCall`/`arguments` matching, `branchEntries` scoping; stale-viewport guard + snapshot label (§5.7); injection tests able to fail (M1–M14 with mutation controls); `checkpoint_search` and README drift cleaned. `auto-checkpoint.ts`'s migration is a follow-up order (owner ruling pending on its WIP — it is the last duplicate). [addresses 5.1, 5.3, 5.4, 5.7, 5.8]
2. **Resolve the summary-ownership collision** (owner ruling pending — verbatim vs fleet vs hybrid): make the winner explicit via `reason`-based dispatch — auto (`threshold`/`overflow`) vs manual only; `reason` cannot distinguish checkpoint from `/compact` (both report `"manual"`), so the `[CHECKPOINT]` marker stays for that split (pi-upgrade-2026-10 §2) — fix the `MissingSessionID` routing gap, and stop swallowing fleet failures into silent fallback (5.2). [addresses 5.2]
3. **Drift cleanup + decision record** for the `9925257` removals (owner ruling pending on restore-vs-record). [addresses 5.8]
4. ✅ **Landed (2026-10-21, `f2cbcbc`, WO-2026-056): cheap best-practice upgrades** — fixed summary schema on both tools (`goal / filesTouched / decisions / triedAndFailed / constraints`, all required, one `renderSummary` renderer), token before/after + summary in the notify and archive meta (`tokens.after` = pi's `estimatedTokensAfter`, patched into meta at `onComplete` since pi exposes it nowhere earlier), git-ref binding in meta (non-git cwd → `git: null`). [addresses §3 rows 4, 5, 8]
5. ✅ **Evaluated (2026-10-21, `docs/investigations/pi-upgrade-2026-10.md`): pi upgrade (0.83.0 → 1.3.0)** — the unlock premise is **falsified**: `reason` and the `message_end` replacement already exist in 0.83.0; `retainedTail` never shipped. Verdict GO, but **after item 2, not before** — upgrading likely revives the dormant fleet path (5.2), arming the override before the ownership rule arbitrates it. Own work order (upgrade + `compaction-model.ts` 1.3.0 header/routing fixes); not a checkpoint fix. [addresses §3 row 2]

Suggested sequencing: 1 and 4 landed; 2 after the owner's summary-ownership ruling; 3 on the owner's restore-vs-record ruling (batchable with 2); 5's upgrade order after 2 lands (evaluation done — see the verdict there).

## 7. Open questions

- **Q1 — Owner ruling needed, summary ownership**: should checkpoint summaries be verbatim (checkpoint.ts's philosophy) or fleet-model-summarized with the agent's summary as instruction (compaction-model's)? Observed fact to weigh: the fleet path currently never fires (5.2), so "keep verbatim" is the live behavior by accident. Update (2026-10-21): pi-upgrade-2026-10 §4.3 shows the fleet path's `MissingSessionID` 400 plausibly disappears on a pi upgrade — the fleet override may wake, so the ownership rule must be enforced explicitly, not held by the fleet path's failure. Premise verified 2026-10-21 against the installed 0.83.0 runtime: `reason` is populated at both emit sites (`agent-session.js:1396` manual, `:1623` auto) and splits `manual`/`threshold`/`overflow`; `ctx.compact()` and `/compact` both report `"manual"` with no override, so the marker split is forced; `{compaction}` results replace, not merge (`runner.js:586-587`) — the dispatch's `undefined` yield is the enforcement point. Full cites: `work-orders/WO-summary-ownership-dispatch.md` Premise. (Asked 2026-10-21.)
- **Q2 — Owner ruling needed, pi upgrade**: 0.83.0 → 1.3.x on the roadmap now or batched later? Research landed (2026-10-21): GO but sequenced *after* the summary-ownership fix — the upgrade arms the dormant fleet override (pi-upgrade-2026-10 §7). The remaining ruling is purely timing: schedule the upgrade order now, or batch later. (Asked 2026-10-21.)
- **Q3 — Owner ruling needed, uncommitted `auto-checkpoint.ts` WIP** (identified in `structure-trend.md` as another session's work): hands-off + migrate in a follow-up order, or land it? (Asked 2026-10-21.)
- **Q4 — Owner ruling needed, April-era features removed by `9925257`** (`doCheckpoint`, `checkpoint-continue`/`-stop`, `isAbnormalStop`, context strip): restore any, or record removal as intentional? (Asked 2026-10-21.)
- ~~Open — injection utility~~ **Resolved (2026-10-21)**: keep with changes — validated 5/5 vs 0/4; fixes folded into WO-2026-055 (§5.7).
