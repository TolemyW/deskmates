-- ADR-0023 amendment 5 (issue #8): the shape of each forwarded request, counts and hashes only.
-- Every column is NULL when the body could not be read, and on rows from before this migration:
-- unknown, never zero.

-- `cache_control` markers anywhere in system, tools and messages.
ALTER TABLE model_requests ADD COLUMN cache_control_blocks INTEGER
  CHECK (cache_control_blocks IS NULL OR cache_control_blocks >= 0);

-- The system prompt: block count, characters, the prefix marked cacheable and the rest, and a
-- short hash per block (a JSON array of 16-hex-digit strings).
ALTER TABLE model_requests ADD COLUMN system_blocks INTEGER
  CHECK (system_blocks IS NULL OR system_blocks >= 0);
ALTER TABLE model_requests ADD COLUMN system_chars INTEGER
  CHECK (system_chars IS NULL OR system_chars >= 0);
ALTER TABLE model_requests ADD COLUMN system_static_sha256 TEXT;
ALTER TABLE model_requests ADD COLUMN system_dynamic_sha256 TEXT;
ALTER TABLE model_requests ADD COLUMN system_block_hashes_json TEXT
  CHECK (system_block_hashes_json IS NULL OR json_valid(system_block_hashes_json));

-- The tool list and the message list.
ALTER TABLE model_requests ADD COLUMN tools_count INTEGER
  CHECK (tools_count IS NULL OR tools_count >= 0);
ALTER TABLE model_requests ADD COLUMN tools_chars INTEGER
  CHECK (tools_chars IS NULL OR tools_chars >= 0);
ALTER TABLE model_requests ADD COLUMN messages_count INTEGER
  CHECK (messages_count IS NULL OR messages_count >= 0);
