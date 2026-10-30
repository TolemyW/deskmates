-- Issue #39 item 7: a Gateway model job (ADR-0023 amendment 1: round triage, SOUL proposals,
-- status inquiries, vision probes, approval review and presentation, Activity summaries, memory
-- recheck, organisation and consolidation) is a run of its own trigger kind, so run analytics
-- stop counting it as cron. Forward-only: earlier job rows keep `cron`, because nothing on an old
-- row tells a job from a cron run reliably enough to rewrite history.
INSERT INTO run_trigger_kinds (kind) VALUES ('model_job');
