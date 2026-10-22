#!/usr/bin/env node
/**
 * Regression test for the uncommitted-state carry into isolated worktrees.
 *
 * createWorktree (extensions/subagent-async/index.ts) now overlays the
 * parent's uncommitted working-tree state (untracked / modified / staged /
 * deleted / renamed / copied files) into the freshly-created worktree,
 * gated on `carryUncommitted && !baseRef`. The subagent therefore sees what
 * the orchestrator prepared instead of hitting ENOENT on first read.
 *
 * This test cannot import index.ts — `typebox` and `@earendil-works/*`
 * resolve only under jiti at runtime. So, following the test-subject.cjs
 * precedent, it mirrors the carry logic (porcelain parsing + copy/delete
 * decisions + the CarriedSnapshot capture used by the WO-2026-035 completion
 * filter) and exercises it end-to-end against REAL temp repos and REAL
 * `git worktree add`. Every row of the behavior/failure matrix is a case,
 * and the parser is pinned against real `git status --porcelain=v1 -uall -z`
 * output (including a rename `R  new\0old\0` and a copy `C  new\0old\0`).
 *
 * Run: node test-carry-uncommitted.cjs
 */
"use strict";

const assert = require("node:assert");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { execFileSync } = require("node:child_process");
const { createHash } = require("node:crypto");

// ── carryUncommittedState — KEEP IN SYNC with index.ts ────────────────────
// Mirror of the carry overlay in extensions/subagent-async/index.ts
// (carryUncommittedState + unsafeCarryPath + copyCarriedFile + hashCarriedFile).
// Same porcelain -z parsing, same copy/delete/rename/copy decisions, same path
// safety, same symlink-as-link and exec-bit handling. It now ALSO returns the
// CarriedSnapshot (per-path sha256 hash / `"link:" + target` / `absent`) that
// preCommitSteps' completion filter compares against — the filter itself is
// mirrored by test-completion-filter.cjs. When changing one side, change the
// other. Both are pinned below against real `git status` output.
function unsafeCarryPath(p) {
	return p.length === 0 || p.includes("..") || p === ".git" || p.startsWith(".git/");
}

// ── hashCarriedFile — KEEP IN SYNC with index.ts ──────────────────────────
// sha256 hex of a file's bytes, `"link:" + target` for a symlink, null when
// absent / not a regular file or symlink. Single source of truth for the
// snapshot hashes (capture here, compare in test-completion-filter.cjs).
async function hashCarriedFile(absPath) {
	try {
		const st = await fs.promises.lstat(absPath);
		if (st.isSymbolicLink()) return "link:" + (await fs.promises.readlink(absPath));
		if (!st.isFile()) return null;
		return createHash("sha256").update(await fs.promises.readFile(absPath)).digest("hex");
	} catch {
		return null;
	}
}

async function recordPresent(snapshot, worktreePath, rel) {
	const hash = await hashCarriedFile(path.join(worktreePath, rel));
	if (hash !== null) snapshot.set(rel, { state: "present", hash });
}

async function copyCarriedFile(topLevel, worktreePath, rel) {
	const src = path.join(topLevel, rel);
	const dst = path.join(worktreePath, rel);
	await fs.promises.mkdir(path.dirname(dst), { recursive: true });
	const st = await fs.promises.lstat(src);
	if (st.isSymbolicLink()) {
		await fs.promises.symlink(await fs.promises.readlink(src), dst);
	} else if (st.isDirectory()) {
		return; // gitlink/submodule — known limitation, not carried
	} else {
		await fs.promises.copyFile(src, dst);
		await fs.promises.chmod(dst, st.mode & 0o7777);
	}
}

// ── carryUncommittedState — KEEP IN SYNC with index.ts ────────────────────
// Mirror of the carry overlay in extensions/subagent-async/index.ts
// (carryUncommittedState + unsafeCarryPath + copyCarriedFile + hashCarriedFile).
// Same porcelain -z parsing, same copy/delete/rename/copy decisions, same path
// safety, same symlink-as-link and exec-bit handling. It now ALSO returns the
// CarriedSnapshot (per-path sha256 hash / `"link:" + target` / `absent`) that
// preCommitSteps' completion filter compares against — the filter itself is
// mirrored by test-completion-filter.cjs. When changing one side, change the
// other. Both are pinned below against real `git status` output.
//
// WIRING HAZARD (do not "simplify"): index.ts's createWorktree destructures the
// git() result OBJECT and must extract the path string via .stdout.trim()
// before calling carryUncommittedState. Passing the object instead of the
// string makes the overlay silently no-op in production (spawn cwd invalid →
// best-effort catch). The fail-fast typeof guard below exists on BOTH sides;
// matrix row 1 pins the end-to-end wiring through createWorktreeMirror, and
// row 21 pins the guard itself.
function unsafeCarryPath(p) {
	return p.length === 0 || p.includes("..") || p === ".git" || p.startsWith(".git/");
}

// ── carryUncommittedState entry — KEEP IN SYNC with index.ts ──────────────
// The mirror receives the extracted path STRING from createWorktreeMirror,
// exactly like production. A non-string (e.g. the git result object) throws,
// matching the production fail-fast guard.
function assertTopLevelString(topLevel) {
	if (typeof topLevel !== "string" || topLevel.length === 0) {
		throw new TypeError("carryUncommittedState: topLevel must be the repo path string");
	}
}

// ── gitStatusPorcelain — mirror of the git() status call ──────────────────
// Mirror of index.ts's `git()` result shape for the carry status: never
// rejects — resolves with exitCode 1 when `git status` fails. Used as the
// default fetch inside carryUncommittedState and as the prefetched
// statusPromise from createWorktreeMirror (A2).
async function gitStatusPorcelain(topLevel) {
	try {
		const out = execFileSync("git", ["status", "--porcelain=v1", "-uall", "-z"], {
			cwd: topLevel,
			encoding: "utf8",
		});
		return { stdout: out, stderr: "", exitCode: 0 };
	} catch (e) {
		return { stdout: "", stderr: String(e && e.stderr ? e.stderr : ""), exitCode: 1 };
	}
}

async function carryUncommittedState(topLevel, worktreePath, statusPromise) {
	assertTopLevelString(topLevel);
	const snapshot = new Map();
	const res = await (statusPromise ?? gitStatusPorcelain(topLevel));
	if (res.exitCode !== 0) return snapshot; // git status failed — empty snapshot, mirror of index.ts
	const tokens = res.stdout.split("\0");
	for (let i = 0; i < tokens.length; i++) {
		const rec = tokens[i];
		if (rec.length === 0) continue;
		const x = rec[0];
		const y = rec[1];
		const p = rec.slice(3);
		if (unsafeCarryPath(p)) continue;

		if (x === "R" || x === "C") {
			// Rename/copy: the record path is the NEW path; the next NUL
			// token holds the ORIGINAL path.
			const orig = tokens[i + 1] ?? "";
			i++;
			if (unsafeCarryPath(orig)) continue;
			if (x === "R") {
				fs.rmSync(path.join(worktreePath, orig), { recursive: true, force: true });
				snapshot.set(orig, { state: "absent" });
			}
			await copyCarriedFile(topLevel, worktreePath, p);
			await recordPresent(snapshot, worktreePath, p);
			continue;
		}
		if (x === "D" || y === "D") {
			fs.rmSync(path.join(worktreePath, p), { recursive: true, force: true });
			snapshot.set(p, { state: "absent" });
			continue;
		}
		if (x === "?" && y === "?") {
			await copyCarriedFile(topLevel, worktreePath, p);
			await recordPresent(snapshot, worktreePath, p);
			continue;
		}
		if (["M", "A", "T", "U"].includes(x) || ["M", "A", "T", "U"].includes(y)) {
			if (fs.existsSync(path.join(topLevel, p))) {
				await copyCarriedFile(topLevel, worktreePath, p);
				await recordPresent(snapshot, worktreePath, p);
			}
		}
	}
	return snapshot;
}

// ── createWorktree mirror — control flow only ──────────────────────────────
// Instrumented git runner for createWorktreeMirror's control flow. Records the
// argv of every git subprocess the mirror issues so tests can assert on A1's
// guarded cleanup (matrix cases 1/2). Production uses index.ts's git().
const gitCallLog = [];
function gitSync(args, opts) {
	gitCallLog.push(args.join(" "));
	return execFileSync("git", args, opts);
}

// Mirrors createWorktree's git/fs flow: rev-parse toplevel + base ref, stale
// cleanup, `git worktree add`, then the optional carry. The pieces under test
// here are the overlay gate (`carryUncommitted && !baseRef`) and the
// best-effort catch — a carry failure must never fail the dispatch, while a
// `worktree add` failure must (returns null). Also returns the carried
// CarriedSnapshot (present — possibly empty — when the overlay ran, absent
// when skipped or when the overlay threw).
//
// WIRING: production destructures the git() RESULT OBJECT and extracts the
// path string via .stdout.trim(); this mirror does the same with the
// execFileSync stdout string (which is already the raw path). The extract-
// then-pass-string shape is what row 1 exercises end-to-end; row 21 pins the
// fail-fast guard that makes an object-wiring regression loud instead of
// silent.
async function createWorktreeMirror(parentCwd, sessionId, baseRef, carryUncommitted = true) {
	let topLevel;
	try {
		topLevel = gitSync(["rev-parse", "--show-toplevel"], {
			cwd: parentCwd,
			encoding: "utf8",
			stdio: ["ignore", "pipe", "ignore"],
		}).trim();
	} catch {
		return null; // not a git repo
	}
	const baseCommitRef = baseRef || "HEAD";
	let headCommit;
	try {
		headCommit = gitSync(["rev-parse", baseCommitRef], {
			cwd: parentCwd,
			encoding: "utf8",
			stdio: ["ignore", "pipe", "ignore"],
		}).trim();
	} catch {
		return null;
	}
	const suffix = String(sessionId).slice(-12);
	const branchName = `pi-subagent-${suffix}`;
	const worktreePath = path.join(os.tmpdir(), `pi-subagent-wt-${suffix}`);

	const quiet = { cwd: parentCwd, stdio: "ignore" };
	// Mirror of A1: the session id is fresh per spawn, so the stale dir normally
	// does not exist; skip both cleanup subprocesses when it does not.
	if (fs.existsSync(worktreePath)) {
		// Unlock before the force-remove: a leftover carries OUR session id, so
		// the lock (R3-2) is ours to drop — and git refuses force-remove of a
		// locked tree.
		try { gitSync(["worktree", "unlock", worktreePath], quiet); } catch { /* */ }
		try { gitSync(["worktree", "remove", "--force", worktreePath], quiet); } catch { /* */ }
		try { gitSync(["branch", "-D", branchName], quiet); } catch { /* */ }
	}
	// Mirror of A2: prefetch the carry status before `worktree add`. git()
	// never rejects, so an unconsumed prefetch cannot become an unhandled
	// rejection.
	const carryStatusPromise = carryUncommitted && !baseRef ? gitStatusPorcelain(topLevel) : undefined;
	try {
		gitSync(["worktree", "add", worktreePath, "-b", branchName, headCommit], quiet);
	} catch {
		return null; // worktree add failure is fatal, like the real code
	}
	// R3-2 lock, immediately after `worktree add`. The full lock/unlock/reap
	// matrix lives in test-worktree-lock.cjs; here it exists so the teardown
	// below mirrors the real cleanup's unlock-then-remove.
	try { gitSync(["worktree", "lock", "--reason", `pi-subagent ${sessionId}`, worktreePath], quiet); } catch { /* */ }
	let carried;
	if (carryUncommitted && !baseRef) {
		try {
			carried = await carryUncommittedState(topLevel, worktreePath, carryStatusPromise);
		} catch {
			// best-effort: degrade to HEAD-only, never fail the dispatch
		}
	}
	return {
		worktreePath,
		branchName,
		parentHeadCommit: headCommit,
		...(carried !== undefined ? { carried } : {}),
	};
}

// ── Test harness ───────────────────────────────────────────────────────────
let passed = 0;
let failed = 0;
let skipped = 0;
const registeredTests = [];

// Tests register here and run sequentially in the async runner at the bottom
// (top-level await is unavailable in CJS, and the carry I/O is now async).
function test(name, fn) {
	registeredTests.push({ name, fn });
}

async function runTests() {
	for (const { name, fn } of registeredTests) {
		try {
			await fn();
			console.log(`  ✅ ${name}`);
			passed++;
		} catch (e) {
			if (e && e.__piSkip) {
				console.log(`  ⏭  ${name} (skipped: ${e.message})`);
				skipped++;
				continue;
			}
			console.log(`  ❌ ${name}`);
			console.log(`     ${e.message}`);
			failed++;
		}
	}
}

function skip(msg) {
	const e = new Error(msg);
	e.__piSkip = true;
	throw e;
}

function eq(actual, expected, msg) {
	assert.strictEqual(actual, expected, msg);
}

let nextId = 0;
function newSessionId() {
	return `test-${Date.now().toString(36)}-${nextId++}`;
}

function initRepo(dir) {
	execFileSync("git", ["init", "-q"], { cwd: dir });
	execFileSync("git", ["config", "user.email", "t@t"], { cwd: dir });
	execFileSync("git", ["config", "user.name", "t"], { cwd: dir });
}

function git(dir, args) {
	return execFileSync("git", args, { cwd: dir, encoding: "utf8" });
}

function cleanupWorktree(parentDir, result) {
	if (!result) return;
	try { execFileSync("git", ["worktree", "unlock", result.worktreePath], { cwd: parentDir, stdio: "ignore" }); } catch { /* */ }
	try { execFileSync("git", ["worktree", "remove", "--force", result.worktreePath], { cwd: parentDir, stdio: "ignore" }); } catch { /* */ }
	try { fs.rmSync(result.worktreePath, { recursive: true, force: true }); } catch { /* */ }
	try { execFileSync("git", ["branch", "-D", result.branchName], { cwd: parentDir, stdio: "ignore" }); } catch { /* */ }
}

// Real temp repo + real `git worktree add`, then the mirror carry, then the
// assertion. baselineFn writes the tracked file set (committed); setupFn
// creates the uncommitted state (and may stage/commit further).
async function withCarryFlow(opts, baselineFn, setupFn, assertFn) {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-carry-repo-"));
	let result = null;
	try {
		initRepo(dir);
		baselineFn(dir);
		git(dir, ["add", "-A"]);
		git(dir, ["commit", "-q", "-m", "baseline"]);
		setupFn(dir, git);
		result = await createWorktreeMirror(dir, newSessionId(), opts.baseRef, opts.carryUncommitted ?? true);
		await assertFn(result, dir, git);
	} finally {
		cleanupWorktree(dir, result);
		try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* */ }
	}
}

const defaultBaseline = (dir) => {
	fs.writeFileSync(path.join(dir, "baseline.txt"), "baseline\n");
};

// ── Behavior / failure matrix ──────────────────────────────────────────────

test("1. untracked file (`?? docs/plans/foo.md`) is carried", async () => {
	await withCarryFlow({}, defaultBaseline, (dir) => {
		fs.mkdirSync(path.join(dir, "docs", "plans"), { recursive: true });
		fs.writeFileSync(path.join(dir, "docs", "plans", "foo.md"), "# plan\n");
		// space-in-path pin: the porcelain `XY ` separator must not eat a
		// leading space of the path, and the path itself survives verbatim.
		fs.writeFileSync(path.join(dir, "docs", "plans", "with space.md"), "spaced\n");
	}, (result) => {
		const wt = result.worktreePath;
		const carried = path.join(wt, "docs", "plans", "foo.md");
		assert.ok(fs.existsSync(carried), "untracked file present in worktree");
		eq(fs.readFileSync(carried, "utf8"), "# plan\n");
		eq(fs.readFileSync(path.join(wt, "docs", "plans", "with space.md"), "utf8"), "spaced\n", "path with spaces survives verbatim");
	});
});

test("2. modified tracked file (` M`) is carried with parent bytes", async () => {
	await withCarryFlow({}, defaultBaseline, (dir) => {
		fs.writeFileSync(path.join(dir, "baseline.txt"), "modified\n");
	}, (result) => {
		const f = path.join(result.worktreePath, "baseline.txt");
		assert.ok(fs.existsSync(f));
		eq(fs.readFileSync(f, "utf8"), "modified\n", "parent worktree bytes win over HEAD");
	});
});

test("3. staged-added file (`A `) is carried", async () => {
	await withCarryFlow({}, defaultBaseline, (dir, git) => {
		fs.writeFileSync(path.join(dir, "staged-new.txt"), "new\n");
		git(dir, ["add", "staged-new.txt"]);
	}, (result) => {
		eq(fs.readFileSync(path.join(result.worktreePath, "staged-new.txt"), "utf8"), "new\n");
	});
});

test("4. staged+worktree modified (`MM`) — parent worktree bytes win", async () => {
	await withCarryFlow({}, (dir) => {
		fs.writeFileSync(path.join(dir, "mm.txt"), "v1\n");
	}, (dir, git) => {
		fs.writeFileSync(path.join(dir, "mm.txt"), "v2\n");
		git(dir, ["add", "mm.txt"]);
		fs.writeFileSync(path.join(dir, "mm.txt"), "v3\n");
		const out = git(dir, ["status", "--porcelain=v1", "-uall", "-z"]);
		assert.ok(out.startsWith("MM "), `expected an MM record, got: ${JSON.stringify(out.split("\0"))}`);
	}, (result) => {
		eq(fs.readFileSync(path.join(result.worktreePath, "mm.txt"), "utf8"), "v3\n");
	});
});

test("5. deleted in worktree (` D`) — file absent from worktree", async () => {
	await withCarryFlow({}, (dir) => {
		fs.writeFileSync(path.join(dir, "gone-wt.txt"), "x\n");
	}, (dir) => {
		fs.rmSync(path.join(dir, "gone-wt.txt"));
	}, (result) => {
		assert.ok(!fs.existsSync(path.join(result.worktreePath, "gone-wt.txt")), "deleted file absent");
	});
});

test("6. staged deletion (`D `) — file absent from worktree", async () => {
	await withCarryFlow({}, (dir) => {
		fs.writeFileSync(path.join(dir, "gone-staged.txt"), "x\n");
	}, (dir, git) => {
		git(dir, ["rm", "-q", "gone-staged.txt"]);
	}, (result) => {
		assert.ok(!fs.existsSync(path.join(result.worktreePath, "gone-staged.txt")), "deleted file absent");
	});
});

test("7. rename (`R  new\0old\0`) — old removed, new present with parent bytes", async () => {
	await withCarryFlow({}, (dir) => {
		fs.writeFileSync(path.join(dir, "oldname.txt"), "old content\n");
	}, (dir, git) => {
		git(dir, ["mv", "oldname.txt", "newname.txt"]);
		// pin the rename record shape against real git output
		const tokens = git(dir, ["status", "--porcelain=v1", "-uall", "-z"]).split("\0");
		const ri = tokens.findIndex((t) => t.startsWith("R "));
		assert.ok(ri !== -1, `expected a rename record, got: ${JSON.stringify(tokens)}`);
		eq(tokens[ri + 1], "oldname.txt", "rename original path is the next NUL token");
	}, (result) => {
		const wt = result.worktreePath;
		assert.ok(!fs.existsSync(path.join(wt, "oldname.txt")), "old path removed");
		eq(fs.readFileSync(path.join(wt, "newname.txt"), "utf8"), "old content\n");
	});
});

test("8. copy (`C  new\0old\0`, status.renames=copies) — new present", async () => {
	await withCarryFlow({}, (dir) => {
		fs.writeFileSync(path.join(dir, "orig.txt"), "hello\n");
	}, (dir, git) => {
		// Copy detection in `git status` only fires when the source is also
		// modified and status.renames is set to "copies" — and this is a
		// per-repo config, so the plain carry command emits the C record.
		fs.writeFileSync(path.join(dir, "orig.txt"), "hello modified\n");
		fs.writeFileSync(path.join(dir, "newcopy.txt"), "hello\n");
		git(dir, ["add", "-A"]);
		git(dir, ["config", "status.renames", "copies"]);
		const tokens = git(dir, ["status", "--porcelain=v1", "-uall", "-z"]).split("\0");
		const ci = tokens.findIndex((t) => t.startsWith("C "));
		assert.ok(ci !== -1, `expected a copy record, got: ${JSON.stringify(tokens)}`);
		eq(tokens[ci + 1], "orig.txt", "copy original path is the next NUL token");
	}, (result) => {
		const wt = result.worktreePath;
		eq(fs.readFileSync(path.join(wt, "newcopy.txt"), "utf8"), "hello\n", "copy carried");
		eq(fs.readFileSync(path.join(wt, "orig.txt"), "utf8"), "hello modified\n", "modified source also carried");
	});
});

test("9. .gitignore-matched file — NOT carried", async () => {
	await withCarryFlow({}, defaultBaseline, (dir, git) => {
		fs.writeFileSync(path.join(dir, ".gitignore"), "ignored.log\n");
		fs.writeFileSync(path.join(dir, "ignored.log"), "ignored\n");
		const out = git(dir, ["status", "--porcelain=v1", "-uall", "-z"]);
		assert.ok(!out.includes("ignored.log"), "ignored file absent from status");
	}, (result) => {
		assert.ok(!fs.existsSync(path.join(result.worktreePath, "ignored.log")), "ignored file not carried");
	});
});

test("10. exec-bit file — mode preserved in worktree", async () => {
	await withCarryFlow({}, defaultBaseline, (dir) => {
		fs.writeFileSync(path.join(dir, "run.sh"), "#!/bin/sh\necho hi\n");
		fs.chmodSync(path.join(dir, "run.sh"), 0o755);
	}, (result, dir) => {
		const wtMode = fs.statSync(path.join(result.worktreePath, "run.sh")).mode & 0o777;
		const srcMode = fs.statSync(path.join(dir, "run.sh")).mode & 0o777;
		eq(wtMode, srcMode, "exec bit preserved (carried mode matches parent)");
		eq(wtMode, 0o755);
	});
});

test("11. symlink — carried as link, same target string, not dereferenced", async () => {
	await withCarryFlow({}, defaultBaseline, (dir) => {
		fs.symlinkSync("baseline.txt", path.join(dir, "newlink"));
	}, (result, dir) => {
		const wtLink = path.join(result.worktreePath, "newlink");
		const st = fs.lstatSync(wtLink);
		assert.ok(st.isSymbolicLink(), "carried as a symlink, not a regular file");
		eq(fs.readlinkSync(wtLink), fs.readlinkSync(path.join(dir, "newlink")), "identical target string");
		eq(fs.readlinkSync(wtLink), "baseline.txt");
	});
});

test("12. path containing `..` — rejected, no escape", async () => {
	await withCarryFlow({}, defaultBaseline, (dir, git) => {
		fs.writeFileSync(path.join(dir, "a..b"), "dotdot\n");
		const out = git(dir, ["status", "--porcelain=v1", "-uall", "-z"]);
		assert.ok(out.includes("?? a..b"), "real status lists the ..-containing path");
	}, (result) => {
		assert.ok(!fs.existsSync(path.join(result.worktreePath, "a..b")), "unsafe path skipped");
	});
});

test("13. carryUncommitted: false — no overlay, worktree still created", async () => {
	await withCarryFlow({ carryUncommitted: false }, defaultBaseline, (dir) => {
		fs.writeFileSync(path.join(dir, "untracked.txt"), "x\n");
	}, (result) => {
		assert.ok(result, "worktree created");
		assert.ok(!fs.existsSync(path.join(result.worktreePath, "untracked.txt")), "no carry");
		eq(fs.readFileSync(path.join(result.worktreePath, "baseline.txt"), "utf8"), "baseline\n");
	});
});

test("14. baseRef set — no overlay even with carry default true", async () => {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-carry-repo-"));
	let result = null;
	try {
		initRepo(dir);
		fs.writeFileSync(path.join(dir, "baseline.txt"), "baseline\n");
		git(dir, ["add", "-A"]);
		git(dir, ["commit", "-q", "-m", "base1"]);
		const base1 = git(dir, ["rev-parse", "HEAD"]).trim();
		fs.writeFileSync(path.join(dir, "second.txt"), "second\n");
		git(dir, ["add", "-A"]);
		git(dir, ["commit", "-q", "-m", "base2"]);
		fs.writeFileSync(path.join(dir, "third.txt"), "third\n");
		fs.writeFileSync(path.join(dir, "baseline.txt"), "modified\n");

		result = await createWorktreeMirror(dir, newSessionId(), base1, true);
		assert.ok(result, "worktree created");
		const wt = result.worktreePath;
		eq(git(wt, ["rev-parse", "HEAD"]).trim(), base1, "branches from baseRef tree, not HEAD");
		eq(fs.readFileSync(path.join(wt, "baseline.txt"), "utf8"), "baseline\n", "baseRef tree content, no carry");
		assert.ok(!fs.existsSync(path.join(wt, "second.txt")), "base1 tree, not HEAD");
		assert.ok(!fs.existsSync(path.join(wt, "third.txt")), "no carry of uncommitted state");
	} finally {
		cleanupWorktree(dir, result);
		try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* */ }
	}
});

test("15. clean tree — no-op; worktree add still succeeds", async () => {
	await withCarryFlow({}, defaultBaseline, () => { /* no uncommitted state */ }, (result) => {
		assert.ok(result, "worktree created");
		const entries = fs.readdirSync(result.worktreePath).filter((e) => e !== ".git").sort();
		assert.deepStrictEqual(entries, ["baseline.txt"], "only the tracked baseline file");
		eq(fs.readFileSync(path.join(result.worktreePath, "baseline.txt"), "utf8"), "baseline\n");
	});
});

test("16. nested new dirs (`-uall` untracked in subdir) — parent dirs created", async () => {
	await withCarryFlow({}, defaultBaseline, (dir) => {
		fs.mkdirSync(path.join(dir, "a", "b", "c"), { recursive: true });
		fs.writeFileSync(path.join(dir, "a", "b", "c", "deep.txt"), "deep\n");
	}, (result) => {
		const f = path.join(result.worktreePath, "a", "b", "c", "deep.txt");
		assert.ok(fs.existsSync(f), "nested file carried");
		eq(fs.readFileSync(f, "utf8"), "deep\n");
	});
});

test("17. carry failure (source unreadable) — dispatch continues, no throw", async () => {
	const isRoot = typeof process.getuid === "function" && process.getuid() === 0;
	if (isRoot) {
		// chmod 000 does not make a file unreadable to root, so the failure
		// cannot be simulated; count it as skipped rather than passed.
		skip("running as root — chmod 000 does not make a file unreadable");
	}
	await withCarryFlow({}, defaultBaseline, (dir) => {
		fs.writeFileSync(path.join(dir, "locked.txt"), "secret\n");
		fs.chmodSync(path.join(dir, "locked.txt"), 0o000);
	}, (result) => {
		assert.ok(result, "dispatch continues: worktree still returned, carry skipped");
		assert.ok(fs.existsSync(result.worktreePath), "worktree exists");
		assert.ok(!fs.existsSync(path.join(result.worktreePath, "locked.txt")), "carry skipped on failure");
	});
});

test("18. non-git cwd — createWorktree returns null", async () => {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-carry-nongit-"));
	try {
		const result = await createWorktreeMirror(dir, newSessionId(), undefined, true);
		eq(result, null, "not a git repo → null");
	} finally {
		try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* */ }
	}
});

test("19. carried snapshot — present hashes, absent deletions, link-prefixed symlinks", async () => {
	await withCarryFlow({}, (dir) => {
		fs.writeFileSync(path.join(dir, "baseline.txt"), "baseline\n");
		fs.writeFileSync(path.join(dir, "gone-wt.txt"), "x\n");
	}, (dir) => {
		// Mixed uncommitted state: modified file, deleted file, untracked
		// symlink, untracked file. Each must land in the snapshot correctly.
		fs.writeFileSync(path.join(dir, "baseline.txt"), "modified\n");
		fs.rmSync(path.join(dir, "gone-wt.txt"));
		fs.symlinkSync("baseline.txt", path.join(dir, "newlink"));
		fs.writeFileSync(path.join(dir, "untracked.txt"), "u\n");
	}, async (result) => {
		const snap = result.carried;
		assert.ok(snap instanceof Map, "snapshot is a Map");
		const h1 = snap.get("baseline.txt");
		assert.ok(h1 && h1.state === "present", "modified file recorded as present");
		eq(h1.hash, createHash("sha256").update("modified\n").digest("hex"), "hash = sha256 of the carried bytes (independent literal)");
		eq(h1.hash, await hashCarriedFile(path.join(result.worktreePath, "baseline.txt")), "stable across reads");
		const del = snap.get("gone-wt.txt");
		assert.deepStrictEqual(del, { state: "absent" }, "deletion recorded as absent");
		const link = snap.get("newlink");
		assert.ok(link && link.state === "present", "symlink recorded as present");
		eq(link.hash, "link:baseline.txt", "symlink hash is the link prefix + target");
		const unt = snap.get("untracked.txt");
		assert.ok(unt && unt.state === "present", "untracked file recorded as present");
		eq(snap.size, 4, "exactly the four carried paths, nothing else");
	});
});

test("20. clean tree — snapshot is a present empty map", async () => {
	await withCarryFlow({}, defaultBaseline, () => { /* no uncommitted state */ }, (result) => {
		assert.ok(result.carried instanceof Map, "snapshot present even with no changes");
		eq(result.carried.size, 0, "empty map for a clean tree");
	});
});

test("21. wiring regression — carryUncommittedState rejects a non-string topLevel (git result object)", async () => {
	// WO-2026-034 production bug: createWorktree passed the git() RESULT
	// OBJECT as topLevel → spawn cwd invalid → best-effort catch → carry
	// silently never ran. The fail-fast guard (index.ts + this mirror) makes
	// that loud. Pinning both sides.
	const obj = { stdout: "/some/repo\n", stderr: "", exitCode: 0 };
	await assert.rejects(
		() => carryUncommittedState(obj, "/tmp/pi-subagent-wt-wiringpin"),
		/\btopLevel must be the repo path string\b/,
		"non-string topLevel must reject with the fail-fast TypeError",
	);
	// The extracted path STRING must be accepted.
	await assert.doesNotReject(
		() => carryUncommittedState("/nonexistent-repo-path", "/tmp/pi-subagent-wt-wiringpin"),
		"string topLevel must not trigger the guard",
	);
});

test("22. fresh spawn, no stale dir — A1 cleanup subprocesses skipped", async () => {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-carry-fresh-"));
	let result = null;
	try {
		initRepo(dir);
		fs.writeFileSync(path.join(dir, "baseline.txt"), "baseline\n");
		git(dir, ["add", "-A"]);
		git(dir, ["commit", "-q", "-m", "baseline"]);
		gitCallLog.length = 0;
		result = await createWorktreeMirror(dir, newSessionId(), undefined, false);
		assert.ok(result, "fresh worktree created");
		const cleanupCalls = gitCallLog.filter((c) => c.startsWith("worktree remove") || c.startsWith("branch -D"));
		eq(cleanupCalls.length, 0, `no cleanup subprocesses on a fresh spawn (log: ${JSON.stringify(gitCallLog)})`);
	} finally {
		cleanupWorktree(dir, result);
		try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* */ }
	}
});

test("23. stale dir exists — A1 runs both cleanups, then worktree add still succeeds", async () => {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-carry-stale-"));
	let result = null;
	let stalePath = null;
	try {
		initRepo(dir);
		fs.writeFileSync(path.join(dir, "baseline.txt"), "baseline\n");
		git(dir, ["add", "-A"]);
		git(dir, ["commit", "-q", "-m", "baseline"]);
		const sessionId = newSessionId();
		const suffix = String(sessionId).slice(-12);
		stalePath = path.join(os.tmpdir(), `pi-subagent-wt-${suffix}`);
		const branchName = `pi-subagent-${suffix}`;
		// A real stale worktree + branch: the cleanups must actually succeed for
		// `git worktree add` at the same path to proceed below.
		execFileSync("git", ["worktree", "add", stalePath, "-b", branchName, "HEAD"], {
			cwd: dir,
			stdio: "ignore",
		});
		gitCallLog.length = 0;
		result = await createWorktreeMirror(dir, sessionId, undefined, false);
		assert.ok(result, "worktree add still succeeds after the stale cleanup");
		const removeCalls = gitCallLog.filter((c) => c.startsWith("worktree remove --force"));
		const branchCalls = gitCallLog.filter((c) => c.startsWith("branch -D"));
		eq(removeCalls.length, 1, "stale worktree remove attempted");
		eq(branchCalls.length, 1, "stale branch -D attempted");
	} finally {
		cleanupWorktree(dir, result);
		if (stalePath) { try { fs.rmSync(stalePath, { recursive: true, force: true }); } catch { /* */ } }
		try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* */ }
	}
});

test("24. carry status failure (exitCode 1) — empty snapshot, no overlay", async () => {
	const top = fs.mkdtempSync(path.join(os.tmpdir(), "pi-carry-statusfail-"));
	const wt = fs.mkdtempSync(path.join(os.tmpdir(), "pi-carry-statusfail-wt-"));
	try {
		initRepo(top);
		fs.writeFileSync(path.join(top, "untracked.txt"), "x\n");
		const snap = await carryUncommittedState(
			top,
			wt,
			Promise.resolve({ stdout: "", stderr: "boom", exitCode: 1 }),
		);
		assert.ok(snap instanceof Map, "snapshot is a Map");
		eq(snap.size, 0, "status failure yields an empty snapshot");
		assert.ok(!fs.existsSync(path.join(wt, "untracked.txt")), "no overlay applied on status failure");
	} finally {
		try { fs.rmSync(top, { recursive: true, force: true }); } catch { /* */ }
		try { fs.rmSync(wt, { recursive: true, force: true }); } catch { /* */ }
	}
});

test("25. prefetched statusPromise is consumed — canned success drives the overlay", async () => {
	// A2: createWorktree prefetches `git status` and hands the promise to
	// carryUncommittedState. Were the third argument ignored, the real status
	// (empty here — secret.txt is gitignored) would be used and the overlay
	// would not run. A populated snapshot proves the prefetch is consumed.
	const top = fs.mkdtempSync(path.join(os.tmpdir(), "pi-carry-prefetch-"));
	const wt = fs.mkdtempSync(path.join(os.tmpdir(), "pi-carry-prefetch-wt-"));
	try {
		initRepo(top);
		fs.writeFileSync(path.join(top, ".gitignore"), "secret.txt\n");
		fs.writeFileSync(path.join(top, "secret.txt"), "canned\n");
		const snap = await carryUncommittedState(
			top,
			wt,
			Promise.resolve({ stdout: "?? secret.txt\0", stderr: "", exitCode: 0 }),
		);
		assert.ok(snap.has("secret.txt"), "canned prefetch status drove the overlay");
		eq(fs.readFileSync(path.join(wt, "secret.txt"), "utf8"), "canned\n", "canned file copied into the worktree");
	} finally {
		try { fs.rmSync(top, { recursive: true, force: true }); } catch { /* */ }
		try { fs.rmSync(wt, { recursive: true, force: true }); } catch { /* */ }
	}
});

// ── Result ─────────────────────────────────────────────────────────────────
runTests().then(() => {
	console.log(`\n${passed} passed, ${failed} failed${skipped ? `, ${skipped} skipped` : ""}`);
	process.exit(failed === 0 ? 0 : 1);
});
