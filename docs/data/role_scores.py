#!/usr/bin/env python3
"""Combined role-fit scores (Orchestrator / Implementer / Oracle / Reviewer) for
frontier OpenRouter models, plus a cost score. Reads docs/data/benchlm_snapshot.json
(see fetch_benchlm.py) + the manual framia dict below for LiveCodeBench and IMO/HMMT,
which BenchLM does not track for DeepSeek.

Model rows include thinking-level variants where BenchLM publishes them
(DeepSeek rows: High/Max).

Benchmark weights follow the 2026-10-18 integrity review (decision
model-tiers/002): SWE-bench Verified dropped (OpenAI abandoned it — ~59% flawed
tests, contaminated); SWE-bench Pro kept at reduced weight (verifier
false-negatives ~24-32%, git-history gold-commit exploit inflates some rows);
Terminal-Bench scored at 4.0 (2.x is stale and cross-version incomparable);
DeepSWE added at full weight (verifier-hardened, 1.1% false-negatives);
AIME (saturated), Codeforces (Elo not cross-vendor comparable, arXiv 2602.05891)
and GPQA (AA retired it in v4.2) are informational columns only, no composite
weight. AA indices are used within one index version (v4.3.2), never across.

Normalization: well-covered benchmarks -> min-max WITHIN the scored set (mode 'mm');
sparsely-reported benchmarks (IFBench, LiveCodeBench) -> raw %/100 ('raw') to avoid
tiny-sample min-max artifacts. Oracle uses a raw weighted-% composite. Cost = blended
$/M at 95/5 I/O + 98% cache. Missing data -> confidence flag.

Run: python3 docs/data/role_scores.py   (needs benchlm_snapshot.json)
"""
import json, os

HERE = os.path.dirname(os.path.abspath(__file__))
SNAP = os.path.join(HERE, "benchlm_snapshot.json")
if not os.path.exists(SNAP):
    raise SystemExit(f"{SNAP} missing — run `python3 docs/data/fetch_benchlm.py` first")
S = json.load(open(SNAP))
BL = {k: v["scores"] for k, v in S["benchlm"].items()}
OR_AA = S["openrouter_aa"]
OR_MODELS = S["openrouter_models"]

CACHE_HIT = 0.98
IN_RATIO = 0.95
OUT_RATIO = 0.05  # <-- I/O ratio knob

# ---- Manual framia dict (BenchLM does not track these for DeepSeek) ----
LCB = {"DeepSeek V4 Pro": 93.5, "DeepSeek V4 Flash": 91.6, "Qwen3.7 Max": 91.6}
HARDMATH = {"DeepSeek V4 Pro": 89.8, "DeepSeek V4 Flash": 88.4}
# AIME is on BenchLM (aime26) — GLM-5.2 99.2, Kimi K2.6 96.4, GLM-5.1 95.3.

# ---- Model registry: (name, lab, benchlm display name, openrouter model id, ctx_K, multimodal) ----
# benchlm display name None = no BenchLM rows (0731, Nex-N2-Pro).
REG = [
    ("Claude Fable 5", "Anthropic", "Claude Fable 5", "anthropic/claude-fable-5", 1000, True),
    ("GPT-5.6 Sol", "OpenAI", "GPT-5.6 Sol", "openai/gpt-5.6-sol", 1050, True),
    ("GPT-5.6 Terra", "OpenAI", "GPT-5.6 Terra", "openai/gpt-5.6-terra", 1050, True),
    ("GPT-5.5", "OpenAI", "GPT-5.5", "openai/gpt-5.5", 1050, True),
    ("Grok 4.5", "xAI", "Grok 4.5", "x-ai/grok-4.5", 500, True),
    ("Claude Opus 4.8", "Anthropic", "Claude Opus 4.8", "anthropic/claude-opus-4.8", 1000, True),
    ("Claude Opus 4.7", "Anthropic", "Claude Opus 4.7", "anthropic/claude-opus-4.7", 1000, True),
    ("Claude Sonnet 5", "Anthropic", "Claude Sonnet 5", "anthropic/claude-sonnet-5", 1000, True),
    ("GPT-5.4", "OpenAI", "GPT-5.4", "openai/gpt-5.4", 1050, True),
    ("GPT-5.6 Luna", "OpenAI", "GPT-5.6 Luna", "openai/gpt-5.6-luna", 1050, True),
    ("GLM-5.2", "Zhipu", "GLM-5.2", "z-ai/glm-5.2", 1048, False),
    ("Gemini 3.5 Flash", "Google", "Gemini 3.5 Flash", "google/gemini-3.5-flash", 1048, True),
    ("Claude Sonnet 4.6", "Anthropic", "Claude Sonnet 4.6", "anthropic/claude-sonnet-4.6", 1000, True),
    ("Gemini 3.1 Pro", "Google", "Gemini 3.1 Pro", "google/gemini-3.1-pro-preview", 1048, True),
    ("Qwen3.7 Max", "Alibaba", "Qwen3.7 Max", "qwen/qwen3.7-max", 1000, False),
    ("MiniMax-M3", "MiniMax", "MiniMax M3", "minimax/minimax-m3", 1048, True),
    ("DeepSeek V4 Pro", "DeepSeek", "DeepSeek V4 Pro", "deepseek/deepseek-v4-pro", 1048, False),
    ("Kimi K2.6", "Moonshot", "Kimi K2.6", "moonshotai/kimi-k2.6", 262, True),
    ("MiMo-V2.5-Pro", "Xiaomi", "MiMo-V2.5-Pro", "xiaomi/mimo-v2.5-pro", 1048, False),
    ("Kimi K2.7 Code", "Moonshot", "Kimi K2.7 Code", "moonshotai/kimi-k2.7-code", 262, True),
    ("Hy3", "Tencent", "Hy3", "tencent/hy3", 262, False),
    ("Nex-N2-Pro", "NexAGI", None, "nex-agi/nex-n2-pro", 262, True),
    ("DeepSeek V4 Flash", "DeepSeek", "DeepSeek V4 Flash", "deepseek/deepseek-v4-flash", 1048, False),
    ("GLM-5.1", "Zhipu", "GLM-5.1", "z-ai/glm-5.1", 202, False),
    ("GPT-5.4 mini", "OpenAI", "GPT-5.4 mini", "openai/gpt-5.4-mini", 400, True),
    ("Qwen3.7 Plus", "Alibaba", "Qwen3.7 Plus", "qwen/qwen3.7-plus", 1000, True),
    ("GPT-5.4 nano", "OpenAI", "GPT-5.4 nano", "openai/gpt-5.4-nano", 400, True),
    ("MiMo-V2.5", "Xiaomi", "MiMo-V2.5", "xiaomi/mimo-v2.5", 1048, True),
    ("Kimi K3", "Moonshot", "Kimi K3", "moonshotai/kimi-k3", 1048, True),
    # 2026-10-18 integrity review: OpenCode Go menu SKUs added (decision model-tiers/002).
    ("GLM-5.3", "Zhipu", "GLM-5.3", "z-ai/glm-5.3", 1048, False),
    ("GLM-5.3-Flash", "Zhipu", "GLM-5.3-Flash", "z-ai/glm-5.3-flash", 1048, False),
    ("MiMo-V2.6-Flash", "Xiaomi", "MiMo-V2.6-Flash", "xiaomi/mimo-v2.6-flash", 1048, False),
    ("MiMo-V2.6-Pro", "Xiaomi", "MiMo-V2.6-Pro", "xiaomi/mimo-v2.6-pro", 1048, False),
    ("DeepSeek V4.1 Flash 1017", "DeepSeek", "DeepSeek V4.1 Flash 1017", "deepseek/deepseek-v4.1-flash-1017", 1048, False),
    ("GPT-6 Luna", "OpenAI", "GPT-6 Luna", "openai/gpt-6-luna", 1050, True),
    ("Gemini 4 Argon", "Google", "Gemini 4 Argon", "google/gemini-4-argon", 1048, True),
    ("Grok 4.7", "xAI", "Grok 4.7", "x-ai/grok-4.7", 1048, True),
    ("Qwen3.8 Max", "Alibaba", "Qwen3.8 Max Preview", "qwen/qwen3.8-max-0902", 1000, False),
    ("Qwen3.8 Flash", "Alibaba", "Qwen3.8-Flash-Next", "qwen/qwen3.8-flash", 1048, True),
    ("Step 5 Preview", "StepFun", "Step 5 Preview", "stepfun/step-5-preview", 1048, True),
    ("Muse Spark 1.3", "Meta", "Muse Spark 1.3", "meta/muse-spark-1.3-contributor", 1048, True),
    ("Claude Haiku 5.5", "Anthropic", "Claude Haiku 5.5", "anthropic/claude-haiku-5.5", 1000, True),
    # 2026-07-31 checkpoint — BenchLM not yet ingested; granular benchmarks pending.
    ("DeepSeek V4 Flash 0731", "DeepSeek", None, "deepseek/deepseek-v4-flash-0731", 1048, False),
]

# ---- Rows: expand variants for models BenchLM splits (High/Max); drop the base
# row when a High variant exists — the fleet runs DeepSeek at `high`, so base
# (no thinking level) is never used and min-max normalization turns it to noise.
ROWS = []  # (rowkey, variant, benchlm name, or model id)
for name, lab, bl_name, or_id, ctx, mm in REG:
    if bl_name and f"{bl_name} (High)" in BL["aa_int"]:
        for v in ("(High)", "(Max)"):
            ROWS.append((f"{name} {v}", v, f"{bl_name} {v}", or_id))
    else:
        ROWS.append((name, "base", bl_name, or_id))

def bench_val(page, benchlm_name):
    return BL[page].get(benchlm_name) if benchlm_name else None

AA_KEY = {"aa_int": "intel", "aa_coding": "coding", "aa_agentic": "agentic"}

def aa_val(row, page, fallback_slug=None):
    v = bench_val(page, row[2])
    if v is not None:
        return v
    if fallback_slug and fallback_slug in OR_AA:
        return OR_AA[fallback_slug][AA_KEY[page]]
    return None

# Map or_model_id -> AA slug from OpenRouter (canonical slugs match /benchmarks keys)
OR_ID_TO_SLUG = {mid: m.get("canonical_slug") for mid, m in OR_MODELS.items()}

def row_data(row):
    rk, variant, bl_name, or_id = row
    slug = OR_ID_TO_SLUG.get(or_id)
    def g(page):
        v = bench_val(page, bl_name)
        if v is not None:
            return v, True
        if slug and slug in OR_AA:
            return OR_AA[slug][AA_KEY[page]], True
        return None, False
    aa_int, _ = g("aa_int")
    aa_cod, _ = g("aa_coding")
    aa_agt, _ = g("aa_agentic")
    d = {
        "aa_int": aa_int, "aa_cod": aa_cod, "aa_agt": aa_agt,
        "swe_pro": bench_val("swe_pro", bl_name),
        "deepswe": bench_val("deepswe", bl_name),
        "tb4": bench_val("tb4", bl_name),
        "lcr": bench_val("aa_lcr", bl_name),
        "ifbench": bench_val("aa_ifbench", bl_name),
        "aime": bench_val("aime26", bl_name),
        "codeforces": bench_val("codeforces", bl_name),
        "gpqa": bench_val("gpqa_d", bl_name),
        "omni_acc": bench_val("omni_acc", bl_name),
        "omni_halluc": bench_val("omni_halluc", bl_name),
    }
    base = rk.split(" (")[0]
    d["lcb"] = LCB.get(base)
    d["hardmath"] = HARDMATH.get(base)
    return d

DATA = {rk: row_data(row) for row in ROWS for rk in [row[0]]}

def name_of(rowkey):
    return rowkey

REG_BY_BASE = {r[0]: r for r in REG}
LAB = {rk: REG_BY_BASE[rk.split(" (")[0]][1] for rk in DATA}
CTX = {rk: next(r[4] for r in REG if r[0] == rk.split(" (")[0]) for rk in DATA}
MM = {rk: next(r[5] for r in REG if r[0] == rk.split(" (")[0]) for rk in DATA}

def cost_per_M(rk):
    or_id = next(r[3] for r in ROWS if r[0] == rk)
    m = OR_MODELS.get(or_id)
    if not m or not m.get("prompt"):
        return None  # not on OpenRouter (Go-exclusive SKU) or no published price
    pr, cr, co = (float(m["prompt"]), float(m["cache_read"] or 0), float(m["completion"]))
    eff = (0.02 * pr + CACHE_HIT * cr) if cr > 0 else pr
    return (eff * IN_RATIO + co * OUT_RATIO) * 1e6

COST = {rk: cost_per_M(rk) for rk in DATA}

# Value-tier membership FIXED (cost-conscious set, flagships excluded).
EXCLUDE = {"Claude Fable 5", "GPT-5.6 Sol", "Claude Opus 4.8", "GPT-5.6 Terra", "GPT-5.5",
 "Claude Opus 4.7", "Claude Sonnet 5", "GPT-5.4", "Gemini 3.1 Pro", "Claude Sonnet 4.6", "Kimi K3",
 "Gemini 4 Argon", "GPT-6 Luna", "Muse Spark 1.3"}
VALUE = [rk for rk in DATA if rk.split(" (")[0] not in EXCLUDE]

# OpenCode Go menu: SKUs purchasable on the Go plan (2026-10-18 table).
GO_MENU = ["GLM-5.3-Flash", "GLM-5.3", "GLM-5.2", "Kimi K3", "Kimi K2.7 Code",
 "Step 5 Preview", "MiMo-V2.6-Flash", "MiMo-V2.6-Pro", "MiMo-V2.5-Pro",
 "Muse Spark 1.3", "Qwen3.8 Max", "Qwen3.8 Flash", "Qwen3.7 Plus", "DeepSeek V4.1 Flash 1017",
 "DeepSeek V4 Pro (High)", "Hy3", "Grok 4.7", "GPT-6 Luna", "GPT-5.6 Luna", "Claude Haiku 5.5",
 "Gemini 4 Argon", "MiniMax-M3"]

# ---- Role weights (2026-10-18 integrity review; supersede the pre-review weights) ----
# SWE-bench Pro discounted (verifier FN ~24-32%, git-history exploit); swe_ver dropped;
# tb2 -> tb4; DeepSWE added; AIME/Codeforces/GPQA informational only.
MINMAX_ROLES = {
 "Orchestrator": [("lcr", 5, "mm"), ("aa_int", 5, "mm"), ("ifbench", 4, "raw"), ("tb4", 4, "mm"),
                  ("swe_pro", 2, "mm"), ("aa_agt", 3, "mm")],
 "Implementer": [("deepswe", 5, "mm"), ("swe_pro", 3, "mm"), ("lcb", 5, "raw"), ("aa_cod", 4, "mm"),
                 ("tb4", 3, "mm"), ("ifbench", 2, "raw")],
 "Review-Code": [("aa_cod", 5, "mm"), ("aa_int", 4, "mm"), ("ifbench", 4, "raw"), ("lcr", 3, "mm"),
                 ("swe_pro", 2, "mm")],
 "Review-Tests": [("aa_int", 5, "mm"), ("ifbench", 4, "raw"), ("lcr", 4, "mm"), ("aa_cod", 3, "mm"),
                  ("swe_pro", 2, "mm")],
}
GRANULAR = {"Orchestrator": ["lcr", "tb4", "swe_pro", "ifbench"],
            "Implementer": ["swe_pro", "deepswe", "tb4", "lcb"],
            "Review-Code": ["lcr", "swe_pro", "ifbench"],
            "Review-Tests": ["lcr", "swe_pro", "ifbench"]}
ORACLE_W = [("lcb", 5), ("hardmath", 4)]  # aime/codeforces/gpqa: informational only (2026-10-18)
LAB_SRC = {rk: LAB[rk] for rk in DATA}
IMPL_LAB = "DeepSeek"

def minmax(key, subset):
    vals = [DATA[r][key] for r in subset if DATA[r].get(key) is not None]
    if not vals:
        return {r: None for r in subset}
    lo, hi = min(vals), max(vals)
    rng = hi - lo or 1.0
    return {r: (None if DATA[r].get(key) is None else (DATA[r][key] - lo) / rng) for r in subset}

def score_role(bmks, subset):
    norm = []
    for key, w, mode in bmks:
        nb = minmax(key, subset) if mode == "mm" else \
             {r: (None if DATA[r].get(key) is None else DATA[r][key] / 100.0) for r in subset}
        norm.append((nb, w))
    out = {}
    for r in subset:
        num = den = 0.0
        for nb, w in norm:
            if nb[r] is not None:
                num += nb[r] * w
                den += w
        out[r] = (num / den * 100 if den else None)
    return out

def score_oracle(subset):
    out = {}
    for r in subset:
        num = den = 0.0
        for key, w in ORACLE_W:
            v = DATA[r].get(key)
            if v is not None:
                num += v * w
                den += w
        out[r] = (num / den if den else None)
    return out

def conf_oi(r, role):
    g = GRANULAR[role]
    present = sum(1 for b in g if DATA[r].get(b) is not None)
    total = len(g)
    if present == 0:
        return f"proxy (0/{total})"
    if present <= total // 3:
        return f"partial ({present}/{total})"
    return f"solid ({present}/{total})"

def conf_oracle(r):
    if DATA[r].get("lcb") is not None or DATA[r].get("hardmath") is not None:
        return "solid (hard/algo)"
    if DATA[r].get("aime") is not None:
        return "aime-only"
    return "proxy (0 math/algo)"

def compute(subset):
    r = {role: score_role(b, subset) for role, b in MINMAX_ROLES.items()}
    r["Oracle"] = score_oracle(subset)
    return r

VRES = compute(VALUE)
FRES = compute([rk for rk in DATA])

def f(x):
    return f"{x:6.1f}" if x is not None else "   -- "

def table(res, subset, title):
    print(f"\n=== {title} ===")
    print(f"{'MODEL':<26}{'ORCH':>7}{'IMPL':>7}{'ORAC':>7}{'$/M':>7}  {'ctx':>5}  conf(orch/impl/oracle)")
    for rk in sorted(subset, key=lambda r: -(res['Orchestrator'][r] or -1)):
        cost = COST[rk]
        cs = f"{cost:>7.3f}" if cost is not None else "    -- "
        print(f"{rk:<26}{f(res['Orchestrator'][rk]):>7}{f(res['Implementer'][rk]):>7}"
              f"{f(res['Oracle'][rk]):>7}{cs}  {CTX[rk]:>4}K  "
              f"{conf_oi(rk,'Orchestrator')} | {conf_oi(rk,'Implementer')} | {conf_oracle(rk)}")

def oracle_detail(subset):
    print(f"\n=== ORACLE math/algo detail (value tier) ===")
    print(f"{'MODEL':<26}{'LCB':>6}{'IMO/HMMT':>9}{'AIME':>6}{'CForces':>8}{'SCORE':>7}  conf")
    sc = score_oracle(subset)
    for rk in sorted([x for x in subset if sc[x] is not None], key=lambda r: -sc[r]):
        print(f"{rk:<26}{f(DATA[rk].get('lcb')):>6}{f(DATA[rk].get('hardmath')):>9}"
              f"{f(DATA[rk].get('aime')):>6}{str(DATA[rk].get('codeforces') or '--'):>8}"
              f"{sc[rk]:>7.1f}  {conf_oracle(rk)}")
    print(f"  unknown (no math/algo eval): {', '.join(r for r in subset if sc[r] is None)}")

def reviewer_view(subset, res=None):
    print(f"\n=== ADVERSARIAL REVIEW (review-code / review-tests) ===")
    print(f"{'MODEL':<26}{'R-CODE':>7}{'R-TEST':>7}{'$/M':>7}  {'ctx':>5}  {'lab':<9} decorr")
    res = res if res is not None else (VRES if subset is VALUE else FRES)
    key = lambda r: -((res['Review-Code'][r] or -1) + (res['Review-Tests'][r] or -1))
    for rk in sorted(subset, key=key):
        decorr = 'same-lab ✗' if LAB[rk] == IMPL_LAB else 'ok ✓'
        cost = COST[rk]
        cs = f"{cost:>7.3f}" if cost is not None else "    -- "
        print(f"{rk:<26}{f(res['Review-Code'][rk]):>7}{f(res['Review-Tests'][rk]):>7}{cs}  "
              f"{CTX[rk]:>4}K  {LAB[rk]:<9} {decorr}")

table(VRES, VALUE, f"PRIMARY: value tier, {len(VALUE)} rows (flagships excluded) @ {int(IN_RATIO*100)}/{int(OUT_RATIO*100)} I/O")
reviewer_view(VALUE)
oracle_detail(VALUE)
GRES = compute(GO_MENU)
table(GRES, GO_MENU, "OPENCODE GO MENU (decision model-tiers/002, 2026-10-18)")
reviewer_view(GO_MENU, GRES)
table(FRES, list(DATA), f"APPENDIX: full frontier, all {len(DATA)} rows")

def pack(res, subset):
    return {rk: {
        "orchestrator": res['Orchestrator'][rk], "implementer": res['Implementer'][rk],
        "oracle": res['Oracle'][rk], "review_code": res['Review-Code'][rk],
        "review_tests": res['Review-Tests'][rk], "cost_per_M": COST[rk], "ctx_K": CTX[rk],
        "multimodal": MM[rk], "lab": LAB[rk], "decorrelated_from_impl": LAB[rk] != IMPL_LAB,
        "variant": next((r[1] for r in ROWS if r[0] == rk), "base"),
        "aa_int": DATA[rk]["aa_int"], "aa_cod": DATA[rk]["aa_cod"], "aa_agt": DATA[rk]["aa_agt"],
        "swe_pro": DATA[rk]["swe_pro"], "deepswe": DATA[rk]["deepswe"], "tb4": DATA[rk]["tb4"],
        "lcr": DATA[rk]["lcr"], "ifbench": DATA[rk]["ifbench"], "aime": DATA[rk]["aime"],
        "codeforces": DATA[rk]["codeforces"], "gpqa": DATA[rk]["gpqa"],
        "omni_acc": DATA[rk]["omni_acc"], "omni_halluc": DATA[rk]["omni_halluc"],
        "lcb": DATA[rk]["lcb"], "hardmath": DATA[rk]["hardmath"],
        "conf_orch": conf_oi(rk, 'Orchestrator'), "conf_impl": conf_oi(rk, 'Implementer'),
        "conf_oracle": conf_oracle(rk), "conf_review": conf_oi(rk, 'Review-Code'),
    } for rk in subset}

_out = os.path.join(HERE, "role_scores.json")
json.dump({"fetchedAt": S.get("fetchedAt"), "value_tier": pack(VRES, VALUE),
           "go_menu": pack(GRES, GO_MENU),
           "full": pack(FRES, list(DATA))}, open(_out, "w"), indent=2)
print(f"\nwrote {_out}")
