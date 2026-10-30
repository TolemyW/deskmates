-- An identical retry of the latest unchanged delivery returns its original receipt.
-- Historical deliveries remain readable; their first post-upgrade retry is not guessed.
ALTER TABLE task_deliveries ADD COLUMN request_sha256 TEXT
  CHECK (request_sha256 IS NULL OR length(request_sha256) = 64);
ALTER TABLE task_deliveries ADD COLUMN task_version INTEGER
  CHECK (task_version IS NULL OR task_version >= 1);
