/**
 * Ambient `PI_SUBAGENT_*` control for tests that drive the subagent tool gate.
 *
 * The harness injects PI_SUBAGENT_ALLOWLIST / PI_SUBAGENT_DEPTH / PI_IS_SUBAGENT
 * into every subagent process, and the gate (extensions/subagent-async) reads
 * them: an inherited allowlist refuses the `implement`/`orchestrator` spawns a
 * boundary row is about, and an inherited depth counts against the nesting cap.
 * That env sensitivity is the feature under test, so the suite must not inherit
 * it (pi-config#9): a file whose rows are not about env control scrubs it in
 * `beforeAll`, and a row that *is* about env control sets the value it exercises.
 *
 * Bun hands a child the env snapshot taken at process start: an in-process
 * `delete process.env.X` never reaches a spawn that omits `env` — verified on
 * bun 1.3.11 (pi-config#7, commit afe16c9). Spawns therefore pass `childEnv()`,
 * which spreads the *live* env, not the startup snapshot.
 */

/** The vars the harness injects into a subagent session. */
export const SUBAGENT_ENV_VARS = ["PI_SUBAGENT_ALLOWLIST", "PI_SUBAGENT_DEPTH", "PI_IS_SUBAGENT"] as const;

/** Unset the three vars. `scrubSubagentEnv` is this plus a snapshot. */
export function unsetSubagentEnv(): void {
	for (const key of SUBAGENT_ENV_VARS) delete process.env[key];
}

/**
 * Snapshot the three vars, unset them, and return the restore to call from
 * `afterAll` (which bun runs even when a row failed). At row level the same
 * call brackets the value the row sets, so the file's scrubbed baseline comes
 * back afterwards instead of the harness's inherited one.
 */
export function scrubSubagentEnv(): () => void {
	const saved = SUBAGENT_ENV_VARS.map((key) => [key, process.env[key]] as const);
	unsetSubagentEnv();
	return () => {
		for (const [key, value] of saved) {
			if (value === undefined) delete process.env[key];
			else process.env[key] = value;
		}
	};
}

/**
 * The env to hand a child process explicitly: the live env plus `overrides`
 * (`undefined` removes a key). Never spawn without it — see the startup-snapshot
 * note above.
 */
export function childEnv(overrides: Record<string, string | undefined> = {}): NodeJS.ProcessEnv {
	const env: NodeJS.ProcessEnv = { ...process.env };
	for (const [key, value] of Object.entries(overrides)) {
		if (value === undefined) delete env[key];
		else env[key] = value;
	}
	return env;
}
