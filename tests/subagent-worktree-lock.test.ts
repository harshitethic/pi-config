/**
 * tfd process-controls R3-2 (owner, 2026-10-19): the worktree lock/reap
 * lifecycle, driven against real git in a real temp repo.
 *
 * Lock: `createWorktree` locks immediately after `worktree add`, so
 * `git worktree remove --force` on a live child's tree fails; the harness's own
 * cleanup unlocks only after the completion is recorded, then removes.
 * Reap: `reapFinishedWorktrees` needs 027's adoption gate AND child-side
 * terminal evidence; a clean tree is unlocked and removed (no `--force`), a
 * dirty tree is kept and marked `worktreeKept`, a live foreign owner or a
 * legacy meta is left untouched.
 *
 * Run: bun test tests/subagent-worktree-lock.test.ts
 */

import { afterAll, afterEach, beforeAll, describe, expect, it } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import subagentFactory, {
	_testSetLiveSessionCtx,
	_testSetRecoveryScanDir,
	metaPath,
	readMetaJson,
	reapFinishedWorktrees,
	resolveRunningSession,
	updateMetaJson,
	writeMetaJson,
} from "../extensions/subagent-async/index.ts";

// ── Real git helpers ───────────────────────────────────────────────────────

function git(cwd: string, args: string[]): { code: number; out: string; err: string } {
	const p = Bun.spawnSync(["git", ...args], { cwd, stdout: "pipe", stderr: "pipe" });
	return { code: p.exitCode, out: p.stdout.toString(), err: p.stderr.toString() };
}

function makeRepo(): string {
	const repo = mkdtempSync(join(tmpdir(), "pi-lock-repo-"));
	expectedRepos.push(repo);
	git(repo, ["init", "-q", "."]);
	git(repo, ["config", "user.email", "test@example.com"]);
	git(repo, ["config", "user.name", "Test"]);
	writeFileSync(join(repo, "seed.txt"), "seed\n");
	git(repo, ["add", "-A"]);
	git(repo, ["commit", "-q", "-m", "init"]);
	return repo;
}

/** `git worktree list --porcelain` entry for `path`, when registered. git
 *  canonicalises the path (/var → /private/var on macOS), so compare realpaths. */
function worktreeEntry(repo: string, path: string): string | null {
	let target = path;
	try { target = realpathSync(path); } catch { /* directory already removed */ }
	const out = git(repo, ["worktree", "list", "--porcelain"]).out;
	for (const block of out.split("\n\n")) {
		const first = block.split("\n")[0];
		if (!first?.startsWith("worktree ")) continue;
		let registered = first.slice("worktree ".length);
		try { registered = realpathSync(registered); } catch { /* gone */ }
		if (registered === target) return block;
	}
	return null;
}

const expectedRepos: string[] = [];
const expectedDirs: string[] = [];
const children: Array<{ sid: string; cwd: string; ctx: any; tools: Map<string, any> }> = [];

function tempDir(prefix: string): string {
	const d = mkdtempSync(join(tmpdir(), prefix));
	expectedDirs.push(d);
	return d;
}

// ── Spawn plumbing ─────────────────────────────────────────────────────────

let fixtureRoot: string;
let argv1Before: string | undefined;
let agentDirBefore: string | undefined;

beforeAll(() => {
	fixtureRoot = mkdtempSync(join(tmpdir(), "pi-lock-fixture-"));
	const fakePi = join(fixtureRoot, "stand-in-pi.mjs");
	writeFileSync(
		fakePi,
		`
import { appendFileSync, readFileSync } from "node:fs";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (d) => { try { appendFileSync("stdin-echo.txt", d); } catch {} });
process.stdin.on("end", () => process.exit(0));
let last = null;
setInterval(() => {
	let report = "";
	try { report = readFileSync("standin-report.txt", "utf8"); } catch { /* not yet */ }
	if (report.length > 0 && report !== last) {
		last = report;
		process.stdout.write(JSON.stringify({ type: "message_end", message: { role: "assistant",
			content: [{ type: "text", text: report }],
			usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, cost: { total: 0 } } } }) + "\\n");
	}
}, 200);
setInterval(() => {}, 1 << 30);
`,
	);
	argv1Before = process.argv[1];
	process.argv[1] = fakePi;

	const agentsDir = join(fixtureRoot, "agent", "agents");
	mkdirSync(agentsDir, { recursive: true });
	writeFileSync(join(agentsDir, "worker.md"), "---\nname: worker\ndescription: lock fixture\n---\n\nDo the work.\n");
	agentDirBefore = process.env.PI_CODING_AGENT_DIR;
	process.env.PI_CODING_AGENT_DIR = join(fixtureRoot, "agent");
});

afterAll(() => {
	if (argv1Before !== undefined) process.argv[1] = argv1Before;
	if (agentDirBefore === undefined) delete process.env.PI_CODING_AGENT_DIR;
	else process.env.PI_CODING_AGENT_DIR = agentDirBefore;
	rmSync(fixtureRoot, { recursive: true, force: true });
});

async function spawnIsolated(cwd: string, opts: { steers?: string[] } = {}) {
	const tools = new Map<string, any>();
	const pi: any = {
		events: { emit: () => {} },
		registerTool: (def: any) => tools.set(def.name, def),
		registerCommand: () => {},
		on: () => {},
		sendUserMessage: (text: string) => opts.steers?.push(text),
		ui: { setStatus: () => {}, notify: () => {}, setWidget: () => {} },
	};
	subagentFactory(pi);
	const ctx: any = {
		cwd,
		ui: { setStatus: () => {}, notify: () => {}, setWidget: () => {}, clearStatus: () => {} },
		getModel: () => ({ provider: "openrouter", id: "xiaomi/mimo-v2.6-flash" }),
		sessionManager: { getBranch: () => [], getEntries: () => [], getSessionId: () => "sess-lock" },
	};
	_testSetLiveSessionCtx(ctx);

	const res = await tools
		.get("subagent")
		.execute("tc", { agent: "worker", task: "wait for the signal", cwd, isolate: true, review_policy: "skip" }, undefined, undefined, ctx);
	const text = res.content[0].text as string;
	if (res.isError) throw new Error(`spawn failed: ${text}`);
	const sid = /session: (subagent-[0-9a-f-]+)/.exec(text)?.[1];
	if (!sid) throw new Error(`no session id in:\n${text}`);
	children.push({ sid, cwd, ctx, tools });
	return { sid, text, ctx, tools };
}

async function waitFor(check: () => boolean, ms = 15_000): Promise<boolean> {
	const deadline = Date.now() + ms;
	while (Date.now() < deadline) {
		if (check()) return true;
		await new Promise((r) => setTimeout(r, 50));
	}
	return check();
}

afterEach(async () => {
	_testSetLiveSessionCtx(undefined);
	for (const child of children.splice(0)) {
		try {
			const rs = resolveRunningSession(child.sid);
			if (rs) {
				if (rs.staleTimer) clearTimeout(rs.staleTimer);
				if (rs.silenceTimer) clearTimeout(rs.silenceTimer);
				rs.proc?.kill("SIGKILL");
			}
		} catch { /* best-effort */ }
		await new Promise((r) => setTimeout(r, 100));
		for (const f of [metaPath(child.sid), `/tmp/pi-subagent-${child.sid}.log`, `/tmp/pi-subagent-${child.sid}.sock`]) {
			try { if (existsSync(f)) unlinkSync(f); } catch { /* best-effort */ }
		}
	}
	for (const d of expectedDirs.splice(0)) rmSync(d, { recursive: true, force: true });
	for (const r of expectedRepos.splice(0)) {
		git(r, ["worktree", "prune"]);
		rmSync(r, { recursive: true, force: true });
	}
});

// ── Lock lifecycle ─────────────────────────────────────────────────────────

describe("worktree lock lifecycle (real git)", () => {
	it("locks after `worktree add`, refuses force-remove while the child lives, and removes after completion", async () => {
		const repo = makeRepo();
		const { sid } = await spawnIsolated(repo);

		const meta = readMetaJson(sid) as any;
		const worktreePath: string = meta.worktreePath;
		expect(typeof worktreePath).toBe("string");
		expect(existsSync(worktreePath)).toBe(true);

		// Locked: git records the lock, and a hand force-remove of the live
		// child's tree fails loudly.
		const entry = worktreeEntry(repo, worktreePath);
		expect(entry).not.toBeNull();
		expect(entry!).toContain("locked");
		expect(entry!).toContain(`pi-subagent ${sid}`);
		const forced = git(repo, ["worktree", "remove", "--force", worktreePath]);
		expect(forced.code).not.toBe(0);
		expect(forced.err).toContain("locked");
		expect(existsSync(worktreePath)).toBe(true);

		// Completion recorded → the harness's own cleanup unlocks and removes.
		writeFileSync(join(worktreePath, "standin-report.txt"), "**status:** complete\n");
		const removed = await waitFor(() => !existsSync(worktreePath), 20_000);
		expect(removed).toBe(true);
		// The registration is gone too (cleanup used `worktree remove`, not rmtree).
		expect(worktreeEntry(repo, worktreePath)).toBeNull();
	}, 40_000);

	it("a cleanup failure keeps the tree, re-locks it, and warns the parent", async () => {
		const repo = makeRepo();
		const steers: string[] = [];
		const { sid } = await spawnIsolated(repo, { steers });
		const worktreePath = (readMetaJson(sid) as any).worktreePath;
		expectedDirs.push(worktreePath);

		// Break the removal in a way git refuses before deregistering: remove the
		// worktree's own `.git` pointer, so `worktree remove --force` fails its
		// validation while the lock is still ours to restore. The uncommitted
		// bytes are what the failure branch must not destroy.
		unlinkSync(join(worktreePath, ".git"));
		writeFileSync(join(worktreePath, "uncommitted.txt"), "bytes\n");

		writeFileSync(join(worktreePath, "standin-report.txt"), "**status:** complete\n");
		expect(
			await waitFor(() => steers.some((m) => m.includes("worktree cleanup failed")), 20_000),
		).toBe(true);

		// No rmtree fallback: the tree and its uncommitted bytes survive.
		expect(existsSync(join(worktreePath, "uncommitted.txt"))).toBe(true);
		expect(readFileSync(join(worktreePath, "uncommitted.txt"), "utf8")).toBe("bytes\n");

		// Re-locked, so a hand reap still refuses instead of deleting the work.
		const entry = worktreeEntry(repo, worktreePath);
		expect(entry).not.toBeNull();
		expect(entry!).toContain("locked");
		expect(entry!).toContain("(cleanup failed)");
		const forced = git(repo, ["worktree", "remove", "--force", worktreePath]);
		expect(forced.code).not.toBe(0);
	}, 40_000);

	it("unlocks only after the completion is recorded (kill path cleans up, live tree stays locked)", async () => {
		const repo = makeRepo();
		const { sid, tools, ctx } = await spawnIsolated(repo);
		const worktreePath = (readMetaJson(sid) as any).worktreePath;

		// While the child lives the lock is in force.
		expect(worktreeEntry(repo, worktreePath)).toContain("locked");

		// A kill records the completion, so the harness may unlock and remove.
		await tools.get("subagent_kill").execute("tk", { session_id: sid }, undefined, undefined, ctx);
		await waitFor(() => !resolveRunningSession(sid), 10_000);
		expect(await waitFor(() => !existsSync(worktreePath), 10_000)).toBe(true);
		expect(worktreeEntry(repo, worktreePath)).toBeNull();
	}, 40_000);
});

// ── Reap ───────────────────────────────────────────────────────────────────

describe("reapFinishedWorktrees (real git, injected registry)", () => {
	/** A meta + log pair wired to a real locked worktree. */
	function makeEntry(
		repo: string,
		sid: string,
		opts: { logLastLine?: string; ownerPid?: number | null; ownerStartToken?: string | null; sessionFile?: string; dirty?: boolean },
	): { dir: string; worktreePath: string } {
		const worktreePath = join(tempDir("pi-reap-wt-"), "tree");
		const add = git(repo, ["worktree", "add", "-q", worktreePath, "-b", `pi-subagent-${sid}`]);
		if (add.code !== 0) throw new Error(`worktree add failed: ${add.err}`);
		git(repo, ["worktree", "lock", "--reason", `pi-subagent ${sid}`, worktreePath]);
		if (opts.dirty) writeFileSync(join(worktreePath, "uncommitted.txt"), "bytes\n");

		const dir = tempDir("pi-reap-registry-");
		writeMetaJson(sid, {
			agentName: "worker",
			task: "wait for the signal",
			worktreePath,
			isolationBranch: `pi-subagent-${sid}`,
			ownerPid: opts.ownerPid === undefined ? process.pid : opts.ownerPid,
			ownerStartToken: opts.ownerStartToken ?? null,
			sessionFile: opts.sessionFile,
		});
		// writeMetaJson writes to /tmp; relocate the fixture into the injected dir.
		const tmpMeta = metaPath(sid);
		writeFileSync(join(dir, `pi-subagent-${sid}.meta.json`), readFileSync(tmpMeta, "utf8"));
		unlinkSync(tmpMeta);
		writeFileSync(join(dir, `pi-subagent-${sid}.log`), opts.logLastLine ?? "── Turn 1 ──\nwork\n");
		return { dir, worktreePath };
	}

	it("removes a clean finished tree (unlock-then-remove, no --force)", async () => {
		const repo = makeRepo();
		const { dir, worktreePath } = makeEntry(repo, "clean-1", {
			logLastLine: "── Completed (3 turns, exit 0) ──\n",
		});

		const results = await reapFinishedWorktrees({} as any, {} as any, { dir, selfPid: process.pid });
		expect(results.map((r) => r.outcome)).toEqual(["removed"]);
		expect(existsSync(worktreePath)).toBe(false);
		expect(worktreeEntry(repo, worktreePath)).toBeNull();
	});

	it("keeps a finished tree with uncommitted work and marks it (meta)", async () => {
		const repo = makeRepo();
		const { dir, worktreePath } = makeEntry(repo, "dirty-1", {
			logLastLine: "── Exited (3 turns, exit 1) ──\n",
			dirty: true,
		});

		const results = await reapFinishedWorktrees({} as any, {} as any, { dir, selfPid: process.pid });
		expect(results.map((r) => r.outcome)).toEqual(["kept-uncommitted"]);
		expect(existsSync(join(worktreePath, "uncommitted.txt"))).toBe(true);
		const meta = JSON.parse(readFileSync(join(dir, "pi-subagent-dirty-1.meta.json"), "utf8"));
		expect(meta.worktreeKept.reason).toBe("uncommitted work");
	});

	it("leaves a tree whose child has no terminal footer (could still be running)", async () => {
		const repo = makeRepo();
		const { dir, worktreePath } = makeEntry(repo, "unfinished-1", { logLastLine: "── Turn 1 ──\nworking…\n" });

		const results = await reapFinishedWorktrees({} as any, {} as any, { dir, selfPid: process.pid });
		expect(results).toEqual([]);
		expect(existsSync(worktreePath)).toBe(true);
		expect(worktreeEntry(repo, worktreePath)).not.toBeNull();
	});

	it("skips a live foreign owner's tree and a legacy meta (027)", async () => {
		const repo = makeRepo();
		const foreign = makeEntry(repo, "foreign-1", {
			logLastLine: "── Completed (1 turns, exit 0) ──\n",
			ownerPid: process.pid === 1 ? 2 : process.ppid,
			ownerStartToken: "not-our-token",
		});
		// A legacy meta: no owner fields at all.
		const legacy = makeEntry(repo, "legacy-1", { logLastLine: "── Completed (1 turns, exit 0) ──\n", ownerPid: null });
		const legacyPath = join(legacy.dir, "pi-subagent-legacy-1.meta.json");
		const legacyMeta = JSON.parse(readFileSync(legacyPath, "utf8"));
		delete legacyMeta.ownerPid;
		delete legacyMeta.ownerStartToken;
		writeFileSync(legacyPath, JSON.stringify(legacyMeta));

		// Probe stub: every recorded pid is alive with an unknown token.
		const probe = { exists: () => true, startToken: () => null };

		const results = await reapFinishedWorktrees({} as any, {} as any, { dir: foreign.dir, selfPid: -1, probe });
		expect(results).toEqual([]);
		expect(existsSync(foreign.worktreePath)).toBe(true);
		expect(existsSync(legacy.worktreePath)).toBe(true);
	});

	it("does not touch a tree the running map still tracks", async () => {
		const repo = makeRepo();
		const { dir, worktreePath } = makeEntry(repo, "tracked-1", {
			logLastLine: "── Completed (1 turns, exit 0) ──\n",
		});
		const { _testRunning } = await import("../extensions/subagent-async/index.ts");
		_testRunning.set("tracked-1", { sessionId: "tracked-1" } as any);
		try {
			const results = await reapFinishedWorktrees({} as any, {} as any, { dir, selfPid: process.pid });
			expect(results).toEqual([]);
			expect(existsSync(worktreePath)).toBe(true);
		} finally {
			_testRunning.delete("tracked-1");
		}
	});

	it("re-locks a tree it could not remove (never leaves it unlocked)", async () => {
		const repo = makeRepo();
		// An initialized submodule makes `git worktree remove` refuse *at
		// validation* — registration intact, so the re-lock is observable — while
		// the reap's own cleanliness check still sees a clean tree.
		const sub = makeRepo();
		git(repo, ["-c", "protocol.file.allow=always", "submodule", "add", "-q", sub, "sub"]);
		git(repo, ["commit", "-q", "-m", "add submodule"]);

		const { dir, worktreePath } = makeEntry(repo, "submod-1", {
			logLastLine: "── Completed (1 turns, exit 0) ──\n",
		});
		git(worktreePath, ["-c", "protocol.file.allow=always", "submodule", "update", "--init", "-q"]);
		expect(git(worktreePath, ["status", "--porcelain", "-uall"]).out.trim()).toBe("");

		const results = await reapFinishedWorktrees({} as any, {} as any, { dir, selfPid: process.pid });
		expect(results.map((r) => r.outcome)).toEqual(["kept-remove-failed"]);
		expect(existsSync(worktreePath)).toBe(true);

		const entry = worktreeEntry(repo, worktreePath);
		expect(entry).not.toBeNull();
		expect(entry!).toContain("locked");
		expect(entry!).toContain("(reap failed)");
	});

	it("the real session_start handler runs the reap (wiring)", async () => {
		const repo = makeRepo();
		const { dir, worktreePath } = makeEntry(repo, "wiring-1", {
			logLastLine: "── Completed (1 turns, exit 0) ──\n",
		});

		// Register the extension for real and fire the captured handler: the reap
		// is fire-and-forget inside session_start, so the effect (not a return
		// value) is what proves the wiring. Dropping the call leaves the tree.
		const handlers = new Map<string, Function>();
		const pi: any = {
			events: { emit: () => {} },
			registerTool: () => {},
			registerCommand: () => {},
			on: (event: string, cb: Function) => handlers.set(event, cb),
			sendUserMessage: () => {},
			ui: { setStatus: () => {}, notify: () => {}, setWidget: () => {} },
		};
		subagentFactory(pi);
		_testSetRecoveryScanDir(dir);
		try {
			await handlers.get("session_start")!(
				{ type: "session_start", reason: "reload" },
				{ cwd: repo, sessionManager: { getSessionId: () => "sess-lock-wiring" }, ui: {} },
			);
			expect(await waitFor(() => !existsSync(worktreePath), 20_000)).toBe(true);
			expect(worktreeEntry(repo, worktreePath)).toBeNull();
		} finally {
			_testSetRecoveryScanDir(undefined);
		}
	});
});

describe("updateMetaJson keeps the reap marker (wiring)", () => {
	it("round-trips worktreeKept through the meta file", () => {
		writeMetaJson("marker-check", { ownerPid: process.pid });
		updateMetaJson("marker-check", { worktreeKept: { reason: "uncommitted work" } });
		expect((readMetaJson("marker-check") as any).worktreeKept.reason).toBe("uncommitted work");
		unlinkSync(metaPath("marker-check"));
	});
});
