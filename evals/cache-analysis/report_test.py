"""Model-free regression cases for population boundaries and unknown usage."""

import sqlite3
import unittest

from report import analyze, cache_stats, distribution


class CacheAnalysisTest(unittest.TestCase):
    def request(self, **overrides):
        return dict(input_tokens=100, cache_read_tokens=50, cache_create_tokens=0,
                    system_static_sha256="static", cache_control_blocks=1,
                    system_chars=1000, tools_chars=2000, served_model="model", **overrides)

    def test_null_usage_is_neither_miss_nor_zero_in_token_denominator(self):
        complete = self.request()
        unknown = {**complete, "cache_read_tokens": None}
        partial = {**complete, "cache_create_tokens": None}
        miss = {**complete, "cache_read_tokens": 0}
        result = cache_stats([complete, unknown, partial, miss])
        self.assertEqual(result["cacheReadMissingShare"], .25)
        self.assertEqual(result["hits"], 2)
        self.assertEqual(result["misses"], 1)
        self.assertEqual(result["completePromptUsageRequests"], 2)
        self.assertEqual(result["tokenWeightedCacheReadShare"], 50 / 250)
        self.assertEqual(result["promptTokens"]["missing"], 2)

    def test_empty_window_has_no_rate_or_zero_latency(self):
        result = cache_stats([])
        self.assertIsNone(result["cacheReadMissingShare"])
        self.assertIsNone(result["hitShareAmongReported"])
        self.assertIsNone(result["tokenWeightedCacheReadShare"])
        self.assertEqual(distribution([None]),
                         {"observed": 0, "missing": 1, "p50": None, "p95": None})

    def test_messages_only_jobs_apart_and_half_open_window(self):
        db = sqlite3.connect(":memory:")
        db.executescript("""
          CREATE TABLE runs(id,config_json,run_type,workspace_id,bot_id,thread_id);
          CREATE TABLE model_requests(id,run_id,attempt,seq,ts,request_kind,
            input_tokens,cache_read_tokens,cache_create_tokens,system_static_sha256,
            cache_control_blocks,system_chars,tools_chars,served_model);
          CREATE TABLE run_events(run_id,attempt,ts,payload_json,kind,seq);
          INSERT INTO runs VALUES('agent','{}',NULL,'w','b','t');
          INSERT INTO runs VALUES('title','{}','activity_summary','w','b','t');
          INSERT INTO model_requests VALUES
            (1,'agent',1,1,'2026-10-16T01:00:00Z','messages',100,50,0,'s',1,1,2,'m'),
            (2,'agent',1,2,'2026-10-16T01:00:01Z','count_tokens',999,0,0,'s',1,1,2,'m'),
            (3,'title',1,1,'2026-10-16T01:00:02Z','messages',999,0,0,'s',1,1,2,'m'),
            (4,'agent',1,3,'2026-10-17T00:00:00Z','messages',999,0,0,'s',1,1,2,'m');
        """)
        result = analyze(db, "2026-10-16T00:00:00Z", "2026-10-17T00:00:00Z")
        self.assertEqual(result["excludedNonMessages"], 1)
        self.assertEqual(result["excludedJobs"], {"activity_summary": 1})
        self.assertEqual(result["allMessages"]["requests"], 2)
        self.assertEqual(result["agentMessages"]["requests"], 1)
        self.assertEqual(result["cohorts"][0]["session"], "unknown")
        # An old attempt's absent marks remain absent; do not invent a fresh start.
        self.assertEqual(result["context"]["sidecarStartedToQueryStartedMs"]["missing"], 1)
        self.assertNotIn('"model"', str(result))
        db.close()


if __name__ == "__main__":
    unittest.main()
