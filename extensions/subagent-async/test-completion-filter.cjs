#!/usr/bin/env node
/**
 * Regression test for the completion-time carry filter (WO-2026-035).
 *
 * preCommitSteps (extensions/subagent-async/index.ts) now skips auto-
 * committing carried files whose worktree bytes still match the carried-in
 * snapshot: a subagent that only READ the orchestrator's uncommitted doc
 * produces no branch commit (branch stays at parent HEAD, postDeliveryCleanup
 * deletes it). The filter runs AFTER the WO-*.md unstage block and BEFORE the
 * `git diff --cached --quiet` check; `git reset -q -- <rel>` restores each
 * untouched path's index entry to HEAD (so carried deletions stay present on
 * the branch); any failure inside the loop degrades via debugLog, never
 * aborting preCommitSteps. The snapshot lives in-memory only (rs.carried,
 * default null) — no persistence.
 *
 * This test cannot import index.ts — `typebox` and `@earendil-works/*`
 * resolve only under jiti at runtime. Following test-carry-uncommitted.cjs,
 * it mirrors the hash helper + filter (KEEP IN SYNC) and exercises the full
 * preCommitSteps sequence against REAL temp repos, REAL `git worktree add`,
 * REAL `git add -A` / `git reset` / `git diff --cached`. The matrix below
 * below pins every filter behavior from the WO.
 *
 * Run: node test-completion-filter.cjs
 */
"use strict";

const assert = require("node:assert");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { execFileSync } = require("node:child_process");
const { createHash } = require("node:crypto");

// ── hashCarriedFile — KEEP IN SYNC with index.ts ──────────────────────────
// Single source of truth for carry-snapshot hashes: sha256 hex of a file's
// bytes, `"link:" + target` for a symlink, null when absent / not a regular
// file or symlink. Used by both carryUncommittedState (capture) and
// applyCarryFilter (compare) below, exactly as in index.ts.
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

// ── carryUncommittedState — KEEP IN SYNC with index.ts ────────────────────
// Mirror of the carry overlay + CarriedSnapshot capture in
// extensions/subagent-async/index.ts (carryUncommittedState + unsafeCarryPath
// + copyCarriedFile + hashCarriedFile). Same porcelain -z parsing, same
// copy/delete/rename/copy decisions, same path safety, same symlink-as-link
// and exec-bit handling — and now also records per-path snapshot entries:
// present (sha256 of the exact bytes written into the worktree), absent for
// carried deletions, nothing for skipped `.git`/unsafe paths. Returns a Map,
// never null (empty map when `git status` fails).
function unsafeCarryPath(p) {
	return p.length === 0 || p.includes("..") || p === ".git" || p.startsWith(".git/");
}

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

async function recordPresent(snapshot, worktreePath, rel) {
	const hash = await hashCarriedFile(path.join(worktreePath, rel));
	if (hash !== null) snapshot.set(rel, { state: "present", hash });
}

async function carryUncommittedState(topLevel, worktreePath, statusPromise) {
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
// Mirrors createWorktree's git/fs flow: rev-parse toplevel + base ref, stale
// cleanup, `git worktree add`, then the optional carry. Returns the carried
// snapshot (present — possibly empty — when the overlay ran, absent when
// skipped or when the overlay threw), matching the real return shape.
async function createWorktreeMirror(parentCwd, sessionId, baseRef, carryUncommitted = true) {
	let topLevel;
	try {
		topLevel = execFileSync("git", ["rev-parse", "--show-toplevel"], {
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
		headCommit = execFileSync("git", ["rev-parse", baseCommitRef], {
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
		try { execFileSync("git", ["worktree", "remove", "--force", worktreePath], quiet); } catch { /* */ }
		try { execFileSync("git", ["branch", "-D", branchName], quiet); } catch { /* */ }
	}
	// Mirror of A2: prefetch the carry status before `worktree add`. git()
	// never rejects, so an unconsumed prefetch cannot become an unhandled
	// rejection.
	const carryStatusPromise = carryUncommitted && !baseRef ? gitStatusPorcelain(topLevel) : undefined;
	try {
		execFileSync("git", ["worktree", "add", worktreePath, "-b", branchName, headCommit], quiet);
	} catch {
		return null; // worktree add failure is fatal, like the real code
	}
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

// ── preCommitSteps mirrors — KEEP IN SYNC with index.ts ───────────────────
// The completion filter: after `git add -A` + the WO-*.md unstage block,
// reset every carried path whose worktree bytes still match the snapshot
// (or whose carried deletion is still absent). Failures degrade — the filter
// must never abort preCommitSteps.
async function applyCarryFilter(worktreePath, carried) {
	const untouched = [];
	try {
		for (const [rel, snap] of carried) {
			const abs = path.join(worktreePath, rel);
			if (snap.state === "absent") {
				if (!fs.existsSync(abs)) untouched.push(rel);
			} else {
				const cur = await hashCarriedFile(abs);
				if (cur === snap.hash) untouched.push(rel);
			}
		}
	} catch {
		// degrade: continue with the untouched list computed so far
	}
	if (untouched.length > 0) {
		execFileSync("git", ["reset", "-q", "--", ...untouched], { cwd: worktreePath });
	}
}

function commitIfChanges(worktreePath, subject) {
	let hadChanges = false;
	try {
		git(worktreePath, ["diff", "--cached", "--quiet"]);
	} catch (e) {
		if (e.status !== 1) throw e;
		hadChanges = true;
		git(worktreePath, ["commit", "-q", "-m", subject]);
	}
	return hadChanges;
}

// The full preCommitSteps sequence in mirror form. Returns hadChanges.
async function preCommitStepsMirror(worktreePath, carried, subject) {
	git(worktreePath, ["add", "-A"]);
	const stagedNames = git(worktreePath, ["diff", "--cached", "--name-only"]);
	const scratch = stagedNames.split("\n").filter((p) => p.length > 0 && /^WO-.*\.md$/i.test(p));
	if (scratch.length > 0) git(worktreePath, ["reset", "-q", "--", ...scratch]);
	if (carried && carried.size > 0) await applyCarryFilter(worktreePath, carried);
	return commitIfChanges(worktreePath, subject);
}

// ── postDeliveryCleanup mirror — KEEP IN SYNC with index.ts ───────────────
// The branch-deletion decision (WO-2026-049). preCommitSteps reports
// hadChanges = "did the HARNESS auto-commit staged changes"; that flag alone
// is NOT a safe signal for deleting the branch, because a subagent that
// committed its OWN work leaves nothing staged (hadChanges=false) even though
// the branch HEAD moved past the parent. The real invariant is whether the
// branch carries any commit beyond the parent: delete iff finalCommit ===
// parentHeadCommit. (Observed 2026-08-08 in the Threefry branch-loss incident.)
function branchExists(parentDir, branchName) {
	try {
		execFileSync("git", ["rev-parse", "--verify", `refs/heads/${branchName}`], {
			cwd: parentDir, stdio: "ignore",
		});
		return true;
	} catch {
		return false;
	}
}

function postDeliveryCleanupMirror(parentDir, result, finalCommit) {
	// R3-2 (tfd process-controls, owner 2026-10-19): unlock first — git refuses
	// force-remove of a locked tree. Mirrors index.ts; the lock/unlock/reap
	// matrix itself lives in test-worktree-lock.cjs and tests/subagent-worktree-lock.test.ts.
	try {
		execFileSync("git", ["worktree", "unlock", result.worktreePath], { cwd: parentDir, stdio: "ignore" });
	} catch {
		/* not locked — the one tolerated unlock failure */
	}
	execFileSync("git", ["worktree", "remove", "--force", result.worktreePath], {
		cwd: parentDir, stdio: "ignore",
	});
	if (finalCommit === result.parentHeadCommit) {
		execFileSync("git", ["branch", "-D", result.branchName], {
			cwd: parentDir, stdio: "ignore",
		});
	}
}

// ── Test harness ───────────────────────────────────────────────────────────
let passed = 0;
let failed = 0;
let skipped = 0;
const registeredTests = [];

// Tests register here and run sequentially in the async runner at the bottom
// (top-level await is unavailable in CJS, and the carry/commit I/O is async).
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

function commitCount(dir) {
	return git(dir, ["rev-list", "--count", "HEAD"]).trim();
}

function cleanupWorktree(parentDir, result) {
	if (!result) return;
	try { execFileSync("git", ["worktree", "remove", "--force", result.worktreePath], { cwd: parentDir, stdio: "ignore" }); } catch { /* */ }
	try { fs.rmSync(result.worktreePath, { recursive: true, force: true }); } catch { /* */ }
	try { execFileSync("git", ["branch", "-D", result.branchName], { cwd: parentDir, stdio: "ignore" }); } catch { /* */ }
}

// Real temp repo + real `git worktree add` + real carry (with snapshot), then
// the phaseFn runs the subagent phase + preCommitSteps mirror + assertions.
async function withCarryFlow(opts, baselineFn, setupFn, phaseFn) {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-filter-repo-"));
	let result = null;
	try {
		initRepo(dir);
		baselineFn(dir);
		git(dir, ["add", "-A"]);
		git(dir, ["commit", "-q", "-m", "baseline"]);
		setupFn(dir, git);
		result = await createWorktreeMirror(dir, newSessionId(), opts.baseRef, opts.carryUncommitted ?? true);
		await phaseFn(result, dir, git);
	} finally {
		cleanupWorktree(dir, result);
		try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* */ }
	}
}

const defaultBaseline = (dir) => {
	fs.writeFileSync(path.join(dir, "plan.md"), "v1\n");
	fs.writeFileSync(path.join(dir, "gone.txt"), "x\n");
	fs.writeFileSync(path.join(dir, "target.txt"), "target\n");
};

const SUBJECT = "subagent(implement): test";

// ── The matrix below ───────────────────────────────────────────────────────

test("1. carried file read-only (never edited) — not in diff; no commit", async () => {
	await withCarryFlow({}, defaultBaseline, (dir) => {
		fs.writeFileSync(path.join(dir, "plan.md"), "v2\n"); // parent uncommitted edit
	}, async (result, dir) => {
		const wt = result.worktreePath;
		eq(fs.readFileSync(path.join(wt, "plan.md"), "utf8"), "v2\n", "carried bytes present");
		fs.readFileSync(path.join(wt, "plan.md"), "utf8"); // subagent reads, never edits
		const hadChanges = await preCommitStepsMirror(wt, result.carried, SUBJECT);
		eq(hadChanges, false, "no commit produced");
		eq(commitCount(dir), "1", "branch still at baseline");
		eq(git(wt, ["diff", "--cached", "--name-only"]).trim(), "", "carried file not staged");
	});
});

test("2. carried file edited by subagent — in diff; committed", async () => {
	await withCarryFlow({}, defaultBaseline, (dir) => {
		fs.writeFileSync(path.join(dir, "plan.md"), "v2\n");
	}, async (result, dir) => {
		const wt = result.worktreePath;
		fs.writeFileSync(path.join(wt, "plan.md"), "v3\n"); // subagent edit
		const hadChanges = await preCommitStepsMirror(wt, result.carried, SUBJECT);
		eq(hadChanges, true, "changes committed");
		eq(git(wt, ["show", "HEAD:plan.md"]), "v3\n", "edit landed on the branch");
	});
});

test("3. subagent-created new file — committed (carried file still filtered)", async () => {
	await withCarryFlow({}, defaultBaseline, (dir) => {
		fs.writeFileSync(path.join(dir, "plan.md"), "v2\n");
	}, async (result, dir) => {
		const wt = result.worktreePath;
		fs.writeFileSync(path.join(wt, "new.txt"), "subagent work\n");
		const hadChanges = await preCommitStepsMirror(wt, result.carried, SUBJECT);
		eq(hadChanges, true, "new file committed");
		eq(git(wt, ["show", "HEAD:new.txt"]), "subagent work\n");
		eq(git(wt, ["show", "HEAD:plan.md"]), "v1\n", "untouched carried file NOT on branch");
	});
});

test("4. carried deletion untouched (still absent) — deletion NOT staged; file present on branch", async () => {
	await withCarryFlow({}, defaultBaseline, (dir) => {
		fs.rmSync(path.join(dir, "gone.txt")); // parent uncommitted deletion
	}, async (result, dir) => {
		const wt = result.worktreePath;
		assert.ok(!fs.existsSync(path.join(wt, "gone.txt")), "carried deletion absent in worktree");
		const hadChanges = await preCommitStepsMirror(wt, result.carried, SUBJECT);
		eq(hadChanges, false, "no commit produced");
		eq(commitCount(dir), "1", "branch still at baseline");
		eq(git(wt, ["diff", "--cached", "--name-only"]).trim(), "", "deletion not staged");
		git(wt, ["show", "HEAD:gone.txt"]); // still tracked on the branch
	});
});

test("5. carried deletion undone (recreated with content) — committed", async () => {
	await withCarryFlow({}, defaultBaseline, (dir) => {
		fs.rmSync(path.join(dir, "gone.txt"));
	}, async (result, dir) => {
		const wt = result.worktreePath;
		fs.writeFileSync(path.join(wt, "gone.txt"), "recreated\n"); // subagent undoes the deletion
		const hadChanges = await preCommitStepsMirror(wt, result.carried, SUBJECT);
		eq(hadChanges, true, "recreated file committed");
		eq(git(wt, ["show", "HEAD:gone.txt"]), "recreated\n");
	});
});

test("6. carried symlink untouched — not committed", async () => {
	await withCarryFlow({}, defaultBaseline, (dir) => {
		fs.symlinkSync("target.txt", path.join(dir, "mylink")); // parent untracked symlink
	}, async (result, dir) => {
		const wt = result.worktreePath;
		const snap = result.carried.get("mylink");
		assert.ok(snap, "symlink in snapshot");
		eq(snap.hash, "link:target.txt", "snapshot hash is the link prefix + target");
		assert.ok(fs.lstatSync(path.join(wt, "mylink")).isSymbolicLink(), "carried as link");
		const hadChanges = await preCommitStepsMirror(wt, result.carried, SUBJECT);
		eq(hadChanges, false, "no commit produced");
		eq(commitCount(dir), "1");
		eq(git(wt, ["diff", "--cached", "--name-only"]).trim(), "", "symlink not staged");
	});
});

test("7. carried file + subagent WO-x.md scratch — both filtered; no commit", async () => {
	await withCarryFlow({}, defaultBaseline, (dir) => {
		fs.writeFileSync(path.join(dir, "plan.md"), "v2\n");
	}, async (result, dir) => {
		const wt = result.worktreePath;
		fs.writeFileSync(path.join(wt, "WO-2026-999.md"), "# scratch the subagent wrote\n");
		const hadChanges = await preCommitStepsMirror(wt, result.carried, SUBJECT);
		eq(hadChanges, false, "no commit produced");
		eq(commitCount(dir), "1");
		eq(git(wt, ["diff", "--cached", "--name-only"]).trim(), "", "neither the WO doc nor the carried file staged");
	});
});

test("8. rs.carried null (carryUncommitted:false) — old behavior, unchanged", async () => {
	await withCarryFlow({ carryUncommitted: false }, defaultBaseline, (dir) => {
		fs.writeFileSync(path.join(dir, "plan.md"), "v2\n");
	}, async (result, dir) => {
		const wt = result.worktreePath;
		// This asserts the createWorktree return SHAPE (no `carried` key when
		// carry is skipped) — the pipeline-level null is asserted below by
		// passing null into preCommitStepsMirror, matching rs.carried's null
		// default in production (spawnSubagent: carriedSnapshot ?? null).
		eq(result.carried, undefined, "no snapshot when carry skipped");
		fs.writeFileSync(path.join(wt, "new.txt"), "work\n");
		const hadChanges = await preCommitStepsMirror(wt, null, SUBJECT);
		eq(hadChanges, true, "commit proceeds as before");
		eq(git(wt, ["show", "HEAD:new.txt"]), "work\n");
	});
});

test("9. empty carried map — no-op", async () => {
	await withCarryFlow({}, defaultBaseline, () => { /* clean parent tree → empty snapshot */ }, async (result, dir) => {
		const wt = result.worktreePath;
		assert.ok(result.carried, "snapshot present (empty map) even with no changes");
		eq(result.carried.size, 0, "empty map");
		fs.writeFileSync(path.join(wt, "new.txt"), "work\n");
		const hadChanges = await preCommitStepsMirror(wt, result.carried, SUBJECT);
		eq(hadChanges, true, "no-op filter, commit proceeds");
		eq(git(wt, ["show", "HEAD:new.txt"]), "work\n");
	});
});

test("10. path with a space, carried & untouched — not committed (args-array reset)", async () => {
	await withCarryFlow({}, defaultBaseline, (dir) => {
		fs.writeFileSync(path.join(dir, "my file.txt"), "spaced\n"); // parent untracked
	}, async (result, dir) => {
		const wt = result.worktreePath;
		assert.ok(result.carried.has("my file.txt"), "spaced path in snapshot");
		eq(fs.readFileSync(path.join(wt, "my file.txt"), "utf8"), "spaced\n");
		const hadChanges = await preCommitStepsMirror(wt, result.carried, SUBJECT);
		eq(hadChanges, false, "no commit produced");
		eq(commitCount(dir), "1");
		eq(git(wt, ["diff", "--cached", "--name-only"]).trim(), "", "spaced path not staged");
	});
});

test("11. carried file edited then reverted to identical bytes — treated as untouched; no commit", async () => {
	await withCarryFlow({}, defaultBaseline, (dir) => {
		fs.writeFileSync(path.join(dir, "plan.md"), "v2\n");
	}, async (result, dir) => {
		const wt = result.worktreePath;
		fs.writeFileSync(path.join(wt, "plan.md"), "v3\n"); // edit
		fs.writeFileSync(path.join(wt, "plan.md"), "v2\n"); // revert to exact carried bytes
		const hadChanges = await preCommitStepsMirror(wt, result.carried, SUBJECT);
		eq(hadChanges, false, "net-zero edit is untouched — no commit");
		eq(commitCount(dir), "1");
	});
});

test("12. filter failure (carried file unreadable) — preCommitSteps continues; commit proceeds", async () => {
	const isRoot = typeof process.getuid === "function" && process.getuid() === 0;
	if (isRoot) {
		// chmod 000 does not make a file unreadable to root, so the filter
		// cannot be made to fail; count it as skipped rather than passed.
		skip("running as root — chmod 000 does not make a file unreadable");
	}
	await withCarryFlow({}, defaultBaseline, (dir) => {
		fs.writeFileSync(path.join(dir, "plan.md"), "v2\n");
	}, async (result, dir) => {
		const wt = result.worktreePath;
		const carriedFile = path.join(wt, "plan.md");
		// Stage while readable (git add cannot read a chmod-000 file), then
		// break readability so hashCarriedFile fails mid-filter.
		git(wt, ["add", "-A"]);
		fs.chmodSync(carriedFile, 0o000);
		await applyCarryFilter(wt, result.carried); // must not throw
		const staged = git(wt, ["diff", "--cached", "--name-only"]).trim();
		assert.ok(staged.includes("plan.md"), "unverifiable carried file stays staged");
		const hadChanges = commitIfChanges(wt, SUBJECT);
		eq(hadChanges, true, "commit proceeds with whatever remains staged");
		eq(git(wt, ["show", "HEAD:plan.md"]), "v2\n", "unreadable-but-staged file committed");
		fs.chmodSync(carriedFile, 0o644);
	});
});

// ── Branch-preservation matrix (WO-2026-049) ───────────────────────────
// postDeliveryCleanup deletes the isolation branch iff finalCommit ===
// parentHeadCommit (nothing new committed). hadChanges alone is unsafe: a
// subagent that committed its own work leaves nothing staged (hadChanges=
// false) yet the branch HEAD moved past the parent — deleting it orphans the
// work (the Threefry branch-loss incident, 2026-08-08).

test("13. subagent self-commits (nothing left staged) — branch PRESERVED (hadChanges=false, HEAD moved)", async () => {
	await withCarryFlow({}, defaultBaseline, () => {}, async (result, dir) => {
		const wt = result.worktreePath;
		// The subagent commits its own work before completing (tfd WOs and model
		// behavior both do this; observed 2026-08-08 in the Threefry branch-loss
		// incident). preCommitSteps then finds nothing left staged.
		fs.writeFileSync(path.join(wt, "self.txt"), "subagent work\n");
		git(wt, ["add", "-A"]);
		git(wt, ["commit", "-q", "-m", "subagent's own commit"]);
		const hadChanges = await preCommitStepsMirror(wt, result.carried, SUBJECT);
		eq(hadChanges, false, "nothing left staged for the harness to auto-commit");
		const finalCommit = git(wt, ["rev-parse", "HEAD"]).trim();
		assert.notStrictEqual(finalCommit, result.parentHeadCommit, "branch HEAD moved past the parent");
		postDeliveryCleanupMirror(dir, result, finalCommit);
		eq(branchExists(dir, result.branchName), true, "self-commit preserved on branch (not deleted)");
	});
});

test("14. no commits at all (read-only scout) — branch deleted (finalCommit === parentHeadCommit)", async () => {
	await withCarryFlow({}, defaultBaseline, () => {}, async (result, dir) => {
		const wt = result.worktreePath;
		fs.readFileSync(path.join(wt, "target.txt"), "utf8"); // read-only, never edits
		const hadChanges = await preCommitStepsMirror(wt, result.carried, SUBJECT);
		eq(hadChanges, false, "no commit produced");
		const finalCommit = git(wt, ["rev-parse", "HEAD"]).trim();
		eq(finalCommit, result.parentHeadCommit, "branch still at parent commit");
		postDeliveryCleanupMirror(dir, result, finalCommit);
		eq(branchExists(dir, result.branchName), false, "useless branch deleted");
	});
});

test("15. harness auto-commit (hadChanges=true) — branch PRESERVED", async () => {
	await withCarryFlow({}, defaultBaseline, () => {}, async (result, dir) => {
		const wt = result.worktreePath;
		fs.writeFileSync(path.join(wt, "work.txt"), "uncommitted subagent work\n");
		const hadChanges = await preCommitStepsMirror(wt, result.carried, SUBJECT);
		eq(hadChanges, true, "harness auto-committed the staged change");
		const finalCommit = git(wt, ["rev-parse", "HEAD"]).trim();
		assert.notStrictEqual(finalCommit, result.parentHeadCommit, "branch HEAD moved past the parent");
		postDeliveryCleanupMirror(dir, result, finalCommit);
		eq(branchExists(dir, result.branchName), true, "auto-commit preserved on branch (not deleted)");
	});
});

// ── Result ─────────────────────────────────────────────────────────────────
runTests().then(() => {
	console.log(`\n${passed} passed, ${failed} failed${skipped ? `, ${skipped} skipped` : ""}`);
	process.exit(failed === 0 ? 0 : 1);
});
