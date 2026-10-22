/**
 * Async Subagent Extension — Non-blocking subagent execution via RPC mode.
 *
 * Subagents run in background pi processes using RPC mode. The parent
 * remains interactive and can check progress, steer, or stop subagents
 * at any time. Results are delivered as injected user messages.
 */

import { execFileSync, spawn, spawnSync, type ChildProcess } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import * as fs from "node:fs";
import * as net from "node:net";
import * as os from "node:os";
import * as path from "node:path";
import type { AgentToolResult } from "@earendil-works/pi-agent-core";
import type { ExtensionAPI, ToolDefinition } from "@earendil-works/pi-coding-agent";
import { CustomEditor, getAgentDir } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { type AgentConfig, type AgentScope, discoverAgents } from "./agents.ts";
import { FLEET_MODEL_SPEC } from "../lib/fleet-model.ts";
import { matchesKey, Key, truncateToWidth } from "@earendil-works/pi-tui";

// ── Constants ───────────────────────────────────────────────────────────────

const MAX_TURNS_HARD = 500;
const TURN_NUDGE_SOFT = 450; // warn once before the hard 500-turn kill
const STOP_TIMEOUT_MS = 5 * 60 * 1000; // 5 minutes
const HARD_KILL_DELAY_MS = 5000;
// Stalled-turn watchdog: if a subagent hasn't completed a turn in
// SUBAGENT_STALE_TURN_MS, wake the caller (do NOT kill the subagent)
// so it can inspect progress with subagent_status or stop it with
// subagent_stop. The watchdog resets on every assistant turn, so it
// only fires when the subagent is genuinely stuck.
const SUBAGENT_STALE_TURN_MS = 5 * 60 * 1000; // 5 minutes
// Decision 015 stage-2: a child SILENT for SILENCE_TIMEOUT_DEFAULT_MS (no
// activity in the decision-015 signal union — tools, LLM streaming, retries,
// logs; per `lastActivityMs` tracking) is
// auto-killed via the shared subagent_kill machinery (SIGTERM → SIGKILL),
// with a `[Killed via progress-timeout]` marker delivered so the parent's
// wait resolves and the session stays resumable. The default (30 min) is
// strictly longer than SUBAGENT_STALE_TURN_MS (5 min) — the stage-1 wake
// gives the caller four chances to intervene before stage 2 fires.
// 0/negative per-spawn (silenceTimeoutMs param) disables stage 2 entirely.
const SILENCE_TIMEOUT_DEFAULT_MS = 30 * 60 * 1000; // 30 minutes
// Sleep guard (decision 015 fix): heartbeat cadence and jitter slack for
// detecting system sleep. A heartbeat tick landing >slack late means the
// process was suspended — discount the slept interval from each child's
// silence budget so sleep isn't billed as child silence.
const SLEEP_GUARD_HEARTBEAT_MS = 10 * 1000;
const SLEEP_GUARD_SLACK_MS = 3 * 1000;
// Decision 015 guards 3+4: the raw RPC event types that count as child
// activity. Tool lifecycle + streaming tool output (guard 3); LLM-call
// streaming + provider retry lifecycle (guard 4 — a child mid-LLM-call emits
// none of guard 3's signals, so without message_update one slow provider call
// spanning the silence window was killed at a live turn boundary, issue #1).
// The assistant message_end bump is role-gated at its call site and stays
// there; log lines bump via logEntry.
const ACTIVITY_EVENT_TYPES: ReadonlySet<string> = new Set([
	"tool_execution_start",
	"tool_execution_end",
	"tool_execution_update",
	"message_start",
	"message_update",
	"auto_retry_start",
	"auto_retry_end",
]);
function eventCountsAsActivity(type: string): boolean {
	return ACTIVITY_EVENT_TYPES.has(type);
}
// Stage-1 softening: activity within this window means the child is emitting
// (LLM deltas / retries arrive sub-second) — soften the stall notice instead
// of crying "stalled" mid-stream. False stalls invited manual kills of
// healthy children (decision 015 amendment 2026-08-12: ≈209 manual vs ≈6
// stage-2 kills).
const STALL_SOFTEN_ACTIVITY_MS = 60 * 1000;
const STARTUP_SUMMARY_EVENT = "pi-config:startup-summary-item";
const REVIEW_ROUND_CAP = 3;

/** Module-level debug flag — set once at load time. Used for timing instrumentation. */
const PI_ASYNC_DEBUG = process.env.PI_ASYNC_DEBUG === "1";

// ── Reviewer-spawn tracker ────────────────────────────────────────────────
//
// Tracks which post-implementation reviewer kinds each parent (the running pi
// process) has spawned. The orchestrator's `subagent_review_status` tool reads
// the persisted form of this map to mechanically verify that an implementer's
// declared `reviewParentRequirements` are met before forwarding `complete`.
//
// Two views of the same data:
//   - `parentReviewerSpawns`: in-memory `Map<parentSessionId, SpawnEntry[]>`,
//     used by the soft-prompt check at parent-stop time. Per-process; lost on
//     restart (documented; not a bug).
//   - `/tmp/pi-subagent-<parentSessionId>.reviewers.json`: durable file the
//     orchestrator reads via `subagent_review_status`. Persisted on every
//     spawn so cross-process visibility survives the harness restarting.
//
// When the parent is itself a subagent (e.g. implement running in RPC
// mode), `ctx.sessionManager.getSessionId()` returns the parent's session id;
// if unavailable, fall back to `pid:<process.pid>`. The fallback only matters
// in nested-orchestration scenarios; normal pi sessions always have a
// session id.

import type { ReviewerKind } from "./agents.ts";

interface SpawnEntry {
	reviewerKind: ReviewerKind;
	childSessionId: string;
	childAgentName: string;
	spawnedAt: number;
}

interface TrackerState {
	spawns: SpawnEntry[];
	reviewRounds: number;
	reviewCapReached: boolean;
}

const parentReviewerSpawns = new Map<string, TrackerState>();

/** Stable key for tracker persistence and cross-process lookup. */
export function getParentTrackerKey(ctx: any): string {
	try {
		const id = ctx?.sessionManager?.getSessionId?.();
		if (typeof id === "string" && id.length > 0) return id;
	} catch { /* sessionManager not present — fall through */ }
	return `pid:${process.pid}`;
}

/** On-disk path for a parent's reviewer-spawn log (read by orchestrator tool). */
function reviewStatusPath(parentKey: string): string {
	// Sanitize: strip characters that would break a path. The session id is
	// generated by the parent process and is normally safe, but a malicious or
	// buggy upstream could produce anything. Keep this conservative.
	const safe = parentKey.replace(/[^A-Za-z0-9._-]+/g, "_").slice(0, 200) || `pid_${process.pid}`;
	return `/tmp/pi-subagent-${safe}.reviewers.json`;
}

function recordReviewerSpawn(parentKey: string, entry: SpawnEntry): void {
	const state = parentReviewerSpawns.get(parentKey) ?? { spawns: [], reviewRounds: 0, reviewCapReached: false };
	state.spawns.push(entry);
	state.reviewRounds++;
	if (state.reviewRounds >= REVIEW_ROUND_CAP) {
		state.reviewCapReached = true;
	}
	parentReviewerSpawns.set(parentKey, state);

	// Persist atomically: write to a temp file then rename. Avoids partial
	// reads if the orchestrator polls while we write.
	try {
		const target = reviewStatusPath(parentKey);
		const tmp = `${target}.tmp.${process.pid}`;
		fs.writeFileSync(tmp, JSON.stringify({
			parentSessionId: parentKey,
			updatedAt: Date.now(),
			spawns: state.spawns,
			reviewRounds: state.reviewRounds,
			reviewCapReached: state.reviewCapReached,
		}, null, 2));
		fs.renameSync(tmp, target);
	} catch (e) {
		debugLog(`recordReviewerSpawn: persist failed: ${e instanceof Error ? e.message : String(e)}`);
	}
}

/**
 * Read the persisted spawn list for a given session id. Used by:
 *   1. The soft-prompt check at child-stop time (parent's harness reads the
 *      child's tracker file).
 *   2. The `subagent_review_status` tool (orchestrator's harness reads the
 *      implementer's tracker file).
 * Returns an empty TrackerState on any error (missing file, parse failure, IO error).
 * Never throws — this is a best-effort signal; gate enforcement belongs to the
 * orchestrator, not the harness.
 */
export function readPersistedSpawns(parentSessionId: string): TrackerState {
	try {
		const path = reviewStatusPath(parentSessionId);
		const raw = fs.readFileSync(path, "utf-8");
		const parsed = JSON.parse(raw);
		const spawns = Array.isArray(parsed.spawns) ? parsed.spawns as SpawnEntry[] : [];
		const reviewRounds = typeof parsed.reviewRounds === "number" ? parsed.reviewRounds : spawns.length > 0 ? 1 : 0;
		const reviewCapReached = parsed.reviewCapReached === true;
		return { spawns, reviewRounds, reviewCapReached };
	} catch { /* missing or malformed — treat as empty */ }
	return { spawns: [], reviewRounds: 0, reviewCapReached: false };
}

/** Drop the in-memory entry when a parent ends (avoid growth across sessions). */
function clearParentTracker(parentKey: string): void {
	parentReviewerSpawns.delete(parentKey);
	// Note: we intentionally do NOT delete the on-disk file here — the
	// orchestrator may still want to read it after this parent has stopped.
	// A subsequent spawn from a new parent with the same key (unlikely but
	// possible with the pid fallback) will overwrite the file.
}

/**
 * Module-level debug logger. No-op unless PI_ASYNC_DEBUG=1 is set. Used by
 * tracker helpers and the spawn code (the spawn code previously had its own
 * closure-scoped debugLog; we keep one canonical helper at module scope so
 * tracker logic can log too).
 */
function debugLog(msg: string): void {
	if (!PI_ASYNC_DEBUG) return;
	try { fs.appendFileSync("/tmp/pi-async-debug.log", `[${process.pid}] ${msg}\n`); } catch { /* */ }
}

// ── Meta-file helpers ──────────────────────────────────────────────────────
// Atomic read/write for /tmp/pi-subagent-<sid>.meta.json, matching the
// recordReviewerSpawn pattern (tmp + rename) to avoid torn reads.

export function metaPath(sessionId: string): string {
	return `/tmp/pi-subagent-${sessionId}.meta.json`;
}

/** Write a complete meta file atomically. */
export function writeMetaJson(sessionId: string, data: Record<string, any>): void {
	try {
		const target = metaPath(sessionId);
		const tmp = `${target}.tmp.${process.pid}`;
		fs.writeFileSync(tmp, JSON.stringify(data, null, 2));
		fs.renameSync(tmp, target);
	} catch (e) {
		debugLog(`writeMetaJson: failed: ${e instanceof Error ? e.message : String(e)}`);
	}
}

/** Read a meta file, returning null on any error (missing, malformed, etc.). */
export function readMetaJson(sessionId: string): Record<string, any> | null {
	try {
		const raw = fs.readFileSync(metaPath(sessionId), "utf-8");
		return JSON.parse(raw);
	} catch {
		return null;
	}
}

/** Update an existing meta file by merging fields (read-modify-write, atomic). */
export function updateMetaJson(sessionId: string, updates: Record<string, any>): void {
	try {
		const existing = readMetaJson(sessionId) ?? {};
		const merged = { ...existing, ...updates };
		writeMetaJson(sessionId, merged);
	} catch (e) {
		debugLog(`updateMetaJson: failed: ${e instanceof Error ? e.message : String(e)}`);
	}
}

// ── Recovery ownership ─────────────────────────────────────────────────────
//
// The session_start recovery scan re-attaches to subagent sockets left behind
// by a previous session. Before decision 027 it adopted EVERY socket with a
// matching meta file — including children owned by other, still-live pi
// processes. The adopted client connections kept the event loop referenced, so
// `pi -p` hung until a stranger's child finished, and that child's completion
// was delivered into the wrong session as "[Isolation] Recovered". The scan now
// gates adoption on the spawning process's identity, recorded at spawn:
//
//   ownerPid         the spawning process's pid
//   ownerStartToken  an OS start-time token, so a recycled pid is not mistaken
//                    for the original owner (pid reuse is real: see the peer
//                    note in decision 027)
//
// Adopt only when the owner is THIS process (a previous session in the same
// process — /reload, /new still hold the old socket server open) or the owner
// process is gone. A live FOREIGN owner means the child belongs to another
// session and must be left alone.
//
// Legacy metas (written before 027) carry no owner fields. Ownership cannot be
// established, so they are SKIPPED: adopting a stranger is the bug being fixed,
// while a false "owner alive" only skips a best-effort recovery — the safe
// direction.

export interface OwnerProbe {
	/** True while a process with this pid exists. */
	exists(pid: number): boolean;
	/** OS start-time token for the pid, or null when unavailable. */
	startToken(pid: number): string | null;
}

/** Default real-OS probe. `exists` uses signal 0; EPERM still means alive.
 *  Exported for unit testing. */
export const defaultOwnerProbe: OwnerProbe = {
	exists(pid: number): boolean {
		try {
			process.kill(pid, 0);
			return true;
		} catch (e) {
			return (e as NodeJS.ErrnoException)?.code === "EPERM";
		}
	},
	startToken(pid: number): string | null {
		return processStartToken(pid);
	},
};

/**
 * OS start-time token for a pid, used to make pid liveness pid-reuse-safe.
 * Linux: field 22 (`starttime`, clock ticks since boot) from /proc/<pid>/stat.
 * macOS/BSD: `ps -o lstart=` (1s resolution — good enough to separate a reused
 * pid, and the pid must still exist for a match to happen at all). Returns null
 * when the process is gone or the platform cannot report the token. Exported
 * for unit testing.
 */
export function processStartToken(pid: number, platform: string = process.platform): string | null {
	if (!Number.isInteger(pid) || pid <= 0) return null;
	try {
		if (platform === "linux") {
			const stat = fs.readFileSync(`/proc/${pid}/stat`, "utf-8");
			const close = stat.lastIndexOf(")");
			if (close < 0) return null;
			// After "pid (comm) " comes field 3 (state). starttime is field 22,
			// i.e. index 19 of the whitespace-split remainder.
			const fields = stat.slice(close + 2).trim().split(/\s+/);
			return fields[19] ?? null;
		}
		const out = execFileSync("ps", ["-o", "lstart=", "-p", String(pid)], {
			encoding: "utf-8",
			stdio: ["ignore", "pipe", "ignore"],
		});
		const token = out.trim();
		return token.length > 0 ? token : null;
	} catch {
		return null;
	}
}

/** Cached start token for THIS process, written into meta at spawn. Exported
 *  for unit testing. */
let selfStartTokenCache: string | null | undefined;
export function selfStartToken(): string | null {
	if (selfStartTokenCache === undefined) selfStartTokenCache = processStartToken(process.pid);
	return selfStartTokenCache;
}

/**
 * pid-reuse-safe "is the recorded owner still alive?" — pure over the injected
 * probe. The recorded start token must match the current one; a mismatch means
 * the pid was recycled and the original owner is gone. When the pid exists but
 * its current token cannot be read, assume ALIVE: skipping recovery is the safe
 * direction, adopting a stranger is not.
 *
 * A missing/invalid `ownerPid` also returns true — there is no recorded owner
 * to prove gone, so callers that use this predicate alone still fail safe.
 * (The legacy policy itself is `decideRecoveryAdoption`'s "skip-legacy".)
 * Exported for unit testing.
 */
export function isOwnerAlive(
	meta: Record<string, any> | null | undefined,
	probe: OwnerProbe = defaultOwnerProbe,
): boolean {
	const pid = meta?.ownerPid;
	if (!Number.isInteger(pid) || pid <= 0) return true; // no recorded owner → not provably gone
	if (!probe.exists(pid)) return false;
	const current = probe.startToken(pid);
	if (current === null) return true; // exists, token unknown → assume alive
	const recorded = meta?.ownerStartToken;
	if (typeof recorded !== "string" || recorded.length === 0) return true; // cannot disprove
	return current === recorded;
}

export type RecoveryAdoption = "adopt" | "skip-live-owner" | "skip-legacy";

/**
 * Decide whether the recovery scan may adopt the socket described by `meta`.
 * Pure and injectable so the adopt/skip matrix is unit-testable without
 * touching /tmp or the real OS.
 *
 * A same-process owner (pid === selfPid) is adopted even though it is alive:
 * the previous session in THIS process left the socket server running
 * (/reload, /new), and re-attaching to it is the recovery path the scan exists
 * for. A live FOREIGN owner is skipped — that is the stranger-adoption bug.
 * Exported for unit testing.
 */
export function decideRecoveryAdoption(
	meta: Record<string, any> | null | undefined,
	opts: { selfPid?: number; probe?: OwnerProbe } = {},
): RecoveryAdoption {
	const pid = meta?.ownerPid;
	if (!Number.isInteger(pid) || pid <= 0) return "skip-legacy";
	// pid === self: either our own previous session (adopt), or a recycled pid
	// whose original owner process is gone (also adopt). Both are safe, so the
	// start-token comparison is unnecessary for this branch.
	if (pid === (opts.selfPid ?? process.pid)) return "adopt";
	return isOwnerAlive(meta, opts.probe ?? defaultOwnerProbe) ? "skip-live-owner" : "adopt";
}

/** The non-owner fields persisted to the meta file at spawn. */
export interface SpawnMetaFields {
	agentName: string;
	task: string;
	cwd: string;
	startedAt: number;
	worktreePath: string | null;
	isolationBranch: string | null;
	parentHeadCommit: string | null;
	parentCwd: string;
	tools: string[];
	model: string;
	systemPrompt?: string;
	allowedSubagents: string[];
	excludeTools: string[];
	/** Set when the spawn opened a work-order record; resume and recovery complete it. */
	workRecord?: WorkRecord;
}

/**
 * Build the meta payload written at spawn, stamping the spawning process's
 * identity (`ownerPid` + `ownerStartToken`) that `decideRecoveryAdoption`
 * reads. Extracted so the owner stamp is unit-testable: if these fields are
 * dropped, every new meta degrades to legacy and recovery silently stops.
 * Exported for unit testing.
 */
export function buildSpawnMeta(
	fields: SpawnMetaFields,
	owner: { pid: number; startToken: string | null } = { pid: process.pid, startToken: selfStartToken() },
): Record<string, any> {
	return { ...fields, ownerPid: owner.pid, ownerStartToken: owner.startToken };
}

/**
 * Strip the display prefix from a session-id query. Callers pass ids in four
 * shapes — `subagent-<uuid>`, a bare `<uuid>`, or either truncated to an 8+
 * character tail. Matching is a suffix test against the stored full id, so the
 * prefix must go first: `subagent-c3587cc8c12e` was not a suffix of
 * `subagent-ac5fe548-…-c3587cc8c12e` while the bare `c3587cc8c12e` was, and the
 * miss surfaced as "No running subagent found" — read as death, which cost two
 * live worktrees to a peer's force-reap (2026-10-07).
 * Exported for unit testing.
 */
export function normalizeIdQuery(s: string): string {
	return s.replace(/^subagent-/, "");
}

/**
 * True when a stored session id matches a user-supplied query. Both stores key
 * by the full `subagent-<uuid>` handle — the running map directly, and meta
 * files named `pi-subagent-<handle>.meta.json` — so a query matches when it is
 * a suffix of the handle (`-ac5fe548-…-c3587cc8c12e`, a `subagent-`-prefixed
 * tail) or of the handle with that prefix stripped (a bare tail). Surrounding
 * whitespace is ignored; an empty query matches nothing, since every id is a
 * superset of the empty string.
 * @for-testing-only — pure
 */
export function idMatchesQuery(storedId: string, query: string): boolean {
	const q = query.trim();
	const needle = normalizeIdQuery(q);
	if (needle.length === 0) return false; // empty query must not match every id
	return storedId.endsWith(q) || normalizeIdQuery(storedId).endsWith(needle);
}

/**
 * Match a session query against the running map. Shared by /watch and /attach
 * so both accept the same forms, and backed by `idMatchesQuery` — the one
 * definition of what an id query means (the /tmp meta scan uses it too).
 * @for-testing-only — pure over the injected map
 */
export function findRunningByQuery(
	runningMap: Map<string, RunningSubagent>,
	query: string,
): RunningSubagent | undefined {
	for (const [id, rs] of runningMap) {
		if (idMatchesQuery(id, query)) return rs;
	}
	return undefined;
}

/**
 * Resolve a subagent session ID from a full or partial (last 8+ chars)
 * identifier. Scans /tmp/pi-subagent-*.meta.json and matches on the
 * session id portion (the part between "pi-subagent-" and ".meta.json").
 * Returns the full session ID and meta if exactly one match; null if none;
 * throws with an ambiguity list if multiple match.
 */
export function resolveSubagentMeta(sessionId: string): { sid: string; meta: Record<string, any> } | null {
	let files: string[];
	try {
		files = fs.readdirSync("/tmp").filter(
			(f) => f.startsWith("pi-subagent-") && f.endsWith(".meta.json"),
		);
	} catch {
		return null;
	}

	// Extract the session id portion from the filename. `idMatchesQuery` owns the
	// empty-query guard, so this loop needs no separate one.
	const candidates: Array<{ sid: string; meta: Record<string, any> }> = [];
	for (const f of files) {
		const sid = f.replace("pi-subagent-", "").replace(".meta.json", "");
		if (idMatchesQuery(sid, sessionId)) {
			const meta = readMetaJson(sid);
			if (meta) candidates.push({ sid, meta });
		}
	}

	if (candidates.length === 0) return null;
	if (candidates.length === 1) return candidates[0];

	// Ambiguous partial match — list candidates
	const ids = candidates.map((c) => c.sid).join(", ");
	throw new Error(
		`Ambiguous partial session id "${sessionId}" matches multiple sessions: ${ids}. ` +
			`Use a longer suffix or the full id.`,
	);
}

/**
 * Not-found message for the tracker-based tools. Distinguishes an id that
 * matches nothing from a session that exists on disk but is not attached to
 * this process — the two used to share one sentence, so a live child queried
 * with a slightly-off id read as dead. Reports the disk facts (branch,
 * worktree, log) and whether the recorded owner process is still alive.
 * Exported for unit testing.
 */
export function describeUnknownSession(idQuery: string): string {
	let resolved: { sid: string; meta: Record<string, any> } | null = null;
	try {
		resolved = resolveSubagentMeta(idQuery);
	} catch (error) {
		return error instanceof Error ? error.message : String(error);
	}
	if (!resolved) {
		return (
			`No session matches "${idQuery}". Pass the full id (subagent-<uuid>) or its last 8+ characters ` +
			`(with or without the subagent- prefix); /subagents lists this session's running children.`
		);
	}

	const { sid, meta } = resolved;
	const parts = [`Session ${sid} is not attached to this session's tracker.`];
	const recordedPid = meta.ownerPid;
	const sock = `/tmp/pi-subagent-${sid}.sock`;
	// Report the facts that were checked, never a fact the code did not observe.
	// The old single sentence ("No running subagent found") read as death and got
	// live worktrees force-reaped, so the state must stay legible from the text:
	// whether a socket file is present, whether an owner was recorded, and
	// whether that owner is still alive. `isOwnerAlive` alone returns true for a
	// legacy meta with no owner, which would render "pid undefined is alive".
	const hasRecordedOwner = Number.isInteger(recordedPid) && recordedPid > 0;
	const ownerAlive = hasRecordedOwner ? isOwnerAlive(meta) : undefined;
	const sockExists = fs.existsSync(sock);
	const sockFact = sockExists
		? `a socket file exists at ${sock}`
		: `no socket file exists at ${sock}`;
	const ownerFact = hasRecordedOwner
		? `its recorded owner process (pid ${recordedPid}) is ${ownerAlive ? "still running" : "gone"}`
		: "no owner process was recorded for it";

	if (sockExists && ownerAlive === true) {
		parts.push(
			`Running under another session (owner pid ${recordedPid}) — query it there or use /subagents in that session.`,
		);
	} else {
		// No claim about the child's state beyond the two observed facts: a
		// leftover socket file with a dead owner is common, and only the owner
		// session can settle whether the child is still there.
		parts.push(`Not attached here: ${sockFact}, and ${ownerFact}.`);
	}
	if (meta.isolationBranch) parts.push(`Branch: ${meta.isolationBranch}.`);
	if (meta.worktreePath) parts.push(`Worktree: ${meta.worktreePath}.`);
	parts.push(`Log: /tmp/pi-subagent-${sid}.log`);
	return parts.join(" ");
}

/**
 * The working directory pi recorded in a session file's header, or null when
 * the file is unreadable or carries no cwd. pi refuses to resume a session
 * whose stored cwd is missing, and in rpc mode there is no prompt to choose a
 * replacement — the child exits 1 before its first turn.
 * @for-testing-only — pure over the filesystem
 */
export function readSessionCwd(sessionFile: string): string | null {
	try {
		const fd = fs.openSync(sessionFile, "r");
		let buf: Buffer;
		try {
			// The header is the first line; 16KB is far beyond its real size and
			// avoids reading a multi-megabyte transcript to reach it.
			buf = Buffer.alloc(16 * 1024);
			const n = fs.readSync(fd, buf, 0, buf.length, 0);
			buf = buf.subarray(0, n);
		} finally {
			fs.closeSync(fd);
		}
		const firstLine = buf.toString("utf-8").split("\n", 1)[0];
		const header = JSON.parse(firstLine);
		// Mirror pi's header acceptance (parseSessionHeaderCandidate: type
		// "session" + a string id). A line 1 that pi does not recognize as the
		// header is not what pi reads the cwd from — it falls back to its own
		// cwd — so refusing on that cwd could block a resume pi would accept.
		if (header?.type !== "session" || typeof header.id !== "string") return null;
		return typeof header.cwd === "string" && header.cwd.trim() ? header.cwd : null;
	} catch {
		return null;
	}
}

/**
 * Validate a meta object read from disk for resume. Returns either
 * { ok: true } or { ok: false, error, isError }. Module scope so tests can
 * cover every error path without spawning real processes.
 * @for-testing-only — pure over the filesystem
 */
export function validateResumeMeta(
	meta: Record<string, any> | null,
	sid: string,
): { ok: true } | { ok: false; error: string; isError: boolean } {
	if (!meta) {
		return {
			ok: false,
			error: `No prior session found with id "${sid}". The session may have been purged or never existed. Spawn a fresh subagent instead.`,
			isError: false,
		};
	}
	if (!meta.sessionFile) {
		return {
			ok: false,
			error: `Session file not captured for "${sid}". The original subagent may have crashed before reporting its session. Spawn a fresh subagent instead.`,
			isError: true,
		};
	}
	if (!fs.existsSync(meta.sessionFile)) {
		return {
			ok: false,
			error: `Session file ${meta.sessionFile} no longer exists. Cannot resume.`,
			isError: true,
		};
	}
	// The stored cwd, not the spawn cwd, is what pi validates when the session
	// file is opened. A missing one kills the child at startup, so say why and
	// name the two ways out instead of reporting a 0-turn child that exited 1.
	const storedCwd = readSessionCwd(meta.sessionFile);
	if (storedCwd && !fs.existsSync(storedCwd)) {
		return {
			ok: false,
			error:
				`Cannot resume: the session's recorded working directory no longer exists.\n` +
				`  recorded cwd: ${storedCwd}\n` +
				`pi refuses to resume a session whose stored cwd is missing, and rpc mode has no prompt to pick another (the child would exit 1 before its first turn).\n` +
				`Recreate it and retry:  mkdir -p "${storedCwd}"\n` +
				`Or point it at a live checkout:  ln -s "<checkout>" "${storedCwd}"`,
			isError: true,
		};
	}
	return { ok: true };
}

/**
 * Resolve an orchestrator-supplied parent_session_id to the actual tracker
 * key. The orchestrator passes the RPC handle returned by the subagent
 * dispatch (e.g. `subagent-81f2a34c-...`). Since the handle is passed to
 * the child as `--session-id`, it IS the child's pi session id (meta
 * persists the same value from get_state) — so this is effectively the
 * identity, kept as a safety net for legacy meta files written before the
 * ids were unified.
 *
 * If the arg looks like an RPC handle, look up the meta file and return
 * meta.piSessionId if it's a non-empty string. Otherwise (no meta, malformed
 * meta, missing piSessionId, arg isn't a handle) return the arg unchanged —
 * preserves prior behavior for direct piSessionId args and handles called
 * before get_state fired.
 */
export function resolveTrackerKey(requestedId: string): string {
	// Detection: starts with "subagent-" followed by at least 8 hex/dash chars
	if (!/^subagent-[0-9a-f-]{8,}$/i.test(requestedId)) {
		return requestedId;
	}
	try {
		const meta = readMetaJson(requestedId);
		if (meta && typeof meta.piSessionId === "string" && meta.piSessionId.length > 0) {
			return meta.piSessionId;
		}
	} catch {
		// Swallow all errors — fall through to return requestedId unchanged
	}
	return requestedId;
}

// ── Progress tracking ───────────────────────────────────────────────────────

interface SubagentProgress {
	turns: number;
	filesRead: Set<string>;
	filesModified: Set<string>;
	lastActions: string[]; // last 5 tool calls, newest last
	errors: string[];
	currentActivity: string;
}

interface UsageStats {
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	cost: number;
	latestCacheHitRate: number | undefined;
}

interface RunningSubagent {
	proc: ChildProcess;
	sessionId: string;
	agentName: string;
	task: string;
	cwd: string;
	startedAt: number;
	progress: SubagentProgress;
	messages: any[]; // accumulated messages for final output
	stdin: NodeJS.WritableStream | null;
	resolveOnStop: ((finalMessage?: string) => void) | null; // set by stop tool
	isDone: boolean;
	// Set in proc.on("exit") — the earliest reliable signal that the child
	// process has died. The running-map entry only disappears in the later
	// close handler, so guards on the map alone leave a window where a
	// steer can be "sent" into a dead pipe. Check this (and stdin state)
	// before any stdin write.
	procExited: boolean;
	// Set by the `subagent_kill` tool before it dispatches SIGTERM/SIGKILL
	// so the close handler can label the footer "Killed" and prepend a
	// `[Killed via subagent_kill ...]` marker to the delivered result.
	// Set BEFORE `proc.kill(...)` so the close handler observes it; tool is
	// idempotent on the second call (no-op when already true). Not set by
	// `subagent_stop` — that path uses the regular `Stopped` footer and
	// resolves the waiter directly without delivering as a user message.
	killedExplicitly: boolean;
	// Set by the `subagent_stop` tool BEFORE it dispatches the wrap-up
	// steer so the review-gate soft-prompt block (msg_end handler) can tell
	// the final text-only message that follows a stop apart from a normal
	// completion. An explicit stop means "wrap up and report, do not start
	// new work" — so the post-implementation review soft-prompt (which
	// would re-enter the agent loop to launch reviewers) is suppressed and
	// the subagent is allowed to exit cleanly. The orchestrator's
	// mechanical `subagent_review_status` gate is report-driven (it keys
	// off an implementer `complete` report, not a `subagent_stop` result),
	// so a stopped result is never gated on either.
	stoppedExplicitly: boolean;
	turnNudged: boolean; // one-shot flag: soft 450-turn wrap-up nudge already sent
	logPath: string;   // live human-readable event log
	logLines: string[];     // in-memory buffer for live TUI widget
	stderrLines: string[];  // captured stderr from the child pi process;
	                        // surfaced in the delivered result when the
	                        // child exits before completing any turn so
	                        // the orchestrator can see *why* it failed
	                        // instead of just "exit 1, 0 turns".
	watchHandle: any;       // setWidget handle for live updates
	sockPath: string;       // Unix socket path for external viewers
	sockServer: net.Server; // socket server
	sockClients: Set<net.Socket>; // connected viewers
	// Reviewer invocation guard: the parent agent's declared requirements.
	// Empty / undefined means "no gate applies" (the soft-prompt check is a no-op).
	reviewParentRequirements?: ReviewerKind[];
	workRecord?: WorkRecord; // set when the spawn passed workOrderPath (decisions/work-order-records/001)
	recordNotes?: string[]; // failed record writes, surfaced in status and the delivered result
	// Worktree isolation
	worktreePath: string | null;
	isolationBranch: string | null;
	parentHeadCommit: string | null;
	parentCwd: string;
	// Snapshot of the parent's state carried into the worktree (WO-2026-035).
	// preCommitSteps compares the worktree against it to skip committing files
	// the subagent never touched. In-memory only: if the parent restarts and
	// orphans the subagent, this is lost and the filter degrades to committing
	// everything staged (best-effort). Null when no carry happened
	// (carryUncommitted:false / baseRef / no worktree).
	carried: CarriedSnapshot | null;
	// Cached parent tracker key (session id or `pid:<pid>` fallback) for the
	// soft-prompt guard and the cross-process persisted status file. Computed
	// at spawn time when ctx is available; reused at stop time when ctx is
	// out of scope inside the message_end handler.
	parentTrackerKey: string;
	// Cumulative token/cost usage stats for the subagent
	usageStats: UsageStats;
	// Captured from the child's RPC get_state response; set once after spawn.
	// Used by subagent_resume to locate the session file for later continuation.
	sessionFile?: string;
	piSessionId?: string;
	// Stalled-turn watchdog timer. Resets on every assistant message_end
	// and on tool_execution_end; fires a wake-up steer message after
	// SUBAGENT_STALE_TURN_MS.
	staleTimer: NodeJS.Timeout | null;
	// Count of tool calls currently in flight (tool_execution_start increments,
	// tool_execution_end decrements). Lets the stalled-turn watchdog tell a
	// genuinely-idle child from one mid-way through a long tool call (build,
	// grep, deep read) that hasn't produced an assistant message yet — the
	// latter gets a softened "working" notice instead of a "stalled" alarm.
	toolInFlight: number;
	// Decision 015 stage-2: last-activity timestamp — updated on any log
	// line written to the child's log, tool_execution_start/end, and
	// assistant message_end. The silence-kill timer compares this to
	// silenceTimeoutMs to tell a hung child from a slow-but-healthy one.
	lastActivityMs: number;
	// Stage-2 silence-kill timer handle. Cleaned up in the same teardown as
	// the stage-1 watchdog (close handler + kill dispatch). Null when
	// disabled or not armed.
	silenceTimer: NodeJS.Timeout | null;
	// Resolved stage-2 timeout for this child (undefined → 30-min default;
	// 0/negative/NaN → disabled). Per-spawn; no global setting.
	silenceTimeoutMs: number;
	// Kill source for the delivered marker: "kill-tool" (subagent_kill),
	// "progress-timeout" (stage-2 auto-kill), or "turn-limit" (the
	// MAX_TURNS_HARD stop). Null until killedExplicitly.
	killedVia: "kill-tool" | "progress-timeout" | "turn-limit" | null;
}

const running = new Map<string, RunningSubagent>();
/** @internal test hook — allows tests to inject entries into the running map. */
export const _testRunning = running;

// ── Live-session ctx ───────────────────────────────────────────────────────
//
// The ctx of the currently-live pi session, or null when no session is live
// (print-mode dispose, reload, quit). Async subagent callbacks — the child's
// socket `data` handler, its process close handler, stale-turn timers —
// outlive the turn that spawned them, so they must never use a captured
// spawn-time ctx: pi invalidates it when the session ends and any `ctx.ui`
// access then throws "This extension ctx is stale after session replacement
// or reload", which crashes the process from inside a socket handler. Set in
// `session_start`; cleared in `session_shutdown`, which pi emits BEFORE
// `ExtensionRunner.invalidate` — see
// decisions/subagents/026-subagent-events-after-session-disposal.md.
let liveSessionCtx: any = null;

/** @internal test hook — the live-session ctx (null when no session is live). */
export function _testLiveSessionCtx(): any {
	return liveSessionCtx;
}

/** @internal test hook — set/clear the live-session ctx without a real pi
 *  session. Mirrors the `session_start`/`session_shutdown` lifecycle for
 *  tests that exercise delivery against a live session. */
export function _testSetLiveSessionCtx(ctx: any): void {
	liveSessionCtx = ctx;
}

/** @internal test hook — override the directory the real `session_start`
 *  recovery scan reads (defaults to /tmp). Lets a test fire the captured
 *  handler and observe adoption without touching real /tmp. */
let recoveryScanDirOverride: string | undefined;
export function _testSetRecoveryScanDir(dir: string | undefined): void {
	recoveryScanDirOverride = dir;
}

// Active wait timer — set when `wait` is called with the optional `seconds`
// parameter. We hold a single module-level handle because at most one wait
// can be active at a time (the tool terminates the turn, so the next call
// only happens after a wake-up). The timer fires a wake-up steer message
// after N seconds if no subagent has completed; we cancel it from the
// subagent close handler so a completing subagent doesn't get followed
// by a redundant "still running" wakeup.
// Sleep guard state (decision 015 fix). One heartbeat for all running
// children; one caffeinate assertion for the running set's lifetime.
let heartbeatTimer: NodeJS.Timeout | null = null;
let lastHeartbeatMs = 0;
let caffeinateProc: ChildProcess | null = null;

let activeWaitTimer: NodeJS.Timeout | null = null;

function clearActiveWait(): void {
	if (activeWaitTimer) {
		clearTimeout(activeWaitTimer);
		activeWaitTimer = null;
	}
}

/**
 * Resolve a session id to a RunningSubagent by exact match first, then
 * partial match via resolveSubagentMeta. Returns the RunningSubagent if
 * found, null otherwise.
 * @throws {Error} If resolveSubagentMeta finds multiple meta files matching
 *   the partial suffix (ambiguous match). The caller should let this
 *   propagate — the pi tool framework surfaces it as an informative error
 *   response telling the user to use a longer suffix.
 */
export function resolveRunningSession(sessionId: string): RunningSubagent | null {
	const exact = running.get(sessionId);
	if (exact) return exact;
	const r = resolveSubagentMeta(sessionId);
	if (!r) return null;
	return running.get(r.sid) ?? null;
}

// ── Attach state ────────────────────────────────────────────────────────────

let attachedSessionId: string | null = null;
let _attachCtx: any = null; // captured from /attach command for editor-internal notify

/** @internal test hook — set/clear the attach state without driving /attach. */
export function _testSetAttachState(sessionId: string | null, ctx: any = null): void {
	attachedSessionId = sessionId;
	_attachCtx = ctx;
}

/** @internal test hook — the currently attached session id (null when detached). */
export function _testAttachSessionId(): string | null {
	return attachedSessionId;
}

function newProgress(): SubagentProgress {
	return {
		turns: 0,
		filesRead: new Set(),
		filesModified: new Set(),
		lastActions: [],
		errors: [],
		currentActivity: "starting...",
	};
}

// ── Helpers ─────────────────────────────────────────────────────────────────

/** Run a git command and collect output. */
function git(args: string[], cwd: string): Promise<{ stdout: string; stderr: string; exitCode: number }> {
	return new Promise((resolve) => {
		const proc = spawn("git", args, { cwd, stdio: ["ignore", "pipe", "pipe"] });
		let stdout = "";
		let stderr = "";
		proc.stdout.on("data", (d: Buffer) => { stdout += d.toString(); });
		proc.stderr.on("data", (d: Buffer) => { stderr += d.toString(); });
		proc.on("close", (code) => resolve({ stdout, stderr, exitCode: code ?? 1 }));
		proc.on("error", () => resolve({ stdout, stderr, exitCode: 1 }));
	});
}

function getPiInvocation(args: string[]): { command: string; args: string[] } {
	const currentScript = process.argv[1];
	const isBunVirtualScript = currentScript?.startsWith("/$bunfs/root/");
	if (currentScript && !isBunVirtualScript && fs.existsSync(currentScript)) {
		return { command: process.execPath, args: [currentScript, ...args] };
	}
	const execName = path.basename(process.execPath).toLowerCase();
	const isGenericRuntime = /^(node|bun)(\.exe)?$/.test(execName);
	if (!isGenericRuntime) return { command: process.execPath, args };
	return { command: "pi", args };
}

// ── Worktree isolation ────────────────────────────────────────────────────

/** Create an isolated git worktree on a branch off the parent HEAD (or optional baseRef).
 *  Returns null if the cwd is not a git repo or worktree creation fails. */
async function createWorktree(
	parentCwd: string,
	sessionId: string,
	baseRef?: string,
	carryUncommitted: boolean = true,
): Promise<{ worktreePath: string; branchName: string; parentHeadCommit: string; carried?: CarriedSnapshot } | null> {
	const t0 = PI_ASYNC_DEBUG ? Date.now() : 0;
	try {
		const baseCommitRef = baseRef || "HEAD";

		// Run the two independent rev-parse calls concurrently.
		// NOTE: `topLevelResult` is the git() RESULT OBJECT {stdout, stderr,
		// exitCode}; the repo path string must be extracted via .stdout.trim()
		// before passing it around. Passing the object as a path silently kills
		// the carry overlay (spawn cwd invalid → best-effort catch swallows) —
		// caught by real-dispatch E2E, not by the mirror tests.
		const [topLevelResult, headResult] = await Promise.all([
			git(["rev-parse", "--show-toplevel"], parentCwd),
			git(["rev-parse", baseCommitRef], parentCwd),
		]);
		if (PI_ASYNC_DEBUG) debugLog(`createWorktree: rev-parse (parallel): ${Date.now() - t0}ms`);

		if (topLevelResult.exitCode !== 0) return null;
		if (headResult.exitCode !== 0) return null;
		const parentHeadCommit = headResult.stdout.trim();
		const topLevel = topLevelResult.stdout.trim();

		const suffix = sessionId.slice(-12);
		const branchName = `pi-subagent-${suffix}`;
		const worktreePath = path.join(os.tmpdir(), `pi-subagent-wt-${suffix}`);

		// Remove stale leftovers from a previous run with the same session id.
		// `sessionId` is a fresh randomUUID slice per spawn and createWorktree is
		// only called on fresh spawns (subagent_resume passes nulls), so there is
		// normally nothing on disk to clean — skip the two git subprocesses when
		// the directory does not exist. When it does, both independent best-effort
		// cleanups still run concurrently, unchanged.
		const tCleanup = PI_ASYNC_DEBUG ? Date.now() : 0;
		if (fs.existsSync(worktreePath)) {
			await Promise.allSettled([
				git(["worktree", "remove", "--force", worktreePath], parentCwd),
				git(["branch", "-D", branchName], parentCwd),
			]);
		}
		if (PI_ASYNC_DEBUG) debugLog(`createWorktree: stale-cleanup (parallel): ${Date.now() - tCleanup}ms`);

		// The carry status only reads the parent tree, so it can be fetched while
		// the worktree materializes below. `git()` never rejects (it resolves with
		// exitCode: 1 on spawn failure), so an unconsumed prefetch (worktree add
		// failed, or the carry gate changed) cannot become an unhandled rejection.
		const carryStatusPromise =
			carryUncommitted && !baseRef
				? git(["status", "--porcelain=v1", "-uall", "-z"], topLevel)
				: undefined;

		// worktree add must be last and fatal on failure.
		const tAdd = PI_ASYNC_DEBUG ? Date.now() : 0;
		const wtResult = await git(
			["worktree", "add", worktreePath, "-b", branchName, parentHeadCommit],
			parentCwd,
		);
		if (PI_ASYNC_DEBUG) debugLog(`createWorktree: worktree add: ${Date.now() - tAdd}ms`);
		if (wtResult.exitCode !== 0) return null;

		// Best-effort overlay of the parent's uncommitted state; a failure
		// degrades to the plain HEAD-only worktree, never fails the dispatch.
		// `carried` is present (possibly empty map) when the overlay ran,
		// absent when skipped (carryUncommitted:false / baseRef) or when the
		// overlay threw. In-memory only — no persistence.
		let carried: CarriedSnapshot | undefined;
		if (carryUncommitted && !baseRef) {
			const tCarry = PI_ASYNC_DEBUG ? Date.now() : 0;
			try {
				carried = await carryUncommittedState(topLevel, worktreePath, carryStatusPromise);
			} catch (e: any) {
				debugLog(`createWorktree: carry failed — degrading to HEAD-only: ${e.message || e}`);
			}
			if (PI_ASYNC_DEBUG) debugLog(`createWorktree: carry: ${Date.now() - tCarry}ms`);
		}

		if (PI_ASYNC_DEBUG) debugLog(`createWorktree: total: ${Date.now() - t0}ms`);
		return {
			worktreePath,
			branchName,
			parentHeadCommit,
			...(carried !== undefined ? { carried } : {}),
		};
	} catch {
		return null;
	}
}

/** Per-path snapshot of the carried state; the completion filter compares
 *  the worktree against this to find files the subagent never touched. */
type CarriedEntry = { state: "present"; hash: string } | { state: "absent" };
type CarriedSnapshot = Map<string, CarriedEntry>;

/** sha256 hex of a file's bytes, or `"link:" + target` for a symlink,
 *  or null when the path is absent / not a regular file or symlink.
 *  Single source of truth for the carry snapshot hashes — used by both
 *  carryUncommittedState (capture) and the preCommitSteps completion filter
 *  (compare). Async (fs.promises) so the spawn path never blocks the event
 *  loop on file I/O. Mirrored identically by test-completion-filter.cjs —
 *  keep in sync. */
async function hashCarriedFile(absPath: string): Promise<string | null> {
	try {
		const st = await fs.promises.lstat(absPath);
		if (st.isSymbolicLink()) return "link:" + (await fs.promises.readlink(absPath));
		if (!st.isFile()) return null;
		return createHash("sha256").update(await fs.promises.readFile(absPath)).digest("hex");
	} catch {
		return null;
	}
}

/** Best-effort overlay of the parent's uncommitted working-tree state
 *  (untracked, modified, staged, deleted, renamed, copied) into a fresh
 *  worktree, preserving exec bits and symlinks-as-links. Read-only on the
 *  parent (single `git status`); writes only under `worktreePath`. Never
 *  returns null: a fresh empty map when `git status` fails or there are no
 *  changes. fs-level overlay failures still throw and are caught by the
 *  caller (createWorktree), which degrades to the plain HEAD-only worktree.
 *  Each carried path is recorded in the returned CarriedSnapshot: sha256 of
 *  the exact bytes written into the worktree (computed via hashCarriedFile,
 *  the shared async helper — bytes copied via fs.promises.copyFile and hashed
 *  separately), `"link:"` + target for symlinks, `absent` for carried
 *  deletions; `.git`/unsafe paths are skipped and absent from the snapshot.
 *  Mirrored by test-carry-uncommitted.cjs and test-completion-filter.cjs —
 *  keep in sync.
 *
 *  `statusPromise` may be prefetched by the caller (createWorktree) to overlap
 *  `git status` with `git worktree add`; when omitted, the status is fetched
 *  here. Per-entry ordering (rename delete → copy, etc.) is preserved. */
async function carryUncommittedState(
	topLevel: string,
	worktreePath: string,
	statusPromise?: Promise<{ stdout: string; stderr: string; exitCode: number }>,
): Promise<CarriedSnapshot> {
	// Fail-fast: a non-string here means the caller passed the git() result
	// object instead of the extracted path (see createWorktree). Throwing makes
	// the caller's best-effort catch log it instead of silently no-oping.
	if (typeof topLevel !== "string" || topLevel.length === 0) {
		throw new TypeError("carryUncommittedState: topLevel must be the repo path string");
	}
	const snapshot: CarriedSnapshot = new Map();
	const res = await (statusPromise ?? git(["status", "--porcelain=v1", "-uall", "-z"], topLevel));
	if (res.exitCode !== 0) return snapshot;

	// Record a present-entry for a path just copied into the worktree.
	// If hashing fails (path gone / not a regular file), the path is left
	// out of the snapshot — the filter then treats it as touched, which
	// degrades to today's commit-everything behavior.
	const recordPresent = async (rel: string) => {
		const hash = await hashCarriedFile(path.join(worktreePath, rel));
		if (hash !== null) snapshot.set(rel, { state: "present", hash });
	};

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
			await recordPresent(p);
			continue;
		}
		if (x === "D" || y === "D") {
			fs.rmSync(path.join(worktreePath, p), { recursive: true, force: true });
			snapshot.set(p, { state: "absent" });
			continue;
		}
		if (x === "?" && y === "?") {
			await copyCarriedFile(topLevel, worktreePath, p);
			await recordPresent(p);
			continue;
		}
		if (x === "M" || x === "A" || x === "T" || x === "U" || y === "M" || y === "A" || y === "T" || y === "U") {
			if (fs.existsSync(path.join(topLevel, p))) {
				await copyCarriedFile(topLevel, worktreePath, p);
				await recordPresent(p);
			}
		}
	}
	return snapshot;
}

/** Paths come from git and are trusted, but assert-skip anything odd anyway. */
function unsafeCarryPath(p: string): boolean {
	return p.length === 0 || p.includes("..") || p === ".git" || p.startsWith(".git/");
}

/** Copy one file (or symlink-as-link) from the parent tree into the worktree,
 *  preserving the exec bit. Submodule gitlink dirs are skipped — a known
 *  limitation, submodule contents are not carried. */
async function copyCarriedFile(topLevel: string, worktreePath: string, rel: string): Promise<void> {
	const src = path.join(topLevel, rel);
	const dst = path.join(worktreePath, rel);
	await fs.promises.mkdir(path.dirname(dst), { recursive: true });
	const st = await fs.promises.lstat(src);
	if (st.isSymbolicLink()) {
		await fs.promises.symlink(await fs.promises.readlink(src), dst);
	} else if (st.isDirectory()) {
		return;
	} else {
		await fs.promises.copyFile(src, dst);
		await fs.promises.chmod(dst, st.mode & 0o7777);
	}
}

/** First non-empty line of a task, truncated to a git commit subject.
 *  Handles multi-line work-order tasks without dumping the body into `-m`.
 *  Callers must pass the CLEAN task identity (never the worktree-isolation
 *  preamble wrapper) — see decisions/subagents/009-clean-task-identity.md. */
function subjectFromTask(task: string): string {
	const firstLine = task.split("\n").map((l) => l.trim()).find((l) => l.length > 0);
	return (firstLine ?? "(no task)").slice(0, 72);
}

/** Pre-delivery commit steps: stage, commit, and capture the final commit
 *  hash. Runs BEFORE deliverResult so the parent sees the result immediately.
 *  Returns a status note for the delivered result plus metadata for post-delivery
 *  cleanup. Never throws — failures produce an error note and worktree is left
 *  for inspection (same as the existing failure path). */
async function preCommitSteps(rs: RunningSubagent): Promise<{
	note: string;
	finalCommit: string;
	hadChanges: boolean;
}> {
	const notes: string[] = [];
	const { worktreePath, isolationBranch, parentHeadCommit } = rs;
	if (!worktreePath || !isolationBranch || !parentHeadCommit) {
		return { note: "", finalCommit: "", hadChanges: false };
	}

	const t0 = PI_ASYNC_DEBUG ? Date.now() : 0;

	try {
		// Stage and commit any uncommitted changes in the worktree.
		await git(["add", "-A"], worktreePath);
		// Unstage scratch/work-order docs so the auto-commit doesn't leak them
		// into the branch. Dispatch work orders are committed under work-orders/
		// (see agents/orchestrator.md), so this is defense-in-depth against stray
		// WO-*.md scratch copies rather than the primary mechanism (007 validation
		// finding F4 — a 290-line WO doc leaked into the repo this way).
		const stagedNames = (await git(["diff", "--cached", "--name-only"], worktreePath)).stdout;
		const scratch = stagedNames.split("\n").filter((p) => p.length > 0 && /^WO-.*\.md$/i.test(p));
		if (scratch.length > 0) {
			await git(["reset", "-q", "--", ...scratch], worktreePath);
		}

		// Carried files that are byte-identical to what was carried in are
		// the parent's state, not the subagent's work — don't commit them.
		// `git reset -q -- <rel>` restores the index entry for that path to
		// HEAD, so it also unstages carried *deletions* (file absent on the
		// branch). Args-array call handles paths with spaces. Any failure
		// inside the loop degrades via debugLog — never abort preCommitSteps.
		// Mirrored by test-completion-filter.cjs — keep in sync.
		const carried = rs.carried;
		if (carried && carried.size > 0) {
			const untouched: string[] = [];
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
			} catch (e: any) {
				if (PI_ASYNC_DEBUG) debugLog(`preCommitSteps: carry filter failed — continuing with untouched list: ${e.message || e}`);
			}
			if (untouched.length > 0) {
				await git(["reset", "-q", "--", ...untouched], worktreePath);
			}
		}

		const diffResult = await git(["diff", "--cached", "--quiet"], worktreePath);
		if (diffResult.exitCode !== 0) {
			const commitMsg = `subagent(${rs.agentName}): ${subjectFromTask(rs.task)}`;
			await git(["commit", "-m", commitMsg], worktreePath);
			notes.push(`Uncommitted changes auto-committed to \`${isolationBranch}\`.`);
		}

		// Check whether the branch has diverged from the parent HEAD
		const finalHead = await git(["rev-parse", "HEAD"], worktreePath);
		const finalCommit = finalHead.stdout.trim();
		const hadChanges = diffResult.exitCode !== 0;

		// The branch is worth merging iff it carries commits beyond the parent —
		// either a harness auto-commit (hadChanges) OR the subagent's OWN commit
		// (observed 2026-08-08: a Threefry-removal subagent ran `git commit` itself
		// before completing, leaving nothing staged, so hadChanges was false even
		// though the branch HEAD had moved past the parent — and postDeliveryCleanup
		// then deleted the branch, orphaning the work). Keying the merge hint on the
		// real invariant (finalCommit !== parentHeadCommit) covers both cases.
		if (finalCommit !== parentHeadCommit) {
			notes.push(`Changes preserved on branch \`${isolationBranch}\`.`);
			notes.push(`Merge with: \`git merge ${isolationBranch}\``);
		}

		if (PI_ASYNC_DEBUG) debugLog(`preCommitSteps: ${Date.now() - t0}ms (hadChanges=${hadChanges})`);

		return {
			note: notes.length > 0 ? `\n\n[Isolation] ${notes.join(" ")}` : "",
			finalCommit,
			hadChanges,
		};
	} catch (e: any) {
		notes.push(`Worktree commit error: ${e.message || e}`);
		if (PI_ASYNC_DEBUG) debugLog(`preCommitSteps: FAILED after ${Date.now() - t0}ms: ${e.message || e}`);
		return {
			note: notes.length > 0 ? `\n\n[Isolation] ${notes.join(" ")}` : "",
			finalCommit: "",
			hadChanges: false,
		};
	}
}

/** Post-delivery cleanup: remove the worktree directory and delete the branch
 *  when no changes were committed. Runs async after deliverResult; failures are
 *  logged and surfaced as a steer warning, never fatal. */
async function postDeliveryCleanup(
	pi: ExtensionAPI,
	rs: RunningSubagent,
	finalCommit: string,
	hadChanges: boolean,
): Promise<void> {
	const { worktreePath, isolationBranch, parentHeadCommit, parentCwd } = rs;
	if (!worktreePath || !isolationBranch || !parentHeadCommit) return;

	const t0 = PI_ASYNC_DEBUG ? Date.now() : 0;

	try {
		// Remove the worktree directory (branch ref stays in the repo)
		await git(["worktree", "remove", "--force", worktreePath], parentCwd);

		if (finalCommit === parentHeadCommit) {
			// Branch still at the parent commit — nothing new was committed (by the
			// harness OR by the subagent itself), so delete it. hadChanges alone is
			// NOT a safe signal: a subagent that committed its own work leaves
			// nothing staged, so preCommitSteps reports hadChanges=false even though
			// the branch HEAD moved past the parent — keying on finalCommit
			// preserves those commits. (WO-2026-049; the Threefry branch-loss
			// incident, 2026-08-08, where a self-commit's branch was deleted and
			// the work survived only as a dangling commit, recovered by hash.)
			await git(["branch", "-D", isolationBranch], parentCwd);
		}

		if (PI_ASYNC_DEBUG) debugLog(`postDeliveryCleanup: ${Date.now() - t0}ms (hadChanges=${hadChanges})`);
	} catch (e: any) {
		if (PI_ASYNC_DEBUG) debugLog(`postDeliveryCleanup: FAILED after ${Date.now() - t0}ms: ${e.message || e}`);
		// Best-effort: force-remove the worktree directory
		try { fs.rmSync(worktreePath, { recursive: true, force: true }); } catch { /* */ }

		// Surface the warning to the parent via steer
		try {
			pi.sendUserMessage(
				`[subagent ${rs.sessionId.slice(-8)}] warning: worktree cleanup failed: ${e instanceof Error ? e.message : String(e)} — worktree at ${worktreePath} may need manual removal`,
				{ deliverAs: "steer" },
			);
		} catch { /* steer failed — nothing we can do */ }
	}
}

async function writeTempFile(name: string, content: string): Promise<{ dir: string; filePath: string }> {
	const tmpDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "pi-async-subagent-"));
	const safeName = name.replace(/[^\w.-]+/g, "_");
	const filePath = path.join(tmpDir, `prompt-${safeName}.md`);
	await fs.promises.writeFile(filePath, content, { encoding: "utf-8", mode: 0o600 });
	return { dir: tmpDir, filePath };
}

function getFinalOutput(messages: any[]): string {
	for (let i = messages.length - 1; i >= 0; i--) {
		const msg = messages[i];
		if (msg.role === "assistant") {
			for (const part of msg.content) {
				if (part.type === "text") {
					return part.text.replace(/^\s*\[session_id:[^\]]*\]\s*$/gim, "").trimEnd();
				}
			}
		}
	}
	return "";
}

// ── Work-order records (decisions/work-order-records/001) ───────────────────
// The spawner writes, into its own repo: the dispatch at spawn, then each
// reviewer round and the completion when the implementer closes. The
// implementer's worktree is never written — two writers would conflict at
// merge. `scripts/wo_record.py` owns the format and the departure parsing.

const WO_RECORD_SCRIPT = "scripts/wo_record.py";

export interface WorkRecord {
	cwd: string; // the spawner's repo root
	woId: string; // WO-YYYY-NNN
}

function failureText(run: { error?: Error; stderr: string; status: number | null }): string {
	return run.error?.message || run.stderr.trim() || `exit ${run.status}`;
}

function woRecordAppend(cwd: string, args: string[], body: string): string | null {
	const run = spawnSync("python3", [path.join(cwd, WO_RECORD_SCRIPT), "append", ...args], {
		cwd, input: body, encoding: "utf8",
	});
	return run.status === 0 && !run.error ? null : failureText(run);
}

/** A reviewer's task and final output, from its pi session file (JSONL, one entry per line).
 *  A malformed line throws: a record must not quietly lose part of a session. */
export function readSessionExchange(sessionFile: string): { task: string; output: string } | null {
	const messages: any[] = [];
	for (const line of fs.readFileSync(sessionFile, "utf-8").split("\n")) {
		if (line.trim()) {
			const entry = JSON.parse(line);
			if (entry.type === "message") messages.push(entry.message);
		}
	}
	const first = messages.find((m) => m?.role === "user");
	if (!first) return null;
	const task = typeof first.content === "string"
		? first.content
		: first.content.filter((p: any) => p.type === "text").map((p: any) => p.text).join("\n");
	return { task, output: getFinalOutput(messages) };
}

/** Open a work-order record for a spawn by writing its dispatch. Returns the record to complete at
 *  close, plus notes to surface. Never throws; a repo without wo_record.py gets neither record nor note. */
export function openWorkRecord(
	cwd: string,
	workOrderPath: string,
	implementerId: string,
	task: string,
): { record?: WorkRecord; notes: string[] } {
	if (!fs.existsSync(path.join(cwd, WO_RECORD_SCRIPT))) return { notes: [] };
	const fail = (why: string) => ({ notes: [`work-order record not written: ${why}`] });
	try {
		const woId = path.basename(workOrderPath).match(/^WO-\d{4}-\d{3}/)?.[0];
		if (!woId) return fail(`${workOrderPath} has no WO-YYYY-NNN prefix`);
		const blob = spawnSync("git", ["hash-object", "--", workOrderPath], { cwd, encoding: "utf8" });
		if (blob.status !== 0 || blob.error) return fail(`git hash-object ${workOrderPath}: ${failureText(blob)}`);
		const err = woRecordAppend(cwd, [
			woId, "dispatch", "--wo_blob", blob.stdout.trim(), "--implementer", implementerId, "--work_order", workOrderPath,
		], task);
		return err ? fail(err) : { record: { cwd, woId }, notes: [] };
	} catch (e) {
		return fail(e instanceof Error ? e.message : String(e));
	}
}

/** The reviewer sessions a record already holds, and how many reviews. Read through the tool, not
 *  by parsing its text. A failure is returned as text: the caller then writes nothing. */
function recordedReviews(record: WorkRecord): { sessions: Set<string>; count: number } | string {
	const run = spawnSync("python3", [path.join(record.cwd, WO_RECORD_SCRIPT), "summary", record.woId, "--json"], {
		cwd: record.cwd, encoding: "utf8",
	});
	if (run.status !== 0 || run.error) return failureText(run);
	const reviews = (JSON.parse(run.stdout).entries as { kind: string; keys: Record<string, string> }[])
		.filter((e) => e.kind === "review");
	return { sessions: new Set(reviews.map((e) => e.keys.session)), count: reviews.length };
}

/** The final text of a recovered run, from its session file (its messages never reached this process). */
function sessionFinalText(sessionFile: string | undefined): string {
	return sessionFile ? (readSessionExchange(sessionFile)?.output ?? "") : "";
}

/** Write the reviews not yet in the record, then a completion, for a finished implementer. Reviews
 *  already recorded (by session id) are skipped, so a resumed or recovered run appends only what is
 *  new. `implementerKey` is its pi session id, the key its reviewers were registered under; `readFinal`
 *  yields its final report and runs inside the guard. Returns notes for the writes that failed. */
export function completeWorkRecord(record: WorkRecord, implementerKey: string, readFinal: () => string): string[] {
	const { cwd, woId } = record;
	try {
		const recorded = recordedReviews(record);
		if (typeof recorded === "string") return [`work-order record: ${woId} not read, nothing written: ${recorded}`];
		const notes: string[] = [];
		let round = recorded.count;
		for (const entry of readPersistedSpawns(implementerKey).spawns) {
			if (recorded.sessions.has(entry.childSessionId)) continue;
			const where = `review ${entry.childSessionId}`;
			try {
				const sessionFile = readMetaJson(entry.childSessionId)?.sessionFile;
				const exchange = sessionFile ? readSessionExchange(sessionFile) : null;
				if (!exchange) {
					notes.push(`work-order record: ${where} not written: no session file with a task`);
					continue;
				}
				const err = woRecordAppend(cwd, [
					woId, "review", "--seat", entry.childAgentName, "--round", String(round + 1), "--session", entry.childSessionId,
				], JSON.stringify({ brief: exchange.task, output: exchange.output }));
				if (err) notes.push(`work-order record: ${where} not written: ${err}`);
				else {
					round += 1;
					recorded.sessions.add(entry.childSessionId);
				}
			} catch (e) {
				notes.push(`work-order record: ${where} not written: ${e instanceof Error ? e.message : String(e)}`);
			}
		}
		const finalText = readFinal();
		const err = finalText.trim()
			? woRecordAppend(cwd, [woId, "completion", "--implementer", implementerKey], finalText)
			: "implementer has no final report";
		if (err) notes.push(`work-order record: completion not written: ${err}`);
		return notes;
	} catch (e) {
		return [`work-order record: completion not written: ${e instanceof Error ? e.message : String(e)}`];
	}
}

function extractFilesFromArgs(toolName: string, args: Record<string, any>): { read?: string; write?: string } {
	const result: { read?: string; write?: string } = {};
	const filePath = args.file_path || args.path;
	if (!filePath) return result;

	switch (toolName) {
		case "read":
			result.read = filePath;
			break;
		case "write":
		case "edit":
			result.write = filePath;
			break;
	}
	return result;
}

function formatTokens(count: number): string {
	if (count < 1000) return count.toString();
	if (count < 10000) return `${(count / 1000).toFixed(1)}k`;
	if (count < 1000000) return `${Math.round(count / 1000)}k`;
	if (count < 10000000) return `${(count / 1000000).toFixed(1)}M`;
	return `${Math.round(count / 1000000)}M`;
}

function formatProgress(rs: RunningSubagent): string {
	const p = rs.progress;
	const elapsed = Math.round((Date.now() - rs.startedAt) / 1000);
	const mins = Math.floor(elapsed / 60);
	const secs = elapsed % 60;
	const state = rs.isDone
		? "[completed — result delivered]"
		: rs.procExited
			? "[process exited — result pending delivery]"
			: null;
	return [
		`Agent: ${rs.agentName}`,
		`Session: ${rs.sessionId}`,
		state,
		`Turns: ${p.turns}`,
		`Elapsed: ${mins}m ${secs}s`,
		`Activity: ${p.currentActivity}`,
		p.filesRead.size > 0 ? `Files read: ${p.filesRead.size}` : null,
		p.filesModified.size > 0 ? `Files modified: ${p.filesModified.size}` : null,
		p.errors.length > 0 ? `Errors: ${p.errors.length}` : null,
		rs.recordNotes?.length ? `Work-order record: ${rs.recordNotes.join("; ")}` : null,
	]
		.filter(Boolean)
		.join(" | ");
}

// ── Attach helpers ─────────────────────────────────────────────────────────

/**
 * Resolve an attach target from a user-supplied session-id string.
 * Encapsulates lookup + all guards: empty arg, not found, already done,
 * no writable stdin. Pure over the map + each rs's isDone/stdin state.
 */
function resolveAttachTarget(
	runningMap: Map<string, RunningSubagent>,
	sid: string,
): { ok: true; rs: RunningSubagent } | { ok: false; reason: "empty" | "notFound" | "done" | "noStdin" } {
	if (!sid.trim()) return { ok: false, reason: "empty" };

	const rs = findRunningByQuery(runningMap, sid);
	if (!rs) return { ok: false, reason: "notFound" };
	if (rs.isDone) return { ok: false, reason: "done" };
	if (!rs.stdin || rs.stdin.destroyed) return { ok: false, reason: "noStdin" };
	return { ok: true, rs };
}

/**
 * Build the RPC prompt payload for attaching user input to a running
 * subagent. Pins the exact shape — missing streamingBehavior would throw
 * when the child is mid-turn.
 */
function buildPromptPayload(text: string): { type: "prompt"; message: string; streamingBehavior: "steer" } {
	return { type: "prompt", message: text, streamingBehavior: "steer" };
}

// ── RPC communication ──────────────────────────────────────────────────────

export function rpcSend(stdin: NodeJS.WritableStream | null, command: Record<string, any>): boolean {
	// Returns false when the write cannot land (null, destroyed, or the
	// write throws) so callers can report the truth instead of "sent".
	// Note: destroyed may still be false briefly after the child exits —
	// callers must ALSO guard on rs.procExited before calling.
	if (!stdin || stdin.destroyed) return false;
	try {
		stdin.write(JSON.stringify(command) + "\n");
		return true;
	} catch {
		return false;
	}
}

/**
 * Append a single text line to a running subagent's live log: persisted log
 * file, in-memory `logLines` buffer (drives the TUI widget), and any
 * connected socket viewers.
 *
 * Mirrors the closure-scoped `logEntry` helper inside `spawnSubagent` so
 * tool bodies registered in `export default function` (e.g. `subagent_kill`,
 * which must return before `proc.on("close")` fires) can write to the same
 * log surface without needing access to the closure. Append-only; the close
 * handler is still the single owner of footer/status rendering.
 */
function appendRunningLogLine(rs: RunningSubagent, text: string): void {
	// Decision 015: same activity signal as the closure-scoped `logEntry`.
	bumpActivity(rs);
	try { fs.appendFileSync(rs.logPath, text + "\n"); } catch { /* */ }
	rs.logLines.push(text);
	rs.watchHandle?.requestRender();
	for (const client of rs.sockClients) {
		try { client.write(text + "\n"); } catch { rs.sockClients.delete(client); }
	}
}

interface RpcEvent {
	type: string;
	id?: string;
	message?: any;
	message_end?: any;
	// auto_retry_* payload (see pi docs/json.md RPC protocol)
	attempt?: number;
	maxAttempts?: number;
	delayMs?: number;
	errorMessage?: string;
	success?: boolean;
	finalError?: string;
}

/**
 * Build the argv array for spawning a subagent pi process.
 * Extracted so tests can assert flag composition without spawning.
 *
 * `appendSystemPrompts` is the ordered list of append-system-prompt source
 * paths: the shared global APPEND_SYSTEM.md first (so the role prompt has the
 * last word), then the agent-body temp file. Passing any
 * --append-system-prompt flag suppresses pi's own append discovery
 * (resource-loader.js: `discoverAppendSystemPromptFile` runs only when no
 * explicit append source is given), so the caller injects the global file
 * explicitly — see decisions/subagents/025-global-append-for-subagents.md.
 * Entries that are empty/undefined are skipped; a nonexistent path must NOT
 * be passed, because pi treats it as literal prompt text rather than a file.
 *
 * `sessionId` and `sessionFile` are mutually exclusive: a fresh spawn
 * passes its tracking id as `--session-id` so the child's pi session id
 * IS the handle (searchable in /resume, joinable via `pi --session
 * <id>`); a resume passes `--session <file>` to reopen the same session.
 */
export function buildSubagentArgs(config: {
	model: string;
	tools: string[];
	excludeTools: string[];
	sessionFile?: string;
	sessionId?: string;
	appendSystemPrompts?: string[];
}): string[] {
	const args: string[] = ["--mode", "rpc"];
	if (config.model) args.push("--model", config.model);
	if (config.tools && config.tools.length > 0) args.push("--tools", config.tools.join(","));
	if (config.excludeTools && config.excludeTools.length > 0) {
		args.push("--exclude-tools", config.excludeTools.join(","));
	}
	if (config.sessionFile && config.sessionId) {
		throw new Error("buildSubagentArgs: sessionFile and sessionId are mutually exclusive");
	}
	if (config.sessionFile) {
		args.push("--session", config.sessionFile);
	}
	if (config.sessionId) {
		args.push("--session-id", config.sessionId);
	}
	if (config.appendSystemPrompts) {
		for (const source of config.appendSystemPrompts) {
			if (source) args.push("--append-system-prompt", source);
		}
	}
	return args;
}

/**
 * Resolve the shared global APPEND_SYSTEM.md path for injection into a child.
 * Returns the path only when the file exists — pi treats a nonexistent
 * --append-system-prompt argument as literal prompt text, so a missing file
 * must produce NO argument. Exported so tests can pin path derivation from
 * getAgentDir() and the absence case.
 * See decisions/subagents/025-global-append-for-subagents.md.
 */
export function resolveGlobalAppendPrompt(
	exists: (path: string) => boolean = fs.existsSync,
): string | undefined {
	const candidate = path.join(getAgentDir(), "APPEND_SYSTEM.md");
	return exists(candidate) ? candidate : undefined;
}

/**
 * Decision 028: nesting depth of the *current* process. The root session
 * is 0; each subagent spawn adds one. Used to cap orchestrator nesting
 * at one level. Malformed stamps fail closed (deny, never grant).
 */
export function subagentDepth(env: NodeJS.ProcessEnv = process.env): number {
	const raw = env.PI_SUBAGENT_DEPTH;
	if (raw === undefined || raw === "") return 0;
	const n = Number(raw);
	if (!Number.isFinite(n) || n < 0) return MAX_ORCHESTRATOR_NESTING_DEPTH;
	return Math.floor(n);
}

/** Decision 028: the depth stamped on a child spawned by this process. */
export function nextSubagentDepth(env: NodeJS.ProcessEnv = process.env): number {
	return subagentDepth(env) + 1;
}

/** Decision 028: an orchestrator may nest once — depth 1 may spawn orchestrators, depth 2 may not. */
export const MAX_ORCHESTRATOR_NESTING_DEPTH = 2;

/**
 * Decision 028: refuse an `orchestrator` spawn from a process already at
 * the nesting cap. Returns the error text, or null when the dispatch is
 * allowed. Only orchestrators can spawn orchestrators, so no other agent
 * needs the depth cap.
 */
export function subagentNestingBlock(agentName: string, depth: number): string | null {
	if (agentName !== "orchestrator" || depth < MAX_ORCHESTRATOR_NESTING_DEPTH) return null;
	return (
		`Orchestrator nesting is capped at one level: this session is already at ` +
		`PI_SUBAGENT_DEPTH=${depth}, so it cannot dispatch another orchestrator. ` +
		`Delegate to implementers (or flatten the work into work orders).`
	);
}

export interface SubagentEnvConfig {
	sessionId: string;
	allowlist: string[] | undefined;
	worktreePath: string | null;
	parentCwdForCleanup: string;
	depth: number;
}

/**
 * Build the env additions for a subagent pi process (spread over the
 * parent's process.env at spawn). Extracted so tests can assert the role
 * markers without spawning.
 */
export function buildSubagentEnv(config: SubagentEnvConfig): Record<string, string> {
	return {
		// Marker that this process is a subagent. The modes extension
		// (and any other extension that branches on orchestrator vs
		// worker role) reads this to skip orchestrator-specific prompts
		// like "you are the conductor." Set unconditionally so the
		// signal is present even when allowedSubagents is empty.
		PI_IS_SUBAGENT: "1",
		// Decision 028: this process's nesting depth (root session 0, +1 per
		// spawn). The subagent tool refuses orchestrator spawns at
		// depth >= MAX_ORCHESTRATOR_NESTING_DEPTH.
		PI_SUBAGENT_DEPTH: String(config.depth),
		...(config.allowlist && config.allowlist.length > 0
			? { PI_SUBAGENT_ALLOWLIST: config.allowlist.join(",") }
			: {}),
		// Path to the subagent's isolated git worktree. The worktree-guard
		// extension reads this and uses it to:
		//   1. Allow writes inside this worktree (the "own worktree" anchor)
		//   2. Block writes inside OTHER concurrent subagents' worktrees
		//      (paths matching `/tmp/pi-subagent-wt-*` that are not this one)
		// Empty string when no worktree isolation applies (`isolate: false`
		// reviewers, or subagents dispatched without worktree support);
		// the worktree-guard treats empty as a no-op for that guard.
		PI_SUBAGENT_WORKTREE: config.worktreePath ?? "",
		// Path to the parent repo's checkout. The worktree-guard blocks
		// writes inside this path so the child cannot contaminate the
		// orchestrator's working tree. Only meaningful when the child is
		// actually isolated (i.e. has its own worktree) — for unisolated
		// reviewers the child runs IN the parent cwd, so the parent-cwd
		// block would block them from their own working directory. Empty
		// in that case.
		PI_SUBAGENT_PARENT_CWD: config.worktreePath ? (config.parentCwdForCleanup ?? "") : "",
		// peer-link identity: the subagent's peer name is its session id, so
		// the same id steers it, resumes it, and addresses peer messages to
		// it. Always set — an inherited PI_PEER_NAME would make sibling
		// subagents collide on one mailbox identity.
		PI_PEER_NAME: config.sessionId,
	};
}

/**
 * Full env for a spawned subagent: the parent's env with the subagent
 * additions layered over it. The additions win (spread order), so an
 * inherited PI_SUBAGENT_DEPTH can never survive into the child — the
 * child's own stamped depth is authoritative. This is the spawn site's
 * env builder and computes the depth itself, so no caller can forget
 * the increment.
 */
export function buildSubagentProcessEnv(
	config: Omit<SubagentEnvConfig, "depth">,
	parentEnv: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv {
	return { ...parentEnv, ...buildSubagentEnv({ ...config, depth: nextSubagentDepth(parentEnv) }) };
}

// Decision 014 (+ 2026-10-07 ruling): one grammar for the work order's
// declared `review_policy`. Two encodings, in priority order:
//   1. the bold line — `**review_policy**: skip`. The leading bullet is
//      OPTIONAL: a bare bold line is how a human writes a metadata block, and
//      before the ruling it matched no form and was silently read as
//      `required` — inert, which defeats decision 014 making the WO the single
//      source of truth (the same class as the frontmatter gap fixed
//      2026-08-26, and observed for real in another repo's work orders).
//   2. YAML frontmatter  — `review_policy: skip`, for work orders written that
//      way. The bold line wins when both are present.
//
// First-word-after-colon semantics in both forms: `skip` → skip; anything else
// — `required`, the template literal `required | skip`, or no declaration at
// all — → required. Trailing rationale after the first token is ignored, so
// `skip — because ...` still reads as skip. Deliberately NOT a substring match
// for `skip`.
const POLICY_BOLD_RE = /^\s*(?:-\s*)?\*\*review_policy\*\*:\s*(\S+)/m;
// YAML frontmatter is work-order scope only — a task string never carries it.
const POLICY_YAML_RE = /^review_policy:\s*(\S+)/m;

export function parseWorkOrderPolicy(woText: string): "required" | "skip" {
	const m = woText.match(POLICY_BOLD_RE) ?? woText.match(POLICY_YAML_RE);
	return m?.[1] === "skip" ? "skip" : "required";
}

/** Does this dispatch's task text declare `skip`? The bold line only — YAML
 *  frontmatter is a work-order spelling, not something a task string carries —
 *  with the same first-word semantics as `parseWorkOrderPolicy`. The gate's
 *  WO-less fallback and the skip-bullet injection share this one detector.
 *  @for-testing-only — exported to pin the task-text scope. */
export function taskDeclaresPolicySkip(task: string): boolean {
	return POLICY_BOLD_RE.exec(task)?.[1] === "skip";
}

// ── Model resolution (decision 031) ─────────────────────────────────────────

/** The one seat that always tracks its caller's model. */
const INHERITING_AGENT = "orchestrator";

/** pi's thinking levels (`docs/extensions.md` → pi.getThinkingLevel). A model
 *  spec's `:suffix` is a level only when it names one — otherwise it belongs to
 *  the model id (`:free` is a real OpenRouter tag). */
const THINKING_LEVELS = new Set(["off", "minimal", "low", "medium", "high", "xhigh", "max"]);

/** Split `provider/id[:level]` into the bare spec and its level. */
function splitModelSpec(spec: string): { id: string; level?: string } {
	const i = spec.lastIndexOf(":");
	if (i > 0 && THINKING_LEVELS.has(spec.slice(i + 1))) {
		return { id: spec.slice(0, i), level: spec.slice(i + 1) };
	}
	return { id: spec };
}

/**
 * The model a child process is spawned with. Single source of truth: the spawn
 * args and the `meta.json` record both consume this result, so they cannot
 * disagree about what a child ran on.
 *
 * - The orchestrator seat always tracks its caller (decision 031): the child
 *   runs on the caller's model at the seat's own audited level. On today's
 *   single-slug fleet that resolves to the same model the seat pinned anyway;
 *   it bites when the caller runs something else (Opus, MiMo, …). With no
 *   caller model it falls back to the seat's model — never to "no model".
 *   `inheritParentModel` cannot opt this seat out: the orchestrator branch is
 *   evaluated before the inherit branch, so an explicit `true` is ignored too
 *   and the seat's model is used when there is no caller model.
 * - `inheritParentModel` is the per-spawn opt-in for every other seat; the
 *   caller's model passes through unsubstituted (decisions 020/022).
 * - Resume keeps the recorded model verbatim (decision 022 site 2) —
 *   re-deriving it would silently switch a resumed child's model.
 * - Otherwise the agent frontmatter model wins, the fleet spec when the seat
 *   pins none (decision 022). The spec is provider-qualified
 *   (`opencode-go/deepseek-v4.1-flash`), never the bare id: a bare id resolves
 *   against the session default provider and wanders onto unpinned routes
 *   (owner ruling 2026-10-22).
 *
 * `undefined` means no `--model` flag at all (pi picks its own default).
 * Exported for tests (@for-testing-only): the precedence is the contract.
 */
export function resolveChildModel(opts: {
	agentName: string;
	agentModel?: string;
	parentModel?: string;
	inheritParentModel?: boolean;
	isResume?: boolean;
}): string | undefined {
	if (opts.isResume) return opts.agentModel ?? FLEET_MODEL_SPEC;
	if (opts.agentName === INHERITING_AGENT) {
		if (!opts.parentModel) return opts.agentModel ?? FLEET_MODEL_SPEC;
		const level = opts.agentModel ? splitModelSpec(opts.agentModel).level : undefined;
		return level ? `${opts.parentModel}:${level}` : opts.parentModel;
	}
	if (opts.inheritParentModel) return opts.parentModel;
	return opts.agentModel ?? FLEET_MODEL_SPEC;
}

// ── Spawn & manage ──────────────────────────────────────────────────────────

async function spawnSubagent(
	pi: ExtensionAPI,
	ctx: any,
	agent: AgentConfig,
	task: string,
	cwd: string,
	sessionId: string,
	// Resolved by the caller through resolveChildModel (decision 031) and used
	// verbatim — the spawn args and the meta.json record consume one value, so
	// they cannot disagree. Resume passes the recorded `meta.model`.
	resolvedModel: string | undefined,
	worktreePath: string | null,
	isolationBranch: string | null,
	parentHeadCommit: string | null,
	parentCwdForCleanup: string,
	// When set, the subprocess loads an existing session file instead of
	// creating a new one. Used by subagent_resume.
	resumeSessionFile?: string,
	// Mirrors the work-order `review_policy` field. When `skip`, suppresses
	// the harness's post-implementation review guard for this spawn. Ad-hoc
	// dispatches without a work order should pass `"skip"` here.
	reviewPolicy?: "required" | "skip",
	// Full message delivered to the child. Defaults to `task`. The worktree-
	// isolation preamble + review-policy annotation are delivery wrappers that
	// must reach the child but must NOT pollute `task` — `task` is the clean
	// identity used for the auto-commit subject and result display.
	// See decisions/subagents/009-clean-task-identity.md.
	promptMessage?: string,
	// Snapshot of the parent's uncommitted state carried into the worktree
	// (WO-2026-035), for the preCommitSteps completion filter. Trailing and
	// optional: undefined/null when no carry happened (carryUncommitted:false,
	// baseRef, or no worktree). In-memory only — no persistence.
	carriedSnapshot?: CarriedSnapshot,
	// Parsed `review_policy` from the referenced work order (decision 014),
	// set only when the spawn passed `workOrderPath`. When set, it is the
	// single source of truth for the review gate — it wins over
	// `reviewPolicy` and the task-text bullet on disagreement.
	workOrderPolicy?: "required" | "skip",
	// Decision 015 stage-2: silence-based auto-kill. The child is killed
	// after `silenceTimeoutMs` with no activity (no tool calls AND no
	// assistant messages). Default 30 min; 0 or negative disables.
	silenceTimeoutMs?: number,
): Promise<RunningSubagent> {
	// Message actually delivered to the child process. `task` stays the clean
	// identity (commit subject / "Task:" display); the preamble and
	// review-policy annotation live only in promptForChild.
	const promptForChild = promptMessage ?? task;

	// The shared global prompt (decisions/subagents/025-global-append-for-subagents.md).
	// pi's resource loader discovers <agentDir>/APPEND_SYSTEM.md only when no
	// explicit append source is given (`if (!appendSources) { …
	// discoverAppendSystemPromptFile() … }`, dist/core/resource-loader.js).
	// We always pass the agent body below when it is non-empty, which suppresses
	// that discovery — so inject the global file explicitly or subagents never
	// see it. Global first, agent body last, so the role prompt wins on conflict.
	//
	// We deliberately do NOT mirror <cwd>/.pi/APPEND_SYSTEM.md: pi gates that
	// project file on a project-trust check (isProjectTrusted) the spawner
	// cannot re-run, so injecting an untrusted repo's file would bypass it.
	const globalAppendPath = resolveGlobalAppendPrompt();

	// Write the agent body to a temp file (if any) before composing argv, so
	// buildSubagentArgs stays the single composition point for every
	// --append-system-prompt flag.
	let tmpDir: string | null = null;
	let tmpPath: string | null = null;
	if (agent.systemPrompt.trim()) {
		const tmp = await writeTempFile(agent.name, agent.systemPrompt);
		tmpDir = tmp.dir;
		tmpPath = tmp.filePath;
	}
	const appendSystemPrompts = [globalAppendPath, tmpPath ?? undefined]
		.filter((p): p is string => typeof p === "string" && p.length > 0);

	// Build spawn args via shared helper (also used by tests).
	// Fresh spawn: pass the tracking id as --session-id so the child's pi
	// session id IS the handle. Resume: reopen the existing session file
	// (its header id is the handle), which keeps the same id.
	const args = buildSubagentArgs({
		model: resolvedModel ?? "",
		tools: agent.tools ?? [],
		excludeTools: agent.excludeTools ?? [],
		sessionFile: resumeSessionFile,
		sessionId: resumeSessionFile === undefined ? sessionId : undefined,
		appendSystemPrompts,
	});

	const logPath = `/tmp/pi-subagent-${sessionId}.log`;
	const sockPath = `/tmp/pi-subagent-${sessionId}.sock`;

	// Decision 014: the review gate keys on the WORK ORDER when one is
	// referenced (workOrderPolicy), else on the tool param / a bold declaration
	// in the task text (prior behavior). With a WO present, its parsed policy
	// wins on disagreement — the task-text fallback applies only to WO-less
	// dispatches. Computed before the RS record so the soft-prompt guard and
	// `subagent_review_status` see the same value.
	const effectiveReviewPolicy = workOrderPolicy ?? reviewPolicy;
	const gateSkipped =
		effectiveReviewPolicy === "skip" ||
		(workOrderPolicy === undefined && taskDeclaresPolicySkip(task));

	// Decision 015 stage-2: resolve the per-spawn silence timeout. Undefined
	// → 30-min default; 0/negative (and NaN/Infinity) → disabled (0).
	const effectiveSilenceTimeoutMs = silenceTimeoutMs === undefined
		? SILENCE_TIMEOUT_DEFAULT_MS
		: (Number.isFinite(silenceTimeoutMs) && silenceTimeoutMs > 0 ? silenceTimeoutMs : 0);

	const rs: RunningSubagent = {
		proc: null as any,
		sessionId,
		agentName: agent.name,
		task,
		cwd,
		startedAt: Date.now(),
		progress: newProgress(),
		messages: [],
		stdin: null,
		resolveOnStop: null,
		isDone: false,
		procExited: false,
		killedExplicitly: false,
		stoppedExplicitly: false,
		turnNudged: false,
		logPath,
		logLines: [],
		stderrLines: [],
		watchHandle: null,
		sockPath,
		sockServer: null as any,
		sockClients: new Set(),
		worktreePath,
		isolationBranch,
		parentHeadCommit,
		parentCwd: parentCwdForCleanup,
		parentTrackerKey: getParentTrackerKey(ctx),
		reviewParentRequirements: gateSkipped ? undefined : agent.reviewParentRequirements,
		usageStats: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, latestCacheHitRate: undefined },
		carried: carriedSnapshot ?? null,
		lastActivityMs: Date.now(),
		silenceTimer: null,
		silenceTimeoutMs: effectiveSilenceTimeoutMs,
		killedVia: null,
		toolInFlight: 0,
	};

	// Unix socket server for external viewers
	try { fs.unlinkSync(sockPath); } catch { /* not there yet */ }
	const sockServer = net.createServer((socket) => {
		rs.sockClients.add(socket);
		// Replay buffered lines so new viewer sees previous output
		for (const line of rs.logLines) {
			try { socket.write(line + "\n"); } catch { /* */ }
		}
		socket.on("close", () => { rs.sockClients.delete(socket); });
		socket.on("error", () => { rs.sockClients.delete(socket); });
	});
	sockServer.listen(sockPath, () => { /* ready */ });
	sockServer.on("error", () => { /* ignore */ });
	rs.sockServer = sockServer;

	// Open the live log file and write the header.
	const logEntry = (text: string) => {
		// Decision 015: any log output counts as activity — a child emitting
		// logs is alive, so the stage-2 silence-kill timer must not fire.
		bumpActivity(rs);
		try { fs.appendFileSync(logPath, text + "\n"); } catch { /* */ }
		rs.logLines.push(text);
		rs.watchHandle?.requestRender();
		for (const client of rs.sockClients) {
			try { client.write(text + "\n"); } catch { rs.sockClients.delete(client); }
		}
	};

	// ANSI style helpers (Catppuccin-like)
	const S = {
		reset: "\x1b[0m",
		bold: "\x1b[1m",
		dim: "\x1b[2m",
		fgCyan: "\x1b[36m",
		fgGreen: "\x1b[32m",
		fgRed: "\x1b[31m",
		fgMagenta: "\x1b[35m",
		fgYellow: "\x1b[33m",
		fgBlue: "\x1b[34m",
		bgBlue: "\x1b[44m",
		bgRed: "\x1b[41m",
		toolPending: "\x1b[34m\x1b[1m",   // bold blue
		toolSuccess: "\x1b[32m",          // green
		toolError: "\x1b[31m\x1b[1m",     // bold red
		turnHdr: "\x1b[2m\x1b[36m",       // dim cyan
		think: "\x1b[2m",                  // dim
		headerFg: "\x1b[34m\x1b[1m",      // bold blue
		doneOk: "\x1b[32m\x1b[1m",        // bold green
		doneFail: "\x1b[31m\x1b[1m",      // bold red
		aside: "\x1b[2m\x1b[35m",          // dim magenta
	};
	const hdr = (lbl: string) => S.headerFg + lbl + S.reset + S.dim;

	logEntry(`${hdr("Agent:")} ${agent.name}  ${hdr("Session:")} ${sessionId}  ${hdr("CWD:")} ${cwd}${S.reset}`);
	logEntry(`${S.dim}Task: ${promptForChild.slice(0, 300)}${promptForChild.length > 300 ? "…" : ""}${S.reset}`);
	logEntry("");

	let currentTurn = 0;
	let pendingToolCalls: Map<string, string> = new Map(); // toolCallId → summary

	const invocation = getPiInvocation(args);
	const proc = spawn(invocation.command, invocation.args, {
		cwd,
		shell: false,
		stdio: ["pipe", "pipe", "pipe"],
		env: buildSubagentProcessEnv({
			sessionId,
			allowlist: agent.allowedSubagents,
			worktreePath,
			parentCwdForCleanup,
		}),
	});

	rs.proc = proc;
	rs.stdin = proc.stdin;

	// Swallow EPIPE/stream errors from writing to a dying child's stdin.
	// Without a listener, an 'error' event on the write stream is an
	// unhandled exception and would crash the parent session.
	rs.stdin?.on("error", (err: Error) => {
		debugLog(`subagent stdin error: ${err.message}`);
	});

	// Earliest liveness signal: the process has exited, even though the
	// close handler (running-map removal) may lag behind. Steer/stop must
	// not write into the dead pipe.
	proc.on("exit", () => {
		rs.procExited = true;
	});

	let stdoutBuffer = "";

	// Debug logging, enabled via PI_ASYNC_DEBUG=1
	const debugLog = PI_ASYNC_DEBUG
		? (msg: string) => {
			try { fs.appendFileSync("/tmp/pi-async-debug.log", `[${rs.sessionId}] ${msg}\n`); } catch { /* */ }
		  }
		: () => {};
	debugLog("spawned cwd=" + cwd);

	// Track spawn-to-first-RPC-response latency for timing instrumentation.
	const spawnTime = PI_ASYNC_DEBUG ? Date.now() : 0;
	let firstRpcSeen = false;

	const processLine = (line: string) => {
		if (!line.trim()) return;
		let event: RpcEvent;
		try {
			event = JSON.parse(line);
		} catch {
			return;
		}

		if (PI_ASYNC_DEBUG && !firstRpcSeen) {
			firstRpcSeen = true;
			debugLog(`spawn-to-first-rpc (${event.type}): ${Date.now() - spawnTime}ms`);
		}

		debugLog("ev:" + event.type);

		// ── Capture session info from get_state response ───────────────
		if (event.type === "response" && event.id === getStateId) {
			const data = (event as any).data;
			if ((event as any).success && data) {
				rs.sessionFile = data.sessionFile;
				rs.piSessionId = data.sessionId;
				debugLog(`get_state: sessionFile=${rs.sessionFile} piSessionId=${rs.piSessionId}`);
				// Persist to meta so subagent_resume can discover the file later.
				// The meta file was already written by the spawn caller with
				// the agent config fields; we add only sessionFile / piSessionId.
				updateMetaJson(sessionId, {
					sessionFile: rs.sessionFile,
					piSessionId: rs.piSessionId,
				});
			}
		}

		// ── Live log: turn boundaries ──────────────────────────────────
		if (event.type === "turn_start") {
			currentTurn++;
			logEntry(`${S.turnHdr}── Turn ${currentTurn} ──${S.reset}`);
		}

		// ── Live log: tool start ───────────────────────────────────────
		if (event.type === "tool_execution_start") {
			// (activity bump via the union classifier below)
			rs.toolInFlight++; // a tool is now running — suppress the stale-turn
			                   // watchdog's "stalled" alarm while it executes
			const tn: string = event.toolName || "";
			const ta: Record<string, any> = event.args || {};
			const summary = formatToolAction(tn, ta);
			pendingToolCalls.set(event.toolCallId, summary);
			logEntry(`  ${S.toolPending}▸ ${summary}${S.reset}`);
		}

		// ── Live log: tool end ─────────────────────────────────────────
		if (event.type === "tool_execution_end") {
			// (activity bump via the union classifier below)
			if (rs.toolInFlight > 0) rs.toolInFlight--;
			// Re-arm the stalled-turn watchdog so a completed tool starts a fresh
			// 5-minute window — otherwise a subagent that finishes a long tool and
			// is mid-LLM-call when the (old-deadline) timer fires would get a false
			// "stalled" notice. (The turn's own message_end also re-arms.)
			bumpStaleWatchdog(pi, rs);
			const summary = pendingToolCalls.get(event.toolCallId) || event.toolName || "tool";
			pendingToolCalls.delete(event.toolCallId);
			if (event.isError) {
				const errText = typeof event.result === "string"
					? event.result.slice(0, 120)
					: JSON.stringify(event.result).slice(0, 120);
				logEntry(`  ${S.toolError}✖ ${summary}${S.reset} ${S.fgRed}→ ERROR: ${errText}${S.reset}`);
			} else {
				// Extract readable result text
				let resultText = "";
				try {
					if (event.result?.content) {
						for (const c of event.result.content) {
							if (c.type === "text") resultText += c.text;
						}
					}
				} catch { /* */ }
				const trimmed = resultText.trim().slice(0, 200);
				if (trimmed) {
					logEntry(`  ${S.toolSuccess}─ ${trimmed.replace(/\n/g, "\n    ")}${S.reset}`);
				}
			}
		}

		// ── Activity signal: the decision-015 union (guards 3+4) ────────
		// One classifier for every raw event type that proves the child is
		// alive — tool lifecycle, streaming tool output, LLM-call streaming,
		// provider retries. Cheap enough to run on every event.
		if (eventCountsAsActivity(event.type)) {
			bumpActivity(rs);
		}

		// Provider retry lifecycle: log it (also activity via the classifier
		// above). The issue #1 incident log showed nothing between the last
		// tool result and the kill — a retry line makes degraded-provider
		// kills legible after the fact.
		if (event.type === "auto_retry_start") {
			logEntry(`  ${S.fgYellow}↻ retry ${event.attempt ?? "?"}/${event.maxAttempts ?? "?"} in ${event.delayMs ?? "?"}ms${event.errorMessage ? `: ${String(event.errorMessage).slice(0, 120)}` : ""}${S.reset}`);
		} else if (event.type === "auto_retry_end") {
			logEntry(`  ${S.dim}↻ retry ${event.attempt ?? "?"} ${event.success ? "recovered" : `failed${event.finalError ? `: ${String(event.finalError).slice(0, 120)}` : ""}`}${S.reset}`);
		}

		// ── Live log: assistant message content ────────────────────────
		if (event.type === "message_end" && event.message) {
			const msg = event.message;
			if (msg.role === "assistant") {
				for (const part of msg.content) {
					// Thinking / reasoning tokens
					if (part.type === "thinking" && part.thinking?.trim()) {
						const tt = part.thinking.trim().slice(0, 500);
						logEntry(`  ${S.think}[thinking] ${tt.replace(/\n/g, `\n  ${S.think}[thinking] `)}${S.reset}`);
					}
					// Regular text
					if (part.type === "text" && part.text.trim()) {
						const t = part.text.trim();
						logEntry(`  ${t.replace(/\n/g, "\n  ")}${t.includes("\n") ? "" : ""}`);
					}
				}
			}
		}

		// Track session id from response
		if (event.type === "response" && event.id === "session") {
			// session header response
		}

		// Track messages
		if (event.type === "message_end" && event.message) {
			const msg = event.message;
			rs.messages.push(msg);

			if (msg.role === "assistant") {
				rs.progress.turns++;
				// Reset stalled-turn watchdog — fresh progress means no wake-up needed.
				bumpStaleWatchdog(pi, rs);
				// Decision 015: an assistant message is activity too. (Role-gated
				// here rather than in the raw-type classifier — a user-message
				// message_end must not count.)
				bumpActivity(rs);
				// Accumulate usage stats
				rs.usageStats.input += msg.usage.input;
				rs.usageStats.output += msg.usage.output;
				rs.usageStats.cacheRead += msg.usage.cacheRead;
				rs.usageStats.cacheWrite += msg.usage.cacheWrite;
				rs.usageStats.cost += msg.usage.cost.total;
				const promptTokens = msg.usage.input + msg.usage.cacheRead + msg.usage.cacheWrite;
				if (promptTokens > 0) {
					rs.usageStats.latestCacheHitRate = (msg.usage.cacheRead / promptTokens) * 100;
				}
				updateFooter();

				// Soft turn nudge: warn once near the hard cap so the agent can wrap
				// up with a partial result instead of being hard-killed mid-task.
				if (!rs.turnNudged && rs.progress.turns >= TURN_NUDGE_SOFT) {
					rs.turnNudged = true;
					const nudge =
						`[Turn-limit warning] You have used ${TURN_NUDGE_SOFT} of the ${MAX_TURNS_HARD}-turn ` +
						`hard limit for this subagent run; the process will be killed at ${MAX_TURNS_HARD} turns. ` +
						`Do NOT start new work and do NOT launch reviewers. Wrap up now: complete or abandon the ` +
						`current step, then emit your completion report with **status: partial** (or blocked) — ` +
						`summarize what was completed, what remains, and any open issues. Your next text-only ` +
						`message is your final output.`;
					try {
						rpcSend(rs.stdin, { type: "prompt", message: nudge, streamingBehavior: "steer" });
						logEntry(`\x1b[33m[turn-limit] soft nudge injected at ${rs.progress.turns} turns\x1b[0m`);
						debugLog(`turn-nudge: soft nudge at turns=${rs.progress.turns} child=${rs.sessionId}`);
					} catch (e) {
						debugLog(`turn-nudge: rpcSend failed: ${e instanceof Error ? e.message : String(e)}`);
					}
				}

				// Hard turn limit — routes through the shared kill dispatch
				// (dispatchKillSignals), NOT a bare proc.kill: the close handler is
				// the single owner of delivery and reads killedExplicitly/killedVia
				// to prepend the kill marker; a bare kill delivers the child's last
				// message as a normal completion (and escapes the killed/stopped
				// skips, e.g. the owner_asks gate).
				if (rs.progress.turns >= MAX_TURNS_HARD) {
					rs.progress.currentActivity = `hit turn limit (${MAX_TURNS_HARD}), stopping`;
					rs.progress.errors.push(`Turn limit reached (${MAX_TURNS_HARD})`);
					debugLog("turn-limit hit, dispatching kill");
					dispatchKillSignals(rs, "turn-limit");
					return;
				}

				// Detect completion: text-only message (no tool calls) means the
				// model is done. RPC mode keeps stdin open so we must close it to
				// trigger process exit and fire the close handler.
				const hasToolCalls = msg.content.some((c: any) => c.type === "toolCall");
				const hasText = msg.content.some((c: any) => c.type === "text");
				debugLog("msg_end: tc=" + hasToolCalls + " txt=" + hasText + " resolve=" + !!rs.resolveOnStop);
				if (!hasToolCalls && hasText) {
					// Reviewer invocation guard: if this child has
				// `reviewParentRequirements` non-empty (i.e. it is itself an
				// implementer with a gate), check whether every required
				// reviewer kind has been spawned from it. The child's harness
				// writes a persisted tracker file at
				// `/tmp/pi-subagent-<childSessionId>.reviewers.json` for every
				// reviewer it spawns; we read that file here to make a
				// cross-process decision (the implementer runs in its own pi
				// process; its in-memory tracker is invisible to us — but the
				// file is the same one `subagent_review_status` reads, so the
				// soft-prompt check and the orchestrator's mechanical gate
				// share one source of truth).
				//
				// If any required reviewer kind is missing, inject a steer
				// prompt into the child's RPC stdin and SKIP the stdin.close()
				// so the implementer re-enters its agent loop with a corrective
				// message. We do NOT hard-stop the implementer: a hard stop
				// would lose model state for the corrective path. The soft
				// prompt is a polite nudge; the orchestrator's mechanical
				// `subagent_review_status` check is the actual gate.
				const required = rs.reviewParentRequirements;
				if (required && required.length > 0 && !rs.stoppedExplicitly && !rs.turnNudged) {
					// The child's harness writes its reviewer-spawn tracker file
					// keyed by its own pi session ID (obtained via
					// getParentTrackerKey inside the child process). We read
					// by `rs.piSessionId` (captured from the child's get_state
					// response) so the file key matches. If get_state never
					// responded (child crashed before responding), skip the
					// soft-prompt guard — the orchestrator's mechanical
					// `subagent_review_status` check is the real gate.
					if (!rs.piSessionId) {
						debugLog(`review-gate: piSessionId not captured, skipping soft-prompt guard`);
						// Fall through to isDone/completion logic below
					} else {
					const trackerKey = rs.piSessionId;
					const trackerState = readPersistedSpawns(trackerKey);
					const spawnedKinds = new Set(trackerState.spawns.map((s) => s.reviewerKind));
					const missing = required.filter((k) => !spawnedKinds.has(k));
					if (missing.length > 0 && !trackerState.reviewCapReached) {
						const message =
							`[review-gate] You returned a final message without spawning all required reviewers. ` +
							`Missing: ${missing.join(", ")}. Per your post-implementation review section, you must launch ` +
							`both reviewers with \`isolate: false\` before reporting \`complete\`. Continuing.`;
						try {
							rpcSend(rs.stdin, {
								type: "prompt",
								message,
								streamingBehavior: "steer",
							});
							logEntry(`\x1b[33m[review-gate] soft prompt injected; missing reviewers: ${missing.join(", ")}\x1b[0m`);
							debugLog(`review-gate: soft prompt for missing=${missing.join(",")} child=${rs.sessionId} trackerKey=${trackerKey}`);
						} catch (e) {
							debugLog(`review-gate: rpcSend failed: ${e instanceof Error ? e.message : String(e)}`);
						}
						// Do NOT close stdin — the corrective prompt re-enters
						// the agent loop. We also do not set isDone=true here
						// because the agent is not actually done; it has a
						// corrective prompt to act on.
						return;
					}
					} // end else (piSessionId captured)
				} // end if (required)

					rs.progress.currentActivity = "completed, closing session";
					rs.isDone = true;
					debugLog("DONE! closing stdin");

					// Auto-detach: if the user is attached to this session,
					// restore the default editor and clear the attach widget
					// so it isn't orphaned after the child completes.
					if (attachedSessionId === sessionId) {
						detach();
						notifyChildDetached(rs);
					}

					if (rs.stdin && !rs.stdin.destroyed) {
						rs.stdin.end();
					}
				}
			}
		}

		// Track tool execution for progress
		if (event.type === "tool_execution_start") {
			const toolName: string = event.toolName || "";
			const toolArgs: Record<string, any> = event.args || {};
			const files = extractFilesFromArgs(toolName, toolArgs);
			if (files.read) rs.progress.filesRead.add(files.read);
			if (files.write) rs.progress.filesModified.add(files.write);

			const actionSummary = formatToolAction(toolName, toolArgs);
			rs.progress.lastActions.push(actionSummary);
			if (rs.progress.lastActions.length > 5) rs.progress.lastActions.shift();
			rs.progress.currentActivity = actionSummary;
		}

		// Track errors
		if (event.type === "tool_execution_end" && event.isError) {
			const errMsg = typeof event.result === "string" ? event.result : JSON.stringify(event.result);
			rs.progress.errors.push(`${event.toolName}: ${errMsg.slice(0, 200)}`);
		}
	};

	proc.stdout.on("data", (data: Buffer) => {
		const raw = data.toString();
		stdoutBuffer += raw;
		const lines = stdoutBuffer.split("\n");
		stdoutBuffer = lines.pop() || "";
		for (const l of lines) {
			if (l.trim()) processLine(l);
		}
	});

	proc.stderr.on("data", (data: Buffer) => {
		// Capture every line. Capped to the last 200 to bound memory for
		// long-running sessions; surfaced in deliverResult when the child
		// exits before completing a turn so the orchestrator sees the
		// actual failure (extension load error, model auth, etc.) instead
		// of a bare "exit 1, 0 turns".
		for (const line of data.toString().split("\n")) {
			if (line) {
				rs.stderrLines.push(line);
				if (rs.stderrLines.length > 200) rs.stderrLines.shift();
			}
		}
	});

	proc.on("close", async (code) => {
		debugLog("close: code=" + code + " resolve=" + !!rs.resolveOnStop + " done=" + rs.isDone + " turns=" + rs.progress.turns);
		// Cancel the stalled-turn watchdog and the stage-2 silence timer —
		// the subagent is leaving the running set, so neither may fire again.
		if (rs.staleTimer) { clearTimeout(rs.staleTimer); rs.staleTimer = null; }
		if (rs.silenceTimer) { clearTimeout(rs.silenceTimer); rs.silenceTimer = null; }
		// Cancel any active wait timer — the subagent's completion delivers
		// its own result as a steer message, so a follow-up "still running"
		// wakeup would be redundant. Multiple subagents share one timer, so
		// clearing on the *first* completion is correct: the caller will be
		// woken by the result and can re-issue wait() for any still-running
		// subagents.
		clearActiveWait();
		if (stdoutBuffer.trim()) processLine(stdoutBuffer);

		// Write completion footer to live log
		const how = rs.killedExplicitly
			? "Killed"
			: (rs.isDone ? "Completed" : (code === 0 ? "Exited" : "Stopped"));
		logEntry("");
		// Killed footer is always red — even in the rare race where a subagent
		// raced to `isDone` before SIGTERM was dispatched, a hard kill is an
		// abort and should render as such.
		const style = rs.killedExplicitly ? S.doneFail : (rs.isDone ? S.doneOk : S.doneFail);
		logEntry(`${style}── ${how} (${rs.progress.turns} turns, exit ${code ?? "?"}) ──${S.reset}`);

		// Widget stays visible for user to review; they clear it with /watch off

		// Close socket server and clean up
		try {
			for (const client of rs.sockClients) client.destroy();
			rs.sockServer.close();
			fs.unlinkSync(sockPath);
		} catch { /* */ }

		// Auto-detach on unexpected exit: if the user was attached to this
		// session when it died (crash, kill, timeout), restore the default
		// editor so it isn't orphaned. The isDone path above handles the
		// normal-completion case; this catches abnormal termination.
		if (attachedSessionId === sessionId) {
			detach();
			notifyChildDetached(rs);
		}

		// Mark the session as no longer running BEFORE preCommitSteps (which
		// runs multiple git commands). Otherwise subagent_resume would
		// incorrectly reject with "already running" during the commit window
		// for a session that has completed.
		running.delete(sessionId);
		updateFooter();

		// PRE-DELIVERY: commit-producing git steps (add, diff, commit, rev-parse).
		// Split from post-delivery cleanup so the result reaches the parent
		// immediately rather than waiting seconds for worktree removal.
		const tDeliver = PI_ASYNC_DEBUG ? Date.now() : 0;
		const { note: commitNote, finalCommit, hadChanges } = await preCommitSteps(rs);

		// Clean up temp files
		if (tmpPath) try { fs.unlinkSync(tmpPath); } catch { /* ignore */ }
		if (tmpDir) try { fs.rmdirSync(tmpDir); } catch { /* ignore */ }

		// DELIVER: the result reaches the parent now.
		// No double delivery: resolveOnStop and deliverResult are mutually
		// exclusive — see deliverCloseResult (the single delivery owner).
		// Work-order record: the completion and each reviewer round (decisions/work-order-records/001).
		const recordNotes = rs.workRecord
			? completeWorkRecord(rs.workRecord, rs.piSessionId ?? sessionId, () => getFinalOutput(rs.messages))
			: [];
		rs.recordNotes = [...(rs.recordNotes ?? []), ...recordNotes];
		const deliveryPath = deliverCloseResult(pi, rs, code ?? 0, commitNote + recordNotes.map((n) => `\n${n}`).join(""));
		if (PI_ASYNC_DEBUG) debugLog(`deliverResult (${deliveryPath}): ${Date.now() - tDeliver}ms`);

		// POST-DELIVERY: worktree removal and branch cleanup. Fire-and-forget —
		// must not block the close handler, and failures are surfaced as steer
		// warnings, never fatal.
		postDeliveryCleanup(pi, rs, finalCommit, hadChanges).catch((e) => {
			debugLog(`postDeliveryCleanup: unhandled rejection: ${e instanceof Error ? e.message : String(e)}`);
		});
	});

	proc.on("error", () => {
		running.delete(sessionId);
		updateFooter();
	});

	// Send get_state BEFORE the initial prompt so we capture the child's
	// real sessionFile and pi sessionId before any prompt processing begins.
	// Both commands run on the same RPC pipe; order is preserved by serial
	// stdin writes. If get_state never responds (child crashes immediately),
	// sessionFile remains undefined on rs — subagent_resume will error
	// gracefully for that session.
	const getStateId = `get-state-${randomUUID()}`;
	rpcSend(proc.stdin, { id: getStateId, type: "get_state" });
	rpcSend(proc.stdin, { type: "prompt", message: promptForChild });

	// Arm the stalled-turn watchdog — the subagent is now running and
	// will reset the timer on every assistant turn.
	bumpStaleWatchdog(pi, rs);

	// Arm the stage-2 silence-kill timer (decision 015) — kills a child
	// silent for `silenceTimeoutMs` (no-op when disabled).
	armSilenceTimer(rs);

	return rs;
}

// ── Live Log Viewer TUI Component ────────────────────────────────────────

class LogViewer {
	constructor(
		private lines: string[],
		private agentName: string,
		private sessionId: string,
		private getStats: () => UsageStats,
		private maxHeight: number = 15,
	) {}

	/* TUI state */
	private lastLineCount = 0;
	private lastStatsSnapshot = "";
	private cachedWidth?: number;
	private cachedLines?: string[];

	invalidate(): void {
		this.cachedWidth = undefined;
		this.cachedLines = undefined;
	}

	render(width: number): string[] {
		const statsSnapshot = JSON.stringify(this.getStats());
		// Skip cache if lines and stats haven't changed
		if (this.cachedLines && this.cachedWidth === width && this.lastLineCount === this.lines.length && this.lastStatsSnapshot === statsSnapshot) {
			return this.cachedLines;
		}
		this.lastLineCount = this.lines.length;
		this.lastStatsSnapshot = statsSnapshot;

		// Build stats line
		const stats = this.getStats();
		const statsParts: string[] = [];
		if (stats.input) statsParts.push(`↑${formatTokens(stats.input)}`);
		if (stats.output) statsParts.push(`↓${formatTokens(stats.output)}`);
		if (stats.cacheRead) statsParts.push(`R${formatTokens(stats.cacheRead)}`);
		if (stats.cacheWrite) statsParts.push(`W${formatTokens(stats.cacheWrite)}`);
		if ((stats.cacheRead > 0 || stats.cacheWrite > 0) && stats.latestCacheHitRate !== undefined) {
			statsParts.push(`CH${stats.latestCacheHitRate.toFixed(1)}%`);
		}
		if (stats.cost) statsParts.push(`$${stats.cost.toFixed(3)}`);
		const statsLine = statsParts.length > 0 ? ` ${statsParts.join(" ")}` : "";

		const tail = this.lines.slice(-this.maxHeight);
		this.cachedLines = [
			truncateToWidth(`▸ Subagent: ${this.agentName}  |  ${this.sessionId}`, width),
			truncateToWidth(statsLine, width),
			...tail.map((l) => truncateToWidth(` ${l}`, width - 1)),
		];
		this.cachedWidth = width;
		return this.cachedLines;
	}
}

// ── Attach Editor ───────────────────────────────────────────────────────────

/**
 * Custom editor that intercepts submit to route user input to an attached
 * async subagent. Escape detaches; all other keys pass through to the
 * default editor (ctrl+d/exit, model switching, paste, autocomplete, etc.).
 */
class AttachEditor extends CustomEditor {
	handleInput(data: string): void {
		// Escape → detach (restore default editor, clear widget, clear state)
		if (matchesKey(data, Key.escape)) {
			if (_attachCtx) detach();
			return;
		}

		// Submit interception: route user text to the attached subagent
		if (this.keybindings.matches(data, "tui.input.submit") && !this.isShowingAutocomplete()) {
			const text = this.getExpandedText().trim();
			if (!text) return; // no-op on empty/whitespace submit

			this.setText(""); // clear the editor

			const id = attachedSessionId;
			if (!id) {
				// No target — shouldn't happen if editor is installed, but be safe
				debugLog("attach: submit with no attachedSessionId");
				return;
			}

			const rs = running.get(id);
			if (!rs || !rs.stdin || rs.stdin.destroyed) {
				// Session is gone — append a visible error line to the stream
				if (rs) {
					appendRunningLogLine(rs, "\x1b[31m[Session no longer accepting input — detach with Escape]\x1b[0m");
				}
				debugLog("attach: submit with no valid target (rs=" + !!rs + ")");
				return;
			}

			// Send the user's message to the child's RPC stdin
			rpcSend(rs.stdin, buildPromptPayload(text));

			// Log the user's message into the stream view so it appears inline
			appendRunningLogLine(rs, "\x1b[36m› " + text + "\x1b[0m");

			return; // consumed — do NOT pass to super (would send to parent)
		}

		// Everything else → normal editor behavior (ctrl+d/exit, model
		// switching, paste, autocomplete navigation, all editing keys)
		super.handleInput(data);
	}
}

// ── Attach widget ───────────────────────────────────────────────────────────

/**
 * Lightweight viewer for the attached session's log stream.
 * Resolves the target dynamically from `attachedSessionId` on each render
 * so target-switching and auto-detach work without re-installing the widget.
 * Delegates rendering to the existing `LogViewer` class.
 */
class AttachLogViewer {
	private viewer: LogViewer | null = null;
	private viewerId: string | null = null;

	invalidate(): void {
		this.viewer?.invalidate();
	}

	render(width: number): string[] {
		const id = attachedSessionId;
		if (!id) return [];
		const rs = running.get(id);
		if (!rs) return [truncateToWidth("(session ended)", width)];

		// Rebuild the inner LogViewer when the target changes
		if (this.viewerId !== id) {
			this.viewer = new LogViewer(rs.logLines, rs.agentName, rs.sessionId, () => rs.usageStats);
			this.viewerId = id;
		}

		const lines = this.viewer.render(width);
		// Prepend a clear header so it's visually distinct from /watch
		return [
			truncateToWidth(`\x1b[36m▸ ATTACHED: ${rs.agentName} | ${rs.sessionId}\x1b[0m`, width),
			...lines,
		];
	}
}

// ── Detach ──────────────────────────────────────────────────────────────────

/**
 * Internal detach routine. Restores the default editor, clears the attach
 * widget, resets module state, and updates the footer. Idempotent — safe to
 * call when not attached (no-op).
 *
 * Post-turn callers (auto-detach in the child's message_end / close handlers)
 * may run after the spawning session ended, so this NEVER touches a captured
 * spawn-time ctx — it routes UI restore/clear through the live-session ctx and
 * skips the UI work when there is none. Module attach state is always reset so
 * a later session doesn't inherit a stale attach target.
 *
 * Exported as an @internal test hook so the no-live-session guard can be
 * exercised directly.
 */
export function detach(): void {
	if (attachedSessionId === null) return;
	const ctx = liveSessionCtx;
	if (ctx) {
		ctx.ui.setEditorComponent(undefined);
		ctx.ui.setWidget("subagent-attach", undefined);
		ctx.ui.setStatus("subagent-attach", undefined);
	}
	attachedSessionId = null;
	_attachCtx = null;
	updateFooter();
}

// ── Tool action formatting ─────────────────────────────────────────────────

function formatToolAction(toolName: string, args: Record<string, any>): string {
	const shortenPath = (p: string) => {
		const home = os.homedir();
		return p.startsWith(home) ? `~${p.slice(home.length)}` : p;
	};
	const filePath = (args.file_path || args.path || "") as string;
	const short = filePath ? shortenPath(filePath) : "";

	switch (toolName) {
		case "read": return `read ${short}`;
		case "write": return `write ${short}`;
		case "edit": return `edit ${short}`;
		case "bash": {
			const cmd = (args.command as string) || "...";
			return `bash ${cmd.length > 40 ? cmd.slice(0, 40) + "..." : cmd}`;
		}
		case "grep": return `grep ${args.pattern || "..."}`;
		case "find": return `find ${args.pattern || "..."}`;
		case "subagent": return `subagent ${args.agent || "..."}`;
		case "checkpoint": return "checkpoint";
		default: return toolName;
	}
}

/** Arm the stalled-turn watchdog for `rs`. Each assistant turn resets
 *  it via bumpStaleWatchdog; if it fires, a wake-up is delivered to the
 *  caller without killing the subagent — they decide whether to
 *  continue, inspect, or stop. The wake-up is skipped when no live session
 *  exists (the timer can outlive the spawning session; `pi` is invalidated
 *  with the ctx). Exported as an @internal test hook. */
export function bumpStaleWatchdog(pi: ExtensionAPI, rs: RunningSubagent): void {
	if (rs.staleTimer) clearTimeout(rs.staleTimer);
	rs.staleTimer = setTimeout(() => {
		rs.staleTimer = null;
		// Skip if the subagent already finished between the timer fire
		// and our callback running — completion delivers its own message.
		if (rs.isDone || !running.has(rs.sessionId)) return;
		// Post-turn async path: the spawning session may have ended while the
		// child ran. pi invalidates its ExtensionAPI alongside the ctx, so
		// `pi.sendUserMessage` below would throw uncaught from this timer.
		// No live session → no receiver for a stall wake-up; skip.
		if (!liveSessionCtx) {
			debugLog(`stale-watchdog: no live session — skipping wake-up for ${rs.sessionId}`);
			return;
		}
		// If the subagent is parked in a nested wait (it dispatched a child
		// and is blocked on it), the stall is expected — soften the message
		// so the caller doesn't reach for subagent_stop prematurely. The
		// signal: its last tool call was `wait`, so currentActivity === "wait"
		// (formatToolAction falls through to the literal tool name).
		if (rs.progress.currentActivity === "wait") {
			pi.sendUserMessage(
				`[Subagent waiting] ${rs.agentName} (${rs.sessionId.slice(-8)}) has not advanced a turn in ${SUBAGENT_STALE_TURN_MS / 60000} minutes, but appears parked in a nested wait (dispatched a child and is blocked on it). This is usually expected — use subagent_status to inspect; use subagent_stop only if it seems genuinely stuck.`,
				{ deliverAs: "steer" },
			);
			return;
		}
		// A tool call is mid-execution (no RPC progress event arrives mid-tool,
		// so the turn legitimately hasn't produced an assistant message yet).
		// Soften the message so the caller doesn't mistake a healthy long
		// build/grep/read for a hang — observed false "stalled" warnings tripped
		// mid-bash-command (2026-08-08). The stage-2 silence timer (30 min) is
		// still the backstop if the tool genuinely deadlocks.
		if (rs.toolInFlight > 0) {
			pi.sendUserMessage(
				`[Subagent working] ${rs.agentName} (${rs.sessionId.slice(-8)}) has not advanced a turn in ${SUBAGENT_STALE_TURN_MS / 60000} minutes, but a tool call is still in flight. This is usually expected — use subagent_status to inspect; use subagent_stop only if it seems genuinely stuck.`,
				{ deliverAs: "steer" },
			);
			return;
		}
		// Activity within the softening window means the child is emitting —
		// LLM deltas and retry events arrive sub-second when a provider call
		// is grinding. The turn hasn't completed, but the child is
		// demonstrably alive; crying "stalled" here invited manual kills of
		// healthy children (issue #1 family).
		if (Date.now() - rs.lastActivityMs < STALL_SOFTEN_ACTIVITY_MS) {
			pi.sendUserMessage(
				`[Subagent streaming] ${rs.agentName} (${rs.sessionId.slice(-8)}) has not completed a turn in ${SUBAGENT_STALE_TURN_MS / 60000} minutes, but is still emitting activity (LLM response streaming or provider retries). This is usually expected under degraded provider latency — use subagent_status to inspect; use subagent_stop only if it seems genuinely stuck.`,
				{ deliverAs: "steer" },
			);
			return;
		}
		pi.sendUserMessage(
			`[Subagent stalled] ${rs.agentName} (${rs.sessionId.slice(-8)}) has not advanced a turn in ${SUBAGENT_STALE_TURN_MS / 60000} minutes. The subagent is still running — use subagent_status to inspect progress or subagent_stop to terminate.`,
			{ deliverAs: "steer" },
		);
	}, SUBAGENT_STALE_TURN_MS);
}

// ── Decision 015: silence-based stage-2 auto-kill ─────────────────────────
//
// Stage 1 (above) wakes the caller after a stale turn; stage 2 kills a
// child that has been SILENT — no tool calls AND no assistant messages, per
// `lastActivityMs` — for `silenceTimeoutMs` (default 30 min, strictly longer
// than SUBAGENT_STALE_TURN_MS). The kill reuses the `subagent_kill`
// dispatch (dispatchKillSignals) so there is exactly one SIGTERM→SIGKILL
// path; the delivered marker is greppable as `[Killed via progress-timeout]`
// and the session file is preserved, so `subagent_resume` can continue the
// killed session.

/** Record a progress signal from the child — tool lifecycle, streaming tool
 *  output, LLM-call streaming + provider retries (the ACTIVITY_EVENT_TYPES
 *  union), assistant message_end, or any log output. The stage-2
 *  silence-kill timer reads this timestamp to tell a hung child from a
 *  slow-but-healthy one. */
function bumpActivity(rs: RunningSubagent): void {
	rs.lastActivityMs = Date.now();
}

// ── Sleep guard: caffeinate + sleep-aware silence accounting ──────────────
//
// macOS system sleep suspends pi and every subagent with it, but Date.now()
// advances across the suspension — so decision 015's silence budget billed
// sleep as child silence and killed healthy subagents on wake (observed
// 2026-08-08, recurrent through 2026-08-11/12: auto-kills firing 10–35 min
// overdue; pmset showed ~15-min Sleep-Service cycles on battery). Two guards:
//
//  (1) caffeinate -s -i holds a PreventSystemSleep assertion while any child
//      runs, so the machine doesn't sleep mid-task (AC; macOS won't honor it
//      indefinitely on battery). Lifecycle tracks the running set via
//      reconcileSleepGuards(), which updateFooter calls on every transition.
//  (2) a 10s heartbeat (heartbeatTick) detects suspension — a tick landing
//      >slack late means the process was asleep — and discounts the slept
//      interval from every child's lastActivityMs, then re-arms. The
//      just-woke guard in armSilenceTimer (above) keeps an overdue silence
//      timer from firing on an inflated gap before the heartbeat corrects it.
//
// Neither guard disables stage 2: a child silent while AWAKE (no tool calls,
// no log output, no tool_execution_update) is still killed at
// silenceTimeoutMs — the deadlock backstop decision 015 preserves.

/** Start the heartbeat + caffeinate when the first child dispatches; stop
 *  when the running set empties so the machine may sleep when idle.
 *  Idempotent — called from updateFooter on every running-map transition. */
function reconcileSleepGuards(): void {
	if (running.size > 0 && !heartbeatTimer) startSleepGuards();
	else if (running.size === 0 && heartbeatTimer) stopSleepGuards();
}

function startSleepGuards(): void {
	lastHeartbeatMs = Date.now();
	heartbeatTimer = setInterval(heartbeatTick, SLEEP_GUARD_HEARTBEAT_MS);
	heartbeatTimer.unref();
	// Hold PreventSystemSleep (-s) + prevent idle sleep (-i) for the running
	// set's lifetime. -w <pi pid> frees cleanup: caffeinate exits when pi
	// exits. macOS only — the heartbeat covers platforms where this is a
	// no-op (and battery, where the assertion isn't honored long-term).
	if (process.platform === "darwin" && !caffeinateProc) {
		try {
			caffeinateProc = spawn("caffeinate", ["-s", "-i", "-w", String(process.pid)], { stdio: "ignore" });
			caffeinateProc.unref();
			caffeinateProc.on("error", () => { caffeinateProc = null; });
		} catch { caffeinateProc = null; }
	}
}

function stopSleepGuards(): void {
	if (heartbeatTimer) { clearInterval(heartbeatTimer); heartbeatTimer = null; }
	if (caffeinateProc) { try { caffeinateProc.kill(); } catch { /* */ } caffeinateProc = null; }
}

/** Heartbeat: if this tick landed >slack late, the process was suspended
 *  (system sleep). Date.now() advanced across it but the children could not
 *  emit activity, so each silence budget is inflated by the suspension —
 *  discount it (bump lastActivityMs forward) and re-arm. Errs slightly toward
 *  over-discounting (forgives ~one heartbeat of legitimate silence per
 *  sleep), the safe direction: never kill healthy work for sleep. */
function heartbeatTick(): void {
	const now = Date.now();
	const elapsed = now - lastHeartbeatMs;
	lastHeartbeatMs = now;
	if (elapsed <= SLEEP_GUARD_HEARTBEAT_MS + SLEEP_GUARD_SLACK_MS) return;
	const oversleep = elapsed - SLEEP_GUARD_HEARTBEAT_MS;
	for (const rs of running.values()) {
		rs.lastActivityMs += oversleep;
		if (rs.silenceTimeoutMs > 0) armSilenceTimer(rs);
	}
}

/** Arm the stage-2 silence-kill timer for `rs`. Mirrors the stage-1
 *  watchdog's setTimeout chain: fires when the child has been silent for
 *  `silenceTimeoutMs` and re-arms from its own callback when activity has
 *  slid the deadline (activity merely bumps `lastActivityMs`; the callback
 *  re-checks staleness at fire time). `silenceTimeoutMs <= 0` disables
 *  stage 2 entirely. */
function armSilenceTimer(rs: RunningSubagent): void {
	if (rs.silenceTimer) clearTimeout(rs.silenceTimer);
	if (rs.silenceTimeoutMs <= 0) { rs.silenceTimer = null; return; }
	// Just-woke window (sleep guard): if the heartbeat hasn't reconciled
	// since the process resumed, the wall-clock silence may still include
	// suspension we haven't discounted yet. Defer — re-arm after one
	// heartbeat interval instead of evaluating (and firing on) an inflated
	// gap. The heartbeat tick will discount the slept interval and call
	// armSilenceTimer again with a corrected budget.
	if (Date.now() - lastHeartbeatMs > SLEEP_GUARD_HEARTBEAT_MS + SLEEP_GUARD_SLACK_MS) {
		rs.silenceTimer = setTimeout(() => { rs.silenceTimer = null; armSilenceTimer(rs); }, SLEEP_GUARD_HEARTBEAT_MS);
		return;
	}
	const silentFor = Date.now() - rs.lastActivityMs;
	const remaining = rs.silenceTimeoutMs - silentFor;
	if (remaining <= 0) {
		// Already silent past the budget — fire immediately (guards inside).
		rs.silenceTimer = null;
		fireSilenceKill(rs);
		return;
	}
	rs.silenceTimer = setTimeout(() => {
		rs.silenceTimer = null;
		// Re-check staleness: activity may have landed while the timer was
		// pending (e.g. a log line between arm and fire). If so, slide the
		// deadline rather than killing an active child.
		if (Date.now() - rs.lastActivityMs < rs.silenceTimeoutMs) {
			armSilenceTimer(rs);
			return;
		}
		fireSilenceKill(rs);
	}, remaining);
}

/** Stage-2 auto-kill: the child has been silent for `silenceTimeoutMs`.
 *  Guards mirror the kill path's idempotency — an already stopped/killed/
 *  completed child (or one that left the running set) is a no-op, so the
 *  auto-kill never double-fires and never races an explicit stop/kill. */
function fireSilenceKill(rs: RunningSubagent): void {
	if (rs.isDone || rs.killedExplicitly || rs.stoppedExplicitly || !running.has(rs.sessionId)) return;
	// A child parked in a nested wait is expected-silent: the `wait` tool only
	// parks it when it has live children to block on, and those children's own
	// silence timers handle genuine hangs. Killing the parent here would
	// cascade to those children for no benefit, and wall-clock silence can't
	// distinguish "hung" from "frozen by system sleep" — observed 2026-08-08:
	// an implementer parked in wait was progress-timeout-killed on laptop
	// wake (its timers had frozen during sleep and fired overdue on resume),
	// taking its reviewers with it. The stage-1 watchdog already told the
	// caller this child is waiting ("[Subagent waiting]"), so skip stage 2 and
	// let the caller, or the children's timers, resolve it.
	if (rs.progress.currentActivity === "wait") return;
	dispatchKillSignals(rs, "progress-timeout");
}

/** Shared kill dispatch — SIGTERM immediately, SIGKILL after
 *  HARD_KILL_DELAY_MS, idempotent, cancels the stale-turn watchdog and the
 *  stage-2 silence timer. Single implementation used by both the
 *  `subagent_kill` tool and the stage-2 progress-timeout auto-kill
 *  (decision 015) — never fork a second kill path. The close handler is
 *  the single owner of delivery; it reads `killedExplicitly`/`killedVia`
 *  and prepends the marker. Returns `alreadyDead` so callers can report
 *  dispatch status, and `noProcess` when the entry had no live process
 *  (recovered/pre-reload session) — callers must distinguish that from a
 *  raced exit. Exported as an @internal test hook so the kill paths can be
 *  exercised with stubbed procs. */
export function dispatchKillSignals(rs: RunningSubagent, via: "kill-tool" | "progress-timeout" | "turn-limit"): { alreadyDead: boolean; noProcess?: boolean } {
	// Order matters: set the flags BEFORE any proc access or signal so the
	// close handler observes them on entry — including the null-proc
	// (recovered/pre-reload) path below.
	rs.killedExplicitly = true;
	rs.killedVia = via;

	// Cancel the stalled-turn watchdog so a killed subagent doesn't get a
	// spurious [Subagent stalled] wake-up racing the close handler's
	// cleanup, and cancel the stage-2 silence timer so it cannot re-arm or
	// double-fire. The close handler also clears both timers in its own
	// cleanup section, but doing it here closes the race where a timer
	// fires between SIGTERM dispatch and the close handler reaching that
	// section — `bumpStaleWatchdog`'s guard `running.has(rs.sessionId)` is
	// not enough because the close handler runs `running.delete` AFTER the
	// cleanup phase.
	if (rs.staleTimer) { clearTimeout(rs.staleTimer); rs.staleTimer = null; }
	if (rs.silenceTimer) { clearTimeout(rs.silenceTimer); rs.silenceTimer = null; }

	const viaLabel = via === "kill-tool" ? "subagent_kill" : via;

	// Recovered/pre-reload sessions are reconstructed from disk with a null
	// proc (session_start re-attach — `proc: null` in that path); there is
	// no live process to signal. The flags are already set above (the close
	// handler and `killedMarker` depend on them), so log a distinct marker
	// and report `{ alreadyDead: true, noProcess: true }` — nothing to
	// signal. Never dereference `rs.proc` on this path, including the
	// SIGKILL fallback below.
	if (!rs.proc) {
		appendRunningLogLine(rs, `── Killed via ${viaLabel} — process handle unavailable (recovered/pre-reload session), marked killed, no signal sent ──`);
		return { alreadyDead: true, noProcess: true };
	}

	// Log a visible kill marker to /watch and the persisted log so the
	// orchestrator / user see the kill even if the close handler is
	// delayed. Mirrors the closure-scoped `logEntry` helper inside
	// `spawnSubagent`, since tool bodies do not share that closure.
	appendRunningLogLine(rs, `── Killed via ${viaLabel} (SIGTERM sent, SIGKILL in ${HARD_KILL_DELAY_MS / 1000}s if needed) ──`);

	const alreadyDead = rs.proc.killed || rs.proc.exitCode !== null;
	if (!alreadyDead) {
		try {
			rs.proc.kill("SIGTERM");
		} catch {
			// proc.kill can throw on an already-dead proc; the close
			// handler will still fire (or has already fired) and
			// deliver the result. Swallow.
		}
		setTimeout(() => {
			// Re-check `rs.proc` here rather than trusting the dispatch-time
			// check: the handle could be gone by the time the fallback fires.
			// Guarding the callback itself keeps every `rs.proc` dereference
			// behind a non-null check (WO-2026-043 verification requirement).
			if (rs.proc && !rs.proc.killed && rs.proc.exitCode === null) {
				try { rs.proc.kill("SIGKILL"); } catch { /* */ }
			}
		}, HARD_KILL_DELAY_MS);
	}
	return { alreadyDead };
}

/** Marker prefix for a delivered kill result. Mirrors the `subagent_kill`
 *  marker; the stage-2 variant is greppable as `[Killed via progress-timeout]`
 *  and the turn-limit variant as `[Killed via turn-limit]`. */
function killedMarker(rs: RunningSubagent): string | null {
	if (!rs.killedExplicitly) return null;
	if (rs.killedVia === "progress-timeout")
		return "[Killed via progress-timeout — process terminated, work in this subagent is lost]";
	if (rs.killedVia === "turn-limit")
		return "[Killed via turn-limit — process terminated, work in this subagent is lost]";
	return "[Killed via subagent_kill — process terminated, work in this subagent is lost]";
}

/** Close-handler delivery decision — the single owner of result delivery
 *  (decision 015 / WO-2026-043 contract). Exactly one path runs: a pending
 *  stop waiter (`resolveOnStop`) is resolved — with the kill marker
 *  prepended when the session was killed — and the waiter is nulled;
 *  otherwise the result is delivered as a user message via `deliverResult`.
 *  The two are mutually exclusive, which is what guarantees no double
 *  delivery. Returns which path ran so callers can log it. Exported as an
 *  @internal test hook so the mutual-exclusion contract can be exercised
 *  without spawning a real child process. */
export function deliverCloseResult(pi: ExtensionAPI, rs: RunningSubagent, code: number, commitNote?: string): "stop" | "deliver" {
	if (rs.resolveOnStop) {
		let stoppedText = getFinalOutput(rs.messages) + commitNote;
		// Kill marker keyed on the kill source (subagent_kill tool vs
		// decision 015 stage-2 progress-timeout auto-kill).
		const marker = killedMarker(rs);
		if (marker) {
			stoppedText = marker + "\n" + stoppedText;
		}
		rs.resolveOnStop(stoppedText);
		rs.resolveOnStop = null;
		return "stop";
	}
	deliverResult(pi, rs, code, commitNote);
	return "deliver";
}

/** Deliver the final result message to the parent — used by the
 *  close-handler `deliver` path (via `deliverCloseResult`) and by the
 *  recovered-session socket-close handler, which always delivers. Prepends
 *  the kill marker when `killedExplicitly` is set. Exported as an
 *  @internal test hook so the delivered-marker contract (WO-2026-043
 *  integration contract) can be exercised with a stub `ExtensionAPI`. */
export function deliverResult(pi: ExtensionAPI, rs: RunningSubagent, exitCode: number, isolationNote?: string): void {
	// No live session → the parent cannot receive the result. pi invalidates
	// its ExtensionAPI alongside the ctx, so `pi.sendUserMessage` would throw
	// from inside the child's close handler. Skip deliberately (not a
	// try/catch): the child's own session file and
	// /tmp/pi-subagent-<id>.log retain the full output.
	// See decisions/subagents/026-subagent-events-after-session-disposal.md.
	if (!liveSessionCtx) {
		debugLog(`deliverResult: no live session — dropping result for ${rs.sessionId} (output retained in ${rs.logPath})`);
		return;
	}
	const output = getFinalOutput(rs.messages) || "(no output)";

	const wasAborted = exitCode !== 0 && rs.progress.turns < MAX_TURNS_HARD;
	// A kill (subagent_kill tool or decision 015 stage-2 progress-timeout)
	// supersedes the standard prefix — make the marker the first line of
	// the delivered message so the orchestrator sees what happened.
	const killedNote = killedMarker(rs);
	const prefix = killedNote
		? killedNote
		: `[Subagent ${rs.agentName} ${wasAborted ? "aborted" : "finished"}]`;

	// Surface child stderr when the agent never made a turn. The most
	// common cause is a child `pi` that failed to start (broken extension,
	// missing binary, auth error, etc.) — without this, the orchestrator
	// sees only "exit 1, 0 turns" and has no signal for debugging.
	const stderrNote = rs.progress.turns === 0 && rs.stderrLines.length > 0
		? `Child stderr (${rs.stderrLines.length} line${rs.stderrLines.length === 1 ? "" : "s"}):\n\`\`\`\n${rs.stderrLines.slice(-30).join("\n")}\n\`\`\``
		: null;

	const message = [
		`${prefix} — session: ${rs.sessionId}`,
		`Task: ${rs.task.slice(0, 200)}${rs.task.length > 200 ? "..." : ""}`,
		`Turns: ${rs.progress.turns} | Files read: ${rs.progress.filesRead.size} | Files modified: ${rs.progress.filesModified.size}`,
		rs.progress.errors.length > 0
			? `Errors: ${rs.progress.errors.slice(0, 3).join("; ")}`
			: null,
		isolationNote || null,
		stderrNote,
		"---",
		output,
	]
		.filter(Boolean)
		.join("\n");

	pi.sendUserMessage(message, { deliverAs: "steer" });
}

// ── Footer ─────────────────────────────────────────────────────────────────

/** Update the subagent footer on the LIVE session. Post-turn async callers
 *  (socket data handlers, child close handlers) may run after the spawning
 *  session ended, when the captured spawn-time ctx is invalidated — so this
 *  reads the live-session ctx and no-ops when there is none. Exported as an
 *  @internal test hook. */
export function updateFooter(): void {
	reconcileSleepGuards();
	// No live session → nothing to render on. Deliberately not a try/catch:
	// an explicit liveness check, per
	// decisions/subagents/026-subagent-events-after-session-disposal.md.
	if (!liveSessionCtx) return;
	if (running.size === 0) {
		liveSessionCtx.ui.setStatus("subagent-async", undefined);
		return;
	}
	const parts: string[] = [];
	for (const rs of running.values()) {
		parts.push(`${rs.agentName} (${rs.progress.turns}t)`);
	}
	liveSessionCtx.ui.setStatus("subagent-async", `subagents: ${parts.join(", ")}`);
}

/** Notify the parent that an attached subagent ended. Post-turn async path —
 *  the child can outlive the session that spawned it, so this notifies only
 *  while a live session ctx exists (mirrors `updateFooter`/`deliverResult`).
 *  The captured spawn-time ctx is never used here. Exported as an @internal
 *  test hook. */
export function notifyChildDetached(rs: RunningSubagent): void {
	if (!liveSessionCtx) return;
	liveSessionCtx.ui.notify(`Subagent ${rs.sessionId.slice(-8)} ended — detached.`, "info");
}

// ── Orphan recovery scan ─────────────────────────────────────────────────────

export interface RecoveryScanDeps {
	/** Directory holding the `pi-subagent-*.{sock,log,meta.json}` triplets. */
	dir?: string;
	/** Override for the current process pid (tests). */
	selfPid?: number;
	/** Override for the OS owner probe (tests). */
	probe?: OwnerProbe;
	/** Override for the socket client factory (tests). */
	connect?: (sockPath: string) => net.Socket;
}

/**
 * `session_start` recovery scan: re-attach to subagent sockets left behind by a
 * previous session. Decision 027 gates adoption on the spawning process's
 * identity (see `decideRecoveryAdoption`); a live foreign owner is skipped.
 *
 * Extracted with injectable directory / pid / probe / connection factory so the
 * adopt-skip matrix and the `unref` contract are unit-testable without touching
 * /tmp or opening real sockets. Best-effort: never throws (the caller also
 * wraps it, but keeping the scan self-contained makes every branch safe).
 */
export function recoverOrphanedSubagents(
	pi: ExtensionAPI,
	ctx: any,
	deps: RecoveryScanDeps = {},
): void {
	try {
		const sockDir = deps.dir ?? recoveryScanDirOverride ?? "/tmp";
		const connect = deps.connect ?? ((p: string) => net.createConnection(p));
		let files: string[];
		try {
			files = fs.readdirSync(sockDir).filter((f) => f.startsWith("pi-subagent-") && f.endsWith(".sock"));
		} catch {
			return;
		}
		for (const f of files) {
			const sid = f.replace("pi-subagent-", "").replace(".sock", "");
			if (running.has(sid)) continue; // already tracked

			const sockPath = path.join(sockDir, f);
			const logPath = sockPath.replace(".sock", ".log");
			const metaPath = sockPath.replace(".sock", ".meta.json");

			// Read metadata written at spawn time
			let meta: any = null;
			try { meta = JSON.parse(fs.readFileSync(metaPath, "utf-8")); } catch { continue; }

			// Decision 027: adopt only if the owner is this process (session
			// reload / new in the same process) or the owner process is gone.
			const adoption = decideRecoveryAdoption(meta, { selfPid: deps.selfPid, probe: deps.probe });
			if (adoption !== "adopt") {
				debugLog(`recovery: ${adoption} for ${sid} (ownerPid=${meta?.ownerPid ?? "none"})`);
				continue;
			}

			// Parse current turns from log
			let turns = 0;
			try {
				const log = fs.readFileSync(logPath, "utf-8");
				turns = (log.match(/── Turn (\d+) ──/g) || []).length;
			} catch {}

			const rs: RunningSubagent = {
				proc: null as any,
				sessionId: sid,
				agentName: meta.agentName || "?",
				task: meta.task || "?",
				cwd: meta.cwd || ctx.cwd,
				startedAt: meta.startedAt || Date.now(),
				progress: { turns, filesRead: new Set(), filesModified: new Set(), errors: [], currentActivity: "recovered" },
				messages: [],
				stdin: null,
				resolveOnStop: null,
				isDone: false,
				procExited: false,
				// Recovered subagents are re-attached to a fresh pi
				// session; the kill flag never applies (the previous
				// session died, not killed). Initialize to false to
				// satisfy the RunningSubagent interface contract.
				// `stoppedExplicitly` is likewise N/A on recovery.
				killedExplicitly: false,
				stoppedExplicitly: false,
				turnNudged: false,
				toolInFlight: 0,
				logPath,
				logLines: [],
				stderrLines: [],
				watchHandle: null,
				sockPath,
				sockServer: null as any,
				sockClients: new Set(),
				worktreePath: meta.worktreePath || null,
				isolationBranch: meta.isolationBranch || null,
				parentHeadCommit: meta.parentHeadCommit || null,
				parentCwd: meta.parentCwd || ctx.cwd,
				workRecord: meta.workRecord,
				// Recovered (orphan-reattached) subagents don't carry the
				// parent's tracker key from the metadata file. Use a stable
				// pid fallback so re-attached sessions don't pollute the
				// live tracker's view. If we had a `parentSessionId` field
				// in the meta file, we'd use it here instead.
				parentTrackerKey: getParentTrackerKey(ctx),
				reviewParentRequirements: undefined,
				usageStats: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, latestCacheHitRate: undefined },
				carried: null,
				staleTimer: null,
				lastActivityMs: Date.now(),
				silenceTimer: null,
				silenceTimeoutMs: 0,
				killedVia: null,
			};

			// Monitor via socket — when it closes, subagent exited.
			// The socket may already be dead (previous pi died without
			// cleanup), in which case connect() fails with ECONNREFUSED.
			// Without an `error` handler that event becomes an
			// uncaughtException and crashes the new pi session.
			const sock = connect(sockPath);
			// Decision 027 liveness hygiene: a recovery connection must NEVER
			// pin the event loop, or `pi -p` hangs until the recovered child
			// exits. unref is unconditional — a recovered child is not this
			// process's own work (the spawn-time handles stay ref'd on
			// purpose; see decision 027).
			sock.unref();
			let connected = false;
			sock.on("connect", () => {
				connected = true;
			});
			sock.on("error", () => {
				rs.sockClients.delete(sock);
				if (connected) return; // socket lived, then died — close handler will run
				// Orphan: previous session left a sock file behind with no listener.
				// Clean up and skip live tracking.
				try {
					fs.unlinkSync(sockPath);
				} catch {
					/* already gone */
				}
				running.delete(sid);
				updateFooter();
			});
			sock.on("close", () => {
				rs.sockClients.delete(sock);
				if (!connected) return; // orphan already handled in error handler
				rs.isDone = true;
				// Read final output from log
				let finalOutput = "(no output)";
				try {
					const log = fs.readFileSync(logPath, "utf-8");
					const match = log.match(/── (Completed|Exited|Stopped) \((\d+) turns, exit (\d+)\)/);
					if (match) {
						rs.progress.turns = parseInt(match[2]);
						finalOutput = log.split("── ").pop()?.trim() || finalOutput;
					}
				} catch {}
				// The recovered child's messages never reached this process; its session file has them.
				const recordNotes = rs.workRecord
					? completeWorkRecord(rs.workRecord, meta.piSessionId ?? sid, () => sessionFinalText(meta.sessionFile))
					: [];
				rs.recordNotes = recordNotes;
				deliverResult(pi, rs, 0, `\n[Isolation] Recovered from previous session.${recordNotes.map((n) => `\n${n}`).join("")}`);
				running.delete(sid);
				updateFooter();
			});

			rs.sockClients.add(sock);
			running.set(sid, rs);
			updateFooter();
		}
	} catch { /* best-effort */ }
}

// ── Extension entry point ──────────────────────────────────────────────────

export default function (pi: ExtensionAPI) {
	// ── Session lifecycle ──────────────────────────────────────────────

	pi.on("session_start", async (_event, ctx) => {
		// Track the live-session ctx before anything else can touch the UI.
		// Every post-turn async path (footer, delivery, child-end notify,
		// attach cleanup) reads this instead of a captured spawn-time ctx.
		liveSessionCtx = ctx;
		try {
			const agents = discoverAgents(ctx.cwd, "user").agents;
			const agentNames = agents.map((agent) => agent.name).sort();
			const text = `[Subagents] ${agentNames.length} available: ${agentNames.join(", ") || "none"}`;
			pi.events.emit(STARTUP_SUMMARY_EVENT, { key: "subagents", order: 20, text });
		} catch (error) {
			const detail = error instanceof Error ? error.message : String(error);
			const text = `[Subagents] Unable to list available subagents: ${detail}`;
			pi.events.emit(STARTUP_SUMMARY_EVENT, { key: "subagents", order: 20, text });
		}

		// Re-attach to orphaned subagents from a previous session.
		// Decision 027: the scan gates adoption on the spawning process's
		// recorded identity, so a live foreign session's children are left
		// alone. See `recoverOrphanedSubagents`.
		try { recoverOrphanedSubagents(pi, ctx); } catch { /* best-effort */ }
	});

	pi.on("session_shutdown", () => {
		// Clear the live-session ctx. pi emits this BEFORE invalidating the
		// extension runner, so async child callbacks that observe a null ctx
		// skip UI/delivery instead of throwing on a stale ctx.
		liveSessionCtx = null;
		// Don't kill subagents — they survive parent reloads/restarts.
		// Their work commits to branches and is recoverable via git merge.
		// Socket servers and log files persist at /tmp/pi-subagent-<sid>.*
	});

	// ── /subagents command ──────────────────────────────────────────────

	pi.registerCommand("subagents", {
		description: "List running async subagents",
		handler: async (_args, ctx) => {
			if (running.size === 0) {
				ctx.ui.notify("No subagents running.");
				return;
			}
			const lines = Array.from(running.values()).map((rs) => formatProgress(rs));
			ctx.ui.notify(lines.join("\n\n"));
		},
	});

	pi.registerCommand("watch", {
		description: "Show a live log panel for a running subagent. Usage: /watch <session-id> or /watch off",
		handler: async (args, ctx) => {
			const sid = args.trim();

			// Turn off current watch if "off" or empty
			if (!sid || sid === "off") {
				ctx.ui.setWidget("subagent-watch", undefined);
				ctx.ui.notify("Watch cleared.");
				return;
			}

			// Match by full session ID, bare tail, or `subagent-`-prefixed tail
			const rs = findRunningByQuery(running, sid);
			if (!rs) {
				ctx.ui.notify(`No running subagent matching "${sid}".`);
				return;
			}

			// Build the widget
			const viewer = new LogViewer(
				rs.logLines,
				rs.agentName,
				rs.sessionId,
				() => rs.usageStats,
			);
			rs.watchHandle = ctx.ui.setWidget("subagent-watch", () => viewer, { placement: "belowEditor" });

			ctx.ui.notify(`Watching ${rs.agentName} (${rs.sessionId}). Use /watch off to close.`);
		},
	});

	// ── /attach ──────────────────────────────────────────────────────────

	pi.registerCommand("attach", {
		description: "Attach to a running async subagent to converse directly. Usage: /attach <session-id>",
		handler: async (args, ctx) => {
			const sid = args.trim();

			// Empty arg while attached → convenience detach
			if (!sid) {
				if (attachedSessionId !== null) {
					detach();
					ctx.ui.notify("Detached.", "info");
					return;
				}
				ctx.ui.notify("Usage: /attach <session-id>", "info");
				return;
			}

			// Resolve target — all guards are in the pure helper
			const result = resolveAttachTarget(running, sid);
			if (!result.ok) {
				const msgs: Record<string, string> = {
					empty: "Usage: /attach <session-id>",
					notFound: `No running session matches "${sid}".`,
					done: `Session "${sid}" has completed; nothing to attach to.`,
					noStdin: `Session "${sid}" is not accepting input.`,
				};
				const level = result.reason === "notFound" || result.reason === "done" || result.reason === "noStdin"
					? "warning" : "info";
				ctx.ui.notify(msgs[result.reason], level);
				return;
			}

			const rs = result.rs;

			// Capture ctx for editor-internal use (escape-detach, notify)
			_attachCtx = ctx;

			// Already attached to the same session — no-op
			if (attachedSessionId === rs.sessionId) {
				ctx.ui.notify(`Already attached to ${rs.sessionId.slice(-8)}.`, "info");
				return;
			}

			// Switching target (already attached to a different session)
			const wasAttached = attachedSessionId !== null;
			attachedSessionId = rs.sessionId;

			if (wasAttached) {
				ctx.ui.notify(`Switched attach target → ${rs.sessionId.slice(-8)}`, "info");
			}

			// Install the attach stream widget (only if not already attached;
			// the widget resolves its target dynamically so switching works
			// without re-installing).
			if (!wasAttached) {
				const attachViewer = new AttachLogViewer();
				ctx.ui.setWidget("subagent-attach", () => attachViewer, { placement: "belowEditor" });
			}

			// Install the AttachEditor (only if not already attached; setEditorComponent
			// creates a fresh editor each call and would lose in-progress text).
			if (!wasAttached) {
				ctx.ui.setEditorComponent((tui, theme, kb) => new AttachEditor(tui, theme, kb));
			}

			// Update footer / status line
			ctx.ui.setStatus("subagent-attach", `▸ attached: ${rs.agentName} (${rs.sessionId.slice(-8)})`);

			if (!wasAttached) {
				ctx.ui.notify(
					`Attached to ${rs.agentName} (${rs.sessionId.slice(-8)}). Type /detach or Escape to return.`,
					"info",
				);
			}
		},
	});

	// ── /detach ──────────────────────────────────────────────────────────

	pi.registerCommand("detach", {
		description: "Detach from the foregrounded subagent and return to the parent session.",
		handler: async (_args, ctx) => {
			if (attachedSessionId === null) {
				ctx.ui.notify("Not currently attached.", "info");
				return;
			}
			detach();
			ctx.ui.notify("Detached.", "info");
		},
	});

	// ── Tools ───────────────────────────────────────────────────────────

	const SubagentParams = Type.Object({
		agent: Type.String({ description: "Name of the agent to invoke" }),
		task: Type.String({ description: "Task to delegate" }),
		cwd: Type.Optional(Type.String({ description: "Working directory for the subagent process" })),
		inheritParentModel: Type.Optional(
			Type.Boolean({
				description:
					"Use the parent session's active model instead of the agent default. The orchestrator agent always inherits the caller's model regardless of this flag; it is how every other agent opts in.",
				default: false,
			}),
		),
		isolate: Type.Optional(
			Type.Boolean({
				description: "Run in an isolated git worktree to avoid file conflicts with concurrent subagents. Default: true. When true, a git worktree is created on a branch off the parent HEAD. On completion, uncommitted changes are auto-committed to that branch, the worktree is removed, and the branch remains for the calling session to inspect and merge.",
				default: true,
			}),
		),
		carryUncommitted: Type.Optional(
			Type.Boolean({
				description: "Carry the parent's uncommitted working-tree state (untracked, modified, staged, deleted files) into the isolated worktree at creation, so the subagent sees what the orchestrator prepared. Default: true. Ignored when baseRef is set — the worktree then branches from that ref's tree. Set false to reproduce HEAD-only behavior.",
				default: true,
			}),
		),
		baseRef: Type.Optional(
			Type.String({
				description: "Git ref (commit hash, branch, or tag) to fork the worktree from. Defaults to HEAD if omitted. Use this when changes are on a feature branch that isn't ready for main — pass the branch name or ref. If changes are only in the working tree, create a feature branch, commit them, and pass that branch.",
			}),
		),
		review_policy: Type.Optional(
			Type.Union([Type.Literal("required"), Type.Literal("skip")], {
				description: "Mirrors the work-order `review_policy` field. Pass `skip` to suppress the harness's post-implementation review guard for this spawn (use for trivial changes where the orchestrator will review the diff directly, or for ad-hoc dispatches without a formal work order). Default: `required`.",
			}),
		),
		workOrderPath: Type.Optional(
			Type.String({
				description: "Repo-relative path to the work order this task executes (e.g. `work-orders/WO-2026-037.md`). When set, the harness reads the work order from the parent checkout at spawn time and derives the review-gate decision from its declared `review_policy` — the WO is the single source of truth. The spawn hard-fails with a loud error if the file is missing or unreadable.",
			}),
		),
		silenceTimeoutMs: Type.Optional(
			Type.Number({
				description: "Kill the subagent if it makes no progress (no tool calls and no assistant messages) for this many milliseconds. Default 1800000 (30 min). 0 or negative disables the auto-kill. Stage-1 wake-up warnings are unaffected.",
				default: 1800000,
			}),
		),
	});

	const StatusParams = Type.Object({
		session_id: Type.String({ description: "Session ID of the running subagent (full id, or its last 8+ characters)" }),
	});

	const SteerParams = Type.Object({
		session_id: Type.String({ description: "Session ID of the running subagent (full id, or its last 8+ characters)" }),
		message: Type.String({ description: "Steering message to inject" }),
	});

	const StopParams = Type.Object({
		session_id: Type.String({ description: "Session ID of the running subagent (full id, or its last 8+ characters)" }),
		final_message: Type.Optional(
			Type.String({ description: "Final steering message before stopping" }),
		),
	});

	const KillParams = Type.Object({
		session_id: Type.String({ description: "Session ID of the running subagent to hard-kill (full id, or its last 8+ characters)" }),
	});

	// If the EFFECTIVE review policy is "skip" — from the referenced work
	// order when `workOrderPath` is set (decision 014), else from the
	// `review_policy` tool param — but the task does not already declare it
	// with the bold line, append one so the implementer's own agent-level
	// reasoning (Gate B) matches the harness's gate suppression (Gate A).
	// Single source of truth: the work order, when `workOrderPath` is set;
	// else the tool arg. When the WO declares `required`, nothing is injected
	// even if the param says `skip` — the WO wins.
	function maybeInjectReviewPolicySkip(task: string, reviewPolicy: "required" | "skip" | undefined): string {
		if (reviewPolicy !== "skip") return task;
		if (taskDeclaresPolicySkip(task)) return task;
		const skipLine = "\n\n- **review_policy**: skip (set by orchestrator on the subagent call — do not spawn reviewers; orchestrator will review the diff directly)";
		return task + skipLine;
	}

	// ── subagent ───────────────────────────────────────────────────────

	pi.registerTool({
		name: "subagent",
		label: "Subagent (async)",
		description:
			"Spawn a subagent that runs in the background. The parent remains interactive. " +
			"Use subagent_status to check progress, subagent_steer to inject guidance, " +
			"and subagent_stop to tell it to wrap up. Results are delivered as a user message when the subagent finishes. " +
			"After a subagent finishes, use `subagent_resume` with the same session_id to continue the same conversation instead of starting fresh.",
		parameters: SubagentParams,
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			// One id everywhere: the handle is passed to the child as
			// --session-id, so it is also the subagent's pi session id —
			// searchable in /resume and joinable via `pi --session-id <id>`.
			const sessionId = `subagent-${randomUUID()}`;
			const cwd = params.cwd ?? ctx.cwd;

			const agents = discoverAgents(cwd, "user").agents;
			const agent = agents.find((a) => a.name === params.agent);
			if (!agent) {
				const available = agents.map((a) => a.name).join(", ") || "none";
				return {
					content: [{ type: "text", text: `Unknown agent: "${params.agent}". Available: ${available}` }],
				};
			}

			// Check if the parent restricted sub-spawning via PI_SUBAGENT_ALLOWLIST
			const allowlist = process.env.PI_SUBAGENT_ALLOWLIST;
			if (allowlist) {
				const allowed = new Set(
					allowlist.split(",").map((a: string) => a.trim()).filter(Boolean),
				);
				if (!allowed.has(agent.name)) {
					const requested = agent.name;
					const allowedList = [...allowed].sort().join(", ") || "(empty)";
					return {
						content: [{
							type: "text",
							text:
								`Agent "${requested}" is not in this subagent's allowlist ` +
								`(${allowedList}). The parent's \`allowedSubagents\` field ` +
								`restricted sub-spawning to that set.`,
						}],
					};
				}
			}

			// Decision 028: cap orchestrator nesting at one level. A process
			// at depth >= 2 is a nested orchestrator; refuse to deepen the
			// tree rather than letting a role-confusion bug nest silently.
			const nestingBlock = subagentNestingBlock(agent.name, subagentDepth());
			if (nestingBlock) {
				return { content: [{ type: "text", text: nestingBlock }] };
			}

			// Check if session is already running
			if (running.has(sessionId)) {
				return {
					content: [{ type: "text", text: `Subagent ${sessionId} is already running.` }],
				};
			}

			// Decision 014 (workOrderPath): read + parse the referenced work
			// order from the parent checkout at spawn, BEFORE any worktree is
			// created, so a missing/unreadable WO hard-fails the spawn with a
			// loud error (no spawn, no worktree) instead of silently falling
			// back. The parsed `review_policy` is the single source of truth
			// for the review gate — it wins over the tool param on disagreement.
			let workOrderPolicy: "required" | "skip" | undefined;
			if (params.workOrderPath) {
				const woPath = path.join(cwd, params.workOrderPath);
				let woText: string;
				try {
					woText = fs.readFileSync(woPath, "utf8");
				} catch {
					return {
						content: [{
							type: "text",
							text:
								`workOrderPath file not found: ${params.workOrderPath} (resolved to ${woPath}). ` +
								`Spawn aborted — pass a valid repo-relative path or omit workOrderPath.`,
						}],
					};
				}
				workOrderPolicy = parseWorkOrderPolicy(woText);
			}
			// Effective review policy — computed once here, shared by the gate
			// decision inside spawnSubagent (RS record) and the skip injection
			// below: the WO wins when present, else the tool param.
			const effectiveReviewPolicy = workOrderPolicy ?? params.review_policy;

			const parentModel = (() => {
				try { const m = ctx.getModel?.(); if (m?.provider && m?.id) return `${m.provider}/${m.id}`; } catch { /* */ }
				return undefined;
			})();

			// Decision 031: the orchestrator seat always tracks its caller's model;
			// every other seat keeps its frontmatter model unless the spawn opts in
			// via inheritParentModel (decision 020). Resolved once — the spawn call
			// below and the meta.json record consume this same value.
			const childModel = resolveChildModel({
				agentName: agent.name,
				agentModel: agent.model,
				parentModel,
				inheritParentModel: params.inheritParentModel ?? false,
			});

			// Worktree isolation (default: true)
			let effectiveCwd = cwd;
			let worktreePath: string | null = null;
			let isolationBranch: string | null = null;
			let parentHeadCommit: string | null = null;
			let carriedSnapshot: CarriedSnapshot | undefined;
			let isolationStatus = "";
			let taskForAgent = params.task;

			// Reviewers default to sharing the caller's worktree — they need
			// to see the implementer's uncommitted changes. But if the caller
			// explicitly passes baseRef (a specific branch/commit), the reviewer
			// gets its own worktree branched from that ref.
			if (agent.reviewerKind && params.isolate === undefined && !params.baseRef) {
				params.isolate = false;
			}

			if (params.isolate !== false) {
				const wt = await createWorktree(cwd, sessionId, params.baseRef, params.carryUncommitted ?? true);
				if (wt) {
					effectiveCwd = wt.worktreePath;
					worktreePath = wt.worktreePath;
					isolationBranch = wt.branchName;
					parentHeadCommit = wt.parentHeadCommit;
					carriedSnapshot = wt.carried;
					isolationStatus = `\nIsolated in worktree \`${wt.branchName}\` (off \`${wt.parentHeadCommit.slice(0, 8)}\`)`;
					taskForAgent =
						`## Worktree isolation\n` +
						`You are running inside an isolated git worktree at \`${wt.worktreePath}\`, branched from \`${wt.parentHeadCommit.slice(0, 12)}\`. ` +
						`Your cwd is the worktree root. Edits go to the worktree branch; the harness auto-commits uncommitted changes, removes the worktree, and keeps the branch for review.\n\n` +
						`If the task lists paths like \`/Users/<owner>/<parent-repo>/foo/bar.rs\`, strip the parent prefix and use \`foo/bar.rs\` as a repo-relative path. Never \`cd\` to an absolute parent-repo path — that bypasses isolation.\n\n` +
						params.task;
				} else {
					isolationStatus = "\n(Worktree isolation unavailable — not a git repo or creation failed.)";
				}
			}

			const rs = await spawnSubagent(
				pi,
				ctx,
				agent,
				params.task, // clean task identity (commit subject / display)
				effectiveCwd,
				sessionId,
				childModel,
				worktreePath,
				isolationBranch,
				parentHeadCommit,
				cwd,
				undefined, // resumeSessionFile
				params.review_policy,
				// Full delivery payload: worktree-isolation preamble + (possibly
				// review-policy-annotated) task. Reaches the child only.
				// Injection keys on the EFFECTIVE policy (WO wins over the param).
				maybeInjectReviewPolicySkip(taskForAgent, effectiveReviewPolicy),
				carriedSnapshot, // completion-filter snapshot (WO-2026-035)
				workOrderPolicy, // decision 014: parsed WO review_policy (undefined when no WO)
				params.silenceTimeoutMs, // decision 015: stage-2 silence-kill timeout (undefined → 30-min default)
			);

			running.set(sessionId, rs);

			// Work-order record: the dispatch is written by this spawner, into its own repo.
			// A failure is reported with the result; it never fails the spawn.
			const dispatch = params.workOrderPath
				? openWorkRecord(cwd, params.workOrderPath, sessionId, params.task)
				: { notes: [] };
			rs.workRecord = dispatch.record;
			rs.recordNotes = dispatch.notes;

		// Write metadata for recovery on session reload. Includes the full
		// agent config so subagent_resume can reproduce the original
		// configuration faithfully (storing the resolved model and system
		// prompt avoids drift if the user edits the agent definition between
		// spawn and resume). Uses atomic write (tmp + rename) to avoid torn
		// reads.
		// Site 2 (decision 022): meta.json records the resolved model (suffix
		// included) so resume reproduces exactly what ran.
		// Decision 027: record the spawning process's identity so the
		// session_start recovery scan can tell a genuine orphan (owner gone)
		// from another live session's child (owner alive) — and so a recycled
		// pid is not mistaken for the original owner (ownerStartToken).
		writeMetaJson(sessionId, buildSpawnMeta({
			agentName: agent.name,
			task: params.task,
			cwd,
			startedAt: rs.startedAt,
			worktreePath,
			isolationBranch,
			parentHeadCommit,
			parentCwd: cwd,
			tools: agent.tools ?? [],
			model: childModel,
			systemPrompt: agent.systemPrompt,
			allowedSubagents: agent.allowedSubagents ?? [],
			excludeTools: agent.excludeTools ?? [],
			workRecord: dispatch.record,
		}));

			// Reviewer-spawn tracker: if the spawned agent is a declared reviewer
			// (reviewerKind set in frontmatter), record this spawn under the
			// parent's key. The orchestrator reads this via `subagent_review_status`
			// to mechanically verify the gate. Recording happens AFTER the spawn
			// succeeds and BEFORE the result returns to the caller, so a child
			// session that hasn't yet been recorded is "not yet spawned" per the
			// work-order ordering invariant.
			if (agent.reviewerKind) {
				try {
					const parentKey = getParentTrackerKey(ctx);
					recordReviewerSpawn(parentKey, {
						reviewerKind: agent.reviewerKind,
						childSessionId: sessionId,
						childAgentName: agent.name,
						spawnedAt: Date.now(),
					});
					debugLog(`tracker: recorded ${agent.reviewerKind} spawn for parent=${parentKey} child=${sessionId}`);
				} catch (e) {
					debugLog(`tracker: record failed: ${e instanceof Error ? e.message : String(e)}`);
				}
			}

			updateFooter();

			return {
				content: [
					{
						type: "text",
						text: [
							`Subagent started: ${agent.name} (session: ${sessionId})${isolationStatus}`,
							`Task: ${params.task.slice(0, 200)}${params.task.length > 200 ? "..." : ""}`,
							...dispatch.notes,
							"",
							"The session id is the subagent's real pi session id — search it in /resume",
							"or join it from a terminal with `pi --session <id>`.",
							"It is also its peer-link name: message it anytime with peer_send (to: the session id).",
							"",
							"Watch live:",
							"```bash",
							`tail -f /tmp/pi-subagent-${sessionId}.log`,
							"```",
							"Or in-pi: /watch " + sessionId.slice(-8),
							"Or from another terminal: nc -U /tmp/pi-subagent-" + sessionId + ".sock",
							"Use /subagents to check progress.",
						].join("\n"),
					},
				],
			};
		},
	});

	// ── subagent_status ────────────────────────────────────────────────

	pi.registerTool({
		name: "subagent_status",
		label: "Subagent Status",
		description: "Check the progress of a running async subagent.",
		parameters: StatusParams,
		async execute(_toolCallId, params) {
			const rs = resolveRunningSession(params.session_id);
			if (!rs) {
				return {
					content: [
						{
							type: "text",
							text: describeUnknownSession(params.session_id),
						},
					],
				};
			}

			return {
				content: [{ type: "text", text: formatProgress(rs) }],
			};
		},
	});

	// ── subagent_review_status ──────────────────────────────────────────
	// Read-only tool that returns the persisted reviewer-spawn tracker for a
	// given parent session id. The orchestrator calls this mechanically after
	// any implementer completion report lands; see `decisions/subagents/
	// 004-parallel-review-gate.md` (Reviewer invocation guard).
	//
	// Returns a JSON object safe to surface in the parent prompt:
	//   {
	//     "parentSessionId": "...",
	//     "updatedAt": 1234,
	//     "kindsPresent": ["implementation", "tests"],
	//     "kindsMissing": [],
	//     "spawns": [ { "reviewerKind": "implementation", "childSessionId": "subagent-...", "childAgentName": "review-code", "spawnedAt": 1234 } ]
	//   }
	// `parentSessionId` is required; the tool reads from
	// `/tmp/pi-subagent-<safe-id>.reviewers.json` (written by the parent's
	// harness on each spawn). If the file is missing or unreadable, returns
	// an empty spawns list — never throws.
	const ReviewStatusParams = Type.Object({
		parent_session_id: Type.Optional(Type.String({
			description: "Session id of the parent whose reviewer spawns you want to inspect (e.g. the implementer's session id). Defaults to the caller's own session id.",
		})),
	});

	pi.registerTool({
		name: "subagent_review_status",
		label: "Subagent Review Status",
		description:
			"Read-only tool. Returns the list of post-implementation reviewer kinds " +
			"that a given parent session has spawned, with each child session id. " +
			"Use after an implementer's completion report to mechanically verify that " +
			"every reviewer kind the implementer declared in `requires_parent_reviewers` " +
			"has actually been launched. The orchestrator's parallel-review gate uses " +
			"this to refuse `complete` until the implementer's tracker shows all required " +
			"kinds. Output is a JSON object with `parentSessionId`, `updatedAt`, " +
			"`kindsPresent`, `kindsMissing` (relative to no requirement list — always empty), " +
			"`reviewRounds`, `reviewCapReached`, and `spawns` (one entry per spawn).",
		parameters: ReviewStatusParams,
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			const resolvedId = params.parent_session_id ?? getParentTrackerKey(ctx);
			const parentSessionId = resolveTrackerKey(resolvedId);
			const trackerState = readPersistedSpawns(parentSessionId);
			// updatedAt is informational; recompute from file mtime if available
			let updatedAt: number | null = null;
			try {
				const path = reviewStatusPath(parentSessionId);
				const stat = fs.statSync(path);
				updatedAt = stat.mtimeMs;
			} catch { /* missing file — updatedAt stays null */ }
			const kindsPresent = Array.from(new Set(trackerState.spawns.map((s) => s.reviewerKind))).sort();
			const payload = {
				parentSessionId,
				updatedAt,
				kindsPresent,
				kindsMissing: [], // populated by orchestrator if it knows the requirement set
				reviewRounds: trackerState.reviewRounds,
				reviewCapReached: trackerState.reviewCapReached,
				spawns: trackerState.spawns,
			};
			return {
				content: [{ type: "text", text: JSON.stringify(payload, null, 2) }],
			};
		},
	});

	// ── subagent_resume ───────────────────────────────────────────────
	// Resumes a previously-completed subagent session by spawning a new
	// RPC process that loads the existing session JSONL and continues
	// from where the previous run stopped. Preserves the original agent
	// config (tools, model, system prompt) from the spawn-time meta file.

	/**
	 * Build an AgentConfig from persisted meta fields. Uses the stored
	 * resolved model and full system prompt so resume reproduces the
	 * original config exactly (no drift from user editing agent files).
	 */
	function buildAgentConfigFromMeta(meta: Record<string, any>): AgentConfig {
		return {
			name: meta.agentName || "?",
			description: "",
			systemPrompt: meta.systemPrompt || "",
			tools: Array.isArray(meta.tools) ? meta.tools : [],
			model: meta.model,
			source: "user",
			filePath: "",
			allowedSubagents: Array.isArray(meta.allowedSubagents) ? meta.allowedSubagents : undefined,
			excludeTools: Array.isArray(meta.excludeTools) ? meta.excludeTools : undefined,
		};
	}

	const ResumeParams = Type.Object({
		session_id: Type.String({
			minLength: 1,
			description:
				"Session ID of a previously completed subagent to resume " +
				"(full 'subagent-<UUID>' or last 8+ chars).",
		}),
		task: Type.String({
			description: "Follow-up task to send to the resumed session.",
		}),
		cwd: Type.Optional(
			Type.String({
				description:
					"Working directory; defaults to the original subagent's recorded parentCwd.",
			}),
		),
	});

	pi.registerTool({
		name: "subagent_resume",
		label: "Subagent Resume",
		description:
			"Resume a previously-completed subagent session with a follow-up prompt. " +
			"Spawns a new RPC process that loads the existing session file and continues " +
			"from where the previous run stopped, preserving conversation history and " +
			"model state. The resumed session runs in the original recorded parent cwd " +
			"and does NOT re-establish the original isolation worktree. " +
			"Use this to send a follow-up question or corrective prompt to a reviewer " +
			"that has already finished, without re-seeding the full context.",
		parameters: ResumeParams,
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			// 1. Resolve the meta file by full or partial session id
			let sid: string;
			let resolvedMeta: Record<string, any>;
			try {
				const r = resolveSubagentMeta(params.session_id);
				if (!r) {
					const v = validateResumeMeta(null, params.session_id);
					return {
						content: [{ type: "text", text: v.ok ? "" : v.error }],
						isError: (v as any).isError,
					};
				}
				sid = r.sid;
				resolvedMeta = r.meta;

				// 2. Validate meta fields (sessionFile present, file on disk)
				const validation = validateResumeMeta(resolvedMeta, sid);
				if (!validation.ok) {
					return {
						content: [{ type: "text", text: validation.error }],
						isError: validation.isError,
					};
				}
			} catch (e: any) {
				return {
					content: [{ type: "text", text: e.message }],
					isError: true,
				};
			}

	
			// 3. Validate no running subagent with the same id
			if (running.has(sid)) {
				return {
					content: [{
						type: "text",
						text: `Subagent "${sid}" is already running.`,
					}],
					isError: true,
				};
			}

			// 4. Build a synthetic AgentConfig from the persisted meta fields.
			const syntheticAgent = buildAgentConfigFromMeta(resolvedMeta);
			const cwd = params.cwd ?? (resolvedMeta.parentCwd || ctx.cwd);

			// 5. Spawn the resumed RPC process under the SAME subagent-<UUID> key.
			// No worktree isolation — resumed sessions run in the recorded parentCwd.
			const rs = await spawnSubagent(
				pi,
				ctx,
				syntheticAgent,
				params.task,
				cwd,
				sid,
				// Resume reproduces the recorded model verbatim (decision 022
				// site 2) — no inheritance here, not even for an orchestrator.
				resolveChildModel({
					agentName: syntheticAgent.name,
					agentModel: resolvedMeta.model,
					inheritParentModel: false,
					isResume: true,
				}),
				null, // worktreePath
				null, // isolationBranch
				null, // parentHeadCommit
				cwd,
				resolvedMeta.sessionFile, // resumeSessionFile
			);
			// The resumed run completes the same work-order record (decisions/work-order-records/001).
			rs.workRecord = resolvedMeta.workRecord;

			running.set(sid, rs);
			updateFooter();

			// 6. DO NOT record a new reviewer-spawn tracker entry. The original
			// spawn already recorded it; resume continues the same logical session.

			return {
				content: [
					{
						type: "text",
						text: [
							`Subagent resumed: ${syntheticAgent.name} (session: ${sid})`,
							`Task: ${params.task.slice(0, 200)}${params.task.length > 200 ? "..." : ""}`,
							"",
							"Watch live:",
							"```bash",
							`tail -f /tmp/pi-subagent-${sid}.log`,
							"```",
							"Or in-pi: /watch " + sid.slice(-8),
							"Or from another terminal: nc -U /tmp/pi-subagent-" + sid + ".sock",
							"Use /subagents to check progress.",
						].join("\n"),
					},
				],
			};
		},
	});

	// ── wait ──────────────────────────────────────────────────────────
	// Why is `wait` a tool at all, instead of just instructing the model
	// "stop after launching a subagent"? Some models have a lot of
	// trouble reliably stopping their turn on their own once they've
	// spawned one — they tend to keep generating, call
	// subagent_status repeatedly, or otherwise spin. Making `wait` a
	// named tool invocation gives them a concrete affordance to reach
	// for: "I have nothing else to do; end the turn and wake me when a
	// subagent finishes." The `terminate: true` below is what actually
	// ends the turn; the tool is just the well-named hook.

	// `wait` ends the current turn and yields until a running subagent
	// completes. By default it owns no timer — wake-up is triggered
	// solely by subagent completion (delivered as a steer message by
	// the close handler). The optional `seconds` parameter arms a
	// wake-up timer that fires after N seconds if no subagent has
	// completed by then; the timer is cancelled when a subagent
	// completes, so completion never triggers a redundant "still
	// running" wakeup. Only use the timer when you have a concrete
	// concern that the subagent may need steering — if you're
	// confident in its direction, call `wait` with no argument and
	// you'll be woken exactly when it finishes. `wait` is not a
	// sleep or general timer.

	const WaitParams = Type.Object({
		seconds: Type.Optional(
			Type.Number({
				description:
					"Optional wake-up timer in seconds (1-600). If provided, you will be woken up after this many seconds if no subagent has completed by then — only use this when you have a specific concern the subagent may need steering. If you trust the subagent's direction, omit this and call wait() with no argument; you'll be woken when it finishes, with no token cost in the meantime. The timer is cancelled automatically when a subagent completes, so the two wake-ups never collide.",
				minimum: 1,
				maximum: 600,
			}),
		),
	});

	pi.registerTool({
		name: "wait",
		label: "Wait",
		description: "End the current turn and yield until a running subagent completes and delivers its result. With no argument, wake-up is triggered solely by subagent completion — call this exactly once after launching subagents and stop; do not poll. With the optional `seconds` argument, a wake-up timer is armed: you will also be woken if N seconds pass with no subagent completed (only use this when you have a specific concern the subagent may need steering; if you trust the direction, omit `seconds` and you'll be woken when it finishes with no token cost in between). The two wake-ups never collide — a completing subagent cancels the timer. Only call this when at least one subagent is running; with nothing running there is nothing to wake you. This is not a sleep or general timer.",
		parameters: WaitParams,
		async execute(_toolCallId, params) {
			if (running.size === 0) {
				return {
					content: [{ type: "text", text: "No running subagents — nothing to wait for. Launch a subagent first, or continue your work." }],
				};
			}
			const names = [...running.values()].map((rs) => `${rs.agentName} (${rs.sessionId.slice(-8)})`);

			// No timer requested — default behavior: terminate and wait for
			// subagent completion only.
			if (params.seconds === undefined) {
				return {
					content: [{ type: "text", text: `Waiting for ${running.size} running subagent${running.size === 1 ? "" : "s"}: ${names.join(", ")}. I will be woken when one completes.` }],
					terminate: true,
				};
			}

			// Timer requested. Replace any existing timer (defensive — the
			// tool terminates the turn, so a second call only happens after a
			// wake-up, but clean up just in case).
			clearActiveWait();

			const seconds = params.seconds;
			activeWaitTimer = setTimeout(() => {
				activeWaitTimer = null;
				// Skip if a subagent completed in the race window between
				// timer arm and timer fire — the close handler clears
				// activeWaitTimer and delivers the result as a steer, so a
				// "still running" message on top of that would be noise. The
				// close handler's clearTimeout cancels us, but checking
				// running.size here is belt-and-braces in case the callback
				// was already queued.
				if (running.size === 0) return;
				// Post-turn async path: the spawning session may have ended while
				// the timer was pending. pi invalidates its ExtensionAPI alongside
				// the ctx, so `pi.sendUserMessage` below would throw uncaught from
				// this timer. No live session → no receiver for a wait wake-up.
				if (!liveSessionCtx) {
					debugLog(`wait-timer: no live session — skipping wake-up`);
					return;
				}
				const liveNames = [...running.values()].map((rs) => `${rs.agentName} (${rs.sessionId.slice(-8)})`);
				pi.sendUserMessage(
					`[wait timer] ${seconds}s elapsed — ${running.size} subagent${running.size === 1 ? "" : "s"} still running: ${liveNames.join(", ")}. If concerned about direction, use subagent_status to inspect or subagent_steer to redirect. If you trust the work, call wait() again with no argument to keep waiting.`,
					{ deliverAs: "steer" },
				);
			}, seconds * 1000);

			return {
				content: [{ type: "text", text: `Waiting for ${running.size} running subagent${running.size === 1 ? "" : "s"}: ${names.join(", ")}. I will be woken either when one completes or after ${seconds}s if still running.` }],
				terminate: true,
			};
		},
	});

	// ── subagent_steer ─────────────────────────────────────────────────

	pi.registerTool({
		name: "subagent_steer",
		label: "Subagent Steer",
		description: "Inject a steering message into a running async subagent. The message is delivered before the subagent's next LLM call.",
		parameters: SteerParams,
		async execute(_toolCallId, params) {
			const rs = resolveRunningSession(params.session_id);
			if (!rs) {
				return {
					content: [
						{
							type: "text",
							text: describeUnknownSession(params.session_id),
						},
					],
				};
			}

			// A stopped session must not be "steered" — a write into a dead
			// child's pipe would buffer and be silently lost while the tool
			// reported success. Reflect the true state instead.
			if (rs.isDone || rs.procExited || !rs.stdin || rs.stdin.destroyed) {
				return {
					content: [
						{
							type: "text",
							text: `Subagent ${rs.agentName} (${params.session_id}) is no longer running (${rs.isDone ? "completed" : "process exited"}) — steering message not delivered: "${params.message}"`,
						},
					],
				};
			}

			const sent = rpcSend(rs.stdin, {
				type: "prompt",
				message: params.message,
				streamingBehavior: "steer",
			});

			if (!sent) {
				return {
					content: [
						{
							type: "text",
							text: `Steering message NOT delivered to ${rs.agentName} (${params.session_id}) — stdin closed (session may have just stopped): "${params.message}"`,
						},
					],
				};
			}

			return {
				content: [
					{
						type: "text",
						text: `Steering message sent to ${rs.agentName} (${params.session_id}): "${params.message}"`,
					},
				],
			};
		},
	});

	// ── subagent_stop ──────────────────────────────────────────────────

	pi.registerTool({
		name: "subagent_stop",
		label: "Subagent Stop",
		description: "Tell a running async subagent to wrap up and return a summary. Waits up to 5 minutes for the subagent to finish.",
		parameters: StopParams,
		async execute(_toolCallId, params, signal) {
			const rs = resolveRunningSession(params.session_id);
			if (!rs) {
				return {
					content: [
						{
							type: "text",
							text: describeUnknownSession(params.session_id),
						},
					],
				};
			}

			// Mark this session as explicitly stopped BEFORE the wrap-up steer
			// ships. The subagent's final text-only message (produced in
			// response to the steer below) otherwise trips the review-gate
			// soft-prompt in the msg_end handler, which would re-enter the
			// agent loop to launch reviewers — the opposite of "wrap up".
			// An explicit stop means "report only"; the review machinery is
			// bypassed for this session.
			rs.stoppedExplicitly = true;

			// Send final steer if provided — but only while the child can
			// still receive it. If it has already exited (or is mid-exit),
			// skip the steer; the wait below resolves via the close handler
			// regardless.
			const finalMsg = params.final_message || "Wrap up your current work and return a summary. Do not start new tasks.";
			if (rs.isDone || rs.procExited || !rs.stdin || rs.stdin.destroyed) {
				debugLog(`subagent_stop: wrap-up steer skipped for ${params.session_id} (session already stopped)`);
			} else {
				rpcSend(rs.stdin, {
					type: "prompt",
					message: finalMsg,
					streamingBehavior: "steer",
				});
			}

		// Wait for subagent to finish, with timeout
			// The worker won't exit on its own (RPC mode keeps it alive).
			// We rely on the isDone detection (text-only message) to close
			// stdin, which triggers process exit → close handler → resolveOnStop.
			// Fallback: force-kill after a generous timeout.
			const result = await new Promise<string>((resolve) => {
				let resolved = false;
				const finish = (text: string) => {
					if (resolved) return;
					resolved = true;
					clearTimeout(fallbackTimeout);
					if (signal) {
						try { signal.removeEventListener("abort", onAbort); } catch { /* */ }
					}
					resolve(text);
				};

				// Fallback: force-kill the process if it doesn't finish naturally.
				// Guarded for recovered/pre-reload sessions (proc === null):
				// nothing to signal — skip the signals; the waiter still
				// resolves via finish() so the stop tool returns.
				const fallbackTimeout = setTimeout(() => {
					if (rs.proc) {
						rs.proc.kill("SIGTERM");
						setTimeout(() => {
							if (rs.proc && !rs.proc.killed) rs.proc.kill("SIGKILL");
							finish("[Force-stopped after timeout]");
						}, HARD_KILL_DELAY_MS);
					} else {
						finish("[Force-stopped after timeout]");
					}
				}, STOP_TIMEOUT_MS);

				rs.resolveOnStop = (finalOutput?: string) => {
					finish(finalOutput || "(no output)");
				};

				// If already done (subagent finished before we set resolveOnStop),
				// close stdin now to trigger exit.
				if (rs.isDone && rs.stdin && !rs.stdin.destroyed) {
					rs.stdin.end();
				}

				const onAbort = () => finish("[Aborted]");
				if (signal) {
					if (signal.aborted) onAbort();
					else signal.addEventListener("abort", onAbort, { once: true });
				}
			});

			return {
				content: [
					{
						type: "text",
						text: `${rs.agentName} (${params.session_id}) stopped.\n\n${result}`,
					},
				],
			};
		},
	});

	// ── subagent_kill ──────────────────────────────────────────────────
	// Hard-kill tool: dispatch SIGTERM immediately, schedule SIGKILL after
	// HARD_KILL_DELAY_MS, and return without waiting for the close handler.
	// The close handler is the single owner of delivery; it reads the
	// `killedExplicitly`/`killedVia` flags set here and prepends a marker to
	// the delivered message so the orchestrator sees what happened.
	// Idempotent on the second call (no-op when the flag is already true).
	// Shares the dispatch with decision 015's stage-2 progress-timeout
	// auto-kill (dispatchKillSignals) — exactly one SIGTERM→SIGKILL path.

	pi.registerTool({
		name: "subagent_kill",
		label: "Subagent Kill",
		description:
			"Hard-kill a stuck subagent by terminating its underlying `pi` process. Use this when `subagent_stop` has not worked because the subagent is genuinely stuck and no longer reading its RPC stdin (e.g. deadlocked, infinite loop, blocked provider call). Sends SIGTERM, then SIGKILL after a short grace period if the child is still alive. The result is delivered as a user message with a clear marker so the orchestrator can see the kill happened. This is destructive — any in-flight work in the subagent is lost. Prefer `subagent_stop` when the subagent is responsive.",
		parameters: KillParams,
		async execute(_toolCallId, params) {
			const rs = resolveRunningSession(params.session_id);
			if (!rs) {
				return {
					content: [
						{
							type: "text",
							text: describeUnknownSession(params.session_id),
						},
					],
				};
			}

			// Idempotency: a second `subagent_kill` on the same session is a
			// no-op. Returning a short message keeps the orchestrator's log
			// legible without re-firing signals. (The stage-2 auto-kill sets
			// the same flag, so a kill-after-timeout is also a no-op here.)
			if (rs.killedExplicitly) {
				return {
					content: [
						{
							type: "text",
							text: `${rs.agentName} (${params.session_id}) already killed — signals skipped. Result will be delivered via the close handler.`,
						},
					],
				};
			}

			// Shared kill dispatch (decision 015): sets killedExplicitly +
			// killedVia BEFORE any proc access so the close handler observes
			// them on entry, cancels the stale-turn watchdog AND the stage-2
			// silence timer, logs the kill marker, and SIGTERM→SIGKILLs. For a
			// recovered/pre-reload session there is no live process to signal
			// (`noProcess`) — the flags are still set so the close handler
			// prepends the marker, and no signal is attempted.
			const { alreadyDead, noProcess } = dispatchKillSignals(rs, "kill-tool");

			const statusText = noProcess
				? `${rs.agentName} (${params.session_id}) marked killed — no live process existed to signal (recovered/pre-reload session). Result will be delivered via the close handler.`
				: alreadyDead
					? `${rs.agentName} (${params.session_id}) already dead — kill signals skipped. Result will be delivered via the close handler.`
					: `${rs.agentName} (${params.session_id}) sent SIGTERM (SIGKILL will follow in ${HARD_KILL_DELAY_MS / 1000}s if still alive). Result will be delivered via the close handler.`;

			return {
				content: [
					{
						type: "text",
						text: statusText,
					},
				],
			};
		},
	});
}
