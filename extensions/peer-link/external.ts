#!/usr/bin/env bun
/**
 * External peer CLI: lets a non-pi tool (a Claude Code session) join the
 * peer-link mailbox. Not a pi extension — pi loads only peer-link/index.ts.
 *
 * Driven by Claude Code hooks (stdin = hook input JSON):
 *   external.ts hook session-start   register `claude-<session_id>`; print identity + usage
 *   external.ts hook prompt          refresh registration; print pending mail; record it inflight
 *   external.ts hook stop            ack what the completed turn carried (bookkeeping only)
 *   external.ts hook session-end     unregister
 * And by the session itself:
 *   external.ts send --from <name> [--reply] [--require-online] <to> <text | ->
 *   external.ts list
 *
 * Mail is read only inside a hook the user's prompt fired, so nothing here
 * starts a Claude turn. Why that matters: docs/design/peer-link-external.md.
 * Delivery is at-least-once: envelopes are acked only by the Stop hook, after
 * a turn that carried them completed; an aborted prompt leaves them in the
 * inbox and the next prompt re-emits them (duplicates over loss).
 */

import * as fs from "node:fs";
import * as path from "node:path";
import {
	type Envelope,
	ackEnvelope,
	deliveryDecision,
	ensureMailbox,
	listPeers,
	mailboxRoot,
	newEnvelope,
	peerStatus,
	queuedStatus,
	readIncoming,
	removeHeartbeat,
	resolvePeerAddressAmong,
	sanitizePeerName,
	sendEnvelope,
	writeHeartbeat,
} from "./mailbox.ts";

const SELF = process.argv[1];

interface HookInput {
	session_id: string;
	cwd?: string;
	hook_event_name?: string;
}

function readStdin(): string {
	return fs.readFileSync(0, "utf8");
}

function hookInput(): HookInput {
	const input = JSON.parse(readStdin()) as HookInput;
	if (typeof input.session_id !== "string" || !input.session_id) {
		throw new Error("hook input has no session_id");
	}
	return input;
}

export function externalName(sessionId: string): string {
	return sanitizePeerName(`claude-${sessionId}`);
}

function register(mailbox: string, name: string, cwd: string | undefined): void {
	ensureMailbox(mailbox, name);
	writeHeartbeat(mailbox, { name, cwd, ts: Date.now(), external: true });
}

function emitContext(event: string, text: string): void {
	process.stdout.write(
		JSON.stringify({ hookSpecificOutput: { hookEventName: event, additionalContext: text } }),
	);
}

/** Render pending envelopes as prompt context. Exported for tests. */
export function renderMail(self: string, envelopes: Envelope[]): string {
	const blocks = envelopes
		.sort((a, b) => a.sentAt - b.sentAt)
		.map((e) => {
			const reply = e.expectReply
				? `\n(${e.from} asked for a reply: send one with \`${sendUsage(self, e.from)}\`)`
				: "";
			const re = e.inReplyTo ? ` (reply to ${e.inReplyTo})` : "";
			return `[peer:${e.from}]${re} ${e.text}${reply}`;
		});
	return `peer-link mail for ${self} (${envelopes.length}):\n\n${blocks.join("\n\n")}`;
}

function sendUsage(self: string, to = "<peer>"): string {
	return `bun ${SELF} send --from ${self} ${to} '<text>'`;
}

// ── inflight state ─────────────────────────────────────────────────────────
//
// The prompt hook records which envelopes the just-submitted prompt carries;
// the Stop hook acks exactly that set (the turn completed, so its context —
// which carried the mail — was consumed). Envelopes are otherwise left in the
// inbox until acked, so an aborted prompt loses nothing: the next prompt
// re-emits whatever is un-acked. Crash-safety falls out of the same rule —
// a lost inflight file means re-emission (duplicate), never loss.

function inflightPath(mailbox: string, name: string): string {
	return path.join(mailbox, "inflight", `${name}.json`);
}

function markInflight(mailbox: string, name: string, envelopes: Envelope[]): void {
	const p = inflightPath(mailbox, name);
	fs.mkdirSync(path.dirname(p), { recursive: true });
	fs.writeFileSync(p, JSON.stringify(envelopes));
}

function ackInflight(mailbox: string, name: string): void {
	let carried: Envelope[] = [];
	try {
		carried = JSON.parse(fs.readFileSync(inflightPath(mailbox, name), "utf8")) as Envelope[];
	} catch {
		return; // nothing inflight (or unreadable state) — nothing to ack
	}
	try {
		fs.unlinkSync(inflightPath(mailbox, name));
	} catch {
		// already gone; acks below are idempotent
	}
	for (const env of carried) ackEnvelope(mailbox, name, env);
}

function hook(event: string): void {
	const input = hookInput();
	const mailbox = mailboxRoot();
	const self = externalName(input.session_id);
	switch (event) {
		case "session-start":
			register(mailbox, self, input.cwd);
			emitContext(
				"SessionStart",
				`peer-link: this session is external peer \`${self}\`. pi peers can message it; ` +
					"their mail is added to the user's next prompt. " +
					`Send: \`${sendUsage(self)}\` (text \`-\` reads stdin; \`--reply\` asks for an answer; ` +
					"`--require-online` fails instead of queueing). " +
					`List peers: \`bun ${SELF} list\`.`,
			);
			return;
		case "prompt": {
			register(mailbox, self, input.cwd);
			const envelopes = readIncoming(mailbox, self);
			if (envelopes.length === 0) return;
			emitContext("UserPromptSubmit", renderMail(self, envelopes));
			// At-least-once: no ack here — the prompt can be aborted before the turn
			// consumes this context (mail loss bug, 2026-10-18). The Stop hook acks
			// what a completed turn carried; un-acked mail is re-emitted next prompt.
			markInflight(mailbox, self, envelopes);
			return;
		}
		case "stop":
			// Bookkeeping only: acks files, starts no turn (ToS invariants hold).
			ackInflight(mailbox, self);
			return;
		case "session-end":
			removeHeartbeat(mailbox, self);
			return;
		default:
			throw new Error(`unknown hook event "${event}"`);
	}
}

function send(args: string[]): void {
	let from: string | undefined;
	let expectReply = false;
	let requireOnline = false;
	const rest: string[] = [];
	for (let i = 0; i < args.length; i++) {
		const a = args[i];
		if (a === "--from") from = args[++i];
		else if (a === "--reply") expectReply = true;
		else if (a === "--require-online") requireOnline = true;
		else rest.push(a);
	}
	if (!from || rest.length < 2) {
		throw new Error("usage: send --from <name> [--reply] [--require-online] <to> <text | ->");
	}
	from = sanitizePeerName(from);
	const text = rest[1] === "-" && rest.length === 2 ? readStdin().trim() : rest.slice(1).join(" ");
	if (!text) throw new Error("send: empty message");
	const mailbox = mailboxRoot();
	const listed = listPeers(mailbox);
	if (!listed.some((p) => p.name === from && p.external)) {
		throw new Error(`send: "${from}" is not a registered external peer (did the SessionStart hook run?)`);
	}
	const to = resolvePeerAddressAmong(listed, sanitizePeerName(rest[0]));
	const decision = deliveryDecision(to, listed, requireOnline);
	if (!decision.ok) throw new Error(`send: ${decision.reason}`);
	sendEnvelope(mailbox, newEnvelope(from, to, text, expectReply));
	console.log(`sent to ${to} (${queuedStatus(decision)})`);
}

function list(): void {
	const peers = listPeers(mailboxRoot());
	if (peers.length === 0) console.log("no peers listed");
	for (const p of peers) {
		console.log(`${p.name} (${peerStatus(p)})${p.cwd ? ` — ${p.cwd}` : ""}`);
	}
}

if (import.meta.main) {
	const [cmd, ...args] = process.argv.slice(2);
	try {
		if (cmd === "hook") hook(args[0]);
		else if (cmd === "send") send(args);
		else if (cmd === "list") list();
		else throw new Error("usage: external.ts <hook <event> | send … | list>");
	} catch (err) {
		console.error(`peer-link external: ${(err as Error).message}`);
		process.exit(1);
	}
}
