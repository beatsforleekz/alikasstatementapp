-- ============================================================
-- EDDY MASTER RUNS
-- Lightweight administration for statements calculated in Eddy.
-- This module is deliberately separate from statement_records and
-- the contract-scoped statement calculation/carryover architecture.
-- ============================================================

CREATE TABLE eddy_master_runs (
  id                   UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  statement_period_id  UUID NOT NULL REFERENCES statement_periods(id) ON DELETE RESTRICT,
  currency             TEXT NOT NULL DEFAULT 'GBP' CHECK (char_length(currency) = 3),
  notes                TEXT,
  created_by           UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  created_at           TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at           TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(statement_period_id)
);

CREATE TABLE eddy_master_carryover_imports (
  id                   UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  run_id               UUID NOT NULL REFERENCES eddy_master_runs(id) ON DELETE CASCADE,
  file_name            TEXT NOT NULL,
  source_period_label  TEXT,
  column_mapping_json  JSONB NOT NULL DEFAULT '{}'::jsonb,
  row_count            INTEGER NOT NULL DEFAULT 0 CHECK (row_count >= 0),
  imported_by          UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  created_at           TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE eddy_master_run_artists (
  id                         UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  run_id                     UUID NOT NULL REFERENCES eddy_master_runs(id) ON DELETE CASCADE,
  payee_id                   UUID REFERENCES payees(id) ON DELETE SET NULL,
  artist_name                TEXT NOT NULL,
  normalized_artist_name     TEXT NOT NULL,
  email                      TEXT,
  previous_carryover         NUMERIC(18, 6) NOT NULL DEFAULT 0,
  status                     TEXT NOT NULL DEFAULT 'to_prepare'
                               CHECK (status IN ('to_prepare', 'ready', 'sent', 'carry_forward')),
  email_subject              TEXT,
  email_body                 TEXT,
  email_prepared_at          TIMESTAMPTZ,
  sent_at                    TIMESTAMPTZ,
  carryover_source_artist_id UUID REFERENCES eddy_master_run_artists(id) ON DELETE SET NULL,
  carryover_import_id        UUID REFERENCES eddy_master_carryover_imports(id) ON DELETE SET NULL,
  created_at                 TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at                 TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(run_id, normalized_artist_name)
);

CREATE TABLE eddy_master_statements (
  id             UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  run_artist_id  UUID NOT NULL REFERENCES eddy_master_run_artists(id) ON DELETE CASCADE,
  statement_label TEXT NOT NULL,
  amount          NUMERIC(18, 6) NOT NULL,
  file_reference  TEXT,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_eddy_master_runs_period ON eddy_master_runs(statement_period_id);
CREATE INDEX idx_eddy_master_artists_run ON eddy_master_run_artists(run_id);
CREATE INDEX idx_eddy_master_artists_payee ON eddy_master_run_artists(payee_id);
CREATE INDEX idx_eddy_master_artists_status ON eddy_master_run_artists(status);
CREATE INDEX idx_eddy_master_statements_artist ON eddy_master_statements(run_artist_id);
CREATE INDEX idx_eddy_master_carryover_imports_run ON eddy_master_carryover_imports(run_id);

CREATE TRIGGER trg_eddy_master_runs_updated_at
  BEFORE UPDATE ON eddy_master_runs
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

CREATE TRIGGER trg_eddy_master_artists_updated_at
  BEFORE UPDATE ON eddy_master_run_artists
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

CREATE TRIGGER trg_eddy_master_statements_updated_at
  BEFORE UPDATE ON eddy_master_statements
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

ALTER TABLE eddy_master_runs ENABLE ROW LEVEL SECURITY;
ALTER TABLE eddy_master_carryover_imports ENABLE ROW LEVEL SECURITY;
ALTER TABLE eddy_master_run_artists ENABLE ROW LEVEL SECURITY;
ALTER TABLE eddy_master_statements ENABLE ROW LEVEL SECURITY;

CREATE POLICY "staff_all_eddy_master_runs" ON eddy_master_runs FOR ALL TO authenticated
  USING (current_user_role() IN ('admin', 'staff'))
  WITH CHECK (current_user_role() IN ('admin', 'staff'));

CREATE POLICY "staff_all_eddy_master_carryover_imports" ON eddy_master_carryover_imports FOR ALL TO authenticated
  USING (current_user_role() IN ('admin', 'staff'))
  WITH CHECK (current_user_role() IN ('admin', 'staff'));

CREATE POLICY "staff_all_eddy_master_run_artists" ON eddy_master_run_artists FOR ALL TO authenticated
  USING (current_user_role() IN ('admin', 'staff'))
  WITH CHECK (current_user_role() IN ('admin', 'staff'));

CREATE POLICY "staff_all_eddy_master_statements" ON eddy_master_statements FOR ALL TO authenticated
  USING (current_user_role() IN ('admin', 'staff'))
  WITH CHECK (current_user_role() IN ('admin', 'staff'));

CREATE OR REPLACE FUNCTION commit_eddy_master_carryover_import(
  p_run_id UUID,
  p_file_name TEXT,
  p_source_period_label TEXT,
  p_column_mapping_json JSONB,
  p_rows JSONB
)
RETURNS UUID AS $$
DECLARE
  v_import_id UUID;
  v_row JSONB;
  v_artist_id UUID;
  v_payee_id UUID;
BEGIN
  IF current_user_role() NOT IN ('admin', 'staff') THEN
    RAISE EXCEPTION 'Only staff can import Eddy master carryovers';
  END IF;

  INSERT INTO eddy_master_carryover_imports (
    run_id, file_name, source_period_label, column_mapping_json, row_count, imported_by
  ) VALUES (
    p_run_id,
    p_file_name,
    NULLIF(p_source_period_label, ''),
    COALESCE(p_column_mapping_json, '{}'::jsonb),
    jsonb_array_length(COALESCE(p_rows, '[]'::jsonb)),
    auth.uid()
  ) RETURNING id INTO v_import_id;

  FOR v_row IN SELECT value FROM jsonb_array_elements(COALESCE(p_rows, '[]'::jsonb))
  LOOP
    v_payee_id := NULLIF(v_row->>'payee_id', '')::UUID;
    v_artist_id := NULL;

    SELECT id INTO v_artist_id
    FROM eddy_master_run_artists
    WHERE run_id = p_run_id
      AND (
        (v_payee_id IS NOT NULL AND payee_id = v_payee_id)
        OR normalized_artist_name = v_row->>'normalized_artist_name'
      )
    ORDER BY CASE WHEN v_payee_id IS NOT NULL AND payee_id = v_payee_id THEN 0 ELSE 1 END
    LIMIT 1;

    IF v_artist_id IS NULL THEN
      INSERT INTO eddy_master_run_artists (
        run_id, payee_id, artist_name, normalized_artist_name, email,
        previous_carryover, carryover_import_id
      ) VALUES (
        p_run_id,
        v_payee_id,
        v_row->>'artist_name',
        v_row->>'normalized_artist_name',
        NULLIF(v_row->>'email', ''),
        (v_row->>'previous_carryover')::NUMERIC,
        v_import_id
      );
    ELSE
      UPDATE eddy_master_run_artists
      SET payee_id = COALESCE(v_payee_id, payee_id),
          email = COALESCE(NULLIF(v_row->>'email', ''), email),
          previous_carryover = (v_row->>'previous_carryover')::NUMERIC,
          carryover_import_id = v_import_id
      WHERE id = v_artist_id;
    END IF;
  END LOOP;

  RETURN v_import_id;
END;
$$ LANGUAGE plpgsql;

COMMENT ON TABLE eddy_master_runs IS
  'Administrative runs for master statements already calculated in Eddy. Does not participate in statement generation.';
COMMENT ON TABLE eddy_master_run_artists IS
  'Artist-level Eddy statement administration, including opening carryover snapshots and manual email preparation.';
COMMENT ON TABLE eddy_master_statements IS
  'References and amounts copied from Eddy-produced master statement PDFs. Amounts are not recalculated by this app.';
