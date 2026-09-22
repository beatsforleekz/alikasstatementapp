-- H1 2026 is the Eddy master reset point. Historical negative opening
-- carryovers stay reset; new closing balances may carry forward negatively.

ALTER TABLE eddy_master_run_artists
  DROP CONSTRAINT IF EXISTS eddy_master_run_artists_nonnegative_carryover;

ALTER TABLE eddy_master_statements
  ADD COLUMN IF NOT EXISTS net_payee_subtotal NUMERIC(24, 12),
  ADD COLUMN IF NOT EXISTS net_payee_subtotal_override NUMERIC(24, 12),
  ADD COLUMN IF NOT EXISTS net_payee_subtotal_overridden_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS net_payee_subtotal_overridden_by UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS eddy_payee_split_percent NUMERIC(18, 9);

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
  v_carryover_source_artist_id UUID;
  v_opening_carryover NUMERIC;
BEGIN
  IF current_user_role() NOT IN ('admin', 'staff') THEN
    RAISE EXCEPTION 'Only staff can import Eddy master statements';
  END IF;

  INSERT INTO eddy_master_statement_imports (
    run_id, file_name, period_ref, row_count, imported_by
  ) VALUES (
    p_run_id, p_file_name, p_period_ref,
    jsonb_array_length(COALESCE(p_rows, '[]'::jsonb)), auth.uid()
  ) RETURNING id INTO v_import_id;

  FOR v_row IN SELECT value FROM jsonb_array_elements(COALESCE(p_rows, '[]'::jsonb))
  LOOP
    IF v_row->>'period_ref' IS DISTINCT FROM p_period_ref THEN
      RAISE EXCEPTION 'Import row period does not match selected Eddy period';
    END IF;

    IF NULLIF(v_row->>'net_payee_subtotal', '') IS NULL THEN
      RAISE EXCEPTION 'Net Payee Subtotal is required for Eddy Statement ID %', v_row->>'statement_id';
    END IF;

    v_payee_id := NULLIF(v_row->>'payee_id', '')::UUID;
    v_artist_id := NULL;
    v_payee_artist_id := NULL;
    v_name_artist_id := NULL;

    SELECT id INTO v_payee_artist_id
    FROM eddy_master_run_artists
    WHERE run_id = p_run_id AND v_payee_id IS NOT NULL AND payee_id = v_payee_id
    LIMIT 1;

    SELECT id INTO v_name_artist_id
    FROM eddy_master_run_artists
    WHERE run_id = p_run_id
      AND normalized_artist_name = v_row->>'normalized_payee_name'
    LIMIT 1;

    IF v_payee_artist_id IS NOT NULL AND v_name_artist_id IS NOT NULL
       AND v_payee_artist_id <> v_name_artist_id THEN
      RAISE EXCEPTION 'Selected payee and Eddy payee name already exist as separate rows in this run';
    END IF;

    v_artist_id := COALESCE(v_payee_artist_id, v_name_artist_id);

    IF v_artist_id IS NULL THEN
      v_carryover_source_artist_id := NULL;
      v_opening_carryover := 0;

      SELECT prior_artist.id,
             CASE
               WHEN prior_artist.previous_carryover
                    + COALESCE(SUM(COALESCE(prior_statement.net_payee_subtotal_override, prior_statement.net_payee_subtotal, 0)), 0) >= 100
                 THEN 0
               ELSE prior_artist.previous_carryover
                    + COALESCE(SUM(COALESCE(prior_statement.net_payee_subtotal_override, prior_statement.net_payee_subtotal, 0)), 0)
             END
        INTO v_carryover_source_artist_id, v_opening_carryover
      FROM eddy_master_run_artists prior_artist
      JOIN eddy_master_runs prior_run ON prior_run.id = prior_artist.run_id
      JOIN statement_periods prior_period ON prior_period.id = prior_run.statement_period_id
      JOIN eddy_master_runs current_run ON current_run.id = p_run_id
      JOIN statement_periods current_period ON current_period.id = current_run.statement_period_id
      LEFT JOIN eddy_master_statements prior_statement ON prior_statement.run_artist_id = prior_artist.id
      WHERE prior_period.period_end < current_period.period_start
        AND (
          (v_payee_id IS NOT NULL AND prior_artist.payee_id = v_payee_id)
          OR prior_artist.normalized_artist_name = v_row->>'normalized_payee_name'
        )
      GROUP BY prior_artist.id, prior_artist.previous_carryover, prior_period.period_end
      ORDER BY prior_period.period_end DESC
      LIMIT 1;

      INSERT INTO eddy_master_run_artists (
        run_id, payee_id, artist_name, imported_artist_name,
        normalized_artist_name, email, previous_carryover,
        carryover_source_artist_id
      ) VALUES (
        p_run_id, v_payee_id, v_row->>'payee_name', v_row->>'payee_name',
        v_row->>'normalized_payee_name', NULLIF(v_row->>'email', ''),
        COALESCE(v_opening_carryover, 0), v_carryover_source_artist_id
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
        eddy_payee_id, eddy_contract_id, eddy_statement_id,
        net_payee_subtotal, eddy_payee_split_percent
      ) VALUES (
        v_artist_id, v_row->>'contract_name', (v_row->>'final_due')::NUMERIC,
        p_file_name, v_import_id, v_row->>'period_ref', v_row->>'payee_name',
        NULLIF(v_row->>'eddy_payee_id', ''), NULLIF(v_row->>'contract_id', ''),
        v_row->>'statement_id', (v_row->>'net_payee_subtotal')::NUMERIC,
        NULLIF(v_row->>'payee_split_percent', '')::NUMERIC
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
          eddy_contract_id = NULLIF(v_row->>'contract_id', ''),
          net_payee_subtotal = (v_row->>'net_payee_subtotal')::NUMERIC,
          eddy_payee_split_percent = NULLIF(v_row->>'payee_split_percent', '')::NUMERIC
      WHERE id = v_existing_statement_id;
    END IF;
  END LOOP;

  RETURN v_import_id;
END;
$$ LANGUAGE plpgsql;

-- Shared implementation keeps first-time and replacement carryover imports
-- consistent while allowing negative post-reset carryovers in future runs.
CREATE OR REPLACE FUNCTION apply_eddy_master_carryover_import(
  p_run_id UUID,
  p_file_name TEXT,
  p_source_period_label TEXT,
  p_column_mapping_json JSONB,
  p_rows JSONB,
  p_replace BOOLEAN
)
RETURNS UUID AS $$
DECLARE
  v_import_id UUID;
  v_row JSONB;
  v_artist_id UUID;
  v_payee_id UUID;
  v_payee_artist_id UUID;
  v_name_artist_id UUID;
  v_source_balance NUMERIC;
BEGIN
  IF current_user_role() NOT IN ('admin', 'staff') THEN
    RAISE EXCEPTION 'Only staff can import Eddy master carryovers';
  END IF;

  IF NOT EXISTS (SELECT 1 FROM eddy_master_runs WHERE id = p_run_id) THEN
    RAISE EXCEPTION 'Eddy Master Run not found';
  END IF;

  INSERT INTO eddy_master_carryover_imports (
    run_id, file_name, source_period_label, column_mapping_json, row_count, imported_by
  ) VALUES (
    p_run_id, p_file_name, NULLIF(p_source_period_label, ''),
    COALESCE(p_column_mapping_json, '{}'::jsonb),
    jsonb_array_length(COALESCE(p_rows, '[]'::jsonb)), auth.uid()
  ) RETURNING id INTO v_import_id;

  IF p_replace THEN
    UPDATE eddy_master_run_artists
    SET previous_carryover = 0,
        imported_final_balance = NULL,
        carryover_import_id = NULL,
        carryover_source_artist_id = NULL,
        carryover_manually_adjusted_at = NULL,
        carryover_manually_adjusted_by = NULL
    WHERE run_id = p_run_id;
  END IF;

  FOR v_row IN SELECT value FROM jsonb_array_elements(COALESCE(p_rows, '[]'::jsonb))
  LOOP
    v_payee_id := NULLIF(v_row->>'payee_id', '')::UUID;
    v_source_balance := (v_row->>'previous_carryover')::NUMERIC;
    v_artist_id := NULL;
    v_payee_artist_id := NULL;
    v_name_artist_id := NULL;

    SELECT id INTO v_payee_artist_id
    FROM eddy_master_run_artists
    WHERE run_id = p_run_id AND v_payee_id IS NOT NULL AND payee_id = v_payee_id
    LIMIT 1;

    SELECT id INTO v_name_artist_id
    FROM eddy_master_run_artists
    WHERE run_id = p_run_id
      AND normalized_artist_name = v_row->>'normalized_artist_name'
    LIMIT 1;

    IF v_payee_artist_id IS NOT NULL AND v_name_artist_id IS NOT NULL
       AND v_payee_artist_id <> v_name_artist_id THEN
      RAISE EXCEPTION 'Selected payee and imported artist already exist as separate rows in this Eddy run';
    END IF;

    v_artist_id := COALESCE(v_payee_artist_id, v_name_artist_id);

    IF v_artist_id IS NULL THEN
      INSERT INTO eddy_master_run_artists (
        run_id, payee_id, artist_name, imported_artist_name,
        normalized_artist_name, email, previous_carryover,
        imported_final_balance, carryover_import_id
      ) VALUES (
        p_run_id, v_payee_id, v_row->>'artist_name',
        v_row->>'imported_artist_name', v_row->>'normalized_artist_name',
        NULLIF(v_row->>'email', ''), v_source_balance, v_source_balance, v_import_id
      );
    ELSE
      UPDATE eddy_master_run_artists
      SET payee_id = COALESCE(v_payee_id, payee_id),
          imported_artist_name = COALESCE(NULLIF(v_row->>'imported_artist_name', ''), imported_artist_name),
          email = COALESCE(NULLIF(v_row->>'email', ''), email),
          previous_carryover = v_source_balance,
          imported_final_balance = v_source_balance,
          carryover_import_id = v_import_id,
          carryover_manually_adjusted_at = NULL,
          carryover_manually_adjusted_by = NULL
      WHERE id = v_artist_id;
    END IF;
  END LOOP;

  RETURN v_import_id;
END;
$$ LANGUAGE plpgsql;

CREATE OR REPLACE FUNCTION commit_eddy_master_carryover_import(
  p_run_id UUID,
  p_file_name TEXT,
  p_source_period_label TEXT,
  p_column_mapping_json JSONB,
  p_rows JSONB
)
RETURNS UUID AS $$
  SELECT apply_eddy_master_carryover_import(
    p_run_id, p_file_name, p_source_period_label,
    p_column_mapping_json, p_rows, FALSE
  );
$$ LANGUAGE SQL;

CREATE OR REPLACE FUNCTION replace_eddy_master_carryover_import(
  p_run_id UUID,
  p_file_name TEXT,
  p_source_period_label TEXT,
  p_column_mapping_json JSONB,
  p_rows JSONB
)
RETURNS UUID AS $$
  SELECT apply_eddy_master_carryover_import(
    p_run_id, p_file_name, p_source_period_label,
    p_column_mapping_json, p_rows, TRUE
  );
$$ LANGUAGE SQL;

COMMENT ON COLUMN eddy_master_statements.amount IS
  'Original Eddy Final Due, retained for reference only.';
COMMENT ON COLUMN eddy_master_statements.net_payee_subtotal IS
  'Original Eddy Net Payee Subtotal used for current-period master balance calculations.';
COMMENT ON COLUMN eddy_master_statements.net_payee_subtotal_override IS
  'Optional administrative correction to Net Payee Subtotal; original source remains unchanged.';
COMMENT ON COLUMN eddy_master_statements.eddy_payee_split_percent IS
  'Eddy Payee Split percentage retained for reference; never reapplied to Net Payee Subtotal.';
