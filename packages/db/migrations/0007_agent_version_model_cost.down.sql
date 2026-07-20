ALTER TABLE agent_versions DROP COLUMN IF EXISTS model_cost_usd;
ALTER TABLE agent_versions DROP COLUMN IF EXISTS model_output_tokens;
ALTER TABLE agent_versions DROP COLUMN IF EXISTS model_input_tokens;
