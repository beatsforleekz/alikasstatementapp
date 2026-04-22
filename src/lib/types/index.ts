// ============================================================
// STATEMENT OPS — TYPE DEFINITIONS
//
// Statement unit: CONTRACT + PAYEE + PERIOD
//
// Key model rules:
//   - Contracts are standalone (no payee_id on Contract type)
//   - ContractPayeeLink is the junction: one row per payee on a contract
//   - royalty_share lives on ContractPayeeLink, not Contract
//   - StatementRecord is keyed by (contract_id, payee_id, statement_period_id)
//   - Balance model: Approach B — opening_balance always 0 for generated records
//
// v2 additions:
//   - PayeeAlias type
//   - SendingParty type
//   - ContractRepertoirePayeeSplit type (work-level splits, publishing allocation)
//   - Extended Contract with income-type rates + artist_share_percent
//   - Extended Repertoire with iswc + draft_status
//   - Extended Import with currency conversion fields
//   - Extended ImportRow with income_type + currency conversion
//   - PUBLISHING_INCOME_TYPES constant
// ============================================================

export type Domain = 'master' | 'publishing'
export type Half   = 'H1' | 'H2'

export const CONTRACT_TYPE_OPTIONS = [
  { value: 'publishing', label: 'Publishing', domain: 'publishing' as const },
  { value: 'single_song_assignment', label: 'Single Song Assignment', domain: 'publishing' as const },
  { value: 'master', label: 'Master', domain: 'master' as const },
  { value: 'add_producer', label: 'Add-Producer', domain: 'master' as const },
  { value: 'remix', label: 'Remix', domain: 'master' as const },
] as const

export type ContractType = typeof CONTRACT_TYPE_OPTIONS[number]['value']

export function normalizeContractType(raw: string | null | undefined): ContractType | null {
  const value = raw?.trim().toLowerCase()
  switch (value) {
    case 'publishing':
      return 'publishing'
    case 'single song assignment':
    case 'single_song_assignment':
    case 'ssa':
      return 'single_song_assignment'
    case 'master':
      return 'master'
    case 'add-producer':
    case 'add producer':
    case 'add_producer':
      return 'add_producer'
    case 'remix':
      return 'remix'
    default:
      return null
  }
}

export function contractTypeLabel(raw: string | null | undefined): string {
  const normalized = normalizeContractType(raw)
  if (!normalized) return raw ?? ''
  return CONTRACT_TYPE_OPTIONS.find(option => option.value === normalized)?.label ?? normalized
}

export function contractTypeToDomain(raw: string | null | undefined): Domain | null {
  const normalized = normalizeContractType(raw)
  if (!normalized) return null
  return CONTRACT_TYPE_OPTIONS.find(option => option.value === normalized)?.domain ?? null
}

export function isPublishingContractType(raw: string | null | undefined): boolean {
  return contractTypeToDomain(raw) === 'publishing'
}

export function isMasterContractType(raw: string | null | undefined): boolean {
  return contractTypeToDomain(raw) === 'master'
}

export interface PublishingContractDefaultValues {
  status: string
  currency: string
  territory: string
  statement_frequency: string
  hold_payment_flag: boolean
  approval_required: boolean
  is_recoupable: boolean
  pre_term_included: boolean
  mechanical_rate: string
  digital_mechanical_rate: string
  performance_rate: string
  digital_performance_rate: string
  synch_rate: string
  other_rate: string
}

export const PUBLISHING_CONTRACT_DEFAULTS: PublishingContractDefaultValues = {
  status: 'active',
  currency: 'EUR',
  territory: 'WW',
  statement_frequency: 'bi-annual',
  hold_payment_flag: false,
  approval_required: true,
  is_recoupable: true,
  pre_term_included: false,
  mechanical_rate: '70',
  digital_mechanical_rate: '70',
  performance_rate: '40',
  digital_performance_rate: '40',
  synch_rate: '60',
  other_rate: '70',
}

// ============================================================
// INCOME TYPES (publishing)
// Maps to contract rate columns: mechanical_rate, digital_mechanical_rate, etc.
// ============================================================
export const PUBLISHING_INCOME_TYPES = [
  'mechanical',
  'digital_mechanical',
  'performance',
  'digital_performance',
  'synch',
  'other',
] as const

export type PublishingIncomeType = typeof PUBLISHING_INCOME_TYPES[number]

/** Map an income_type string to the corresponding Contract rate column */
export function incomeTypeToRateColumn(incomeType: string | null | undefined): keyof Contract {
  switch (incomeType) {
    case 'mechanical':            return 'mechanical_rate'
    case 'digital_mechanical':    return 'digital_mechanical_rate'
    case 'performance':           return 'performance_rate'
    case 'digital_performance':   return 'digital_performance_rate'
    case 'synch':                 return 'synch_rate'
    default:                      return 'other_rate'
  }
}

// ============================================================
// PAYEES
// ============================================================
export interface Payee {
  id:                   string
  payee_name:           string
  statement_name:       string | null
  primary_contact_name: string | null
  primary_email:        string | null
  secondary_email:      string | null
  currency:             string
  territory:            string | null
  active_status:        boolean
  vendor_reference:     string | null
  notes:                string | null
  created_at:           string
  updated_at:           string
}

// ============================================================
// PAYEE ALIASES
// Alternate name variations for matching.
// ============================================================
export interface PayeeAlias {
  id:         string
  payee_id:   string
  alias_name: string
  is_active:  boolean
  created_at: string
  updated_at: string
  // joined
  payee?: Payee
}

// ============================================================
// SENDING PARTIES
// Entity that issues / sends statements.
// ============================================================
export interface SendingParty {
  id:             string
  name:           string
  company_name:   string | null
  trading_name:   string | null
  address:        string | null
  email:          string | null
  vat_number:     string | null
  company_number: string | null
  is_active:      boolean
  notes:          string | null
  created_at:     string
  updated_at:     string
}

// ============================================================
// CONTRACTS
// No payee_id. Payee relationships are in ContractPayeeLink.
//
// v2 additions:
//   - sending_party_id
//   - artist_share_percent (master)
//   - income-type rate columns (publishing)
//   - is_recoupable, cross_recoup_group
//   - statement_frequency, pre_term_included, exclusion_notes
// ============================================================
export interface Contract {
  id:                                 string
  contract_name:                      string
  contract_code:                      string | null
  contract_type:                      string
  currency:                           string
  territory:                          string | null
  start_date:                         string | null
  end_date:                           string | null
  status:                             string
  source_system:                      string | null
  source_reference:                   string | null
  sending_party_id:                   string | null

  // Payment control
  minimum_payment_threshold_override: number | null
  hold_payment_flag:                  boolean
  approval_required:                  boolean
  is_recoupable:                      boolean
  cross_recoup_group:                 string | null
  statement_frequency:                'monthly' | 'quarterly' | 'bi-annual' | 'annual' | null
  pre_term_included:                  boolean
  exclusion_notes:                    string | null

  // MASTER: artist share
  // Total income × artist_share_percent → amount to split across payee links
  artist_share_percent:               number | null   // e.g. 0.20 = 20%

  // PUBLISHING: income-type rates
  // Applied per matching income_type on import_row to determine earnings contribution
  mechanical_rate:                    number | null
  digital_mechanical_rate:            number | null
  performance_rate:                   number | null
  digital_performance_rate:           number | null
  synch_rate:                         number | null
  other_rate:                         number | null

  notes:                              string | null
  created_at:                         string
  updated_at:                         string

  // joined
  sending_party?:     SendingParty
  payee_links?:       ContractPayeeLink[]
  repertoire_links?:  ContractRepertoireLink[]
}

// ============================================================
// CONTRACT PAYEE LINKS
// ============================================================
export interface ContractPayeeLink {
  id:             string
  contract_id:    string
  payee_id:       string
  royalty_share:  number
  role:           string | null
  statement_name: string | null
  start_date:     string | null
  end_date:       string | null
  is_active:      boolean
  notes:          string | null
  created_at:     string
  // joined
  payee?:    Payee
  contract?: Contract
}

// ============================================================
// REPERTOIRE
// v2: added iswc (primary publishing identifier), draft_status.
// ============================================================
export interface Repertoire {
  id:               string
  repertoire_type:  'track' | 'release' | 'work'
  title:            string
  artist_name:      string | null
  writer_name:      string | null
  tempo_id:         string | null   // Sony Song ID / Tempo ID
  isrc:             string | null   // master track identifier
  upc:              string | null   // release identifier
  iswc:             string | null   // publishing work identifier (T-ddd.ddd.ddd-d)
  internal_code:    string | null
  source_id:        string | null   // legacy / source system ID
  linked_payee_id:  string | null
  active_status:    boolean
  draft_status:     'active' | 'draft' | 'needs_linking' | null
  notes:            string | null
  created_at:       string
  updated_at:       string
  // joined
  linked_payee?: Payee
}

// ============================================================
// CONTRACT REPERTOIRE LINKS
// ============================================================
export interface ContractRepertoireLink {
  id:             string
  contract_id:    string
  repertoire_id:  string
  royalty_rate:   number | null
  start_date:     string | null
  end_date:       string | null
  notes:          string | null
  // joined
  repertoire?: Repertoire
}

// ============================================================
// CONTRACT REPERTOIRE PAYEE SPLITS
// Source of truth for publishing allocation per work.
// A payee only receives allocation if a row exists here.
// ============================================================
export interface ContractRepertoirePayeeSplit {
  id:             string
  contract_id:    string
  repertoire_id:  string
  payee_id:       string
  split_percent:  number   // e.g. 0.50 = 50% of the work's income for this contract
  is_active:      boolean
  start_date:     string | null
  end_date:       string | null
  notes:          string | null
  created_at:     string
  updated_at:     string
  // joined
  payee?:      Payee
  repertoire?: Repertoire
  contract?:   Contract
}

// ============================================================
// STATEMENT PERIODS
// v2: added is_current flag
// ============================================================
export interface StatementPeriod {
  id:            string
  year:          number
  half:          Half
  label:         string
  period_start:  string
  period_end:    string
  status:        'open' | 'locked' | 'archived'
  is_current:    boolean
  notes:         string | null
  created_at:    string
  updated_at:    string
}

// ============================================================
// IMPORTS
// v2: added currency conversion fields
// ============================================================
export interface Import {
  id:                   string
  import_type:          string   // believe | eddy | sony_publishing | publishing_csv | sony_balance
  domain:               Domain
  source_name:          string | null
  file_name:            string | null
  statement_period_id:  string | null
  imported_at:          string
  imported_by:          string | null
  imported_by_name:     string | null
  row_count:            number
  success_count:        number
  warning_count:        number
  error_count:          number
  import_status:        'pending' | 'processing' | 'complete' | 'failed' | 'partial'
  column_mapping_json:  Record<string, string> | null
  raw_snapshot_json:    unknown | null

  // Currency conversion
  source_currency:      string | null
  reporting_currency:   string | null
  exchange_rate:        number | null
  exchange_rate_date:   string | null

  notes:                string | null
}

// Import type metadata for UI — domain-specific source options
export interface ImportTypeOption {
  value:       string
  label:       string
  domain:      Domain
  badge?:      'primary' | 'legacy' | 'secondary'
  description: string
}

export const IMPORT_TYPE_OPTIONS: ImportTypeOption[] = [
  // MASTER
  {
    value: 'believe',
    label: 'Believe Automatic Report',
    domain: 'master',
    badge: 'primary',
    description: 'Semicolon-delimited CSV from Believe automated reporting. Primary source for master sales data. ISRC primary, UPC secondary.',
  },
  {
    value: 'eddy',
    label: 'Eddy Export',
    domain: 'master',
    badge: 'legacy',
    description: 'Comma-delimited CSV from the Eddy platform. Retained for historical data only. New periods should use Believe.',
  },
  // PUBLISHING
  {
    value: 'sony_csv',
    label: 'Sony CSV (Wide)',
    domain: 'publishing',
    badge: 'primary',
    description: 'Wide-format Sony CSV import. Each song row is expanded into per-income rows using Tempo ID as the primary publishing identifier.',
  },
  {
    value: 'sony_publishing',
    label: 'Sony Music Publishing Import',
    domain: 'publishing',
    badge: 'primary',
    description: 'Standard line-by-line transaction import from Sony Music Publishing. Tempo ID is primary, ISWC is fallback, and rows are then allocated per stored payee splits.',
  },
  {
    value: 'publishing_csv',
    label: 'Publishing CSV (In-house)',
    domain: 'publishing',
    badge: 'secondary',
    description: 'Manual in-house publishing CSV. Secondary/manual option for custom sources.',
  },
  {
    value: 'sony_balance',
    label: 'Sony Balance Import',
    domain: 'publishing',
    badge: 'secondary',
    description: 'Balance-level Sony import. Secondary option — use Sony Publishing Import for line-level data.',
  },
]

// ============================================================
// IMPORT ROWS
// v2: added income_type, currency conversion fields
// ============================================================
export interface ImportRow {
  id:                    string
  import_id:             string
  raw_row_number:        number | null
  domain:                Domain
  statement_period_id:   string | null

  // Raw fields
  payee_name_raw:        string | null
  contract_name_raw:     string | null
  artist_name_raw:       string | null
  title_raw:             string | null
  identifier_raw:        string | null
  country_raw:           string | null
  transaction_date:      string | null
  row_type:              string | null
  income_type:           string | null   // publishing: mechanical | digital_mechanical | performance | digital_performance | synch | other

  // Financial
  amount:                number | null
  currency:              string | null

  // Currency conversion
  amount_converted:      number | null
  converted_currency:    string | null
  exchange_rate_used:    number | null

  // Eddy-specific
  channel:               string | null
  retailer:              string | null
  quantity:              number | null
  original_currency:     string | null
  sale_amount_original:  number | null
  royalty_base_percentage: number | null
  base_amount:           number | null
  gross_cost_recovered:  number | null
  threshold_step_amount: number | null
  threshold_step:        string | null
  reserved_amount_pre_rate: number | null
  royalty_rate:          number | null
  contract_amount:       number | null
  deducted_amount:       number | null
  reserved_amount:       number | null
  final_contract_amount: number | null
  payee_split:           number | null
  net_amount:            number | null

  // Normalized
  normalized_title:      string | null
  normalized_identifier: string | null

  // Match results
  matched_payee_id:      string | null
  matched_contract_id:   string | null
  matched_repertoire_id: string | null
  match_status:          'matched' | 'partial' | 'unmatched' | 'manual_override'

  // Flags
  error_flag:            boolean
  error_reason:          string | null
  warning_flag:          boolean
  warning_reason:        string | null
  excluded_flag:         boolean
  exclusion_reason:      string | null
  raw_payload_json:      unknown | null
}

// ============================================================
// STATEMENT RECORDS
// ============================================================
export interface StatementRecord {
  id:                    string
  contract_id:           string
  payee_id:              string
  statement_period_id:   string
  domain:                Domain
  royalty_share_snapshot: number

  opening_balance:                   number
  current_earnings:                  number
  deductions:                        number
  closing_balance_pre_carryover:     number
  prior_period_carryover_applied:    number
  final_balance_after_carryover:     number
  payable_amount:                    number
  carry_forward_amount:              number
  issued_amount:                     number

  is_payable:              boolean
  is_recouping:            boolean
  carryover_rule_applied:  boolean
  hold_payment_flag:       boolean
  balance_model:           'approach_b'

  balance_source_summary:  string | null
  source_import_ids:       string[] | null

  manual_override_flag:    boolean
  override_notes:          string | null
  override_by:             string | null
  override_at:             string | null

  balance_confirmed_flag:   boolean
  carryover_confirmed_flag: boolean

  calculation_status:      'pending' | 'calculated' | 'needs_review' | 'error'
  calculation_notes:       string | null
  last_calculated_at:      string | null

  review_status:           'not_started' | 'in_review' | 'reviewed'
  approval_status:         'pending' | 'approved' | 'rejected' | 'on_hold'
  output_status:           'not_generated' | 'generated' | 'outdated'
  output_generated_flag:   boolean
  statement_currency:      string | null
  exchange_rate_snapshot:  number | null

  email_status:            'not_prepared' | 'prepared' | 'sent'
  email_prepared_subject:  string | null
  email_prepared_body:     string | null
  email_prepared_at:       string | null
  email_prepared_by:       string | null

  portal_visible_flag:     boolean
  portal_published_at:     string | null
  portal_published_by:     string | null
  portal_version:          number
  portal_notes:            string | null

  sent_date:               string | null
  paid_date:               string | null
  checked_by:              string | null
  checked_at:              string | null
  approved_by:             string | null
  approved_at:             string | null

  created_at:              string
  updated_at:              string
}

// ============================================================
// STATEMENT LINE SUMMARIES
// ============================================================
export interface StatementLineSummary {
  id:                    string
  statement_record_id:   string
  source_import_row_id:  string | null
  line_category:         string | null
  title:                 string | null
  identifier:            string | null
  income_type:           string | null
  transaction_date:      string | null
  retailer_channel:      string | null
  territory:             string | null
  quantity:              number | null
  gross_amount:          number | null
  net_amount:            number | null
  deduction_amount:      number | null
  split_percent_applied: number | null
  rate_applied:          number | null
  pre_split_amount:      number | null
  notes:                 string | null
}

// ============================================================
// EXCEPTIONS
// ============================================================
export interface Exception {
  id:                   string
  domain:               Domain
  severity:             'critical' | 'warning' | 'info'
  issue_type:           string
  statement_period_id:  string | null
  payee_id:             string | null
  contract_id:          string | null
  import_id:            string | null
  import_row_id:        string | null
  statement_record_id:  string | null
  title:                string
  detail:               string | null
  resolution_status:    'open' | 'resolved' | 'dismissed' | 'wont_fix'
  resolution_notes:     string | null
  resolved_by:          string | null
  resolved_at:          string | null
  auto_generated:       boolean
  created_at:           string
}

// ============================================================
// STATEMENT OUTPUTS
// ============================================================
export interface StatementOutput {
  id:                   string
  statement_record_id:  string
  output_type:          'excel' | 'csv' | 'html' | 'pdf'
  storage_path:         string | null
  storage_bucket:       string | null
  file_name:            string | null
  version_number:       number
  output_status:        'generated' | 'superseded' | 'error'
  portal_accessible:    boolean
  access_expires_at:    string | null
  checksum:             string | null
  file_size_bytes:      number | null
  generated_at:         string
  generated_by:         string | null
  notes:                string | null
}

// ============================================================
// APPROVAL LOG
// ============================================================
export interface ApprovalLog {
  id:                   string
  statement_record_id:  string
  approval_stage:       'prepared' | 'checked' | 'approved' | 'rejected' | 'on_hold'
  previous_stage:       string | null
  approved_by:          string
  approved_at:          string
  comments:             string | null
}

// ============================================================
// CARRYOVER LEDGER
// ============================================================
export interface CarryoverLedger {
  id:                          string
  contract_id:                 string
  payee_id:                    string
  domain:                      Domain
  from_period_id:              string
  to_period_id:                string
  carried_amount:              number
  currency:                    string
  carry_reason:                'below_threshold' | 'on_hold' | 'recouping' | 'manual'
  balance_at_carry:            number | null
  threshold_at_carry:          number | null
  source_statement_record_id:  string | null
  notes:                       string | null
  created_at:                  string
  created_by:                  string | null
}

// ============================================================
// CONTRACT COSTS
// Costs/expenses linked to a contract for recoupment and
// statement inclusion. Only recoupable costs reduce payable.
// ============================================================
export type CostType =
  | 'advance'
  | 'recording'
  | 'marketing'
  | 'distribution'
  | 'mechanical_licence'
  | 'admin_fee'
  | 'legal'
  | 'other'

export type CostAppliedStatus = 'pending' | 'applied' | 'waived' | 'disputed'

export interface ContractCost {
  id:                   string
  contract_id:          string
  statement_period_id:  string | null  // NULL = applies to all periods until settled
  cost_type:            CostType | string
  description:          string
  cost_date:            string | null
  amount:               number
  currency:             string
  recoupable:           boolean        // TRUE = reduces payable; FALSE = informational only
  applied_status:       CostAppliedStatus
  applied_at:           string | null
  applied_by:           string | null
  notes:                string | null
  created_at:           string
  updated_at:           string
  // Joined
  contract?:            Pick<Contract, 'id' | 'contract_name' | 'contract_code'> | null
  statement_period?:    Pick<StatementPeriod, 'id' | 'label'> | null
}

// ============================================================
// AUTH / PORTAL TYPES
// ============================================================
export type UserRole = 'admin' | 'staff' | 'payee'

export interface UserProfile {
  id:               string
  role:             UserRole
  display_name:     string | null
  job_title:        string | null
  is_active:        boolean
  last_sign_in_at:  string | null
  notes:            string | null
  created_at:       string
  updated_at:       string
}

export interface PayeeUserLink {
  id:           string
  user_id:      string
  payee_id:     string
  access_level: 'read' | 'download'
  invited_by:   string | null
  invited_at:   string
  is_active:    boolean
  notes:        string | null
  payee?:        Payee
  user_profile?: UserProfile
}

// ============================================================
// PORTAL-SAFE STATEMENT VIEW
// ============================================================
export interface PortalStatementView {
  id:                   string
  contract_id:          string
  payee_id:             string
  domain:               Domain
  statement_period_id:  string
  contract_name:        string
  contract_code:        string | null
  royalty_share_snapshot: number
  current_earnings:               number
  deductions:                     number
  prior_period_carryover_applied: number
  final_balance_after_carryover:  number
  payable_amount:                 number
  carry_forward_amount:           number
  is_payable:                     boolean
  is_recouping:                   boolean
  carryover_rule_applied:         boolean
  portal_version:      number
  portal_published_at: string | null
  portal_notes:        string | null
  statement_period?: Pick<StatementPeriod, 'label' | 'period_start' | 'period_end'>
  line_summaries?:   StatementLineSummary[]
  outputs?:          Pick<StatementOutput, 'id' | 'output_type' | 'file_name' | 'generated_at'>[]
}

// ============================================================
// BUSINESS LOGIC TYPES
// ============================================================

export interface BalanceCalculation {
  opening_balance:                number
  current_earnings:               number
  deductions:                     number
  closing_balance_pre_carryover:  number
  prior_period_carryover_applied: number
  final_balance_after_carryover:  number
  payable_amount:                 number
  carry_forward_amount:           number
  is_payable:                     boolean
  is_recouping:                   boolean
}

export interface CarryoverCalculationResult {
  final_balance_after_carryover: number
  payable_amount:                number
  carry_forward_amount:          number
  is_payable:                    boolean
  carryover_rule_applied:        boolean
  threshold_used:                number
  below_threshold:               boolean
  carry_reason:                  'below_threshold' | 'on_hold' | 'recouping' | null
  notes:                         string
}

export interface ReadyToIssueCheck {
  ready:    boolean
  blockers: string[]
  warnings: string[]
}

export interface StatementIdentity {
  contract_id:          string
  payee_id:             string
  statement_period_id:  string
}

export interface StatementRunSummary {
  period:                         StatementPeriod
  domain:                         Domain
  imports_count:                  number
  statement_records_count:        number
  payable_count:                  number
  payable_total:                  number
  recouping_count:                number
  approved_count:                 number
  output_generated_count:         number
  sent_count:                     number
  unresolved_critical_exceptions: number
  unmatched_rows:                 number
}

// ============================================================
// PUBLISHING ALLOCATION RESULT
// Produced per row during publishing import matching.
// Each payee on a work gets their own AllocationResult.
// ============================================================
export interface PublishingAllocationResult {
  repertoire_id:   string
  contract_id:     string
  payee_id:        string
  income_type:     string
  rate_applied:    number   // from contract income-type rate column
  split_percent:   number   // from contract_repertoire_payee_splits
  source_amount:   number   // original row amount
  allocated_amount: number  // source_amount × rate_applied × split_percent
  warning?:        string
}

// ============================================================
// CARRYOVER CONSTANTS
// ============================================================
export const DEFAULT_PAYMENT_THRESHOLD = 100

export function getPaymentThreshold(contract: Contract | null): number {
  return contract?.minimum_payment_threshold_override ?? DEFAULT_PAYMENT_THRESHOLD
}

// ============================================================
// OUTPUT IDENTITY HELPERS
// ============================================================
export function buildOutputFilename(
  payeeName: string,
  contractCode: string | null,
  periodLabel: string,
  version: number,
  ext: 'xlsx' | 'csv' | 'html' | 'pdf'
): string {
  const safeName   = payeeName.replace(/[^a-zA-Z0-9]/g, '_').replace(/_+/g, '_')
  const safeCode   = (contractCode ?? 'NOCODE').replace(/[^a-zA-Z0-9-]/g, '_')
  const safePeriod = periodLabel.replace(/[^a-zA-Z0-9-]/g, '_')
  return `${safeName}_${safeCode}_${safePeriod}_v${version}.${ext}`
}

export function buildStatementTitle(
  payeeName: string,
  contractName: string,
  periodLabel: string
): string {
  return `${payeeName} — ${contractName} — ${periodLabel}`
}
