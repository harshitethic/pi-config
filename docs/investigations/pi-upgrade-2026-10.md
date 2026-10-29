# pi upgrade: 0.83.0 → 1.3.0 (2026-10)

Assessment for the summary-ownership work (sanity-check §5.2 / §6.2). Installed
version verified at `/opt/homebrew/lib/node_modules/@earendil-works/pi-coding-agent`
(`package.json`: 0.83.0); delta measured against that tree, not release-note prose.

**Verdict first:** the three APIs this upgrade was assumed to unlock are not the
reason to upgrade. `session_compact.reason`/`session_before_compact.reason` and
`message_end` replacement **already exist in 0.83.0**; `retainedTail` **never
shipped in any version** and is gone from 1.3.0's docs. The upgrade is worth doing
for correctness fixes (compaction retry, truncated-summary refusal, provider
routing) — but land the summary-ownership change **first**: upgrading is likely to
wake the dormant `compaction-model` override described in §5.2.

## 1. Releases in range

`npm latest` = **1.3.0**, published 2026-10-15 (`dist-tags.latest`, no 1.3.x
successor). Range walked: 0.84.0, 0.84.1, 0.84.2, 0.84.3, 0.84.4, 0.85.0, 0.85.1,
0.86.0, 0.86.1, 0.87.0, 0.87.1, 0.99.0, 0.99.1, 0.99.2, 1.0.0–1.0.4, 1.1.0, 1.2.0,
1.3.0 — 23 releases, 6 with a "Breaking Changes" heading (0.84.0, 0.84.3, 0.86.0,
0.87.0, 1.0.3, 1.2.0).

Themes that touch us:

| release | what changed | why it matters here |
|---|---|---|
| 0.84.0 | `ModelRegistry.getApiKeyAndHeaders()` headers become `ProviderHeaders` (`string \| null`); `refresh()` returns `Promise<ModelsRefreshResult>`; extension model calls routed through the coding-agent runtime | `compaction-model.ts` consumes the old shape |
| 0.84.3 | truncated compaction/branch summaries no longer persisted; `session_compact_failed` event added | fleet-path failures become visible instead of silent |
| 0.86.0 | summarized retries, cache warming, `pi.on()` unsubscribe, `context_with_system` | orthogonal |
| 0.87.0 | `turn_end`/`agent_before_settle` become actionable boundaries with required fields; `ContextEditEntry` added to `SessionEntry`; `SessionManager` canonical for provider context | `turn_end` is our compaction trigger |
| 0.99.0 | codemode/MCP built-ins, tool `exposure`/`namespace`/`outputSchema`, `ctx.executeTool()`, `system` theme default | additive for extensions |
| 1.0.0 | **TUI defaults to fullscreen** | user-visible; keybindings to re-verify |
| 1.1.0 | `durationMs` on `tool_execution_end` / render context; `agent_settled.aborted` | additive |
| 1.2.0 | published config schemas (theme schema now `pi.dev/schemas/theme.schema.json`, startup themes validated); `before_agent_start` becomes a union on `messageType`; session busy during `before_agent_start`, `sendUserMessage()` requires `deliverAs` | theme file + event shapes |
| 1.3.0 | Kimi Code transport, `/share` destination, `read` line-range label fixes, malformed tool-arg JSON now fails validation | bug fixes we benefit from |

Changelog: <https://github.com/earendil-works/pi/blob/main/packages/coding-agent/CHANGELOG.md>
Registry: <https://registry.npmjs.org/@earendil-works/pi-coding-agent>

## 2. The "reason-era" APIs — all three premises checked

| claimed | reality |
|---|---|
| `CompactionResult.reason` | Does not exist in either version. `CompactionResult` is `{summary, firstKeptEntryId, tokensBefore, estimatedTokensAfter?, usage?, details?}` — byte-identical field set in `0.83.0 dist/core/compaction/compaction.d.ts:18` and `v1.3.0 src/core/compaction/compaction.ts`. |
| the compaction-hook `reason` field | **Already in 0.83.0**: `SessionBeforeCompactEvent.reason` / `SessionCompactEvent.reason: "manual" \| "threshold" \| "overflow"` at `dist/core/extensions/types.d.ts:447,458`. Unchanged in 1.3.0. |
| `message_end` replacement | **Already in 0.83.0**: `MessageEndEventResult { message?: AgentMessage }` at `types.d.ts:796`, wired at `:879`. 1.3.0's only addition is that the replacement is normalized in place (`_replaceMessageInPlace`) so agent state and persistence agree. |
| `retainedTail` | Documented in 0.83.0's own `docs/session-format.md:240,245,327,337,342` but **absent from 0.83.0 code** (zero hits in `dist/`). Absent from 1.3.0 too: 1.3.0's `session-format.md` has no `retainedTail`; the checkpoint is now `CompactionEntry.systemMessage` (complete prompt+tool state), and `firstKeptEntryId` is required, with a self-retaining compaction storing its own id (`session-manager.ts` `appendCompaction`). |

**Consequence for summary ownership:** `reason` cannot replace the `[CHECKPOINT]`
marker, because `ctx.compact()` and `/compact` both report `reason: "manual"`
(`agent-session.ts` `compact()` hardcodes `"manual"`; only `_runAutoCompaction`
passes `"threshold"/"overflow"`, and it passes `customInstructions: undefined`).
The usable dispatch is coarser: *automatic* compactions (`threshold`/`overflow`)
→ fleet summary; `manual` → leave to whichever handler owns the marker. That is a
real settlement of §5.2, but it is available on 0.83.0 today.

## 3. Migration delta — extension-facing surface

| surface | 0.83.0 | 1.3.0 | breaks us? |
|---|---|---|---|
| `ctx.compact().onComplete(result)` | ✔ | ✔ unchanged; `estimatedTokensAfter` still injected only there | no |
| `CompactOptions` | `customInstructions/onComplete/onError` | identical | no |
| `CompactionResult.estimatedTokensAfter` | optional, set by `AgentSession` | same (extension-supplied compactions get it applied afterwards) | no |
| `session_before_compact` → `{compaction}` | ✔ | ✔ (`SessionBeforeCompactResult.compaction`) | no |
| `ExtensionContext` | ui/mode/hasUI/cwd/sessionManager/modelRegistry/model/scopedModels/thinkingLevel/isIdle/isProjectTrusted/signal/abort/hasPendingMessages/shutdown/getContextUsage/compact/getSystemPrompt | same set (+ nothing removed) | no |
| `pi.registerTool(ToolDefinition)` | name/label/description/parameters/execute | + `promptSnippet`, `promptGuidelines`, `exposure`, `namespace`, `annotations`, `outputSchema`, `reachesTools`, `prepareLoadout`, `defaultActive` | no (additive) |
| `tool_result` event | `{toolCallId, toolName, input, content, details, isError}` | + `structuredContent`, `usage`, `parentToolCallId` | no |
| `tool_execution_end` | `{toolCallId, toolName, result, isError}` | + `durationMs`, `parentToolCallId`; **still no `args`** | no (already documented) |
| `turn_end` | `{turnIndex, message, toolResults}` | required `messageEntryId`, `toolResultEntryIds`, `outcome`, `entries`, `continue`, `context` | no (handlers reading 3 fields still compile) |
| `message_update` | cumulative `message` | deltas only — JSON/RPC *only*, extension event unchanged | no |
| `ModelRegistry.getApiKeyAndHeaders` | `headers?: Record<string,string>` | `headers?: ProviderHeaders` (`string \| null`), + `baseUrl`, `env` | **type error** in `compaction-model.ts` |
| `compact()` params | `(prep, model, apiKey, headers, customInstructions, signal, thinkingLevel, …)` | same order, + `env, retry, callbacks, sessionId` | no (positional-compatible) |
| `SessionManager.create/appendMessage/getEntries/getSessionId/getCwd` | ✔ | ✔ | no |
| `SessionEntry` union | no `context_edit` | + `context_edit` | no (no exhaustive switch here) |
| `before_agent_start` | `{prompt, images?, systemPrompt?}` | union on `messageType`; `"custom"` has no `prompt` | no (unused) |

Not relevant to this repo but worth knowing: 0.84.0 removed the pi-agent-core v4
harness `Session`/`SessionRepo` APIs and 1.2.0 removed the experimental
server/client stack — nothing here imports either.

## 4. Per-file risk

**`extensions/checkpoint.ts` — LOW.** No removed API. Three deltas to exercise, not
to code around: (a) `turn_end` is now a *boundary* dispatch (`_dispatchTurnEndBoundary`
→ `emitBoundary`) rather than a plain notification, so the `ctx.compact()` call from
that handler runs on a different path — behavioral, needs a live checkpoint; (b) 1.2.0
makes the session count as busy while a run starts and requires `deliverAs` on
`sendUserMessage` — both call sites already pass `deliverAs: "followUp"`, and the
`onComplete` path runs while compaction (not a run) is in flight; (c) new
`session_compact_failed` event exists if `onError` never fires where we expect.

**`extensions/compaction-model.ts` — HIGH (small file, sharp edges).** (1) `auth.headers`
is `ProviderHeaders` in 1.3.0, passed into `compact(…, headers?: Record<string,string>)`:
a type error, and at runtime `null` deletion markers would be forwarded as real
headers — 1.3.0 filters them via `withoutDeletedHeaders`. (2) `auth.baseUrl`/`auth.env`
are now part of `ResolvedRequestAuth`; ignoring them drops credential-resolved
endpoints and ambient env (exactly the class of bug pi fixed for extension model calls
in 0.84.0). (3) **The sleepy hazard wakes up:** `compact()` funnels every
summarization call through `completeSummarization`, which assigns
`sessionId: options.sessionId ?? uuidv7()`; 0.86.0 taught the OpenCode adapters to send
`x-opencode-session` from `options.sessionId`. The `MissingSessionID` 400 that made the
fleet path deterministically fail (§5.2) therefore plausibly disappears on upgrade,
which means the fleet summary would start winning over checkpoint's verbatim summary.
(4) 0.84.3 makes a length-truncated summary throw instead of persisting — good, and our
`catch` already falls back; post-1.3.0 `Unreleased` also drops the `reserveTokens` cap
on summary output.

**`extensions/lib/read-tracking.ts` — NONE.** No pi runtime import. Consumes
`tool_result.input` (present both, `types.d.ts:691-694` → 1.3.0 unchanged) and session
entries shaped `{type:"toolCall", name, arguments}` (unchanged). 1.3.0 strictly
improves the inputs: numeric-string/null `offset`/`limit` are normalized (#9887) and
malformed final tool-arg JSON now fails validation instead of running partially (#10897),
so the tracker sees fewer unparseable reads. Its own `startLine`/`lineCount`
tolerances stay as the belt-and-braces layer.

**`extensions/lib/checkpoint-meta.ts` — NONE.** `ctx.getContextUsage()?.tokens` is
unchanged (`number | null`), and `estimatedTokensAfter` is still only visible in
`ctx.compact().onComplete` in 1.3.0 (verified in `agent-session.ts` `compact()` /
`_runAutoCompaction`). The load-bearing comment in that file stays true.

**Blast radius warning:** `settings.json` loads 14 extension entries; only 4 were in
scope. `pi.on()` now returning an unsubscribe function (0.86.0) and `user_bash` failing
closed (0.86.0) are silent behavior changes for the other ten.

## 5. Non-code deltas to check

- `themes/catppuccin-macchiato.json`: uses `vars` (1.2.0-compatible) but its `$schema`
  points at the old `badlogic/pi-mono` raw URL, and startup themes are now
  schema-validated (1.2.0 breaking). No `thinkingMax`/`appearance` keys — expected to
  fall back, not fail. Re-point the `$schema` to `https://pi.dev/schemas/theme.schema.json`.
- `settings.json`: every key used (`defaultProvider`, `defaultModel`, `theme`,
  `extensions`, `defaultThinkingLevel`, `hideThinkingBlock`, `httpIdleTimeoutMs`,
  `shellCommandPrefix`, `lastChangelogVersion`) still exists in 1.3.0's settings
  reference. New defaults the user will notice: `tuiMode: "fullscreen"`,
  `theme: "system"` (overridden here), `retry.*` retries on by default.
- `keybindings.json` (`app.session.new/tree/fork/resume`): action ids not verified
  against 1.3.0 — check the startup diagnostics after upgrading (invalid actions are
  reported). `Home`/`End` semantics changed in 1.0.3.
- Sessions stay format v3 both directions; 1.3.0 compaction entries gain
  `systemMessage`, which 0.83.0 ignores on read (it would replay retained system
  messages instead of the checkpoint). Rollback is lossless enough, not identical.

## 6. Suggested sequence

1. **Land summary ownership on 0.83.0** (sanity-check §6.2). Reason-based dispatch:
   `reason === "threshold" | "overflow"` → fleet; `manual` → checkpoint's marker path;
   delete the silent fleet→default fallback and surface the error. Keep the marker —
   §2 shows `reason` cannot distinguish checkpoint from `/compact`.
2. `tsc --noEmit` is not available (no `package.json`/`tsconfig`, extensions are
   jiti-stripped), so treat the `compaction-model.ts` header-type fix as a compile-time
   obligation of step 1's reviewer, not something the runtime will tell you about.
3. Upgrade: `npm i -g @earendil-works/pi-coding-agent@1.3.0` (or the managed installer).
4. Fix `compaction-model.ts` for 1.3.0: filter `null` headers (or reuse pi's
   `withoutDeletedHeaders` semantics), forward `auth.env`, and pass
   `ctx.sessionManager.getSessionId()` as `compact(..., sessionId)` so fleet compaction
   routing is explicit rather than accidental.
5. Smoke matrix, in this order: start a session and `/reload` (all 14 extensions load
   without errors) → one `read` then a `checkpoint` tool call (injection + token delta
   in the notify, i.e. `estimatedTokensAfter` non-null) → `/checkpoints` → `/compact`
   (verbatim summary survives, fleet path exercised or refused loudly) → let a session
   cross the threshold (auto-compaction archives, does not touch the summary) →
   `/go` fork → one subagent spawn + one peer-link message.
6. Rollback: reinstall 0.83.0; no session migration to undo.

## 7. Go/no-go

**GO, after step 1, not before.** Nothing in the four in-scope files is structurally
broken by 1.3.0 — one type mismatch and one routing fix — and the delta carries real
value: retried compaction/ summarization (0.84.3/0.86.0), truncated-summary refusal
(0.84.3), malformed-tool-arg rejection and `read` label fixes (1.3.0), and an 11-week
security/bug tail. What it does **not** buy is any of the APIs this evaluation was
scoped around; if the only motive were `reason`/`message_end`/`retainedTail`, the
answer would be **no-go, do nothing**. The sequencing matters more than the verdict:
upgrading first would silently arm the fleet-summary override before the ownership
rule exists to arbitrate it.

## Sources

- <https://registry.npmjs.org/@earendil-works/pi-coding-agent> — `dist-tags.latest = 1.3.0`, publish dates, full version list
- <https://github.com/earendil-works/pi/blob/main/packages/coding-agent/CHANGELOG.md> — all release entries 0.83.0 → 1.3.0 plus `[Unreleased]`
- <https://raw.githubusercontent.com/earendil-works/pi/v1.3.0/packages/coding-agent/src/core/extensions/types.ts> — 1.3.0 `ExtensionContext`, events, `ToolDefinition`, `MessageEndEventResult`
- <https://raw.githubusercontent.com/earendil-works/pi/v1.3.0/packages/coding-agent/src/core/compaction/compaction.ts> — `CompactionResult`, `compact()`, `completeSummarization`, `getSummarizationFailure`
- <https://raw.githubusercontent.com/earendil-works/pi/v1.3.0/packages/coding-agent/src/core/agent-session.ts> — `reason` values, `estimatedTokensAfter`, `ctx.compact` wiring, `_runDefaultCompaction`
- <https://raw.githubusercontent.com/earendil-works/pi/v1.3.0/packages/coding-agent/src/core/model-registry.ts> — `ResolvedRequestAuth` / `ProviderHeaders`
- <https://raw.githubusercontent.com/earendil-works/pi/v1.3.0/packages/coding-agent/src/core/session-manager.ts> — `CompactionEntry.systemMessage`, `appendCompaction`, `SessionManager.create`
- <https://raw.githubusercontent.com/earendil-works/pi/v1.3.0/packages/coding-agent/docs/session-format.md> — no `retainedTail`; `systemMessage` checkpoint
- <https://raw.githubusercontent.com/earendil-works/pi/v1.3.0/packages/coding-agent/docs/settings.md> — 1.3.0 settings keys and defaults
- Installed 0.83.0 tree: `dist/core/extensions/types.d.ts` (`:205-249`, `:447-458`, `:691-694`, `:796-799`), `dist/core/compaction/compaction.d.ts:18,136`, `dist/core/model-registry.d.ts:5-29`, `dist/core/agent-session.js:1392-1397,1437-1456`, `docs/session-format.md:240-342`
