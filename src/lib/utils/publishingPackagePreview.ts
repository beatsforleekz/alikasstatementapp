import type { Payee, StatementLineSummary, StatementPeriod, StatementRecord } from '@/lib/types'
import {
  buildIncomeTypeSections,
  getStatementCurrency,
  resolvePayeeDisplayName,
  resolvePayeePerformerName,
} from '@/lib/utils/statementPresentation'

export type PublishingPackagePayee = Pick<
  Payee,
  'id' | 'payee_name' | 'display_name' | 'performer_name' | 'statement_name'
> & {
  currency: string | null
}

export type PublishingPackagePeriod = Pick<StatementPeriod, 'id' | 'label' | 'year' | 'half'>

export type PublishingPackageRecord = StatementRecord & {
  payee?: PublishingPackagePayee | null
  statement_period?: PublishingPackagePeriod | null
  contract?: {
    id: string
    contract_name: string
    contract_code: string | null
    contract_type?: string | null
  } | null
}

export interface PublishingPackagePreviewSection {
  record: PublishingPackageRecord
  lines: StatementLineSummary[]
  currency: string
  contractLabel: string
  contractDescriptor: string
  incomeSections: ReturnType<typeof buildIncomeTypeSections>
}

export interface PublishingPackagePreview {
  id: string
  payeeId: string
  statementPeriodId: string
  payeeDisplayName: string
  performerName: string | null
  periodLabel: string
  currency: string
  contractsIncluded: string[]
  sections: PublishingPackagePreviewSection[]
  totals: {
    currentEarnings: number
    deductions: number
    closingBalance: number
    priorCarryoverApplied: number
    finalBalance: number
    payableAmount: number
    carryForwardAmount: number
  }
}

function comparePeriods(a: PublishingPackagePeriod | null | undefined, b: PublishingPackagePeriod | null | undefined) {
  const yearDiff = (b?.year ?? 0) - (a?.year ?? 0)
  if (yearDiff !== 0) return yearDiff
  const halfOrder = { H1: 1, H2: 2 } as const
  return (halfOrder[b?.half ?? 'H1'] ?? 0) - (halfOrder[a?.half ?? 'H1'] ?? 0)
}

function contractLabel(record: PublishingPackageRecord) {
  return record.contract?.contract_name?.trim()
    || record.contract?.contract_code?.trim()
    || record.contract_id
}

function contractDescriptor(record: PublishingPackageRecord) {
  const code = record.contract?.contract_code?.trim()
  const name = record.contract?.contract_name?.trim()
  if (code && name && code !== name) return `${name} (${code})`
  return code || name || record.contract_id
}

export function assemblePublishingPackages(
  records: PublishingPackageRecord[],
  lineMap: Map<string, StatementLineSummary[]>
): PublishingPackagePreview[] {
  const packageMap = new Map<string, PublishingPackagePreview>()

  for (const record of records) {
    if (record.domain !== 'publishing') continue
    const key = `${record.payee_id}::${record.statement_period_id}`

    if (!packageMap.has(key)) {
      packageMap.set(key, {
        id: key,
        payeeId: record.payee_id,
        statementPeriodId: record.statement_period_id,
        payeeDisplayName: resolvePayeeDisplayName(record.payee),
        performerName: resolvePayeePerformerName(record.payee),
        periodLabel: record.statement_period?.label ?? record.statement_period_id,
        currency: getStatementCurrency(record),
        contractsIncluded: [],
        sections: [],
        totals: {
          currentEarnings: 0,
          deductions: 0,
          closingBalance: 0,
          priorCarryoverApplied: 0,
          finalBalance: 0,
          payableAmount: 0,
          carryForwardAmount: 0,
        },
      })
    }

    const pkg = packageMap.get(key)!
    const lines = lineMap.get(record.id) ?? []
    const label = contractLabel(record)
    pkg.contractsIncluded.push(contractDescriptor(record))
    pkg.sections.push({
      record,
      lines,
      currency: getStatementCurrency(record),
      contractLabel: label,
      contractDescriptor: contractDescriptor(record),
      incomeSections: buildIncomeTypeSections(lines),
    })
    pkg.totals.currentEarnings += record.current_earnings ?? 0
    pkg.totals.deductions += record.deductions ?? 0
    pkg.totals.closingBalance += record.closing_balance_pre_carryover ?? 0
    pkg.totals.priorCarryoverApplied += record.prior_period_carryover_applied ?? 0
    pkg.totals.finalBalance += record.final_balance_after_carryover ?? 0
    pkg.totals.payableAmount += record.payable_amount ?? 0
    pkg.totals.carryForwardAmount += record.carry_forward_amount ?? 0
  }

  return Array.from(packageMap.values())
    .map(pkg => ({
      ...pkg,
      contractsIncluded: Array.from(new Set(pkg.contractsIncluded)),
      sections: pkg.sections.sort((a, b) => a.contractLabel.localeCompare(b.contractLabel)),
    }))
    .sort((a, b) => {
      const periodCompare = comparePeriods(
        a.sections[0]?.record.statement_period,
        b.sections[0]?.record.statement_period
      )
      if (periodCompare !== 0) return periodCompare
      return a.payeeDisplayName.localeCompare(b.payeeDisplayName)
    })
}
