-- 0007: record the one-time model cost of compiling an agent version, so run
-- receipts can attribute the model cost of the version they executed.
ALTER TABLE agent_versions ADD COLUMN model_input_tokens bigint NOT NULL DEFAULT 0;
ALTER TABLE agent_versions ADD COLUMN model_output_tokens bigint NOT NULL DEFAULT 0;
ALTER TABLE agent_versions ADD COLUMN model_cost_usd numeric(14, 6) NOT NULL DEFAULT 0;
