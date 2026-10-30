#!/usr/bin/env python3
"""Read-only, zero-token context/cache observations. Outputs counts and hashes only.

python3 evals/cache-analysis/report.py --db gateway.sqlite \
  --window 2026-10-17T00:00:00.000Z,2026-10-18T00:00:00.000Z \
  --window 2026-10-18T00:00:00.000Z,2026-10-19T00:00:00.000Z

Windows are half open, selected by request timestamp. They are observational,
not an A/B experiment. count_tokens and title/other model jobs never enter the
agent-request population. A missing usage field never means zero.
"""

import argparse
from collections import Counter, defaultdict
from datetime import datetime
import hashlib
import json
from pathlib import Path
import sqlite3


CONFIG_KEYS = (
    "runtime", "model", "cheapModel", "fallbackModel", "reasoning", "cliSurface",
    "browserRuntimeVersion", "browserSnapshotMode", "browserExecutionMode",
    "groupRouting", "memoryVersion", "knowledgeVersion", "knowledgeRetrieval",
    "visionPolicy", "desktopToolsVersion", "systemPromptStaticSha256",
)
CATEGORIES = (
    "System prompt", "System tools", "MCP tools", "Skills", "Messages",
)


def digest(value):
    return hashlib.sha256(json.dumps(value, sort_keys=True, separators=(",", ":"))
                          .encode()).hexdigest()[:16]


def distribution(values):
    observed = sorted(v for v in values if isinstance(v, (int, float)))
    def quantile(p):
        if not observed:
            return None
        import math
        return observed[max(0, math.ceil(p * len(observed)) - 1)]
    return {"observed": len(observed), "missing": len(values) - len(observed),
            "p50": quantile(.5), "p95": quantile(.95)}


def cache_stats(rows):
    n = len(rows)
    reported = [r for r in rows if r["cache_read_tokens"] is not None]
    complete = [r for r in reported if r["input_tokens"] is not None
                and r["cache_create_tokens"] is not None]
    denominator = sum(r["input_tokens"] + r["cache_read_tokens"]
                      + r["cache_create_tokens"] for r in complete)
    return {
        "requests": n,
        "cacheReadMissing": n - len(reported),
        "cacheReadMissingShare": (n - len(reported)) / n if n else None,
        "cacheReadReported": len(reported),
        "inputTokensMissing": sum(r["input_tokens"] is None for r in rows),
        "cacheCreateMissing": sum(r["cache_create_tokens"] is None for r in rows),
        "hits": sum(r["cache_read_tokens"] > 0 for r in reported),
        "misses": sum(r["cache_read_tokens"] == 0 for r in reported),
        "hitShareAmongReported": (sum(r["cache_read_tokens"] > 0 for r in reported)
                                   / len(reported) if reported else None),
        "completePromptUsageRequests": len(complete),
        "tokenWeightedCacheReadShare": (sum(r["cache_read_tokens"] for r in complete)
                                        / denominator if denominator else None),
        "promptTokens": distribution([
            r["input_tokens"] + r["cache_read_tokens"] + r["cache_create_tokens"]
            if all(r[k] is not None for k in (
                "input_tokens", "cache_read_tokens", "cache_create_tokens")) else None
            for r in rows]),
        "positiveCacheCreates": sum((r["cache_create_tokens"] or 0) > 0 for r in rows),
        "staticHashMissing": sum(r["system_static_sha256"] is None for r in rows),
        "distinctStaticHashes": len({r["system_static_sha256"] for r in rows
                                    if r["system_static_sha256"] is not None}),
        "withCacheControl": sum((r["cache_control_blocks"] or 0) > 0 for r in rows),
        "systemChars": distribution([r["system_chars"] for r in rows]),
        "toolSchemaChars": distribution([r["tools_chars"] for r in rows]),
        "servedModelHashes": dict(Counter(digest(r["served_model"]) if r["served_model"]
                                           else "not_reported" for r in rows)),
    }


def parse_time(value):
    return datetime.fromisoformat(value.replace("Z", "+00:00"))


def analyze(db, start, end):
    db.row_factory = sqlite3.Row
    rows = [dict(r) for r in db.execute(
        """SELECT q.*, r.config_json, r.run_type, r.workspace_id, r.bot_id,
                  r.thread_id
             FROM model_requests q JOIN runs r ON r.id=q.run_id
            WHERE q.request_kind='messages' AND q.ts>=? AND q.ts<?
            ORDER BY q.ts,q.id""", (start, end))]
    run_ids = {r["run_id"] for r in rows}
    # Restrict the SELECT to instrumentation. Never read tool input, output or chat text.
    event_rows = db.execute(
        """SELECT run_id,attempt,ts,payload_json,kind FROM run_events
            WHERE kind='model_retry' OR (kind='log' AND
              json_extract(payload_json,'$.source') IN ('run_timeline','context','sdk'))
            ORDER BY run_id,seq""")
    events = defaultdict(list)
    for event in event_rows:
        if event["run_id"] in run_ids:
            events[event["run_id"], event["attempt"]].append(dict(event))

    agents = [r for r in rows if r["run_type"] is None]
    groups = defaultdict(list)
    first_requests = {}
    for r in agents:
        attempt_key = r["run_id"], r["attempt"]
        marks = {}
        retries = 0
        for e in events[attempt_key]:
            if e["kind"] == "model_retry":
                retries += 1
            else:
                payload = json.loads(e["payload_json"])
                if payload.get("source") == "run_timeline":
                    marks[payload.get("mark")] = payload
        config = json.loads(r["config_json"])
        config_hash = digest({k: config.get(k) for k in CONFIG_KEYS})
        started = marks.get("attempt_started", {})
        sandbox = marks.get("sandbox_ready", {})
        cohort = (started.get("start", "unknown"), started.get("session", "unknown"),
                  sandbox.get("sandbox", "unknown"), "retried" if retries else "no-retry",
                  config_hash)
        groups[cohort].append(r)
        first_requests.setdefault(attempt_key, r)

    context_full = []
    prequery = []
    for key in first_requests:
        marks = {}
        full = None
        for e in events[key]:
            p = json.loads(e["payload_json"])
            if p.get("source") == "run_timeline":
                marks[p.get("mark")] = p.get("at")
            if (p.get("source") == "context" and p.get("kind") == "context_usage"
                    and p.get("detail") == "full" and full is None
                    and isinstance(p.get("totalTokens"), (int, float))):
                full = p
        if full is not None:
            context_full.append(full)
        left, right = marks.get("sidecar_started"), marks.get("query_started")
        prequery.append((parse_time(right) - parse_time(left)).total_seconds() * 1000
                        if left and right else None)

    categories = {}
    for name in CATEGORIES:
        categories[name] = distribution([
            next((c.get("tokens") for c in p.get("categories", [])
                  if c.get("name") == name), None) for p in context_full])
    return {
        "start": start, "end": end,
        "excludedNonMessages": db.execute(
            "SELECT count(*) FROM model_requests WHERE request_kind!='messages' AND ts>=? AND ts<?",
            (start, end)).fetchone()[0],
        "excludedJobs": dict(Counter(r["run_type"] for r in rows if r["run_type"])),
        "allMessages": cache_stats(rows), "agentMessages": cache_stats(agents),
        "agentFirstObservedRequestPerAttempt": cache_stats(list(first_requests.values())),
        "context": {
            "agentAttemptsWithMessages": len(first_requests),
            "fullSamples": len(context_full),
            "firstFullTotalTokens": distribution([p["totalTokens"] for p in context_full]),
            "firstFullCategories": categories,
            "sidecarStartedToQueryStartedMs": distribution(prequery),
            "prequeryMeaning": "Whole sidecar pre-query work, not isolated context construction",
        },
        "cohorts": [dict(zip(("start", "session", "sandbox", "retry", "configHash"), key),
                         **cache_stats(group)) for key, group in sorted(groups.items())],
        "privacy": "No prompt, tool result, model name, workspace identity or credential emitted",
    }


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--db", required=True)
    parser.add_argument("--window", action="append", required=True)
    args = parser.parse_args()
    windows = [w.split(",") for w in args.window]
    for start, end in windows:
        if parse_time(start) >= parse_time(end):
            parser.error("each window must have start < end")
    uri = Path(args.db).resolve().as_uri() + "?mode=ro"
    with sqlite3.connect(uri, uri=True) as db:
        db.execute("PRAGMA query_only=ON")
        print(json.dumps({"schema": 1, "windows": [analyze(db, *w) for w in windows]}, indent=2))


if __name__ == "__main__":
    main()
