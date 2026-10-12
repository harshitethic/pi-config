/**
 * Session-log hooks: the shared plumbing (lib.ts), the pi extension
 * (index.ts) wired to a fake ExtensionAPI, and the Claude Code CLI
 * (external.ts) driven with real subprocesses as Claude hooks would.
 *
 * The fixture is a repo-shaped temp dir with a fake scripts/session_log.py
 * that echoes its argv, so assertions are about the contract — which event and
 * session id the harness passes, what cwd, and what gets injected — not about
 * tfd's own script.
 */

import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { mkdtemp, mkdir, writeFile, rm, realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import loadExtension from "../extensions/session-log/index.ts";
import { findSessionLogScript, HOOK_TIMEOUT_MS, runSessionLogHook } from "../extensions/session-log/lib.ts";

const CLI = join(import.meta.dir, "..", "extensions", "session-log", "external.ts");

const STUB_PY = `
import os, sys
mode = os.environ.get("SESSION_LOG_STUB_MODE", "")
if mode == "empty":
    sys.exit(0)
if mode == "fail":
    sys.exit(3)
if mode == "sleep":
    import time
    time.sleep(30)
print("stub " + " ".join(sys.argv[1:]) + " cwd=" + os.path.realpath(os.getcwd()))
`;

/** A tmp repo (root + scripts/session_log.py) and a bare tmp dir beside it. */
let repo: string;
let bare: string;
let failing: string;

// A subagent session inherits PI_SUBAGENT_DEPTH, and index.ts skips itself when
// it is set — so the suite must be green from inside a subagent, where the
// reviewers run. Snapshot, sanitize in beforeAll, restore in afterAll
// (tests/subagent-nesting.test.ts uses the same pattern).
const savedSubagentDepth = process.env.PI_SUBAGENT_DEPTH;

beforeAll(async () => {
	delete process.env.PI_SUBAGENT_DEPTH;
	repo = await realpath(await mkdtemp(join(tmpdir(), "session-log-repo-")));
	bare = await realpath(await mkdtemp(join(tmpdir(), "session-log-bare-")));
	failing = await realpath(await mkdtemp(join(tmpdir(), "session-log-fail-")));
	await mkdir(join(repo, "scripts"), { recursive: true });
	await mkdir(join(repo, "src", "deep"), { recursive: true });
	await writeFile(join(repo, "scripts", "session_log.py"), STUB_PY);
	await mkdir(join(failing, "scripts"), { recursive: true });
	await writeFile(join(failing, "scripts", "session_log.py"), "import sys\nsys.exit(3)\n");
});
afterAll(async () => {
	if (savedSubagentDepth === undefined) delete process.env.PI_SUBAGENT_DEPTH;
	else process.env.PI_SUBAGENT_DEPTH = savedSubagentDepth;
	for (const dir of [repo, bare, failing]) {
		try {
			await rm(dir, { recursive: true, force: true });
		} catch {}
	}
});

// ---------------------------------------------------------------------------
// lib.ts
// ---------------------------------------------------------------------------

describe("findSessionLogScript", () => {
	it("finds the script at the root and from a subdirectory", () => {
		expect(findSessionLogScript(repo)).toBe(join(repo, "scripts", "session_log.py"));
		expect(findSessionLogScript(join(repo, "src", "deep"))).toBe(join(repo, "scripts", "session_log.py"));
	});

	it("returns null when no ancestor has one", () => {
		expect(findSessionLogScript(bare)).toBe(null);
	});
});

describe("runSessionLogHook", () => {
	it("runs the script from the repo root with the event and session id", async () => {
		const text = await runSessionLogHook({ harness: "pi", startDir: join(repo, "src"), event: "compact", sessionId: "sid-9" });
		expect(text).toBe(`stub hook compact --session sid-9 --harness pi --cwd ${join(repo, "src")} cwd=${repo}`);
	}, 15_000);

	it("is empty when the repo has no script", async () => {
		expect(await runSessionLogHook({ harness: "pi", startDir: bare, event: "start", sessionId: "sid-9" })).toBe("");
	});

	it("is empty when the script exits non-zero", async () => {
		expect(await runSessionLogHook({ harness: "pi", startDir: failing, event: "start", sessionId: "sid-9" })).toBe("");
	}, 15_000);

	it("is empty when the script exceeds the timeout", async () => {
		process.env.SESSION_LOG_STUB_MODE = "sleep";
		try {
			const started = Date.now();
			expect(await runSessionLogHook({ harness: "pi", startDir: repo, event: "start", sessionId: "s", timeoutMs: 100 })).toBe("");
			expect(Date.now() - started).toBeLessThan(5_000);
		} finally {
			delete process.env.SESSION_LOG_STUB_MODE;
		}
	}, 15_000);

	it("is empty when the script exits non-zero (partial stdout is discarded)", async () => {
		// The real `pi.exec` returns non-zero rather than throwing, so a script
		// that prints then fails must not leak its partial output.
		const exec = async () => ({ stdout: "partial junk", code: 1 });
		expect(await runSessionLogHook({ harness: "pi", startDir: repo, event: "stop", sessionId: "s", exec })).toBe("");
	});

	it("passes the repo root, the session cwd, and the default timeout to exec", async () => {
		let seen: { cwd?: string; timeout?: number } | undefined;
		let args: string[] = [];
		const exec = async (_cmd: string, argv: string[], options?: { cwd?: string; timeout?: number }) => {
			args = argv;
			seen = options;
			return { stdout: "", code: 0 };
		};
		await runSessionLogHook({ harness: "pi", startDir: join(repo, "src"), event: "start", sessionId: "s", exec });
		expect(seen?.cwd).toBe(repo); // exec cwd: the script's repo root
		expect(args.slice(-4)).toEqual(["--harness", "pi", "--cwd", join(repo, "src")]); // --cwd: the session's own dir
		expect(seen?.timeout).toBe(HOOK_TIMEOUT_MS);
	});

	it("resolves the session cwd before passing it as --cwd", async () => {
		let args: string[] = [];
		const exec = async (_cmd: string, argv: string[]) => {
			args = argv;
			return { stdout: "", code: 0 };
		};
		await runSessionLogHook({ harness: "pi", startDir: `${repo}/src/..`, event: "start", sessionId: "s", exec });
		expect(args.slice(-2)).toEqual(["--cwd", repo]);
	});

	it("trims trailing whitespace and keeps leading whitespace", async () => {
		const script = join(repo, "scripts", "session_log.py");
		const calls: string[][] = [];
		const exec = async (_cmd: string, args: string[]) => {
			calls.push(args);
			return { stdout: "  indented  \n\n", code: 0 };
		};
		expect(await runSessionLogHook({ harness: "pi", startDir: repo, event: "start", sessionId: "s", exec })).toBe("  indented");
		expect(calls[0][0]).toBe(script);
		const empty = async () => ({ stdout: " \n", code: 0 });
		expect(await runSessionLogHook({ harness: "pi", startDir: repo, event: "start", sessionId: "s", exec: empty })).toBe("");
	});
});

// ---------------------------------------------------------------------------
// pi extension (index.ts)
// ---------------------------------------------------------------------------

interface Sent {
	message: { customType: string; content: string; display: boolean };
	options: { triggerTurn?: boolean };
}

async function loadPi(cwd = repo, opts: { execThrows?: boolean; execResult?: { stdout: string; code: number } } = {}) {
	const handlers = new Map<string, (event: any, ctx: any) => Promise<any> | any>();
	const sent: Sent[] = [];
	const execCalls: string[][] = [];
	const fakePi: any = {
		on(event: string, handler: any) {
			handlers.set(event, handler);
		},
		sendMessage(message: any, options: any) {
			sent.push({ message, options });
		},
		async exec(command: string, args: string[], options?: any) {
			execCalls.push(args);
			if (opts.execThrows) throw new Error("exec unavailable");
			if (opts.execResult) return opts.execResult;
			const p = Bun.spawnSync([command, ...args], { cwd: options?.cwd, env: process.env });
			return { stdout: p.stdout.toString(), code: p.exitCode ?? 1 };
		},
	};
	loadExtension(fakePi);
	return { handlers, sent, execCalls, ctx: { cwd, sessionManager: { getSessionId: () => "sid-1" } } };
}

describe("pi extension wiring", () => {
	it("injects the start text at session start and compact text after compaction", async () => {
		const { handlers, sent, ctx } = await loadPi();
		await handlers.get("session_start")!({ type: "session_start" }, ctx);
		expect(sent).toHaveLength(1);
		expect(sent[0].message.customType).toBe("session-log");
		expect(sent[0].message.display).toBe(true);
		expect(sent[0].message.content).toContain(`stub hook start --session sid-1 --harness pi`);
		expect(sent[0].options?.triggerTurn).toBe(false);

		await handlers.get("session_compact")!({ type: "session_compact" }, ctx);
		expect(sent).toHaveLength(2);
		expect(sent[1].message.content).toContain(`stub hook compact --session sid-1 --harness pi`);
		expect(sent[1].options?.triggerTurn).toBe(false);
	}, 15_000);

	it("nudges at most once per settle episode, re-armed by a user prompt", async () => {
		const { handlers, sent, ctx } = await loadPi();
		await handlers.get("agent_settled")!({ type: "agent_settled" }, ctx);
		expect(sent).toHaveLength(1);
		expect(sent[0].message.content).toContain(`stub hook stop --session sid-1 --harness pi`);
		expect(sent[0].options?.triggerTurn).toBe(true);

		// Same episode: the nudge started a turn; settling again must not start another.
		await handlers.get("agent_settled")!({ type: "agent_settled" }, ctx);
		expect(sent).toHaveLength(1);

		// A user prompt re-arms it.
		await handlers.get("before_agent_start")!({ type: "before_agent_start" }, ctx);
		await handlers.get("agent_settled")!({ type: "agent_settled" }, ctx);
		expect(sent).toHaveLength(2);
	}, 15_000);

	it("does not re-check the hook once it has nudged, until the user prompts again", async () => {
		const { handlers, sent, execCalls, ctx } = await loadPi();
		await handlers.get("agent_settled")!({ type: "agent_settled" }, ctx);
		expect(sent).toHaveLength(1);
		expect(execCalls.length).toBe(1); // one settle, one hook run
		const afterNudge = execCalls.length;

		// Same episode: no hook run, no second turn.
		await handlers.get("agent_settled")!({ type: "agent_settled" }, ctx);
		expect(sent).toHaveLength(1);
		expect(execCalls.length).toBe(afterNudge);

		// A user prompt re-arms it, and the next settle checks once.
		await handlers.get("before_agent_start")!({ type: "before_agent_start" }, ctx);
		await handlers.get("agent_settled")!({ type: "agent_settled" }, ctx);
		expect(sent).toHaveLength(2);
		expect(execCalls.length).toBe(afterNudge + 1);
	}, 15_000);

	it("re-arms the settle nudge at session start", async () => {
		const { handlers, sent, ctx } = await loadPi();
		await handlers.get("agent_settled")!({ type: "agent_settled" }, ctx);
		expect(sent).toHaveLength(1);

		await handlers.get("session_start")!({ type: "session_start" }, ctx); // start text + guard reset
		expect(sent).toHaveLength(2);
		await handlers.get("agent_settled")!({ type: "agent_settled" }, ctx);
		expect(sent).toHaveLength(3);
		expect(sent[2].options?.triggerTurn).toBe(true);
	}, 15_000);

	it("injects nothing when the hook prints nothing", async () => {
		const { handlers, sent, ctx } = await loadPi();
		process.env.SESSION_LOG_STUB_MODE = "empty";
		try {
			await handlers.get("session_start")!({ type: "session_start" }, ctx);
			await handlers.get("session_compact")!({ type: "session_compact" }, ctx);
		} finally {
			delete process.env.SESSION_LOG_STUB_MODE;
		}
		expect(sent).toHaveLength(0);
	}, 15_000);

	it("stays silent in a repo with no script", async () => {
		const { handlers, sent, ctx } = await loadPi(bare);
		await handlers.get("session_start")!({ type: "session_start" }, ctx);
		await handlers.get("session_compact")!({ type: "session_compact" }, ctx);
		await handlers.get("agent_settled")!({ type: "agent_settled" }, ctx);
		expect(sent).toHaveLength(0);
	}, 15_000);

	it("does not register handlers in a subagent session", () => {
		const saved = process.env.PI_SUBAGENT_DEPTH;
		process.env.PI_SUBAGENT_DEPTH = "1";
		try {
			const handlers = new Map<string, unknown>();
			loadExtension({ on: (event: string, handler: unknown) => handlers.set(event, handler) } as any);
			expect(handlers.size).toBe(0);
		} finally {
			if (saved === undefined) delete process.env.PI_SUBAGENT_DEPTH;
			else process.env.PI_SUBAGENT_DEPTH = saved;
		}
	});

	it("contains exec failures instead of throwing", async () => {
		const { handlers, sent, ctx } = await loadPi(repo, { execThrows: true });
		await handlers.get("session_start")!({ type: "session_start" }, ctx);
		await handlers.get("agent_settled")!({ type: "agent_settled" }, ctx);
		expect(sent).toHaveLength(0);
	});

	it("stays silent when the hook exits non-zero with partial stdout", async () => {
		const { handlers, sent, ctx } = await loadPi(repo, { execResult: { stdout: "partial junk", code: 1 } });
		await handlers.get("session_start")!({ type: "session_start" }, ctx);
		await handlers.get("agent_settled")!({ type: "agent_settled" }, ctx);
		expect(sent).toHaveLength(0);
	});
});

// ---------------------------------------------------------------------------
// Claude Code CLI (external.ts)
// ---------------------------------------------------------------------------

function run(args: string[], input: unknown): { code: number; out: string; err: string } {
	const stdin = typeof input === "string" ? input : JSON.stringify(input);
	const p = Bun.spawnSync(["bun", CLI, ...args], {
		stdin: new TextEncoder().encode(stdin),
		env: process.env,
	});
	return { code: p.exitCode ?? -1, out: p.stdout.toString(), err: p.stderr.toString() };
}

describe("external.ts as Claude Code runs it", () => {
	it("SessionStart prints additionalContext, picking start vs compact from source", () => {
		const start = run(["hook", "session-start"], { session_id: "sid-7", cwd: repo, source: "startup" });
		expect(start.code).toBe(0);
		const startJson = JSON.parse(start.out);
		expect(startJson.hookSpecificOutput.hookEventName).toBe("SessionStart");
		expect(startJson.hookSpecificOutput.additionalContext).toContain(`stub hook start --session sid-7 --harness claude-code --cwd ${repo}`);

		const compact = run(["hook", "session-start"], { session_id: "sid-7", cwd: repo, source: "compact" });
		expect(JSON.parse(compact.out).hookSpecificOutput.additionalContext).toContain(
			`stub hook compact --session sid-7 --harness claude-code --cwd ${repo}`,
		);
	}, 15_000);

	it("prompt prints the stop nudge as UserPromptSubmit context", () => {
		const prompt = run(["hook", "prompt"], { session_id: "sid-7", cwd: repo });
		expect(prompt.code).toBe(0);
		const json = JSON.parse(prompt.out);
		expect(json.hookSpecificOutput.hookEventName).toBe("UserPromptSubmit");
		expect(json.hookSpecificOutput.additionalContext).toContain(`stub hook stop --session sid-7 --harness claude-code --cwd ${repo}`);
	}, 15_000);

	it("prompt stays silent when the hook is clean", () => {
		process.env.SESSION_LOG_STUB_MODE = "empty";
		try {
			const prompt = run(["hook", "prompt"], { session_id: "sid-7", cwd: repo });
			expect(prompt.code).toBe(0);
			expect(prompt.out).toBe("");
		} finally {
			delete process.env.SESSION_LOG_STUB_MODE;
		}
	}, 15_000);

	it("prints nothing outside a repo with the script, and without a session id", () => {
		const outside = run(["hook", "session-start"], { session_id: "sid-7", cwd: bare, source: "startup" });
		expect(outside.code).toBe(0);
		expect(outside.out).toBe("");
		const noId = run(["hook", "session-start"], { cwd: repo, source: "startup" });
		expect(noId.code).toBe(0);
		expect(noId.out).toBe("");
	}, 15_000);

	it("fails loud on CLI misuse and stays silent on malformed stdin", () => {
		const bogus = run(["hook", "bogus"], { session_id: "sid-7" });
		expect(bogus.code).toBe(1);
		expect(bogus.err).toContain('unknown hook event "bogus"');

		// A typo must fail loud even without a session id (validated before stdin).
		const bogusNoId = run(["hook", "bogus"], {});
		expect(bogusNoId.code).toBe(1);

		const bareInvocation = run([], {});
		expect(bareInvocation.code).toBe(1);
		expect(bareInvocation.err).toContain("usage:");

		const malformed = run(["hook", "session-start"], "{not json");
		expect(malformed.code).toBe(0);
		expect(malformed.out).toBe("");
	}, 15_000);
});
