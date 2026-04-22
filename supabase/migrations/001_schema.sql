-- ============================================================
-- STATEMENT OPS — COMPLETE DATABASE SCHEMA
-- Music Business Statement Operations System
--
-- Statement unit: CONTRACT + PAYEE + PERIOD
--
-- v2 additions:
--   - iswc column on repertoire (publishing work identifier)
--   - payee_aliases table (name variant resolution)
--   - contract_repertoire_payee_splits (work-level splits, source of truth)
--   - sending_parties table + sending_party_id on contracts
--   - income-type royalty rate columns on contracts (publishing)
--   - artist_share_percent on contracts (master)
--   - currency conversion fields on imports and import_rows
--   - import_type renamed/extended for Sony publishing
-- ============================================================

CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

-- ============================================================
-- SHARED TRIGGER FUNCTION (referenced by multiple tables)
-- ============================================================
CREATE OR REPLACE FUNCTION update_updated_at_column()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;


-- ============================================================
-- 1. PAYEES
-- ============================================================
CREATE TABLE payees (
  id                    UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  payee_name            TEXT NOT NULL,
  statement_name        TEXT,
  primary_contact_name  TEXT,
  primary_email         TEXT,
  secondary_email       TEXT,
  currency              TEXT NOT NULL DEFAULT 'GBP',
  territory             TEXT,
  active_status         BOOLEAN NOT NULL DEFAULT TRUE,
  vendor_reference      TEXT,
  notes                 TEXT,
  created_at            TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at            TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_payees_active ON payees(active_status);
CREATE INDEX idx_payees_email  ON payees(primary_email);

CREATE TRIGGER trg_payees_updated_at
  BEFORE UPDATE ON payees
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();


-- ============================================================
-- 1b. PAYEE ALIASES
-- Alternate name variations for matching (e.g. writer name variants).
-- Matching logic checks alias_name case-insensitively.
-- ============================================================
CREATE TABLE payee_aliases (
  id          UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  payee_id    UUID NOT NULL REFERENCES payees(id) ON DELETE CASCADE,
  alias_name  TEXT NOT NULL,
  is_active   BOOLEAN NOT NULL DEFAULT TRUE,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(payee_id, alias_name)
);

CREATE INDEX idx_pa_payee  ON payee_aliases(payee_id);
CREATE INDEX idx_pa_alias  ON payee_aliases(alias_name);
CREATE INDEX idx_pa_active ON payee_aliases(is_active);

CREATE TRIGGER trg_payee_aliases_updated_at
  BEFORE UPDATE ON payee_aliases
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

COMMENT ON TABLE payee_aliases IS
  'Alternate name variations for a payee. Used in import matching to resolve '
  'writer name variations case-insensitively. A payee can have many aliases.';


-- ============================================================
-- 2. SENDING PARTIES
-- The entity sending statements (label, publisher, etc.)
-- ============================================================
CREATE TABLE sending_parties (
  id             UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  name           TEXT NOT NULL,
  company_name   TEXT,
  trading_name   TEXT,
  address        TEXT,
  email          TEXT,
  vat_number     TEXT,
  company_number TEXT,
  is_active      BOOLEAN NOT NULL DEFAULT TRUE,
  notes          TEXT,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_sp_active ON sending_parties(is_active);

CREATE TRIGGER trg_sending_parties_updated_at
  BEFORE UPDATE ON sending_parties
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();


-- ============================================================
-- 3. CONTRACTS
-- v2: added sending_party_id, income-type rates (publishing),
--     artist_share_percent (master), pre_term_included,
--     exclusion_notes, statement_frequency.
-- ============================================================
CREATE TABLE contracts (
  id                                UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  contract_name                     TEXT NOT NULL,
  contract_code                     TEXT,
  contract_type                     TEXT NOT NULL CHECK (contract_type IN ('master', 'publishing')),
  currency                          TEXT NOT NULL DEFAULT 'GBP',
  territory                         TEXT,
  start_date                        DATE,
  end_date                          DATE,
  status                            TEXT NOT NULL DEFAULT 'active'
                                      CHECK (status IN ('active', 'expired', 'suspended', 'terminated')),
  source_system                     TEXT,
  source_reference                  TEXT,

  -- Sending party (who issues the statement)
  sending_party_id                  UUID REFERENCES sending_parties(id) ON DELETE SET NULL,

  -- Payment control
  minimum_payment_threshold_override NUMERIC(12,2),
  hold_payment_flag                 BOOLEAN NOT NULL DEFAULT FALSE,
  approval_required                 BOOLEAN NOT NULL DEFAULT TRUE,
  is_recoupable                     BOOLEAN NOT NULL DEFAULT FALSE,
  cross_recoup_group                TEXT,           -- group key for cross-contract recoupment
  statement_frequency               TEXT CHECK (statement_frequency IN ('monthly', 'quarterly', 'bi-annual', 'annual')),
  pre_term_included                 BOOLEAN NOT NULL DEFAULT FALSE,  -- include pre-term recordings
  exclusion_notes                   TEXT,           -- works or periods explicitly excluded

  -- MASTER-specific: artist share
  -- artist_share_percent: the % of income that goes to artist(s) on this contract.
  -- label_share_percent is informational: 1 - artist_share_percent.
  artist_share_percent              NUMERIC(7,4),   -- e.g. 0.20 = 20%. NULL for publishing contracts.

  -- PUBLISHING-specific: income-type royalty rates
  -- These are applied per income type when allocating publishing row amounts.
  mechanical_rate                   NUMERIC(10,6),
  digital_mechanical_rate           NUMERIC(10,6),
  performance_rate                  NUMERIC(10,6),
  digital_performance_rate          NUMERIC(10,6),
  synch_rate                        NUMERIC(10,6),
  other_rate                        NUMERIC(10,6),

  notes                             TEXT,
  created_at                        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at                        TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_contracts_type        ON contracts(contract_type);
CREATE INDEX idx_contracts_status      ON contracts(status);
CREATE INDEX idx_contracts_hold        ON contracts(hold_payment_flag);
CREATE INDEX idx_contracts_sending     ON contracts(sending_party_id);
CREATE INDEX idx_contracts_cross_recoup ON contracts(cross_recoup_group);

CREATE TRIGGER trg_contracts_updated_at
  BEFORE UPDATE ON contracts
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

COMMENT ON COLUMN contracts.artist_share_percent IS
  'Master contracts only. The artist(s) share of income on this contract, e.g. 0.20 = 20%. '
  'Statement generation applies this share first, then splits across payee links. '
  'Label share = 1 - artist_share_percent (informational).';
COMMENT ON COLUMN contracts.mechanical_rate IS
  'Publishing contracts only. Royalty rate applied to mechanical income rows.';
COMMENT ON COLUMN contracts.digital_mechanical_rate IS
  'Publishing contracts only. Royalty rate applied to digital mechanical income rows.';
COMMENT ON COLUMN contracts.performance_rate IS
  'Publishing contracts only. Royalty rate applied to performance income rows.';
COMMENT ON COLUMN contracts.digital_performance_rate IS
  'Publishing contracts only. Royalty rate applied to digital performance income rows.';
COMMENT ON COLUMN contracts.synch_rate IS
  'Publishing contracts only. Royalty rate applied to sync income rows.';
COMMENT ON COLUMN contracts.other_rate IS
  'Publishing contracts only. Royalty rate applied to uncategorised income rows.';


-- ============================================================
-- 4. CONTRACT PAYEE LINKS
-- ============================================================
CREATE TABLE contract_payee_links (
  id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  contract_id     UUID NOT NULL REFERENCES contracts(id) ON DELETE CASCADE,
  payee_id        UUID NOT NULL REFERENCES payees(id)    ON DELETE RESTRICT,
  royalty_share   NUMERIC(10,6) NOT NULL,
  role            TEXT,
  statement_name  TEXT,
  start_date      DATE,
  end_date        DATE,
  is_active       BOOLEAN NOT NULL DEFAULT TRUE,
  notes           TEXT,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(contract_id, payee_id)
);

CREATE INDEX idx_cpl_contract ON contract_payee_links(contract_id);
CREATE INDEX idx_cpl_payee    ON contract_payee_links(payee_id);
CREATE INDEX idx_cpl_active   ON contract_payee_links(is_active);

COMMENT ON TABLE contract_payee_links IS
  'One row per payee on a contract. royalty_share is this individual payee''s share — '
  'not the total contract rate. Multiple payees can participate in one contract with different shares.';
COMMENT ON COLUMN contract_payee_links.royalty_share IS
  'This payee''s royalty share on this contract, e.g. 0.18 = 18%. '
  'Each payee on the contract has their own row with their own share.';


-- ============================================================
-- 5. REPERTOIRE
-- v2: added iswc column (primary identifier for publishing works).
--     source_id is retained for backward compat but iswc is the
--     canonical publishing identifier going forward.
-- ============================================================
CREATE TABLE repertoire (
  id               UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  repertoire_type  TEXT NOT NULL CHECK (repertoire_type IN ('track', 'release', 'work')),
  title            TEXT NOT NULL,
  artist_name      TEXT,
  writer_name      TEXT,
  isrc             TEXT,               -- master track identifier
  upc              TEXT,               -- release identifier
  iswc             TEXT,               -- publishing work identifier (T-000.000.000-0 format)
  internal_code    TEXT,
  source_id        TEXT,               -- legacy / source system ID (retained for audit)
  linked_payee_id  UUID REFERENCES payees(id) ON DELETE SET NULL,
  active_status    BOOLEAN NOT NULL DEFAULT TRUE,
  draft_status     TEXT CHECK (draft_status IN ('active', 'draft', 'needs_linking')),  -- for auto-created works
  notes            TEXT,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_repertoire_isrc   ON repertoire(isrc);
CREATE INDEX idx_repertoire_upc    ON repertoire(upc);
CREATE INDEX idx_repertoire_iswc   ON repertoire(iswc);
CREATE INDEX idx_repertoire_title  ON repertoire(title);
CREATE INDEX idx_repertoire_payee  ON repertoire(linked_payee_id);
CREATE INDEX idx_repertoire_type   ON repertoire(repertoire_type);

CREATE TRIGGER trg_repertoire_updated_at
  BEFORE UPDATE ON repertoire
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

COMMENT ON COLUMN repertoire.iswc IS
  'International Standard Work Code. Primary identifier for publishing works. '
  'Format: T-000.000.000-0. Takes precedence over source_id for publishing matching. '
  'Matching priority for publishing imports: ISWC → title.';
COMMENT ON COLUMN repertoire.source_id IS
  'Legacy / source system ID. For publishing works, prefer iswc. '
  'Retained for backward compatibility and non-standard identifiers.';
COMMENT ON COLUMN repertoire.draft_status IS
  'Lifecycle status for auto-created works during import. '
  'draft = created during import, not yet reviewed. '
  'needs_linking = created but not yet linked to a contract. '
  'active = fully configured (default).';


-- ============================================================
-- 5b. CONTRACT REPERTOIRE PAYEE SPLITS
-- Source of truth for publishing allocation.
-- A writer appearing in source data does NOT guarantee payment —
-- only a row in this table for the matching (contract, repertoire, payee)
-- triple authorises payment.
-- ============================================================
CREATE TABLE contract_repertoire_payee_splits (
  id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  contract_id     UUID NOT NULL REFERENCES contracts(id)   ON DELETE CASCADE,
  repertoire_id   UUID NOT NULL REFERENCES repertoire(id)  ON DELETE CASCADE,
  payee_id        UUID NOT NULL REFERENCES payees(id)      ON DELETE RESTRICT,
  split_percent   NUMERIC(10,6) NOT NULL                   -- e.g. 0.50 = 50% of income for this work
                    CHECK (split_percent > 0 AND split_percent <= 1),
  is_active       BOOLEAN NOT NULL DEFAULT TRUE,
  start_date      DATE,
  end_date        DATE,
  notes           TEXT,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(contract_id, repertoire_id, payee_id)
);

CREATE INDEX idx_crps_contract    ON contract_repertoire_payee_splits(contract_id);
CREATE INDEX idx_crps_repertoire  ON contract_repertoire_payee_splits(repertoire_id);
CREATE INDEX idx_crps_payee       ON contract_repertoire_payee_splits(payee_id);
CREATE INDEX idx_crps_active      ON contract_repertoire_payee_splits(is_active);

CREATE TRIGGER trg_crps_updated_at
  BEFORE UPDATE ON contract_repertoire_payee_splits
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

COMMENT ON TABLE contract_repertoire_payee_splits IS
  'Source of truth for publishing allocation per work. '
  'One row per (contract, work, payee) triplet authorised to receive payment. '
  'A writer in source CSV who has no row here receives NO allocation. '
  'split_percent is this payee''s share of the work''s income under this contract. '
  'Publishing matching MUST consult this table — not the source CSV writer field.';
COMMENT ON COLUMN contract_repertoire_payee_splits.split_percent IS
  'This payee''s percentage share of income for this work under this contract. '
  'e.g. 0.50 means payee receives 50% of the allocated income for this work. '
  'Applied AFTER the contract income-type rate. '
  'Sum across all active payees for a (contract, repertoire) should equal 1.0 but is not enforced.';


-- ============================================================
-- 6. CONTRACT REPERTOIRE LINKS
-- Links works/tracks/releases to contracts.
-- For publishing, allocation per payee is now handled by
-- contract_repertoire_payee_splits (above), not royalty_rate alone.
-- royalty_rate here is retained for master contracts and as a default.
-- ============================================================
CREATE TABLE contract_repertoire_links (
  id             UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  contract_id    UUID NOT NULL REFERENCES contracts(id)   ON DELETE CASCADE,
  repertoire_id  UUID NOT NULL REFERENCES repertoire(id)  ON DELETE CASCADE,
  royalty_rate   NUMERIC(10,6),
  start_date     DATE,
  end_date       DATE,
  notes          TEXT,
  UNIQUE(contract_id, repertoire_id)
);

CREATE INDEX idx_crl_contract    ON contract_repertoire_links(contract_id);
CREATE INDEX idx_crl_repertoire  ON contract_repertoire_links(repertoire_id);

COMMENT ON COLUMN contract_repertoire_links.royalty_rate IS
  'Total royalty rate for this work under this contract (primarily used for master). '
  'For publishing, per-payee allocation is driven by contract_repertoire_payee_splits '
  'combined with the contract income-type rate columns.';


-- ============================================================
-- 7. STATEMENT PERIODS
-- v2: supports inline creation (UI-level, no schema change required).
-- ============================================================
CREATE TABLE statement_periods (
  id            UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  year          INTEGER NOT NULL,
  half          TEXT    NOT NULL CHECK (half IN ('H1', 'H2')),
  label         TEXT    NOT NULL,
  period_start  DATE    NOT NULL,
  period_end    DATE    NOT NULL,
  status        TEXT    NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'locked', 'archived')),
  is_current    BOOLEAN NOT NULL DEFAULT FALSE,  -- manually designated as active period for the app
  notes         TEXT,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(year, half),
  UNIQUE(label)
);

CREATE INDEX idx_periods_current ON statement_periods(is_current) WHERE is_current = TRUE;

CREATE TRIGGER trg_periods_updated_at
  BEFORE UPDATE ON statement_periods
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

COMMENT ON COLUMN statement_periods.is_current IS
  'Manually designated "current" period for the app. '
  'Only one period should have is_current = TRUE at a time. '
  'Used as the app-wide default for imports, statement run, and dashboard. '
  'Never auto-set — must be explicitly chosen by staff.';


-- ============================================================
-- 8. IMPORTS
-- v2: added currency conversion fields, expanded import_type values.
-- import_type now includes sony_publishing (replaces sony_balance for line-level).
-- ============================================================
CREATE TABLE imports (
  id                  UUID PRIMARY KEY DEFAULT uuid_generate_v4(),

  -- Import type: domain-specific source labels
  -- master:     believe, eddy (legacy)
  -- publishing: sony_publishing (primary), publishing_csv (secondary), sony_balance (balance only)
  import_type         TEXT NOT NULL,
  domain              TEXT NOT NULL CHECK (domain IN ('master', 'publishing')),
  source_name         TEXT,
  file_name           TEXT,
  statement_period_id UUID REFERENCES statement_periods(id) ON DELETE SET NULL,
  imported_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  imported_by         UUID,
  imported_by_name    TEXT,
  row_count           INTEGER NOT NULL DEFAULT 0,
  success_count       INTEGER NOT NULL DEFAULT 0,
  warning_count       INTEGER NOT NULL DEFAULT 0,
  error_count         INTEGER NOT NULL DEFAULT 0,
  import_status       TEXT NOT NULL DEFAULT 'pending'
                        CHECK (import_status IN ('pending', 'processing', 'complete', 'failed', 'partial')),
  column_mapping_json JSONB,
  raw_snapshot_json   JSONB,

  -- Currency conversion (optional, one rate per import)
  source_currency     TEXT,                    -- e.g. 'USD' if original file is in USD
  reporting_currency  TEXT DEFAULT 'GBP',      -- target currency for statement generation
  exchange_rate       NUMERIC(18,8),           -- rate applied: source → reporting
  exchange_rate_date  DATE,                    -- date the rate was sourced

  notes               TEXT
);

CREATE INDEX idx_imports_period  ON imports(statement_period_id);
CREATE INDEX idx_imports_domain  ON imports(domain);
CREATE INDEX idx_imports_status  ON imports(import_status);
CREATE INDEX idx_imports_type    ON imports(import_type);

COMMENT ON COLUMN imports.import_type IS
  'Source-specific import type. '
  'master domain: believe (primary), eddy (legacy). '
  'publishing domain: sony_publishing (primary line-by-line), publishing_csv (secondary/manual), sony_balance (balance-only). '
  'sony_publishing replaces the old sony_balance label for standard transaction imports.';
COMMENT ON COLUMN imports.exchange_rate IS
  'Optional. Exchange rate from source_currency to reporting_currency. '
  'If set, converted amounts are stored on import_rows and used in statement generation. '
  'Source amounts are always preserved for audit.';


-- ============================================================
-- 9. IMPORT ROWS
-- v2: added currency conversion fields, income_type for publishing,
--     publishing-specific matching fields.
-- ============================================================
CREATE TABLE import_rows (
  id                    UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  import_id             UUID NOT NULL REFERENCES imports(id) ON DELETE CASCADE,
  raw_row_number        INTEGER,
  domain                TEXT NOT NULL CHECK (domain IN ('master', 'publishing')),
  statement_period_id   UUID REFERENCES statement_periods(id) ON DELETE SET NULL,

  -- Raw parsed fields
  payee_name_raw        TEXT,
  contract_name_raw     TEXT,
  artist_name_raw       TEXT,
  title_raw             TEXT,
  identifier_raw        TEXT,               -- raw ISRC / UPC / ISWC
  country_raw           TEXT,
  transaction_date      DATE,
  row_type              TEXT,               -- sale, adjustment, deduction, balance, etc.

  -- Publishing-specific income type for rate lookup
  income_type           TEXT,               -- mechanical, digital_mechanical, performance, digital_performance, synch, other

  -- Financial (source values always preserved)
  amount                NUMERIC(15,6),
  currency              TEXT,

  -- Currency conversion (populated if import has exchange_rate)
  amount_converted      NUMERIC(15,6),      -- amount × exchange_rate
  converted_currency    TEXT,               -- = import.reporting_currency
  exchange_rate_used    NUMERIC(18,8),      -- snapshot of rate at time of import

  -- Eddy-specific fields (preserved verbatim for audit)
  channel               TEXT,
  retailer              TEXT,
  quantity              NUMERIC(15,4),
  original_currency     TEXT,
  sale_amount_original  NUMERIC(15,6),
  royalty_base_percentage NUMERIC(10,6),
  base_amount           NUMERIC(15,6),
  gross_cost_recovered  NUMERIC(15,6),
  threshold_step_amount NUMERIC(15,6),
  threshold_step        TEXT,
  reserved_amount_pre_rate NUMERIC(15,6),
  royalty_rate          NUMERIC(10,6),
  contract_amount       NUMERIC(15,6),
  deducted_amount       NUMERIC(15,6),
  reserved_amount       NUMERIC(15,6),
  final_contract_amount NUMERIC(15,6),
  payee_split           NUMERIC(10,6),
  net_amount            NUMERIC(15,6),      -- key financial figure (post-share, pre-conversion)

  -- Normalized (post-processing)
  normalized_title      TEXT,
  normalized_identifier TEXT,

  -- Match results
  matched_payee_id      UUID REFERENCES payees(id)      ON DELETE SET NULL,
  matched_contract_id   UUID REFERENCES contracts(id)   ON DELETE SET NULL,
  matched_repertoire_id UUID REFERENCES repertoire(id)  ON DELETE SET NULL,
  match_status          TEXT NOT NULL DEFAULT 'unmatched'
                          CHECK (match_status IN ('matched', 'partial', 'unmatched', 'manual_override')),

  -- Row flags
  error_flag            BOOLEAN NOT NULL DEFAULT FALSE,
  error_reason          TEXT,
  warning_flag          BOOLEAN NOT NULL DEFAULT FALSE,
  warning_reason        TEXT,
  excluded_flag         BOOLEAN NOT NULL DEFAULT FALSE,
  exclusion_reason      TEXT,

  raw_payload_json      JSONB
);

CREATE INDEX idx_ir_import    ON import_rows(import_id);
CREATE INDEX idx_ir_match     ON import_rows(match_status);
CREATE INDEX idx_ir_payee     ON import_rows(matched_payee_id);
CREATE INDEX idx_ir_contract  ON import_rows(matched_contract_id);
CREATE INDEX idx_ir_error     ON import_rows(error_flag);
CREATE INDEX idx_ir_period    ON import_rows(statement_period_id);
CREATE INDEX idx_ir_repertoire ON import_rows(matched_repertoire_id);

COMMENT ON COLUMN import_rows.income_type IS
  'Publishing domain only. Categorises the income for rate lookup on the contract. '
  'Values: mechanical, digital_mechanical, performance, digital_performance, synch, other. '
  'Used to select the correct rate column from contracts (e.g. mechanical_rate).';
COMMENT ON COLUMN import_rows.net_amount IS
  'Primary financial figure in source currency. '
  'For master: post-royalty-rate amount from source. '
  'For publishing: source row amount before contract rate is applied (applied during statement gen).';
COMMENT ON COLUMN import_rows.amount_converted IS
  'net_amount converted to reporting currency using exchange_rate_used. '
  'Populated during import if the parent import has an exchange_rate. '
  'Statement generation uses this value when set; falls back to net_amount.';


-- ============================================================
-- 10. STATEMENT RECORDS
-- (unchanged from v1 — balance model and structure identical)
-- ============================================================
CREATE TABLE statement_records (
  id                    UUID PRIMARY KEY DEFAULT uuid_generate_v4(),

  contract_id           UUID NOT NULL REFERENCES contracts(id)          ON DELETE RESTRICT,
  payee_id              UUID NOT NULL REFERENCES payees(id)             ON DELETE RESTRICT,
  statement_period_id   UUID NOT NULL REFERENCES statement_periods(id)  ON DELETE RESTRICT,

  domain                TEXT NOT NULL CHECK (domain IN ('master', 'publishing')),

  royalty_share_snapshot NUMERIC(10,6) NOT NULL,

  -- Balance chain (Approach B)
  opening_balance                   NUMERIC(15,2) NOT NULL DEFAULT 0,
  current_earnings                  NUMERIC(15,2) NOT NULL DEFAULT 0,
  deductions                        NUMERIC(15,2) NOT NULL DEFAULT 0,
  closing_balance_pre_carryover     NUMERIC(15,2) NOT NULL DEFAULT 0,
  prior_period_carryover_applied    NUMERIC(15,2) NOT NULL DEFAULT 0,
  final_balance_after_carryover     NUMERIC(15,2) NOT NULL DEFAULT 0,
  payable_amount                    NUMERIC(15,2) NOT NULL DEFAULT 0,
  carry_forward_amount              NUMERIC(15,2) NOT NULL DEFAULT 0,
  issued_amount                     NUMERIC(15,2) NOT NULL DEFAULT 0,

  is_payable              BOOLEAN NOT NULL DEFAULT FALSE,
  is_recouping            BOOLEAN NOT NULL DEFAULT FALSE,
  carryover_rule_applied  BOOLEAN NOT NULL DEFAULT FALSE,
  hold_payment_flag       BOOLEAN NOT NULL DEFAULT FALSE,
  balance_model           TEXT NOT NULL DEFAULT 'approach_b'
                            CHECK (balance_model IN ('approach_b')),

  balance_source_summary  TEXT,
  source_import_ids       JSONB,

  manual_override_flag    BOOLEAN NOT NULL DEFAULT FALSE,
  override_notes          TEXT,
  override_by             TEXT,
  override_at             TIMESTAMPTZ,

  balance_confirmed_flag  BOOLEAN NOT NULL DEFAULT FALSE,
  carryover_confirmed_flag BOOLEAN NOT NULL DEFAULT FALSE,

  calculation_status      TEXT NOT NULL DEFAULT 'pending'
                            CHECK (calculation_status IN ('pending', 'calculated', 'needs_review', 'error')),
  calculation_notes       TEXT,
  last_calculated_at      TIMESTAMPTZ,

  review_status           TEXT NOT NULL DEFAULT 'not_started'
                            CHECK (review_status IN ('not_started', 'in_review', 'reviewed')),
  approval_status         TEXT NOT NULL DEFAULT 'pending'
                            CHECK (approval_status IN ('pending', 'approved', 'rejected', 'on_hold')),
  output_status           TEXT NOT NULL DEFAULT 'not_generated'
                            CHECK (output_status IN ('not_generated', 'generated', 'outdated')),
  output_generated_flag   BOOLEAN NOT NULL DEFAULT FALSE,

  email_status            TEXT NOT NULL DEFAULT 'not_prepared'
                            CHECK (email_status IN ('not_prepared', 'prepared', 'sent')),
  email_prepared_subject  TEXT,
  email_prepared_body     TEXT,
  email_prepared_at       TIMESTAMPTZ,
  email_prepared_by       TEXT,

  portal_visible_flag     BOOLEAN NOT NULL DEFAULT FALSE,
  portal_published_at     TIMESTAMPTZ,
  portal_published_by     TEXT,
  portal_version          INTEGER NOT NULL DEFAULT 1,
  portal_notes            TEXT,

  sent_date               DATE,
  paid_date               DATE,

  checked_by              TEXT,
  checked_at              TIMESTAMPTZ,
  approved_by             TEXT,
  approved_at             TIMESTAMPTZ,

  created_at              TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at              TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  UNIQUE(contract_id, payee_id, statement_period_id)
);

CREATE INDEX idx_sr_contract   ON statement_records(contract_id);
CREATE INDEX idx_sr_payee      ON statement_records(payee_id);
CREATE INDEX idx_sr_period     ON statement_records(statement_period_id);
CREATE INDEX idx_sr_domain     ON statement_records(domain);
CREATE INDEX idx_sr_approval   ON statement_records(approval_status);
CREATE INDEX idx_sr_payable    ON statement_records(is_payable);
CREATE INDEX idx_sr_email      ON statement_records(email_status);
CREATE INDEX idx_sr_output     ON statement_records(output_generated_flag);
CREATE INDEX idx_sr_portal     ON statement_records(payee_id, portal_visible_flag)
  WHERE portal_visible_flag = TRUE;

CREATE TRIGGER trg_sr_updated_at
  BEFORE UPDATE ON statement_records
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();


-- ============================================================
-- 11. STATEMENT LINE SUMMARIES
-- ============================================================
CREATE TABLE statement_line_summaries (
  id                    UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  statement_record_id   UUID NOT NULL REFERENCES statement_records(id) ON DELETE CASCADE,
  source_import_row_id  UUID REFERENCES import_rows(id) ON DELETE SET NULL,
  line_category         TEXT,
  title                 TEXT,
  identifier            TEXT,
  income_type           TEXT,               -- publishing: mechanical, performance, etc.
  transaction_date      DATE,
  retailer_channel      TEXT,
  territory             TEXT,
  quantity              NUMERIC(15,4),
  gross_amount          NUMERIC(15,6),
  net_amount            NUMERIC(15,6),
  deduction_amount      NUMERIC(15,6),

  -- Publishing allocation detail
  split_percent_applied NUMERIC(10,6),      -- from contract_repertoire_payee_splits
  rate_applied          NUMERIC(10,6),      -- income-type rate from contract
  pre_split_amount      NUMERIC(15,6),      -- amount before split was applied

  notes                 TEXT
);

CREATE INDEX idx_sls_record     ON statement_line_summaries(statement_record_id);
CREATE INDEX idx_sls_identifier ON statement_line_summaries(identifier);


-- ============================================================
-- 12. EXCEPTIONS
-- ============================================================
CREATE TABLE exceptions (
  id                    UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  domain                TEXT NOT NULL CHECK (domain IN ('master', 'publishing')),
  severity              TEXT NOT NULL CHECK (severity IN ('critical', 'warning', 'info')),
  issue_type            TEXT NOT NULL,
  statement_period_id   UUID REFERENCES statement_periods(id) ON DELETE SET NULL,
  payee_id              UUID REFERENCES payees(id)            ON DELETE SET NULL,
  contract_id           UUID REFERENCES contracts(id)         ON DELETE SET NULL,
  import_id             UUID REFERENCES imports(id)           ON DELETE SET NULL,
  import_row_id         UUID REFERENCES import_rows(id)       ON DELETE SET NULL,
  statement_record_id   UUID REFERENCES statement_records(id) ON DELETE SET NULL,
  title                 TEXT NOT NULL,
  detail                TEXT,
  resolution_status     TEXT NOT NULL DEFAULT 'open'
                          CHECK (resolution_status IN ('open', 'resolved', 'dismissed', 'wont_fix')),
  resolution_notes      TEXT,
  resolved_by           TEXT,
  resolved_at           TIMESTAMPTZ,
  auto_generated        BOOLEAN NOT NULL DEFAULT TRUE,
  created_at            TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_exc_domain   ON exceptions(domain);
CREATE INDEX idx_exc_severity ON exceptions(severity);
CREATE INDEX idx_exc_period   ON exceptions(statement_period_id);
CREATE INDEX idx_exc_status   ON exceptions(resolution_status);
CREATE INDEX idx_exc_type     ON exceptions(issue_type);
CREATE INDEX idx_exc_record   ON exceptions(statement_record_id);
CREATE INDEX idx_exc_contract ON exceptions(contract_id);
CREATE INDEX idx_exc_payee    ON exceptions(payee_id);


-- ============================================================
-- 13. STATEMENT OUTPUTS
-- ============================================================
CREATE TABLE statement_outputs (
  id                    UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  statement_record_id   UUID NOT NULL REFERENCES statement_records(id) ON DELETE CASCADE,
  output_type           TEXT NOT NULL CHECK (output_type IN ('excel', 'csv', 'html', 'pdf')),
  storage_path          TEXT,
  storage_bucket        TEXT,
  file_name             TEXT,
  version_number        INTEGER NOT NULL DEFAULT 1,
  output_status         TEXT NOT NULL DEFAULT 'generated'
                          CHECK (output_status IN ('generated', 'superseded', 'error')),
  portal_accessible     BOOLEAN NOT NULL DEFAULT FALSE,
  access_expires_at     TIMESTAMPTZ,
  checksum              TEXT,
  file_size_bytes       BIGINT,
  generated_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  generated_by          TEXT,
  notes                 TEXT
);

CREATE INDEX idx_so_record ON statement_outputs(statement_record_id);
CREATE INDEX idx_so_type   ON statement_outputs(output_type);
CREATE INDEX idx_so_portal ON statement_outputs(statement_record_id, portal_accessible)
  WHERE portal_accessible = TRUE;


-- ============================================================
-- 14. APPROVAL LOG
-- ============================================================
CREATE TABLE approval_log (
  id                    UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  statement_record_id   UUID NOT NULL REFERENCES statement_records(id) ON DELETE CASCADE,
  approval_stage        TEXT NOT NULL CHECK (approval_stage IN ('prepared', 'checked', 'approved', 'rejected', 'on_hold')),
  previous_stage        TEXT,
  approved_by           TEXT NOT NULL,
  approved_at           TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  comments              TEXT
);

CREATE INDEX idx_al_record ON approval_log(statement_record_id);
CREATE INDEX idx_al_stage  ON approval_log(approval_stage);


-- ============================================================
-- 15. CARRYOVER LEDGER
-- ============================================================
CREATE TABLE carryover_ledger (
  id                          UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  contract_id                 UUID NOT NULL REFERENCES contracts(id)          ON DELETE RESTRICT,
  payee_id                    UUID NOT NULL REFERENCES payees(id)             ON DELETE RESTRICT,
  domain                      TEXT NOT NULL CHECK (domain IN ('master', 'publishing')),
  from_period_id              UUID NOT NULL REFERENCES statement_periods(id)  ON DELETE RESTRICT,
  to_period_id                UUID NOT NULL REFERENCES statement_periods(id)  ON DELETE RESTRICT,
  carried_amount              NUMERIC(15,2) NOT NULL,
  currency                    TEXT NOT NULL DEFAULT 'GBP',
  carry_reason                TEXT NOT NULL DEFAULT 'below_threshold'
                                CHECK (carry_reason IN ('below_threshold', 'on_hold', 'recouping', 'manual')),
  balance_at_carry            NUMERIC(15,2),
  threshold_at_carry          NUMERIC(12,2),
  source_statement_record_id  UUID REFERENCES statement_records(id) ON DELETE SET NULL,
  notes                       TEXT,
  created_at                  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_by                  TEXT,
  UNIQUE(contract_id, payee_id, from_period_id, to_period_id)
);

CREATE INDEX idx_cl_contract ON carryover_ledger(contract_id);
CREATE INDEX idx_cl_payee    ON carryover_ledger(payee_id);
CREATE INDEX idx_cl_from     ON carryover_ledger(from_period_id);
CREATE INDEX idx_cl_to       ON carryover_ledger(to_period_id);


-- ============================================================
-- 16. USER PROFILES
-- ============================================================
CREATE TABLE user_profiles (
  id              UUID PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  role            TEXT NOT NULL DEFAULT 'staff'
                    CHECK (role IN ('admin', 'staff', 'payee')),
  display_name    TEXT,
  job_title       TEXT,
  is_active       BOOLEAN NOT NULL DEFAULT TRUE,
  last_sign_in_at TIMESTAMPTZ,
  notes           TEXT,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_up_role   ON user_profiles(role);
CREATE INDEX idx_up_active ON user_profiles(is_active);

CREATE TRIGGER trg_user_profiles_updated_at
  BEFORE UPDATE ON user_profiles
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

CREATE OR REPLACE FUNCTION handle_new_user()
RETURNS TRIGGER AS $$
BEGIN
  INSERT INTO public.user_profiles (id, role, display_name)
  VALUES (
    NEW.id,
    'staff',
    COALESCE(NEW.raw_user_meta_data->>'display_name', NEW.email)
  )
  ON CONFLICT (id) DO NOTHING;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

CREATE OR REPLACE TRIGGER on_auth_user_created
  AFTER INSERT ON auth.users
  FOR EACH ROW EXECUTE FUNCTION handle_new_user();


-- ============================================================
-- 17. PAYEE USER LINKS
-- ============================================================
CREATE TABLE payee_user_links (
  id            UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id       UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  payee_id      UUID NOT NULL REFERENCES payees(id)     ON DELETE CASCADE,
  access_level  TEXT NOT NULL DEFAULT 'read'
                  CHECK (access_level IN ('read', 'download')),
  invited_by    UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  invited_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  is_active     BOOLEAN NOT NULL DEFAULT TRUE,
  notes         TEXT,
  UNIQUE(user_id, payee_id)
);

CREATE INDEX idx_pul_user   ON payee_user_links(user_id);
CREATE INDEX idx_pul_payee  ON payee_user_links(payee_id);
CREATE INDEX idx_pul_active ON payee_user_links(is_active);


-- ============================================================
-- HELPER SQL FUNCTIONS FOR RLS
-- ============================================================
CREATE OR REPLACE FUNCTION current_user_role()
RETURNS TEXT AS $$
  SELECT role FROM public.user_profiles WHERE id = auth.uid()
$$ LANGUAGE sql SECURITY DEFINER STABLE;

CREATE OR REPLACE FUNCTION current_user_payee_ids()
RETURNS SETOF UUID AS $$
  SELECT payee_id FROM public.payee_user_links
  WHERE user_id = auth.uid() AND is_active = TRUE
$$ LANGUAGE sql SECURITY DEFINER STABLE;


-- ============================================================
-- ROW LEVEL SECURITY
-- ============================================================
ALTER TABLE payees                              ENABLE ROW LEVEL SECURITY;
ALTER TABLE payee_aliases                       ENABLE ROW LEVEL SECURITY;
ALTER TABLE sending_parties                     ENABLE ROW LEVEL SECURITY;
ALTER TABLE contracts                           ENABLE ROW LEVEL SECURITY;
ALTER TABLE contract_payee_links                ENABLE ROW LEVEL SECURITY;
ALTER TABLE repertoire                          ENABLE ROW LEVEL SECURITY;
ALTER TABLE contract_repertoire_links           ENABLE ROW LEVEL SECURITY;
ALTER TABLE contract_repertoire_payee_splits    ENABLE ROW LEVEL SECURITY;
ALTER TABLE statement_periods                   ENABLE ROW LEVEL SECURITY;
ALTER TABLE imports                             ENABLE ROW LEVEL SECURITY;
ALTER TABLE import_rows                         ENABLE ROW LEVEL SECURITY;
ALTER TABLE statement_records                   ENABLE ROW LEVEL SECURITY;
ALTER TABLE statement_line_summaries            ENABLE ROW LEVEL SECURITY;
ALTER TABLE exceptions                          ENABLE ROW LEVEL SECURITY;
ALTER TABLE statement_outputs                   ENABLE ROW LEVEL SECURITY;
ALTER TABLE approval_log                        ENABLE ROW LEVEL SECURITY;
ALTER TABLE carryover_ledger                    ENABLE ROW LEVEL SECURITY;
ALTER TABLE user_profiles                       ENABLE ROW LEVEL SECURITY;
ALTER TABLE payee_user_links                    ENABLE ROW LEVEL SECURITY;

-- payees
CREATE POLICY "staff_all_payees" ON payees FOR ALL TO authenticated
  USING (current_user_role() IN ('admin', 'staff'))
  WITH CHECK (current_user_role() IN ('admin', 'staff'));
CREATE POLICY "payee_read_own" ON payees FOR SELECT TO authenticated
  USING (current_user_role() = 'payee' AND id IN (SELECT current_user_payee_ids()));

-- payee_aliases (staff only — internal matching support)
CREATE POLICY "staff_all_payee_aliases" ON payee_aliases FOR ALL TO authenticated
  USING (current_user_role() IN ('admin', 'staff'))
  WITH CHECK (current_user_role() IN ('admin', 'staff'));

-- sending_parties (staff only)
CREATE POLICY "staff_all_sending_parties" ON sending_parties FOR ALL TO authenticated
  USING (current_user_role() IN ('admin', 'staff'))
  WITH CHECK (current_user_role() IN ('admin', 'staff'));

-- contracts
CREATE POLICY "staff_all_contracts" ON contracts FOR ALL TO authenticated
  USING (current_user_role() IN ('admin', 'staff'))
  WITH CHECK (current_user_role() IN ('admin', 'staff'));
CREATE POLICY "payee_read_own_contracts" ON contracts FOR SELECT TO authenticated
  USING (
    current_user_role() = 'payee'
    AND id IN (
      SELECT contract_id FROM contract_payee_links
      WHERE payee_id IN (SELECT current_user_payee_ids()) AND is_active = TRUE
    )
  );

-- contract_payee_links
CREATE POLICY "staff_all_cpl" ON contract_payee_links FOR ALL TO authenticated
  USING (current_user_role() IN ('admin', 'staff'))
  WITH CHECK (current_user_role() IN ('admin', 'staff'));
CREATE POLICY "payee_read_own_cpl" ON contract_payee_links FOR SELECT TO authenticated
  USING (current_user_role() = 'payee' AND payee_id IN (SELECT current_user_payee_ids()));

-- contract_repertoire_payee_splits (staff only — source of truth for allocation)
CREATE POLICY "staff_all_crps" ON contract_repertoire_payee_splits FOR ALL TO authenticated
  USING (current_user_role() IN ('admin', 'staff'))
  WITH CHECK (current_user_role() IN ('admin', 'staff'));

-- statement_records
CREATE POLICY "staff_all_sr" ON statement_records FOR ALL TO authenticated
  USING (current_user_role() IN ('admin', 'staff'))
  WITH CHECK (current_user_role() IN ('admin', 'staff'));
CREATE POLICY "payee_read_own_published_sr" ON statement_records FOR SELECT TO authenticated
  USING (
    current_user_role() = 'payee'
    AND payee_id IN (SELECT current_user_payee_ids())
    AND portal_visible_flag = TRUE
  );

-- statement_line_summaries
CREATE POLICY "staff_all_sls" ON statement_line_summaries FOR ALL TO authenticated
  USING (current_user_role() IN ('admin', 'staff'))
  WITH CHECK (current_user_role() IN ('admin', 'staff'));
CREATE POLICY "payee_read_own_published_sls" ON statement_line_summaries FOR SELECT TO authenticated
  USING (
    current_user_role() = 'payee'
    AND statement_record_id IN (
      SELECT id FROM statement_records
      WHERE payee_id IN (SELECT current_user_payee_ids()) AND portal_visible_flag = TRUE
    )
  );

-- statement_outputs
CREATE POLICY "staff_all_so" ON statement_outputs FOR ALL TO authenticated
  USING (current_user_role() IN ('admin', 'staff'))
  WITH CHECK (current_user_role() IN ('admin', 'staff'));
CREATE POLICY "payee_read_portal_outputs" ON statement_outputs FOR SELECT TO authenticated
  USING (
    current_user_role() = 'payee'
    AND portal_accessible = TRUE
    AND statement_record_id IN (
      SELECT id FROM statement_records
      WHERE payee_id IN (SELECT current_user_payee_ids()) AND portal_visible_flag = TRUE
    )
  );

-- statement_periods
CREATE POLICY "staff_all_periods" ON statement_periods FOR ALL TO authenticated
  USING (current_user_role() IN ('admin', 'staff'))
  WITH CHECK (current_user_role() IN ('admin', 'staff'));
CREATE POLICY "payee_read_relevant_periods" ON statement_periods FOR SELECT TO authenticated
  USING (
    current_user_role() = 'payee'
    AND id IN (
      SELECT DISTINCT statement_period_id FROM statement_records
      WHERE payee_id IN (SELECT current_user_payee_ids()) AND portal_visible_flag = TRUE
    )
  );

-- user_profiles
CREATE POLICY "staff_read_all_profiles" ON user_profiles FOR SELECT TO authenticated
  USING (current_user_role() IN ('admin', 'staff'));
CREATE POLICY "admin_manage_profiles" ON user_profiles FOR ALL TO authenticated
  USING (current_user_role() = 'admin')
  WITH CHECK (current_user_role() = 'admin');
CREATE POLICY "users_read_own_profile" ON user_profiles FOR SELECT TO authenticated
  USING (id = auth.uid());

-- payee_user_links
CREATE POLICY "admin_manage_pul" ON payee_user_links FOR ALL TO authenticated
  USING (current_user_role() = 'admin')
  WITH CHECK (current_user_role() = 'admin');
CREATE POLICY "staff_read_pul" ON payee_user_links FOR SELECT TO authenticated
  USING (current_user_role() IN ('admin', 'staff'));
CREATE POLICY "payee_read_own_pul" ON payee_user_links FOR SELECT TO authenticated
  USING (user_id = auth.uid());

-- internal-only tables
CREATE POLICY "staff_only_imports" ON imports FOR ALL TO authenticated
  USING (current_user_role() IN ('admin', 'staff'))
  WITH CHECK (current_user_role() IN ('admin', 'staff'));
CREATE POLICY "staff_only_import_rows" ON import_rows FOR ALL TO authenticated
  USING (current_user_role() IN ('admin', 'staff'))
  WITH CHECK (current_user_role() IN ('admin', 'staff'));
CREATE POLICY "staff_only_exceptions" ON exceptions FOR ALL TO authenticated
  USING (current_user_role() IN ('admin', 'staff'))
  WITH CHECK (current_user_role() IN ('admin', 'staff'));
CREATE POLICY "staff_only_approval_log" ON approval_log FOR ALL TO authenticated
  USING (current_user_role() IN ('admin', 'staff'))
  WITH CHECK (current_user_role() IN ('admin', 'staff'));
CREATE POLICY "staff_only_carryover" ON carryover_ledger FOR ALL TO authenticated
  USING (current_user_role() IN ('admin', 'staff'))
  WITH CHECK (current_user_role() IN ('admin', 'staff'));
CREATE POLICY "staff_only_repertoire" ON repertoire FOR ALL TO authenticated
  USING (current_user_role() IN ('admin', 'staff'))
  WITH CHECK (current_user_role() IN ('admin', 'staff'));
CREATE POLICY "staff_only_crl" ON contract_repertoire_links FOR ALL TO authenticated
  USING (current_user_role() IN ('admin', 'staff'))
  WITH CHECK (current_user_role() IN ('admin', 'staff'));


-- ============================================================
-- MIGRATION: copy ISWC-like values from source_id → iswc
-- Run once on existing data after deploying this schema.
-- ISWC format: T-ddd.ddd.ddd-d  (e.g. T-034.524.680-1)
-- ============================================================
-- UPDATE repertoire
--   SET iswc = source_id
-- WHERE repertoire_type = 'work'
--   AND source_id ~ '^T-[0-9]{3}\.[0-9]{3}\.[0-9]{3}-[0-9]$'
--   AND iswc IS NULL;
