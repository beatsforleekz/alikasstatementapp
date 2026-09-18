-- Eddy Master Run corrections remain isolated from statement_records.
-- A replacement carryover import is a complete opening-balance snapshot;
-- Eddy statement overrides remain separate from imported Final Due values.

ALTER TABLE eddy_master_run_artists
  ADD COLUMN IF NOT EXISTS carryover_manually_adjusted_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS carryover_manually_adjusted_by UUID REFERENCES auth.users(id) ON DELETE SET NULL;

ALTER TABLE eddy_master_statements
  ADD COLUMN IF NOT EXISTS amount_override NUMERIC(24, 12),
  ADD COLUMN IF NOT EXISTS amount_overridden_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS amount_overridden_by UUID REFERENCES auth.users(id) ON DELETE SET NULL;

-- Artist-level carryover represents positive unpaid payable money only.
UPDATE eddy_master_run_artists
SET previous_carryover = 0
WHERE previous_carryover < 0;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'eddy_master_run_artists_nonnegative_carryover'
      AND conrelid = 'eddy_master_run_artists'::regclass
  ) THEN
    ALTER TABLE eddy_master_run_artists
      ADD CONSTRAINT eddy_master_run_artists_nonnegative_carryover
      CHECK (previous_carryover >= 0);
  END IF;
END $$;

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
  v_payee_artist_id UUID;
  v_name_artist_id UUID;
  v_source_balance NUMERIC;
  v_opening_carryover NUMERIC;
BEGIN
  IF current_user_role() NOT IN ('admin', 'staff') THEN
    RAISE EXCEPTION 'Only staff can import Eddy master carryovers';
  END IF;

  INSERT INTO eddy_master_carryover_imports (
    run_id, file_name, source_period_label, column_mapping_json, row_count, imported_by
  ) VALUES (
    p_run_id, p_file_name, NULLIF(p_source_period_label, ''),
    COALESCE(p_column_mapping_json, '{}'::jsonb),
    jsonb_array_length(COALESCE(p_rows, '[]'::jsonb)), auth.uid()
  ) RETURNING id INTO v_import_id;

  FOR v_row IN SELECT value FROM jsonb_array_elements(COALESCE(p_rows, '[]'::jsonb))
  LOOP
    v_payee_id := NULLIF(v_row->>'payee_id', '')::UUID;
    v_source_balance := (v_row->>'previous_carryover')::NUMERIC;
    v_opening_carryover := GREATEST(v_source_balance, 0);
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
        NULLIF(v_row->>'email', ''), v_opening_carryover,
        v_source_balance, v_import_id
      );
    ELSE
      UPDATE eddy_master_run_artists
      SET payee_id = COALESCE(v_payee_id, payee_id),
          imported_artist_name = COALESCE(NULLIF(v_row->>'imported_artist_name', ''), imported_artist_name),
          email = COALESCE(NULLIF(v_row->>'email', ''), email),
          previous_carryover = v_opening_carryover,
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

CREATE OR REPLACE FUNCTION replace_eddy_master_carryover_import(
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
  v_payee_artist_id UUID;
  v_name_artist_id UUID;
  v_source_balance NUMERIC;
  v_opening_carryover NUMERIC;
BEGIN
  IF current_user_role() NOT IN ('admin', 'staff') THEN
    RAISE EXCEPTION 'Only staff can replace Eddy master carryovers';
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

  -- Preserve artists, payee links, statuses, emails, and every Eddy statement.
  -- Only the opening-carryover snapshot is replaced.
  UPDATE eddy_master_run_artists
  SET previous_carryover = 0,
      imported_final_balance = NULL,
      carryover_import_id = NULL,
      carryover_source_artist_id = NULL,
      carryover_manually_adjusted_at = NULL,
      carryover_manually_adjusted_by = NULL
  WHERE run_id = p_run_id;

  FOR v_row IN SELECT value FROM jsonb_array_elements(COALESCE(p_rows, '[]'::jsonb))
  LOOP
    v_payee_id := NULLIF(v_row->>'payee_id', '')::UUID;
    v_source_balance := (v_row->>'previous_carryover')::NUMERIC;
    v_opening_carryover := GREATEST(v_source_balance, 0);
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
        NULLIF(v_row->>'email', ''), v_opening_carryover,
        v_source_balance, v_import_id
      );
    ELSE
      UPDATE eddy_master_run_artists
      SET payee_id = COALESCE(v_payee_id, payee_id),
          imported_artist_name = COALESCE(NULLIF(v_row->>'imported_artist_name', ''), imported_artist_name),
          email = COALESCE(NULLIF(v_row->>'email', ''), email),
          previous_carryover = v_opening_carryover,
          imported_final_balance = v_source_balance,
          carryover_import_id = v_import_id
      WHERE id = v_artist_id;
    END IF;
  END LOOP;

  RETURN v_import_id;
END;
$$ LANGUAGE plpgsql;

COMMENT ON COLUMN eddy_master_statements.amount_override IS
  'Optional administrative correction. Imported Final Due remains in amount.';
COMMENT ON COLUMN eddy_master_run_artists.imported_final_balance IS
  'Original carryover value from the latest Eddy carryover spreadsheet; negative source values produce a zero artist-level opening carryover.';
COMMENT ON FUNCTION replace_eddy_master_carryover_import IS
  'Atomically replaces opening carryovers for one Eddy Master Run without changing its Eddy statements.';
