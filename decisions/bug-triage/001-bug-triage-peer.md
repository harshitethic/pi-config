---
title: "Bug-triage peer — a standing intake role, not a 4th mode"
type: decision
status: done
date: 2026-08-13
---

# Bug-triage peer

**What:** A long-running session, launched `pi --name bug-triage`, that
owns an intake queue for bugs in `main` — not regressions a session
introduces in its own WIP (those each session fixes itself).
`extensions/bug-triage.ts` injects `agents/bug-triage.md` into that one
session's system prompt; reporters hand off via `peer_send`.

**Why ownership transfer, not delegation:** a subagent's lifecycle is
scoped delegation — task → report → gate → merge → die — with a bounded
deliverable. A bug handoff has no single report to gate and no bounded
scope; it's an open-ended investigation. The caller wants to stop
thinking about it, not manage a return report. That's a persistent
owner — a peer session.

## Why not a 4th mode in modes.ts (the obvious alternative)

- **Axis mismatch + cycle pollution.** The three modes are one axis —
  *operational style for work a session has taken on* (do it directly /
  dispatch / super-orchestrate), cycled via `/mode`. bug-triage is a
  *concurrent role*, not a style. `implement → orchestrate → plan →
  bug-triage` is nonsensical.
- **Global-default clobber.** `saveMode` writes both the per-project
  file *and* the global fallback `~/.pi/agent/modes.json`. The
  per-project file is per-clone, but `/mode bug-triage` would clobber
  the global default — every new session everywhere would come up in
  bug-triage mode until changed.

A name-triggered peer carries no mode state, so nothing to clobber.

## Alternatives considered

- **4th mode, excluded from the cycle, stored per-session.** Rejected:
  "a mode that isn't a mode" — needs a second storage path; the name
  trigger gives per-session isolation for free.
- **A subagent, not a peer.** Rejected: wrong lifecycle (above).
- **A git worktree of one reporter's clone.** Rejected: couples the
  peer to one clone and blinds it to the others; one-clone-per-session
  is already convention, so a 4th clone is simpler.
- **File-only — never fix.** Rejected as default: loses the speed the
  user wanted for mechanically-evident fixes. Kept for non-trivial bugs.

## Trigger: session name, not env var

The role activates on the session **display name** being "bug-triage"
(`pi --name bug-triage`), not on `PI_PEER_NAME`. An env var is ambient:
`export PI_PEER_NAME=bug-triage` then reusing the terminal for an
unrelated `pi` would quietly reactivate the role in the wrong session.
`--name` is a per-invocation CLI arg that can't leak into the shell, so
the role fires only for a session explicitly launched as the triage peer
(and reactivates correctly on `/resume` of that named session).

The same `--name` drives peer-link's mailbox identity too: `peerIdentityFrom`
(peer-link) falls back to the session display name when `PI_PEER_NAME` is
unset, so `pi --name bug-triage` is the complete launch — reporters
`peer_send` to "bug-triage" and it reaches this session, no env var.
`sanitizePeerName` rejects human-readable names (spaces), so only
name-shaped display names become identities; casual names fall through to
the filename, keeping the display-label-vs-routing-key distinction intact.
A stale `PI_PEER_NAME=bug-triage` in the shell would still hijack that
identity for an unrelated session, so the extension warns if it's set
without the name.

## Trivial-fix policy

Trivial means the fix is mechanically evident from the confirmed root
cause — no design decision, no behavior choice between plausible
options, no new API surface; file and line counts are explicitly not
criteria (same boundary as the subagents review-skip policy,
`decisions/subagents/014-review-skip-source-of-truth.md`). The peer
lands trivial fixes itself, through the standard gate: branch off the
mainline tip (`bug-triage/*`), turn the `.cases` pin red→green, commit
referencing the issue, spawn `review-code` and `review-tests` on the
branch (`isolate: false`,
`decisions/subagents/004-parallel-review-gate.md`), and accept only
both approvals (`APPROVED`, or `APPROVED_WITH_NOTES` with every note
resolved; 3 rounds max). On a clear gate the peer merges into the
mainline (`origin/hamster`), pushes to `origin`, and closes the issue
with the merge commit. Non-mechanical fixes — or a gate that does not
converge — stop at issue + failing `.cases`; the fix becomes a normal
work-order.

> **Amended (2026-10-06): draft PR replaced by peer-run gate + merge.**
> The original policy restricted fixes to "genuinely one-line and
> isolated" and routed them through a draft PR on the premise that the
> review gate would complete the merge. Both premises failed: size
> conflates with difficulty (a five-file rename is mechanical; a
> one-line behavior choice is not), and no PR review/completion process
> exists — every other session commits to a branch in its clone, merges
> to the mainline, and pushes to the shared remote. The fleet's review gate
> (decision 004) still applies: the peer spawns `review-code` and
> `review-tests` on the fix branch before merging. That preserves the
> original policy's gate intent while removing the dead PR handoff — the
> reviewers are separate sessions, so the peer still cannot self-approve
> a fix.

> **Amended (2026-10-07): verification stays in the peer's clone; the loop
> is implement-mode.** Two operational rules from the first month of live
> triage, recorded in `agents/bug-triage.md`.
> *(1) Reproduce, pin, characterize, and root-cause are never delegated.*
> The pin's value is that the triage peer measured it firsthand on the
> confirmed tip; a subagent's report (isolated worktree off parent HEAD,
> possibly a different tip) is a lead to re-measure, not evidence — and a
> probe can arrive broken. Observed cost of the alternative: a handoff's
> probe set included two files that did not compile (a value-literal
> syntax slip), which the peer had to fix and re-run; the fixed override
> probe then *rejected*, narrowing the class the order pins. Subagents and
> peers are for context-heavy side investigation and the mandatory fix
> gate.
> *(2) Fetch ≠ checkout.* Confirm the tip (`git log --oneline -1`) before
> reading any suite, probe, or IR result; a parked tree that lagged the
> fetch silently measured the old tip — twice in one session.
> Mode follows from (1): the loop is direct, tight-feedback work, and
> orchestrate's "never implement directly" is incompatible with producing
> an independently verified pin, so this role stays on implement.

## Tradeoffs

- **No auto-spawn.** Launched and pinned manually (`/pin bug-triage`);
  if down, a handoff queues silently until TTL and the reporter thinks
  it's handled. Mitigation: reporters check `peer_list` first
  (APPEND_SYSTEM) and fall back to filing.
- **`main`-only scope.** The peer hands back anything that reproduces
  only on the caller's branch — keeps it from becoming a dumping ground
  for every session's WIP regressions.
- **Name is the contract.** `bug-triage` is hardcoded; renaming is
  coordinated across reporters. Two sessions on the same name collide
  on one mailbox identity.

> **Model seat (2026-10-22, owner):** bug-triage stays unpinned by rule — it is a
> long-running session (`pi --name bug-triage`), not a subagent, and runs on the
> `settings.json` session defaults by design: its model follows the main-session
> defaults and manual `/model` switching, deliberately not pinned to a fleet seat.

## Files changed

- `agents/bug-triage.md` — the role prompt.
- `extensions/bug-triage.ts` — name-triggered injection (role into
  system prompt + one-shot kick-off); no-op for every other session.
- `extensions/peer-link/` — `peerIdentityFrom` (mailbox.ts): identity
  chain now falls back to the session display name before the filename,
  so `pi --name bug-triage` supplies the mailbox identity too (no env var).
- `settings.json` — register the extension.
- `APPEND_SYSTEM.md` — reporter handoff clause.
- `README.md` — extension entry.

## Test coverage

`tests/bug-triage.test.ts` — `isBugTriagePeer` predicate (name match,
trim, miss, unset, subagent guard, and the regression: a stale
`PI_PEER_NAME` without the name must not fire).
`tests/peer-link.test.ts` — `peerIdentityFrom` (env → display name →
file → pid) and `deliveryDecision` (the `requireOnline` gate). The
injection path mirrors `append-system-local.ts` (likewise untested).
