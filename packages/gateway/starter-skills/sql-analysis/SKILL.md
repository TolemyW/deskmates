---
name: sql-analysis
description: Analyze a registered database through Deskmates connector tools and save reproducible results.
---

# SQL analysis

Use the registered database connector; never ask for or invent a connection string.

1. Call `connector_describe` to learn the named connector's capabilities and schemas.
2. Start with metadata or a small bounded read. Select explicit columns, add a row limit while exploring, and state the time zone and units.
3. Call `connector_validate` with the complete batch. Inspect the normalized plan and content hash before calling `connector_submit`.
4. Use a stable, task-specific idempotency key for a submission. Follow with `connector_status` and `connector_receipt`; do not guess whether a timed-out submission ran.
5. Save the query, parameters, connector receipt id, and result summary under `/work/analysis/<descriptive-name>/`. Use CSV for rows and Markdown for interpretation.
6. Cross-check totals, nulls, duplicates, joins, and date boundaries. Label estimates and incomplete data.

If no usable database connector is offered, stop and tell the operator to register the workspace database from Integrations. Account material stays in the connection subsystem and never belongs in this skill or a report.
