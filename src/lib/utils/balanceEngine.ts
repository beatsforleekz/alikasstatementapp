/**
 * STATEMENT BALANCE CALCULATION ENGINE
 *
 * BALANCE MODEL: Approach B — Zero-base per period
 *
 * opening_balance is ALWAYS 0 for generated statement records.
 * All prior-period balances enter the chain ONLY via prior_period_carryover_applied,
 * which is sourced from the carryover_ledger table.
 *
 * This eliminates the double-count that occurred when opening_balance carried
 * the prior closing AND carryover_ledger also added the same amount.
 *
 * BALANCE CHAIN (must always flow in this exact order):
 *
 *   opening_balance                = 0 (always, for generated records)
 *   + current_earnings             = sum of import row net amounts this period
 *   - deductions                   = sum of deduction rows this period
 *   = closing_balance_pre_carryover
 *   + prior_period_carryover_applied (from carryover_ledger — prior unissued balance)
 *   = final_balance_after_carryover
 *   → apply threshold rule
 *   → payable_amount  OR  carry_forward_amount (never both > 0)
 *
 * CARRYOVER LEDGER CONTRACT:
 *   When final_balance_after_carryover < threshold (and not recouping, not on hold),
 *   carryover_ledger records carried_amount = final_balance_after_carryover.
 *   The NEXT period picks this up as prior_period_carryover_applied.
 *   opening_balance stays 0 in that next period.
 *   No double-count possible.
 *
 * TWO-PERIOD EXAMPLE (payee earns 72 in H2, threshold = 100):
 *
 *   H2:
 *     opening_balance                = 0
 *     current_earnings               = 72.00
 *     deductions                     = 0.00
 *     closing_balance_pre_carryover  = 72.00
 *     prior_period_carryover_applied = 0.00
 *     final_balance_after_carryover  = 72.00
 *     payable_amount                 = 0.00   (below 100 threshold)
 *     carry_forward_amount           = 72.00  → written to carryover_ledger
 *
 *   H1 next year (payee earns 150):
 *     opening_balance                = 0        ← always zero
 *     current_earnings               = 150.00
 *     deductions                     = 0.00
 *     closing_balance_pre_carryover  = 150.00
 *     prior_period_carryover_applied = 72.00   ← from carryover_ledger
 *     final_balance_after_carryover  = 222.00
 *     payable_amount                 = 222.00  (above threshold)
 *     carry_forward_amount           = 0.00
 *
 *   Total paid across two periods: 222.00 = 72 + 150. Correct.
 */

import type {
  BalanceCalculation,
  CarryoverCalculationResult,
  Contract,
  ReadyToIssueCheck,
  StatementRecord,
} from '@/lib/types'
import { DEFAULT_PAYMENT_THRESHOLD, getPaymentThreshold } from '@/lib/types'

// ============================================================
// ROUNDING — always 2dp for financial values
// ============================================================
function round2(n: number): number {
  return Math.round(n * 100) / 100
}

// ============================================================
// CORE BALANCE CHAIN
// ============================================================

/**
 * Compute the balance chain.
 * In Approach B, opening_balance is always passed as 0 for generated records.
 * prior_period_carryover_applied comes from carryover_ledger, not from the
 * prior period's closing balance.
 */
export function computeBalanceChain(
  opening_balance: number,         // Always 0 for generated records (Approach B)
  current_earnings: number,
  deductions: number,
  prior_period_carryover_applied: number  // From carryover_ledger lookup
): {
  opening_balance: number
  current_earnings: number
  deductions: number
  closing_balance_pre_carryover: number
  prior_period_carryover_applied: number
  final_balance_after_carryover: number
  is_recouping: boolean
} {
  const opening = round2(opening_balance)
  const closing = round2(opening + current_earnings - deductions)
  const finalBalance = round2(closing + prior_period_carryover_applied)

  return {
    opening_balance: opening,
    current_earnings: round2(current_earnings),
    deductions: round2(deductions),
    closing_balance_pre_carryover: closing,
    prior_period_carryover_applied: round2(prior_period_carryover_applied),
    final_balance_after_carryover: finalBalance,
    is_recouping: finalBalance < 0,
  }
}

// ============================================================
// CARRYOVER RULE
// ============================================================

/**
 * Apply the payment threshold / carryover rule to a final balance.
 *
 * Priority order (highest to lowest):
 *   1. hold_payment_flag (contract or manual) → always 0 payable
 *   2. Negative balance (recouping)           → always 0 payable, 0 carry
 *   3. Below threshold                        → 0 payable, carry forward
 *   4. At or above threshold                  → fully payable
 */
export function applyCarryoverRule(
  finalBalance: number,
  contract: Contract | null,
  holdOverride: boolean = false
): CarryoverCalculationResult {
  const threshold = getPaymentThreshold(contract)
  const isRecouping = finalBalance < 0
  const isOnHold = holdOverride || (contract?.hold_payment_flag ?? false)
  const belowThreshold = !isRecouping && Math.abs(finalBalance) < threshold

  let payable_amount = 0
  let carry_forward_amount = 0
  let is_payable = false
  let carry_reason: 'below_threshold' | 'on_hold' | 'recouping' | null = null
  let notes = ''

  if (isOnHold) {
    carry_forward_amount = round2(finalBalance)
    carry_reason = 'on_hold'
    notes = `Payment on hold. Balance of ${finalBalance.toFixed(2)} carried forward.`
  } else if (isRecouping) {
    carry_reason = 'recouping'
    notes = `Recouping. Balance: ${finalBalance.toFixed(2)}. No payable amount.`
  } else if (belowThreshold) {
    carry_forward_amount = round2(finalBalance)
    carry_reason = 'below_threshold'
    notes = `Balance ${finalBalance.toFixed(2)} is below the ${threshold.toFixed(2)} threshold. Carried forward.`
  } else {
    payable_amount = round2(finalBalance)
    is_payable = true
    notes = `Balance ${finalBalance.toFixed(2)} meets threshold ${threshold.toFixed(2)}. Payable this period.`
  }

  return {
    final_balance_after_carryover: round2(finalBalance),
    payable_amount,
    carry_forward_amount,
    is_payable,
    carryover_rule_applied: true,
    threshold_used: threshold,
    below_threshold: belowThreshold,
    carry_reason,
    notes,
  }
}

/**
 * Full single-entry-point calculation: balance chain + carryover rule.
 *
 * Callers must pass:
 *   opening_balance = 0 (Approach B — always zero for generated records)
 *   prior_period_carryover_applied = value from carryover_ledger lookup
 */
export function calculateStatementRecord(
  opening_balance: number,
  current_earnings: number,
  deductions: number,
  prior_period_carryover_applied: number,
  contract: Contract | null,
  holdOverride: boolean = false
): BalanceCalculation {
  const chain = computeBalanceChain(
    opening_balance,
    current_earnings,
    deductions,
    prior_period_carryover_applied
  )
  const carryover = applyCarryoverRule(
    chain.final_balance_after_carryover,
    contract,
    holdOverride
  )

  return {
    opening_balance: chain.opening_balance,
    current_earnings: chain.current_earnings,
    deductions: chain.deductions,
    closing_balance_pre_carryover: chain.closing_balance_pre_carryover,
    prior_period_carryover_applied: chain.prior_period_carryover_applied,
    final_balance_after_carryover: chain.final_balance_after_carryover,
    payable_amount: carryover.payable_amount,
    carry_forward_amount: carryover.carry_forward_amount,
    is_payable: carryover.is_payable,
    is_recouping: chain.is_recouping,
  }
}

// ============================================================
// READY-TO-ISSUE VALIDATION
// ============================================================

export function checkReadyToIssue(
  record: StatementRecord,
  payee: { primary_email: string | null; active_status: boolean },
  unresolvedCriticalExceptions: number
): ReadyToIssueCheck {
  const blockers: string[] = []
  const warnings: string[] = []

  if (!record.payee_id)
    blockers.push('No payee assigned.')
  if (!payee.active_status)
    blockers.push('Payee is inactive.')
  if (!record.statement_period_id)
    blockers.push('No statement period assigned.')
  if (record.domain !== 'master' && record.domain !== 'publishing')
    blockers.push('Domain is invalid (must be master or publishing).')
  if (unresolvedCriticalExceptions > 0)
    blockers.push(`${unresolvedCriticalExceptions} unresolved critical exception(s) must be cleared.`)
  if (!record.balance_confirmed_flag)
    blockers.push('Balance not confirmed.')
  if (!record.carryover_confirmed_flag)
    blockers.push('Carryover not confirmed.')
  if (!record.output_generated_flag)
    blockers.push('Output not generated.')
  if (record.approval_status !== 'approved')
    blockers.push(`Not approved (status: ${record.approval_status}).`)
  if (record.is_payable && !payee.primary_email)
    blockers.push('Payable statement — payee has no primary email.')

  if (record.is_payable && record.issued_amount === 0)
    warnings.push('Payable but issued_amount is 0. Record the payment after issue.')
  if (record.hold_payment_flag)
    warnings.push('Payment hold flag is set — payable_amount is forced to 0.')

  return { ready: blockers.length === 0, blockers, warnings }
}

// ============================================================
// CHAIN VALIDATOR
// ============================================================

export function validateBalanceChain(record: StatementRecord): {
  valid: boolean
  issues: string[]
} {
  const issues: string[] = []

  const expectedClosing = round2(
    record.opening_balance + record.current_earnings - record.deductions
  )
  if (Math.abs(expectedClosing - record.closing_balance_pre_carryover) > 0.01)
    issues.push(
      `closing_balance_pre_carryover ${record.closing_balance_pre_carryover} ≠ ` +
      `opening + earnings − deductions = ${expectedClosing}`
    )

  const expectedFinal = round2(
    record.closing_balance_pre_carryover + record.prior_period_carryover_applied
  )
  if (Math.abs(expectedFinal - record.final_balance_after_carryover) > 0.01)
    issues.push(
      `final_balance_after_carryover ${record.final_balance_after_carryover} ≠ ` +
      `closing_pre + prior_carryover = ${expectedFinal}`
    )

  if (record.is_payable && record.payable_amount <= 0)
    issues.push('is_payable = true but payable_amount ≤ 0.')
  if (!record.is_payable && record.payable_amount > 0)
    issues.push('is_payable = false but payable_amount > 0.')
  if (record.carry_forward_amount > 0 && record.payable_amount > 0)
    issues.push('Both carry_forward_amount and payable_amount are > 0. Only one can be non-zero.')

  if (record.balance_model === 'approach_b' && record.opening_balance !== 0)
    issues.push(
      `opening_balance is ${record.opening_balance} but balance_model = approach_b requires 0. ` +
      `Prior period balance must enter via prior_period_carryover_applied only.`
    )

  return { valid: issues.length === 0, issues }
}

// ============================================================
// DISPLAY HELPERS
// ============================================================

export function formatCurrency(amount: number, currency = 'GBP'): string {
  return new Intl.NumberFormat('en-GB', {
    style: 'currency',
    currency,
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(amount)
}

export function formatPeriodLabel(label: string): string {
  return label.replace('-', ' ')
}
