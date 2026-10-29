/**
 * Subagent disk state: the meta registry, 027's owner-liveness gate, and the
 * four-state vocabulary (tfd process-controls R3, owner, 2026-10-19).
 *
 * Dependency-light on purpose: `extensions/checkpoint.ts` reads the registry
 * read-only through this module (R3-1's in-flight section) while
 * `extensions/subagent-async/index.ts` owns spawn-time writes. One classifier
 * serves both, so `subagent_status` and the checkpoint section can never
 * disagree about what "running" means.
 *
 * The owner-liveness block is moved verbatim from subagent-async/index.ts
 * (decision 027) and re-exported there — behaviour unchanged.
 */

import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";

/** A log silent for this long is no longer evidence of a live child. Same
 *  window as subagent-async's stalled-turn watchdog. */
export const SUBAGENT_STALE_TURN_MS = 5 * 60 * 1000;

// ── Recovery ownership (decision 027) ──────────────────────────────────────
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

// ── Meta registry scan ─────────────────────────────────────────────────────

export const SUBAGENT_TMP_DIR = "/tmp";

export interface SubagentMetaEntry {
	sid: string;
	meta: Record<string, any>;
}

/** Every readable `pi-subagent-<sid>.meta.json` in `dir`. */
export function listSubagentMetas(dir: string = SUBAGENT_TMP_DIR): SubagentMetaEntry[] {
	let files: string[];
	try {
		files = fs.readdirSync(dir);
	} catch {
		return [];
	}
	const entries: SubagentMetaEntry[] = [];
	for (const f of files) {
		if (!f.startsWith("pi-subagent-") || !f.endsWith(".meta.json")) continue;
		const sid = f.slice("pi-subagent-".length, -".meta.json".length);
		if (!sid) continue;
		try {
			const meta = JSON.parse(fs.readFileSync(path.join(dir, f), "utf-8"));
			if (meta && typeof meta === "object") entries.push({ sid, meta });
		} catch {
			/* torn or malformed meta — not a session we can classify */
		}
	}
	return entries;
}

// ── Four-state vocabulary (R3-3) ───────────────────────────────────────────

/**
 * `dead/unmatched` is one bucket with two named causes: `unmatched` when the
 * child cannot be attributed (no meta, or a pre-027 meta with no owner), `dead`
 * when a recorded owner is gone and no session file was left behind.
 */
export type SubagentState = "running" | "complete" | "orphaned" | "dead" | "unmatched";

export interface SubagentDiskFacts {
	meta: Record<string, any> | null;
	/** Tracked in this process's running map. */
	attached: boolean;
	sockExists: boolean;
	/** Last non-empty line of the spawn log, or null when there is no log. */
	logLastLine: string | null;
	logMtimeMs: number | null;
	sessionFileExists: boolean;
	hasRecordedOwner: boolean;
	/** undefined when no owner was recorded. */
	ownerAlive: boolean | undefined;
	now: number;
}

export interface SubagentStateReading {
	state: SubagentState;
	/** The evidence read, in a sentence the status text can quote verbatim. */
	evidence: string;
}

const COMPLETED_FOOTER_RE = /──\s*Completed\s*\(/;
const TERMINAL_FOOTER_RE = /──\s*(Completed|Exited|Stopped|Killed)\s*\(/;

/**
 * True when the log's last non-empty line is a terminal footer — the child-side
 * evidence that the run is over (`── Completed|Exited|Stopped|Killed (…) ──`).
 * The status vocabulary and the reap both key on this one predicate.
 */
export function hasTerminalFooter(logLastLine: string | null): boolean {
	return logLastLine !== null && TERMINAL_FOOTER_RE.test(logLastLine);
}

/**
 * Pure classifier over observed facts. Order matters: an attached child is
 * running; a completion footer is terminal; a socket with a live owner or a
 * freshly written log is running; a session file without a completion line is
 * orphaned-resumable; otherwise nothing attributable remains.
 */
export function readSubagentState(f: SubagentDiskFacts): SubagentStateReading {
	if (f.attached) return { state: "running", evidence: "attached to this session's tracker" };
	if (!f.meta) return { state: "unmatched", evidence: "no registry entry (meta file) matches the id" };

	const footered = f.logLastLine ? TERMINAL_FOOTER_RE.exec(f.logLastLine) : null;
	if (f.logLastLine && COMPLETED_FOOTER_RE.test(f.logLastLine)) {
		return { state: "complete", evidence: "the log ends with the `── Completed …` footer" };
	}
	if (footered) {
		return f.sessionFileExists
			? { state: "orphaned", evidence: `the log ends with the \`── ${footered[1]} …\` footer and a session file exists` }
			: { state: "dead", evidence: `the log ends with the \`── ${footered[1]} …\` footer and no session file was captured` };
	}
	if (f.sockExists && f.ownerAlive === true) {
		return { state: "running", evidence: `a socket file exists and its recorded owner (pid ${f.meta.ownerPid}) is still running` };
	}
	if (f.logMtimeMs !== null && f.now - f.logMtimeMs < SUBAGENT_STALE_TURN_MS) {
		const age = Math.max(0, Math.round((f.now - f.logMtimeMs) / 1000));
		return { state: "running", evidence: `the log was written ${age}s ago` };
	}
	if (f.sessionFileExists) {
		return { state: "orphaned", evidence: "no completion line, and a session file exists (resumable)" };
	}
	if (!f.hasRecordedOwner) {
		return { state: "unmatched", evidence: "no completion line, and no owner process was recorded" };
	}
	if (f.ownerAlive === false) {
		return { state: "dead", evidence: `no completion line, no session file, and its recorded owner process (pid ${f.meta.ownerPid}) is gone` };
	}
	return {
		state: "unmatched",
		evidence: `no completion line, no session file, and its recorded owner process (pid ${f.meta.ownerPid}) is still running`,
	};
}

/** Last `bytes` of a file as text, or null when it cannot be read. */
function readTail(file: string, bytes = 16 * 1024): string | null {
	try {
		const fd = fs.openSync(file, "r");
		try {
			const size = fs.fstatSync(fd).size;
			const start = Math.max(0, size - bytes);
			const buf = Buffer.alloc(Math.min(bytes, size));
			if (buf.length === 0) return "";
			fs.readSync(fd, buf, 0, buf.length, start);
			return buf.toString("utf-8");
		} finally {
			fs.closeSync(fd);
		}
	} catch {
		return null;
	}
}

/** Last non-empty line of a text blob, or null. */
export function lastNonEmptyLine(text: string | null): string | null {
	if (text === null) return null;
	const lines = text.split("\n");
	for (let i = lines.length - 1; i >= 0; i--) {
		const t = lines[i].trim();
		if (t) return t;
	}
	return null;
}

/** Gather the disk facts for `sid`. Read-only; never throws. */
export function gatherSubagentDiskFacts(
	sid: string,
	opts: {
		meta: Record<string, any> | null;
		dir?: string;
		attached?: boolean;
		probe?: OwnerProbe;
		now?: number;
	},
): SubagentDiskFacts {
	const dir = opts.dir ?? SUBAGENT_TMP_DIR;
	const meta = opts.meta;
	const sockPath = path.join(dir, `pi-subagent-${sid}.sock`);
	const logPath = path.join(dir, `pi-subagent-${sid}.log`);
	const hasRecordedOwner = Number.isInteger(meta?.ownerPid) && (meta?.ownerPid as number) > 0;
	const sessionFile = typeof meta?.sessionFile === "string" ? meta.sessionFile : null;

	let logMtimeMs: number | null = null;
	try {
		logMtimeMs = fs.statSync(logPath).mtimeMs;
	} catch {
		/* no log */
	}

	return {
		meta,
		attached: opts.attached ?? false,
		sockExists: fs.existsSync(sockPath),
		logLastLine: lastNonEmptyLine(readTail(logPath)),
		logMtimeMs,
		sessionFileExists: sessionFile !== null && fs.existsSync(sessionFile),
		hasRecordedOwner,
		ownerAlive: hasRecordedOwner ? isOwnerAlive(meta, opts.probe ?? defaultOwnerProbe) : undefined,
		now: opts.now ?? Date.now(),
	};
}

// ── In-flight listing (R3-1) ───────────────────────────────────────────────

export interface InFlightSubagent {
	sid: string;
	agentName: string | null;
	branch: string | null;
	worktreePath: string | null;
	state: SubagentState;
	evidence: string;
	/** Present for orphaned children: the call that resumes the session. */
	resumeCall: string | null;
}

/** `subagent_resume({ session_id: "<sid>", task: "<what it was doing>" })`. */
export function resumeCallFor(sid: string, meta: Record<string, any> | null): string {
	const raw = typeof meta?.task === "string" ? meta.task : "";
	const task = raw.replace(/\s+/g, " ").trim();
	const clipped = task.length > 120 ? `${task.slice(0, 117)}…` : task;
	const quoted = clipped.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
	return `subagent_resume({ session_id: "${sid}", task: "${quoted || "continue the work"}" })`;
}

/**
 * The live children this process can act on: adoption per 027's gate (same
 * process owner, or owner gone — a live foreign owner's child is another
 * session's business, a legacy meta is unattributable) AND a state of running
 * or orphaned. Completed and dead children are not in flight.
 */
export function listInFlightSubagents(
	opts: { dir?: string; selfPid?: number; probe?: OwnerProbe; now?: number } = {},
): InFlightSubagent[] {
	const dir = opts.dir ?? SUBAGENT_TMP_DIR;
	const out: InFlightSubagent[] = [];
	for (const { sid, meta } of listSubagentMetas(dir)) {
		if (decideRecoveryAdoption(meta, { selfPid: opts.selfPid, probe: opts.probe }) !== "adopt") continue;
		const reading = readSubagentState(
			gatherSubagentDiskFacts(sid, { meta, dir, probe: opts.probe, now: opts.now }),
		);
		if (reading.state !== "running" && reading.state !== "orphaned") continue;
		out.push({
			sid,
			agentName: typeof meta.agentName === "string" ? meta.agentName : null,
			branch: typeof meta.isolationBranch === "string" ? meta.isolationBranch : null,
			worktreePath: typeof meta.worktreePath === "string" ? meta.worktreePath : null,
			state: reading.state,
			evidence: reading.evidence,
			resumeCall: reading.state === "orphaned" ? resumeCallFor(sid, meta) : null,
		});
	}
	return out;
}
