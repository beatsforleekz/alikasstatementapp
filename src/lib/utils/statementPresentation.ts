import type { StatementLineSummary } from '@/lib/types'

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

export interface StatementPivotRow {
  title: string
  identifier: string | null
  buckets: Partial<Record<StatementIncomeBucket, number>>
  total: number
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

export function activeStatementBuckets(rows: StatementPivotRow[]): StatementIncomeBucket[] {
  return STATEMENT_BUCKETS.filter(bucket => rows.some(row => row.buckets[bucket] != null))
}

export function getStatementCurrency(record: {
  statement_currency?: string | null
  payee?: { currency?: string | null } | null
}): string {
  return record.statement_currency ?? record.payee?.currency ?? 'GBP'
}
