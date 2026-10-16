/**
 * Owner-asks counter for the pi status bar: open registry questions and the
 * new ones since the owner last ran `/asks`. Repos without
 * scripts/reviews_status.py show nothing. Logic: lib.ts; the Claude Code side:
 * external.ts. Subagents skip: no owner watches their status bar.
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { ack, attention, countText, list, ownerAsks } from "./lib.ts";

const STATUS_KEY = "owner-asks";
const REFRESH_MS = 60_000;

export default function (pi: ExtensionAPI) {
	if (process.env.PI_SUBAGENT_DEPTH) return;

	let ctx: ExtensionContext | undefined;
	let timer: ReturnType<typeof setInterval> | undefined;

	const refresh = async (): Promise<void> => {
		const current = ctx;
		if (!current?.hasUI) return;
		try {
			const state = await ownerAsks(current.cwd);
			if (!state) {
				current.ui.setStatus(STATUS_KEY, undefined);
				return;
			}
			const text = countText(state.asks, state.unruled.length);
			current.ui.setStatus(STATUS_KEY, attention(state) ? current.ui.theme.fg("warning", text) : text);
		} catch {
			// The error text comes from /asks; the status bar only flags it.
			current.ui.setStatus(STATUS_KEY, current.ui.theme.fg("error", "owner asks: error"));
		}
	};

	pi.on("session_start", (_event, c) => {
		ctx = c;
		clearInterval(timer);
		timer = undefined;
		// Print/JSON mode has no status bar, and a live interval would keep the process from exiting.
		if (!c.hasUI) return;
		void refresh();
		timer = setInterval(() => void refresh(), REFRESH_MS);
	});

	pi.on("agent_settled", (_event, c) => {
		ctx = c;
		void refresh();
	});

	pi.on("session_shutdown", () => {
		clearInterval(timer);
		timer = undefined;
		ctx = undefined;
	});

	pi.registerCommand("asks", {
		description: "Show owner asks (new first) and mark them seen",
		handler: async (_args, c) => {
			ctx = c;
			try {
				const lines = await list(c.cwd);
				if (!lines) {
					c.ui.notify("not a registry repo (no scripts/reviews_status.py)", "info");
					return;
				}
				c.ui.notify(lines.join("\n") || "no open asks", "info");
				await ack(c.cwd);
			} catch (err) {
				c.ui.notify(`owner asks: ${(err as Error).message}`, "error");
			}
			await refresh();
		},
	});
}
