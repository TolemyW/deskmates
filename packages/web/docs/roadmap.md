# Roadmap

The bot management screen has a searchable roster, canonical SOUL instructions with saved version
and unsaved-draft handling, model overrides, approval rules and cron editing. Role is a display
description, not an instruction. SOUL edits invalidate that bot's SDK sessions for its next run;
active and parked work must finish first. New bots can be configured while their workspace is
stopped; older bots need one import of their physical SOUL file while it is available. Schedules
use the Gateway's displayed time zone and existing five-field cron contract. The test-conversation
button opens a normal one-bot thread; it does not automatically execute a test or alter run caps.

Roadmap: run list and replay improvements, knowledge history/pagination, cost by bot by day, and a
workspace screen that shows the lock and screen outside a thread.
