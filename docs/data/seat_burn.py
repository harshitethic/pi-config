#!/usr/bin/env python3
"""seat_burn — attribute pi session-log token usage to subagent seats and
OpenCode Go plan buckets.

Reads pi session logs (`~/.pi/agent/sessions/**/*.jsonl`) plus the ephemeral
spawn records `/tmp/pi-subagent-<session-id>.meta.json` and reports, for a UTC
date window:

  - raw tokens per day per seat and per day per model (cache/non-cache split)
  - per-seat and per-model window totals with shares
  - per-model "solo capacity" (Go Plus monthly limit per model) with $ burn
    month-projected at the observed pace, **plus the plan-wide meter the console
    actually enforces**: Σ(real $ on model m ÷ solo capacity_m) ≤ 1.0 per month.
    Per-model monthly limits are illustrations of one shared allowance, not
    separate budgets (OpenCode console `quotaCost = round(cost × costMultiplier)`
    into a single per-workspace counter; github.com/anomalyco/opencode#54875 —
    "It is not a separate budget for that model"). The server-side cross-check is
    the plan-wide monthly percent from `/zen/go/v1/usage`, rendered in the footer
    (decision `decisions/external-tools/006`); this tool is offline and reports
    the client-computed meter only.
  - a headline: the session+orchestrator seats' share of raw tokens and of $
    burn, their month projection against the MiMo-V2.6-Pro solo capacity, and
    their share of the plan-wide meter
  - data-quality counters: duplicate entries, missing usage, unattributed
    share, ambiguous signature groups, unpriced token classes, and the
    model-id spelling inventory of the whole corpus

**Read-only.** Nothing is written except stdout (`--json` included): no state
files, no session-log or /tmp writes.

Seat attribution
  1. A session file not named `subagent-*` is the main-session seat (this
     includes long-running peer sessions, e.g. `bug-triage`).
  2. A `subagent-*` file joins `/tmp/pi-subagent-<session-id>.meta.json` for
     `agentName`.
  3. With no meta.json — /tmp is ephemeral, and historically ~86% of subagent
     sessions lack one — the seat is inferred from the (canonical model,
     thinking level) signature against a table derived at runtime from
     `agents/*.md` frontmatter + `settings.json` + the `FLEET_MODEL` fallback,
     with decision `decisions/subagents/031` contributing the one inheritance
     rule (the orchestrator seat runs on its caller's model at its own level).
     A signature that matches more than one seat is reported as a named
     ambiguous group — never guessed. Trusting-level inference is reported per
     seat in the `attribution` column.

Pricing — list price per token class ($/M), never a blended rate
(`decisions/model-tiers/004` rules blended rates out; `docs/data/role_scores.py`
offers no importable per-class helper — it is a script that rewrites
`role_scores.json` on import — so the table is embedded here). Each row carries
its `source`. A class whose price is unpublished is *not* invented: those tokens
are reported as unpriced and excluded from $ burn. MiMo-V2.6-Pro's Go price is
unknown, so its row carries the Xiaomi/OpenRouter list price as a flagged
placeholder. Peak: ×2 for DeepSeek V4.1 Flash on weekdays 01:00–04:00 and
06:00–10:00 UTC (`decisions/subagents/036`); every other model's peak behaviour
is unknown and not modelled.

Run:
  python3 docs/data/seat_burn.py                    # 45 days before the latest entry
  python3 docs/data/seat_burn.py --since 2026-10-17
  python3 docs/data/seat_burn.py --since 2026-10-17 --json
  python3 docs/data/seat_burn.py --selftest
"""
import argparse
import datetime
import json
import os
import re
import subprocess
import sys
from collections import Counter, defaultdict, namedtuple

HERE = os.path.dirname(os.path.abspath(__file__))
REPO_ROOT = os.path.dirname(os.path.dirname(HERE))
AGENTS_DIR = os.path.join(REPO_ROOT, "agents")
SETTINGS_PATH = os.path.join(REPO_ROOT, "settings.json")
FLEET_MODEL_TS = os.path.join(REPO_ROOT, "extensions", "lib", "fleet-model.ts")
TESTDATA = os.path.join(HERE, "testdata", "seat_burn")

DEFAULT_SESSIONS = os.path.join(os.path.expanduser("~"), ".pi", "agent", "sessions")
DEFAULT_META_DIR = "/tmp"
DEFAULT_WINDOW_DAYS = 45

MAIN_SEAT = "main-session"
HEADLINE_SEATS = (MAIN_SEAT, "orchestrator")
GO_PROVIDER = "opencode-go"
UNATTRIBUTED = "unattributed"
AMBIGUOUS_PREFIX = "ambiguous:"

# Token classes: (Rec/usage attribute, price-table key). `reasoning` is part of
# `output` in pi's usage shape and is never additive.
CLASSES = (
    ("inp", "input", "input"),
    ("out", "output", "output"),
    ("cr", "cache_read", "cacheRead"),
    ("cw", "cache_write", "cacheWrite"),
)

# ---- Price table ($/M, off-peak list). One row per canonical model id. ----
# `cache_write=None` everywhere: no fleet SKU publishes a separate cache-write
# price, so those tokens are reported as their own unpriced class rather than
# folded into input.
PRICES = {
    "deepseek-v4.1-flash": {
        "input": 0.15, "output": 0.60, "cache_read": 0.003, "cache_write": None,
        "peak": True,
        "listed_limit_usd": 160.0,
        "limit_source": "decisions/subagents/036 (Go Plus solo capacity)",
        "source": "decisions/subagents/036 (OpenCode Go list = DeepSeek first-party "
                  "list: in/out/cache-read); peak doubling per 036",
    },
    "deepseek-v4.1-flash-1017": {
        "input": 0.15, "output": 0.60, "cache_read": 0.003, "cache_write": None,
        "peak": True,
        "source": "decisions/subagents/035 (1017 checkpoint: pricing unchanged from "
                  "the 0910 id, weekday peak windows unchanged)",
    },
    "deepseek-v4-pro": {
        "input": 0.66, "output": 1.98, "cache_read": None, "cache_write": None,
        "peak": None,
        "listed_limit_usd": 60.0,
        "limit_source": "decisions/subagents/036 (Go Plus solo capacity)",
        "source": "decisions/subagents/036 + WO-2026-053 price table (in/out only; no "
                  "cache-read price given — cannot be derived, so unpriced)",
    },
    "deepseek-v4-flash": {
        "input": 0.14, "output": 0.28, "cache_read": 0.028, "cache_write": None,
        "peak": None,
        "source": "decisions/subagents/010 (pi.dev catalog row for the 0910 flash id)",
    },
    "deepseek-v4-flash-0731": {
        "input": 0.14, "output": 0.28, "cache_read": 0.0028, "cache_write": None,
        "peak": None,
        "source": "decisions/subagents/010 (pi.dev catalog row: 0731 flash, 10x "
                  "cheaper cache read)",
    },
    "glm-5.3-flash": {
        "input": 0.15, "output": 0.50, "cache_read": None, "cache_write": None,
        "peak": None,
        "listed_limit_usd": 180.0,
        "limit_source": "decisions/subagents/036, 037 (Go Plus solo capacity)",
        "source": "decisions/subagents/036 + WO-2026-053 price table (in/out only; no "
                  "cache-read price given — unpriced)",
    },
    "glm-5.3": {
        "input": 1.40, "output": 4.40, "cache_read": None, "cache_write": None,
        "peak": None,
        "source": "decisions/subagents/036 + WO-2026-053 price table (in/out only)",
    },
    "mimo-v2.6-flash": {
        "input": 0.14, "output": 0.28, "cache_read": 0.0028, "cache_write": None,
        "peak": None,
        "source": "decisions/subagents/023 (Xiaomi first-party pin, in/out/cache-read)",
    },
    "mimo-v2.6-pro": {
        "input": 0.435, "output": 0.87, "cache_read": 0.036, "cache_write": None,
        "peak": None,
        "placeholder": True,
        "listed_limit_usd": 60.0,
        "limit_source": "decisions/subagents/036; TODO seat-burn entry (Go Plus solo "
                        "capacity — the watched allowance consumer)",
        "source": "PLACEHOLDER — Xiaomi/OpenRouter list price (WO-2026-053); the "
                  "OpenCode Go price for this SKU is unknown",
    },
    "mimo-v2.5-pro": {
        "input": 0.435, "output": 0.87, "cache_read": 0.0036, "cache_write": None,
        "peak": None,
        "source": "decisions/subagents/010 (OpenRouter live /models row)",
    },
    "minimax-m3": {
        "input": 0.30, "output": 1.20, "cache_read": 0.06, "cache_write": None,
        "peak": None,
        "source": "decisions/subagents/010 (OpenRouter live /models row)",
    },
}

# ---- OpenCode Go Plus plan limits (decisions/subagents/036, 037). ----
# These are *solo capacities*, not separate budgets: one shared plan allowance
# meters Σ(real $ on model m ÷ listed capacity_m) ≤ 1.0 per month (OpenCode's
# console records `quotaCost = round(cost × costMultiplier)` into a single
# per-workspace counter; the per-model "monthly limit" is how much of that
# allowance one model alone would consume — github.com/anomalyco/opencode#54875).
# The capacity lives on the PRICE rows so price and limit cannot drift apart.
HEADLINE_MODEL_LIMIT = "mimo-v2.6-pro"

# Peak windows, applied only to price rows that carry `peak: True` — DeepSeek
# V4.1 Flash and its -1017 checkpoint (decisions/subagents/036, 035). Every
# other model's peak behaviour is unknown and deliberately not modelled.
PEAK_HOURS = ((1, 4), (6, 10))  # [start, end) UTC, weekdays only
PEAK_MULTIPLIER = 2.0

# decision 031: this seat runs on its caller's model and takes only its level
# from frontmatter, so its signature is (any model, seat level).
INHERIT_MODEL_SEATS = {"orchestrator"}

LEVELS = {"off", "minimal", "low", "medium", "high", "xhigh", "max"}

# One in-window assistant message with usage. `model` is the canonical id,
# `raw_model` the spelling as recorded.
Rec = namedtuple(
    "Rec",
    "sid is_sub day ts model raw_model provider inp out cr cw total cost level",
)


class DataError(Exception):
    """Invalid CLI input or an empty window — reported on stderr, nonzero exit."""


# --------------------------------------------------------------------------
# Model ids and config-derived seat signatures
# --------------------------------------------------------------------------
def canonical_model(raw):
    """Merge bare and provider-prefixed spellings of one model.

    pi records the same model as `glm-5.3-flash` (opencode-go, zai) and
    `z-ai/glm-5.3` (openrouter); the checkpoint suffix (`-1017`) stays part of
    the id so those remain distinct models. Case is folded because the corpus
    spells one model both ways (`MiniMax-M3` via minimax, `minimax/minimax-m3`
    via openrouter) — no two distinct fleet models differ only by case.
    """
    if not raw:
        return "unknown"
    return raw.rsplit("/", 1)[-1].strip().lower() or "unknown"


def split_model_spec(spec):
    """`provider/model:level` -> (spec, level). `:free` is not a level."""
    spec = (spec or "").strip()
    m = re.match(r"^(.*):([a-z]+)$", spec)
    if m and m.group(2) in LEVELS:
        return m.group(1), m.group(2)
    return spec, None


def read_frontmatter(path):
    try:
        with open(path, encoding="utf-8", errors="replace") as fh:
            lines = fh.read().splitlines()
    except OSError:
        return None
    if not lines or lines[0].strip() != "---":
        return None
    fm = {}
    for line in lines[1:]:
        if line.strip() == "---":
            return fm
        if ":" in line:
            key, val = line.split(":", 1)
            fm[key.strip()] = val.strip()
    return None


def load_fleet_model():
    try:
        with open(FLEET_MODEL_TS, encoding="utf-8", errors="replace") as fh:
            text = fh.read()
    except OSError:
        return None, None
    prov = re.search(r'FLEET_PROVIDER\s*=\s*"([^"]+)"', text)
    model = re.search(r'FLEET_MODEL\s*=\s*"([^"]+)"', text)
    return (prov.group(1) if prov else None, model.group(1) if model else None)


def load_signature_table():
    """Derive every seat's (canonical model, level) signature from live config.

    Returns (entries, notes). Each entry: agent, model (None = caller's model),
    level, kind ('exact' | 'inherit'), source.
    """
    entries, notes = [], []
    settings = {}
    try:
        with open(SETTINGS_PATH, encoding="utf-8") as fh:
            settings = json.load(fh)
    except (OSError, ValueError):
        notes.append("settings.json unreadable — default level / fleet-fallback "
                     "seats omitted from the signature table")
    default_level = settings.get("defaultThinkingLevel")
    fleet_provider, fleet_model = load_fleet_model()
    if not os.path.isdir(AGENTS_DIR):
        notes.append(f"agents/ not found at {AGENTS_DIR} — no signature inference")
        return entries, notes

    for name in sorted(os.listdir(AGENTS_DIR)):
        if not name.endswith(".md"):
            continue
        fm = read_frontmatter(os.path.join(AGENTS_DIR, name))
        if not fm or not fm.get("name"):
            notes.append(f"agents/{name}: no frontmatter name — not a spawnable "
                         "agent (main-session/peer seat only), excluded from "
                         "signature inference")
            continue
        agent = fm["name"]
        spec, level = split_model_spec(fm.get("model"))
        if spec:
            model = canonical_model(spec.split("/", 1)[-1])
            source = f"agents/{name} frontmatter model"
        elif fleet_model:
            model = canonical_model(fleet_model)
            level = level or default_level
            source = (f"agents/{name} has no model: → FLEET_MODEL "
                      f"({fleet_provider}/{fleet_model}) at settings.json "
                      f"defaultThinkingLevel")
            notes.append(f"agents/{name}: no model: frontmatter — uses the fleet "
                         f"fallback ({model}:{level})")
        else:
            notes.append(f"agents/{name}: no model: frontmatter and FLEET_MODEL "
                         "unreadable — excluded")
            continue
        if level is None:
            level = default_level
            notes.append(f"agents/{name}: no level in frontmatter — "
                         f"settings.json defaultThinkingLevel ({level})")
        kind = "inherit" if agent in INHERIT_MODEL_SEATS else "exact"
        if kind == "inherit":
            source += " + decisions/subagents/031 (caller's model, seat's level)"
        entries.append({"agent": agent, "model": None if kind == "inherit" else model,
                        "level": level, "kind": kind, "source": source})
    if not entries:
        notes.append("signature table is empty — every meta-less subagent session "
                     "is reported unattributed")
    return entries, notes


def signature_candidates(table, model, level):
    """Seat names whose signature can produce (canonical model, level)."""
    if not table or not model:
        return []
    inherit = [e for e in table if e["kind"] == "inherit"]
    if level is None:
        # No thinking_level_change recorded: every seat on this model, plus the
        # caller-model seats, is a candidate.
        return sorted({e["agent"] for e in table
                       if e["kind"] == "exact" and e["model"] == model}
                      | {e["agent"] for e in inherit})
    exact = sorted({e["agent"] for e in table
                    if e["kind"] == "exact" and e["model"] == model and e["level"] == level})
    if exact:
        return exact  # an exact frontmatter model beats the inheritance rule
    return sorted({e["agent"] for e in inherit if e["level"] == level})


def load_meta(meta_dir, q):
    """session id -> agentName, from /tmp/pi-subagent-<session-id>.meta.json."""
    meta = {}
    try:
        names = sorted(os.listdir(meta_dir))
    except OSError:
        q["meta_dir_missing"] = meta_dir
        return meta
    for name in names:
        m = re.match(r"^pi-subagent-(.+)\.meta\.json$", name)
        if not m:
            continue
        try:
            with open(os.path.join(meta_dir, name), encoding="utf-8", errors="replace") as fh:
                data = json.load(fh)
        except (OSError, ValueError):
            q["meta_unreadable"] += 1
            continue
        q["meta_files"] += 1
        agent = data.get("agentName") if isinstance(data, dict) else None
        if agent:
            meta[m.group(1)] = agent
        else:
            q["meta_without_agent"] += 1
    return meta


def session_id_from_filename(filename):
    """`<iso-timestamp>_<session-id>.jsonl` -> session id."""
    base = filename[: -len(".jsonl")]
    return base.split("_", 1)[1] if "_" in base else base


# --------------------------------------------------------------------------
# Session-log scan
# --------------------------------------------------------------------------
TS_RE = re.compile(r'"timestamp"\s*:\s*"(\d{4}-\d{2}-\d{2})')


def latest_day(sessions_dir):
    """Cheap pre-pass for the default window: newest timestamp in the corpus."""
    latest = None
    for dirpath, dirnames, filenames in os.walk(sessions_dir):
        dirnames.sort()
        for name in sorted(filenames):
            if not name.endswith(".jsonl") or ".pre-" in name:
                continue
            try:
                with open(os.path.join(dirpath, name), "rb") as fh:
                    for line in fh:
                        m = TS_RE.search(line.decode("utf-8", "replace"))
                        if m and (latest is None or m.group(1) > latest):
                            latest = m.group(1)
            except OSError:
                continue
    return latest


def scan_sessions(sessions_dir, since, until, q):
    """All assistant messages with usage inside [since, until] (UTC days).

    Tolerates the whole real corpus shape: entry types session/model_change/
    thinking_level_change/message/custom/custom_message/compaction/session_info,
    `*.pre-*` backups, and unknown/unparseable lines (counted, never fatal).
    """
    recs = []
    spellings = defaultdict(set)   # canonical -> recorded spellings (whole scan)
    routes = defaultdict(set)      # canonical -> providers (whole scan)
    for dirpath, dirnames, filenames in os.walk(sessions_dir):
        dirnames.sort()
        for name in sorted(filenames):
            if ".pre-" in name:
                q["files_skipped_pre"] += 1
                continue
            if not name.endswith(".jsonl"):
                continue
            q["files_scanned"] += 1
            sid = session_id_from_filename(name)
            is_sub = sid.startswith("subagent-")
            seen_ids = set()
            level = None
            cur_model = None
            cur_provider = None
            try:
                fh = open(os.path.join(dirpath, name), encoding="utf-8", errors="replace")
            except OSError:
                q["files_unreadable"] += 1
                continue
            with fh:
                for line in fh:
                    line = line.strip()
                    if not line:
                        continue
                    try:
                        entry = json.loads(line)
                    except ValueError:
                        q["bad_lines"] += 1
                        continue
                    if not isinstance(entry, dict):
                        q["bad_lines"] += 1
                        continue
                    etype = entry.get("type")
                    q["entries_by_type"][str(etype)] += 1
                    if etype == "thinking_level_change":
                        level = entry.get("thinkingLevel")
                        continue
                    if etype == "model_change":
                        cur_model = entry.get("modelId")
                        cur_provider = entry.get("provider")
                        continue
                    if etype != "message":
                        continue
                    msg = entry.get("message")
                    if not isinstance(msg, dict) or msg.get("role") != "assistant":
                        continue
                    entry_id = entry.get("id")
                    if entry_id:
                        # Replay/branching duplicates one entry id 2-4x; the
                        # first copy wins and the rest are data-quality noise.
                        if entry_id in seen_ids:
                            q["dup_ids_dropped"] += 1
                            continue
                        seen_ids.add(entry_id)
                    usage = msg.get("usage")
                    if not isinstance(usage, dict) or not any(
                        k in usage for k in ("input", "output", "cacheRead",
                                             "cacheWrite", "totalTokens")
                    ):
                        q["no_usage"] += 1
                        continue
                    total = usage.get("totalTokens")
                    if total is None:
                        q["no_total_tokens"] += 1
                        continue
                    raw_model = msg.get("model") or cur_model
                    canon = canonical_model(raw_model)
                    # Provider order: the message envelope (always present in the
                    # real corpus), then the last model_change, then a routing
                    # prefix on the model id.
                    provider = msg.get("provider")
                    if not provider:
                        q["messages_without_provider"] += 1
                        if cur_provider:
                            provider = cur_provider
                            q["provider_from_model_change"] += 1
                        elif raw_model and "/" in raw_model:
                            provider = raw_model.split("/", 1)[0]
                            q["provider_from_prefix"] += 1
                        else:
                            provider = "unknown"
                            q["provider_unknown"] += 1
                    # The spelling inventory describes the whole corpus, so it is
                    # recorded before the window filter drops the record.
                    spellings[canon].add(raw_model or canon)
                    routes[canon].add(provider)
                    ts = entry.get("timestamp") or ""
                    day = ts[:10]
                    if len(day) != 10:
                        q["bad_timestamps"] += 1
                        continue
                    if day < since or day > until:
                        continue
                    inp = usage.get("input") or 0
                    out = usage.get("output") or 0
                    cr = usage.get("cacheRead") or 0
                    cw = usage.get("cacheWrite") or 0
                    if total != inp + out + cr + cw:
                        q["total_mismatch"] += 1
                    cost = usage.get("cost")
                    recorded = None
                    if isinstance(cost, dict) and isinstance(cost.get("total"), (int, float)):
                        recorded = float(cost["total"])
                    recs.append(Rec(sid, is_sub, day, ts, canon, raw_model, provider,
                                    inp, out, cr, cw, int(total), recorded, level))
    return recs, spellings, routes


def peak_multiplier(model, ts):
    """×2 inside the DeepSeek V4.1 Flash weekday peak windows, else ×1."""
    if not PRICES.get(model, {}).get("peak"):
        return 1.0
    try:
        stamp = datetime.datetime.strptime(ts[:19], "%Y-%m-%dT%H:%M:%S")
    except ValueError:
        return 1.0
    if stamp.weekday() >= 5:
        return 1.0
    for start, end in PEAK_HOURS:
        if start <= stamp.hour < end:
            return PEAK_MULTIPLIER
    return 1.0


# --------------------------------------------------------------------------
# Report
# --------------------------------------------------------------------------
def _new_row():
    return {"raw": 0, "in": 0, "out": 0, "cr": 0, "cw": 0,
            "burn": 0.0, "recorded": 0.0, "n": 0}


def _add(row, rec, burn, recorded):
    row["raw"] += rec.total
    row["in"] += rec.inp
    row["out"] += rec.out
    row["cr"] += rec.cr
    row["cw"] += rec.cw
    row["burn"] += burn
    row["recorded"] += recorded
    row["n"] += 1


def build_report(opts):
    q = Counter()
    q["entries_by_type"] = Counter()
    if not os.path.isdir(opts.sessions_dir):
        raise DataError(f"sessions dir not found: {opts.sessions_dir}")
    if opts.since is not None:
        since = opts.since
    else:
        latest = latest_day(opts.sessions_dir)
        if latest is None:
            raise DataError(f"no session entries found under {opts.sessions_dir}")
        since = (datetime.date.fromisoformat(latest)
                 - datetime.timedelta(days=DEFAULT_WINDOW_DAYS)).isoformat()
    until = opts.until or datetime.datetime.now(datetime.timezone.utc).date().isoformat()
    if since > until:
        raise DataError(f"--since {since} is after --until {until}")
    window_days = (datetime.date.fromisoformat(until)
                   - datetime.date.fromisoformat(since)).days + 1

    table, table_notes = load_signature_table()
    meta = load_meta(opts.meta_dir, q)
    recs, spellings, routes = scan_sessions(opts.sessions_dir, since, until, q)
    if not recs:
        raise DataError(f"no assistant messages with token usage between {since} "
                        f"and {until} under {opts.sessions_dir}")

    seat_rows = {}           # label -> row
    seat_conf = defaultdict(Counter)   # label -> attribution counter
    model_rows = {}          # (model, route) -> row
    day_seat = {}            # (day, label) -> row
    day_model = {}           # (day, model, route) -> row
    unpriced = Counter()     # (model, class) -> tokens
    ambiguous = Counter()    # group label -> messages
    ambiguous_sig = {}       # group label -> signature text
    attribution_count = Counter()
    peak_routes = set()      # (model, route) pairs whose burn hit the peak
    headline = _new_row()
    headline_go = {}         # model -> row, headline seats on opencode-go only
    total = _new_row()
    go_total = _new_row()
    unmapped = set()

    for rec in recs:
        if not rec.is_sub:
            seat, conf = MAIN_SEAT, "filename"
        else:
            agent = meta.get(rec.sid)
            if agent:
                seat, conf = agent, "meta"
            else:
                cands = signature_candidates(table, rec.model, rec.level)
                if len(cands) == 1:
                    seat, conf = cands[0], "signature"
                elif cands:
                    seat = AMBIGUOUS_PREFIX + "|".join(cands)
                    conf = seat
                    ambiguous[seat] += 1
                    ambiguous_sig.setdefault(
                        seat, f"{rec.model}:{rec.level if rec.level else '(no level)'}")
                else:
                    seat, conf = UNATTRIBUTED, UNATTRIBUTED
        label = seat
        route = GO_PROVIDER if rec.provider == GO_PROVIDER else rec.provider
        recorded = rec.cost or 0.0
        burn = 0.0
        price = PRICES.get(rec.model)
        mult = peak_multiplier(rec.model, rec.ts)
        for attr, price_key, _usage_key in CLASSES:
            tokens = getattr(rec, attr)
            if not tokens:
                continue
            unit = price.get(price_key) if price else None
            if unit is None:
                unpriced[(rec.model, price_key)] += tokens
                continue
            burn += tokens * unit / 1e6 * mult

        _add(seat_rows.setdefault(label, _new_row()), rec, burn, recorded)
        seat_conf[label][conf] += 1
        attribution_count[conf] += 1
        _add(model_rows.setdefault((rec.model, route), _new_row()), rec, burn, recorded)
        _add(day_seat.setdefault((rec.day, label), _new_row()), rec, burn, recorded)
        _add(day_model.setdefault((rec.day, rec.model, route), _new_row()), rec, burn, recorded)
        _add(total, rec, burn, recorded)
        if label in HEADLINE_SEATS:
            _add(headline, rec, burn, recorded)
            if route == GO_PROVIDER:
                _add(headline_go.setdefault(rec.model, _new_row()), rec, burn, recorded)
        if mult > 1.0:
            peak_routes.add((rec.model, route))
        if route == GO_PROVIDER:
            _add(go_total, rec, burn, recorded)
            if solo_capacity_usd(rec.model) is None:
                unmapped.add(rec.model)

    total_tokens = total["raw"] or 1
    total_burn = total["burn"]

    def share(part, whole):
        return round(100.0 * part / whole, 2) if whole else None

    seats_out = []
    for label, row in seat_rows.items():
        confs = sorted(seat_conf[label])
        seats_out.append({
            "seat": label,
            "raw_tokens": row["raw"],
            "token_share": share(row["raw"], total_tokens),
            "burn_usd": round(row["burn"], 6),
            "burn_share": share(row["burn"], total_burn),
            "recorded_usd": round(row["recorded"], 6),
            "messages": row["n"],
            "attribution": ",".join(confs),
            "cache_read": row["cr"],
            "cache_write": row["cw"],
            "io_tokens": row["in"] + row["out"],
        })
    seats_out.sort(key=lambda r: (-r["raw_tokens"], r["seat"]))

    models_out = []
    for (model, route), row in model_rows.items():
        price = PRICES.get(model)
        missing = [key for _, key, _ in CLASSES
                   if (price or {}).get(key) is None]
        models_out.append({
            "model": model,
            "route": route,
            "solo_capacity_usd": solo_capacity_usd(model) if route == GO_PROVIDER else None,
            "raw_tokens": row["raw"],
            "cache_read": row["cr"],
            "cache_write": row["cw"],
            "io_tokens": row["in"] + row["out"],
            "cache_pct": share(row["cr"] + row["cw"], row["raw"]),
            "burn_usd": round(row["burn"], 6),
            "recorded_usd": round(row["recorded"], 6),
            "messages": row["n"],
            "price_source": (price or {}).get("source", "no price row — tokens only"),
            "price_placeholder": bool((price or {}).get("placeholder")),
            "peak_applied": (model, route) in peak_routes,
            "unpriced_classes": missing,
        })
    models_out.sort(key=lambda r: (-r["raw_tokens"], r["model"], r["route"]))

    # Per-model solo capacity (illustrative) and the plan-wide meter the console
    # actually enforces: Σ(real $ on model m ÷ listed capacity_m) ≤ 1.0 per month.
    solo_rows = []
    meter_parts = []
    for model in sorted(m for m, p in PRICES.items() if p.get("listed_limit_usd")):
        price = PRICES[model]
        cap = price["listed_limit_usd"]
        row = model_rows.get((model, GO_PROVIDER)) or _new_row()
        # Rounded per row so the printed `meter part` column adds up to the
        # printed meter.
        contribution = round(row["burn"] / cap, 6)
        meter_parts.append(contribution)
        solo_rows.append({
            "model": model,
            "listed_limit_usd": cap,
            "meter_contribution": contribution,
            "raw_tokens": row["raw"],
            "burn_usd": round(row["burn"], 6),
            "burn_per_day": round(row["burn"] / window_days, 6),
            "month_projected_usd": round(row["burn"] / window_days * 30, 4),
            "solo_use_pct": share(row["burn"] / window_days * 30, cap),
            "placeholder_price": bool(price.get("placeholder")),
            "unpriced_classes": [key for _, key, _ in CLASSES
                                 if price.get(key) is None],
            "limit_source": price["limit_source"],
        })
    meter_window = round(sum(meter_parts), 6)
    meter_month = meter_window / window_days * 30
    meter_out = {
        "meter_window": round(meter_window, 6),
        "meter_per_day": round(meter_window / window_days, 6),
        "month_projected": round(meter_month, 6),
        "cap": 1.0,
        "cap_use_pct": share(meter_month, 1.0),
        "fits": meter_month <= 1.0,
        "excluded_models": sorted(unmapped),
        "server_side_cross_check": (
            "GET https://opencode.ai/zen/go/v1/usage monthly percent (plan-wide, no "
            "per-model breakdown) — rendered in the footer quota segment, decision "
            "decisions/external-tools/006; this tool does no network I/O"),
    }

    ref_cap = solo_capacity_usd(HEADLINE_MODEL_LIMIT)
    headline_projected = headline["burn"] / window_days * 30
    headline_meter = sum(row["burn"] / solo_capacity_usd(model)
                         for model, row in headline_go.items()
                         if solo_capacity_usd(model))
    headline_meter_month = headline_meter / window_days * 30
    headline_out = {
        "seats": list(HEADLINE_SEATS),
        "raw_tokens": headline["raw"],
        "token_share": share(headline["raw"], total_tokens),
        "burn_usd": round(headline["burn"], 6),
        "burn_share": share(headline["burn"], total_burn),
        "recorded_usd": round(headline["recorded"], 6),
        "recorded_share": share(headline["recorded"], total["recorded"]),
        "messages": headline["n"],
        "month_projected_usd": round(headline_projected, 4),
        "reference_model": HEADLINE_MODEL_LIMIT,
        "reference_solo_capacity_usd": ref_cap,
        "reference_cap_use_pct": share(headline_projected, ref_cap),
        "fits_reference_capacity": headline_projected <= ref_cap,
        "plan_meter_month_projected": round(headline_meter_month, 6),
        "plan_meter_cap_use_pct": share(headline_meter_month, 1.0),
        "plan_meter_share_pct": share(headline_meter_month, meter_month),
    }

    ambiguous_out = [{"group": group, "messages": n, "signature": ambiguous_sig[group]}
                     for group, n in sorted(ambiguous.items())]
    unattributed_tokens = sum(r["raw_tokens"] for r in seats_out
                              if r["seat"] == UNATTRIBUTED
                              or r["seat"].startswith(AMBIGUOUS_PREFIX))
    unattributed_burn = sum(r["burn_usd"] for r in seats_out
                            if r["seat"] == UNATTRIBUTED
                            or r["seat"].startswith(AMBIGUOUS_PREFIX))
    unpriced_out = [{"model": model, "class": cls, "tokens": n}
                    for (model, cls), n in sorted(unpriced.items())]

    return {
        "tool": "seat_burn",
        "window": {
            "since": since,
            "until": until,
            "days": window_days,
            "sessions_dir": opts.sessions_dir,
            "meta_dir": opts.meta_dir,
            "messages": total["n"],
        },
        "daily": {
            "by_seat": [
                {"date": day, "seat": label, "raw_tokens": row["raw"],
                 "cache_read": row["cr"], "cache_write": row["cw"],
                 "io_tokens": row["in"] + row["out"],
                 "burn_usd": round(row["burn"], 6), "messages": row["n"]}
                for (day, label), row in sorted(
                    day_seat.items(), key=lambda kv: (kv[0][0], kv[0][1]))
            ],
            "by_model": [
                {"date": day, "model": model, "route": route,
                 "raw_tokens": row["raw"], "cache_read": row["cr"],
                 "cache_write": row["cw"], "io_tokens": row["in"] + row["out"],
                 "burn_usd": round(row["burn"], 6), "messages": row["n"]}
                for (day, model, route), row in sorted(
                    day_model.items(), key=lambda kv: (kv[0][0], kv[0][1], kv[0][2]))
            ],
        },
        "seats": seats_out,
        "models": models_out,
        "go_plan": {"solo_capacity": solo_rows, "meter": meter_out,
                    "go_burn_usd": round(go_total["burn"], 6)},
        "headline": headline_out,
        "data_quality": {
            "files_scanned": q["files_scanned"],
            "files_skipped_pre": q["files_skipped_pre"],
            "files_unreadable": q["files_unreadable"],
            "bad_lines": q["bad_lines"],
            "duplicate_ids_dropped": q["dup_ids_dropped"],
            "messages_without_usage": q["no_usage"],
            "messages_without_provider": q["messages_without_provider"],
            "provider_from_model_change": q["provider_from_model_change"],
            "provider_from_prefix": q["provider_from_prefix"],
            "provider_unknown": q["provider_unknown"],
            "messages_without_total_tokens": q["no_total_tokens"],
            "total_tokens_mismatch": q["total_mismatch"],
            "bad_timestamps": q["bad_timestamps"],
            "entries_by_type": dict(sorted(q["entries_by_type"].items())),
            "meta_files": q["meta_files"],
            "meta_without_agent": q["meta_without_agent"],
            "meta_unreadable": q["meta_unreadable"],
            "meta_dir_missing": q["meta_dir_missing"] or None,
            "attribution_counts": dict(sorted(attribution_count.items())),
            "unattributed_raw_tokens": unattributed_tokens,
            "unattributed_share_pct": share(unattributed_tokens, total_tokens),
            "unattributed_burn_usd": round(unattributed_burn, 6),
            "unattributed_burn_share_pct": share(unattributed_burn, total_burn),
            "ambiguous_groups": ambiguous_out,
            "unpriced_tokens": unpriced_out,
            "recorded_cost_usd": round(total["recorded"], 6),
            "list_price_burn_usd": round(total_burn, 6),
        },
        "totals": {
            "raw_tokens": total["raw"],
            "cache_read": total["cr"],
            "cache_write": total["cw"],
            "io_tokens": total["in"] + total["out"],
            "burn_usd": round(total_burn, 6),
            "recorded_usd": round(total["recorded"], 6),
            "messages": total["n"],
        },
        "spelling_inventory": [
            {"model": model, "spellings": sorted(raw), "routes": sorted(rts)}
            for model, raw in sorted(spellings.items())
            for rts in [routes[model]]
        ],
        "signature_table": {"entries": table, "notes": table_notes},
        "price_table": [
            {"model": model,
             "input": p["input"], "output": p["output"],
             "cache_read": p["cache_read"], "cache_write": p["cache_write"],
             "peak": bool(p.get("peak")), "placeholder": bool(p.get("placeholder")),
             "listed_limit_usd": p.get("listed_limit_usd"),
             "limit_source": p.get("limit_source"),
             "source": p["source"]}
            for model, p in sorted(PRICES.items())
        ],
    }


def solo_capacity_usd(model):
    """Listed Go Plus solo capacity for a model ($/month), or None."""
    return (PRICES.get(model) or {}).get("listed_limit_usd")


# --------------------------------------------------------------------------
# Text rendering
# --------------------------------------------------------------------------
def _usd(x):
    if x is None:
        return "—"
    if x >= 1:
        return f"{x:,.2f}"
    if x >= 0.001:
        return f"{x:.4f}"
    return f"{x:.6f}" if x else "0"


def _pct(x):
    return "—" if x is None else f"{x:.1f}%"


def _num(n):
    return f"{n:,}"


def render_text(rep):
    w = rep["window"]
    out = []
    add = out.append
    add("SEAT BURN — pi session-log token accounting by seat, model and OpenCode Go plan")
    add(f"window: {w['since']}..{w['until']} UTC ({w['days']} days, "
        f"{_num(w['messages'])} assistant messages)")
    add(f"sessions: {w['sessions_dir']}")
    add(f"spawn records: {w['meta_dir']} (pi-subagent-<session-id>.meta.json)")
    dq = rep["data_quality"]
    if dq["unpriced_tokens"]:
        add("NOTE: some token classes have no published price; those tokens are "
            "reported and excluded from $ burn (see PRICES + data quality).")

    seat_w = max([40] + [len(r["seat"]) for r in rep["seats"]]) + 1
    add("")
    add("== per-day by seat ==")
    add(f"{'date':<11}{'seat':<{seat_w}}{'raw tokens':>14}{'cache rd':>14}"
        f"{'cache wr':>11}{'in+out':>12}{'$ burn':>10}")
    for row in rep["daily"]["by_seat"]:
        add(f"{row['date']:<11}{row['seat']:<{seat_w}}{_num(row['raw_tokens']):>14}"
            f"{_num(row['cache_read']):>14}{_num(row['cache_write']):>11}"
            f"{_num(row['io_tokens']):>12}{_usd(row['burn_usd']):>10}")

    add("")
    add("== per-day by model ==")
    add(f"{'date':<11}{'model':<30}{'route':<14}{'raw tokens':>14}"
        f"{'cache rd':>14}{'in+out':>12}{'$ burn':>10}")
    for row in rep["daily"]["by_model"]:
        add(f"{row['date']:<11}{row['model']:<30}{row['route']:<14}"
            f"{_num(row['raw_tokens']):>14}{_num(row['cache_read']):>14}"
            f"{_num(row['io_tokens']):>12}{_usd(row['burn_usd']):>10}")

    add("")
    add("== window summary: seats ==")
    add(f"{'seat':<{seat_w}}{'raw tokens':>14}{'tok %':>8}{'$ burn':>10}{'$ %':>8}"
        f"{'pi $':>10}{'msgs':>7}  attribution")
    for row in rep["seats"]:
        add(f"{row['seat']:<{seat_w}}{_num(row['raw_tokens']):>14}"
            f"{_pct(row['token_share']):>8}{_usd(row['burn_usd']):>10}"
            f"{_pct(row['burn_share']):>8}{_usd(row['recorded_usd']):>10}"
            f"{_num(row['messages']):>7}  {row['attribution']}")
    t = rep["totals"]
    add(f"{'TOTAL':<{seat_w}}{_num(t['raw_tokens']):>14}{'100.0%':>8}"
        f"{_usd(t['burn_usd']):>10}{'100.0%':>8}{_usd(t['recorded_usd']):>10}"
        f"{_num(t['messages']):>7}")

    add("")
    add("== window summary: models ==")
    add(f"{'model':<30}{'route':<14}{'raw tokens':>14}{'cache %':>9}"
        f"{'$ burn':>10}{'pi $':>10}  price note")
    for row in rep["models"]:
        note = "price unknown" if row["unpriced_classes"] and row["burn_usd"] == 0 else ""
        if row["price_placeholder"]:
            note = (note + " " if note else "") + "PLACEHOLDER price"
        if row["peak_applied"]:
            note = (note + " " if note else "") + "peak ×2 applied"
        if row["unpriced_classes"] and note.find("price unknown") < 0:
            note = (note + " " if note else "") + "unpriced: " + ",".join(row["unpriced_classes"])
        add(f"{row['model']:<30}{row['route']:<14}{_num(row['raw_tokens']):>14}"
            f"{_pct(row['cache_pct']):>9}{_usd(row['burn_usd']):>10}"
            f"{_usd(row['recorded_usd']):>10}  {note}")

    add("")
    add("== OpenCode Go plan: per-model solo capacity (illustrative, NOT separate budgets) ==")
    add("one shared monthly allowance; the console meters Σ(real $ on model m ÷ solo")
    add("capacity_m) ≤ 1.0 — the per-model figure is what one model alone could consume")
    add("(opencode console quotaCost, github.com/anomalyco/opencode#54875)")
    add(f"{'model':<30}{'solo cap $':>11}{'raw tokens':>14}{'$ burn':>10}"
        f"{'$/day':>9}{'month proj':>11}{'solo use':>9}{'meter part':>12}")
    gp = rep["go_plan"]
    for row in gp["solo_capacity"]:
        note = " (placeholder price)" if row["placeholder_price"] else ""
        add(f"{row['model']:<30}{row['listed_limit_usd']:>11,.0f}{_num(row['raw_tokens']):>14}"
            f"{_usd(row['burn_usd']):>10}{_usd(row['burn_per_day']):>9}"
            f"{_usd(row['month_projected_usd']):>11}{_pct(row['solo_use_pct']):>9}"
            f"{row['meter_contribution']:>12.6f}{note}")
    meter = gp["meter"]
    add(f"PLAN-WIDE METER  Σ(real $ on model m ÷ solo capacity_m) over the window: "
        f"{meter['meter_window']:.6f}")
    add(f"  {meter['meter_per_day']:.6f}/day → month-projected {meter['month_projected']:.6f} "
        f"vs 1.0 ({_pct(meter['cap_use_pct'])} of the shared allowance) → "
        f"{'fits' if meter['fits'] else 'EXCEEDS'}")
    add("  self-check: /zen/go/v1/usage monthly percent (plan-wide, no per-model")
    add("  breakdown) — footer quota segment, decisions/external-tools/006; this")
    add("  tool performs no network I/O. The meter is biased where a price row")
    add("  leaves a class unpriced (understates) or carries a placeholder price")
    add("  (unknown direction — see the solo-capacity notes above).")
    if meter["excluded_models"]:
        add("  opencode-go models with no listed solo capacity (outside the meter): "
            + ", ".join(meter["excluded_models"]))
    add(f"  projection = window $ burn / {w['days']} days × 30")

    add("")
    add("== headline ==")
    h = rep["headline"]
    add(f"session+orchestrator seats = {_pct(h['token_share'])} of raw tokens, "
        f"{_pct(h['burn_share'])} of $ burn")
    add(f"  ({_num(h['raw_tokens'])} raw tokens, ${_usd(h['burn_usd'])} list-price "
        f"burn, ${_usd(h['recorded_usd'])} as charged by pi "
        f"[{_pct(h['recorded_share'])}])")
    add(f"  month-projected at observed pace: ${_usd(h['month_projected_usd'])} vs "
        f"{h['reference_model']}'s solo capacity (${h['reference_solo_capacity_usd']:,.0f}) → "
        f"{'fits' if h['fits_reference_capacity'] else 'EXCEEDS'} "
        f"({_pct(h['reference_cap_use_pct'])} of it)")
    add(f"  plan-wide meter for these seats: {h['plan_meter_month_projected']:.6f} "
        f"month-projected ({_pct(h['plan_meter_cap_use_pct'])} of the allowance, "
        f"{_pct(h['plan_meter_share_pct'])} of the whole plan meter)")

    add("")
    add("== data quality ==")
    add(f"files scanned: {_num(dq['files_scanned'])} (+{_num(dq['files_skipped_pre'])} "
        f"*.pre-* backups skipped), unreadable: {_num(dq['files_unreadable'])}, "
        f"unparseable lines: {_num(dq['bad_lines'])}")
    add("entry types seen in the scanned corpus: "
        + ", ".join(f"{k}={_num(v)}" for k, v in dq["entries_by_type"].items()))
    add(f"duplicate entry ids dropped (replay/branching, in window): "
        f"{_num(dq['duplicate_ids_dropped'])}")
    add(f"assistant messages without usage (in window): "
        f"{_num(dq['messages_without_usage'])}; "
        f"without totalTokens: {_num(dq['messages_without_total_tokens'])}; "
        f"totalTokens ≠ Σclasses: {_num(dq['total_tokens_mismatch'])}; "
        f"bad timestamps: {_num(dq['bad_timestamps'])}")
    if dq["messages_without_provider"]:
        add(f"messages without an envelope provider: "
            f"{_num(dq['messages_without_provider'])} (model_change: "
            f"{_num(dq['provider_from_model_change'])}, model-id prefix: "
            f"{_num(dq['provider_from_prefix'])}, unknown: "
            f"{_num(dq['provider_unknown'])})")
    add(f"spawn records joined: {_num(dq['meta_files'])}; without agentName: "
        f"{_num(dq['meta_without_agent'])}; unreadable: {_num(dq['meta_unreadable'])}"
        + (f"; meta dir missing: {dq['meta_dir_missing']}" if dq["meta_dir_missing"] else ""))
    add("attribution: " + (", ".join(f"{k}={_num(v)}"
                                     for k, v in dq["attribution_counts"].items()) or "none"))
    add(f"unattributed: {_num(dq['unattributed_raw_tokens'])} raw tokens "
        f"({_pct(dq['unattributed_share_pct'])}), ${_usd(dq['unattributed_burn_usd'])} "
        f"burn ({_pct(dq['unattributed_burn_share_pct'])}) — includes ambiguous groups")
    for group in dq["ambiguous_groups"]:
        add(f"  ambiguous group {group['group']}  [{group['signature']}]  "
            f"{_num(group['messages'])} messages")
    if dq["unpriced_tokens"]:
        add("unpriced token classes (excluded from $ burn):")
        for row in dq["unpriced_tokens"]:
            add(f"  {row['model']} {row['class']}: {_num(row['tokens'])} tokens — price unknown")
    add(f"pi-recorded cost (all providers, as charged): ${_usd(dq['recorded_cost_usd'])} vs "
        f"list-price burn ${_usd(dq['list_price_burn_usd'])}")

    add("")
    add("== model-id spellings (whole scanned corpus; canonical ← recorded) ==")
    for row in rep["spelling_inventory"]:
        add(f"  {row['model']} ← {', '.join(row['spellings'])}  [{', '.join(row['routes'])}]")

    add("")
    add("== seat signature table (derived from agents/*.md + settings.json) ==")
    for entry in rep["signature_table"]["entries"]:
        model = entry["model"] if entry["model"] else "<caller's model>"
        add(f"  {entry['agent']:<18} {model:<22} :{entry['level']:<7} "
            f"{entry['kind']:<7} {entry['source']}")
    for note in rep["signature_table"]["notes"]:
        add(f"  note: {note}")

    add("")
    add("== price table ($/M, list price per class) + Go Plus solo capacity ($/month) ==")
    add(f"{'model':<28}{'in':>7}{'out':>7}{'cache rd':>9}{'cache wr':>9}{'peak':>8}"
        f"{'solo cap $':>12}")
    for row in rep["price_table"]:
        def cell(v):
            return "unknown" if v is None else f"{v:g}"
        cap = ("—" if row["listed_limit_usd"] is None
               else f"{row['listed_limit_usd']:,.0f}")
        add(f"{row['model']:<28}{cell(row['input']):>7}{cell(row['output']):>7}"
            f"{cell(row['cache_read']):>9}{cell(row['cache_write']):>9}"
            f"{('×2' if row['peak'] else 'unknown'):>8}{cap:>12}")
    for row in rep["price_table"]:
        add(f"  {row['model']}: {row['source']}")
        if row["listed_limit_usd"] is not None:
            add(f"    solo capacity ${row['listed_limit_usd']:,.0f}/mo: {row['limit_source']}")
    return "\n".join(out)


# --------------------------------------------------------------------------
# CLI
# --------------------------------------------------------------------------
class Options:
    def __init__(self, **kw):
        self.__dict__.update(kw)


def parse_day(value, flag):
    try:
        return datetime.date.fromisoformat(value).isoformat()
    except ValueError:
        raise DataError(f"{flag} must be YYYY-MM-DD, got {value!r}")


def main(argv=None):
    ap = argparse.ArgumentParser(
        prog="seat_burn.py",
        description="Attribute pi session-log token usage to subagent seats and "
                    "the OpenCode Go plan allowance (read-only).")
    ap.add_argument("--since", metavar="YYYY-MM-DD",
                    help=f"first day (UTC) of the window; default: "
                         f"{DEFAULT_WINDOW_DAYS} days before the latest entry")
    ap.add_argument("--until", metavar="YYYY-MM-DD",
                    help="last day (UTC) of the window; default: today")
    ap.add_argument("--sessions-dir", default=DEFAULT_SESSIONS,
                    help=f"pi session log root (default: {DEFAULT_SESSIONS})")
    ap.add_argument("--meta-dir", default=DEFAULT_META_DIR,
                    help="subagent spawn-record dir (default: /tmp — where "
                         "extensions/subagent-async writes its meta.json files); "
                         "a test seam for fixture runs")
    ap.add_argument("--json", action="store_true", help="machine-readable report")
    ap.add_argument("--selftest", action="store_true",
                    help="run fixtures through the CLI and exit 0/1")
    args = ap.parse_args(argv)

    if args.selftest:
        return selftest()

    try:
        opts = Options(
            since=parse_day(args.since, "--since") if args.since else None,
            until=parse_day(args.until, "--until") if args.until else None,
            sessions_dir=os.path.abspath(os.path.expanduser(args.sessions_dir)),
            meta_dir=os.path.abspath(os.path.expanduser(args.meta_dir)),
        )
        rep = build_report(opts)
    except DataError as exc:
        print(f"seat_burn: {exc}", file=sys.stderr)
        return 2

    if args.json:
        json.dump(rep, sys.stdout, indent=2, sort_keys=False)
        sys.stdout.write("\n")
    else:
        print(render_text(rep))
    return 0


# --------------------------------------------------------------------------
# Selftest: fixtures through the CLI, one case per row of the WO-2026-053
# behavior matrix, plus an end-to-end golden of a small fixture window.
# --------------------------------------------------------------------------
def selftest():
    script = os.path.abspath(__file__)
    sessions = os.path.join(TESTDATA, "sessions")
    meta = os.path.join(TESTDATA, "meta")
    golden_path = os.path.join(TESTDATA, "golden", "report.txt")
    since, until = "2026-05-01", "2026-05-03"
    failures = []

    def fail(name, msg):
        failures.append(f"{name}: {msg}")

    def run(extra):
        return subprocess.run([sys.executable, script] + extra,
                              capture_output=True, text=True)

    def report(extra):
        proc = run(extra + ["--since", since, "--until", until, "--json"])
        if proc.returncode != 0:
            raise AssertionError(f"CLI failed ({proc.returncode}): {proc.stderr.strip()}")
        return json.loads(proc.stdout)

    def case(name, fn):
        try:
            fn()
            print(f"PASS {name}")
        except AssertionError as exc:
            print(f"FAIL {name}: {exc}")
            failures.append(f"{name}: {exc}")

    def _near(got, want, tol=1e-9):
        return got is not None and abs(got - want) < tol

    def seat_of(rep, seat):
        for row in rep["seats"]:
            if row["seat"] == seat:
                return row
        raise AssertionError(f"no seat row {seat!r}; got "
                             f"{[r['seat'] for r in rep['seats']]}")

    def model_row(rep, model, route):
        for row in rep["models"]:
            if row["model"] == model and row["route"] == route:
                return row
        raise AssertionError(f"no model row {model}/{route}; got "
                             f"{[(r['model'], r['route']) for r in rep['models']]}")

    all_json = {}

    def combined():
        all_json.update(report(["--sessions-dir", sessions, "--meta-dir", meta]))

    case("combined fixture run", combined)

    def case1():
        r = report(["--sessions-dir", os.path.join(sessions, "case01"),
                    "--meta-dir", meta])
        # One main-session file, model switched mid-file by a compaction-model
        # change: per-message model attribution, both rows on main-session.
        assert [row["date"] for row in r["daily"]["by_seat"]] == ["2026-05-01"], r["daily"]
        assert seat_of(r, MAIN_SEAT)["raw_tokens"] == 11100 + 2550 + 11100
        assert sorted(row["model"] for row in r["daily"]["by_model"]) == \
            ["deepseek-v4.1-flash", "glm-5.3-flash"]
        assert model_row(r, "glm-5.3-flash", GO_PROVIDER)["raw_tokens"] == 2550
        assert [row["seat"] for row in r["seats"]] == [MAIN_SEAT]

    case("1 main session + model_change mid-file", case1)

    def case2():
        r = report(["--sessions-dir", os.path.join(sessions, "case02"),
                    "--meta-dir", meta])
        # meta.json's agentName wins even though (model, level) would infer scouts.
        row = seat_of(r, "implement")
        assert row["attribution"] == "meta", row["attribution"]
        assert not [s for s in r["seats"] if s["seat"].startswith("ambiguous")]

    case("2 meta.json present → agentName", case2)

    def case3():
        r = report(["--sessions-dir", os.path.join(sessions, "case03"),
                    "--meta-dir", meta])
        row = seat_of(r, "math-algo-oracle")
        assert row["attribution"] == "signature", row["attribution"]
        assert r["data_quality"]["attribution_counts"].get("signature") == 1

    case("3 no meta, unique signature → inferred seat", case3)

    def case4():
        r = report(["--sessions-dir", os.path.join(sessions, "case04"),
                    "--meta-dir", meta])
        groups = [g["group"] for g in r["data_quality"]["ambiguous_groups"]]
        assert groups and groups[0].startswith(AMBIGUOUS_PREFIX + "review-code|"), groups
        assert "review-plan" in groups[0] and "review-tests" in groups[0], groups
        assert not [s for s in r["seats"]
                    if s["seat"] in ("review-code", "review-plan", "review-tests")], \
            "an ambiguous signature must never be resolved to one seat"
        assert r["data_quality"]["unattributed_share_pct"] == 100.0

    case("4 no meta, ambiguous signature → named group", case4)

    def case5():
        r = report(["--sessions-dir", os.path.join(sessions, "case05"),
                    "--meta-dir", meta])
        # Two distinct entry ids, replayed 3x and 2x: counted once each.
        assert seat_of(r, MAIN_SEAT)["raw_tokens"] == 110 + 110
        assert r["data_quality"]["duplicate_ids_dropped"] == 3

    case("5 duplicated entry ids counted once", case5)

    def case6():
        r = report(["--sessions-dir", os.path.join(sessions, "case06"),
                    "--meta-dir", meta])
        # Same model, bare and provider-prefixed: one canonical id, two routes.
        got = {(row["model"], row["route"]): row["raw_tokens"] for row in r["models"]}
        assert got == {("deepseek-v4.1-flash", "openrouter"): 1110,
                       ("deepseek-v4.1-flash", GO_PROVIDER): 111,
                       # m-c carries no envelope provider: routed by model_change
                       ("glm-5.3-flash", "zai"): 220}, got
        inv = {row["model"]: row["spellings"] for row in r["spelling_inventory"]}
        assert inv["deepseek-v4.1-flash"] == ["deepseek-v4.1-flash",
                                             "deepseek/deepseek-v4.1-flash"], inv
        assert r["data_quality"]["messages_without_provider"] == 1, r["data_quality"]
        assert r["data_quality"]["provider_from_model_change"] == 1, r["data_quality"]

    case("6 bare vs provider-prefixed spellings merged", case6)

    def case7():
        r = report(["--sessions-dir", os.path.join(sessions, "case07"),
                    "--meta-dir", meta])
        row = model_row(r, "deepseek-v4.1-flash-1017", "openrouter")
        assert row["solo_capacity_usd"] is None, "the -1017 checkpoint is a distinct model"
        assert not [m for m in r["models"] if m["solo_capacity_usd"]], r["models"]
        assert all(b["raw_tokens"] == 0 for b in r["go_plan"]["solo_capacity"]), r["go_plan"]
        assert r["go_plan"]["meter"]["meter_window"] == 0, r["go_plan"]["meter"]
        # ...and the caller-model inheritance rule seats it as orchestrator.
        assert seat_of(r, "orchestrator")["attribution"] == "signature"

    case("7 -1017 checkpoint via openrouter excluded from bucket math", case7)

    def case8():
        r = report(["--sessions-dir", os.path.join(sessions, "case08"),
                    "--meta-dir", meta])
        assert r["data_quality"]["messages_without_usage"] == 2, r["data_quality"]
        assert seat_of(r, MAIN_SEAT)["raw_tokens"] == 110
        assert r["data_quality"]["messages_without_total_tokens"] == 1

    case("8 missing/empty usage skipped and counted", case8)

    def case9():
        r = report(["--sessions-dir", os.path.join(sessions, "case09"),
                    "--meta-dir", meta])
        # Identical usage inside/outside the peak windows and on a weekend:
        # (1000*0.15 + 100*0.6 + 10000*0.003)/1e6 = 0.00024, doubled in peak.
        rows = {(row["date"], row["seat"]): row["burn_usd"]
                for row in r["daily"]["by_seat"]}
        assert _near(rows[("2026-05-01", MAIN_SEAT)], 0.00048), rows
        assert _near(rows[("2026-05-02", MAIN_SEAT)], 0.00024), rows
        assert _near(rows[("2026-05-03", MAIN_SEAT)], 0.00024), rows

    case("9 peak ×2 only inside weekday DS-Flash windows", case9)

    def case10():
        r = report(["--sessions-dir", os.path.join(sessions, "case10"),
                    "--meta-dir", meta])
        row = model_row(r, "deepseek-v4.1-flash", GO_PROVIDER)
        assert row["cache_write"] == 1000, row
        assert row["io_tokens"] == 1100, row
        # (1000*0.15 + 100*0.6 + 1000*0.003)/1e6 — cacheWrite not folded into input
        assert _near(row["burn_usd"], 0.000213), row
        unpriced = {(u["model"], u["class"]): u["tokens"]
                    for u in r["data_quality"]["unpriced_tokens"]}
        assert unpriced.get(("deepseek-v4.1-flash", "cache_write")) == 1000, unpriced

    case("10 nonzero cacheWrite priced as its own class", case10)

    def case11():
        absent = run(["--sessions-dir", os.path.join(TESTDATA, "no-such-dir"),
                      "--since", since, "--until", until])
        assert absent.returncode != 0, "missing sessions dir must fail"
        assert "not found" in absent.stderr, absent.stderr
        assert absent.stdout.strip() == "", "no report on a failed run"
        empty = run(["--sessions-dir", os.path.join(sessions, "case01"),
                     "--meta-dir", meta,
                     "--since", "2026-01-01", "--until", "2026-01-02"])
        assert empty.returncode != 0, "empty window must fail"
        assert "no assistant messages" in empty.stderr, empty.stderr
        bad = run(["--since", "01/05/2026"])
        assert bad.returncode != 0 and "YYYY-MM-DD" in bad.stderr, bad.stderr

    case("11 absent dir / empty window / bad date fail cleanly", case11)

    def case12():
        # Row 12 (real-log smoke run): the default window always covers the
        # newest entry, so it has data whenever the corpus exists at all.
        if not os.path.isdir(DEFAULT_SESSIONS):
            print("SKIP 12 real-log smoke run (no session logs on this host)")
            return
        proc = subprocess.run([sys.executable, script, "--json"],
                              capture_output=True, text=True)
        assert proc.returncode == 0, proc.stderr
        data = json.loads(proc.stdout)
        assert data["totals"]["messages"] > 0, data["totals"]
        assert data["window"]["until"] >= data["window"]["since"]

    case("12 real-log smoke run", case12)

    def golden():
        proc = run(["--sessions-dir", sessions, "--meta-dir", meta,
                    "--since", since, "--until", until])
        assert proc.returncode == 0, proc.stderr
        got = (proc.stdout
               .replace(os.path.abspath(sessions), "<SESSIONS>")
               .replace(os.path.abspath(meta), "<META>"))
        with open(golden_path, encoding="utf-8") as fh:
            want = fh.read()
        if got != want:
            import difflib
            diff = "".join(difflib.unified_diff(
                want.splitlines(True), got.splitlines(True),
                fromfile="golden/report.txt", tofile="stdout", n=2))
            raise AssertionError("text report differs from golden\n" + diff)

    case("end-to-end golden text report", golden)

    def golden_json():
        proc = run(["--sessions-dir", sessions, "--meta-dir", meta,
                    "--since", since, "--until", until, "--json"])
        assert proc.returncode == 0, proc.stderr
        data = json.loads(proc.stdout)
        # Same numbers in both directions: the JSON totals must match the
        # per-day rows it summarizes, and the seat shares must sum to 100.
        per_day = sum(row["raw_tokens"] for row in data["daily"]["by_seat"])
        assert per_day == data["totals"]["raw_tokens"], (per_day, data["totals"])
        per_seat = sum(row["raw_tokens"] for row in data["seats"])
        assert per_seat == data["totals"]["raw_tokens"], (per_seat, data["totals"])
        share = sum(row["token_share"] for row in data["seats"])
        assert abs(share - 100.0) < 0.5, share
        text = run(["--sessions-dir", sessions, "--meta-dir", meta,
                    "--since", since, "--until", until]).stdout
        assert f"{data['totals']['raw_tokens']:,}" in text, "text/JSON token mismatch"

    case("JSON mirrors the text numbers", golden_json)

    print()
    if failures:
        print(f"SELFTEST FAILED — {len(failures)} case(s) failed")
        return 1
    print("SELFTEST OK — all cases passed")
    return 0


if __name__ == "__main__":
    sys.exit(main())
