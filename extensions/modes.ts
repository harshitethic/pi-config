/**
 * Modes — switch between "implement" (act directly) and "orchestrate"
 * (conduct through subagents — dispatch implementers directly, or
 * orchestrator subagents for chunks large enough to warrant their own
 * context, one nesting level only).
 *
 * Architecture: a static brief in the system prompt (cache-stable) plus
 * full mode instructions injected as a one-shot user-role message at
 * session start, after /mode, and after compaction. Message injection
 * lands at end-of-input (highest attention) and rides the conversation
 * tail cache. /mode invalidates no system-prompt cache.
 *
 * State is per-project (<cwd>/.pi/mode.json) with a global fallback
 * (~/.pi/agent/modes.json) for new sessions in projects that haven't
 * chosen yet.
 */

import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

type Mode = "implement" | "orchestrate";

/** Pure helper: the 2-way mode cycle. Unit-testable. */
export function nextMode(current: Mode): Mode {
	return current === "implement" ? "orchestrate" : "implement";
}

/** Pure helper: mode guard. Accepts exactly the two mode strings (case-sensitive, no whitespace). */
export function isValidMode(s: string): s is Mode {
	return s === "implement" || s === "orchestrate";
}

/**
 * @internal Exported for tests: resolve a /mode argument to a target mode,
 * or null when the argument is not a known mode. An empty argument cycles.
 */
export function resolveModeArg(current: Mode, arg: string): Mode | null {
	const a = arg.trim().toLowerCase();
	if (a === "") return nextMode(current);
	return isValidMode(a) ? a : null;
}

const PROJECT_FILE = join(process.cwd(), ".pi", "mode.json");
const GLOBAL_FILE = join(homedir(), ".pi", "agent", "modes.json");

const MODES_BRIEF = `## Modes

You operate in one of two modes (the user sets or cycles via /mode):
- **implement** (default): work directly in this session — read files, make edits, run commands — and dispatch subagents (implement / scouts) whenever delegation is useful: parallel work, context-heavy research, mechanical multi-file changes. You are the operator; subagents are a tool, not a mode change.
- **orchestrate**: conduct work through subagents — dispatch implementers directly, or \`orchestrator\` subagents for chunks large enough to deserve their own orchestrator context (sequential or parallel — nesting buys context isolation; one nesting level only). You own the roadmap when working at scale and never implement directly. You are the conductor.

The currently-active mode is delivered as a user-role message at session start and after every /mode switch. The most recent such message is authoritative — read it to see which mode you are in.`;

const MODE_FULL: Record<Mode, string> = {
	implement: `## Mode: implement

You are in implementation mode — work directly, and dispatch
subagents (implement / scouts) whenever
delegation is useful; that's tool use, not a mode change. For
code-changing dispatches, verify the completion report (status,
adversarial_reviews, structural_checks) before accepting it — you
are the gate for what you spawn.`,

	orchestrate: `## Mode: orchestrate

You are in orchestration mode. You conduct work through subagents:
implementers do the work, you design, gate, merge, and reconcile. You
never implement directly — if you are editing feature code, you have
drifted out of the role; stop and dispatch.

## Dispatch

For substantial tasks, generate a work order (load the
work-order-template skill) and dispatch to implement (the single
implementation tier). For research, dispatch scout-code/scout-web.
For trivial changes, pass \`review_policy: "skip"\` on the \`subagent\` call
(or include \`**review_policy**: skip\` in the work order) and review the
diff directly. Handle completion reports: status, invariant_exhaustiveness
calibration, structural_checks, deviations, notes_for_orchestrator.

Most work does not nest. When a workstream splits into chunks large
enough to deserve their own orchestrator context — sequentially or in
parallel — dispatch an \`orchestrator\` subagent per chunk, hand it a
chunk spec, the roadmap pointer, and the resolved policy. That is the
only nesting level: the children dispatch implementers, not further
orchestrators (the harness refuses orchestrator spawns at depth 2+).

## Roadmap ownership + reconcile rule

When you own a workstream, maintain the roadmap doc and reconcile it
after every chunk lands:
- Mark the chunk done with its commit hash.
- Reorder remaining items if dependencies have shifted.
- Catch cross-chunk dependencies the orchestrators flagged.

This is a hard step, not optional. Doc/reality drift is the failure
mode this role was created to prevent.

## Reframes via /attach

When an orchestrated chunk surfaces a design reframe — a question
that re-opens the design and needs genuine multi-turn conversation
with the user, not a single structured fork — use \`/attach <id>\` to
let the user converse with the orchestrator directly. The
orchestrator's conclusions land in the roadmap doc; \`/detach\` returns
you here, and you read the updated doc. Your context stays clean.

Distinguish the two cases:
- **Tweak** = a single structured fork ("options A/B/C, which?").
  Relay handles it — you pass the options to the user, relay the
  answer back. No attach needed.
- **Reframe** = a multi-turn design conversation where the user must
  probe the orchestrator's understanding and iterate. Relay fails;
  attach is required.

## Overlap independent work during review windows

\`subagent\` dispatch is non-blocking, and an implementer's
review/rework loop can run for minutes. Use that window: before
calling \`wait\`, dispatch the next **independent** implementer (no
dependency on the in-flight item's merged result) or do follow-on
work (spec the next work order, scout, reconcile docs). Stay
sequential when the next step needs the in-flight item's reviewed
result — building on un-reviewed output is what the gate exists to
prevent. \`wait\` wakes on the **first** completion: gate + merge
that one, re-\`wait\` for the rest, and track each in-flight
implementer (session id, independence).

## Remote hygiene

\`git fetch origin\` and integrate \`origin/main\` before dispatching —
work orders written against a stale base are the main source of merge
conflicts — and again before merging an implementer's branch. Push
merged work promptly: a green, unfinished feature is a fine mainline
state as long as tests pass and no existing feature is broken. Never
push red.

## Context hygiene

Occasional investigation, thinking, or experimentation loops you do
yourself burn context that won't matter once the task moves on.
Manage it:

- **Plans go in a plan doc, not in chat.** Write the full plan to a
  repo doc (e.g. \`docs/TODO.md\`) and keep it current as work moves.
  Put tracking/plan docs **in the repo** (e.g. under \`docs/\`), never in
  \`tmp/\` — \`tmp/\` is scratch/build artifacts only.
- **When the repo has a session log, it is the work list.** Read it back
  with \`python3 scripts/session_log.py summary --session <id> --current\`
  (the current goal and its latest events) instead of keeping a parallel
  list.
- **Checkpoint after every context-heavy loop or subtask lands.**
  Summary must be rich enough to resume from cold: what was decided,
  what's next, which files/identifiers matter next.`,

};

/** @internal Exported so tests can pin the persisted-mode parse + the "plan" retirement fallback. */
export function readModeFile(path: string): Mode | null {
	try {
		if (!existsSync(path)) return null;
		const data = JSON.parse(readFileSync(path, "utf-8")) as { mode?: string };
		const mode = data.mode ?? "";
		return isValidMode(mode) ? mode : null;
	} catch {
		return null;
	}
}

function writeModeFile(path: string, mode: Mode): void {
	try {
		mkdirSync(dirname(path), { recursive: true });
		writeFileSync(path, JSON.stringify({ mode }, null, 2));
	} catch {
		/* best-effort */
	}
}

/** @internal Exported for tests: project file wins, then global, then implement. */
export function loadModeFrom(projectPath: string, globalPath: string): Mode {
	return readModeFile(projectPath) ?? readModeFile(globalPath) ?? "implement";
}

const loadMode = (): Mode => loadModeFrom(PROJECT_FILE, GLOBAL_FILE);
const saveMode = (mode: Mode): void => { writeModeFile(PROJECT_FILE, mode); writeModeFile(GLOBAL_FILE, mode); };

export default function modesExt(pi: ExtensionAPI): void {
	let currentMode: Mode = loadMode();
	let pendingInjection: Mode | null = null;

	const setStatus = (
		ctx: { ui: { setStatus(n: string, t: string): void; theme: { fg(c: string, t: string): string } } },
		mode: Mode,
	) => ctx.ui.setStatus("mode", ctx.ui.theme.fg(mode === "implement" ? "muted" : "accent", `[${mode}]`));

	pi.on("session_start", async (_event, ctx) => {
		currentMode = loadMode();
		pendingInjection = currentMode;
		setStatus(ctx, currentMode);
		pi.events.emit("pi-config:startup-summary-item", {
			key: "modes",
			order: 30,
			text: `[Modes] implement, orchestrate. Current: ${currentMode}. /mode to cycle or /mode <name>.`,
		});
	});

	// Re-prime after compaction: the prior mode-injection message has been
	// summarized away, leaving the system-prompt brief pointing at nothing.
	pi.on("session_compact", () => { pendingInjection = currentMode; });

	pi.registerCommand("mode", {
		description: "Set or cycle the session mode (implement / orchestrate)",
		handler: async (args, ctx) => {
			const next = resolveModeArg(currentMode, args);
			if (next === null) {
				ctx.ui.notify(`Current mode: ${currentMode}\nUsage: /mode [implement|orchestrate]`, "info");
				return;
			}

			if (next === currentMode) return;
			currentMode = next;
			saveMode(next);
			pendingInjection = next;
			setStatus(ctx, next);
			ctx.ui.notify(`Mode: ${next}`, "info");
		},
	});

	pi.on("before_agent_start", async (event) => {
		// Subagent sessions inherit the parent's mode setting from disk
		// (e.g. ~/.pi/agent/modes.json), which causes them to receive the
		// orchestrator's "you are the conductor" prompt and try to dispatch
		// work to other subagents — wrong for a session that IS the worker.
		// The subagent harness sets PI_IS_SUBAGENT=1 on every spawn; check
		// it and skip both the brief and the mode-injection message for
		// subagent sessions. The agent's own system prompt (e.g. implement-
		// flash.md) carries the role-specific instructions.
		if (process.env.PI_IS_SUBAGENT === "1") return {};

		const out: { systemPrompt?: string; message?: unknown } = {
			systemPrompt: event.systemPrompt + "\n\n" + MODES_BRIEF,
		};
		if (pendingInjection) {
			out.message = {
				customType: "mode-injection",
				content: MODE_FULL[pendingInjection],
				display: false,
				details: { mode: pendingInjection },
			};
			pendingInjection = null;
		}
		return out;
	});
}
