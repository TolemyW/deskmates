-- ADR-0052 decision 1: assistant-created groups have a structured audit entry.
INSERT INTO audit_actions (action) VALUES ('thread.create');
