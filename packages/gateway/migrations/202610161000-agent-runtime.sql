-- ADR-0042 decision 1 and 6: a bot may name the agent loop its runs use, and a stored SDK
-- session belongs to the runtime that wrote it. NULL on a bot means the installation default;
-- every session row that exists today was written by the Claude Agent SDK.
ALTER TABLE bots ADD COLUMN runtime TEXT
  CHECK (runtime IS NULL OR runtime IN ('claude-agent-sdk', 'openai-agents'));
ALTER TABLE bot_sessions ADD COLUMN runtime TEXT NOT NULL DEFAULT 'claude-agent-sdk'
  CHECK (runtime IN ('claude-agent-sdk', 'openai-agents'));
