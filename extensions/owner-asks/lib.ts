/**
 * Owner asks: how many registry questions await the owner, and which are new.
 *
 * A repo carrying `scripts/reviews_status.py` (tfd) reads its open asks from the
 * upstream branch, so the count moves when another clone pushes, with no
 * checkout. "New" is open minus the set the owner last acknowledged. A repo's
 * first observation seeds that set, so the counter starts at zero rather than
 * flagging the whole backlog. A repo that also carries `scripts/wo_record.py`
 * adds its unruled work-order departures (decisions/work-order-records/001).
 * Other repos report nothing.
 *
 * Shared by the pi extension (index.ts) and the Claude Code CLI (external.ts).
 */

import { execFile, spawn } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

/** Minimum gap between background fetches of one repo. */
export const FETCH_INTERVAL_MS = 5 * 60_000;

const DEFAULT_CACHE_DIR = path.join(os.homedir(), ".cache", "owner-asks");
const SCRIPT = path.join("scripts", "reviews_status.py");
const RECORD_SCRIPT = path.join("scripts", "wo_record.py");

export interface Ask {
	/** `<file>#<id>`: the identity an ack stores. */
	key: string;
	/** The `reviews_status.py --plain` line, verbatim. */
	line: string;
	isNew: boolean;
}

export interface OwnerAsks {
	root: string;
	asks: Ask[];
	/** `wo_record.py unruled` lines: departures with no answered registry row. */
	unruled: string[];
}

/** Status-bar text, e.g. `owner asks: 3 open · 1 new · 2 unruled departures`. */
export function countText(asks: Ask[], unruled = 0): string {
	const fresh = asks.filter((a) => a.isNew).length;
	const departures = unruled ? ` · ${unruled} unruled departure${unruled === 1 ? "" : "s"}` : "";
	return `owner asks: ${asks.length} open${fresh ? ` · ${fresh} new` : ""}${departures}`;
}

/** Whether the status should be drawn as a warning: something new, or a departure to rule. */
export function attention(state: OwnerAsks): boolean {
	return state.asks.some((a) => a.isNew) || state.unruled.length > 0;
}

/** Trimmed stdout of a git command, or null when it fails (no upstream, not a repo). */
export function gitOut(cwd: string, args: string[]): Promise<string | null> {
	return new Promise((resolve) =>
		execFile("git", args, { cwd }, (err, stdout) => resolve(err ? null : stdout.trim())),
	);
}

function sanitize(root: string): string {
	return root.replace(/[^A-Za-z0-9._-]/g, "_");
}

async function registryRoot(cwd: string): Promise<string | null> {
	const root = await gitOut(cwd, ["rev-parse", "--show-toplevel"]);
	return root && fs.existsSync(path.join(root, SCRIPT)) ? root : null;
}

/** Start a detached `git fetch` unless one started within FETCH_INTERVAL_MS. */
function fetchIfStale(root: string, cacheDir: string): void {
	const stamp = path.join(cacheDir, `${sanitize(root)}.fetched`);
	const last = fs.existsSync(stamp) ? fs.statSync(stamp).mtimeMs : 0;
	if (Date.now() - last < FETCH_INTERVAL_MS) return;
	fs.mkdirSync(cacheDir, { recursive: true });
	// Stamp before spawning: a failing fetch must not retry on every call.
	fs.writeFileSync(stamp, "");
	// No prompt: a detached process that waits on credentials would hang forever.
	const child = spawn("git", ["fetch", "--quiet"], {
		cwd: root,
		detached: true,
		stdio: "ignore",
		env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
	});
	// Best effort: a missing git or a dead remote only leaves the counts stale.
	child.on("error", () => {});
	child.unref();
}

function runPython(root: string, args: string[]): Promise<string[]> {
	return new Promise((resolve, reject) =>
		execFile("python3", args, { cwd: root }, (err, stdout, stderr) => {
			if (err) reject(new Error(`${args[0]} failed: ${stderr.trim() || err.message}`));
			else resolve(stdout.split("\n").filter((l) => l.trim() !== ""));
		}),
	);
}

/** Both scripts' output at `ref`, or in the working tree when `ref` is null. */
async function runScripts(root: string, ref: string | null): Promise<{ lines: string[]; unruled: string[] }> {
	const refArgs = ref ? ["--ref", ref] : [];
	const lines = await runPython(root, [SCRIPT, "--plain", ...refArgs]);
	const unruled = fs.existsSync(path.join(root, RECORD_SCRIPT))
		? await runPython(root, [RECORD_SCRIPT, "unruled", ...refArgs])
		: [];
	return { lines, unruled };
}

interface ParsedCache {
	sha: string;
	lines: string[];
	unruled: string[];
}

/**
 * Script output from the upstream sha, or from the working tree when the branch
 * has no upstream. The upstream read is cached by sha, so a repeat call costs one rev-parse.
 */
async function scriptOutput(root: string, cacheDir: string): Promise<{ lines: string[]; unruled: string[] }> {
	fetchIfStale(root, cacheDir);
	const sha = await gitOut(root, ["rev-parse", "--verify", "--quiet", "@{u}"]);
	if (sha === null) return runScripts(root, null);

	const cachePath = path.join(cacheDir, `${sanitize(root)}.parsed.json`);
	if (fs.existsSync(cachePath)) {
		const cached = JSON.parse(fs.readFileSync(cachePath, "utf8")) as ParsedCache;
		// A cache written before `unruled` existed has no such array and is read again.
		if (cached.sha === sha && cached.unruled) return cached;
	}
	const out = await runScripts(root, sha);
	fs.mkdirSync(cacheDir, { recursive: true });
	fs.writeFileSync(cachePath, JSON.stringify({ sha, ...out } satisfies ParsedCache));
	return out;
}

function keyOf(line: string): string {
	const m = /^(\S+)\s+(\S+)/.exec(line);
	if (!m) throw new Error(`unexpected reviews_status line: ${line}`);
	return `${m[1]}#${m[2]}`;
}

function seenPath(root: string, cacheDir: string): string {
	return path.join(cacheDir, `${sanitize(root)}.seen`);
}

function readSeen(root: string, cacheDir: string): string[] | null {
	const file = seenPath(root, cacheDir);
	return fs.existsSync(file) ? (JSON.parse(fs.readFileSync(file, "utf8")) as string[]) : null;
}

function writeSeen(root: string, cacheDir: string, keys: string[]): void {
	fs.mkdirSync(cacheDir, { recursive: true });
	fs.writeFileSync(seenPath(root, cacheDir), JSON.stringify(keys));
}

/** The repo's open asks, or null when `cwd` is not a registry repo. */
export async function ownerAsks(cwd: string, cacheDir = DEFAULT_CACHE_DIR): Promise<OwnerAsks | null> {
	const root = await registryRoot(cwd);
	if (!root) return null;
	const { lines, unruled } = await scriptOutput(root, cacheDir);
	const keys = lines.map(keyOf);
	let seen = readSeen(root, cacheDir);
	if (seen === null) {
		writeSeen(root, cacheDir, keys);
		seen = keys;
	}
	const seenSet = new Set(seen);
	return {
		root,
		asks: lines.map((line, i) => ({ key: keys[i], line, isNew: !seenSet.has(keys[i]) })),
		unruled,
	};
}

/** Plain lines: the new asks first, then the rest, then the unruled departures; null when not a registry repo. */
export async function list(cwd: string, cacheDir = DEFAULT_CACHE_DIR): Promise<string[] | null> {
	const state = await ownerAsks(cwd, cacheDir);
	if (!state) return null;
	const isNew = state.asks.filter((a) => a.isNew);
	const rest = state.asks.filter((a) => !a.isNew);
	return [...isNew, ...rest].map((a) => a.line).concat(state.unruled);
}

/** Mark the current open set seen; returns the state it acked, or null when not a registry repo. */
export async function ack(cwd: string, cacheDir = DEFAULT_CACHE_DIR): Promise<OwnerAsks | null> {
	const state = await ownerAsks(cwd, cacheDir);
	if (!state) return null;
	writeSeen(state.root, cacheDir, state.asks.map((a) => a.key));
	return state;
}
