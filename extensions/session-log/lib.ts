/**
 * Session-log hook plumbing, shared by the pi extension (index.ts) and the
 * Claude Code hook CLI (external.ts).
 *
 * A session log is a repo-local artifact: only repos carrying
 * `scripts/session_log.py` (tfd) participate. The script prints the text the
 * harness injects; an absent script, a missing interpreter, a timeout or a
 * non-zero exit all read as "nothing to say". Contract:
 * docs/design/session-log-hooks.md.
 */

import { execFile } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";

export type SessionLogEvent = "start" | "compact" | "stop";

export type SessionLogHarness = "pi" | "claude-code";

/** Kill a hook that hangs; the script's own work is a few git/file reads. */
export const HOOK_TIMEOUT_MS = 10_000;

export interface HookExecResult {
	stdout: string;
	code: number;
}

/** Matches `pi.exec`; tests substitute a stub. */
export type HookExec = (
	command: string,
	args: string[],
	options?: { cwd?: string; timeout?: number },
) => Promise<HookExecResult>;

/**
 * Nearest ancestor of `startDir` (inclusive) holding scripts/session_log.py, so
 * a session working in a repo subdirectory still finds its repo's script.
 */
export function findSessionLogScript(startDir: string): string | null {
	for (let dir = path.resolve(startDir); ; ) {
		const candidate = path.join(dir, "scripts", "session_log.py");
		if (fs.existsSync(candidate)) return candidate;
		const parent = path.dirname(dir);
		if (parent === dir) return null;
		dir = parent;
	}
}

const defaultExec: HookExec = (command, args, options) =>
	new Promise((resolve) => {
		execFile(command, args, { cwd: options?.cwd, timeout: options?.timeout }, (error, stdout) => {
			resolve(error ? { stdout: "", code: 1 } : { stdout, code: 0 });
		});
	});

/** Text `hook <event>` printed, or "" when there is nothing to inject. */
export async function runSessionLogHook(opts: {
	startDir: string;
	event: SessionLogEvent;
	sessionId: string;
	/** Recorded in the log frontmatter the start text asks the agent to write. */
	harness: SessionLogHarness;
	exec?: HookExec;
	timeoutMs?: number;
}): Promise<string> {
	const script = findSessionLogScript(opts.startDir);
	if (!script) return "";
	// --cwd is the session's own directory, not the repo root the script is run
	// from: the log records where the session ran (tfd's `workdir:`).
	const sessionCwd = path.resolve(opts.startDir);
	try {
		const result = await (opts.exec ?? defaultExec)(
			"python3",
			[
				script,
				"hook",
				opts.event,
				"--session",
				opts.sessionId,
				"--harness",
				opts.harness,
				"--cwd",
				sessionCwd,
			],
			{ cwd: path.dirname(path.dirname(script)), timeout: opts.timeoutMs ?? HOOK_TIMEOUT_MS },
		);
		return result.code === 0 ? result.stdout.trimEnd() : "";
	} catch {
		return "";
	}
}
