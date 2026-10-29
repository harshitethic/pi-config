/**
 * Tests for auto-checkpoint threshold resolution and arming.
 *
 * Two bugs these pin:
 *  1. resolveThreshold's default branch used to multiply defaultThreshold by
 *     contextWindow unconditionally — so an absolute default (e.g. 256000)
 *     resolved to 256000 * window (effectively never fires). The default must
 *     follow the same < 1 = fraction, >= 1 = absolute rule as per-model entries.
 *  2. The nudge never armed for resumed / default-model sessions: model_select
 *     only fires on explicit set/cycle, never on resume/startup, and ctx.model
 *     is undefined at session_start. turn_end must self-heal by (re-)deriving
 *     from ctx.model.
 */
import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { resolveThreshold, matchPattern, idleCompactDelayMs, default as loadExtension } from "../extensions/auto-checkpoint";

// ---------------------------------------------------------------------------
// resolveThreshold
// ---------------------------------------------------------------------------

describe("resolveThreshold", () => {
	const base = {
		defaultThreshold: 256000,
		smallWindowFraction: 0.8,
		cooldownTurns: 3,
		cooldownMs: 30_000,
		models: {},
		prompt: "x",
		defaultContextDegradation: true,
	};

	it("uses the absolute default as-is when the window is large enough", () => {
		// 0.8 * window >= 256000  when window >= 320000 → absolute wins.
		for (const cw of [320_000, 400_000, 1_048_576]) {
			expect(resolveThreshold("any/model", cw, base)).toBe(256000);
		}
	});

	it("caps an absolute default at smallWindowFraction when the window is smaller", () => {
		expect(resolveThreshold("any/model", 163_840, base)).toBe(131_072); // 0.8 * 163840
		expect(resolveThreshold("any/model", 200_000, base)).toBe(160_000); // 0.8 * 200000
		expect(resolveThreshold("any/model", 300_000, base)).toBe(240_000); // 0.8 * 300000 < 256000
	});

	it("respects a configured smallWindowFraction", () => {
		const cfg = { ...base, smallWindowFraction: 0.9 };
		expect(resolveThreshold("any/model", 200_000, cfg)).toBe(180_000); // 0.9 * 200000
	});

	it("treats a fractional default (<1) as a fraction of the window", () => {
		const cfg = { ...base, defaultThreshold: 0.75 };
		expect(resolveThreshold("any/model", 200_000, cfg)).toBe(150_000);
		expect(resolveThreshold("any/model", 1_048_576, cfg)).toBe(786_432);
	});

	it("per-model entries override the default and respect absolute vs fractional", () => {
		const cfg = {
			...base,
			defaultThreshold: 256000,
			models: {
				"deepseek/deepseek-v4-flash-*": { threshold: 200_000 }, // absolute (below cap)
				"openai/gpt-*": { threshold: 0.7 }, // fraction (uncapped)
				"weird/huge": { threshold: 500_000 }, // absolute, capped on small windows
			},
		};
		expect(resolveThreshold("deepseek/deepseek-v4-flash-0731", 1_048_576, cfg)).toBe(200_000);
		expect(resolveThreshold("openai/gpt-5", 200_000, cfg)).toBe(140_000);
		expect(resolveThreshold("weird/huge", 200_000, cfg)).toBe(160_000); // capped to 0.8*200000
		expect(resolveThreshold("zai/glm-5.2", 1_048_576, cfg)).toBe(256000); // falls to default
	});
});

describe("matchPattern", () => {
	it("matches exact, *, and ? case-insensitively", () => {
		expect(matchPattern("deepseek/deepseek-v4-flash-0731", "deepseek/deepseek-v4-flash-0731")).toBe(true);
		expect(matchPattern("deepseek/*", "deepseek/deepseek-v4-flash-0731")).toBe(true);
		expect(matchPattern("deepseek/*", "openai/gpt-5")).toBe(false);
		expect(matchPattern("deepseek/deepseek-v4-flash-??31", "deepseek/deepseek-v4-flash-0731")).toBe(true);
		expect(matchPattern("anthropic/claude-sonnet-*", "Anthropic/Claude-Sonnet-4")).toBe(true);
	});
});

// ---------------------------------------------------------------------------
// Arming self-heal: nudge fires even when session_start saw no model
// (the resumed / default-model case that left 95% of >250k sessions unsteered)
// ---------------------------------------------------------------------------

describe("arming self-heal on turn_end", () => {
	let dir: string;
	const handlers = new Map<string, (event: any, ctx: any) => Promise<any> | any>();
	const sentMessages: Array<{ message: any; options: any }> = [];

	beforeAll(async () => {
		dir = await mkdtemp(join(tmpdir(), "pi-acp-test-"));
		await mkdir(join(dir, ".pi"), { recursive: true });
		// cooldownMs: 0 so the multi-run test exercises the turn gate, not the timer.
		await writeFile(
			join(dir, ".pi", "auto-checkpoint.json"),
			JSON.stringify({ defaultThreshold: 256000, cooldownTurns: 3, cooldownMs: 0 }),
		);
		const fakePi: any = {
			on(event: string, handler: any) {
				handlers.set(event, handler);
			},
			registerCommand() {},
			sendMessage(message: any, options: any) {
				sentMessages.push({ message, options });
			},
		};
		loadExtension(fakePi);

		// session_start with NO model (resume/startup before model is set):
		// loads config but must not arm a threshold.
		await handlers.get("session_start")!({ type: "session_start", reason: "new" }, { cwd: dir, model: undefined });
	});
	afterAll(async () => {
		try { await rm(dir, { recursive: true, force: true }); } catch {}
	});

	const model = { id: "deepseek/deepseek-v4-flash-0731", contextWindow: 1_048_576 };
	// `dir` is assigned in beforeAll, so build the ctx lazily.
	const overThreshold = () => ({
		cwd: dir,
		model,
		getContextUsage: () => ({ tokens: 300_000, contextWindow: 1_048_576, percent: 28.6 }),
	});

	/** A turn that ended a run (stop) arms the next-prompt nudge; toolUse steers. */
	const turn = (turnIndex: number, stopReason = "stop") => ({
		type: "turn_end",
		turnIndex,
		message: { role: "assistant", stopReason },
	});

	async function freshSession() {
		await handlers.get("session_start")!({ type: "session_start", reason: "new" }, { cwd: dir, model: undefined });
		sentMessages.length = 0;
	}

	it("arms from ctx.model at turn_end and delivers the nudge at before_agent_start", async () => {
		await freshSession();
		// Above the 256000 default threshold. Two turns clear the 3-turn cooldown
		// from the -1 sentinel.
		await handlers.get("turn_end")!(turn(0), overThreshold());
		await handlers.get("turn_end")!(turn(1), overThreshold());

		const res = await handlers.get("before_agent_start")!(
			{ type: "before_agent_start" },
			{ cwd: dir, model },
		);
		expect(res).toBeDefined();
		expect(res.message.customType).toBe("auto-checkpoint");
		expect(res.message.content).toContain("300,000");
	});

	it("counts cooldown turns across agent runs (turnIndex resets each prompt)", async () => {
		await freshSession();
		// Run 1: five turns, delivers a nudge, raising the turn watermark.
		for (let i = 0; i < 5; i++) {
			await handlers.get("turn_end")!(turn(i), overThreshold());
		}
		const run1 = await handlers.get("before_agent_start")!(
			{ type: "before_agent_start" },
			{ cwd: dir, model },
		);
		expect(run1).toBeDefined();

		// Run 2: pi resets turnIndex to 0, but three real turns have elapsed, so
		// the cooldown is satisfied and the nudge must fire again. Under the old
		// `state.turnCounter = event.turnIndex` this was suppressed (0-5 < 3).
		for (let i = 0; i < 3; i++) {
			await handlers.get("turn_end")!(turn(i), overThreshold());
		}
		const run2 = await handlers.get("before_agent_start")!(
			{ type: "before_agent_start" },
			{ cwd: dir, model },
		);
		expect(run2).toBeDefined();
	});

	it("steers the nudge mid-run when the turn continues (toolUse)", async () => {
		await freshSession();
		// Three in-flight turns; the cooldown clears on the second.
		for (let i = 0; i < 3; i++) {
			await handlers.get("turn_end")!(turn(i, "toolUse"), overThreshold());
		}
		expect(sentMessages.length).toBe(1);
		expect(sentMessages[0].options.deliverAs).toBe("steer");
		expect(sentMessages[0].message.customType).toBe("auto-checkpoint");
		expect(sentMessages[0].message.content).toContain("300,000");

		// Steered, not armed — no before_agent_start delivery.
		const res = await handlers.get("before_agent_start")!(
			{ type: "before_agent_start" },
			{ cwd: dir, model },
		);
		expect(res).toBeUndefined();
	});

	it("includes read regions tracked from tool_result", async () => {
		await freshSession();
		handlers.get("tool_result")!(
			{ type: "tool_result", toolName: "read", isError: false, input: { path: "src/foo.ts", offset: 10, limit: 5 } },
			overThreshold(),
		);
		await handlers.get("turn_end")!(turn(0), overThreshold());
		await handlers.get("turn_end")!(turn(1), overThreshold());
		const res = await handlers.get("before_agent_start")!(
			{ type: "before_agent_start" },
			{ cwd: dir, model },
		);
		expect(res.message.content).toContain("src/foo.ts");
		expect(res.message.content).toContain("L10-14");
	});

	it("does not nudge below the threshold", async () => {
		await freshSession();
		const ctx = {
			cwd: dir,
			model,
			getContextUsage: () => ({ tokens: 100_000, contextWindow: 1_048_576, percent: 9.5 }),
		};
		await handlers.get("turn_end")!(turn(10), ctx);
		const res = await handlers.get("before_agent_start")!(
			{ type: "before_agent_start" },
			{ cwd: dir, model },
		);
		expect(res).toBeUndefined();
	});
});

// ---------------------------------------------------------------------------
// Idle compaction: a settled session above the threshold compacts itself after
// IDLE_FRACTION × cacheTtlMs, so the next prompt does not re-read the whole
// context at full price.
// ---------------------------------------------------------------------------

describe("idleCompactDelayMs", () => {
	it("fires at 90% of the cache TTL (Claude Code runs 54 of 60 min)", () => {
		expect(idleCompactDelayMs(5 * 60_000)).toBe(270_000);
		expect(idleCompactDelayMs(60 * 60_000)).toBe(3_240_000);
	});

	it("a zero/negative TTL disables the timer", () => {
		expect(idleCompactDelayMs(0)).toBe(0);
		expect(idleCompactDelayMs(-1)).toBe(0);
	});
});

describe("idle compaction", () => {
	let dir: string;
	const handlers = new Map<string, (event: any, ctx: any) => Promise<any> | any>();
	// A neutral id: per-model entries in the developer's live
	// ~/.pi/agent/auto-checkpoint.json must not reach these assertions.
	const model = { id: "idle-test/model", contextWindow: 1_048_576 };
	const TTL_MS = 20; // → 18 ms idle delay
	const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

	beforeAll(async () => {
		dir = await mkdtemp(join(tmpdir(), "pi-acp-idle-"));
		await mkdir(join(dir, ".pi"), { recursive: true });
		loadExtension({
			on(event: string, handler: any) {
				handlers.set(event, handler);
			},
			registerCommand() {},
			sendMessage() {},
		} as any);
	});
	afterAll(async () => {
		await handlers.get("session_start")!({ type: "session_start", reason: "new" }, { cwd: dir, model, mode: "tui" });
		try { await rm(dir, { recursive: true, force: true }); } catch {}
	});

	/** Rewrite the project config, then start a fresh session with it. */
	async function start(raw: Record<string, unknown>, ctx: Record<string, unknown> = {}) {
		await writeFile(join(dir, ".pi", "auto-checkpoint.json"), JSON.stringify(raw));
		await handlers.get("session_start")!({ type: "session_start", reason: "new" }, { cwd: dir, model, mode: "tui", ...ctx });
	}

	function idleCtx(overrides: Record<string, unknown> = {}) {
		const calls: any[] = [];
		const ctx: any = {
			cwd: dir,
			model,
			mode: "tui",
			hasUI: true,
			ui: { notify() {} },
			isIdle: () => true,
			hasPendingMessages: () => false,
			getContextUsage: () => ({ tokens: 300_000, contextWindow: 1_048_576, percent: 28.6 }),
			compact: (options: any) => calls.push(options),
			...overrides,
		};
		return { ctx, calls };
	}

	const base = { defaultThreshold: 1000, idleCompaction: true, cacheTtlMs: TTL_MS };

	it("compacts once after an idle settle when above the threshold", async () => {
		await start(base);
		const { ctx, calls } = idleCtx();
		await handlers.get("agent_settled")!({ type: "agent_settled" }, ctx);
		expect(calls.length).toBe(0); // not before the idle delay
		await sleep(TTL_MS * 4);
		expect(calls.length).toBe(1);
	});

	it("does not compact below the threshold", async () => {
		await start(base);
		const { ctx, calls } = idleCtx({
			getContextUsage: () => ({ tokens: 500, contextWindow: 1_048_576, percent: 0.1 }),
		});
		await handlers.get("agent_settled")!({ type: "agent_settled" }, ctx);
		await sleep(TTL_MS * 4);
		expect(calls).toEqual([]);
	});

	it("stays off when disabled or the TTL is zero", async () => {
		for (const raw of [{ ...base, idleCompaction: false }, { ...base, cacheTtlMs: 0 }]) {
			await start(raw);
			const { ctx, calls } = idleCtx();
			await handlers.get("agent_settled")!({ type: "agent_settled" }, ctx);
			await sleep(TTL_MS * 4);
			expect(calls).toEqual([]);
		}
	});

	it("stays off outside an interactive session", async () => {
		// A subagent/RPC session is settled between driver commands that may
		// arrive at any moment; compacting under it would summarise live context.
		await start(base);
		const { ctx, calls } = idleCtx({ mode: "rpc" });
		await handlers.get("agent_settled")!({ type: "agent_settled" }, ctx);
		await sleep(TTL_MS * 4);
		expect(calls).toEqual([]);
	});

	it("re-checks at fire time: a run that resumed, or queued input, cancels it", async () => {
		await start(base);
		const running = idleCtx({ isIdle: () => false });
		await handlers.get("agent_settled")!({ type: "agent_settled" }, running.ctx);
		await sleep(TTL_MS * 4);
		expect(running.calls).toEqual([]);

		const queued = idleCtx({ hasPendingMessages: () => true });
		await handlers.get("agent_settled")!({ type: "agent_settled" }, queued.ctx);
		await sleep(TTL_MS * 4);
		expect(queued.calls).toEqual([]);
	});

	it("a new turn cancels the pending idle timer", async () => {
		await start(base);
		const { ctx, calls } = idleCtx();
		await handlers.get("agent_settled")!({ type: "agent_settled" }, ctx);
		await handlers.get("turn_start")!({ type: "turn_start", turnIndex: 0, timestamp: Date.now() }, ctx);
		await sleep(TTL_MS * 4);
		expect(calls).toEqual([]);
	});

	it("per-model cacheTtlMs overrides the top-level value", async () => {
		await start({
			defaultThreshold: 1000,
			idleCompaction: true,
			cacheTtlMs: 0, // top level off …
			models: { "idle-test/*": { threshold: 1000, cacheTtlMs: TTL_MS } }, // … this model on
		});
		const { ctx, calls } = idleCtx();
		await handlers.get("agent_settled")!({ type: "agent_settled" }, ctx);
		await sleep(TTL_MS * 4);
		expect(calls.length).toBe(1);
	});
});
