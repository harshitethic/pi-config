/**
 * Compaction Model Extension
 *
 * Forces /compact and auto-compaction to use the fleet model at `:low`
 * effort (decision 022) while keeping every other aspect of compaction
 * identical to the default.
 *
 * Why force the model: the active session model can be switched mid-session,
 * and compaction should always run on the cheap fleet seat rather than
 * whatever the user is currently driving.
 *
 * Why `:low`: compaction is summarization, not reasoning. The vendor effort
 * audit (decision 022) puts `low`=50 as the real discount tier — "modest
 * accuracy degradation" on a smooth curve — and without an explicit level
 * compaction silently rides the provider default (`high`). Resolution is
 * table-driven from extensions/lib/fleet-model.ts.
 *
 * If the model cannot be resolved or auth fails, falls through to pi's
 * default compaction behavior.
 */

import { compact } from "@earendil-works/pi-coding-agent";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { FLEET_MODEL, FLEET_MODEL_SPEC, FLEET_PROVIDER } from "./lib/fleet-model.ts";

export default function (pi: ExtensionAPI) {
	pi.on("session_before_compact", async (event, ctx) => {
		const { preparation, customInstructions, signal } = event;

		const model = ctx.modelRegistry.find(FLEET_PROVIDER, FLEET_MODEL);
		if (!model) {
			ctx.ui.notify(
				`Compaction model ${FLEET_MODEL_SPEC} not found — using default compaction`,
				"warning",
			);
			return;
		}

		// Resolve auth for the compaction model
		const auth = await ctx.modelRegistry.getApiKeyAndHeaders(model);
		if (!auth.ok) {
			ctx.ui.notify(`Compaction auth failed: ${auth.error}`, "warning");
			return;
		}

		try {
			const result = await compact(
				preparation,
				model,
				auth.apiKey,
				auth.headers,
				customInstructions,
				signal,
				"low", // decision 022 effort audit — summarization runs at the discount tier
			);

			return { compaction: result };
		} catch (error) {
			if (signal?.aborted) {
				// Silently swallow — user cancelled compaction
				return;
			}
			const message = error instanceof Error ? error.message : String(error);
			ctx.ui.notify(`Compaction with ${FLEET_MODEL} failed: ${message}`, "error");
			return;
		}
	});
}
