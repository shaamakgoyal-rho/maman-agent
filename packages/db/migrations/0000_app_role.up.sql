-- 0000: restricted application role.
-- Migrations run as the privileged connection user; every tenant transaction
-- drops to maman_app via SET LOCAL ROLE so PostgreSQL RLS actually applies
-- (superusers and table owners would otherwise bypass row-level security).

DO $$
BEGIN
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'maman_app') THEN
    CREATE ROLE maman_app NOLOGIN;
  END IF;
END
$$;

GRANT USAGE ON SCHEMA public TO maman_app;

-- Future tables/sequences created by the migration role get app grants automatically.
ALTER DEFAULT PRIVILEGES IN SCHEMA public
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO maman_app;
ALTER DEFAULT PRIVILEGES IN SCHEMA public
  GRANT USAGE, SELECT ON SEQUENCES TO maman_app;
