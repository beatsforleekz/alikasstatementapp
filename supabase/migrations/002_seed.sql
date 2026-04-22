-- ============================================================
-- STATEMENT OPS — SEED DATA
-- Demonstrates the correct contract + payee + period model.
--
-- Key relationships shown:
--   - Contracts are standalone (no payee_id on contract)
--   - Payees link to contracts via contract_payee_links with individual royalty_share
--   - One contract can have multiple payees (Blackwood Mechanical: Sarah + co-publisher)
--   - One payee can appear on multiple contracts (Aria: master + publishing)
--   - statement_records use (contract_id, payee_id, statement_period_id) as the key
-- ============================================================

-- ============================================================
-- STATEMENT PERIODS
-- ============================================================
INSERT INTO statement_periods (id, year, half, label, period_start, period_end, status) VALUES
  ('11111111-0000-0000-0000-000000000001', 2024, 'H1', '2024-H1', '2024-01-01', '2024-06-30', 'locked'),
  ('11111111-0000-0000-0000-000000000002', 2024, 'H2', '2024-H2', '2024-07-01', '2024-12-31', 'open'),
  ('11111111-0000-0000-0000-000000000003', 2023, 'H2', '2023-H2', '2023-07-01', '2023-12-31', 'locked');


-- ============================================================
-- PAYEES
-- ============================================================
INSERT INTO payees (id, payee_name, statement_name, primary_contact_name, primary_email, secondary_email, currency, territory, active_status, vendor_reference, notes) VALUES
  ('22222222-0000-0000-0000-000000000001', 'Aria Records Ltd',           'Aria Records',   'James Fletcher',    'james@ariarecords.co.uk',  'accounts@ariarecords.co.uk', 'GBP', 'UK',    TRUE,  'VEN-001', 'Master and publishing participant'),
  ('22222222-0000-0000-0000-000000000002', 'Blackwood Music Publishing',  'Blackwood Music','Sarah Blackwood',   'sarah@blackwoodmusic.com', NULL,                         'GBP', 'UK/EU', TRUE,  'VEN-002', 'Publishing participant — multiple contracts'),
  ('22222222-0000-0000-0000-000000000003', 'Neon Coast Productions',      'Neon Coast',     'Marco Delgado',     NULL,                       NULL,                         'USD', 'US',    TRUE,  'VEN-003', 'MISSING EMAIL — statement cannot be sent until added'),
  ('22222222-0000-0000-0000-000000000004', 'The River Sessions',          'River Sessions', 'Emma Walsh',        'emma@riversessions.ie',    NULL,                         'EUR', 'IE/EU', TRUE,  'VEN-004', 'Recouping advance'),
  ('22222222-0000-0000-0000-000000000005', 'Indie Co-Publisher Ltd',      'Indie Co-Pub',   'Tom Price',         'tom@indieco.com',           NULL,                         'GBP', 'UK',    TRUE,  'VEN-006', 'Co-publisher on Blackwood Mechanical contract'),
  ('22222222-0000-0000-0000-000000000006', 'Dormant Catalogue Ltd',       'Dormant Cat.',   'Old Contact',       'old@email.com',             NULL,                         'GBP', 'UK',    FALSE, 'VEN-005', 'Inactive — catalogue transferred');


-- ============================================================
-- CONTRACTS
-- No payee_id. Contracts are standalone deal records.
-- ============================================================
INSERT INTO contracts (id, contract_name, contract_code, contract_type, currency, territory, status, source_system, hold_payment_flag, approval_required, notes) VALUES
  ('33333333-0000-0000-0000-000000000001', 'Aria Master Royalties',         'ARL-M-001', 'master',     'GBP', 'WW',    'active', 'eddy',    FALSE, TRUE, 'Main Aria master deal'),
  ('33333333-0000-0000-0000-000000000002', 'Aria Publishing Rights',         'ARL-P-001', 'publishing', 'GBP', 'WW',    'active', 'inhouse', FALSE, TRUE, 'Aria mechanical and performance'),
  ('33333333-0000-0000-0000-000000000003', 'Blackwood Mechanical Rights',    'BWM-P-001', 'publishing', 'GBP', 'UK/EU', 'active', 'sony',    FALSE, TRUE, 'Sony sub-publishing — two payees share this contract'),
  ('33333333-0000-0000-0000-000000000004', 'Blackwood Sync Licensing',       'BWM-P-002', 'publishing', 'GBP', 'WW',    'active', 'inhouse', FALSE, TRUE, 'Sync only — Blackwood sole payee'),
  ('33333333-0000-0000-0000-000000000005', 'Neon Coast Master Deal',         'NCO-M-001', 'master',     'USD', 'US',    'active', 'eddy',    FALSE, TRUE, 'US distribution — payee has no email'),
  ('33333333-0000-0000-0000-000000000006', 'River Sessions Master',          'RSE-M-001', 'master',     'EUR', 'EU',    'active', 'eddy',    FALSE, TRUE, 'Recouping EUR 5,000 advance');


-- ============================================================
-- CONTRACT PAYEE LINKS
-- This is where royalty_share lives per payee per contract.
-- Shows: one contract with two payees (Blackwood Mechanical).
-- ============================================================
INSERT INTO contract_payee_links (contract_id, payee_id, royalty_share, role, is_active, notes) VALUES
  -- Aria Master: one payee, 18%
  ('33333333-0000-0000-0000-000000000001', '22222222-0000-0000-0000-000000000001', 0.18, 'artist',     TRUE, 'Aria sole participant on master deal'),
  -- Aria Publishing: one payee, 75%
  ('33333333-0000-0000-0000-000000000002', '22222222-0000-0000-0000-000000000001', 0.75, 'publisher',  TRUE, 'Aria sole participant on publishing deal'),
  -- Blackwood Mechanical: TWO payees on one contract (demonstrates the model)
  ('33333333-0000-0000-0000-000000000003', '22222222-0000-0000-0000-000000000002', 0.50, 'publisher',  TRUE, 'Blackwood 50% share of mechanical contract'),
  ('33333333-0000-0000-0000-000000000003', '22222222-0000-0000-0000-000000000005', 0.25, 'co-publisher', TRUE, 'Indie Co-Pub 25% share of same mechanical contract'),
  -- Blackwood Sync: one payee, 65%
  ('33333333-0000-0000-0000-000000000004', '22222222-0000-0000-0000-000000000002', 0.65, 'publisher',  TRUE, 'Blackwood sole participant on sync deal'),
  -- Neon Coast Master: one payee, 22%
  ('33333333-0000-0000-0000-000000000005', '22222222-0000-0000-0000-000000000003', 0.22, 'artist',     TRUE, 'Neon Coast sole participant'),
  -- River Sessions Master: one payee, 15%
  ('33333333-0000-0000-0000-000000000006', '22222222-0000-0000-0000-000000000004', 0.15, 'artist',     TRUE, 'River Sessions sole participant');


-- ============================================================
-- REPERTOIRE
-- Works, tracks, and releases — not owned by payees.
-- linked_payee_id is informational (primary contributor).
-- Ownership and shares are determined by contract_payee_links.
-- ============================================================
INSERT INTO repertoire (id, repertoire_type, title, artist_name, writer_name, isrc, upc, internal_code, linked_payee_id, active_status) VALUES
  ('44444444-0000-0000-0000-000000000001', 'track',   'Midnight Signal',               'Aria Records',    'J. Fletcher / M. Rand', 'GBARL2400001', NULL,          'ARL-T-001', '22222222-0000-0000-0000-000000000001', TRUE),
  ('44444444-0000-0000-0000-000000000002', 'track',   'Glass Architecture',            'Aria Records',    'J. Fletcher',           'GBARL2400002', NULL,          'ARL-T-002', '22222222-0000-0000-0000-000000000001', TRUE),
  ('44444444-0000-0000-0000-000000000003', 'release', 'Signal / Architecture EP',      'Aria Records',    NULL,                    NULL,           '5060123456789','ARL-R-001', '22222222-0000-0000-0000-000000000001', TRUE),
  ('44444444-0000-0000-0000-000000000004', 'work',    'Midnight Signal (Composition)', NULL,              'J. Fletcher / M. Rand', NULL,           NULL,          'BWM-W-001', '22222222-0000-0000-0000-000000000002', TRUE),
  ('44444444-0000-0000-0000-000000000005', 'work',    'Glass Architecture (Composition)',NULL,            'J. Fletcher',           NULL,           NULL,          'BWM-W-002', '22222222-0000-0000-0000-000000000002', TRUE),
  ('44444444-0000-0000-0000-000000000006', 'track',   'Pacific Drive',                 'Neon Coast',      'M. Delgado',            'USNCL2400001', NULL,          'NCO-T-001', '22222222-0000-0000-0000-000000000003', TRUE),
  ('44444444-0000-0000-0000-000000000007', 'track',   'Estuary',                       'The River Sessions','E. Walsh',            'IERSE2400001', NULL,          'RSE-T-001', '22222222-0000-0000-0000-000000000004', TRUE),
  ('44444444-0000-0000-0000-000000000008', 'track',   'Unmatched Track XYZ',           'Unknown Artist',  'Unknown',               'ZZUNK2400099', NULL,          NULL,        NULL, TRUE);


-- ============================================================
-- CONTRACT REPERTOIRE LINKS
-- Links works to contracts. royalty_rate is the total rate for
-- this work on this contract. Each payee's actual take is:
--   royalty_rate × contract_payee_links.royalty_share
-- ============================================================
INSERT INTO contract_repertoire_links (contract_id, repertoire_id, royalty_rate) VALUES
  -- Aria Master → tracks and release
  ('33333333-0000-0000-0000-000000000001', '44444444-0000-0000-0000-000000000001', 0.18),
  ('33333333-0000-0000-0000-000000000001', '44444444-0000-0000-0000-000000000002', 0.18),
  ('33333333-0000-0000-0000-000000000001', '44444444-0000-0000-0000-000000000003', 0.18),
  -- Aria Publishing → composition works
  ('33333333-0000-0000-0000-000000000002', '44444444-0000-0000-0000-000000000004', 0.75),
  ('33333333-0000-0000-0000-000000000002', '44444444-0000-0000-0000-000000000005', 0.75),
  -- Blackwood Mechanical → same works (Sony sub-pub)
  -- Both Blackwood (50%) and Indie Co-Pub (25%) earn from these
  ('33333333-0000-0000-0000-000000000003', '44444444-0000-0000-0000-000000000004', 0.75),
  ('33333333-0000-0000-0000-000000000003', '44444444-0000-0000-0000-000000000005', 0.75),
  -- Blackwood Sync → same works, different rate
  ('33333333-0000-0000-0000-000000000004', '44444444-0000-0000-0000-000000000004', 0.65),
  ('33333333-0000-0000-0000-000000000004', '44444444-0000-0000-0000-000000000005', 0.65),
  -- Neon Coast Master → Pacific Drive
  ('33333333-0000-0000-0000-000000000005', '44444444-0000-0000-0000-000000000006', 0.22),
  -- River Sessions Master → Estuary
  ('33333333-0000-0000-0000-000000000006', '44444444-0000-0000-0000-000000000007', 0.15);


-- ============================================================
-- IMPORTS
-- ============================================================
INSERT INTO imports (id, import_type, domain, source_name, file_name, statement_period_id, imported_by_name, row_count, success_count, warning_count, error_count, import_status) VALUES
  ('55555555-0000-0000-0000-000000000001', 'eddy',          'master',     'Eddy 2024-H1 Master Export',       'eddy_2024_h1_master.csv',    '11111111-0000-0000-0000-000000000001', 'Admin', 45, 40, 3, 2, 'complete'),
  ('55555555-0000-0000-0000-000000000002', 'eddy',          'master',     'Eddy 2024-H2 Master Export',       'eddy_2024_h2_master.csv',    '11111111-0000-0000-0000-000000000002', 'Admin', 38, 35, 2, 1, 'complete'),
  ('55555555-0000-0000-0000-000000000003', 'publishing_csv', 'publishing', 'In-house Publishing 2024-H1',     'publishing_2024_h1.csv',     '11111111-0000-0000-0000-000000000001', 'Admin', 22, 20, 1, 1, 'complete'),
  ('55555555-0000-0000-0000-000000000004', 'publishing_csv', 'publishing', 'In-house Publishing 2024-H2',     'publishing_2024_h2.csv',     '11111111-0000-0000-0000-000000000002', 'Admin', 18, 17, 1, 0, 'complete');


-- ============================================================
-- STATEMENT RECORDS
-- Key: (contract_id, payee_id, statement_period_id)
-- royalty_share_snapshot = value from contract_payee_links at time of generation
-- opening_balance = 0 always (Approach B)
-- ============================================================

-- 2024-H1 MASTER — Aria Records on ARL-M-001 (APPROVED, output generated, sent)
INSERT INTO statement_records (
  id, contract_id, payee_id, domain, statement_period_id,
  royalty_share_snapshot,
  opening_balance, current_earnings, deductions,
  closing_balance_pre_carryover, prior_period_carryover_applied,
  final_balance_after_carryover, payable_amount, carry_forward_amount, issued_amount,
  is_payable, is_recouping, carryover_rule_applied, balance_model,
  balance_source_summary, source_import_ids,
  balance_confirmed_flag, carryover_confirmed_flag,
  calculation_status, review_status, approval_status, output_status, email_status,
  output_generated_flag, sent_date, checked_by, approved_by, approved_at
) VALUES (
  'aaaaaaaa-0000-0000-0000-000000000001',
  '33333333-0000-0000-0000-000000000001',
  '22222222-0000-0000-0000-000000000001',
  'master', '11111111-0000-0000-0000-000000000001',
  0.18,
  0, 2450.00, 0, 2450.00, 0, 2450.00, 2450.00, 0, 2450.00,
  TRUE, FALSE, TRUE, 'approach_b',
  'Eddy H1 2024 — Aria Master — 40 matched lines. Royalty share 18%.',
  '["55555555-0000-0000-0000-000000000001"]',
  TRUE, TRUE,
  'calculated', 'reviewed', 'approved', 'generated', 'sent',
  TRUE, '2024-08-15', 'Sarah K', 'James M', '2024-08-10 09:30:00'
);

-- 2024-H1 PUBLISHING — Aria Records on ARL-P-001 (APPROVED, output generated, sent)
INSERT INTO statement_records (
  id, contract_id, payee_id, domain, statement_period_id,
  royalty_share_snapshot,
  opening_balance, current_earnings, deductions,
  closing_balance_pre_carryover, prior_period_carryover_applied,
  final_balance_after_carryover, payable_amount, carry_forward_amount, issued_amount,
  is_payable, is_recouping, carryover_rule_applied, balance_model,
  balance_source_summary, source_import_ids,
  balance_confirmed_flag, carryover_confirmed_flag,
  calculation_status, review_status, approval_status, output_status, email_status,
  output_generated_flag, sent_date, checked_by, approved_by, approved_at
) VALUES (
  'aaaaaaaa-0000-0000-0000-000000000002',
  '33333333-0000-0000-0000-000000000002',
  '22222222-0000-0000-0000-000000000001',
  'publishing', '11111111-0000-0000-0000-000000000001',
  0.75,
  0, 1180.50, 0, 1180.50, 0, 1180.50, 1180.50, 0, 1180.50,
  TRUE, FALSE, TRUE, 'approach_b',
  'In-house publishing H1 2024 — Aria Publishing. Royalty share 75%.',
  '["55555555-0000-0000-0000-000000000003"]',
  TRUE, TRUE,
  'calculated', 'reviewed', 'approved', 'generated', 'sent',
  TRUE, '2024-08-15', 'Sarah K', 'James M', '2024-08-10 09:30:00'
);

-- 2024-H1 PUBLISHING — Blackwood on BWM-P-001 Mechanical (APPROVED, output ready, NOT sent)
INSERT INTO statement_records (
  id, contract_id, payee_id, domain, statement_period_id,
  royalty_share_snapshot,
  opening_balance, current_earnings, deductions,
  closing_balance_pre_carryover, prior_period_carryover_applied,
  final_balance_after_carryover, payable_amount, carry_forward_amount, issued_amount,
  is_payable, is_recouping, carryover_rule_applied, balance_model,
  balance_source_summary, source_import_ids,
  balance_confirmed_flag, carryover_confirmed_flag,
  calculation_status, review_status, approval_status, output_status, email_status,
  output_generated_flag, checked_by, approved_by, approved_at
) VALUES (
  'aaaaaaaa-0000-0000-0000-000000000003',
  '33333333-0000-0000-0000-000000000003',
  '22222222-0000-0000-0000-000000000002',
  'publishing', '11111111-0000-0000-0000-000000000001',
  0.50,
  0, 3200.00, 120.00, 3080.00, 0, 3080.00, 3080.00, 0, 0,
  TRUE, FALSE, TRUE, 'approach_b',
  'Sony mechanical H1 2024 — Blackwood 50% share of BWM-P-001.',
  '["55555555-0000-0000-0000-000000000003"]',
  TRUE, TRUE,
  'calculated', 'reviewed', 'approved', 'generated', 'not_prepared',
  TRUE, 'Sarah K', 'James M', '2024-08-12 14:00:00'
);

-- 2024-H1 PUBLISHING — Indie Co-Pub on BWM-P-001 Mechanical (demonstrates two payees on one contract)
INSERT INTO statement_records (
  id, contract_id, payee_id, domain, statement_period_id,
  royalty_share_snapshot,
  opening_balance, current_earnings, deductions,
  closing_balance_pre_carryover, prior_period_carryover_applied,
  final_balance_after_carryover, payable_amount, carry_forward_amount, issued_amount,
  is_payable, is_recouping, carryover_rule_applied, balance_model,
  balance_source_summary, source_import_ids,
  balance_confirmed_flag, carryover_confirmed_flag,
  calculation_status, review_status, approval_status, output_status, email_status,
  output_generated_flag
) VALUES (
  'aaaaaaaa-0000-0000-0000-000000000008',
  '33333333-0000-0000-0000-000000000003',
  '22222222-0000-0000-0000-000000000005',
  'publishing', '11111111-0000-0000-0000-000000000001',
  0.25,
  0, 1600.00, 60.00, 1540.00, 0, 1540.00, 1540.00, 0, 0,
  TRUE, FALSE, TRUE, 'approach_b',
  'Sony mechanical H1 2024 — Indie Co-Pub 25% share of BWM-P-001. Same contract as Blackwood.',
  '["55555555-0000-0000-0000-000000000003"]',
  TRUE, TRUE,
  'calculated', 'not_started', 'pending', 'not_generated', 'not_prepared',
  FALSE
);

-- 2024-H1 MASTER — Neon Coast on NCO-M-001 (APPROVED, output ready, BLOCKED — no email)
INSERT INTO statement_records (
  id, contract_id, payee_id, domain, statement_period_id,
  royalty_share_snapshot,
  opening_balance, current_earnings, deductions,
  closing_balance_pre_carryover, prior_period_carryover_applied,
  final_balance_after_carryover, payable_amount, carry_forward_amount, issued_amount,
  is_payable, is_recouping, carryover_rule_applied, balance_model,
  balance_source_summary, source_import_ids,
  balance_confirmed_flag, carryover_confirmed_flag,
  calculation_status, review_status, approval_status, output_status, email_status,
  output_generated_flag
) VALUES (
  'aaaaaaaa-0000-0000-0000-000000000004',
  '33333333-0000-0000-0000-000000000005',
  '22222222-0000-0000-0000-000000000003',
  'master', '11111111-0000-0000-0000-000000000001',
  0.22,
  0, 875.00, 0, 875.00, 0, 875.00, 875.00, 0, 0,
  TRUE, FALSE, TRUE, 'approach_b',
  'Eddy H1 2024 — Neon Coast — NCO-M-001. Payee has no email address.',
  '["55555555-0000-0000-0000-000000000001"]',
  TRUE, TRUE,
  'calculated', 'reviewed', 'approved', 'generated', 'not_prepared',
  TRUE
);

-- 2024-H1 MASTER — River Sessions on RSE-M-001 (RECOUPING)
INSERT INTO statement_records (
  id, contract_id, payee_id, domain, statement_period_id,
  royalty_share_snapshot,
  opening_balance, current_earnings, deductions,
  closing_balance_pre_carryover, prior_period_carryover_applied,
  final_balance_after_carryover, payable_amount, carry_forward_amount, issued_amount,
  is_payable, is_recouping, carryover_rule_applied, balance_model,
  balance_source_summary, source_import_ids,
  balance_confirmed_flag, carryover_confirmed_flag,
  calculation_status, review_status, approval_status, output_status
) VALUES (
  'aaaaaaaa-0000-0000-0000-000000000005',
  '33333333-0000-0000-0000-000000000006',
  '22222222-0000-0000-0000-000000000004',
  'master', '11111111-0000-0000-0000-000000000001',
  0.15,
  0, 312.50, 0, 312.50, -5000.00, -4687.50, 0, 0, 0,
  FALSE, TRUE, TRUE, 'approach_b',
  'Eddy H1 2024 — River Sessions — RSE-M-001. Recouping advance. Carryover entry brings in -5000 unrecouped.',
  '["55555555-0000-0000-0000-000000000001"]',
  TRUE, TRUE,
  'calculated', 'reviewed', 'approved', 'not_generated'
);

-- 2024-H2 MASTER — Aria Records on ARL-M-001 (IN PROGRESS)
INSERT INTO statement_records (
  id, contract_id, payee_id, domain, statement_period_id,
  royalty_share_snapshot,
  opening_balance, current_earnings, deductions,
  closing_balance_pre_carryover, prior_period_carryover_applied,
  final_balance_after_carryover, payable_amount, carry_forward_amount, issued_amount,
  is_payable, is_recouping, carryover_rule_applied, balance_model,
  balance_source_summary, source_import_ids,
  balance_confirmed_flag, carryover_confirmed_flag,
  calculation_status, review_status, approval_status, output_status
) VALUES (
  'aaaaaaaa-0000-0000-0000-000000000006',
  '33333333-0000-0000-0000-000000000001',
  '22222222-0000-0000-0000-000000000001',
  'master', '11111111-0000-0000-0000-000000000002',
  0.18,
  0, 3100.00, 0, 3100.00, 0, 3100.00, 3100.00, 0, 0,
  TRUE, FALSE, TRUE, 'approach_b',
  'Eddy H2 2024 — Aria Master — preliminary.',
  '["55555555-0000-0000-0000-000000000002"]',
  TRUE, FALSE,
  'calculated', 'in_review', 'pending', 'not_generated'
);

-- 2024-H2 PUBLISHING — Blackwood on BWM-P-001 (below threshold, will carry forward)
INSERT INTO statement_records (
  id, contract_id, payee_id, domain, statement_period_id,
  royalty_share_snapshot,
  opening_balance, current_earnings, deductions,
  closing_balance_pre_carryover, prior_period_carryover_applied,
  final_balance_after_carryover, payable_amount, carry_forward_amount, issued_amount,
  is_payable, is_recouping, carryover_rule_applied, balance_model,
  balance_source_summary, source_import_ids,
  balance_confirmed_flag, carryover_confirmed_flag,
  calculation_status, review_status, approval_status, output_status
) VALUES (
  'aaaaaaaa-0000-0000-0000-000000000007',
  '33333333-0000-0000-0000-000000000003',
  '22222222-0000-0000-0000-000000000002',
  'publishing', '11111111-0000-0000-0000-000000000002',
  0.50,
  0, 72.00, 0, 72.00, 0, 72.00, 0, 72.00, 0,
  FALSE, FALSE, TRUE, 'approach_b',
  'In-house publishing H2 2024 — Blackwood BWM-P-001. Below GBP 100 threshold.',
  '["55555555-0000-0000-0000-000000000004"]',
  TRUE, FALSE,
  'calculated', 'not_started', 'pending', 'not_generated'
);


-- ============================================================
-- CARRYOVER LEDGER
-- Note: key is now (contract_id, payee_id, from_period, to_period)
-- River Sessions H1 2024 had a -5000 advance; this is represented
-- as a negative carryover into H1 2024 from a prior period.
-- ============================================================
INSERT INTO carryover_ledger (
  contract_id, payee_id, domain, from_period_id, to_period_id,
  carried_amount, currency, carry_reason, balance_at_carry,
  source_statement_record_id, notes, created_by
) VALUES
  -- Blackwood BWM-P-001 H2 2024 below threshold → carries into next period
  (
    '33333333-0000-0000-0000-000000000003',
    '22222222-0000-0000-0000-000000000002',
    'publishing',
    '11111111-0000-0000-0000-000000000002',
    '11111111-0000-0000-0000-000000000001', -- to_period: 2025-H1 (would be added when that period is created)
    72.00, 'GBP', 'below_threshold', 72.00,
    'aaaaaaaa-0000-0000-0000-000000000007',
    'H2 2024 balance below £100 threshold. Carries forward.',
    'System'
  ),
  -- River Sessions RSE-M-001: advance of -5000 carried into H1 2024
  (
    '33333333-0000-0000-0000-000000000006',
    '22222222-0000-0000-0000-000000000004',
    'master',
    '11111111-0000-0000-0000-000000000003',  -- from: 2023-H2
    '11111111-0000-0000-0000-000000000001',  -- to: 2024-H1
    -5000.00, 'EUR', 'recouping', -5000.00,
    NULL,
    'Unrecouped advance of EUR 5,000 from 2023-H2 carried into 2024-H1.',
    'Admin'
  );


-- ============================================================
-- STATEMENT LINE SUMMARIES (sample lines for approved statements)
-- ============================================================
INSERT INTO statement_line_summaries (statement_record_id, line_category, title, identifier, retailer_channel, territory, quantity, gross_amount, net_amount) VALUES
  -- Aria Master H1 2024
  ('aaaaaaaa-0000-0000-0000-000000000001', 'digital', 'Midnight Signal',    'GBARL2400001', 'Spotify',     'UK',  45230, 980.00,  882.00),
  ('aaaaaaaa-0000-0000-0000-000000000001', 'digital', 'Glass Architecture', 'GBARL2400002', 'Spotify',     'UK',  32100, 620.00,  558.00),
  ('aaaaaaaa-0000-0000-0000-000000000001', 'digital', 'Midnight Signal',    'GBARL2400001', 'Apple Music', 'WW',  12500, 580.00,  522.00),
  ('aaaaaaaa-0000-0000-0000-000000000001', 'digital', 'Glass Architecture', 'GBARL2400002', 'Apple Music', 'WW',   8200, 268.00,  241.20),
  ('aaaaaaaa-0000-0000-0000-000000000001', 'digital', 'Midnight Signal',    'GBARL2400001', 'Amazon',      'WW',   3400, 246.80,  246.80),
  -- River Sessions H1 2024 (recouping — shows earnings against unrecouped balance)
  ('aaaaaaaa-0000-0000-0000-000000000005', 'digital', 'Estuary',            'IERSE2400001', 'Spotify',     'EU',   8750, 312.50,  312.50);


-- ============================================================
-- STATEMENT OUTPUTS (for approved statements)
-- ============================================================
INSERT INTO statement_outputs (statement_record_id, output_type, file_name, version_number, output_status, generated_by) VALUES
  ('aaaaaaaa-0000-0000-0000-000000000001', 'excel', 'Aria_Records_ARL-M-001_2024-H1_v1.xlsx', 1, 'generated', 'Admin'),
  ('aaaaaaaa-0000-0000-0000-000000000001', 'csv',   'Aria_Records_ARL-M-001_2024-H1_v1.csv',  1, 'generated', 'Admin'),
  ('aaaaaaaa-0000-0000-0000-000000000002', 'excel', 'Aria_Records_ARL-P-001_2024-H1_v1.xlsx', 1, 'generated', 'Admin'),
  ('aaaaaaaa-0000-0000-0000-000000000003', 'excel', 'Blackwood_BWM-P-001_2024-H1_v1.xlsx',    1, 'generated', 'Admin'),
  ('aaaaaaaa-0000-0000-0000-000000000004', 'excel', 'Neon_Coast_NCO-M-001_2024-H1_v1.xlsx',   1, 'generated', 'Admin');


-- ============================================================
-- APPROVAL LOG
-- ============================================================
INSERT INTO approval_log (statement_record_id, approval_stage, previous_stage, approved_by, approved_at, comments) VALUES
  ('aaaaaaaa-0000-0000-0000-000000000001', 'checked',  'pending',  'Sarah K', '2024-08-09 15:00:00', 'Balances match Eddy export. Lines reconciled.'),
  ('aaaaaaaa-0000-0000-0000-000000000001', 'approved', 'checked',  'James M', '2024-08-10 09:30:00', 'Approved for issue.'),
  ('aaaaaaaa-0000-0000-0000-000000000002', 'checked',  'pending',  'Sarah K', '2024-08-09 15:10:00', 'Publishing lines reconciled.'),
  ('aaaaaaaa-0000-0000-0000-000000000002', 'approved', 'checked',  'James M', '2024-08-10 09:30:00', 'Approved.'),
  ('aaaaaaaa-0000-0000-0000-000000000003', 'checked',  'pending',  'Sarah K', '2024-08-12 13:00:00', 'Mechanical confirmed. Two payees on this contract.'),
  ('aaaaaaaa-0000-0000-0000-000000000003', 'approved', 'checked',  'James M', '2024-08-12 14:00:00', 'Approved — awaiting send.');


-- ============================================================
-- EXCEPTIONS
-- ============================================================
INSERT INTO exceptions (domain, severity, issue_type, statement_period_id, payee_id, contract_id, title, detail, resolution_status) VALUES
  (
    'master', 'critical', 'missing_email',
    '11111111-0000-0000-0000-000000000001',
    '22222222-0000-0000-0000-000000000003',
    '33333333-0000-0000-0000-000000000005',
    'Payable statement — no email address',
    'Neon Coast Productions has a payable balance of USD 875.00 on contract NCO-M-001 but no primary email is set. Statement cannot be sent.',
    'open'
  ),
  (
    'master', 'warning', 'unmatched_repertoire',
    '11111111-0000-0000-0000-000000000002',
    NULL, NULL,
    'Unmatched ISRC in H2 2024 import',
    'ISRC ZZUNK2400099 found in Eddy H2 2024 import. Does not match any repertoire record. 3 rows affected.',
    'open'
  ),
  (
    'publishing', 'info', 'carryover_below_threshold',
    '11111111-0000-0000-0000-000000000002',
    '22222222-0000-0000-0000-000000000002',
    '33333333-0000-0000-0000-000000000003',
    'Balance below threshold — carried forward',
    'Blackwood BWM-P-001 H2 2024 balance of GBP 72.00 is below the GBP 100 threshold. Carrying forward to next period.',
    'open'
  );
