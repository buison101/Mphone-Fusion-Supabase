-- Run from the default postgres database as a role allowed to create databases.
-- This block is intentionally non-destructive: it preserves an existing test DB.
SELECT 'CREATE DATABASE fusionpbx_analytics_test'
WHERE NOT EXISTS (
  SELECT FROM pg_database WHERE datname = 'fusionpbx_analytics_test'
)\gexec

COMMENT ON DATABASE fusionpbx_analytics_test IS
  'Isolated synthetic CDR data for FusionPBX analytics development';

