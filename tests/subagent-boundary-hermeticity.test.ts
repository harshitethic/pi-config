/**
 * The subagent-boundary test files must not be sensitive to the ambient
 * PI_SUBAGENT_* environment.
 *
 * What happened (pi-config#9): `bun test` run from INSIDE a subagent failed 11
 * rows across three files — tests/subagent-model-inheritance.test.ts,
 * tests/work-order-policy-wiring.test.ts, tests/work-record-capture.test.ts.
 * The harness injects PI_SUBAGENT_ALLOWLIST / PI_SUBAGENT_DEPTH /
 * PI_IS_SUBAGENT into spawned subagents; the boundary rows exercise real
 * spawns through the tool gate (extensions/subagent-async reads
 * process.env.PI_SUBAGENT_ALLOWLIST for the allowlist check and
 * subagentDepth() for the nesting cap), so the inherited allowlist refused
 * the `implement`/`orchestrator` spawns those rows are about. Two WO
 * verifications red identically at base AND landed — the suite's verdict was
 * a property of the invocation context, not the code under test.
 *
 * The fix (test side only): those files scrub the three vars through
 * tests/helpers/subagent-env.ts, so the gate's env sensitivity is exercised by
 * the rows that declare it (tests/subagent-nesting.test.ts sets the values it
 * asserts on) and never inherited. This file pins the observable: a child
 * `bun test` of the boundary files with the harness's injection replicated
 * reports 0 fail.
 *
 * Run: bun test tests/subagent-boundary-hermeticity.test.ts
 */

import { describe, expect, it } from "bun:test";
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { childEnv } from "./helpers/subagent-env.ts";

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

/**
 * Runs the boundary files as a child `bun test` under the injected env and
 * returns its report (stdout + stderr — bun test prints its summary to stderr,
 * which `execFileSync` leaks to this process instead of capturing). The env is
 * passed explicitly: Bun hands a child the startup snapshot, so an in-process
 * deletion alone would not reach it.
 */
function boundaryRun(): { status: number | null; error?: Error; report: string } {
	const run = spawnSync("bun", ["test", ...BOUNDARY_FILES], {
		cwd: join(import.meta.dir, ".."),
		env: childEnv({ ...INJECTED }),
		encoding: "utf8",
		timeout: 300_000,
	});
	return { status: run.status, error: run.error, report: `${run.stdout ?? ""}${run.stderr ?? ""}` };
}

describe("subagent-boundary hermeticity", () => {
	it("the boundary files stay green under an injected PI_SUBAGENT_* env", () => {
		const { status, error, report } = boundaryRun();
		expect(error).toBeUndefined();
		expect(status).toBe(0);
		expect(report).toContain("0 fail");
		// `toContain("0 fail")` also matches "10 fail" — no nonzero count may appear.
		expect(report).not.toMatch(/[1-9]\d* fail/);
	}, 300_000);
});
