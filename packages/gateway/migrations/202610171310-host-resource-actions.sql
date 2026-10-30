-- ADR-0006 amendment 5 decision 13 (issue #14): the root's Remove and Re-attach of a host
-- resource finding are audited, one row per action, success or failure.
INSERT INTO audit_actions (action) VALUES ('host_resource.reattach'), ('host_resource.remove');
