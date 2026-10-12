#!/usr/bin/env bun
/**
 * Session-log hooks for Claude Code (not a pi extension — pi loads only
 * session-log/index.ts). Driven by Claude Code hooks (stdin = hook input JSON):
 *
 *   external.ts hook session-start   context for this session's log; the
 *                                    `source` field picks start vs compact
 *   external.ts hook prompt          nudge when the log is behind
 *
 * Repos without scripts/session_log.py (everything but tfd) print nothing, so
 * the same hooks are safe to install globally. The stop check rides the user's
 * prompt, never Claude Code's Stop event: a Stop-hook nudge would continue the
 * turn with no human (decisions/external-tools/003). Claude-side wiring:
 * docs/design/session-log-hooks.md.
 */

import * as fs from "node:fs";
import { runSessionLogHook, type SessionLogEvent } from "./lib.ts";

interface HookInput {
	session_id?: string;
	cwd?: string;
	/** SessionStart: startup | resume | clear | compact | fork. */
	source?: string;
}

function readInput(): HookInput {
	try {
		return JSON.parse(fs.readFileSync(0, "utf8")) as HookInput;
	} catch {
		return {};
	}
}

function emitContext(event: string, text: string): void {
	process.stdout.write(
		JSON.stringify({ hookSpecificOutput: { hookEventName: event, additionalContext: text } }),
	);
}

async function hook(event: string): Promise<void> {
	// Validate the event before reading stdin: a typo in the settings entry is a
	// config error and must fail loud, not read as "no session id".
	if (event !== "session-start" && event !== "prompt") {
		throw new Error(`unknown hook event "${event}"`);
	}

	const input = readInput();
	if (!input.session_id) return;
	const startDir = input.cwd ?? process.cwd();
	const run = (kind: SessionLogEvent) =>
		runSessionLogHook({ startDir, event: kind, sessionId: input.session_id as string });

	if (event === "session-start") {
		const text = await run(input.source === "compact" ? "compact" : "start");
		if (text) emitContext("SessionStart", text);
		return;
	}
	const text = await run("stop");
	if (text) emitContext("UserPromptSubmit", text);
}

if (import.meta.main) {
	const [cmd, ...args] = process.argv.slice(2);
	try {
		if (cmd === "hook") await hook(args[0] ?? "");
		else throw new Error("usage: external.ts hook <session-start | prompt>");
	} catch (err) {
		console.error(`session-log external: ${(err as Error).message}`);
		process.exit(1);
	}
}
