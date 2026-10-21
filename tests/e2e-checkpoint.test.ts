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
import { mkdtemp, writeFile, readFile, rm, readdir } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
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
		await session.prompt(
			"Call the checkpoint tool. summary: 'Found secret codes in haystack files'. " +
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
				"(2) checkpoint with summary 'Checkpoint batched with a read' and relevantPaths [haystack_1.ts]. " +
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
	onComplete?: (result: unknown) => void;
	onError?: (error: Error) => void;
}

interface HarnessCtxOptions {
	/** Entries returned by `ctx.sessionManager.getEntries()`. */
	entries?: any[];
	contextWindow?: number;
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
		registerCommand: () => {},
		sendUserMessage: (text: string, options?: unknown) => {
			sent.push({ text, options });
		},
	} as unknown as Parameters<typeof checkpointExtension>[0];
	checkpointExtension(api);

	const makeCtx = (cwd: string, opts: HarnessCtxOptions = {}) => ({
		cwd,
		model: { contextWindow: opts.contextWindow ?? 200_000 },
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

	return { tools, makeCtx, emit, sent, compactCalls, notifications };
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
		summary?: string;
		branchEntries?: any[];
		firstKeptEntryId?: string;
	},
): Promise<string> {
	const checkpoint = h.tools.get("checkpoint");
	await checkpoint.execute(
		"call-1",
		{
			summary: opts.summary ?? "deterministic summary",
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
				{ summary: "summary-one", nextSteps: "next-one" },
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

			await checkpoint.execute("call-1", { summary: "first" }, undefined, undefined, ctx);
			await checkpoint.execute("call-2", { summary: "second" }, undefined, undefined, ctx);
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

			await checkpoint.execute("call-1", { summary: "failing" }, undefined, undefined, ctx);
			await h.emit("turn_end", ctx);
			expect(h.compactCalls).toHaveLength(1);

			h.compactCalls[0].onError?.(new Error("Already compacted"));
			expect(
				h.notifications.some((n) => n.message.includes("Checkpoint failed")),
			).toBe(true);

			// No stuck pending request: a fresh checkpoint fires again.
			await checkpoint.execute("call-2", { summary: "recovered" }, undefined, undefined, ctx);
			await h.emit("turn_end", ctx);
			expect(h.compactCalls).toHaveLength(2);
			expect(h.compactCalls[1].customInstructions).toContain("recovered");
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
				"summary: 'Read five haystack files; no findings recorded.'; continue: true; " +
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
