/**
 * Session-log hooks (tfd) — keep a session's log current without being asked.
 *
 * A repo carrying `scripts/session_log.py` gets one line of context at session
 * start (which log is yours, or how to open one), its log's state after a
 * compaction, and a nudge when the agent settles with decision/registry
 * changes no active log points at. The script decides the text; this extension
 * runs it and injects exactly what it printed. Repos without the script are
 * silent. Subagents skip: the top-level session owns the log and its own settle
 * nudge sees the same repo changes.
 *
 * Contract: docs/design/session-log-hooks.md; decision:
 * decisions/external-tools/004-session-log-hooks.md.
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { runSessionLogHook, type SessionLogEvent } from "./lib.ts";

export default function (pi: ExtensionAPI) {
	if (process.env.PI_SUBAGENT_DEPTH) return;

	// One nudge per turn: a nudge starts a turn, and if the model does not act
	// on it, settling again must not start another. Cleared at each user prompt
	// or session start (a fresh interaction gets a fresh nudge).
	let stopNudged = false;

	const hookText = (ctx: ExtensionContext, event: SessionLogEvent): Promise<string> =>
		runSessionLogHook({
			startDir: ctx.cwd,
			event,
			sessionId: ctx.sessionManager.getSessionId(),
			harness: "pi",
			exec: (command, args, options) => pi.exec(command, args, options),
		});

	const inject = (text: string, triggerTurn = false): void => {
		pi.sendMessage({ customType: "session-log", content: text, display: true }, { triggerTurn });
	};

	pi.on("session_start", async (_event, ctx) => {
		stopNudged = false;
		try {
			const text = await hookText(ctx, "start");
			if (text) inject(text);
		} catch {
			// A hook must never break the session.
		}
	});

	pi.on("session_compact", async (_event, ctx) => {
		try {
			const text = await hookText(ctx, "compact");
			if (text) inject(text);
		} catch {}
	});

	pi.on("before_agent_start", async () => {
		stopNudged = false;
	});

	pi.on("agent_settled", async (_event, ctx) => {
		// Check the guard before touching the hook or the session: once nudged,
		// this turn must not run the hook again (the nudge itself starts a turn,
		// and settling again must not start another), and in a one-shot session
		// pi is already disposing, handing the next emission a stale ctx.
		if (stopNudged) return;
		try {
			const text = await hookText(ctx, "stop");
			if (!text) return;
			stopNudged = true;
			inject(text, true);
		} catch {}
	});
}
