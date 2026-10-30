-- Historical deliveries have no recoverable output snapshot; do not copy the current result.
ALTER TABLE task_deliveries ADD COLUMN output_json TEXT CHECK (output_json IS NULL OR json_valid(output_json));
