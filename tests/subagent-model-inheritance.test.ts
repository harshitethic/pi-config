// LIVE-NETWORK: this file makes real billed LLM calls on every full `bun test` run.
// Provider/model: openrouter/xiaomi/mimo-v2.6-flash — the real `pi` binary on an unpinned
// orchestrator seat, fixed ~13.9k system prompt / ~12 output tokens per spawn.
// Invisible to session-log attribution: `afterEach` deletes the child transcripts.
// See docs/investigations/or-workspace-attribution-2026-10.md.

/**
 * Decision 031: the orchestrator seat always runs on its caller's model —
 * caller's `provider/id` at the seat's own thinking level — while every other
 * seat keeps the pre-existing rule (frontmatter model; `inheritParentModel` is
 * the explicit per-spawn opt-in).
 *
 * Three layers, because the resolver matrix alone cannot catch an unwired call
 * site:
 *  - the matrix pins precedence;
 *  - spawns through the `subagent` tool pin the wiring twice over — the written
 *    `meta.json` and the child process's own `--model` argv;
 *  - a real `subagent_resume` pins that a resumed child answers on the recorded
 *    model even when the resuming session runs another one.
 *
 * Why `ps` and not the child's session header: pi creates a session file
 * lazily when spawned with `--session-id` — observed 2026-10-08, no file exists
 * until the first append (a bare `get_state` left none behind), so a header read
 * is a race against the first model call and timed out under load. The argv is
 * written synchronously with the spawn, and transcript reads below happen only
 * after a turn has completed, when the file is certain to exist.
 *
 * Run: bun test tests/subagent-model-inheritance.test.ts
 */

import { waitUntilUntracked } from "./helpers/subagent-lifecycle.ts";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "bun:test";
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync, realpathSync, unlinkSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import subagentFactory, {
	metaPath,
	readMetaJson,
	resolveChildModel,
} from "../extensions/subagent-async/index.ts";
import { childEnv, scrubSubagentEnv } from "./helpers/subagent-env.ts";

// What agents/orchestrator.md pins (the seat's own audited level, decision 022).
const ORCHESTRATOR_SEAT = "opencode-go/deepseek-v4.1-flash:max";
// A caller that is deliberately NOT on the seat's model — that is the whole
// point of the rule; on today's single-slug fleet this is the no-op case.
const OTHER_CALLER = "openrouter/xiaomi/mimo-v2.6-flash";

describe("resolveChildModel — the orchestrator seat tracks its caller", () => {
	it("runs the child on the caller's model, at the seat's own level", () => {
		expect(
			resolveChildModel({
				agentName: "orchestrator",
				agentModel: ORCHESTRATOR_SEAT,
				parentModel: OTHER_CALLER,
			}),
		).toBe(`${OTHER_CALLER}:max`);
	});

	it("inherits regardless of inheritParentModel (its default is false, so `false` cannot mean opt-out)", () => {
		expect(
			resolveChildModel({
				agentName: "orchestrator",
				agentModel: ORCHESTRATOR_SEAT,
				parentModel: OTHER_CALLER,
				inheritParentModel: false,
			}),
		).toBe(`${OTHER_CALLER}:max`);
	});

	it("adds no level when the seat pins none", () => {
		expect(
			resolveChildModel({
				agentName: "orchestrator",
				agentModel: "opencode-go/deepseek-v4.1-flash",
				parentModel: OTHER_CALLER,
			}),
		).toBe(OTHER_CALLER);
	});

	it("does not mistake a non-level suffix for a level", () => {
		// `:free` is part of an OpenRouter slug, not a thinking level — a resolver
		// that stripped the last colon segment unconditionally would corrupt the id.
		expect(
			resolveChildModel({
				agentName: "orchestrator",
				agentModel: "openrouter/deepseek/deepseek-v4.1-flash-1017:free",
				parentModel: OTHER_CALLER,
			}),
		).toBe(OTHER_CALLER);
	});

	it("falls back to the seat's model — never to 'no model' — when the caller's model is unavailable", () => {
		expect(
			resolveChildModel({
				agentName: "orchestrator",
				agentModel: ORCHESTRATOR_SEAT,
				parentModel: undefined,
			}),
		).toBe(ORCHESTRATOR_SEAT);
		// The one edge this decision changes: the old code fell through the
		// inherit branch and produced `undefined` (no --model flag at all).
		expect(
			resolveChildModel({
				agentName: "orchestrator",
				agentModel: ORCHESTRATOR_SEAT,
				parentModel: undefined,
				inheritParentModel: true,
			}),
		).toBe(ORCHESTRATOR_SEAT);
		expect(
			resolveChildModel({ agentName: "orchestrator", agentModel: undefined, parentModel: undefined }),
		).toBe("opencode-go/deepseek-v4.1-flash");
	});
});

describe("resolveChildModel — every other seat keeps the existing rule", () => {
	it("keeps the frontmatter model even when the caller is on a different one", () => {
		expect(
			resolveChildModel({
				agentName: "implement",
				agentModel: "opencode-go/deepseek-v4.1-flash:high",
				parentModel: OTHER_CALLER,
			}),
		).toBe("opencode-go/deepseek-v4.1-flash:high");
	});

	it("passes the caller's model through unsubstituted when the spawn opts in (decision 020)", () => {
		expect(
			resolveChildModel({
				agentName: "implement",
				agentModel: "opencode-go/deepseek-v4.1-flash:high",
				parentModel: OTHER_CALLER,
				inheritParentModel: true,
			}),
		).toBe(OTHER_CALLER);
	});

	it("preserves the opt-in edge: no caller model and no frontmatter model yields no --model flag", () => {
		// Pre-existing behavior — an explicit opt-in with nothing to inherit is
		// not silently rewritten into the fleet model.
		expect(
			resolveChildModel({ agentName: "implement", agentModel: undefined, parentModel: undefined, inheritParentModel: true }),
		).toBeUndefined();
	});

	it("falls back to the fleet model when the seat pins no model (decision 022)", () => {
		expect(resolveChildModel({ agentName: "scout-code", agentModel: undefined, parentModel: OTHER_CALLER })).toBe(
			"opencode-go/deepseek-v4.1-flash",
		);
	});

	it("keeps the recorded model verbatim on resume — even for the orchestrator seat", () => {
		// Decision 022 site 2: resume reproduces what ran. Re-deriving here would
		// silently switch the model of a resumed child.
		expect(
			resolveChildModel({
				agentName: "orchestrator",
				agentModel: ORCHESTRATOR_SEAT,
				parentModel: OTHER_CALLER,
				inheritParentModel: false,
				isResume: true,
			}),
		).toBe(ORCHESTRATOR_SEAT);
	});

	it("falls back to the fleet model on resume when an old meta recorded none", () => {
		expect(resolveChildModel({ agentName: "implement", agentModel: undefined, isResume: true })).toBe(
			"opencode-go/deepseek-v4.1-flash",
		);
	});
});

// ── Tool boundary (real spawns) ─────────────────────────────────────────────
// The harness re-invokes pi from `process.argv[1]` (that is pi's entry when the
// extension runs inside pi). Under `bun test` argv[1] is this test file, so the
// child would be `bun <testfile> --mode rpc …`; point it at the real pi entry
// for the duration of these spawns.
function resolvePiEntry(): string {
	for (const dir of (process.env.PATH ?? "").split(":").filter(Boolean)) {
		const candidate = join(dir, "pi");
		if (existsSync(candidate)) return realpathSync(candidate);
	}
	throw new Error("pi is not on PATH — the spawn tests need pi's entry to re-invoke it");
}

let savedArgv1: string | undefined;
// The rows spawn `orchestrator`/`implement` through the tool gate, whose
// allowlist and nesting-cap reads are env-driven — that sensitivity is the
// feature under test, so this file runs the gate on a controlled env of its own
// rather than on whatever its runner inherited (pi-config#9).
let restoreSubagentEnv: () => void = () => {};
beforeAll(() => {
	restoreSubagentEnv = scrubSubagentEnv();
	savedArgv1 = process.argv[1];
	process.argv[1] = resolvePiEntry();
});
afterAll(() => {
	if (savedArgv1 !== undefined) process.argv[1] = savedArgv1;
	restoreSubagentEnv();
});

function createPiStub() {
	const tools = new Map<string, any>();
	const pi: any = {
		events: { emit: () => {} },
		registerTool: (def: any) => tools.set(def.name, def),
		registerCommand: () => {},
		on: () => {},
		sendUserMessage: () => {},
		ui: { setStatus: () => {}, notify: () => {}, setWidget: () => {} },
	};
	return { pi, tools };
}

function createCtxStub(cwd: string, model: { provider: string; id: string }) {
	return {
		cwd,
		ui: { setStatus: () => {}, notify: () => {}, setWidget: () => {}, clearStatus: () => {} },
		getModel: () => model,
		sessionManager: { getBranch: () => [], getEntries: () => [] },
	};
}

type Child = { sid: string; tools: Map<string, any>; ctx: any; killed: boolean };

const children: Child[] = [];

async function spawnChild(agentName: string, callerModel: { provider: string; id: string }): Promise<Child> {
	const { pi, tools } = createPiStub();
	subagentFactory(pi);
	const ctx = createCtxStub(process.cwd(), callerModel);

	const res = await tools.get("subagent").execute(
		"tc",
		{
			agent: agentName,
			task: "Reply with the single word: ok",
			cwd: process.cwd(),
			isolate: false,
			// A throwaway smoke child: skip the review-gate soft prompt so it
			// answers in one turn instead of re-entering the agent loop.
			review_policy: "skip",
		},
		undefined,
		undefined,
		ctx,
	);
	const match = /session: (subagent-[0-9a-f-]+)/.exec(res.content[0].text);
	expect(match).toBeTruthy();
	const child: Child = { sid: match![1], tools, ctx, killed: false };
	children.push(child);
	return child;
}

async function killChild(child: Child): Promise<void> {
	if (child.killed) return;
	child.killed = true;
	try {
		await child.tools.get("subagent_kill").execute("tk", { session_id: child.sid }, undefined, undefined, child.ctx);
	} catch {
		// best-effort: the child may already be gone
	}
}

/** Everything a spawn leaves on disk for this handle, removed after each test. */
function cleanupArtifacts(sid: string): void {
	const files = [metaPath(sid), `/tmp/pi-subagent-${sid}.log`, `/tmp/pi-subagent-${sid}.sock`];
	// The transcript's name carries the id as its suffix; its directory is the
	// cwd slug we cannot reconstruct, so scan the session root instead.
	const sessionsRoot = join(homedir(), ".pi", "agent", "sessions");
	try {
		for (const dir of readdirSync(sessionsRoot)) {
			for (const entry of readdirSync(join(sessionsRoot, dir))) {
				if (entry.endsWith(`_${sid}.jsonl`)) files.push(join(sessionsRoot, dir, entry));
			}
		}
	} catch {
		// no sessions root (or unreadable) — nothing to scan
	}
	for (const f of files) {
		try {
			if (existsSync(f)) unlinkSync(f);
		} catch {
			// best-effort cleanup
		}
	}
}

afterEach(async () => {
	for (const child of children.splice(0)) {
		await killChild(child);
		const settled = await waitUntilUntracked(child.sid);
		cleanupArtifacts(child.sid);
		if (!settled) {
			// The close handler can still write a footer after the initial unlink.
			await new Promise((r) => setTimeout(r, 250));
			cleanupArtifacts(child.sid);
		}
		const log = `/tmp/pi-subagent-${child.sid}.log`;
		expect(existsSync(log)).toBe(false);
	}
});

async function waitFor<T>(read: () => T | undefined | Promise<T | undefined>, ms: number, onTimeout?: () => string): Promise<T> {
	const deadline = Date.now() + ms;
	for (;;) {
		const value = await read();
		if (value !== undefined) return value;
		if (Date.now() > deadline) throw new Error(onTimeout?.() ?? `timed out after ${ms}ms`);
		await new Promise((r) => setTimeout(r, 250));
	}
}

/** The `--model` the harness actually launched the child with, from its argv. */
function argvModelOf(sid: string): string | undefined {
	let out: string;
	try {
		out = execFileSync("ps", ["-eww", "-o", "command="], { env: childEnv(), encoding: "utf8" });
	} catch {
		return undefined;
	}
	for (const line of out.split("\n")) {
		if (!line.includes(`--session-id ${sid}`)) continue;
		const m = /--model\s+(\S+)/.exec(line);
		if (m) return m[1];
	}
	return undefined;
}

/** Failure text: a red run must explain itself without a re-run. */
function diagnose(child: Child, what: string): string {
	const meta = (() => {
		try {
			return JSON.stringify(readMetaJson(child.sid));
		} catch {
			return "(unreadable)";
		}
	})();
	let logTail = "(no log file)";
	try {
		logTail = readFileSync(`/tmp/pi-subagent-${child.sid}.log`, "utf8").slice(-1500);
	} catch {
		// keep the placeholder
	}
	return `${what}\nmeta.json: ${meta}\nchild log tail:\n${logTail}`;
}

/** Model per assistant turn, in order — the only record of what produced a turn. */
function readAssistantModels(text: string): string[] {
	const out: string[] = [];
	for (const line of text.split("\n")) {
		if (!line.trim()) continue;
		try {
			const e = JSON.parse(line);
			if (e.type === "message" && e.message?.role === "assistant" && typeof e.message?.model === "string") {
				out.push(e.message.model);
			}
		} catch {
			// a torn final line while the child is still writing
		}
	}
	return out;
}

/**
 * Wait until the harness no longer tracks the child (it exited on its own or was
 * killed). By then its turn has completed, so its transcript exists.
 */
async function waitUntilDetached(child: Child): Promise<void> {
	await waitFor(
		async () => {
			const res = await child.tools
				.get("subagent_status")
				.execute("ts", { session_id: child.sid }, undefined, undefined, child.ctx);
			return /not attached to this session's tracker/.test(res.content[0].text) ? true : undefined;
		},
		90_000,
		() => diagnose(child, "the child never left the running tracker"),
	);
}

/** The child's transcript path, reported by its RPC handshake. */
function transcriptOf(child: Child): string | undefined {
	return (readMetaJson(child.sid) as any)?.sessionFile;
}

describe("subagent tool boundary — the resolved model really is what runs", () => {
	it(
		"spawns an orchestrator on the caller's model",
		async () => {
			const child = await spawnChild("orchestrator", { provider: "openrouter", id: "xiaomi/mimo-v2.6-flash" });

			// Written by the same execute() that launched the child…
			expect((readMetaJson(child.sid) as any)?.model).toBe(`${OTHER_CALLER}:max`);
			// …and handed to the child process as its model.
			expect(argvModelOf(child.sid), diagnose(child, `argv --model: expected ${OTHER_CALLER}:max`)).toBe(
				`${OTHER_CALLER}:max`,
			);
		},
		// Subprocess-spawning test: explicit budget, never bun's implicit 5s (#3).
		120_000,
	);

	it(
		"spawns a non-orchestrator on its frontmatter model, not the caller's",
		async () => {
			const child = await spawnChild("implement", { provider: "openrouter", id: "xiaomi/mimo-v2.6-flash" });

			expect((readMetaJson(child.sid) as any)?.model).toBe("opencode-go/deepseek-v4.1-flash:high");
			expect(argvModelOf(child.sid), diagnose(child, "argv --model: expected opencode-go/deepseek-v4.1-flash:high")).toBe(
				"opencode-go/deepseek-v4.1-flash:high",
			);
		},
		120_000,
	);

	it(
		"keeps the recorded model on resume, even when the resuming caller runs another model",
		async () => {
			const child = await spawnChild("orchestrator", { provider: "openrouter", id: "xiaomi/mimo-v2.6-flash" });
			expect((readMetaJson(child.sid) as any)?.model).toBe(`${OTHER_CALLER}:max`);

			// Let it answer its one-turn task and exit; the transcript exists now.
			await waitUntilDetached(child);
			const sessionFile = transcriptOf(child);
			expect(sessionFile).toBeTruthy();
			const modelsBefore = readAssistantModels(readFileSync(sessionFile!, "utf8"));
			expect(modelsBefore).toContain("xiaomi/mimo-v2.6-flash");

			// Resume from a session whose active model is a different one entirely.
			const resumedCtx = createCtxStub(process.cwd(), { provider: "openrouter", id: "deepseek/deepseek-v4.1-flash-1017" });
			const res = await child.tools
				.get("subagent_resume")
				.execute("tr", { session_id: child.sid, task: "Reply with the single word: ok" }, undefined, undefined, resumedCtx);
			expect(res.content[0].text).toContain("Subagent resumed");

			// The resumed turn lands in the same transcript; read the model that
			// produced it. `--model` is honored on resume (observed), so a resume
			// that re-derived the model from its caller would answer on deepseek.
			const resumedModels = await waitFor(
				() => {
					const models = readAssistantModels(readFileSync(sessionFile!, "utf8"));
					return models.length > modelsBefore.length ? models.slice(modelsBefore.length) : undefined;
				},
				90_000,
				() => diagnose(child, "the resumed child wrote no assistant turn to the transcript"),
			);
			// Decision 022 site 2: resume reproduces the recorded model.
			expect(resumedModels.every((m) => m === "xiaomi/mimo-v2.6-flash")).toBe(true);
		},
		240_000,
	);
});
