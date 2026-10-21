/**
 * The subagent-boundary test files must not be sensitive to the ambient
 * PI_SUBAGENT_* environment.
 *
 * What happened (gh #19): `bun test` run from INSIDE a subagent failed 11
 * rows across three files — tests/subagent-model-inheritance.test.ts,
 * tests/work-order-policy-wiring.test.ts, tests/work-record-capture.test.ts.
 * The harness injects PI_SUBAGENT_ALLOWLIST / PI_SUBAGENT_DEPTH /
 * PI_IS_SUBAGENT into spawned subagents; the boundary rows exercise real
 * spawns through the tool gate (extensions/subagent-async/index.ts reads
 * process.env.PI_SUBAGENT_ALLOWLIST for the allowlist check and
 * subagentDepth() for the nesting cap), so the inherited allowlist refused
 * the `implement`/`orchestrator` spawns those rows are about. Two WO
 * verifications red identically at base AND landed — the suite's verdict was
 * a property of the invocation context, not the code under test.
 *
 * Intended end state: the boundary rows control the env they exercise (the
 * spawn gate's env sensitivity is the feature being tested — the suite may
 * not inherit it). The mechanism is the fixer's choice (a shared scrub in the
 * files' beforeAll, a bunfig preload, or per-row env) — this file pins the
 * observable: a child `bun test` of the boundary files with the harness's
 * injection replicated reports 0 fail.
 *
 * bun 1.3 has no expected-failure modifier (`test.fails` is undefined), so
 * this row asserts the known-bug state and is named for the flip: when the
 * fix lands the child run goes green, this row reds the suite, and the fixer
 * replaces the assertion with `expect(out).toContain("0 fail")` and the name
 * with the positive one.
 *
 * Run: bun test tests/subagent-boundary-hermeticity.test.ts
 */

import { describe, expect, it } from "bun:test";
import { execFileSync } from "node:child_process";
import { join } from "node:path";

const BOUNDARY_FILES = [
	"tests/subagent-model-inheritance.test.ts",
	"tests/work-order-policy-wiring.test.ts",
	"tests/work-record-capture.test.ts",
];

/** What the harness injects into a spawned subagent (extensions/subagent-async). */
const INJECTED: Record<string, string> = {
	PI_SUBAGENT_ALLOWLIST: "review-code,review-tests",
	PI_SUBAGENT_DEPTH: "1",
	PI_IS_SUBAGENT: "1",
};

/** Runs the boundary files as a child `bun test`; true iff all pass. */
function boundaryRunGreen(): boolean {
	try {
		execFileSync("bun", ["test", ...BOUNDARY_FILES], {
			cwd: join(import.meta.dir, ".."),
			env: { ...process.env, ...INJECTED },
			encoding: "utf8",
			timeout: 300_000,
		});
		return true;
	} catch {
		return false;
	}
}

describe("subagent-boundary hermeticity", () => {
	it("KNOWN-BUG (fix pending): boundary files fail under an injected PI_SUBAGENT_* env — flip this row at the fix", () => {
		expect(boundaryRunGreen()).toBeFalse();
	});
});
