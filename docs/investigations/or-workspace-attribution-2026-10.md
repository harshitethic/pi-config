# OpenRouter workspace traffic attribution (2026-09-28 → 10-21)

Investigation: scout-code `ddec7711`, 2026-10-22. Follow-up to the ledger sweep (`prompt_tokens` = total incl. cache). Keys cited by label + tail only.

## Findings

**1. Key attribution is exact — everything is the `pi key (macbook)` (`sk-or-v1-e21…914`).**
`/api/v1/activity` accepts an undocumented `api_key_hash` filter. All 100 rows / $81.12 in the window are the pi key; `copilot`, `opencode`, `key for opencode` have **0 rows** (`last_used_at` 2026-07-04 / 2026-04-11 / 2026-04-21, `usage_daily/weekly/monthly = 0`). pi-key monthly reconciles: $79.22 = $77.46 (Oct 1–21) + $1.77 (10-22).

**2. The `deepseek/deepseek-v4.1-flash` $65.99 is expected pre-migration fleet traffic — not the drift bug, not a non-pi client.**
Local pi session logs (`~/.pi/agent/sessions/**` assistant `provider`/`model`) match the activity rows day by day (10-06: 4,096 local turns vs 5,672 requests; 10-07: 8,328/8,921; 10-16: 4,337/4,417; 10-17: 2,575/2,584; 10-18: 439/439; 10-19…21: 0/0). Decision `036-fleet-opencode-go` (2026-10-18) moved DeepSeek seats off OpenRouter; local `model_change` events flip on 10-18/19. The known drift bug (bare `FLEET_MODEL` fallback, fixed `4b91aea`, "observed: 458 requests") is only the 10-18 tail — **zero v4.1 OpenRouter requests after 10-18** despite ~21k local `opencode-go` turns on 10-19/21, so the drift did not recur.

**3. The gemini-image rows are the owner's own script.** `~/Developer/skunkworks/platformer/tools/gen.py` calls `google/gemini-3.1-flash-lite-image` with `$OPENROUTER_API_KEY` (= the pi key); `raw/*.png` mtimes 10-17 19:42–19:44 match 8 req / $0.27.

**4. Client inventory (this machine).** `opencode (macbook)` key lives in `~/.local/share/opencode/auth.json`; opencode is dormant (newest DB session 2026-07-07 — the 2 GB DB's *mtime* is today, its content is not). `copilot` / `key for opencode` holders not found — superseded credentials. VS Code has an OpenRouter BYOM provider (`state.vscdb`) dormant since 2026-07-29. No AI daemons (launchctl/login items clean). `smart-suggestion` targets `deepseek/deepseek-v4-flash-0731` — **zero `-0731` rows in the ledger**, not billing.

**5. Residual unexplained on the pi key: ~$2.4 — the owner's actual worry.** After matching every local session and script, no local producer exists for:
- `deepseek/deepseek-v4-flash` (0423): all 5,424 req / $1.75, incl. **2,297 req on 10-21**. Only local code naming the slug: the `model-benchmarking` runner (last run Aug 7) and stale defaults in `extensions/subagent/_index.ts.off` / tests.
- `xiaomi/mimo-v2.6-flash` post-10-18: 230 req / $0.09 (16 on 10-19, **214 on 10-21**) — uniform ~13.9k prompt / 11–16 output across all 5 endpoints: probe/health-check shape, not reviewer verdicts.
- `deepseek/deepseek-v4.1-flash-1017` post-10-18: 32 req / $0.55 — 57–77k prompt / 5–7k output = manual main-session shape, but no local session file for those days.

Most likely: **another machine sharing the `pi-openrouter` key** (`~/.ssh/known_hosts` has `192.168.1.120`, `[192.168.1.122]:2222`) or `--no-session`/benchmark runs. Inference from exhaustion, not observed. Settling evidence: the other box's `~/.pi/agent/sessions` for 10-19/20/21 — or per-machine keys so `/activity?api_key_hash=…` answers it directly.

> **Superseded 2026-10-22 (later trace, scout-code on the owner's hypothesis):** it is our own
> **test suite**, not a machine. Live-network tests bill real calls and are structurally invisible
> to session logs: `tests/e2e-checkpoint.test.ts:233,240` + `tests/peer-link.test.ts:447-474` run
> real SDK sessions on `deepseek/deepseek-v4-flash` (0423) with `auth.json` credentials through
> `SessionManager.inMemory` (never persisted), ~20–30 0423 requests per full `bun test` run
> (in-test compaction rides the same model — the `compaction-model.ts` extension is not loaded in
> that harness); `tests/subagent-model-inheritance.test.ts:173-236` spawns the real `pi` binary
> with a one-turn "Reply with the single word: ok" task on an unpinned `openrouter/xiaomi/mimo-v2.6-flash`
> orchestrator seat (~13.9k fixed system prompt / ~12 out — exactly the ledger's uniform row), and
> `afterEach` deletes the child transcript. 2,297 calls on 10-21 ≈ ~100 suite runs on the heavy
> load-flake debugging day. The "stale defaults in tests" label above was wrong: two of those tests
> run the slug against the network on every full suite run. Residual uncertainty: the mimo rows may
> also include an external probe (`~/Developer/tfd-bench/benchmark.py`; `docs/thinking-levels.md`
> documents a manual two-request caching probe) — an `/activity` diff around one `bun test
> tests/subagent-model-inheritance.test.ts` run settles it. Attribution lesson: test-spawned LLM
> calls need labelling; transcript cleanup + in-memory sessions defeat session-log forensics.

## Notes

- `~/Developer/pi-config-triage/settings.json` still has pre-036 `defaultProvider: openrouter` / `deepseek/deepseek-v4.1-flash` — a stale checkout that bills OpenRouter if run without `/model`.
- `~/.pi/agent/settings.json` defaulting to OpenRouter is intentional (036: main session is owner-managed) but any *unattended* pi launch bills the pi key.

## Limitations

- Key-to-client for `copilot` / `key for opencode` unproven (no local file holds those values; Keychain not unwrapped).
- Whether VS Code's secret-backed key is the pi key unknown — it had no activity regardless.
- If `/activity` silently caps at 100 rows, pre-09-28 rows are unseen; the monthly reconciliation argues against.
