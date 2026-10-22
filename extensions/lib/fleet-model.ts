/**
 * Fleet model — the one model every subagent seat and compaction runs.
 *
 * The DeepSeek fleet rides the OpenCode Go plan quota (decision 036, owner
 * 2026-10-18) — V4.1 Flash is the plan's most usage-generous SKU ($80/mo on Go,
 * $160 on Go Plus). Agent frontmatter carries the per-seat model + effort
 * level; this constant is the fallback for spawns whose agent has no `model:`
 * frontmatter and the target for the compaction override. Pure module (node
 * builtins only) so tests can import it directly.
 */

export const FLEET_PROVIDER = "opencode-go"

export const FLEET_MODEL = "deepseek-v4.1-flash"

/**
 * The seat as one provider-qualified spec — what `--model` takes. A spawn that
 * falls back to the fleet seat passes this, not the bare id: a bare id resolves
 * against whatever provider the session defaults to, which is how unpinned
 * routes pick up traffic (owner ruling 2026-10-22).
 */
export const FLEET_MODEL_SPEC = `${FLEET_PROVIDER}/${FLEET_MODEL}`
