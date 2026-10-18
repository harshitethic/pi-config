---
title: "peer-link external peers (Claude Code)"
type: design
status: active
date: 2026-10-11
feature: peer-link
---

# peer-link external peers (Claude Code)

A Claude Code session can join the peer-link mailbox as an **external peer**. Before this, Claude could send to pi peers by hand-writing envelope JSON but could never receive replies.

Code: `extensions/peer-link/external.ts` (CLI, not a pi extension). Decision: `decisions/external-tools/003-claude-code-external-peer.md`.

## Flow

- **SessionStart** (`hook session-start`): registers `_peers/claude-<session_id>.json` with `external: true`; prints the session's identity and send usage as context.
- **UserPromptSubmit** (`hook prompt`): refreshes the registration, prints pending envelopes as context on the user's prompt, records them as inflight (no ack).
- **Stop** (`hook stop`): acks exactly the envelopes the completed turn carried (inflight set). Bookkeeping only — deletes files, starts no turn.
- **SessionEnd** (`hook session-end`): removes the registration. Un-acked mail stays in the inbox.

Delivery is at-least-once: an aborted prompt (Escape, crash) acks nothing, so the next prompt re-emits the un-acked envelopes from the inbox (duplicates over loss — the mailbox contract in `extensions/peer-link/mailbox.ts`). Before 2026-10-18 the prompt hook acked at emit and an aborted prompt lost its mail (reported by the external Claude peer after an Escape-re-send dropped five envelopes); the Stop hook is the consumption confirmation Claude Code "gives no later" — it just needed the prompt hook to stop acking early.
- **SessionEnd** (`hook session-end`): removes the registration.
- **Send** (Claude's Bash tool): `external.ts send --from claude-<sid> [--reply] [--require-online] <to> <text | ->`. Same delivery gate as pi: unlisted targets fail loud. `external.ts list` lists peers.
- **pi side:** external peers are listed, never "online", and age out after 24 h without refresh (`EXTERNAL_TTL_MS`) instead of pi's 2 min sweep window. pi's sends and auto-replies to them queue as "queued — external peer, read when its user next prompts"; `requireOnline` fails. pi never reads or injects into an external inbox.

Mail reaches Claude only inside a hook that the user's prompt fired. Nothing starts a Claude turn.

## Hook setup

Merge into the `hooks` block of `~/.claude/settings.json`:

```json
"hooks": {
  "SessionStart": [{ "hooks": [{ "type": "command", "command": "bun ~/Developer/pi-config/extensions/peer-link/external.ts hook session-start" }] }],
  "UserPromptSubmit": [{ "hooks": [{ "type": "command", "command": "bun ~/Developer/pi-config/extensions/peer-link/external.ts hook prompt" }] }],
  "Stop": [{ "hooks": [{ "type": "command", "command": "bun ~/Developer/pi-config/extensions/peer-link/external.ts hook stop" }] }],
  "SessionEnd": [{ "hooks": [{ "type": "command", "command": "bun ~/Developer/pi-config/extensions/peer-link/external.ts hook session-end" }] }]
}
```

Without the Stop hook nothing acks: mail is re-emitted on every prompt (duplicates, no loss). Add it.

## Terms of Service compliance

Sources, fetched 2026-10-11:

- Anthropic Consumer Terms, <https://www.anthropic.com/legal/consumer-terms>. §3 item 7: no accessing "the Services through automated or non-human means, whether through a bot, script, or otherwise," "Except when you are accessing our Services via an Anthropic API Key or where we otherwise explicitly permit it." §2: "You may not share your Account login information, Anthropic API key, or Account credentials with anyone else." §3 closing: no "bypassing any of our systems or protective measures."
- Claude Code legal and compliance, <https://code.claude.com/docs/en/legal-and-compliance>. "OAuth authentication is intended exclusively for purchasers of Claude Free, Pro, Max, Team, and Enterprise subscription plans and is designed to support ordinary use of Claude Code and other native Anthropic applications." Developers "may not collect, store, or intermediate Claude.ai credentials or session tokens," and may not route "requests through Free, Pro, or Max plan credentials on behalf of their users." "Advertised usage limits for Pro and Max plans assume ordinary, individual usage of Claude Code and the Agent SDK."

Neither document mentions loops. §3.7 is the operative clause.

**(a) Credentials.** The scripts read only `session_id` and `cwd` from hook stdin. They never read Claude Code's auth store, OAuth tokens, `transcript_path`, or `~/.claude`. They make no network calls and spawn no processes (`external.ts`, `mailbox.ts`). Claude Code is unmodified and is the only client that talks to Anthropic. pi never holds Claude credentials, and Claude never receives pi's. The only shared state is files in `~/.pi/peer-mail/`. Nothing collects, stores, or forwards Claude credentials or session tokens, and nothing routes requests through a subscription.

**(b) Automated access (§3.7).** Every Claude turn starts from a prompt the human types. Hooks are a Claude Code surface that Anthropic ships and documents. `UserPromptSubmit` runs inside the turn the human started and only appends text to that prompt. Claude's `send` is a Bash call inside that same turn. No code path runs without a human prompt.

Residual reading: §3.7 says "non-human means," and a hook is a local non-human process that adds input to a session. We read the access as the human's own interactive session, configured with a hook, and the hook makes no request to Anthropic. The same reading covers `CLAUDE.md`, `@`-imports, and MCP servers, which Anthropic ships and users rely on.

Rejected designs, and why:

- **Watcher or Monitor that wakes Claude on new mail.** Starts turns with no human. Direct §3.7 violation.
- **pi spawning `claude -p` (or any headless Claude invocation) to answer mail.** Non-human access to the Services, and subscription OAuth outside interactive Claude Code use.
- **Stop hook that forces continuation when mail is pending.** Starts a turn with no human prompt. Same as the watcher.
- **Any agent-to-agent loop with no human in it** (pi replies to Claude, Claude replies to pi, ...). Automated access. pi's sends and auto-replies to an external peer only land in its inbox, which nothing reads until the human prompts, so pi cannot drive Claude turns.
- **pi holding or forwarding Claude OAuth to reach Claude.** Credential intermediation, which the Claude Code legal page prohibits.

**(c) Usage limits.** Volume is bounded by the human's prompt cadence. Each prompt adds one local file read, a few lines of context, and no extra model turns. This is ordinary individual use under the stated Pro/Max assumptions.

**Invariants for future changes:**

- Never add a path that starts a Claude turn: no watcher, no `claude -p`, no SDK call, no Stop hook that continues the turn. (A Stop hook that only acks delivered mail is bookkeeping, not continuation — it is the one Stop hook allowed here.)
- Never read, copy, or forward Claude Code credentials, OAuth tokens, transcripts, or `~/.claude` state.
- Keep `external.ts` free of network calls and child processes.
- Nothing reads an external inbox except the `UserPromptSubmit` hook; pi never reads or injects into it.

Not legal advice. Checked against the sources above on 2026-10-11. Re-check if Anthropic's terms change.
