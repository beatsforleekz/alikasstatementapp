-- Some Eddy exports place one full negative contract balance on one payee and
-- near-zero placeholders on the others. Retain every raw value while storing
-- the shared contract negative used to derive each effective payee amount.

ALTER TABLE eddy_master_statements
  ADD COLUMN IF NOT EXISTS net_payee_subtotal_correction_source NUMERIC(24, 12);

ALTER TABLE eddy_master_statements
  DROP CONSTRAINT IF EXISTS eddy_master_statements_auto_correction_valid;

ALTER TABLE eddy_master_statements
  ADD CONSTRAINT eddy_master_statements_auto_correction_valid CHECK (
    (
      net_payee_subtotal_auto_corrected IS NULL
      AND net_payee_subtotal_correction_source IS NULL
    )
    OR (
      net_payee_subtotal_correction_source < 0
      AND eddy_payee_split_percent IS NOT NULL
      AND net_payee_subtotal_auto_corrected = ROUND(
        net_payee_subtotal_correction_source * eddy_payee_split_percent / 100,
        12
      )
    )
  );

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
  v_existing_statement_run_id UUID;
  v_carryover_source_artist_id UUID;
  v_opening_carryover NUMERIC;
  v_raw_net NUMERIC;
  v_split_percent NUMERIC;
  v_correction_source NUMERIC;
  v_auto_corrected_net NUMERIC;
  v_correction_reason TEXT;
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

    v_raw_net := (v_row->>'net_payee_subtotal')::NUMERIC;
    v_split_percent := NULLIF(v_row->>'payee_split_percent', '')::NUMERIC;
    v_correction_source := NULL;
    v_auto_corrected_net := NULL;
    v_correction_reason := NULL;

    IF COALESCE((v_row->>'duplicate_negative_correction')::BOOLEAN, FALSE) THEN
      v_correction_source := NULLIF(v_row->>'contract_negative_source', '')::NUMERIC;
      IF v_correction_source IS NULL OR v_correction_source >= 0 OR v_split_percent IS NULL THEN
        RAISE EXCEPTION 'Invalid shared-negative correction for Eddy Statement ID %', v_row->>'statement_id';
      END IF;
      IF v_raw_net <> v_correction_source AND ABS(v_raw_net) > 0.00000001 THEN
        RAISE EXCEPTION 'Eddy Statement ID % does not contain the shared negative or an effective-zero placeholder', v_row->>'statement_id';
      END IF;
      v_auto_corrected_net := ROUND(v_correction_source * v_split_percent / 100, 12);
      v_correction_reason := format(
        'Adjusted from Eddy contract-level negative balance using %s%% payee split',
        v_split_percent
      );
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
                    + COALESCE(SUM(COALESCE(
                        prior_statement.net_payee_subtotal_override,
                        prior_statement.net_payee_subtotal_auto_corrected,
                        prior_statement.net_payee_subtotal,
                        0
                      )), 0) >= 100
                 THEN 0
               ELSE prior_artist.previous_carryover
                    + COALESCE(SUM(COALESCE(
                        prior_statement.net_payee_subtotal_override,
                        prior_statement.net_payee_subtotal_auto_corrected,
                        prior_statement.net_payee_subtotal,
                        0
                      )), 0)
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
    v_existing_statement_run_id := NULL;

    SELECT s.id, a.run_id
      INTO v_existing_statement_id, v_existing_statement_run_id
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
        net_payee_subtotal, net_payee_subtotal_auto_corrected,
        net_payee_subtotal_correction_source,
        net_payee_subtotal_correction_reason, eddy_payee_split_percent
      ) VALUES (
        v_artist_id, v_row->>'contract_name', (v_row->>'final_due')::NUMERIC,
        p_file_name, v_import_id, v_row->>'period_ref', v_row->>'payee_name',
        NULLIF(v_row->>'eddy_payee_id', ''), NULLIF(v_row->>'contract_id', ''),
        v_row->>'statement_id', v_raw_net, v_auto_corrected_net,
        v_correction_source, v_correction_reason, v_split_percent
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
          net_payee_subtotal = v_raw_net,
          net_payee_subtotal_auto_corrected = v_auto_corrected_net,
          net_payee_subtotal_correction_source = v_correction_source,
          net_payee_subtotal_correction_reason = v_correction_reason,
          eddy_payee_split_percent = v_split_percent
      WHERE id = v_existing_statement_id;
    END IF;
  END LOOP;

  RETURN v_import_id;
END;
$$ LANGUAGE plpgsql;

COMMENT ON COLUMN eddy_master_statements.net_payee_subtotal_correction_source IS
  'Original shared Eddy contract-level negative used to derive the payee-specific corrected subtotal.';
