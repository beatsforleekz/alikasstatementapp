-- Future Eddy runs carry only unpaid positive balances below the payment
-- threshold. H1 2026 opening balances are an imported reset snapshot and are
-- never changed by this trigger.
CREATE OR REPLACE FUNCTION eddy_master_effective_final_due(
  p_statement eddy_master_statements
)
RETURNS NUMERIC AS $$
DECLARE
  v_amount NUMERIC;
BEGIN
  v_amount := COALESCE(p_statement.amount_override, p_statement.amount, 0);

  -- Only PDF-verified H1 shared deficits are allocated here. Feature/FAC
  -- contracts and all other statements stay raw unless manually overridden.
  IF p_statement.amount_override IS NULL
     AND p_statement.eddy_period_ref = 'H1 2026'
     AND p_statement.eddy_payee_split_percent IS NOT NULL THEN
    v_amount := CASE p_statement.eddy_contract_id
      WHEN '399496' THEN p_statement.amount * p_statement.eddy_payee_split_percent / 100
      WHEN '399497' THEN p_statement.amount * p_statement.eddy_payee_split_percent / 100
      WHEN '379441' THEN p_statement.amount * p_statement.eddy_payee_split_percent / 100
      WHEN '374299' THEN p_statement.amount * p_statement.eddy_payee_split_percent / 100
      WHEN '384774' THEN p_statement.amount * p_statement.eddy_payee_split_percent / 100
      WHEN '384775' THEN -233.38 * p_statement.eddy_payee_split_percent / 100
      WHEN '384496' THEN -732.72 * p_statement.eddy_payee_split_percent / 100
      WHEN '399494' THEN -542.509723691 * p_statement.eddy_payee_split_percent / 100
      WHEN '399492' THEN -674.597790053 * p_statement.eddy_payee_split_percent / 100
      WHEN '399493' THEN -752.63738014 * p_statement.eddy_payee_split_percent / 100
      WHEN '379447' THEN -311.29 * p_statement.eddy_payee_split_percent / 100
      WHEN '374303' THEN -135.723897799 * p_statement.eddy_payee_split_percent / 100
      ELSE v_amount
    END;
  END IF;

  RETURN CASE WHEN ABS(v_amount) < 0.00001 THEN 0 ELSE v_amount END;
END;
$$ LANGUAGE plpgsql IMMUTABLE;

CREATE OR REPLACE FUNCTION seed_eddy_future_positive_carryover()
RETURNS TRIGGER AS $$
DECLARE
  v_current_period_start DATE;
  v_reset_period_end DATE;
  v_prior_closing NUMERIC;
  v_rounded_closing NUMERIC;
BEGIN
  IF NEW.carryover_source_artist_id IS NULL THEN
    RETURN NEW;
  END IF;

  SELECT p.period_start INTO v_current_period_start
  FROM eddy_master_runs r
  JOIN statement_periods p ON p.id = r.statement_period_id
  WHERE r.id = NEW.run_id;

  SELECT period_end INTO v_reset_period_end
  FROM statement_periods
  WHERE year = 2026 AND half = 'H1'
  LIMIT 1;

  IF v_current_period_start IS NULL OR v_reset_period_end IS NULL
     OR v_current_period_start <= v_reset_period_end THEN
    RETURN NEW;
  END IF;

  SELECT a.previous_carryover
         + COALESCE(SUM(eddy_master_effective_final_due(s)), 0)
    INTO v_prior_closing
  FROM eddy_master_run_artists a
  LEFT JOIN eddy_master_statements s ON s.run_artist_id = a.id
  WHERE a.id = NEW.carryover_source_artist_id
  GROUP BY a.previous_carryover;

  v_rounded_closing := ROUND(COALESCE(v_prior_closing, 0), 2);
  NEW.previous_carryover := CASE
    WHEN v_rounded_closing > 0 AND v_rounded_closing < 100
      THEN v_rounded_closing
    ELSE 0
  END;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS seed_eddy_future_positive_carryover_trigger
  ON eddy_master_run_artists;
CREATE TRIGGER seed_eddy_future_positive_carryover_trigger
BEFORE INSERT ON eddy_master_run_artists
FOR EACH ROW EXECUTE FUNCTION seed_eddy_future_positive_carryover();

COMMENT ON FUNCTION seed_eddy_future_positive_carryover() IS
  'For post-H1-2026 Eddy runs, seeds only prior positive closing balances below 100; negatives and payable balances seed zero.';
