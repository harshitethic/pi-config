/**
 * Tests for the subagent kill-path null-proc guard (WO-2026-043).
 *
 * `subagent_kill` (and decision 015's stage-2 progress-timeout auto-kill,
 * which shares `dispatchKillSignals`) crashed on recovered/pre-reload
 * sessions: the `RunningSubagent` entry is reconstructed from disk with
 * `proc === null` (no live ChildProcess), and the dispatch dereferenced it
 * (`rs.proc.killed`) → `Cannot read properties of null (reading 'killed')`.
 *
 * Coverage, at three levels:
 *
 * Dispatch-level (`dispatchKillSignals`, exported @internal test hook):
 *  1. Live proc (regression): SIGTERM dispatched, `{ alreadyDead: false }`,
 *     flags set, existing kill marker logged.
 *  2. Null proc (recovered/pre-reload session): no throw, `{ alreadyDead:
 *     true, noProcess: true }`, flags set, distinct "process handle
 *     unavailable" marker logged, NO signal attempted.
 *  3. Progress-timeout `via` on a null proc: stage-2 auto-kill shares the
 *     dispatch and must get the same guard.
 *  4. Already-dead live proc via `killed === true` (existing contract).
 *  5. Already-dead live proc via `exitCode !== null`.
 *  6. Null proc schedules NO SIGKILL fallback timer (a delayed callback can
 *     never dereference `rs.proc` because none is scheduled).
 *  7. Live proc schedules exactly one fallback; a proc already killed by
 *     SIGTERM makes the callback a no-op.
 *  8. Live proc surviving SIGTERM: the fallback callback sends SIGKILL.
 *  9. Flag ordering: `killedExplicitly` / `killedVia` are set before ANY
 *     proc dereference or signal — observed from inside the proc stub's
 *     getters and `kill()` at dispatch time AND inside the delayed SIGKILL
 *     fallback callback.
 *
 * Close-handler delivery (`deliverCloseResult`, the real delivery seam):
 * 10. Stop path: resolves `resolveOnStop` (marker prepended when killed),
 *     nulls the waiter, and never calls `sendUserMessage`.
 * 11. Kill/completion path: delivers exactly one user message carrying the
 *     kill marker (both `via` kinds).
 *
 * Tool-level (the extension registered with a minimal `ExtensionAPI` stub,
 * exercising the actual `subagent_kill` / `subagent_stop` bodies):
 * 12. `subagent_kill` on a null-proc session: distinct "marked killed — no
 *     live process existed to signal" message, no throw.
 * 13. `subagent_kill` on a live proc: "sent SIGTERM"; second call is an
 *     idempotent no-op ("already killed — signals skipped"), no re-fire, no
 *     duplicate dispatch marker.
 * 14. `subagent_stop` on a null-proc session: waiter resolves via the
 *     resolveOnStop path, no throw, no signal attempted, no user message.
 * 15. `subagent_stop` on a null-proc session: the timeout fallback branch
 *     resolves the waiter ("[Force-stopped after timeout]").
 * 16. `subagent_stop` on a null-proc session: aborted signal resolves the
 *     waiter ("[Aborted]").
 *
 * Run: bun test tests/subagent-async-kill.test.ts
 */

import { afterEach, beforeAll, describe, expect, it, spyOn } from "bun:test";
import { randomUUID } from "node:crypto";
import { existsSync, unlinkSync } from "node:fs";
import extension, {
	dispatchKillSignals,
	deliverCloseResult,
	_testSetLiveSessionCtx,
	_testRunning,
} from "../extensions/subagent-async/index.ts";

// ── Environment helpers ────────────────────────────────────────────────────

// Log files written by appendRunningLogLine during tests; cleaned up so the
// suite leaves no /tmp litter behind.
const logFilesToClean: string[] = [];

afterEach(() => {
	for (const f of logFilesToClean) {
		try {
			if (existsSync(f)) unlinkSync(f);
		} catch {
			// best-effort cleanup
		}
	}
	logFilesToClean.length = 0;
});

// bun 1.3's spyOn wraps-and-calls-through with no built-in restore, so the
// spy is torn down by reassigning the original global. Used by the
// timer-aware tests (6, 7, 8, 9, 13, 15) to intercept the SIGKILL-fallback
// and stop-fallback timers without waiting for the real delays.
const realSetTimeout = globalThis.setTimeout;
let setTimeoutSpy: ReturnType<typeof spyOn> | null = null;

function installSetTimeoutSpy(): void {
	setTimeoutSpy = spyOn(globalThis, "setTimeout");
}

function restoreSetTimeout(): void {
	if (setTimeoutSpy) {
		globalThis.setTimeout = realSetTimeout;
		setTimeoutSpy = null;
	}
}

afterEach(restoreSetTimeout);

// The liveness contract (decision 026): `deliverResult` only sends on a live
// session. Tests below that exercise the delivery path must declare one; this
// teardown keeps the module state clean for the next test.
afterEach(() => {
	_testSetLiveSessionCtx(null);
});

/** Build a RunningSubagent-shaped stub. `proc` is injected separately so
 *  tests can pass a live stub, an already-dead stub, or null (recovered). */
function stubRunningSubagent(proc: any): any {
	const logPath = `/tmp/pi-subagent-test-${randomUUID()}.log`;
	logFilesToClean.push(logPath);
	return {
		proc,
		sessionId: `subagent-${randomUUID()}`,
		agentName: "test-agent",
		task: "test task",
		cwd: "/tmp",
		startedAt: Date.now(),
		progress: { turns: 0, filesRead: new Set(), filesModified: new Set(), errors: [], currentActivity: "testing" },
		messages: [],
		stdin: null,
		resolveOnStop: null,
		isDone: false,
		killedExplicitly: false,
		stoppedExplicitly: false,
		turnNudged: false,
		logPath,
		logLines: [],
		stderrLines: [],
		watchHandle: null,
		sockPath: "",
		sockServer: null,
		sockClients: new Set(),
		worktreePath: null,
		isolationBranch: null,
		parentHeadCommit: null,
		parentCwd: "/tmp",
		carried: null,
		parentTrackerKey: "test",
		usageStats: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, latestCacheHitRate: undefined },
		staleTimer: null,
		lastActivityMs: Date.now(),
		silenceTimer: null,
		silenceTimeoutMs: 0,
		killedVia: null,
	};
}

/** Stubbed ChildProcess-shaped handle: records signals. SIGTERM marks it
 *  killed (like a real process exiting) unless `survivesSigterm` is set —
 *  that variant models a child that needs the SIGKILL fallback. */
function stubLiveProc(opts: { survivesSigterm?: boolean } = {}): any {
	const proc: any = {
		killed: false,
		exitCode: null,
		signals: [] as string[],
		kill(sig: string) {
			proc.signals.push(sig);
			if (!opts.survivesSigterm || sig === "SIGKILL") proc.killed = true;
		},
	};
	return proc;
}

/** Proc stub whose `killed`/`exitCode` getters and `kill()` record the
 *  RunningSubagent's flag state at the exact moment of each proc access —
 *  proves `killedExplicitly`/`killedVia` are set BEFORE any proc
 *  dereference or signal (WO-2026-043 ordering invariant), including inside
 *  the delayed SIGKILL fallback callback. Survives SIGTERM (only SIGKILL
 *  marks it killed) so the fallback callback's reads and kill are observed
 *  too. `getRs` is invoked lazily so the stub can be wired to the rs record
 *  after construction. */
function stubOrderingProc(getRs: () => any): any {
	const proc: any = {
		_killed: false,
		_exitCode: null,
		signals: [] as string[],
		observations: [] as string[],
		get killed() {
			const rs = getRs();
			proc.observations.push(`killed:${rs.killedExplicitly}:${rs.killedVia}`);
			return proc._killed;
		},
		get exitCode() {
			const rs = getRs();
			proc.observations.push(`exitCode:${rs.killedExplicitly}:${rs.killedVia}`);
			return proc._exitCode;
		},
		kill(sig: string) {
			const rs = getRs();
			proc.signals.push(sig);
			proc.observations.push(`kill:${sig}:${rs.killedExplicitly}:${rs.killedVia}`);
			if (sig === "SIGKILL") proc._killed = true;
		},
	};
	return proc;
}

/** Minimal ExtensionAPI stub: captures tool defs, command defs, and
 *  delivered user messages; all other surfaces are inert no-ops. */
function createPiStub() {
	const sentMessages: string[] = [];
	const tools = new Map<string, any>();
	const commands = new Map<string, any>();
	const pi: any = {
		events: { emit: () => {} },
		registerTool: (def: any) => { tools.set(def.name, def); },
		registerCommand: (name: string, def: any) => { commands.set(name, def); },
		on: () => {},
		sendUserMessage: (message: string) => { sentMessages.push(message); },
		ui: { setStatus: () => {}, notify: () => {}, setWidget: () => {} },
	};
	return { pi, tools, commands, sentMessages };
}

const KILL_MARKER = "[Killed via subagent_kill — process terminated, work in this subagent is lost]";
const PROGRESS_MARKER = "[Killed via progress-timeout — process terminated, work in this subagent is lost]";
const TURN_LIMIT_MARKER = "[Killed via turn-limit — process terminated, work in this subagent is lost]";

// ── Dispatch-level tests ───────────────────────────────────────────────────

describe("dispatchKillSignals (WO-2026-043 null-proc guard)", () => {
	it("1: live proc — SIGTERM dispatched, alreadyDead:false, flags + marker set (regression)", () => {
		const proc = stubLiveProc();
		const rs = stubRunningSubagent(proc);

		const result = dispatchKillSignals(rs, "kill-tool");

		expect(result.alreadyDead).toBe(false);
		expect(result.noProcess).toBeUndefined();
		expect(rs.killedExplicitly).toBe(true);
		expect(rs.killedVia).toBe("kill-tool");
		expect(proc.signals).toEqual(["SIGTERM"]);
		// Existing marker wording preserved; no null-proc marker on this path.
		const log = rs.logLines.join("\n");
		expect(log).toContain("Killed via subagent_kill (SIGTERM sent");
		expect(log).not.toContain("process handle unavailable");
	});

	it("2: null proc (recovered/pre-reload) — no throw, alreadyDead:true, noProcess:true, flags set, distinct marker, no signal attempted", () => {
		const rs = stubRunningSubagent(null);

		let result: { alreadyDead: boolean; noProcess?: boolean } | undefined;
		expect(() => {
			result = dispatchKillSignals(rs, "kill-tool");
		}).not.toThrow();

		expect(result?.alreadyDead).toBe(true);
		expect(result?.noProcess).toBe(true);
		expect(rs.killedExplicitly).toBe(true);
		expect(rs.killedVia).toBe("kill-tool");
		// Distinct marker wording for the recovered-session case.
		expect(rs.logLines.join("\n")).toContain("process handle unavailable (recovered/pre-reload session)");
	});

	it("3: progress-timeout via on a null proc — stage-2 auto-kill shares the dispatch and the guard", () => {
		const rs = stubRunningSubagent(null);

		const result = dispatchKillSignals(rs, "progress-timeout");

		expect(result).toEqual({ alreadyDead: true, noProcess: true });
		expect(rs.killedVia).toBe("progress-timeout");
		expect(rs.logLines.join("\n")).toContain("Killed via progress-timeout — process handle unavailable");
	});

	it("4: already-dead live proc (killed=true) — alreadyDead:true, no signal attempted, flags set (existing contract)", () => {
		const proc = stubLiveProc();
		proc.killed = true; // raced to exit before dispatch
		const rs = stubRunningSubagent(proc);

		const result = dispatchKillSignals(rs, "kill-tool");

		expect(result.alreadyDead).toBe(true);
		expect(result.noProcess).toBeUndefined();
		expect(proc.signals).toEqual([]);
		expect(rs.killedExplicitly).toBe(true);
		expect(rs.killedVia).toBe("kill-tool");
	});

	it("5: already-dead live proc via exitCode !== null — alreadyDead:true, no signal attempted", () => {
		const proc = stubLiveProc();
		proc.exitCode = 0; // process already exited with a code
		const rs = stubRunningSubagent(proc);

		const result = dispatchKillSignals(rs, "kill-tool");

		expect(result.alreadyDead).toBe(true);
		expect(proc.signals).toEqual([]);
		expect(rs.killedExplicitly).toBe(true);
	});

	it("6: null proc schedules NO SIGKILL fallback timer — a delayed callback can never dereference rs.proc", () => {
		installSetTimeoutSpy();
		const rs = stubRunningSubagent(null);

		dispatchKillSignals(rs, "kill-tool");

		// The null-proc branch returns before any timer is scheduled.
		expect(setTimeoutSpy!.mock.calls.length).toBe(0);
	});

	it("7: live proc schedules exactly one fallback; SIGTERM-killed proc makes the callback a no-op", () => {
		installSetTimeoutSpy();
		const proc = stubLiveProc(); // SIGTERM kills it
		const rs = stubRunningSubagent(proc);

		const result = dispatchKillSignals(rs, "kill-tool");

		expect(result.alreadyDead).toBe(false);
		expect(setTimeoutSpy!.mock.calls.length).toBe(1); // only the SIGKILL fallback
		const fallbackCb = setTimeoutSpy!.mock.calls[0]![0] as () => void;
		expect(() => fallbackCb()).not.toThrow();
		expect(proc.signals).toEqual(["SIGTERM"]); // callback saw killed=true, skipped SIGKILL
		// The call-through spy scheduled the real timer; clear it so nothing
		// is left pending in the test process.
		clearTimeout((setTimeoutSpy!.mock.results[0] as any).value);
	});

	it("8: live proc surviving SIGTERM — the fallback callback sends SIGKILL", () => {
		installSetTimeoutSpy();
		const proc = stubLiveProc({ survivesSigterm: true });
		const rs = stubRunningSubagent(proc);

		const result = dispatchKillSignals(rs, "kill-tool");

		expect(result.alreadyDead).toBe(false);
		expect(setTimeoutSpy!.mock.calls.length).toBe(1);
		const fallbackCb = setTimeoutSpy!.mock.calls[0]![0] as () => void;
		expect(() => fallbackCb()).not.toThrow();
		expect(proc.signals).toEqual(["SIGTERM", "SIGKILL"]);
		clearTimeout((setTimeoutSpy!.mock.results[0] as any).value);
	});

	it("9: flags are set before ANY proc access or signal — observed at dispatch AND inside the delayed SIGKILL callback", () => {
		installSetTimeoutSpy();
		const rs = stubRunningSubagent(null);
		const proc = stubOrderingProc(() => rs);
		rs.proc = proc;

		dispatchKillSignals(rs, "kill-tool");

		// Fire the delayed SIGKILL fallback callback; ordering must hold there too.
		expect(setTimeoutSpy!.mock.calls.length).toBe(1);
		const fallbackCb = setTimeoutSpy!.mock.calls[0]![0] as () => void;
		expect(() => fallbackCb()).not.toThrow();
		clearTimeout((setTimeoutSpy!.mock.results[0] as any).value);

		// 6 observations: killed + exitCode + kill(SIGTERM) at dispatch, then
		// killed + exitCode + kill(SIGKILL) in the fallback callback. Every
		// one must have observed killedExplicitly=true and killedVia=kill-tool.
		expect(proc.observations.length).toBe(6);
		expect(proc.signals).toEqual(["SIGTERM", "SIGKILL"]);
		for (const obs of proc.observations) {
			expect(obs).toMatch(/:(true):(kill-tool)$/);
		}
	});

	// Hard-turn-limit kill (pi-config gh #8): the MAX_TURNS_HARD stop in the
	// message_end handler must route through the shared kill dispatch so the
	// close handler sees killedExplicitly and prepends the marker — a bare
	// proc.kill there delivered the child's last message as a normal
	// completion, escaping the killed/stopped skips (R4 owner_asks gate).
	it("10: turn-limit via, live proc — SIGTERM dispatched, flags set, turn-limit label", () => {
		const proc = stubLiveProc();
		const rs = stubRunningSubagent(proc);

		const result = dispatchKillSignals(rs, "turn-limit");

		expect(result.alreadyDead).toBe(false);
		expect(rs.killedExplicitly).toBe(true);
		expect(rs.killedVia).toBe("turn-limit");
		expect(proc.signals).toEqual(["SIGTERM"]);
		const log = rs.logLines.join("\n");
		expect(log).toContain("Killed via turn-limit (SIGTERM sent");
	});

	it("11: turn-limit via, null proc — flags set, no signal, noProcess guard", () => {
		const rs = stubRunningSubagent(null);

		const result = dispatchKillSignals(rs, "turn-limit");

		expect(result).toEqual({ alreadyDead: true, noProcess: true });
		expect(rs.killedExplicitly).toBe(true);
		expect(rs.killedVia).toBe("turn-limit");
	});
});

// ── Close-handler delivery decision ────────────────────────────────────────

describe("deliverCloseResult (single owner of delivery)", () => {
	it("10: stop path resolves resolveOnStop exactly once (marker prepended when killed), nulls the waiter, never sends a user message", () => {
		const rs = stubRunningSubagent(null);
		let resolveCalls = 0;
		rs.resolveOnStop = (finalOutput?: string) => { resolveCalls++; rs.stopText = finalOutput || ""; };
		dispatchKillSignals(rs, "kill-tool"); // flags set; kill marker must prepend
		const sent: string[] = [];

		const path = deliverCloseResult({ sendUserMessage: (m: string) => sent.push(m) } as any, rs, 0, "");

		expect(path).toBe("stop");
		// Waiter resolved exactly once, with the kill marker prepended
		// (getFinalOutput([]) is "" on the stop path; the "(no output)"
		// fallback lives in deliverResult).
		expect(resolveCalls).toBe(1);
		expect(rs.stopText).toBe(`${KILL_MARKER}\n`);
		expect(rs.resolveOnStop).toBeNull();
		// No double delivery: sendUserMessage was never called on the stop path.
		expect(sent.length).toBe(0);
	});

	it("11: kill/completion path delivers exactly one user message carrying the kill marker", () => {
		// A live session is required for delivery (decision 026).
		_testSetLiveSessionCtx({ ui: {} });
		const sent: string[] = [];

		// kill-tool via on a recovered (null-proc) session.
		const rs = stubRunningSubagent(null);
		dispatchKillSignals(rs, "kill-tool");
		const path = deliverCloseResult({ sendUserMessage: (m: string) => sent.push(m) } as any, rs, 0, "");
		expect(path).toBe("deliver");
		expect(sent.length).toBe(1);
		expect(sent[0]!.startsWith(KILL_MARKER)).toBe(true);

		// progress-timeout via uses the stage-2 marker family.
		const sent2: string[] = [];
		const rs2 = stubRunningSubagent(null);
		dispatchKillSignals(rs2, "progress-timeout");
		const path2 = deliverCloseResult({ sendUserMessage: (m: string) => sent2.push(m) } as any, rs2, 0, "");
		expect(path2).toBe("deliver");
		expect(sent2.length).toBe(1);
		expect(sent2[0]!.startsWith(PROGRESS_MARKER)).toBe(true);

		// turn-limit via (gh #8 rework, review-tests r1 #1): the delivered
		// marker family gains its own greppable variant — pin the string.
		const sent3: string[] = [];
		const rs3 = stubRunningSubagent(null);
		dispatchKillSignals(rs3, "turn-limit");
		const path3 = deliverCloseResult({ sendUserMessage: (m: string) => sent3.push(m) } as any, rs3, 0, "");
		expect(path3).toBe("deliver");
		expect(sent3.length).toBe(1);
		expect(sent3[0]!.startsWith(TURN_LIMIT_MARKER)).toBe(true);
	});
});

// ── Tool-level tests (registered extension, minimal pi stub) ───────────────

describe("registered subagent_kill / subagent_stop tools (harness)", () => {
	let piStub: ReturnType<typeof createPiStub>;
	let killTool: any;
	let stopTool: any;

	beforeAll(() => {
		piStub = createPiStub();
		extension(piStub.pi);
		killTool = piStub.tools.get("subagent_kill");
		stopTool = piStub.tools.get("subagent_stop");
		expect(killTool).toBeDefined();
		expect(stopTool).toBeDefined();
	});

	afterEach(() => {
		_testRunning.clear();
	});

	it("12: subagent_kill on a null-proc (recovered) session — distinct message, no throw", async () => {
		const rs = stubRunningSubagent(null);
		_testRunning.set(rs.sessionId, rs);

		// Await directly: a rejected promise fails this test loudly.
		const res = await killTool.execute("call-1", { session_id: rs.sessionId });

		const text = res.content[0].text;
		// Distinct recovered-session wording — NOT the generic "already dead".
		expect(text).toContain("marked killed — no live process existed to signal (recovered/pre-reload session)");
		expect(text).not.toContain("already dead — kill signals skipped");
		expect(rs.killedExplicitly).toBe(true);
		expect(rs.logLines.join("\n")).toContain("process handle unavailable");
	});

	it("13: subagent_kill on a live proc — SIGTERM once; second call idempotent no-op", async () => {
		installSetTimeoutSpy(); // clear the real 5s fallback timer after dispatch
		const proc = stubLiveProc();
		const rs = stubRunningSubagent(proc);
		_testRunning.set(rs.sessionId, rs);

		const res1 = await killTool.execute("call-1", { session_id: rs.sessionId });
		expect(res1.content[0].text).toContain("sent SIGTERM");
		expect(proc.signals).toEqual(["SIGTERM"]);
		// Exactly one timer (the SIGKILL fallback); clear it for hygiene.
		expect(setTimeoutSpy!.mock.calls.length).toBe(1);
		clearTimeout((setTimeoutSpy!.mock.results[0] as any).value);

		// Idempotent second call: early return, no re-fire, no duplicate marker.
		const res2 = await killTool.execute("call-2", { session_id: rs.sessionId });
		expect(res2.content[0].text).toContain("already killed — signals skipped");
		expect(proc.signals).toEqual(["SIGTERM"]);
		const killMarkerCount = rs.logLines.filter((l: string) => l.includes("Killed via subagent_kill")).length;
		expect(killMarkerCount).toBe(1);
	});

	it("14: subagent_stop on a null-proc session — waiter resolves via resolveOnStop, no signal, no user message", async () => {
		const rs = stubRunningSubagent(null);
		_testRunning.set(rs.sessionId, rs);

		const p = stopTool.execute("call-1", { session_id: rs.sessionId }, undefined);
		// The promise executor ran synchronously, so resolveOnStop is set —
		// simulate the close-handler/waiter resolution for a session with no
		// live process (proc === null: no signal is ever attempted).
		rs.resolveOnStop("wrapped up early");
		const res = await p;

		expect(res.content[0].text).toContain("stopped");
		expect(res.content[0].text).toContain("wrapped up early");
		expect(rs.stoppedExplicitly).toBe(true);
		// Stop path never delivers via sendUserMessage (mutual exclusion).
		expect(piStub.sentMessages.length).toBe(0);
	});

	it("15: subagent_stop on a null-proc session — timeout fallback branch resolves the waiter", async () => {
		installSetTimeoutSpy();
		const rs = stubRunningSubagent(null);
		_testRunning.set(rs.sessionId, rs);

		const p = stopTool.execute("call-1", { session_id: rs.sessionId }, undefined);
		// Exactly one timer: the STOP_TIMEOUT_MS fallback.
		expect(setTimeoutSpy!.mock.calls.length).toBe(1);
		const fallbackCb = setTimeoutSpy!.mock.calls[0]![0] as () => void;
		// The null-proc branch skips signals and resolves the waiter.
		expect(() => fallbackCb()).not.toThrow();
		const res = await p;

		expect(res.content[0].text).toContain("[Force-stopped after timeout]");
		// finish() cleared the real pending fallback timer via clearTimeout.
		expect(piStub.sentMessages.length).toBe(0);
	});

	it("16: subagent_stop on a null-proc session — aborted signal resolves the waiter", async () => {
		const rs = stubRunningSubagent(null);
		_testRunning.set(rs.sessionId, rs);

		const ac = new AbortController();
		ac.abort();
		const res = await stopTool.execute("call-1", { session_id: rs.sessionId }, ac.signal);

		expect(res.content[0].text).toContain("[Aborted]");
		expect(piStub.sentMessages.length).toBe(0);
	});
});
