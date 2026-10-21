/**
 * E2E tests for the checkpoint extension.
 *
 * Two layers:
 *   - live sessions via the SDK (real model): compaction, pairing, and one
 *     end-to-end flow where the answer can only come from the injection;
 *   - a deterministic handler-table harness driving the real extension's
 *     handlers with real files: read tracking and file injection, where model
 *     compliance has no say.
 *
 * Run:
 *   bash tests/setup.sh        # one-time: link global pi packages
 *   bun test tests/e2e-checkpoint.test.ts
 */

import { describe, expect, it, beforeAll, afterAll } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdtemp, writeFile, readFile, rm, readdir } from "node:fs/promises";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { Value } from "typebox/value";
import {
	createAgentSession,
	DefaultResourceLoader,
	getAgentDir,
	ModelRuntime,
	SessionManager,
	SettingsManager,
	type AgentSession,
} from "@earendil-works/pi-coding-agent";
import checkpointExtension from "../extensions/checkpoint";
import { takePendingGo } from "../extensions/go.ts";
import { childEnv, scrubSubagentEnv } from "./helpers/subagent-env.ts";

const CHECKPOINT_EXTENSION = join(
	import.meta.dir,
	"..",
	"extensions",
	"checkpoint.ts",
);

const NEEDLES = [
	"CRIMSON-FALCON-7291",
	"AZURE-DRAGONFLY-3847",
	"EMERALD-WOLVERINE-5102",
	"VIOLET-OSTRICH-6683",
	"SILVER-PANGOLIN-9470",
];

const TOOLS = ["read", "bash", "checkpoint", "checkpoint_fork"];

// The live rows run in a subagent session too, where the harness injects
// PI_SUBAGENT_*; the file controls that env instead of inheriting it, and every
// spawn passes childEnv() (tests/helpers/subagent-env.ts).
let restoreSubagentEnv: () => void = () => {};

beforeAll(() => {
	restoreSubagentEnv = scrubSubagentEnv();
});

afterAll(() => {
	restoreSubagentEnv();
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Create 5 haystack files, each 50 lines, needle at line 10. */
async function createHaystackFiles(dir: string): Promise<void> {
	for (let i = 0; i < 5; i++) {
		const lines: string[] = [];
		for (let j = 1; j <= 50; j++) {
			if (j === 10) {
				lines.push(`// SECRET: The activation code is ${NEEDLES[i]}`);
			} else {
				lines.push(
					`const placeholder_${j.toString().padStart(3, "0")} = () => { /* line ${j} */ };`,
				);
			}
		}
		await writeFile(join(dir, `haystack_${i + 1}.ts`), lines.join("\n") + "\n");
	}
}

/** Poll until the agent is idle for `stableMs` consecutive milliseconds. */
async function waitForSettled(
	session: AgentSession,
	timeoutMs = 180_000,
	stableMs = 3000,
): Promise<void> {
	const start = Date.now();
	const interval = 200;
	let stableCount = 0;
	const need = Math.ceil(stableMs / interval);
	while (Date.now() - start < timeoutMs) {
		await new Promise((r) => setTimeout(r, interval));
		if (session.isStreaming) {
			stableCount = 0;
		} else {
			stableCount++;
			if (stableCount >= need) return;
		}
	}
	throw new Error(
		`Timeout waiting for agent to settle (${timeoutMs / 1000}s). ` +
			`isStreaming=${session.isStreaming}`,
	);
}

/** Extract text from a message entry's content (handles string and block arrays). */
function getMessageText(entry: { message?: { content?: unknown } }): string {
	const content = entry.message?.content;
	if (typeof content === "string") return content;
	if (Array.isArray(content)) {
		return content
			.filter((b: { type?: string }) => b.type === "text")
			.map((b: { text?: string }) => b.text ?? "")
			.join("\n");
	}
	return "";
}

/** Get all user message texts from session entries. */
function getUserTexts(sm: SessionManager): string[] {
	return sm
		.getEntries()
		.filter((e) => e.type === "message" && (e as any).message?.role === "user")
		.map((e) => getMessageText(e as any));
}

/** Get all assistant message texts from session entries. */
function getAssistantTexts(sm: SessionManager): string[] {
	return sm
		.getEntries()
		.filter((e) => e.type === "message" && (e as any).message?.role === "assistant")
		.map((e) => getMessageText(e as any));
}

/** Count compaction entries. */
function compactionCount(sm: SessionManager): number {
	return sm.getEntries().filter((e) => e.type === "compaction").length;
}

/** Whether the active branch contains an assistant `checkpoint` tool call. */
function branchHasCheckpointToolCall(sm: SessionManager): boolean {
	return (sm.getBranch() as any[]).some(
		(entry) =>
			entry.type === "message" &&
			entry.message?.role === "assistant" &&
			(entry.message.content ?? []).some((b: any) => b?.type === "toolCall" && b.name === "checkpoint"),
	);
}

/**
 * Assert the active branch is structurally sound after a checkpoint: every
 * `toolResult` has a matching assistant `toolCall`, the checkpoint call has a
 * `toolResult`, and no `toolResult` is parented to a compaction entry.
 *
 * Regression guard for the incident where checkpoint compacted from inside the
 * tool's execute(), aborting the turn before its result was persisted; a late
 * tool result then attached to the compaction entry, and every subsequent
 * provider request 400'd on the orphan `toolResult`.
 */
function assertBranchToolCallPairing(sm: SessionManager): void {
	const branch = sm.getBranch() as any[];
	const callIds = new Set<string>();
	const compactionIds = new Set<string>();
	const checkpointCallIds = new Set<string>();
	const results: Array<{ toolCallId: string; parentId?: string }> = [];

	for (const entry of branch) {
		if (entry.type === "compaction") {
			compactionIds.add(entry.id);
			continue;
		}
		if (entry.type !== "message") continue;
		const message = entry.message;
		if (message?.role === "assistant") {
			for (const block of message.content ?? []) {
				if (block?.type === "toolCall") {
					callIds.add(block.id);
					if (block.name === "checkpoint") checkpointCallIds.add(block.id);
				}
			}
		} else if (message?.role === "toolResult") {
			results.push({ toolCallId: message.toolCallId, parentId: entry.parentId });
		}
	}

	const resultIds = new Set(results.map((r) => r.toolCallId));

	// (a) every toolResult has a matching assistant toolCall.
	expect(results.filter((r) => !callIds.has(r.toolCallId))).toEqual([]);

	// (b) every checkpoint call has a toolResult.
	expect(checkpointCallIds.size).toBeGreaterThan(0);
	expect([...checkpointCallIds].filter((id) => !resultIds.has(id))).toEqual([]);

	// (c) no toolResult is parented to a compaction entry.
	expect(results.filter((r) => r.parentId && compactionIds.has(r.parentId))).toEqual([]);
}

/** Compaction entries on the active branch (for trigger attribution). */
function compactionEntries(sm: SessionManager): any[] {
	return (sm.getBranch() as any[]).filter((e) => e.type === "compaction");
}

/**
 * Whether some single assistant message on the active branch issued tool calls
 * for both `a` and `b` (i.e. they ran as one parallel batch in one turn).
 */
function branchCallsInSameTurn(sm: SessionManager, a: string, b: string): boolean {
	return (sm.getBranch() as any[]).some((entry) => {
		if (entry.type !== "message" || entry.message?.role !== "assistant") return false;
		const names = (entry.message.content ?? [])
			.filter((x: any) => x?.type === "toolCall")
			.map((x: any) => x.name);
		return names.includes(a) && names.includes(b);
	});
}

/** Set up an isolated session with checkpoint extension and haystack files. */
async function setupSession(opts?: { keepRecentTokens?: number }) {
	const tmpCwd = await mkdtemp(join(tmpdir(), "pi-ckpt-e2e-"));
	const tmpAgentDir = await mkdtemp(join(tmpdir(), "pi-ckpt-agent-"));
	await createHaystackFiles(tmpCwd);

	const settingsManager = SettingsManager.inMemory({
		compaction: { keepRecentTokens: opts?.keepRecentTokens ?? 500 },
		retry: { enabled: false },
	});

	// ModelRuntime replaces the old AuthStorage + ModelRegistry pair.
	// It picks up auth.json (and models.json) from getAgentDir() by default.
	const modelRuntime = await ModelRuntime.create({
		authPath: join(getAgentDir(), "auth.json"),
		modelsPath: join(getAgentDir(), "models.json"),
	});
	const model = modelRuntime.getModel("openrouter", "deepseek/deepseek-v4-flash");
	if (!model) throw new Error("Model openrouter/deepseek/deepseek-v4-flash not found");

	const loader = new DefaultResourceLoader({
		cwd: tmpCwd,
		agentDir: tmpAgentDir,
		additionalExtensionPaths: [CHECKPOINT_EXTENSION],
		noSkills: true,
		noThemes: true,
		noPromptTemplates: true,
		noContextFiles: true,
		settingsManager,
		systemPromptOverride: () =>
			"You are a coding assistant. Be concise and follow instructions precisely.",
	});
	await loader.reload();

	const exts = loader.getExtensions();
	const toolNames = exts.extensions.flatMap((e) => [...e.tools.keys()]);
	if (!toolNames.includes("checkpoint")) {
		const errors = exts.errors.map((e) => e.error).join("; ");
		throw new Error(`checkpoint tool not registered. Errors: ${errors}`);
	}

	const sessionManager = SessionManager.inMemory(tmpCwd);
	const { session } = await createAgentSession({
		cwd: tmpCwd,
		model,
		thinkingLevel: "off",
		modelRuntime,
		resourceLoader: loader,
		tools: TOOLS,
		sessionManager,
		settingsManager,
	});

	return {
		session,
		sessionManager,
		tmpCwd,
		tmpAgentDir,
		async cleanup() {
			try { session.dispose(); } catch {}
			try { await rm(tmpCwd, { recursive: true, force: true }); } catch {}
			try { await rm(tmpAgentDir, { recursive: true, force: true }); } catch {}
		},
	};
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("checkpoint: basic flow", () => {
	let env: Awaited<ReturnType<typeof setupSession>>;

	beforeAll(async () => {
		env = await setupSession();
	});
	afterAll(async () => env.cleanup());

	it("reads haystack files and finds needles in read regions", async () => {
		const { session, sessionManager } = env;
		await session.prompt(
			"Read the first 30 lines of haystack_1.ts through haystack_5.ts (all 5 files). " +
				"Use 5 separate read calls. Report what you see.",
		);
		await waitForSettled(session);

		const assistantTexts = getAssistantTexts(sessionManager).join("\n");
		const found = NEEDLES.filter((n) => assistantTexts.includes(n));
		expect(found.length).toBeGreaterThan(0);
	}, 60_000);

	it("triggers checkpoint and compaction succeeds with file injection", async () => {
		const { session, sessionManager, tmpCwd } = env;
		// `continue: true` is stated explicitly: the default already makes it true,
		// but a model that volunteers `continue: false` silently suppresses the
		// follow-up this row (and the next) depends on — the flake that used to
		// surface as a 0.3ms failure in the next row.
		await session.prompt(
			"Call the checkpoint tool with continue: true. summary must be an object with all five fields: " +
				"{goal: 'Found secret codes in haystack files', " +
				"filesTouched: ['haystack_1.ts','haystack_2.ts','haystack_3.ts','haystack_4.ts','haystack_5.ts'], " +
				"decisions: ['none'], triedAndFailed: ['none'], constraints: 'none'}. " +
				"Include all 5 haystack files (haystack_1.ts through haystack_5.ts) in relevantPaths.",
		);
		await waitForSettled(session);

		// Compaction entry must exist
		expect(compactionCount(sessionManager)).toBeGreaterThanOrEqual(1);

		// Archive file should have been written (may be from auto- or manual compaction)
		const archives = await readdir(join(tmpCwd, ".pi", "checkpoints"));
		expect(archives.filter((f) => f.endsWith(".jsonl")).length).toBeGreaterThanOrEqual(1);

		// No session branch may contain an orphan `toolResult` or a `toolResult`
		// parented to a compaction entry after the checkpoint. The prompt instructs
		// the model to call checkpoint; this is the regression guard for the
		// orphan-toolResult defect (checkpoint compacting mid-execute()).
		expect(branchHasCheckpointToolCall(sessionManager)).toBe(true);
		assertBranchToolCallPairing(sessionManager);

		// Attribution: at least one compaction must be extension-provided
		// (`fromHook`, set when session_before_compact returns a compaction), i.e.
		// the checkpoint-triggered one — not an SDK auto-compaction that would
		// make the assertions above vacuous. Model summary wording is not asserted
		// (models paraphrase).
		expect(compactionEntries(sessionManager).some((e) => e.fromHook === true)).toBe(true);
	}, 120_000);

	it("agent answers from injected context without tools", async () => {
		const { session, sessionManager } = env;

		// The checkpoint above carried the read windows into the follow-up
		// message, so an answer from context is an answer from the injection.
		const injected = getUserTexts(sessionManager).filter((t) => t.includes("[haystack_1.ts]"));
		expect(injected).toHaveLength(1);
		for (const needle of NEEDLES) expect(injected[0]).toContain(needle);

		await session.prompt(
			"Without using read, bash, grep, or any tools — answer purely from the context above. " +
				"What are the 5 secret activation codes hidden in the haystack files? " +
				"List all 5.",
		);
		await waitForSettled(session);

		const assistantTexts = getAssistantTexts(sessionManager);
		const lastResponse = assistantTexts[assistantTexts.length - 1] ?? "";
		for (const needle of NEEDLES) {
			expect(lastResponse).toContain(needle);
		}
	}, 60_000);
});

// ---------------------------------------------------------------------------
// Sibling tool in the same turn (the incident's literal shape)
// ---------------------------------------------------------------------------

describe("checkpoint: sibling tool in the same turn", () => {
	let env: Awaited<ReturnType<typeof setupSession>>;

	beforeAll(async () => {
		env = await setupSession();
	});
	afterAll(async () => env.cleanup());

	it("compacts only after a batched sibling read result is persisted (no late orphan)", async () => {
		const { session, sessionManager } = env;
		await session.prompt(
			"Issue BOTH tool calls together in a single assistant response (parallel tool calls): " +
				"(1) read haystack_1.ts with offset=1 and limit=30; " +
				"(2) checkpoint with summary {goal: 'Checkpoint batched with a read', filesTouched: ['haystack_1.ts'], " +
				"decisions: ['none'], triedAndFailed: ['none'], constraints: 'none'} and relevantPaths [haystack_1.ts]. " +
				"Both tool calls must be in the same message.",
		);
		await waitForSettled(session);

		// This case is only meaningful if the two tools ran as one parallel batch
		// (checkpoint in flight while the sibling read was still executing). Fail
		// loud rather than silently skip when the model serialized them instead.
		expect(branchHasCheckpointToolCall(sessionManager)).toBe(true);
		expect(branchCallsInSameTurn(sessionManager, "checkpoint", "read")).toBe(true);
		assertBranchToolCallPairing(sessionManager);
	}, 150_000);
});

// ---------------------------------------------------------------------------
// Deterministic trigger-boundary tests (real checkpoint extension)
// ---------------------------------------------------------------------------

interface CompactSpyCall {
	customInstructions?: string;
	onComplete?: (result: unknown) => void | Promise<void>;
	onError?: (error: Error) => void;
}

interface HarnessCtxOptions {
	/** Entries returned by `ctx.sessionManager.getEntries()`. */
	entries?: any[];
	contextWindow?: number;
	/** What pi's `getContextUsage()` reports as live context tokens; null = pi has no estimate. */
	tokens?: number | null;
}

/** The summary object the tool schema requires (the wire shape, restated). */
interface SummaryInput {
	goal: string;
	filesTouched: string[];
	decisions: string[];
	triedAndFailed: string[];
	constraints: string;
}

/**
 * Drive the real checkpoint extension with a captured handler table and a
 * `ctx.compact` spy. Live-model e2e cannot deterministically produce the
 * "execute() must not compact", "two requests in one turn", "compaction
 * fails", or "this exact read window was tracked" states, so these exercise
 * the trigger state machine and the injection pipeline directly.
 */
function makeCheckpointHarness() {
	const tools = new Map<string, any>();
	const commands = new Map<string, any>();
	const handlers = new Map<string, Array<(event: any, ctx: any) => unknown>>();
	const sent: Array<{ text: string; options?: unknown }> = [];
	const compactCalls: CompactSpyCall[] = [];
	const notifications: Array<{ message: string; level: string }> = [];
	const api = {
		on: (event: string, handler: (event: any, ctx: any) => unknown) => {
			const list = handlers.get(event) ?? [];
			list.push(handler);
			handlers.set(event, list);
		},
		registerTool: (def: any) => {
			tools.set(def.name, def);
		},
		registerCommand: (name: string, def: any) => {
			commands.set(name, def);
		},
		sendUserMessage: (text: string, options?: unknown) => {
			sent.push({ text, options });
		},
	} as unknown as Parameters<typeof checkpointExtension>[0];
	checkpointExtension(api);

	const makeCtx = (cwd: string, opts: HarnessCtxOptions = {}) => ({
		cwd,
		model: { contextWindow: opts.contextWindow ?? 200_000 },
		getContextUsage: () => ({
			tokens: opts.tokens ?? null,
			contextWindow: opts.contextWindow ?? 200_000,
			percent: null,
		}),
		ui: {
			notify: (message: string, level: string) => notifications.push({ message, level }),
		},
		sessionManager: {
			getEntries: () => opts.entries ?? [],
			getSessionId: () => "test-session",
			getCwd: () => cwd,
		},
		compact: (options: CompactSpyCall) => compactCalls.push(options),
	});

	/** Fire every handler for `event`, returning their results. */
	const emit = async (event: string, ctx: any, payload: Record<string, unknown> = {}) => {
		const results: unknown[] = [];
		for (const handler of handlers.get(event) ?? []) {
			results.push(await handler({ type: event, ...payload }, ctx));
		}
		return results;
	};

	return { tools, commands, makeCtx, emit, sent, compactCalls, notifications };
}

// ---------------------------------------------------------------------------
// Deterministic checkpoint driver + fixtures
// ---------------------------------------------------------------------------

/** The schema's fields with the `"none"` slots pre-filled, each overridable. */
function summaryFields(over: Partial<SummaryInput> = {}): SummaryInput {
	return {
		goal: "deterministic summary",
		filesTouched: [],
		decisions: ["none"],
		triedAndFailed: ["none"],
		constraints: "none",
		...over,
	};
}

/** The meta record written beside an archive. */
async function readMeta(archivePath: string): Promise<any> {
	return JSON.parse(await readFile(archivePath.replace(/\.jsonl$/, ".meta.json"), "utf8"));
}

/** The archive path the checkpoint tool reports in its result text. */
function archivePathFrom(result: any): string {
	const text = String(result.content[0].text);
	const match = text.match(/`([^`]+\.jsonl)`/);
	if (!match) throw new Error(`no archive path in tool result:\n${text}`);
	return match[1];
}

/** Run one deterministic checkpoint to completion (execute → turn_end → onComplete). */
async function runCheckpoint(
	h: ReturnType<typeof makeCheckpointHarness>,
	ctx: any,
	args: Record<string, unknown>,
	onCompleteResult: Record<string, unknown> = {},
) {
	const result = await h.tools
		.get("checkpoint")
		.execute("call-1", { nextSteps: "NEXT-STEP", ...args }, undefined, undefined, ctx);
	await h.emit("turn_end", ctx);
	const compact = h.compactCalls[h.compactCalls.length - 1];
	if (!compact) throw new Error("turn_end did not request a compaction");
	await compact.onComplete?.(onCompleteResult);
	return { result, compact };
}

function sh(cwd: string, args: string[]): string {
	const res = spawnSync(args[0], args.slice(1), { cwd, encoding: "utf8", env: childEnv() });
	if (res.status !== 0) throw new Error(`${args.join(" ")} failed: ${res.stderr}`);
	return res.stdout.trim();
}

/** A tmp cwd that is a git repo with one commit and a clean tree. */
async function gitFixture(): Promise<string> {
	const cwd = await mkdtemp(join(tmpdir(), "ckpt-git-"));
	await writeFile(join(cwd, "tracked.txt"), "v1\n");
	sh(cwd, ["git", "init", "-b", "main"]);
	sh(cwd, ["git", "add", "tracked.txt"]);
	sh(cwd, [
		"git",
		"-c",
		"user.name=test",
		"-c",
		"user.email=test@example.com",
		"commit",
		"-m",
		"init",
	]);
	return cwd;
}

/** pi's default session dir for a cwd (`getDefaultSessionDir` isn't exported). */
function defaultSessionDir(cwd: string): string {
	const safePath = `--${resolve(cwd).replace(/^[/\\]/, "").replace(/[/\\:]/g, "-")}--`;
	return join(getAgentDir(), "sessions", safePath);
}

// ---------------------------------------------------------------------------
// Deterministic injection driver
// ---------------------------------------------------------------------------

/**
 * Run one full deterministic checkpoint: queue it, fire `turn_end`, fire
 * `session_before_compact` (where the injection is built), then complete the
 * compaction. Returns the follow-up message text, which is the injection's real
 * delivery path.
 */
async function checkpointAndInject(
	h: ReturnType<typeof makeCheckpointHarness>,
	ctx: any,
	opts: {
		relevantPaths: string[];
		summary?: SummaryInput;
		branchEntries?: any[];
		firstKeptEntryId?: string;
	},
): Promise<string> {
	const checkpoint = h.tools.get("checkpoint");
	await checkpoint.execute(
		"call-1",
		{
			summary: opts.summary ?? summaryFields(),
			nextSteps: "NEXT-STEP",
			relevantPaths: opts.relevantPaths.map((path) => ({ path })),
		},
		undefined,
		undefined,
		ctx,
	);
	await h.emit("turn_end", ctx);
	const compact = h.compactCalls[h.compactCalls.length - 1];
	if (!compact) throw new Error("turn_end did not request a compaction");
	await h.emit("session_before_compact", ctx, {
		customInstructions: compact.customInstructions,
		preparation: { firstKeptEntryId: opts.firstKeptEntryId ?? "entry-0", tokensBefore: 1000 },
		branchEntries: opts.branchEntries ?? [],
		reason: "manual",
		willRetry: false,
	});
	compact.onComplete?.({});
	return h.sent[h.sent.length - 1]?.text ?? "";
}

describe("checkpoint: compaction trigger boundary (deterministic, ctx.compact spy)", () => {
	it("execute() never compacts; turn_end compacts exactly once and continues", async () => {
		const h = makeCheckpointHarness();
		const cwd = await mkdtemp(join(tmpdir(), "ckpt-trigger-"));
		try {
			const ctx = h.makeCtx(cwd);
			await h.emit("session_start", ctx);
			const checkpoint = h.tools.get("checkpoint");

			const result = await checkpoint.execute(
				"call-1",
				{ summary: summaryFields({ goal: "summary-one" }), nextSteps: "next-one" },
				undefined,
				undefined,
				ctx,
			);
			expect(result.content[0].text).toContain("Checkpoint queued.");
			expect(h.compactCalls).toHaveLength(0); // must not compact inside execute()

			await h.emit("turn_end", ctx);
			expect(h.compactCalls).toHaveLength(1);
			expect(h.compactCalls[0].customInstructions).toContain("[CHECKPOINT]");
			expect(h.compactCalls[0].customInstructions).toContain("summary-one");

			h.compactCalls[0].onComplete?.({});
			expect(h.sent).toHaveLength(1);
			expect(h.sent[0].text).toContain("next-one");
			expect(h.sent[0].options).toEqual({ deliverAs: "followUp" });

			// No stuck request: a further turn_end must not compact again.
			await h.emit("turn_end", ctx);
			expect(h.compactCalls).toHaveLength(1);
		} finally {
			await rm(cwd, { recursive: true, force: true });
		}
	}, 30_000);

	it("two checkpoint calls before turn_end → one compaction, last request wins", async () => {
		const h = makeCheckpointHarness();
		const cwd = await mkdtemp(join(tmpdir(), "ckpt-trigger-"));
		try {
			const ctx = h.makeCtx(cwd);
			await h.emit("session_start", ctx);
			const checkpoint = h.tools.get("checkpoint");

			await checkpoint.execute("call-1", { summary: summaryFields({ goal: "first" }) }, undefined, undefined, ctx);
			await checkpoint.execute("call-2", { summary: summaryFields({ goal: "second" }) }, undefined, undefined, ctx);
			expect(h.compactCalls).toHaveLength(0);

			await h.emit("turn_end", ctx);
			expect(h.compactCalls).toHaveLength(1); // exactly one
			expect(h.compactCalls[0].customInstructions).toContain("second");
			expect(h.compactCalls[0].customInstructions).not.toContain("first");
		} finally {
			await rm(cwd, { recursive: true, force: true });
		}
	}, 30_000);

	it("compaction failure clears pending state, is non-fatal, and allows a retry", async () => {
		const h = makeCheckpointHarness();
		const cwd = await mkdtemp(join(tmpdir(), "ckpt-trigger-"));
		try {
			const ctx = h.makeCtx(cwd);
			await h.emit("session_start", ctx);
			const checkpoint = h.tools.get("checkpoint");

			await checkpoint.execute("call-1", { summary: summaryFields({ goal: "failing" }) }, undefined, undefined, ctx);
			await h.emit("turn_end", ctx);
			expect(h.compactCalls).toHaveLength(1);

			h.compactCalls[0].onError?.(new Error("Already compacted"));
			expect(
				h.notifications.some((n) => n.message.includes("Checkpoint failed")),
			).toBe(true);

			// No stuck pending request: a fresh checkpoint fires again.
			await checkpoint.execute("call-2", { summary: summaryFields({ goal: "recovered" }) }, undefined, undefined, ctx);
			await h.emit("turn_end", ctx);
			expect(h.compactCalls).toHaveLength(2);
			expect(h.compactCalls[1].customInstructions).toContain("recovered");
		} finally {
			await rm(cwd, { recursive: true, force: true });
		}
	}, 30_000);
});

// ---------------------------------------------------------------------------
// Summary schema, observability, and git binding (S-rows)
// ---------------------------------------------------------------------------

describe("checkpoint: summary schema, observability, git binding", () => {
	it("S1: one renderer feeds customInstructions and the meta, section for section", async () => {
		const h = makeCheckpointHarness();
		const cwd = await mkdtemp(join(tmpdir(), "ckpt-meta-"));
		try {
			const ctx = h.makeCtx(cwd);
			await h.emit("session_start", ctx);
			const fields: SummaryInput = {
				goal: "Wire the checkpoint summary schema",
				filesTouched: ["extensions/checkpoint.ts", "tests/e2e-checkpoint.test.ts"],
				decisions: ["kept nextSteps as the kickoff prompt"],
				triedAndFailed: [
					"a bare string summary — the schema rejected it: triedAndFailed was absent",
				],
				constraints: "compaction-model.ts is off limits",
			};

			const { result, compact } = await runCheckpoint(h, ctx, {
				summary: fields,
				nextSteps: "NEXT-STEP",
			});

			const instructions = String(compact.customInstructions);
			expect(instructions.startsWith("[CHECKPOINT]\n")).toBe(true);
			for (const label of [
				"Goal:",
				"Files touched:",
				"Decisions:",
				"Tried and failed (and why):",
				"Constraints:",
				"Next: NEXT-STEP",
			]) {
				expect(instructions).toContain(label);
			}
			expect(instructions).toContain(fields.goal);
			expect(instructions).toContain("extensions/checkpoint.ts, tests/e2e-checkpoint.test.ts");
			expect(instructions).toContain("  - a bare string summary");

			const meta = await readMeta(archivePathFrom(result));
			expect(meta.summaryFields).toEqual(fields);
			// The compaction window and the meta read the *same* rendered text.
			expect(meta.summary).toBe(instructions.replace("[CHECKPOINT]\n", ""));
			// Meta keys are additive: the pre-schema record survives intact.
			for (const key of ["timestamp", "sessionId", "archivePath", "summary", "entryCount"]) {
				expect(meta).toHaveProperty(key);
			}
			expect(meta.sessionId).toBe("test-session");
			expect(meta.archivePath).toBe(archivePathFrom(result));
		} finally {
			await rm(cwd, { recursive: true, force: true });
		}
	}, 30_000);

	it("S2: the literal none form is accepted and rendered as-is", async () => {
		const h = makeCheckpointHarness();
		const cwd = await mkdtemp(join(tmpdir(), "ckpt-meta-"));
		try {
			const ctx = h.makeCtx(cwd);
			await h.emit("session_start", ctx);
			const fields = summaryFields({ goal: "nothing to report" });

			const { result, compact } = await runCheckpoint(h, ctx, { summary: fields });

			const instructions = String(compact.customInstructions);
			expect(instructions).toContain("Files touched: none");
			expect(instructions).toContain("Decisions: none");
			expect(instructions).toContain("Tried and failed (and why): none");
			expect(instructions).toContain("Constraints: none");

			const meta = await readMeta(archivePathFrom(result));
			expect(meta.summaryFields).toEqual(fields);
		} finally {
			await rm(cwd, { recursive: true, force: true });
		}
	}, 30_000);

	it("S3: the typebox schema, not a runtime check, requires every field", async () => {
		const h = makeCheckpointHarness();
		// Exactly what pi's tool-call validator compiles before calling execute()
		// (`validateToolArguments` in pi-ai's dist/utils/validation.js).
		const schema = h.tools.get("checkpoint").parameters;

		expect(Value.Check(schema, { summary: summaryFields({ goal: "g" }) })).toBe(true);

		const { triedAndFailed: _omitted, ...withoutTried } = summaryFields();
		const invalid = { summary: withoutTried };
		expect(Value.Check(schema, invalid)).toBe(false);
		const errors = Value.Errors(schema, invalid).map((e) => `${e.instancePath} ${e.message}`);
		expect(errors.some((e) => e.includes("triedAndFailed"))).toBe(true);

		// All five slots are declared required, on both tools.
		const required = ["goal", "filesTouched", "decisions", "triedAndFailed", "constraints"];
		for (const name of ["checkpoint", "checkpoint_fork"]) {
			const summarySchema = h.tools.get(name).parameters.properties.summary;
			expect(summarySchema.required).toEqual(required);
		}
	}, 30_000);

	it("S4: nextSteps omitted still kicks off with 'Continue work'", async () => {
		const h = makeCheckpointHarness();
		const cwd = await mkdtemp(join(tmpdir(), "ckpt-meta-"));
		try {
			const ctx = h.makeCtx(cwd);
			await h.emit("session_start", ctx);

			const { compact } = await runCheckpoint(h, ctx, {
				summary: summaryFields(),
				nextSteps: undefined,
			});

			expect(String(compact.customInstructions)).toContain("Next: Continue work");
			expect(h.sent.at(-1)?.text.split("\n")[0]).toBe("Continue work");
		} finally {
			await rm(cwd, { recursive: true, force: true });
		}
	}, 30_000);

	it("S5: continue keeps the follow-up shape — injection, kickoff, archive line", async () => {
		const { h, cwd, ctx } = await injectionFixture();
		try {
			await emitRead(h, ctx, "haystack_1.ts", { offset: 1, limit: 50 });

			const text = await checkpointAndInject(h, ctx, { relevantPaths: ["haystack_1.ts"] });

			expect(text.split("\n")[0]).toContain("Disk snapshot taken at checkpoint time");
			expect(text).toContain("NEXT-STEP");
			expect(text.trimEnd().split("\n").at(-1)).toMatch(/^Archive: .*\.jsonl$/);
		} finally {
			await rm(cwd, { recursive: true, force: true });
		}
	}, 30_000);

	it("S6a: pi exposes a post-compaction count → notify and meta carry the delta", async () => {
		const h = makeCheckpointHarness();
		const cwd = await mkdtemp(join(tmpdir(), "ckpt-meta-"));
		try {
			// Deliberately different from pi's own `tokensBefore` (120,000): the
			// compaction result is the authoritative count, so it must win.
			const ctx = h.makeCtx(cwd, { tokens: 100_000 });
			await h.emit("session_start", ctx);

			const { result } = await runCheckpoint(h, ctx, { summary: summaryFields() }, {
				tokensBefore: 120_000,
				estimatedTokensAfter: 3_400,
			});

			const notify = h.notifications.find((n) => n.message.includes("Checkpoint complete"));
			expect(notify).toBeDefined();
			expect(notify!.message).toContain(
				`Tokens: ${(120_000).toLocaleString()} → ${(3_400).toLocaleString()}`,
			);
			expect(notify!.message).toContain(`(${(3_400 - 120_000).toLocaleString()})`);

			const meta = await readMeta(archivePathFrom(result));
			expect(meta.tokens).toEqual({ before: 120_000, after: 3_400 });
		} finally {
			await rm(cwd, { recursive: true, force: true });
		}
	}, 30_000);

	it("S6b: no post count from pi → notify shows before only, meta.tokens.after is null", async () => {
		const h = makeCheckpointHarness();
		const cwd = await mkdtemp(join(tmpdir(), "ckpt-meta-"));
		try {
			const ctx = h.makeCtx(cwd, { tokens: 88_000 });
			await h.emit("session_start", ctx);

			const { result } = await runCheckpoint(h, ctx, { summary: summaryFields() }, {});

			const notify = h.notifications.find((n) => n.message.includes("Checkpoint complete"));
			expect(notify!.message).toContain(`Tokens: ${(88_000).toLocaleString()}`);
			expect(notify!.message).not.toContain("→");

			const meta = await readMeta(archivePathFrom(result));
			expect(meta.tokens).toEqual({ before: 88_000, after: null });
		} finally {
			await rm(cwd, { recursive: true, force: true });
		}
	}, 30_000);

	it("S6c: pi can estimate nothing → no token text in the notify, both meta counts null", async () => {
		const h = makeCheckpointHarness();
		const cwd = await mkdtemp(join(tmpdir(), "ckpt-meta-"));
		try {
			const ctx = h.makeCtx(cwd, { tokens: null });
			await h.emit("session_start", ctx);

			const { result } = await runCheckpoint(h, ctx, { summary: summaryFields() }, {});

			const notify = h.notifications.find((n) => n.message.includes("Checkpoint complete"));
			expect(notify).toBeDefined();
			expect(notify!.message).not.toContain("Tokens:");

			const meta = await readMeta(archivePathFrom(result));
			expect(meta.tokens).toEqual({ before: null, after: null });
		} finally {
			await rm(cwd, { recursive: true, force: true });
		}
	}, 30_000);

	it("S7: /checkpoints reads the richer meta — goal headline plus the git ref", async () => {
		const h = makeCheckpointHarness();
		const cwd = await gitFixture();
		try {
			const ctx = h.makeCtx(cwd, { tokens: 12_000 });
			await h.emit("session_start", ctx);
			const { result } = await runCheckpoint(h, ctx, {
				summary: summaryFields({ goal: "list me by my goal line" }),
			});
			const meta = await readMeta(archivePathFrom(result));

			await h.commands.get("checkpoints").handler("", ctx);

			const listing = h.notifications.filter((n) => n.message.includes("Checkpoints in")).at(-1);
			expect(listing).toBeDefined();
			expect(listing!.message).toContain("— Goal: list me by my goal line");
			expect(listing!.message).toContain(
				`[${meta.git.branch}@${String(meta.git.head).slice(0, 7)}]`,
			);
		} finally {
			await rm(cwd, { recursive: true, force: true });
		}
	}, 30_000);

	it("S8: binds the archive to the git ref, captured before the archive itself is written", async () => {
		const h = makeCheckpointHarness();
		const cwd = await gitFixture();
		try {
			const head = sh(cwd, ["git", "rev-parse", "HEAD"]);
			const branch = sh(cwd, ["git", "rev-parse", "--abbrev-ref", "HEAD"]);
			const ctx = h.makeCtx(cwd);
			await h.emit("session_start", ctx);

			const first = await runCheckpoint(h, ctx, { summary: summaryFields() });
			const firstMeta = await readMeta(archivePathFrom(first.result));
			expect(firstMeta.git).toEqual({ head, branch, dirty: false });

			// The archive's own `.pi/checkpoints` files are untracked, so a second
			// checkpoint taken after them reports the tree as dirty — proof the
			// first capture happened before the write, not after it.
			const second = await runCheckpoint(h, ctx, { summary: summaryFields() });
			const secondMeta = await readMeta(archivePathFrom(second.result));
			expect(secondMeta.git).toEqual({ head, branch, dirty: true });
		} finally {
			await rm(cwd, { recursive: true, force: true });
		}
	}, 30_000);

	it("S9: non-git cwd → git is null, archive still written, checkpoint proceeds", async () => {
		const h = makeCheckpointHarness();
		const cwd = await mkdtemp(join(tmpdir(), "ckpt-nogit-"));
		try {
			const ctx = h.makeCtx(cwd);
			await h.emit("session_start", ctx);

			const { result } = await runCheckpoint(h, ctx, {
				summary: summaryFields({ goal: "no repo here" }),
			});

			const meta = await readMeta(archivePathFrom(result));
			expect(meta.git).toBeNull();
			expect(meta.summary.startsWith("Goal: no repo here")).toBe(true);
			expect(h.notifications.some((n) => n.message.includes("Checkpoint complete"))).toBe(true);
			expect(h.sent.at(-1)?.text.split("\n")[0]).toBe("NEXT-STEP");
		} finally {
			await rm(cwd, { recursive: true, force: true });
		}
	}, 30_000);

	it("S11: fork binds the source ref, records newCwd, seeds the rendered summary", async () => {
		const h = makeCheckpointHarness();
		const sourceCwd = await gitFixture();
		const targetCwd = await mkdtemp(join(tmpdir(), "ckpt-fork-target-"));
		const notifications: Array<{ message: string; level: string }> = [];
		const switched: { path?: string; followUp?: string[] } = {};
		try {
			const head = sh(sourceCwd, ["git", "rev-parse", "HEAD"]);
			const branch = sh(sourceCwd, ["git", "rev-parse", "--abbrev-ref", "HEAD"]);
			const ctx = h.makeCtx(sourceCwd, { tokens: 4_321 });
			await h.emit("session_start", ctx);
			const fields = summaryFields({ goal: "Fork into the target dir", filesTouched: ["tracked.txt"] });

			const result = await h.tools
				.get("checkpoint_fork")
				.execute(
					"call-fork",
					{ newCwd: targetCwd, summary: fields, nextSteps: "NEXT-STEP" },
					undefined,
					undefined,
					ctx,
				);
			expect(String(result.content[0].text)).toContain("Fork prepared");

			// /go commits the staged fork (takePendingGo is what /go itself calls,
			// so the global staging slot is left clean).
			const action = takePendingGo();
			expect(action).not.toBeNull();
			const cmdCtx = {
				...ctx,
				ui: { notify: (message: string, level: string) => notifications.push({ message, level }) },
				getContextUsage: () => ({ tokens: 4_321, contextWindow: 200_000, percent: 2 }),
				switchSession: async (path: string, opts: any) => {
					switched.path = path;
					await opts?.withSession?.({
						sendUserMessage: async (text: string) => {
							switched.followUp = [text];
						},
					});
				},
			};
			await action!.run(cmdCtx as any);

			const archives = (await readdir(join(sourceCwd, ".pi", "checkpoints"))).filter((f) =>
				f.endsWith(".meta.json"),
			);
			expect(archives).toHaveLength(1);
			const meta = JSON.parse(
				await readFile(join(sourceCwd, ".pi", "checkpoints", archives[0]), "utf8"),
			);
			expect(meta.git).toEqual({ head, branch, dirty: false });
			expect(meta.newCwd).toBe(targetCwd);
			expect(meta.summaryFields).toEqual(fields);
			expect(meta.summary.startsWith("Goal: Fork into the target dir")).toBe(true);
			expect(meta.sessionId).toBe("test-session");

			// The fork's seeded message is the rendered summary — the same string.
			expect(switched.path).toBeDefined();
			const entries = (await readFile(switched.path!, "utf8"))
				.trim()
				.split("\n")
				.map((line) => JSON.parse(line));
			const seeded = entries.find(
				(e: any) => e.type === "message" && e.message?.role === "assistant",
			);
			expect(seeded.message.content[0].text).toBe(meta.summary);
			expect(switched.followUp?.[0]).toBe("NEXT-STEP");
		} finally {
			await rm(sourceCwd, { recursive: true, force: true });
			await rm(targetCwd, { recursive: true, force: true });
			await rm(defaultSessionDir(targetCwd), { recursive: true, force: true });
		}
	}, 60_000);

	it("S12: marker dispatch is untouched — the compaction takes the rendered text", async () => {
		const h = makeCheckpointHarness();
		const cwd = await mkdtemp(join(tmpdir(), "ckpt-meta-"));
		try {
			const ctx = h.makeCtx(cwd);
			await h.emit("session_start", ctx);
			const { compact } = await runCheckpoint(h, ctx, { summary: summaryFields() });

			const results = await h.emit("session_before_compact", ctx, {
				customInstructions: compact.customInstructions,
				preparation: { firstKeptEntryId: "entry-0", tokensBefore: 1000 },
				branchEntries: [],
				reason: "manual",
				willRetry: false,
			});
			const compaction = (results[0] as any).compaction;
			expect(compaction.summary).toBe(
				String(compact.customInstructions).replace("[CHECKPOINT]", "").trim(),
			);
			expect(compaction.summary).toContain("Tried and failed (and why):");
			expect(compaction.firstKeptEntryId).toBe("entry-0");
			expect(compaction.tokensBefore).toBe(1000);
		} finally {
			await rm(cwd, { recursive: true, force: true });
		}
	}, 30_000);
});

// ---------------------------------------------------------------------------
// File injection (deterministic, captured handler table + real files)
// ---------------------------------------------------------------------------

/** A harness with haystack files on disk and the session's read tracker cleared. */
async function injectionFixture() {
	const h = makeCheckpointHarness();
	const cwd = await mkdtemp(join(tmpdir(), "ckpt-injection-"));
	await createHaystackFiles(cwd);
	const ctx = h.makeCtx(cwd);
	await h.emit("session_start", ctx);
	return { h, cwd, ctx };
}

/** Fire the `tool_result` pi fires for a finished read call (finalized args on `input`). */
async function emitRead(
	h: ReturnType<typeof makeCheckpointHarness>,
	ctx: any,
	path: string,
	args: { offset?: number; limit?: number } = {},
) {
	await h.emit("tool_result", ctx, {
		toolCallId: `call-${path}-${args.offset ?? 1}-${args.limit ?? "end"}`,
		toolName: "read",
		input: { path, ...args },
		content: [{ type: "text", text: "file contents" }],
		isError: false,
	});
}

/** An assistant entry whose `read` tool call survives the compaction boundary. */
function keptReadEntry(id: string, path: string) {
	return {
		id,
		type: "message",
		parentId: null,
		message: {
			role: "assistant",
			content: [{ type: "toolCall", id: `call-${id}`, name: "read", arguments: { path, offset: 1, limit: 50 } }],
		},
	};
}

const PRESERVED_NOTE = /already in preserved context — skipped/;

describe("checkpoint: file injection (deterministic, captured handlers)", () => {
	it("M1: injects a file whose read was tracked from tool_result.input", async () => {
		const { h, cwd, ctx } = await injectionFixture();
		try {
			await emitRead(h, ctx, "haystack_1.ts", { offset: 1, limit: 50 });

			const text = await checkpointAndInject(h, ctx, { relevantPaths: ["haystack_1.ts"] });

			expect(text).toContain("[haystack_1.ts]");
			expect(text).toContain(NEEDLES[0]);
			expect(text).toContain("NEXT-STEP");
		} finally {
			await rm(cwd, { recursive: true, force: true });
		}
	}, 30_000);

	it("M2: skips a file whose read survives in the preserved tail", async () => {
		const { h, cwd, ctx } = await injectionFixture();
		try {
			await emitRead(h, ctx, "haystack_1.ts", { offset: 1, limit: 50 });

			const text = await checkpointAndInject(h, ctx, {
				relevantPaths: ["haystack_1.ts"],
				branchEntries: [keptReadEntry("kept", "haystack_1.ts")],
				firstKeptEntryId: "kept",
			});

			expect(text).not.toContain("[haystack_1.ts]");
			expect(text).not.toContain(NEEDLES[0]);
			expect(text).toMatch(PRESERVED_NOTE);
			expect(text).toContain("haystack_1.ts");
		} finally {
			await rm(cwd, { recursive: true, force: true });
		}
	}, 30_000);

	it("M3: does not inject a relevantPaths file that was never read", async () => {
		const { h, cwd, ctx } = await injectionFixture();
		try {
			await emitRead(h, ctx, "haystack_1.ts", { offset: 1, limit: 50 });

			const text = await checkpointAndInject(h, ctx, {
				relevantPaths: ["haystack_1.ts", "haystack_2.ts"],
			});

			expect(text).toContain("[haystack_1.ts]");
			expect(text).not.toContain("[haystack_2.ts]");
			expect(text).not.toContain(NEEDLES[1]);
		} finally {
			await rm(cwd, { recursive: true, force: true });
		}
	}, 30_000);

	it("M4: injects only the read windows, annotated, with content outside them absent", async () => {
		const { h, cwd, ctx } = await injectionFixture();
		try {
			await emitRead(h, ctx, "haystack_1.ts", { offset: 1, limit: 5 });
			await emitRead(h, ctx, "haystack_1.ts", { offset: 20, limit: 3 });

			const text = await checkpointAndInject(h, ctx, { relevantPaths: ["haystack_1.ts"] });

			expect(text).toContain("placeholder_001");
			expect(text).toContain("placeholder_005");
			expect(text).toContain("placeholder_020");
			expect(text).toContain("placeholder_022");
			// Lines 6-19 were never read, and the needle sits at line 10.
			expect(text).not.toContain("placeholder_006");
			expect(text).not.toContain("placeholder_019");
			expect(text).not.toContain(NEEDLES[0]);
			// Continuation annotations, in the injection's own format.
			expect(text).toContain("[L1-5 of 51 lines. offset=6 for more.]");
			expect(text).toContain("[L20-22 of 51 lines. offset=23 for more.]");
		} finally {
			await rm(cwd, { recursive: true, force: true });
		}
	}, 30_000);

	it("M5: names budget-omitted files in the footnote and still injects what fits", async () => {
		const h = makeCheckpointHarness();
		const cwd = await mkdtemp(join(tmpdir(), "ckpt-injection-"));
		try {
			await createHaystackFiles(cwd);
			// Whole-file blocks are ~616 tokens; a 5000-token window gives a
			// ~750-token budget, so exactly one of the two fits.
			const ctx = h.makeCtx(cwd, { contextWindow: 5000 });
			await h.emit("session_start", ctx);
			await emitRead(h, ctx, "haystack_1.ts", { offset: 1, limit: 50 });
			await emitRead(h, ctx, "haystack_2.ts", { offset: 1, limit: 50 });

			const text = await checkpointAndInject(h, ctx, {
				relevantPaths: ["haystack_1.ts", "haystack_2.ts"],
			});

			expect(text).toContain("[haystack_1.ts]");
			expect(text).toContain(NEEDLES[0]);
			expect(text).not.toContain("[haystack_2.ts]");
			expect(text).toMatch(/Omitted: haystack_2\.ts/);
			expect(text).toContain("15% of context window");
		} finally {
			await rm(cwd, { recursive: true, force: true });
		}
	}, 30_000);

	it("M6: records nothing from tool_execution_end, which carries no args", async () => {
		const { h, cwd, ctx } = await injectionFixture();
		try {
			// pi's actual shape: no args at all.
			await h.emit("tool_execution_end", ctx, {
				toolCallId: "t1",
				toolName: "read",
				result: {},
				isError: false,
			});
			// The shape the dead tracking path assumed — still not a source.
			await h.emit("tool_execution_end", ctx, {
				toolCallId: "t2",
				toolName: "read",
				isError: false,
				args: { path: "haystack_1.ts", offset: 1, limit: 50 },
			});

			const text = await checkpointAndInject(h, ctx, { relevantPaths: ["haystack_1.ts"] });

			expect(text).not.toContain("[haystack_1.ts]");
			expect(text).not.toContain(NEEDLES[0]);
		} finally {
			await rm(cwd, { recursive: true, force: true });
		}
	}, 30_000);

	it("M7: scopes the preserved-tail scan to branchEntries, so off-branch reads do not skip", async () => {
		const { h, cwd, ctx } = await injectionFixture();
		try {
			await emitRead(h, ctx, "haystack_1.ts", { offset: 1, limit: 50 });

			// The session history holds a read past the boundary on a branch that
			// was abandoned; the compacting branch does not contain it.
			const ctxWithHistory = h.makeCtx(cwd, {
				entries: [
					{ id: "boundary", type: "message", message: { role: "user", content: [] } },
					keptReadEntry("off-branch", "haystack_1.ts"),
				],
			});

			const text = await checkpointAndInject(h, ctxWithHistory, {
				relevantPaths: ["haystack_1.ts"],
				branchEntries: [{ id: "boundary", type: "message", message: { role: "user", content: [] } }],
				firstKeptEntryId: "boundary",
			});

			expect(text).toContain("[haystack_1.ts]");
			expect(text).toContain(NEEDLES[0]);
			expect(text).not.toMatch(PRESERVED_NOTE);
		} finally {
			await rm(cwd, { recursive: true, force: true });
		}
	}, 30_000);

	it("M11: drops a window whose file changed since the read, and names the file", async () => {
		const { h, cwd, ctx } = await injectionFixture();
		try {
			await emitRead(h, ctx, "haystack_1.ts", { offset: 1, limit: 50 });
			await emitRead(h, ctx, "haystack_2.ts", { offset: 1, limit: 50 });

			// Edited after the read: mtime and size both change.
			const original = await readFile(join(cwd, "haystack_1.ts"), "utf-8");
			await writeFile(join(cwd, "haystack_1.ts"), `// edited after read\n${original}`);

			const text = await checkpointAndInject(h, ctx, {
				relevantPaths: ["haystack_1.ts", "haystack_2.ts"],
			});

			expect(text).not.toContain("[haystack_1.ts]");
			expect(text).not.toContain(NEEDLES[0]);
			expect(text).toMatch(/changed since read — re-read if needed: haystack_1\.ts/);
			// The untouched file is still injected normally in the same run.
			expect(text).toContain("[haystack_2.ts]");
			expect(text).toContain(NEEDLES[1]);
		} finally {
			await rm(cwd, { recursive: true, force: true });
		}
	}, 30_000);

	it("M12: never serves a shifted window after line insertions (eval S2)", async () => {
		const { h, cwd, ctx } = await injectionFixture();
		try {
			const original = await readFile(join(cwd, "haystack_1.ts"), "utf-8");
			// Read lines 1-15; the needle at line 10 is inside the window.
			await emitRead(h, ctx, "haystack_1.ts", { offset: 1, limit: 15 });

			// 20 lines inserted before it: the needle moves to line 30, so the
			// recorded [1,15] window no longer covers it.
			const inserted = Array.from({ length: 20 }, (_, i) => `// inserted ${i + 1}`).join("\n");
			await writeFile(join(cwd, "haystack_1.ts"), `${inserted}\n${original}`);

			const text = await checkpointAndInject(h, ctx, { relevantPaths: ["haystack_1.ts"] });

			expect(text).not.toContain(NEEDLES[0]);
			expect(text).not.toContain("inserted 1");
			expect(text).not.toContain("placeholder");
			expect(text).not.toContain("[L1-15");
			expect(text).toMatch(/changed since read — re-read if needed: haystack_1\.ts/);
		} finally {
			await rm(cwd, { recursive: true, force: true });
		}
	}, 30_000);

	it("M13: starts tracking empty after a session switch", async () => {
		const { h, cwd, ctx } = await injectionFixture();
		const newCwd = await mkdtemp(join(tmpdir(), "ckpt-injection-new-"));
		try {
			await createHaystackFiles(newCwd);
			await emitRead(h, ctx, "haystack_1.ts", { offset: 1, limit: 50 });

			// What a fork's switch does: the new session starts, in the new cwd.
			const newCtx = h.makeCtx(newCwd);
			await h.emit("session_start", newCtx);

			const text = await checkpointAndInject(h, newCtx, { relevantPaths: ["haystack_1.ts"] });

			expect(text).not.toContain("[haystack_1.ts]");
			expect(text).not.toContain(NEEDLES[0]);
		} finally {
			await rm(cwd, { recursive: true, force: true });
			await rm(newCwd, { recursive: true, force: true });
		}
	}, 30_000);

	it("M14: labels the injected block as a checkpoint-time disk snapshot", async () => {
		const { h, cwd, ctx } = await injectionFixture();
		try {
			await emitRead(h, ctx, "haystack_1.ts", { offset: 1, limit: 50 });

			const text = await checkpointAndInject(h, ctx, { relevantPaths: ["haystack_1.ts"] });

			const header = text.split("\n")[0];
			expect(header).toContain("Disk snapshot taken at checkpoint time");
			expect(header).toContain("earlier read");
			expect(header).toContain("line numbers may have shifted");
		} finally {
			await rm(cwd, { recursive: true, force: true });
		}
	}, 30_000);
});

// ---------------------------------------------------------------------------
// Injected context is what answers (kept-tail discipline)
// ---------------------------------------------------------------------------

const FILLER = Array.from(
	{ length: 120 },
	(_, i) =>
		`filler-sentence-${i + 1}: the quick brown fox jumps over the lazy dog while the committee reviews routine paperwork.`,
).join(" ");

const NEEDLE_QUESTION =
	"What are the five SECRET activation codes in the haystack files? " +
	"Answer with all five codes if you know them; if you do not know a code, write UNKNOWN for that one. " +
	"Reply with just the five codes. Answer from your current context only — do not use any tools.";

describe("checkpoint: the injection is what answers", () => {
	let env: Awaited<ReturnType<typeof setupSession>>;

	beforeAll(async () => {
		env = await setupSession();
	});
	afterAll(async () => env.cleanup());

	it("M10: answers all 5 needles with no post-compaction read, needle never in the kept tail", async () => {
		const { session, sessionManager } = env;

		// Read a window containing each needle, without putting it in any text.
		await session.prompt(
			"Use the read tool 5 times in this turn: read haystack_1.ts, haystack_2.ts, haystack_3.ts, " +
				"haystack_4.ts, haystack_5.ts with offset=1 and limit=15 each. " +
				"Do not quote, list, or mention any line containing SECRET. Reply DONE.",
		);
		await waitForSettled(session);
		// Pre-condition: nothing the model has said (and so nothing a summary
		// could pick up) contains a needle yet.
		expect(NEEDLES.filter((n) => getAssistantTexts(sessionManager).join("\n").includes(n))).toEqual([]);

		// Push the read results out of the retained tail.
		await session.prompt(`${FILLER}\n\nReply with exactly: OK`);
		await waitForSettled(session);

		// Checkpoint, carrying the question as the kickoff for the next turn. The
		// follow-up is the only channel the needles can arrive through.
		await session.prompt(
			"Call the checkpoint tool now with these exact arguments: " +
				"summary: {goal: 'Read five haystack files; no findings recorded.', " +
				"filesTouched: ['haystack_1.ts','haystack_2.ts','haystack_3.ts','haystack_4.ts','haystack_5.ts'], " +
				"decisions: ['none'], triedAndFailed: ['none'], constraints: 'none'}; continue: true; " +
				"relevantPaths: [{path:'haystack_1.ts'},{path:'haystack_2.ts'},{path:'haystack_3.ts'}," +
				"{path:'haystack_4.ts'},{path:'haystack_5.ts'}]; " +
				`nextSteps: ${JSON.stringify(NEEDLE_QUESTION)}`,
		);
		await waitForSettled(session);

		expect(compactionCount(sessionManager)).toBeGreaterThanOrEqual(1);

		// (a) the injection itself delivered the needles.
		const injected = getUserTexts(sessionManager).filter((t) => t.includes("[haystack_1.ts]"));
		expect(injected).toHaveLength(1);
		for (const needle of NEEDLES) expect(injected[0]).toContain(needle);

		// (b) nothing else after the compaction could have supplied them: no read
		// result, and no needle in the summary the checkpoint handed the model.
		const branch = sessionManager.getBranch() as any[];
		const compactionIdx = branch.findIndex((e) => e.type === "compaction");
		const after = branch.slice(compactionIdx + 1);
		const postCompactionReads = after.filter(
			(e) => e.type === "message" && e.message?.role === "toolResult" && e.message?.toolName === "read",
		);
		expect(postCompactionReads).toEqual([]);
		for (const needle of NEEDLES) expect(branch[compactionIdx].summary).not.toContain(needle);

		// (c) the answer carries all five.
		const answers = after
			.filter((e) => e.type === "message" && e.message?.role === "assistant")
			.map((e) => getMessageText(e));
		const answer = answers[answers.length - 1] ?? "";
		for (const needle of NEEDLES) expect(answer).toContain(needle);
	}, 300_000);
});
