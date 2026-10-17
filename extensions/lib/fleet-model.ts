/**
 * Fleet model — the one model every subagent seat and compaction runs.
 *
 * OpenRouter-only since the z.ai seat was dropped (decision 022). Agent
 * frontmatter carries the per-seat model + effort level; this constant is the
 * fallback for spawns whose agent has no `model:` frontmatter and the target
 * for the compaction override. Pure module (node builtins only) so tests can
 * import it directly.
 */

export const FLEET_PROVIDER = "openrouter"

export const FLEET_MODEL = "deepseek/deepseek-v4.1-flash-1017"
