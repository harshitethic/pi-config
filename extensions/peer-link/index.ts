/**
 * peer-link — let two user-launched pi sessions coordinate by exchanging
 * user messages.
 *
 * Sessions sharing a mailbox (`~/.pi/peer-mail` by default, or
 * $PI_PEER_MAILBOX) can send each other messages. An inbound envelope is
 * injected into the receiving session as a real user message (prefixed
 * `[peer:<name>]`), which triggers the receiving agent. One-way messages are
 * delivered as `steer` (land at the next turn boundary); reply-requested
 * messages pivot via `followUp` (wait until idle) so the auto-reply slicer
 * captures a clean response. A sender can opt a one-way message into follow-up
 * (`/peer-send --followup` or peer_send `followUp:true`). If the envelope sets
 * `expectReply`, the receiving agent's response is sent back automatically —
 * once, and never re-forwarded (the reply carries expectReply:false).
 *
 * Identity: $PI_PEER_NAME, else the session file basename, else host-pid.
 * Set $PI_PEER_NAME (e.g. `PI_PEER_NAME=alice pi`) for stable friendly
 * names; without it, a session's identity changes when it is replaced
 * (/new, /resume).
 *
 * Commands: /peers (list peers), /peer-send [--reply] <name> <text>,
 * /peer-autoreply [on|off]. The LLM can coordinate via the peer_list and
 * peer_send tools.
 *
 * Loop safety: envelopes are acked (deleted) only after successful injection,
 * auto-replies carry expectReply:false, and each envelope is replied to at most
 * once per process. Peers that message each other deliberately (LLM-driven
 * multi-turn coordination) are fine; nothing here re-forwards a received reply.
 * Delivery is at-least-once: a crash between injection and ack duplicates a
 * message rather than losing it.
 *
 * Delivery gate: a send to a name that matches no listed peer FAILS loudly
 * instead of queueing — an unlisted name (typo, chimera of two session
 * names, a friendly guess like "tfd-b") would otherwise sit forever in an
 * inbox nobody reads while the tool reports "queued". Only listed peers
 * (heartbeat present, online or stale) accept queued offline delivery.
 *
 * External peers (Claude Code sessions via `external.ts`) are listed but never
 * online: mail to them waits until their user next prompts. Nothing here ever
 * reads or injects into their inbox.
 */

import { randomUUID } from "node:crypto";
import * as fs from "node:fs";
import type { ExtensionAPI, ExtensionContext, SessionEntry } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import {
	HEARTBEAT_MS,
	SCAN_MS,
	type Envelope,
	type PeerInfo,
	ackEnvelope,
	deliveryDecision,
	deliveryModeFor,
	ensureMailbox,
	inboxDir,
	listPeers,
	mailboxRoot,
	newEnvelope,
	ownPeerName,
	peerIdentityFrom,
	peerStatus,
	queuedStatus,
	readIncoming,
	removeHeartbeat,
	resolvePeerAddressAmong,
	sanitizePeerName,
	sendEnvelope,
	sweepStalePeers,
	writeHeartbeat,
} from "./mailbox.ts";

const PENDING_TTL_MS = 10 * 60 * 1000; // drop queued-but-never-delivered auto-replies

export { deliveryDecision } from "./mailbox.ts";

function peerGlyph(p: PeerInfo): string {
	if (p.external) return "◇";
	return p.online ? "●" : "○";
}

export default function (pi: ExtensionAPI) {
	// Per-instance state: each pi process (or SDK session) gets its own
	// closure, so two sessions in one process never share timers or state.
	const state = {
		mailbox: "",
		peerName: "",
		sessionFile: undefined as string | undefined,
		cwd: "",
		autoreply: true,
	};

	// Envelope ids consumed this process (belt-and-braces beyond file deletion).
	const seen = new Set<string>();
	// Injected messages awaiting an automatic reply: id -> { env, text, queuedAt }.
	const pendingReplies = new Map<string, { env: Envelope; text: string; queuedAt: number }>();
	// Envelope ids already replied to (at-most-once even if re-consumed).
	const replied = new Set<string>();

	let watcher: fs.FSWatcher | undefined;
	let scanTimer: ReturnType<typeof setInterval> | undefined;
	let heartbeatTimer: ReturnType<typeof setInterval> | undefined;

	// ── lifecycle ──────────────────────────────────────────────────────────

	pi.on("session_start", async (_event, ctx) => {
		try {
			state.mailbox = mailboxRoot();
			state.peerName = resolvePeerName(ctx);
			state.sessionFile = ctx.sessionManager.getSessionFile() ?? undefined;
			state.cwd = ctx.cwd;
			ensureMailbox(state.mailbox, state.peerName);
			restoreAutoreply();
			startRuntime();
		} catch (err) {
			ctx.ui.notify(`peer-link init failed: ${(err as Error).message}`, "error");
		}
	});

	pi.on("session_shutdown", async () => {
		stopRuntime();
	});

	function resolvePeerName(ctx: ExtensionContext): string {
		return peerIdentityFrom(
			process.env,
			ctx.sessionManager.getSessionName() ?? undefined,
			ctx.sessionManager.getSessionFile(),
		);
	}

	/** Late initialization guard for tools/commands (session_start normally covers it). */
	function ensureReady(ctx?: ExtensionContext): void {
		if (state.mailbox && state.peerName) return;
		state.mailbox = mailboxRoot();
		state.peerName = ctx ? resolvePeerName(ctx) : ownPeerName();
		state.sessionFile = ctx?.sessionManager.getSessionFile() ?? undefined;
		state.cwd = ctx?.cwd ?? process.cwd();
		ensureMailbox(state.mailbox, state.peerName);
		startRuntime();
	}

	function startRuntime(): void {
		stopRuntime();
		publishHeartbeat();
		consumeInbox();
		scanTimer = setInterval(() => consumeInbox(), SCAN_MS);
		heartbeatTimer = setInterval(() => {
			publishHeartbeat();
			sweepStalePeers(state.mailbox);
		}, HEARTBEAT_MS);
		scanTimer.unref?.();
		heartbeatTimer.unref?.();
		try {
			watcher = fs.watch(inboxDir(state.mailbox, state.peerName), { persistent: false }, () =>
				consumeInbox(),
			);
		} catch {
			// polling covers platforms/dirs where fs.watch is unavailable
		}
	}

	function stopRuntime(): void {
		if (scanTimer) clearInterval(scanTimer);
		if (heartbeatTimer) clearInterval(heartbeatTimer);
		scanTimer = undefined;
		heartbeatTimer = undefined;
		try {
			watcher?.close();
		} catch {
			// already closed
		}
		watcher = undefined;
		if (state.mailbox && state.peerName) removeHeartbeat(state.mailbox, state.peerName);
	}

	function publishHeartbeat(): void {
		if (!state.mailbox || !state.peerName) return;
		writeHeartbeat(state.mailbox, {
			name: state.peerName,
			sessionFile: state.sessionFile,
			cwd: state.cwd,
			ts: Date.now(),
			autoreply: state.autoreply,
		});
	}

	function restoreAutoreply(): void {
		try {
			const info = listPeers(state.mailbox).find((p) => p.name === state.peerName);
			if (info && typeof info.autoreply === "boolean") state.autoreply = info.autoreply;
		} catch {
			// first run: no heartbeat yet
		}
	}

	// ── inbound ─────────────────────────────────────────────────────────────

	function consumeInbox(): void {
		if (!state.mailbox || !state.peerName) return;
		for (const env of readIncoming(state.mailbox, state.peerName)) {
			if (seen.has(env.id) || replied.has(env.id)) continue;
			seen.add(env.id);
			const text = `[peer:${env.from}] ${env.text}`;
			if (env.expectReply) {
				pendingReplies.set(env.id, { env, text, queuedAt: Date.now() });
			}
			try {
				pi.sendUserMessage(text, { deliverAs: deliveryModeFor(env) });
				// Ack only after injection succeeds: a throw leaves the envelope on
				// disk so the next scan retries (at-least-once, duplicates over loss).
				ackEnvelope(state.mailbox, state.peerName, env);
			} catch {
				seen.delete(env.id);
				pendingReplies.delete(env.id);
			}
		}
		const now = Date.now();
		for (const [id, p] of pendingReplies) {
			if (now - p.queuedAt > PENDING_TTL_MS) pendingReplies.delete(id);
		}
	}

	// ── automatic replies ───────────────────────────────────────────────────

	pi.on("agent_settled", (_event, ctx) => {
		if (pendingReplies.size === 0 || !state.autoreply) return;
		const branch = ctx.sessionManager.getBranch();

		// Anchor each pending reply at its injected user message, so messages
		// that were queued mid-turn slice only the response that followed them.
		const pending = [...pendingReplies.values()];
		const positions: Array<{ env: Envelope; idx: number }> = [];
		let searchFrom = 0;
		for (const p of pending) {
			const idx = findInjectedMessage(branch, p.text, searchFrom);
			if (idx >= 0) {
				positions.push({ env: p.env, idx });
				searchFrom = idx + 1;
			}
			// Not delivered yet: leave it pending; TTL expiry cleans it up.
		}

		for (let i = 0; i < positions.length; i++) {
			const { env, idx } = positions[i];
			pendingReplies.delete(env.id);
			if (replied.has(env.id)) continue;
			const end = i + 1 < positions.length ? positions[i + 1].idx : branch.length;
			const replyText = assistantText(branch.slice(idx + 1, end));
			if (!replyText) continue;
			replied.add(env.id);
			// Resolve the sender the way peer_send does; if their heartbeat is gone
			// (died within the sweep window), say so instead of silently dropping a
			// reply into an inbox nobody reads.
			const listed = listPeers(state.mailbox);
			const to = resolvePeerAddressAmong(listed, env.from);
			if (!listed.some((p) => p.name === to)) {
				ctx.ui.notify(
					`peer-link: auto-reply to "${env.from}" not sent — peer no longer listed`,
					"warning",
				);
				continue;
			}
			sendEnvelope(state.mailbox, newEnvelope(state.peerName, to, replyText, false, env.id));
		}
	});

	function findInjectedMessage(branch: SessionEntry[], text: string, from: number): number {
		for (let i = from; i < branch.length; i++) {
			const entry = branch[i];
			if (entry.type !== "message" || entry.message.role !== "user") continue;
			if (getMessageText(entry.message) === text) return i;
		}
		return -1;
	}

	function getMessageText(message: { content?: unknown }): string {
		const content = message.content;
		if (typeof content === "string") return content;
		if (Array.isArray(content)) {
			return content
				.filter(
					(b): b is { type: "text"; text: string } =>
						b.type === "text" && typeof b.text === "string",
				)
				.map((b) => b.text)
				.join("\n");
		}
		return "";
	}

	function assistantText(entries: SessionEntry[]): string {
		const parts: string[] = [];
		for (const entry of entries) {
			if (entry.type !== "message" || entry.message.role !== "assistant") continue;
			const text = getMessageText(entry.message).trim();
			if (text) parts.push(text);
		}
		return parts.join("\n\n");
	}

	// ── tools (LLM coordination) ────────────────────────────────────────────

	pi.registerTool({
		name: "peer_list",
		label: "Peer List",
		description:
			"List pi sessions (peers) that share this mailbox. Each entry shows a peer name, its session, and whether it is online. Use the names with peer_send.",
		promptSnippet: "List other pi sessions (peers) available for coordination",
		parameters: Type.Object({}),
		async execute(_toolCallId, _params, _signal, _onUpdate, ctx) {
			ensureReady(ctx);
			const peers = listPeers(state.mailbox);
			const lines =
				peers.length === 0
					? ["No peers found (none have announced a heartbeat yet)."]
					: peers.map((p) => {
							const where = p.sessionFile ? ` — ${p.sessionFile}` : p.cwd ? ` — ${p.cwd}` : "";
							return `${peerGlyph(p)} ${p.name} (${peerStatus(p)})${where}`;
						});
			return {
				content: [{ type: "text", text: `self: ${state.peerName}\n${lines.join("\n")}` }],
				details: { self: state.peerName, peers },
			};
		},
	});

	pi.registerTool({
		name: "peer_send",
		label: "Peer Send",
		description:
			"Send a message to another pi session (peer) or an external peer (a Claude Code session; it reads mail only when its user next prompts, so do not wait on its reply). A pi peer's message is injected into the peer's session as a user message, triggering its agent. Use peer_list to discover peers. Set expectReply to true to have the peer's response sent back to this session automatically. Use to: \"*\" to broadcast to all online peers. Keep the message information-dense — lead with the ask, skip filler.",
		promptSnippet: "Send a message to another pi session and optionally await its reply",
		promptGuidelines: [
			"Use peer_send when the user asks to coordinate with another pi session or another agent.",
			"Call peer_list first to discover peers and confirm the recipient name.",
			"Set expectReply: true when this session needs the peer's answer; the reply arrives as a user message prefixed with the peer's name.",
			"Write messages information-dense: lead with the ask and include whatever context or constraints the peer needs, skipping salutations, sign-offs, pleasantries, and recap. Concise is good, but completeness still wins.",
		],
		parameters: Type.Object({
			to: Type.String({
				description:
					'Peer name (or UUID tail) to send to, or "*" to broadcast to all online peers. Names not matching a listed peer fail loudly — call peer_list first.',
			}),
			message: Type.String({
				description:
					"Message text. Information-dense and direct: state the request (and any needed context/constraints) up front; no salutations, sign-offs, or filler prose.",
			}),
			expectReply: Type.Optional(
				Type.Boolean({ description: "Send the peer's response back automatically (default false)" }),
			),
			followUp: Type.Optional(
				Type.Boolean({
					description:
						'Deliver as follow-up (wait until the peer is fully idle) instead of steering its current turn. Default false (steer, lands at the next turn boundary). Only affects one-way messages — reply-requested (expectReply) messages always pivot via follow-up so the agent answers cleanly. Use followUp only when the message must not interrupt in-flight work.',
				}),
			),
			requireOnline: Type.Optional(
				Type.Boolean({
					description:
						"Fail (throw) instead of queueing when the target peer is offline — for handoffs that must not be silently swallowed by a dead peer. Default false (queue and deliver when the peer returns).",
				}),
			),
		}),
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			ensureReady(ctx);
			const expectReply = params.expectReply ?? false;
			const deliverAs = params.followUp ? "followUp" : "steer";
			if (params.to === "*") {
				const targets = listPeers(state.mailbox).filter(
					(p) => p.online && p.name !== state.peerName,
				);
				if (params.requireOnline && targets.length === 0) {
					throw new Error("peer_send: no online peers to broadcast to (requireOnline set) — not queued");
				}
				for (const t of targets) {
					sendEnvelope(state.mailbox, newEnvelope(state.peerName, t.name, params.message, expectReply, undefined, deliverAs));
				}
				return {
					content: [
						{ type: "text", text: `Broadcast sent to ${targets.length} online peer(s).` },
					],
					details: { broadcast: true, recipients: targets.map((t) => t.name) },
				};
			}
			let to: string;
			try {
				to = sanitizePeerName(params.to);
			} catch (err) {
				throw new Error(`peer_send: ${(err as Error).message}`);
			}
			const listed = listPeers(state.mailbox);
			to = resolvePeerAddressAmong(listed, to);
			const decision = deliveryDecision(to, listed, params.requireOnline ?? false);
			if (!decision.ok) throw new Error(`peer_send: ${decision.reason}`);
			sendEnvelope(state.mailbox, newEnvelope(state.peerName, to, params.message, expectReply, undefined, deliverAs));
			return {
				content: [
					{
						type: "text",
						text: `Message sent to peer "${to}" (${queuedStatus(decision)}).`,
					},
				],
				details: { to, online: decision.online, expectReply },
			};
		},
	});

	// ── commands (human) ────────────────────────────────────────────────────

	pi.registerCommand("peers", {
		description: "List peer pi sessions and this session's peer identity",
		handler: async (_args, ctx) => {
			ensureReady(ctx);
			const peers = listPeers(state.mailbox);
			const lines = [
				`self: ${state.peerName} (auto-reply ${state.autoreply ? "on" : "off"})`,
				...(peers.length === 0
					? ["no peers found yet"]
					: peers.map((p) => `${peerGlyph(p)} ${p.name}${p.online ? "" : ` (${peerStatus(p)})`}`)),
			];
			ctx.ui.notify(lines.join("\n"), "info");
		},
	});

	pi.registerCommand("peer-send", {
		description: "Send a message to a peer session: /peer-send [--reply] [--followup] <name> <text>",
		getArgumentCompletions: (prefix: string) => {
			const names = listPeers(state.mailbox).map((p) => p.name);
			if (prefix.length === 0) {
				return names.map((n) => ({ value: n, label: n }));
			}
			return names.filter((n) => n.startsWith(prefix)).map((n) => ({ value: n, label: n }));
		},
		handler: async (args, ctx) => {
			ensureReady(ctx);
			let expectReply = false;
			let followUp = false;
			let rest = args.trim();
			// Leading flags, any order.
			while (true) {
				const head = rest.split(/\s+/, 1)[0];
				if (head === "--reply") {
					expectReply = true;
				} else if (head === "--followup") {
					followUp = true;
				} else {
					break;
				}
				rest = rest.slice(head.length).trim();
			}
			const match = rest.match(/^(\S+)\s+([\s\S]+)$/);
			if (!match) {
				ctx.ui.notify("Usage: /peer-send [--reply] [--followup] <name> <text>", "warning");
				return;
			}
			let to: string;
			try {
				to = sanitizePeerName(match[1]);
			} catch (err) {
				ctx.ui.notify((err as Error).message, "error");
				return;
			}
			const deliverAs = followUp ? "followUp" : "steer";
			const listed = listPeers(state.mailbox);
			to = resolvePeerAddressAmong(listed, to);
			const decision = deliveryDecision(to, listed, false);
			if (!decision.ok) {
				ctx.ui.notify(decision.reason, "error");
				return;
			}
			sendEnvelope(state.mailbox, newEnvelope(state.peerName, to, match[2].trim(), expectReply, undefined, deliverAs));
			ctx.ui.notify(`Sent to ${to} (${queuedStatus(decision)})${expectReply ? " (reply)" : ""}${followUp ? " (follow-up)" : ""}`, "info");
		},
	});

	pi.registerCommand("peer-autoreply", {
		description: "Toggle automatic replies to peer messages: /peer-autoreply [on|off]",
		handler: async (args, ctx) => {
			ensureReady(ctx);
			const value = args.trim().toLowerCase();
			if (value === "on") state.autoreply = true;
			else if (value === "off") state.autoreply = false;
			else if (value === "") state.autoreply = !state.autoreply;
			else {
				ctx.ui.notify("Usage: /peer-autoreply [on|off]", "warning");
				return;
			}
			publishHeartbeat(); // heartbeat carries the flag; persist immediately
			ctx.ui.notify(`Auto-reply ${state.autoreply ? "ON" : "OFF"}`, "info");
		},
	});
}
