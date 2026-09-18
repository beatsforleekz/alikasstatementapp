-- Preserve imported Eddy identity while allowing a run artist to be linked
-- manually to an existing payee. The partial unique index prevents two rows
-- in one Eddy run from being linked to the same payee.

ALTER TABLE eddy_master_run_artists
  ADD COLUMN IF NOT EXISTS imported_artist_name TEXT;

UPDATE eddy_master_run_artists
SET imported_artist_name = artist_name
WHERE carryover_import_id IS NOT NULL
  AND imported_artist_name IS NULL;

DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM eddy_master_run_artists
    WHERE payee_id IS NOT NULL
    GROUP BY run_id, payee_id
    HAVING COUNT(*) > 1
  ) THEN
    RAISE EXCEPTION 'Cannot add Eddy run payee uniqueness: duplicate run/payee links already exist';
  END IF;
END $$;

CREATE UNIQUE INDEX IF NOT EXISTS uq_eddy_master_run_artist_payee
  ON eddy_master_run_artists(run_id, payee_id)
  WHERE payee_id IS NOT NULL;

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
      AND normalized_artist_name = v_row->>'normalized_artist_name'
    LIMIT 1;

    IF v_payee_artist_id IS NOT NULL
       AND v_name_artist_id IS NOT NULL
       AND v_payee_artist_id <> v_name_artist_id THEN
      RAISE EXCEPTION 'Selected payee and imported artist already exist as separate rows in this Eddy run';
    END IF;

    v_artist_id := COALESCE(v_payee_artist_id, v_name_artist_id);

    IF v_artist_id IS NULL THEN
      INSERT INTO eddy_master_run_artists (
        run_id, payee_id, artist_name, imported_artist_name,
        normalized_artist_name, email, previous_carryover, carryover_import_id
      ) VALUES (
        p_run_id,
        v_payee_id,
        v_row->>'artist_name',
        v_row->>'imported_artist_name',
        v_row->>'normalized_artist_name',
        NULLIF(v_row->>'email', ''),
        (v_row->>'previous_carryover')::NUMERIC,
        v_import_id
      );
    ELSE
      UPDATE eddy_master_run_artists
      SET payee_id = COALESCE(v_payee_id, payee_id),
          imported_artist_name = COALESCE(NULLIF(v_row->>'imported_artist_name', ''), imported_artist_name),
          email = COALESCE(NULLIF(v_row->>'email', ''), email),
          previous_carryover = (v_row->>'previous_carryover')::NUMERIC,
          carryover_import_id = v_import_id
      WHERE id = v_artist_id;
    END IF;
  END LOOP;

  RETURN v_import_id;
END;
$$ LANGUAGE plpgsql;
