-- ============================================================
-- 003_dev_helpers.sql — OPTIONAL LOCAL DEVELOPMENT HELPERS
--
-- DO NOT run this in production.
-- Run only if you want to bypass Supabase Auth during local
-- development (e.g. before creating any auth users).
--
-- What it does: replaces the role-gated RLS policies with
-- open anon-accessible policies so the app works with the
-- anon key without a logged-in session.
--
-- To restore production policies, run the REVERT section below
-- (or simply re-run 001_schema.sql from scratch).
-- ============================================================

-- ============================================================
-- APPLY: enable anon access for local dev
-- ============================================================

DO $$
DECLARE
  tbl TEXT;
  tables TEXT[] := ARRAY[
    'payees', 'contracts', 'contract_payee_links', 'repertoire',
    'contract_repertoire_links', 'statement_periods', 'imports',
    'import_rows', 'statement_records', 'statement_line_summaries',
    'exceptions', 'statement_outputs', 'approval_log',
    'carryover_ledger', 'user_profiles', 'payee_user_links'
  ];
BEGIN
  FOREACH tbl IN ARRAY tables LOOP
    -- Drop all existing policies on this table
    EXECUTE format(
      'SELECT pg_catalog.pg_drop_policy(pol.polname::text, %L) '
      'FROM pg_catalog.pg_policy pol '
      'JOIN pg_catalog.pg_class cls ON pol.polrelid = cls.oid '
      'WHERE cls.relname = %L',
      tbl, tbl
    );
    -- Create a simple open policy for anon + authenticated
    EXECUTE format(
      'CREATE POLICY "dev_open_access" ON %I FOR ALL TO anon, authenticated USING (true) WITH CHECK (true)',
      tbl
    );
  END LOOP;
END $$;

-- ============================================================
-- REVERT: restore production role-gated policies
-- (re-run 001_schema.sql instead of this section if possible)
-- ============================================================

-- To revert, the cleanest approach is:
--   1. Drop all dev policies (reverse the DO block above)
--   2. Re-run only the RLS policy section of 001_schema.sql
-- This file does not include a revert block because re-running
-- 001_schema.sql on a fresh database is always cleaner.
