/**
 * tests/helpers/subagent-env.ts — the one env-control helper the subagent-boundary
 * files share (pi-config#9).
 *
 * Three things are load-bearing enough to pin here rather than re-derive in the
 * files that import it: the scrub restores exactly what it found (including
 * "was absent"), `childEnv()` carries the *live* env, and a spawn that omits
 * `env` does not — Bun hands it the startup snapshot, which is why
 * `childEnv()` exists at all. The quirk row is self-contained (a middle child
 * receives a probe var at its own startup) so this file's verdict never depends
 * on the env its runner happens to have.
 *
 * Run: bun test tests/subagent-env.test.ts
 */

import { describe, expect, it } from "bun:test";
import { spawnSync } from "node:child_process";
import { SUBAGENT_ENV_VARS, childEnv, scrubSubagentEnv } from "./helpers/subagent-env.ts";

/** Run `bun -e <code>` and return its stdout; a dead spawn fails loudly. */
function bunEval(code: string, env?: NodeJS.ProcessEnv): string {
	const run = spawnSync(process.execPath, ["-e", code], { encoding: "utf8", timeout: 30_000, env });
	expect(run.error).toBeUndefined();
	expect(run.status).toBe(0);
	return run.stdout;
}

describe("scrubSubagentEnv", () => {
	it("unsets every harness var, then restores exactly what it found", () => {
		const saved = SUBAGENT_ENV_VARS.map((key) => [key, process.env[key]] as const);
		try {
			process.env.PI_SUBAGENT_ALLOWLIST = "review-code,review-tests";
			process.env.PI_SUBAGENT_DEPTH = "1";
			process.env.PI_IS_SUBAGENT = "1";

			const restore = scrubSubagentEnv();
			for (const key of SUBAGENT_ENV_VARS) expect(process.env[key]).toBeUndefined();

			restore();
			expect(process.env.PI_SUBAGENT_ALLOWLIST).toBe("review-code,review-tests");
			expect(process.env.PI_SUBAGENT_DEPTH).toBe("1");
			expect(process.env.PI_IS_SUBAGENT).toBe("1");
		} finally {
			for (const [key, value] of saved) {
				if (value === undefined) delete process.env[key];
				else process.env[key] = value;
			}
		}
	});

	it("restores 'absent' as absent instead of writing an empty stamp", () => {
		const saved = SUBAGENT_ENV_VARS.map((key) => [key, process.env[key]] as const);
		try {
			for (const key of SUBAGENT_ENV_VARS) delete process.env[key];
			scrubSubagentEnv()();
			for (const key of SUBAGENT_ENV_VARS) expect(key in process.env).toBe(false);
		} finally {
			for (const [key, value] of saved) {
				if (value === undefined) delete process.env[key];
				else process.env[key] = value;
			}
		}
	});
});

describe("childEnv", () => {
	it("carries the live env: an in-process deletion removes the key, overrides win", () => {
		const saved = process.env.PI_SUBAGENT_ALLOWLIST;
		try {
			process.env.PI_SUBAGENT_ALLOWLIST = "implement";
			delete process.env.PI_SUBAGENT_ALLOWLIST;
			expect("PI_SUBAGENT_ALLOWLIST" in childEnv()).toBe(false);
			expect(childEnv({ PI_SUBAGENT_ALLOWLIST: "implement" }).PI_SUBAGENT_ALLOWLIST).toBe("implement");
			// `undefined` removes rather than writing the string "undefined".
			process.env.PI_SUBAGENT_ALLOWLIST = "implement";
			expect("PI_SUBAGENT_ALLOWLIST" in childEnv({ PI_SUBAGENT_ALLOWLIST: undefined })).toBe(false);
		} finally {
			if (saved === undefined) delete process.env.PI_SUBAGENT_ALLOWLIST;
			else process.env.PI_SUBAGENT_ALLOWLIST = saved;
		}
	});

	it("reaches a real child with the override, whatever the runner's env says", () => {
		const out = bunEval("process.stdout.write(process.env.PI_SUBAGENT_DEPTH ?? '<unset>')", childEnv({ PI_SUBAGENT_DEPTH: "2" }));
		expect(out).toBe("2");
	}, 30_000);

	it("is required: a spawn without `env` gets the startup snapshot (bun 1.3.11, observed 2026-10-21)", () => {
		// A middle child receives PROBE_STARTUP at its own startup, deletes it, then
		// spawns a grandchild both ways. If this row ever reds, Bun started passing
		// the live env — `childEnv()` is then merely explicit, still correct.
		const middle = `
			const { spawnSync } = require("node:child_process");
			delete process.env.PROBE_STARTUP;
			const read = (options) => spawnSync(process.execPath, ["-e", "process.stdout.write(process.env.PROBE_STARTUP ?? '<unset>')"], { encoding: "utf8", ...options }).stdout;
			process.stdout.write("no-env=" + read({}) + " explicit=" + read({ env: { ...process.env } }));
		`;
		const out = bunEval(middle, { ...process.env, PROBE_STARTUP: "startup" });
		expect(out).toBe("no-env=startup explicit=<unset>");
	}, 30_000);
});
