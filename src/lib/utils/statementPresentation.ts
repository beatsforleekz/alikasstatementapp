import type { Payee, StatementLineSummary } from '@/lib/types'

export type StatementIncomeBucket =
  | 'mechanical'
  | 'digital_mechanical'
  | 'performance'
  | 'digital_performance'
  | 'synch'
  | 'other'

export const STATEMENT_BUCKETS: StatementIncomeBucket[] = [
  'mechanical',
  'digital_mechanical',
  'performance',
  'digital_performance',
  'synch',
  'other',
]

export const STATEMENT_BUCKET_LABELS: Record<StatementIncomeBucket, string> = {
  mechanical: 'Mech',
  digital_mechanical: 'Digital Mech',
  performance: 'Perf',
  digital_performance: 'Digital Perf',
  synch: 'Synch',
  other: 'Other',
}

export const STATEMENT_SECTION_LABELS: Record<StatementIncomeBucket, string> = {
  mechanical: 'Mechanical',
  digital_mechanical: 'Digital Mechanical',
  performance: 'Performance',
  digital_performance: 'Digital Performance',
  synch: 'Sync',
  other: 'Other',
}

export interface StatementPivotRow {
  title: string
  identifier: string | null
  buckets: Partial<Record<StatementIncomeBucket, number>>
  total: number
}

export interface StatementPresentationTotals {
  grossEarnings: number
  deductions: number
  netEarnings: number
}

export interface StatementLinePresentationValues {
  sourceAmount: number | null
  grossBasis: number
  deduction: number
  net: number
  allocationPercent: number | null
  incomeTypePercent: number | null
}

export interface StatementIncomeSectionRow {
  title: string
  identifier: string | null
  sourceAmount: number | null
  grossBasis: number
  deduction: number
  net: number
  allocationPercent: number | null
  incomeTypePercent: number | null
}

export interface StatementIncomeSection {
  bucket: StatementIncomeBucket
  label: string
  rows: StatementIncomeSectionRow[]
  grossBasisTotal: number
  netTotal: number
}

export function normalizeStatementBucket(raw: string | null | undefined): StatementIncomeBucket {
  if (!raw) return 'other'
  const value = raw.toLowerCase().trim()

  if (value === 'mechanical' || value === 'mech') return 'mechanical'
  if (value === 'digital_mechanical' || value === 'digital mech') return 'digital_mechanical'
  if (value === 'performance' || value === 'perf') return 'performance'
  if (value === 'digital_performance' || value === 'digital perf') return 'digital_performance'
  if (value === 'synch' || value === 'sync') return 'synch'
  return 'other'
}

export function buildStatementPivot(lines: StatementLineSummary[]): StatementPivotRow[] {
  const map = new Map<string, StatementPivotRow>()

  for (const line of lines) {
    const title = line.title ?? '(No Title)'
    const key = `${title}|||${line.identifier ?? ''}`

    if (!map.has(key)) {
      map.set(key, { title, identifier: line.identifier ?? null, buckets: {}, total: 0 })
    }

    const row = map.get(key)!
    const bucket = normalizeStatementBucket(line.income_type ?? line.line_category)
    const amount = line.net_amount ?? 0

    row.buckets[bucket] = (row.buckets[bucket] ?? 0) + amount
    row.total += amount
  }

  return Array.from(map.values()).sort((a, b) => a.title.localeCompare(b.title))
}

function safeDivide(numerator: number, denominator: number): number | null {
  if (!Number.isFinite(numerator) || !Number.isFinite(denominator) || denominator === 0) return null
  return numerator / denominator
}

export function getLinePresentationValues(line: StatementLineSummary): StatementLinePresentationValues {
  const sourceAmount = line.pre_split_amount ?? line.gross_amount ?? null
  const incomeNet = Number(line.net_amount ?? 0)
  const deduction = Math.max(line.deduction_amount ?? 0, 0)
  const storedRate = line.rate_applied != null ? Number(line.rate_applied) : null
  const grossBasis = line.line_category === 'income'
    ? (storedRate != null && storedRate > 0 ? incomeNet / storedRate : incomeNet)
    : 0
  const allocationPercent = line.line_category === 'income'
    ? (
        sourceAmount != null && sourceAmount !== 0
          ? safeDivide(grossBasis, sourceAmount)
          : (line.split_percent_applied != null ? Number(line.split_percent_applied) : null)
      )
    : null
  const incomeTypePercent = line.line_category === 'income'
    ? (
        storedRate != null && storedRate > 0
          ? storedRate
          : safeDivide(incomeNet, grossBasis)
      )
    : null
  const net = line.line_category === 'income' ? incomeNet : -deduction

  return {
    sourceAmount,
    grossBasis,
    deduction,
    net,
    allocationPercent,
    incomeTypePercent,
  }
}

export function buildIncomeTypeSections(lines: StatementLineSummary[]): StatementIncomeSection[] {
  const sections = new Map<StatementIncomeBucket, Map<string, StatementIncomeSectionRow>>()

  for (const line of lines.filter(line => line.line_category === 'income')) {
    const bucket = normalizeStatementBucket(line.income_type ?? line.line_category)
    if (!sections.has(bucket)) sections.set(bucket, new Map())
    const section = sections.get(bucket)!
    const title = line.title ?? '(No Title)'
    const identifier = line.identifier ?? null
    const key = `${title}|||${identifier ?? ''}`
    const values = getLinePresentationValues(line)

    if (!section.has(key)) {
      section.set(key, {
        title,
        identifier,
        sourceAmount: 0,
        grossBasis: 0,
        deduction: 0,
        net: 0,
        allocationPercent: null,
        incomeTypePercent: null,
      })
    }

    const row = section.get(key)!
    row.sourceAmount = (row.sourceAmount ?? 0) + (values.sourceAmount ?? 0)
    row.grossBasis += values.grossBasis
    row.deduction += values.deduction
    row.net += values.net
  }

  return STATEMENT_BUCKETS
    .filter(bucket => sections.has(bucket))
    .map(bucket => {
      const rows = Array.from(sections.get(bucket)!.values())
        .map(row => ({
          ...row,
          sourceAmount: row.sourceAmount === 0 ? null : row.sourceAmount,
          allocationPercent: row.sourceAmount != null && row.sourceAmount !== 0
            ? safeDivide(row.grossBasis, row.sourceAmount)
            : null,
          incomeTypePercent: row.grossBasis !== 0
            ? safeDivide(row.net, row.grossBasis)
            : null,
        }))
        .sort((a, b) => a.title.localeCompare(b.title))

      return {
        bucket,
        label: STATEMENT_SECTION_LABELS[bucket],
        grossBasisTotal: rows.reduce((sum, row) => sum + row.grossBasis, 0),
        netTotal: rows.reduce((sum, row) => sum + row.net, 0),
        rows,
      }
    })
}

export function activeStatementBuckets(rows: StatementPivotRow[]): StatementIncomeBucket[] {
  return STATEMENT_BUCKETS.filter(bucket => rows.some(row => row.buckets[bucket] != null))
}

export function resolvePayeeDisplayName(
  payee: Pick<Payee, 'display_name' | 'statement_name' | 'payee_name'> | null | undefined
): string {
  return payee?.display_name?.trim()
    || payee?.statement_name?.trim()
    || payee?.payee_name?.trim()
    || ''
}

export function resolvePayeePerformerName(
  payee: Pick<Payee, 'performer_name'> | null | undefined
): string | null {
  const performerName = payee?.performer_name?.trim()
  return performerName ? performerName : null
}

export function calculateStatementPresentationTotals(lines: StatementLineSummary[]): StatementPresentationTotals {
  const grossEarnings = lines.reduce((sum, line) => sum + getLinePresentationValues(line).grossBasis, 0)
  const deductions = lines.reduce((sum, line) => sum + getLinePresentationValues(line).deduction, 0)
  return {
    grossEarnings,
    deductions,
    netEarnings: grossEarnings - deductions,
  }
}

export function getStatementCurrency(record: {
  statement_currency?: string | null
  payee?: { currency?: string | null } | null
}): string {
  return record.statement_currency ?? record.payee?.currency ?? 'GBP'
}
