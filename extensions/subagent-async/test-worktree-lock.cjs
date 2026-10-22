#!/usr/bin/env node
/**
 * Regression test for the subagent worktree lock lifecycle (tfd
 * process-controls R3-2, owner 2026-10-19).
 *
 * `createWorktree` (extensions/subagent-async/index.ts) locks the tree with
 * `git worktree lock --reason "pi-subagent <sid>"` immediately after
 * `git worktree add`, so `git worktree remove --force` on a live child's tree
 * fails loudly and a hand reap cannot destroy its work. The harness's own
 * cleanup unlocks first and only after the completion is recorded; the reap
 * unlocks and removes a clean finished tree with a plain (no `--force`) remove,
 * so a dirty tree is refused by git itself.
 *
 * This test cannot import index.ts — `typebox` and `@earendil-works/*` resolve
 * only under jiti at runtime. Following the test-carry-uncommitted.cjs
 * precedent it mirrors the exact command sequences (KEEP IN SYNC) and runs them
 * against REAL temp repos and REAL worktrees.
 *
 * Run: node extensions/subagent-async/test-worktree-lock.cjs
 */
"use strict";

const assert = require("node:assert");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { execFileSync, spawnSync } = require("node:child_process");

// ── The mirrored sequences — KEEP IN SYNC with index.ts ────────────────────
// createWorktree, after a successful `worktree add`:
//     git worktree lock --reason "pi-subagent <sid>" <path>      (best-effort)
// postDeliveryCleanup, after the completion is recorded:
//     git worktree unlock <path>        (tolerate "is not locked")
//     git worktree remove --force <path>
// reapFinishedWorktrees, for a clean tree whose child is provably finished:
//     git worktree unlock <path>        (tolerate "is not locked")
//     git worktree remove <path>        (NO --force: git refuses a dirty tree)

function git(dir, args) {
	const p = spawnSync("git", args, { cwd: dir, encoding: "utf8" });
	return { code: p.status, out: p.stdout, err: p.stderr };
}

function gitOrThrow(dir, args) {
	const r = git(dir, args);
	if (r.code !== 0) throw new Error(`git ${args.join(" ")} failed: ${r.err.trim()}`);
	return r.out;
}

/** Mirror of the lock step in createWorktree. */
function lockWorktree(parentCwd, sessionId, worktreePath) {
	const r = git(parentCwd, ["worktree", "lock", "--reason", `pi-subagent ${sessionId}`, worktreePath]);
	return r.code === 0;
}

/** Mirror of the unlock step shared by postDeliveryCleanup and the reap. */
function unlockWorktree(cwd, worktreePath) {
	const r = git(cwd, ["worktree", "unlock", worktreePath]);
	return { ok: r.code === 0 || /is not locked/i.test(r.err), err: r.err };
}

/** Mirror of postDeliveryCleanup's unlock-then-force-remove. */
function postDeliveryCleanup(parentCwd, worktreePath) {
	const unlock = unlockWorktree(parentCwd, worktreePath);
	if (!unlock.ok) return { removed: false, reason: `unlock failed: ${unlock.err.trim()}` };
	const remove = git(parentCwd, ["worktree", "remove", "--force", worktreePath]);
	if (remove.code !== 0) return { removed: false, reason: `remove failed: ${remove.err.trim()}` };
	return { removed: true };
}

/** Mirror of reapFinishedWorktrees' clean-tree branch (cwd inside the tree). */
function reapCleanWorktree(worktreePath) {
	const status = git(worktreePath, ["status", "--porcelain", "-uall"]);
	if (status.code !== 0) return { outcome: "kept-git-error" };
	if (status.out.trim().length > 0) return { outcome: "kept-uncommitted" };
	const unlock = unlockWorktree(worktreePath, worktreePath);
	if (!unlock.ok) return { outcome: "kept-unlock-failed" };
	const remove = git(worktreePath, ["worktree", "remove", worktreePath]);
	if (remove.code !== 0) return { outcome: "kept-remove-failed" };
	return { outcome: "removed" };
}

function worktreeEntry(repo, worktreePath) {
	// git canonicalises the path (/var → /private/var on macOS).
	let target = worktreePath;
	try { target = fs.realpathSync(worktreePath); } catch { /* gone */ }
	for (const block of gitOrThrow(repo, ["worktree", "list", "--porcelain"]).split("\n\n")) {
		const first = block.split("\n")[0];
		if (!first || !first.startsWith("worktree ")) continue;
		let registered = first.slice("worktree ".length);
		try { registered = fs.realpathSync(registered); } catch { /* gone */ }
		if (registered === target) return block;
	}
	return null;
}

// ── Test harness (mirrors test-carry-uncommitted.cjs) ──────────────────────
let passed = 0;
let failed = 0;
let skipped = 0;
const registeredTests = [];

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

function initRepo(dir) {
	gitOrThrow(dir, ["init", "-q"]);
	gitOrThrow(dir, ["config", "user.email", "t@t"]);
	gitOrThrow(dir, ["config", "user.name", "t"]);
	fs.writeFileSync(path.join(dir, "seed.txt"), "seed\n");
	gitOrThrow(dir, ["add", "-A"]);
	gitOrThrow(dir, ["commit", "-q", "-m", "init"]);
}

let nextId = 0;
function newSessionId() {
	return `subagent-test-${Date.now().toString(36)}-${nextId++}`;
}

/** A real repo + a real locked worktree, mirroring createWorktree. */
function makeLockedWorktree() {
	const repo = fs.mkdtempSync(path.join(os.tmpdir(), "pi-lock-cjs-repo-"));
	initRepo(repo);
	const sessionId = newSessionId();
	const branchName = `pi-subagent-${sessionId.slice(-12)}`;
	const worktreePath = path.join(os.tmpdir(), `pi-subagent-wt-${sessionId.slice(-12)}`);
	try { fs.rmSync(worktreePath, { recursive: true, force: true }); } catch { /* */ }
	gitOrThrow(repo, ["worktree", "add", worktreePath, "-b", branchName, "HEAD"]);
	const locked = lockWorktree(repo, sessionId, worktreePath);
	return { repo, sessionId, branchName, worktreePath, locked };
}

function cleanup(repo, worktreePath, branchName) {
	try { git(repo, ["worktree", "unlock", worktreePath]); } catch { /* */ }
	try { git(repo, ["worktree", "remove", "--force", worktreePath]); } catch { /* */ }
	try { fs.rmSync(worktreePath, { recursive: true, force: true }); } catch { /* */ }
	try { git(repo, ["branch", "-D", branchName]); } catch { /* */ }
	try { fs.rmSync(repo, { recursive: true, force: true }); } catch { /* */ }
}

// ── Rows ───────────────────────────────────────────────────────────────────

test("1. createWorktree locks the tree and records the session id as the reason", () => {
	const { repo, sessionId, worktreePath, branchName, locked } = makeLockedWorktree();
	try {
		eq(locked, true, "worktree lock exited 0");
		const entry = worktreeEntry(repo, worktreePath);
		assert.ok(entry, "worktree is registered");
		assert.ok(entry.includes("locked"), "porcelain reports the lock");
		assert.ok(entry.includes(`pi-subagent ${sessionId}`), "the lock reason names the session");
	} finally {
		cleanup(repo, worktreePath, branchName);
	}
});

test("2. a locked tree refuses `worktree remove --force` (the R3-2 protection)", () => {
	const { repo, worktreePath, branchName } = makeLockedWorktree();
	try {
		const forced = git(repo, ["worktree", "remove", "--force", worktreePath]);
		assert.notStrictEqual(forced.code, 0, "force-remove of a locked tree fails");
		assert.match(forced.err, /locked/, "git says why");
		assert.ok(fs.existsSync(worktreePath), "the tree is still there");
	} finally {
		cleanup(repo, worktreePath, branchName);
	}
});

test("3. postDeliveryCleanup unlocks first, then force-removes", () => {
	const { repo, worktreePath, branchName } = makeLockedWorktree();
	try {
		const result = postDeliveryCleanup(repo, worktreePath);
		eq(result.removed, true, "cleanup removed the tree");
		assert.ok(!fs.existsSync(worktreePath), "directory gone");
		eq(worktreeEntry(repo, worktreePath), null, "worktree registration gone");
	} finally {
		cleanup(repo, worktreePath, branchName);
	}
});

test("4. unlock tolerates a tree that was never locked (pre-lock spawn / already unlocked)", () => {
	const repo = fs.mkdtempSync(path.join(os.tmpdir(), "pi-lock-cjs-unlocked-"));
	initRepo(repo);
	const sessionId = newSessionId();
	const branchName = `pi-subagent-${sessionId.slice(-12)}`;
	const worktreePath = path.join(os.tmpdir(), `pi-subagent-wt-${sessionId.slice(-12)}`);
	try {
		try { fs.rmSync(worktreePath, { recursive: true, force: true }); } catch { /* */ }
		gitOrThrow(repo, ["worktree", "add", worktreePath, "-b", branchName, "HEAD"]);

		const unlock = unlockWorktree(repo, worktreePath);
		eq(unlock.ok, true, "unlock of a never-locked tree is treated as success");
		assert.match(unlock.err, /is not locked/, "the tolerated failure is 'is not locked'");

		const result = postDeliveryCleanup(repo, worktreePath);
		eq(result.removed, true, "cleanup still removes the tree");
		assert.ok(!fs.existsSync(worktreePath), "directory gone");
	} finally {
		cleanup(repo, worktreePath, branchName);
	}
});

test("5. unlock fails loudly for any other error (never swallowed)", () => {
	const repo = fs.mkdtempSync(path.join(os.tmpdir(), "pi-lock-cjs-bad-"));
	initRepo(repo);
	try {
		// A path that is not a registered worktree at all: 'not a working tree',
		// not 'is not locked' — the caller must treat this as a failure.
		const missing = path.join(os.tmpdir(), "pi-lock-cjs-not-a-tree");
		const unlock = unlockWorktree(repo, missing);
		eq(unlock.ok, false, "a non-worktree path is not a tolerated unlock result");
		assert.doesNotMatch(unlock.err, /is not locked/, "the failure text is not the tolerated one");
	} finally {
		try { fs.rmSync(repo, { recursive: true, force: true }); } catch { /* */ }
	}
});

test("6. reap removes a clean finished tree with a plain (no --force) remove", () => {
	const { repo, worktreePath, branchName } = makeLockedWorktree();
	try {
		const result = reapCleanWorktree(worktreePath);
		eq(result.outcome, "removed", "clean tree removed");
		assert.ok(!fs.existsSync(worktreePath), "directory gone");
		eq(worktreeEntry(repo, worktreePath), null, "registration gone");
	} finally {
		cleanup(repo, worktreePath, branchName);
	}
});

test("7. reap keeps a dirty tree — plain remove is refused by git", () => {
	const { repo, worktreePath, branchName } = makeLockedWorktree();
	try {
		fs.writeFileSync(path.join(worktreePath, "uncommitted.txt"), "bytes\n");

		const result = reapCleanWorktree(worktreePath);
		eq(result.outcome, "kept-uncommitted", "dirty tree kept");
		assert.ok(fs.existsSync(path.join(worktreePath, "uncommitted.txt")), "uncommitted bytes survive");

		// The command the reap would run after the dirty check: plain remove, no
		// --force. git refuses on its own — "locked" while the lock is in force,
		// "modified or untracked files" once it is released. Either way the bytes
		// survive, which is the property the reap depends on.
		const plain = git(worktreePath, ["worktree", "remove", worktreePath]);
		assert.notStrictEqual(plain.code, 0, "plain remove refuses a dirty tree");
		assert.match(plain.err, /locked|modified or untracked|use --force/i, "git says why");
		assert.ok(fs.existsSync(path.join(worktreePath, "uncommitted.txt")), "still there");

		unlockWorktree(worktreePath, worktreePath);
		const plainUnlocked = git(worktreePath, ["worktree", "remove", worktreePath]);
		assert.notStrictEqual(plainUnlocked.code, 0, "unlocked plain remove still refuses dirty work");
		assert.match(plainUnlocked.err, /modified or untracked|use --force/i, "git names the dirty state");
		assert.ok(fs.existsSync(path.join(worktreePath, "uncommitted.txt")), "bytes survive the unlocked attempt too");
	} finally {
		cleanup(repo, worktreePath, branchName);
	}
});

test("8. a locked tree whose child is gone still refuses --force until unlocked (reap needs the unlock)", () => {
	const { repo, worktreePath, branchName } = makeLockedWorktree();
	try {
		// The child is dead (nothing to record a completion here), the tree is
		// clean: only the explicit unlock makes the reap's remove work.
		const forced = git(repo, ["worktree", "remove", "--force", worktreePath]);
		assert.notStrictEqual(forced.code, 0, "still locked → refused");
		const result = reapCleanWorktree(worktreePath);
		eq(result.outcome, "removed", "reap's unlock-then-remove path succeeds");
	} finally {
		cleanup(repo, worktreePath, branchName);
	}
});

// ── Result ─────────────────────────────────────────────────────────────────
runTests().then(() => {
	console.log(`\n${passed} passed, ${failed} failed${skipped ? `, ${skipped} skipped` : ""}`);
	process.exit(failed === 0 ? 0 : 1);
});
