-- Import standard Eddy Statements List exports into an Eddy Master Run.
-- Eddy remains the source of all statement accounting; this stores only
-- source identifiers, labels, Final Due, and import provenance.

CREATE TABLE eddy_master_statement_imports (
  id          UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  run_id      UUID NOT NULL REFERENCES eddy_master_runs(id) ON DELETE CASCADE,
  file_name   TEXT NOT NULL,
  period_ref  TEXT NOT NULL,
  row_count   INTEGER NOT NULL DEFAULT 0 CHECK (row_count >= 0),
  imported_by UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

ALTER TABLE eddy_master_statements
  ALTER COLUMN amount TYPE NUMERIC(24, 12),
  ADD COLUMN IF NOT EXISTS statement_import_id UUID REFERENCES eddy_master_statement_imports(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS eddy_period_ref TEXT,
  ADD COLUMN IF NOT EXISTS eddy_payee_name TEXT,
  ADD COLUMN IF NOT EXISTS eddy_payee_id TEXT,
  ADD COLUMN IF NOT EXISTS eddy_contract_id TEXT,
  ADD COLUMN IF NOT EXISTS eddy_statement_id TEXT;

CREATE INDEX IF NOT EXISTS idx_eddy_master_statement_imports_run
  ON eddy_master_statement_imports(run_id);

CREATE INDEX IF NOT EXISTS idx_eddy_master_statements_contract_id
  ON eddy_master_statements(eddy_contract_id);

CREATE UNIQUE INDEX IF NOT EXISTS uq_eddy_master_statement_id
  ON eddy_master_statements(eddy_statement_id)
  WHERE eddy_statement_id IS NOT NULL;

ALTER TABLE eddy_master_statement_imports ENABLE ROW LEVEL SECURITY;

CREATE POLICY "staff_all_eddy_master_statement_imports"
  ON eddy_master_statement_imports FOR ALL TO authenticated
  USING (current_user_role() IN ('admin', 'staff'))
  WITH CHECK (current_user_role() IN ('admin', 'staff'));

CREATE OR REPLACE FUNCTION commit_eddy_master_statement_import(
  p_run_id UUID,
  p_file_name TEXT,
  p_period_ref TEXT,
  p_rows JSONB
)
RETURNS UUID AS $$
DECLARE
  v_import_id UUID;
  v_row JSONB;
  v_payee_id UUID;
  v_artist_id UUID;
  v_payee_artist_id UUID;
  v_name_artist_id UUID;
  v_existing_statement_id UUID;
  v_existing_statement_artist_id UUID;
  v_existing_statement_run_id UUID;
BEGIN
  IF current_user_role() NOT IN ('admin', 'staff') THEN
    RAISE EXCEPTION 'Only staff can import Eddy master statements';
  END IF;

  INSERT INTO eddy_master_statement_imports (
    run_id, file_name, period_ref, row_count, imported_by
  ) VALUES (
    p_run_id,
    p_file_name,
    p_period_ref,
    jsonb_array_length(COALESCE(p_rows, '[]'::jsonb)),
    auth.uid()
  ) RETURNING id INTO v_import_id;

  FOR v_row IN SELECT value FROM jsonb_array_elements(COALESCE(p_rows, '[]'::jsonb))
  LOOP
    IF v_row->>'period_ref' IS DISTINCT FROM p_period_ref THEN
      RAISE EXCEPTION 'Import row period does not match selected Eddy period';
    END IF;

    v_payee_id := NULLIF(v_row->>'payee_id', '')::UUID;
    v_artist_id := NULL;
    v_payee_artist_id := NULL;
    v_name_artist_id := NULL;

    SELECT id INTO v_payee_artist_id
    FROM eddy_master_run_artists
    WHERE run_id = p_run_id
      AND v_payee_id IS NOT NULL
      AND payee_id = v_payee_id
    LIMIT 1;

    SELECT id INTO v_name_artist_id
    FROM eddy_master_run_artists
    WHERE run_id = p_run_id
      AND normalized_artist_name = v_row->>'normalized_payee_name'
    LIMIT 1;

    IF v_payee_artist_id IS NOT NULL
       AND v_name_artist_id IS NOT NULL
       AND v_payee_artist_id <> v_name_artist_id THEN
      RAISE EXCEPTION 'Selected payee and Eddy payee name already exist as separate rows in this run';
    END IF;

    v_artist_id := COALESCE(v_payee_artist_id, v_name_artist_id);

    IF v_artist_id IS NULL THEN
      INSERT INTO eddy_master_run_artists (
        run_id, payee_id, artist_name, imported_artist_name,
        normalized_artist_name, email, previous_carryover
      ) VALUES (
        p_run_id,
        v_payee_id,
        v_row->>'payee_name',
        v_row->>'payee_name',
        v_row->>'normalized_payee_name',
        NULLIF(v_row->>'email', ''),
        0
      ) RETURNING id INTO v_artist_id;
    ELSE
      UPDATE eddy_master_run_artists
      SET payee_id = COALESCE(v_payee_id, payee_id),
          imported_artist_name = COALESCE(imported_artist_name, NULLIF(v_row->>'payee_name', '')),
          email = COALESCE(email, NULLIF(v_row->>'email', ''))
      WHERE id = v_artist_id;
    END IF;

    v_existing_statement_id := NULL;
    v_existing_statement_artist_id := NULL;
    v_existing_statement_run_id := NULL;

    SELECT s.id, s.run_artist_id, a.run_id
      INTO v_existing_statement_id, v_existing_statement_artist_id, v_existing_statement_run_id
    FROM eddy_master_statements s
    JOIN eddy_master_run_artists a ON a.id = s.run_artist_id
    WHERE s.eddy_statement_id = v_row->>'statement_id'
    LIMIT 1;

    IF v_existing_statement_id IS NOT NULL AND v_existing_statement_run_id <> p_run_id THEN
      RAISE EXCEPTION 'Eddy Statement ID % already belongs to another run', v_row->>'statement_id';
    END IF;

    IF v_existing_statement_id IS NULL THEN
      INSERT INTO eddy_master_statements (
        run_artist_id, statement_label, amount, file_reference,
        statement_import_id, eddy_period_ref, eddy_payee_name,
        eddy_payee_id, eddy_contract_id, eddy_statement_id
      ) VALUES (
        v_artist_id,
        v_row->>'contract_name',
        (v_row->>'final_due')::NUMERIC,
        p_file_name,
        v_import_id,
        v_row->>'period_ref',
        v_row->>'payee_name',
        NULLIF(v_row->>'eddy_payee_id', ''),
        NULLIF(v_row->>'contract_id', ''),
        v_row->>'statement_id'
      );
    ELSE
      UPDATE eddy_master_statements
      SET run_artist_id = v_artist_id,
          statement_label = v_row->>'contract_name',
          amount = (v_row->>'final_due')::NUMERIC,
          file_reference = p_file_name,
          statement_import_id = v_import_id,
          eddy_period_ref = v_row->>'period_ref',
          eddy_payee_name = v_row->>'payee_name',
          eddy_payee_id = NULLIF(v_row->>'eddy_payee_id', ''),
          eddy_contract_id = NULLIF(v_row->>'contract_id', '')
      WHERE id = v_existing_statement_id;
    END IF;
  END LOOP;

  RETURN v_import_id;
END;
$$ LANGUAGE plpgsql;
