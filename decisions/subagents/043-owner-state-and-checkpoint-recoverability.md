---
title: "Owner state by row id (checkpoint + completion reports) and checkpoint recoverability"
type: decision
status: done
date: 2026-10-19
---

# Owner state by row id and checkpoint recoverability

**What.** Three rulings from tfd `docs/reviews/process-controls.md` (owner,
2026-10-19, recorded at tfd `0d53f8f9`; family policy R8, owner 2026-10-08) land
in the actor harness:

- **R4** — `agents/implement.md` and `agents/orchestrator.md` completion reports
  carry `owner_asks:` (`none`, or one or more `<file>#<id>` registry row ids);
  the harness refuses a report whose field is missing, empty, mixed with
  `none`, or holds free text, and the refusal reaches the live reporter.
- **R6** — `checkpoint` / `checkpoint_fork` `nextSteps` may state owner state
  only by registry row id, in the same paragraph; a repo with
  `scripts/reviews_status.py` also gets an existence check.
- **R3-1/R3-2/R3-3** — a checkpoint records every in-flight subagent; subagent
  worktrees are locked while the child lives and reaped only when provably
  finished; `subagent_status` answers in four evidence-named states.

**Authority.** The ruling record is the spec; its rejected alternatives are not
built: no completion delivery inside checkpoint (R3 option 2), no free-text
`owner_asks` or free `nextSteps` (R4/R6 option 2), and no text heuristic as the
mechanism (R8) — every check here is a form check plus a registry existence
check where a registry is reachable.

**Number.** Landed as 043 (drafted as 039; `039-gate-suite-single-run` took that
id on 2026-10-20, and landed ids keep).

## R3-1 — the checkpoint summary carries the in-flight record

`checkpoint` and `checkpoint_fork` append a machine-built `### In-flight
subagents` section to the summary, sourced read-only from the subagent meta
registry (`/tmp/pi-subagent-*.meta.json`) via `extensions/lib/subagent-state.ts`.
The model's prose is not the source of truth; an empty registry (or no live
child) omits the section entirely, so the round-trip stays byte-identical to
pre-change behavior for the common case. One composed summary feeds both copies
— the archive meta and the `customInstructions`/`[CHECKPOINT]` restore path — so
the record survives compaction.

Listed: children in state `running` or `orphaned` whose owner passes 027's
adoption gate (this process, or gone). A live foreign owner's child is another
session's business; a legacy meta is unattributable (027's rules, unchanged).

## R3-2 — lock as the proof, unlock as the trigger

`createWorktree` runs `git worktree lock --reason "pi-subagent <sid>"` right
after `worktree add`. git refuses `worktree remove --force` on a locked tree, so
a hand reap of a live child fails loudly (the 2026-10-07 incident's four
worktrees, one of them live). A missing lock degrades via `debugLog` — it must
never fail a dispatch.

`postDeliveryCleanup` unlocks first (tolerating only git's `is not locked`), then
force-removes. The unlock is the completion's proof: it happens after
`deliverResult`. A failure after a successful unlock re-locks, best-effort, and
the old `fs.rmSync` fallback is **gone** — a recursive delete is exactly the
destruction the lock exists to prevent, and the tree's cleanliness is unknown on
that path. Unknown fail states warn via steer (existing behavior).

`reapFinishedWorktrees` (session start, after the 027 recovery scan) requires
**both** 027's adoption gate **and** child-side terminal evidence — the log's
last non-empty line being the `── Completed|Exited|Stopped|Killed (…) ──` footer,
the same predicate the status vocabulary uses. Owner death alone is not enough:
the child is a separate process and can outlive a dead owner. A clean tree
(`git status --porcelain -uall` empty) is unlocked and removed with a plain
`worktree remove` — no `--force`, so even a race cannot delete uncommitted work;
a failed removal re-locks best-effort, so neither cleanup path can leave a tree
it just unlocked unprotected. A dirty tree is left, marked `worktreeKept` in its
meta, and the status answer offers `subagent_resume` for it, labelled
`orphaned-resumable` — the WO's own term for a kept tree (see the R3-3 table).

## R3-3 — four states, each naming its evidence

`extensions/lib/subagent-state.ts` classifies by observed facts and the status
answer leads with `State: <state> — <evidence>.`:

| state | evidence |
|---|---|
| `running` | attached to this session's tracker; or a socket file with a live recorded owner; or a log written within `SUBAGENT_STALE_TURN_MS` |
| `complete` | the log's last line is the `── Completed …` footer |
| `orphaned` | a terminal-but-not-completed footer (or nothing) plus a session file → prints `subagent_resume({...})` |
| `dead` | no completion line, no session file, recorded owner gone |
| `unmatched` | the `dead/unmatched` bucket's other cause: no meta, no recorded owner, or an owner alive but not attached here |

The old "No running subagent found … may have already finished or been stopped"
merge is gone; every distinguishable case names its cause. The existing
not-attached facts (029's socket/owner/branch/worktree/log lines) are preserved
verbatim after the state line.

## R4 — the gate at the completion-acceptance point

`validateOwnerAsks` (`extensions/lib/owner-row.ts`) is the one validator: the
field must be present, non-empty, `none` alone, or id tokens that all match
`<file>#<id>`. The gate runs in the `message_end` completion-detection block of
`spawnSubagent`, where the review-gate soft prompt already lives.

Placement is load-bearing: a refusal must reach the **live reporter**, and
`deliverResult` runs after the child is gone. The gate sits on the single
delivery funnel at the point the report is accepted (`msg_end` → close →
`deliverResult`), before `stdin.end()`; the WO-2026-035 `preCommitSteps`
ordering is untouched. A refused report never sets `isDone` and is never
delivered, so the review-status gate cannot count one as delivered.

Scope is derived, not listed: `reportDeclaresOwnerAsks(agent.systemPrompt)` is
true when the agent's own report schema declares the field. `implement` and
`orchestrator` declare it; scouts and reviewers do not, so their reports are
unaffected. A future report-producing agent inherits the gate by declaring the
field in its own prompt — no agent-name list, no new frontmatter key.

Every delivery site enumerated: the close handler → `deliverCloseResult` →
`deliverResult` (gated), and the recovered-session close path
(`recoverOrphanedSubagents`'s socket-close handler), whose reporter is already
gone — that path cannot refuse, and the report it carries never passed a live
gate. Stated, not papered over.

## R6 — same-paragraph row id

`validateOwnerStateProse` splits `nextSteps` at blank lines and at new list
items/headings, and every paragraph matching the owner-state phrase list
(ruling/answer/decision/approval attributed to the owner, and owed-state shapes
like "needs a ruling", "awaiting the ruling", "pending owner") must carry a row
id in that same paragraph. A claim with no id fails the tool call, naming the
rule and the paragraph; an id-shaped token without `#` (e.g. `R3`,
`process-controls.md`) is reported as a malformed id by name. Asking the owner
is not asserting owner state: "ask the owner", "the owner owns this question"
do not match.

Both `checkpoint` and `checkpoint_fork` validate before archiving, so a
violating claim lands nothing. With `scripts/reviews_status.py` present at the
git toplevel, the cited rows are checked against
`python3 scripts/reviews_status.py --all --plain` (matching full path, path
suffix, or basename, since the ruling's own example is a basename) and a missing
row is named in the error.

Two degradations, deliberately different (f4f7d50). A repo **without** the
script is outside the registry convention, so the check is form-only and silent
— R6's existence half depends on a registry the harness does not own. A script
that **is** there but cannot be read — non-zero exit, timeout, unspawnable — is
an observed failure, not an absent convention: it degrades to form-only too,
but **loudly**, with a named warning in the tool result (and a `ui.notify`
warning) stating the script and its failure, so a broken registry cannot pass
as a clean check.

## Relationship to 027 and 026

027's adoption predicate moved verbatim to `extensions/lib/subagent-state.ts`
and is re-exported from `extensions/subagent-async/index.ts`, so checkpoint's
in-flight section and the recovery scan share one gate instead of a second
implementation. Behavior is unchanged (its test suite passes untouched). 026's
post-disposal semantics — no cross-session delivery injection — are untouched.

## Rejected alternatives

- **Text-heuristic enforcement** (R8): the R6 phrase list alone would be a
  heuristic; it is only the *trigger*, and the requirement it triggers is a
  mechanical form-plus-existence check, as R5's adopted shape specifies.
- **Holding green work for the R8 registry-tool gate**: R8 lands separately; the
  R4/R6 checks are shaped to slot into it (row-id form, registry lookup).
- **Auto-resuming orphaned children**: the status answer prints the
  `subagent_resume` call and the checkpoint records their ids and branches; the
  choice to resume stays with the orchestrator.
