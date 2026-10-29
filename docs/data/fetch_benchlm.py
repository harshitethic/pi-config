#!/usr/bin/env python3
"""Fetch role-fit data from BenchLM + OpenRouter into benchlm_snapshot.json.

Sources (all free, no auth except OpenRouter benchmarks which uses the
pi-openrouter keychain entry, same as the model-tiers extension):
- BenchLM per-benchmark pages: SWE-bench Pro, Terminal-Bench 4.0,
  AA-LCR, AA-IFBench, AA-Intelligence, DeepSWE, Codeforces, AIME26,
  GPQA-D, AA-Omniscience Accuracy/Hallucination Rate.
  These pages embed per-model scores as __NEXT_DATA__ JSON, including
  thinking-level variant rows like "DeepSeek V4 Pro (High)"/"(Max)".
- OpenRouter /api/v1/benchmarks: AA Intelligence/Coding/Agentic indices
  (base checkpoints only — no High/Max split) + pricing.
- OpenRouter /api/v1/models: pricing (incl. input_cache_read) + context.

Variant rows carry AA-Coding/AA-Agentic from the base checkpoint (OpenRouter
publishes no variant split); AA-Intelligence has a BenchLM variant split.
role_scores.py merges this snapshot with the manual framia dict (LiveCodeBench,
IMO/HMMT — BenchLM does not track those for DeepSeek).

Benchmark-set policy (integrity review, 2026-10-18 — decision model-tiers/003):
SWE-bench Verified dropped (OpenAI abandoned it: ~59% flawed tests, contaminated);
SWE-bench Pro kept but discounted in composites (verifier false-negatives ~24-32%,
git-history gold-commit exploit); Terminal-Bench scored at 4.0 only (semantic
versioning — cross-version scores incomparable); DeepSWE added (verifier-hardened);
AIME/Codeforces/GPQA fetched for informational columns, not composite weight.

Run: python3 docs/data/fetch_benchlm.py   -> writes benchlm_snapshot.json
"""
import json, os, re, subprocess, sys, time, urllib.request

HERE = os.path.dirname(os.path.abspath(__file__))
OUT = os.path.join(HERE, "benchlm_snapshot.json")

BENCHLM_PAGES = {
    "swe_pro": "swe-bench-pro",
    "tb4": "terminal-bench-4",
    "deepswe": "deepswe",
    "aa_lcr": "lcr",
    "aa_ifbench": "aaifbench",
    "aa_int": "artificialanalysis",
    "aa_coding": "aacodingindex",
    "aa_agentic": "aaagenticindex",
    "codeforces": "codeforces",
    "aime26": "aime2026",
    "gpqa_d": "gpqa-diamond",
    "omni_acc": "omniscienceaccuracy",
    "omni_halluc": "omnisciencehallucinationrate",
}


UA = {"User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36"}


def get(url, headers=None, timeout=30):
    h = dict(UA)
    h.update(headers or {})
    req = urllib.request.Request(url, headers=h)
    with urllib.request.urlopen(req, timeout=timeout) as r:
        return r.read().decode("utf-8", "replace")


def benchlm_page(slug):
    html = get(f"https://benchlm.ai/benchmarks/{slug}")
    m = re.search(
        r'<script id="__NEXT_DATA__" type="application/json">(.*?)</script>',
        html, re.S,
    )
    if not m:
        raise RuntimeError(f"no __NEXT_DATA__ in benchlm.ai/benchmarks/{slug}")
    data = json.loads(m.group(1))
    pp = data["props"]["pageProps"]
    lb = pp.get("leaderboard") or []
    return {
        "lastUpdated": pp.get("lastUpdated"),
        "scores": {r.get("model"): r.get("score") for r in lb},
    }


def openrouter_key():
    if os.environ.get("OPENROUTER_API_KEY"):
        return os.environ["OPENROUTER_API_KEY"]
    try:
        k = subprocess.run(
            ["security", "find-generic-password", "-ws", "pi-openrouter"],
            capture_output=True, text=True, timeout=5,
        ).stdout.strip()
        if k:
            return k
    except Exception:
        pass
    auth = os.path.expanduser("~/.pi/agent/auth.json")
    if os.path.exists(auth):
        a = json.load(open(auth))
        cred = a.get("openrouter")
        if cred and cred.get("type") == "api_key" and cred.get("key"):
            k = cred["key"]
            if k.startswith("$"):
                env = k[1:].strip("${}")
                return os.environ.get(env)
            if not k.startswith("!"):
                return k
    return None


def check_0731(snapshot):
    """Report whether BenchLM has ingested 0731 rows yet (it had not as of 2026-07-31).
    DeepSeek's 0731 launch published only agentic evals (Terminal-Bench 2.1, DeepSWE,
    NL2Repo, ...) — none of the granular composites (SWE-Pro, LCB, IMO/HMMT, TB2, SWE-Ver)."""
    found = []
    for page, d in snapshot["benchlm"].items():
        for name in d["scores"]:
            if "0731" in name or "20260731" in name:
                found.append(f"{page}: {name} = {d['scores'][name]}")
    if found:
        print("0731 rows now present on BenchLM:")
        for f in found:
            print(" ", f)
    else:
        print("No 0731 rows on BenchLM yet — granular composites (SWE-Pro, LCB, IMO/HMMT,"
              " TB2, SWE-Ver) still unpublished for the 0731 checkpoint. Re-run in 24-48h.")
    aa = snapshot["openrouter_aa"].get("deepseek/deepseek-v4-flash-20260731")
    print("0731 AA indices (served-model, OpenRouter/AA):", aa)


def main():
    if "--check-0731" in sys.argv[1:]:
        import json as _json
        if not os.path.exists(OUT):
            raise SystemExit(f"{OUT} missing — run fetch first")
        check_0731(_json.load(open(OUT)))
        return

    bench = {}
    for key, slug in BENCHLM_PAGES.items():
        print(f"benchlm {slug} ...", flush=True)
        bench[key] = benchlm_page(slug)
        time.sleep(0.4)  # be polite

    key = openrouter_key()
    headers = {"Accept": "application/json"}
    if key:
        headers["Authorization"] = f"Bearer {key}"
    bench_rows = json.loads(get(
        "https://openrouter.ai/api/v1/benchmarks?source=artificial-analysis",
        headers,
    )).get("data", [])
    aa = {}
    for r in bench_rows:
        pr = r.get("pricing") or {}
        aa[r.get("model_permaslug")] = {
            "intel": r.get("intelligence_index"),
            "coding": r.get("coding_index"),
            "agentic": r.get("agentic_index"),
            "prompt": pr.get("prompt"),
            "completion": pr.get("completion"),
        }

    models = json.loads(get("https://openrouter.ai/api/v1/models", headers)).get("data", [])
    model_meta = {}
    for m in models:
        p = m.get("pricing", {})
        model_meta[m.get("id")] = {
            "canonical_slug": m.get("canonical_slug"),
            "ctx": m.get("context_length"),
            "prompt": p.get("prompt"),
            "completion": p.get("completion"),
            "cache_read": p.get("input_cache_read"),
        }

    snapshot = {
        "fetchedAt": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
        "benchlm": bench,
        "openrouter_aa": aa,
        "openrouter_models": model_meta,
    }
    with open(OUT, "w") as f:
        json.dump(snapshot, f, indent=1)
    print(f"\nwrote {OUT} ({os.path.getsize(OUT)} bytes)")
    print("benchlm pages:", ", ".join(f"{k}({v['lastUpdated']})" for k, v in bench.items()))
    print("openrouter aa rows:", len(aa), "| models:", len(model_meta))
    if not key:
        print("WARNING: no OpenRouter key found — AA indices/pricing may be stale or missing")


if __name__ == "__main__":
    main()
