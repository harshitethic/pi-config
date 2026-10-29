---
title: "Claude Code joins peer-link as an external peer; mail is delivered on the user's prompt"
type: decision
status: done
date: 2026-10-11
---

# Claude Code joins peer-link as an external peer

**What:** A Claude Code session joins the peer-link mailbox through its own hooks. `external.ts` registers `_peers/claude-<session_id>.json` on SessionStart, delivers pending mail as context on UserPromptSubmit, and unregisters on SessionEnd. Each Claude session has its own external mailbox. Design: `docs/design/peer-link-external.md`.

**Why:** Mail reaches Claude only inside a hook that the user's prompt fired. Nothing starts a Claude turn. That keeps every Claude turn human-started, which is the only delivery shape that holds under Consumer Terms §3 item 7 (automated access) and the Claude Code legal page (ordinary individual use). Per-session mailboxes keep addressing exact when several Claude sessions run at once.

**Refuting the obvious framing:** "Mail should arrive while Claude is idle, like pi's steer." Only a watcher, a `claude -p` spawn, or a forced-continuation Stop hook can do that, and each starts a Claude turn with no human. Delivery latency is bounded by the user's next prompt. That is the cost of compliance, and we accept it.

**Alternatives considered:**

- **Wake-on-mail watcher (Monitor, or a daemon that runs `claude -p`).** Rejected: starts Claude turns with no human. Automated access under §3.7.
- **Stop hook that continues the turn when mail is pending.** Rejected, same reason as the watcher.
- **One shared third-party mailbox for all Claude sessions.** Rejected: concurrent sessions share one inbox and cannot address each other. A reply to "claude" could go to any session. Per-session `claude-<sid>` names keep addressing exact.
- **Manual `/mail`-only pull (the user or Claude checks mail by hand).** Rejected. The UserPromptSubmit hook is equally compliant and needs no remembering. Claude does not have to be told to check, and mail is not missed.

**Tradeoffs accepted:**

- Mail waits until the user's next prompt. An idle session hears nothing.
- External registrations age out after 24 h without refresh (`EXTERNAL_TTL_MS`). A session silent for over a day drops off the peer list until its next prompt.
- Delivery is at-least-once up to the hook boundary. Claude Code gives no later confirmation.

**Files changed:**

- `extensions/peer-link/external.ts` (new): hook and send/list CLI.
- `extensions/peer-link/mailbox.ts`: external heartbeats, 24 h TTL, queued-status wording for external peers; the delivery gate (`deliveryDecision`) moved here from `index.ts` so pi and `external.ts` share it.
- `extensions/peer-link/index.ts`: lists external peers and reports their queued status.
- `tests/peer-link-external.test.ts` (new).
- `docs/design/peer-link-external.md` (new): flow, hook setup, ToS argument, invariants.
- `README.md`: peer-link bullet.

**References:**

- Anthropic Consumer Terms: <https://www.anthropic.com/legal/consumer-terms> (§3 item 7; fetched 2026-10-11).
- Claude Code legal and compliance: <https://code.claude.com/docs/en/legal-and-compliance> (fetched 2026-10-11).
