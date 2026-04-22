/**
 * EXCEPTION GENERATION
 *
 * Automatically creates exception records for known business rule violations.
 * These are inserted into the exceptions table and surfaced in the UI.
 * Exceptions are NEVER auto-resolved — only a user can resolve them.
 */

import type { Domain, StatementRecord, Payee, Import } from '@/lib/types'

export interface ExceptionInput {
  domain: Domain
  severity: 'critical' | 'warning' | 'info'
  issue_type: string
  statement_period_id?: string | null
  payee_id?: string | null
  contract_id?: string | null
  import_id?: string | null
  import_row_id?: string | null
  statement_record_id?: string | null
  title: string
  detail: string
}

// ============================================================
// EXCEPTION DETECTORS
// ============================================================

/**
 * Check a statement record for all known exception conditions.
 * Returns a list of exceptions to insert (caller deduplicates against existing).
 */
export function detectStatementExceptions(
  record: StatementRecord,
  payee: Payee,
  unresolvedImportWarnings: number
): ExceptionInput[] {
  const exceptions: ExceptionInput[] = []
  const base = {
    domain: record.domain,
    statement_period_id: record.statement_period_id,
    payee_id: record.payee_id,
    statement_record_id: record.id,
  }

  // CRITICAL: Payable but missing email
  if (record.is_payable && !payee.primary_email) {
    exceptions.push({
      ...base,
      severity: 'critical',
      issue_type: 'missing_email',
      title: 'Payable statement — no email address',
      detail: `${payee.payee_name} has a payable balance of ${record.payable_amount.toFixed(2)} but no primary email address is set. Statement cannot be sent.`,
    })
  }

  // CRITICAL: Approved but no output
  if (record.approval_status === 'approved' && !record.output_generated_flag) {
    exceptions.push({
      ...base,
      severity: 'critical',
      issue_type: 'output_missing',
      title: 'Approved statement has no output generated',
      detail: 'Statement is approved but no Excel/CSV/HTML output has been generated. Output must exist before issuing.',
    })
  }

  // CRITICAL: Payable but not approved
  if (record.is_payable && record.approval_status !== 'approved') {
    exceptions.push({
      ...base,
      severity: 'critical',
      issue_type: 'payable_not_approved',
      title: 'Payable statement is not approved',
      detail: `Statement has a payable amount of ${record.payable_amount.toFixed(2)} but approval status is "${record.approval_status}". Must be approved before issuing.`,
    })
  }

  // CRITICAL: Issued amount differs from payable without override notes
  if (
    record.issued_amount > 0 &&
    record.payable_amount > 0 &&
    Math.abs(record.issued_amount - record.payable_amount) > 0.01 &&
    !record.override_notes
  ) {
    exceptions.push({
      ...base,
      severity: 'critical',
      issue_type: 'issued_payable_mismatch',
      title: 'Issued amount differs from payable amount',
      detail: `Payable: ${record.payable_amount.toFixed(2)}, Issued: ${record.issued_amount.toFixed(2)}. Difference requires override notes.`,
    })
  }

  // WARNING: Payable but not sent
  if (
    record.approval_status === 'approved' &&
    record.is_payable &&
    record.output_generated_flag &&
    record.email_status !== 'sent'
  ) {
    exceptions.push({
      ...base,
      severity: 'warning',
      issue_type: 'payable_not_sent',
      title: 'Approved payable statement not yet sent',
      detail: 'Statement is approved with output generated but has not been marked as sent.',
    })
  }

  // WARNING: Carryover not confirmed
  if (!record.carryover_confirmed_flag && record.carryover_rule_applied) {
    exceptions.push({
      ...base,
      severity: 'warning',
      issue_type: 'carryover_not_confirmed',
      title: 'Carryover not confirmed',
      detail: 'Carryover rule has been applied but carryover amounts have not been confirmed by a reviewer.',
    })
  }

  // INFO: Balance below threshold, carrying forward
  if (record.carry_forward_amount > 0 && record.payable_amount === 0 && !record.is_recouping) {
    exceptions.push({
      ...base,
      severity: 'info',
      issue_type: 'carryover_below_threshold',
      title: 'Balance below payment threshold — carried forward',
      detail: `Balance of ${record.carry_forward_amount.toFixed(2)} is below the payment threshold and will carry to the next period.`,
    })
  }

  return exceptions
}

/**
 * Detect import-level exceptions (unmatched rows only).
 *
 * NOTE: missing_contract is intentionally NOT raised here.
 * Contract resolution happens AFTER repertoire matching and is handled
 * interactively via the Sales Error Resolution page. Raising it as an
 * exception at import time creates noise and blocks no workflow.
 */
export function detectImportExceptions(
  imp: Import,
  unmatchedRowCount: number,
  _missingContractCount?: number   // kept for call-site compat, ignored
): ExceptionInput[] {
  const exceptions: ExceptionInput[] = []
  const base = {
    domain: imp.domain,
    statement_period_id: imp.statement_period_id ?? null,
    import_id: imp.id,
  }

  if (unmatchedRowCount > 0) {
    exceptions.push({
      ...base,
      severity: 'warning',
      issue_type: 'unmatched_repertoire',
      title: `${unmatchedRowCount} import row(s) are unmatched`,
      detail: `Import "${imp.source_name}" contains ${unmatchedRowCount} row(s) that could not be matched to any repertoire item. Resolve these via the Sales Error Resolution page.`,
    })
  }

  return exceptions
}

export const IMPORT_EXCEPTION_ISSUE_TYPES = [
  'unmatched_row',
  'unmatched_repertoire',
  'missing_contract',
  'missing_allocation',
  'work_not_found',
] as const

export function isImportExceptionIssueType(issueType: string | null | undefined): boolean {
  return !!issueType && (IMPORT_EXCEPTION_ISSUE_TYPES as readonly string[]).includes(issueType)
}

/** Exception issue type labels for display */
export const EXCEPTION_TYPE_LABELS: Record<string, string> = {
  missing_email: 'Missing Email',
  missing_contract: 'Missing Contract',
  duplicate: 'Duplicate Entry',
  period_mismatch: 'Period Mismatch',
  changed_balance: 'Changed Balance',
  payable_not_sent: 'Payable Not Sent',
  issued_payable_mismatch: 'Issued/Payable Mismatch',
  unmatched_repertoire: 'Unmatched Repertoire',
  carryover_not_confirmed: 'Carryover Not Confirmed',
  carryover_below_threshold: 'Below Threshold',
  output_missing: 'Output Missing',
  payable_not_approved: 'Payable Not Approved',
  carryover_missing: 'Carryover Missing',
}

export const SEVERITY_ORDER = { critical: 0, warning: 1, info: 2 }
