/**
 * The suite's verdict must not depend on the invocation-context PI_SUBAGENT_*
 * environment (pi-config#9).
 *
 * What happened: `bun test` run from INSIDE a subagent failed 11 rows across
 * three files. The harness injects PI_SUBAGENT_ALLOWLIST / PI_SUBAGENT_DEPTH /
 * PI_IS_SUBAGENT into every subagent process; the boundary rows exercise real
 * spawns through the tool gate (extensions/subagent-async reads
 * process.env.PI_SUBAGENT_ALLOWLIST for the allowlist check and
 * subagentDepth() for the nesting cap), so an inherited allowlist refused the
 * `implement`/`orchestrator` spawns those rows are about. Two work-order
 * verifications red identically at base AND landed: the verdict was a property
 * of the invocation context, not of the code under test.
 *
 * The idiom (tests/helpers/subagent-env.ts, test side only): `scrubSubagentEnv()`
 * drops those three vars at file level, and every child spawn passes
 * `env: childEnv()` — bun hands a spawn that omits `env` its process-start
 * snapshot, so the in-process scrub alone never reaches such a child.
 *
 * Two rows pin that, and neither enumerates files:
 *
 * 1. Behavioral (the verdict-level pin). Every test file that can observe the
 *    gate env is re-run as a child `bun test` under a replicated harness
 *    injection and must report 0 fail. The set is derived, never listed:
 *    `*.test.*` files that (a) contain a child spawn or (b) import a module
 *    that reads process.env.PI_SUBAGENT_* / PI_IS_SUBAGENT, minus this file
 *    (a nested run must not re-enter itself) and minus live-model files
 *    (anything constructing a real AgentSession) — network flake is not this
 *    pin's verdict. 24 files, ~30 s.
 *
 * 2. Static (the mechanism's other half). Every spawn call site anywhere under
 *    tests/ passes an explicit `env`. A spawn that omits it inherits the
 *    startup snapshot even when the parent scrubbed, and that is invisible
 *    until a child which reads the vars appears — so it is pinned, not waited
 *    for. The detector takes spawn names from the node:child_process import
 *    list plus Bun.spawn/Bun.spawnSync, which makes it a LOWER BOUND: a site
 *    reached through a renamed helper (`const run = promisify(execFile)`) is
 *    not seen. Row 1 is the guarantee; row 2 is the early warning.
 *
 * Options rejected (numbers measured on bun 1.3.11, 2026-10-22):
 *   - (A) nested `bun test` over the whole suite: it doubles the suite
 *     (+~150 s measured), and it runs the live rows so a transient model
 *     failure reds an env-hermeticity pin. Row 1 already keeps A's observable;
 *     it derives the set and drops the live files instead.
 *   - (B) extending an enumerated BOUNDARY_FILES list — the shape this file
 *     had, and the cheap way to reach the adopted sites: every new spawning
 *     file needs a human edit, and covering tests/e2e-checkpoint.test.ts
 *     couples the pin to 82 s of live-model rows.
 *   - (C) static only: fast and hermetic, but it pins spelling and cannot see
 *     a file whose rows observe the env in-process with no spawn site at all
 *     (tests/work-order-policy-wiring.test.ts drives the gate through
 *     production code). Kept as row 2, not as the sole pin.
 *   - (D) funnel all spawns through one helper in tests/helpers/ and forbid the
 *     raw spawn APIs: complete by construction, but it restructures the
 *     just-landed `env: childEnv(...)` call sites (10 files) to buy what row 2
 *     pins without touching them, and its import-restriction row needs the
 *     same scanner. Rejected as churn.
 *
 * Not covered here: PI_SUBAGENT_WORKTREE / PI_SUBAGENT_PARENT_CWD
 * (extensions/worktree-guard.ts:298-299) are a different class. They are read
 * once at extension load inside a pi process; the harness always overwrites
 * both at subagent spawn, empty when unisolated
 * (extensions/subagent-async/index.ts:1737-1745), so they cannot survive from
 * a caller; no test reads them from process.env; and no in-suite child picks
 * them up from an ambient value (the gate-spawned pi children get both
 * overwritten, and the two in-process SDK sessions load exactly one explicit
 * extension against a temp agentDir). The scrub set therefore stays the three
 * gate vars — see docs/investigations/structure-trend.md.
 *
 * Run: bun test tests/subagent-boundary-hermeticity.test.ts
 */

import { describe, expect, it } from "bun:test";
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { childEnv } from "./helpers/subagent-env.ts";

const REPO_ROOT = join(import.meta.dir, "..");
const SELF = join(import.meta.dir, "subagent-boundary-hermeticity.test.ts");

/** What the harness injects into a spawned subagent (extensions/subagent-async). */
const INJECTED: Record<string, string> = {
	PI_SUBAGENT_ALLOWLIST: "review-code,review-tests",
	PI_SUBAGENT_DEPTH: "1",
	PI_IS_SUBAGENT: "1",
};

/** A module reads the gate env if it names one of the vars under `process.env`. */
const GATE_ENV_READ = /process\.env\.(?:PI_SUBAGENT_[A-Z_]+|PI_IS_SUBAGENT)/;
/** Live-model rows: excluded from the child run, their flake is not this verdict. */
const LIVE_SESSION = /\bcreateAgentSession\b/;

const SOURCE_FILE = /\.(?:ts|mts|js|mjs)$/;
const TEST_FILE = /\.test\.(?:ts|mts|js|mjs)$/;

function walk(dir: string): string[] {
	const found: string[] = [];
	for (const entry of readdirSync(dir, { withFileTypes: true })) {
		const path = join(dir, entry.name);
		if (entry.isDirectory()) found.push(...walk(path));
		else if (SOURCE_FILE.test(entry.name)) found.push(path);
	}
	return found;
}

/**
 * `source` with string, template, comment and regex bodies blanked to spaces,
 * so a call named in a comment or a string is not mistaken for code. Offsets
 * and newlines are preserved, so mask slices line up with the raw source.
 */
function codeOnly(source: string): string {
	// `split("")` (code units, not `[...source]`) so mask offsets == source
	// offsets even if a file holds a non-BMP character.
	const out = source.split("");
	const blank = (from: number, to: number) => {
		for (let k = from; k < to && k < out.length; k++) if (out[k] !== "\n") out[k] = " ";
	};
	let i = 0;
	while (i < source.length) {
		if (source[i] === "/" && source[i + 1] === "/") {
			const stop = source.indexOf("\n", i);
			const end = stop === -1 ? source.length : stop;
			blank(i, end);
			i = end;
		} else if (source[i] === "/" && source[i + 1] === "*") {
			const stop = source.indexOf("*/", i + 2);
			const end = stop === -1 ? source.length : stop + 2;
			blank(i, end);
			i = end;
		} else if (source[i] === '"' || source[i] === "'" || source[i] === "`") {
			const quote = source[i];
			let j = i + 1;
			while (j < source.length) {
				if (source[j] === "\\") j += 2;
				else if (source[j] === quote) break;
				else j++;
			}
			blank(i + 1, j);
			i = j + 1;
		} else if (source[i] === "/" && startsRegex(source, i)) {
			// A regex body may hold quotes or backticks; left unblanked it would
			// open a bogus string that blanked the rest of the file (it did:
			// e2e-checkpoint's /`([^`]+\.jsonl)`/ swallowed the spawnSync below).
			let j = i + 1;
			let inClass = false;
			while (j < source.length) {
				const ch = source[j];
				if (ch === "\\") {
					j += 2;
					continue;
				}
				if (ch === "\n") break;
				if (inClass) {
					if (ch === "]") inClass = false;
				} else if (ch === "[") inClass = true;
				else if (ch === "/") break;
				j++;
			}
			if (j >= source.length || source[j] !== "/") {
				// No terminator on this line: it was a division after all.
				i++;
				continue;
			}
			blank(i + 1, j);
			i = j + 1;
			while (i < source.length && /[a-z]/.test(source[i])) i++; // flags
		} else i++;
	}
	return out.join("");
}

/** `/` here opens a regex, not a division: after an operator or a keyword. */
function startsRegex(source: string, at: number): boolean {
	let k = at - 1;
	while (k >= 0 && /\s/.test(source[k])) k--;
	if (k < 0) return true;
	if ("([{:;,=!&|?+-*%^~<>".includes(source[k])) return true;
	return /(?:^|[^\w$])(?:return|typeof|instanceof|in|of|new|delete|void|case|do|else|yield|await)\s*$/.test(
		source.slice(0, k + 1),
	);
}

/** The child-spawn call names this source declares (aliases resolved). */
function spawnApiNames(source: string): string[] {
	const names = new Set<string>(["Bun.spawn", "Bun.spawnSync"]);
	const imports = /import\s*(?:type\s+)?\{([^}]*)\}\s*from\s*["'](?:node:)?child_process["']/g;
	for (const match of source.matchAll(imports)) {
		for (const part of match[1].split(",")) {
			const name = part.trim().split(/\s+as\s+/).pop()?.trim() ?? "";
			if (/^\w+$/.test(name)) names.add(name);
		}
	}
	return [...names];
}

/** Split `text` at its depth-0 commas, ignoring commas inside (), [] and {}. */
function splitTopLevel(text: string): string[] {
	const parts: string[] = [];
	let depth = 0;
	let start = 0;
	for (let i = 0; i < text.length; i++) {
		const ch = text[i];
		if (ch === "(" || ch === "[" || ch === "{") depth++;
		else if (ch === ")" || ch === "]" || ch === "}") depth--;
		else if (ch === "," && depth === 0) {
			parts.push(text.slice(start, i));
			start = i + 1;
		}
	}
	parts.push(text.slice(start));
	return parts;
}

type CallSite = { index: number; args: string[] };

/** Every spawn call site in `source`, its arguments split at depth 0. */
function callSites(source: string): CallSite[] {
	const mask = codeOnly(source);
	const sites: CallSite[] = [];
	for (const name of spawnApiNames(source)) {
		const pattern = new RegExp(`(?<![\\w.$])${name.replace(/\./g, "\\.")}\\s*\\(`, "g");
		for (const match of mask.matchAll(pattern)) {
			const open = (match.index ?? 0) + match[0].length - 1;
			let depth = 0;
			let close = -1;
			for (let i = open; i < mask.length; i++) {
				const ch = mask[i];
				if (ch === "(") depth++;
				else if (ch === ")") {
					depth--;
					if (depth === 0) {
						close = i;
						break;
					}
				}
			}
			if (close === -1) continue;
			// Args are split on the raw source at the mask's comma offsets: the
			// mask preserves offsets, and a comma only counts at depth 0.
			const interior = mask.slice(open + 1, close);
			const args: string[] = [];
			let depth2 = 0;
			let start = 0;
			for (let i = 0; i < interior.length; i++) {
				const ch = interior[i];
				if (ch === "(" || ch === "[" || ch === "{") depth2++;
				else if (ch === ")" || ch === "]" || ch === "}") depth2--;
				else if (ch === "," && depth2 === 0) {
					args.push(source.slice(open + 1 + start, open + 1 + i));
					start = i + 1;
				}
			}
			args.push(source.slice(open + 1 + start, close));
			sites.push({ index: match.index ?? 0, args });
		}
	}
	return sites;
}

/** Whether a call's options argument is an object literal carrying an `env`. */
function hasExplicitEnv(options: string | undefined): boolean {
	const text = (options ?? "").trim();
	if (!text.startsWith("{") || !text.endsWith("}")) return false;
	const properties = splitTopLevel(codeOnly(text).slice(1, -1));
	return properties.some((property) => /^\s*env\s*(?::|,|$)/.test(property));
}

/** "file:line — why" for every spawn in `path` that does not pass an explicit env. */
function spawnSiteProblems(path: string, source = readFileSync(path, "utf8")): string[] {
	const problems: string[] = [];
	for (const site of callSites(source)) {
		const options = site.args.length > 1 ? site.args[site.args.length - 1] : undefined;
		if (hasExplicitEnv(options)) continue;
		const line = source.slice(0, site.index).split("\n").length;
		const where = `${path === SELF ? "<fixture>" : relative(REPO_ROOT, path)}:${line}`;
		problems.push(
			options === undefined || !options.trim().startsWith("{")
				? `${where} — no options object: pass \`env\` explicitly (\`env: childEnv()\`)`
				: `${where} — options omit \`env\`: a spawn without it gets bun's startup env snapshot`,
		);
	}
	return problems;
}

/**
 * "file — why" for a file whose raw source calls a spawn API that the mask no
 * longer shows. The scan asserts nothing when it sees nothing, so a mask that
 * swallows code (a regex literal holding a backtick once did, hiding
 * e2e-checkpoint's spawnSync) would turn this row silently green.
 */
function detectorBlindSpots(path: string): string[] {
	const source = readFileSync(path, "utf8");
	if (callSites(source).length > 0) return [];
	for (const name of spawnApiNames(source)) {
		if (name.startsWith("Bun.")) continue;
		if (new RegExp(`(?<![\\w.$])${name}\\s*\\(`).test(source)) {
			return [`${relative(REPO_ROOT, path)} — raw source calls ${name}() but the scanner found no site`];
		}
	}
	return [];
}

/** Resolve a relative module specifier to a file on disk, if it has one. */
function resolveModule(fromFile: string, specifier: string): string | undefined {
	if (!specifier.startsWith(".")) return undefined;
	const base = resolve(dirname(fromFile), specifier);
	for (const candidate of [base, `${base}.ts`, `${base}.mts`, join(base, "index.ts")]) {
		if (existsSync(candidate) && statSync(candidate).isFile()) return candidate;
	}
	return undefined;
}

/** Whether `path` imports a module whose own source reads the gate env. */
function importsGateEnvReader(path: string): boolean {
	const source = readFileSync(path, "utf8");
	const specifiers = [...source.matchAll(/(?:from|import)\s+["'](\.[^"']+)["']/g)].map((m) => m[1]);
	for (const specifier of specifiers) {
		const target = resolveModule(path, specifier);
		if (target && GATE_ENV_READ.test(readFileSync(target, "utf8"))) return true;
	}
	return false;
}

/**
 * The test files that can observe the gate env: they spawn a child (whose env
 * they therefore choose) or they import a module that reads the vars. Live-model
 * files and this file are excluded — see the header.
 */
function gateSensitiveTestFiles(): string[] {
	return walk(import.meta.dir)
		.filter((path) => TEST_FILE.test(path) && path !== SELF)
		.filter((path) => {
			const source = readFileSync(path, "utf8");
			if (LIVE_SESSION.test(source)) return false;
			return callSites(source).length > 0 || importsGateEnvReader(path);
		})
		.sort();
}

/**
 * Runs `files` as a child `bun test` under the injected env and returns its
 * report. bun prints its summary to stderr, so the report is both streams. The
 * env is passed explicitly: bun hands a child the startup snapshot, so an
 * in-process deletion alone would not reach it.
 */
function childRun(files: string[]): { status: number | null; error?: Error; report: string } {
	for (let attempt = 1; ; attempt++) {
		const run = spawnSync("bun", ["test", ...files.map((path) => relative(REPO_ROOT, path))], {
			cwd: REPO_ROOT,
			env: childEnv({ ...INJECTED }),
			encoding: "utf8",
			timeout: 300_000,
		});
		const report = `${run.stdout ?? ""}${run.stderr ?? ""}`;
		// A spawn that never started (EAGAIN on a loaded machine) says nothing
		// about the env, so it is retried once. A run that started and failed is
		// the verdict, and is not.
		if (!run.error || attempt === 2) return { status: run.status, error: run.error, report };
	}
}

describe("subagent-boundary hermeticity", () => {
	it("every test file that can observe the gate env is green under an injected PI_SUBAGENT_* env", () => {
		const files = gateSensitiveTestFiles();
		// Self-exclusion: the child run must not re-enter this file.
		expect(files).not.toContain(SELF);
		// Vacuity guard: a broken walk must not pass by testing nothing. 24 files
		// when this row landed.
		expect(files.length).toBeGreaterThanOrEqual(10);

		const { status, error, report } = childRun(files);
		if (error || status !== 0) {
			throw new Error(
				`child \`bun test\` over ${files.length} gate-sensitive files failed under an injected env ` +
					`(status ${status}${error ? `, ${error.message}` : ""}):\n${report}`,
			);
		}
		expect(report).toContain("0 fail");
		// The child ran exactly the derived set: a recursive pin would list this
		// file (and never finish).
		expect(report).toContain(`across ${files.length} files`);
		// `toContain("0 fail")` also matches "10 fail" — no nonzero count may appear.
		expect(report).not.toMatch(/[1-9]\d* fail/);
	}, 300_000);

	it("every child spawn under tests/ passes an explicit env", () => {
		const paths = walk(import.meta.dir);
		const inventory = paths.filter((path) => callSites(readFileSync(path, "utf8")).length > 0);
		// Inventory floor: "nothing reported" also describes a scanner that sees
		// nothing. 11 files / 16 sites when this row landed.
		expect(inventory.length).toBeGreaterThanOrEqual(8);
		expect(paths.flatMap((path) => detectorBlindSpots(path))).toEqual([]);
		expect(paths.flatMap((path) => spawnSiteProblems(path))).toEqual([]);
	});

	it("the spawn-env detector fires on a bare spawn and clears an explicit env", () => {
		const bare = `import { spawnSync } from "node:child_process";\nspawnSync("bun", ["test"]);\n`;
		const bareArgs = `import { execFileSync } from "node:child_process";\nexecFileSync("git", ["init"], { cwd: repo });\n`;
		const commentOnly = `// spawnSync("bun", ["test"]) in a comment is not a call site\nconst x = 1;\n`;
		const explicit = `import { execFileSync } from "node:child_process";\nexecFileSync("git", ["init"], { cwd: repo, env: childEnv() });\n`;
		const bunSpawn = `Bun.spawn(["true"], { env: childEnv() });\n`;

		expect(spawnSiteProblems(SELF, bare)).toHaveLength(1);
		expect(spawnSiteProblems(SELF, bareArgs)).toHaveLength(1);
		expect(spawnSiteProblems(SELF, commentOnly)).toEqual([]);
		expect(spawnSiteProblems(SELF, explicit)).toEqual([]);
		expect(spawnSiteProblems(SELF, bunSpawn)).toEqual([]);
	});
});
