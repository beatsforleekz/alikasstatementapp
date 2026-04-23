-- Durable sub-cent allocation carry ledger.
-- Stores final allocated amounts that round to 0.00 so they can accumulate
-- safely without inflating statement totals.

CREATE TABLE IF NOT EXISTS micro_allocation_ledger (
  id                          UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  source_import_row_id         UUID REFERENCES import_rows(id) ON DELETE SET NULL,
  statement_period_id          UUID NOT NULL REFERENCES statement_periods(id) ON DELETE RESTRICT,
  contract_id                  UUID NOT NULL REFERENCES contracts(id) ON DELETE RESTRICT,
  payee_id                     UUID NOT NULL REFERENCES payees(id) ON DELETE RESTRICT,
  domain                       TEXT NOT NULL CHECK (domain IN ('master', 'publishing')),
  carry_key                    TEXT NOT NULL,
  title                        TEXT,
  identifier                   TEXT,
  income_type                  TEXT,
  currency                     TEXT NOT NULL DEFAULT 'GBP',
  raw_amount                   NUMERIC(24,12) NOT NULL,
  status                       TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'released')),
  released_statement_record_id UUID REFERENCES statement_records(id) ON DELETE SET NULL,
  released_at                  TIMESTAMPTZ,
  notes                        TEXT,
  created_at                   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at                   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(source_import_row_id, contract_id, payee_id, carry_key)
);

CREATE INDEX IF NOT EXISTS idx_micro_alloc_status ON micro_allocation_ledger(status);
CREATE INDEX IF NOT EXISTS idx_micro_alloc_period ON micro_allocation_ledger(statement_period_id);
CREATE INDEX IF NOT EXISTS idx_micro_alloc_key    ON micro_allocation_ledger(carry_key);
CREATE INDEX IF NOT EXISTS idx_micro_alloc_path   ON micro_allocation_ledger(contract_id, payee_id, domain);

ALTER TABLE micro_allocation_ledger ENABLE ROW LEVEL SECURITY;

CREATE POLICY "staff_only_micro_allocation_ledger" ON micro_allocation_ledger FOR ALL TO authenticated
  USING (current_user_role() IN ('admin', 'staff'))
  WITH CHECK (current_user_role() IN ('admin', 'staff'));
