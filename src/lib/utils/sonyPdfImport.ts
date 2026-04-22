export type SonyPdfColKey =
  | 'title'
  | 'tempo_id'
  | 'iswc'
  | 'mech'
  | 'digital_mech'
  | 'perf'
  | 'digital_perf'
  | 'synch'
  | 'other'
  | 'song_total'

export interface SonyPdfColField {
  key: SonyPdfColKey
  label: string
  required: boolean
  isAmount: boolean
}

export interface SonyPdfTotalMismatch {
  sourceRowIdx: number
  title: string
  expected: number
  actual: number
}

export const SONY_PDF_BUCKET_MAP: Record<string, string> = {
  mech: 'mechanical',
  digital_mech: 'digital_mechanical',
  perf: 'performance',
  digital_perf: 'digital_performance',
  synch: 'synch',
  other: 'other',
}

export const SONY_PDF_COL_FIELDS: SonyPdfColField[] = [
  { key: 'title', label: 'Song Title', required: true, isAmount: false },
  { key: 'tempo_id', label: 'Tempo ID', required: false, isAmount: false },
  { key: 'iswc', label: 'ISWC (fallback)', required: false, isAmount: false },
  { key: 'mech', label: 'Mech', required: false, isAmount: true },
  { key: 'digital_mech', label: 'Dg Mech', required: false, isAmount: true },
  { key: 'perf', label: 'Perf', required: false, isAmount: true },
  { key: 'digital_perf', label: 'Dg Perf', required: false, isAmount: true },
  { key: 'synch', label: 'Synch', required: false, isAmount: true },
  { key: 'other', label: 'Other', required: false, isAmount: true },
  { key: 'song_total', label: 'Song Total (opt.)', required: false, isAmount: true },
]

export const SONY_PDF_HINTS: Partial<Record<SonyPdfColKey, string[]>> = {
  title: ['song_title', 'title', 'work_title', 'composition'],
  tempo_id: ['tempo_id', 'song_id', 'sony_song_id', 'tempoid'],
  iswc: ['iswc', 'work_id', 'work_iswc'],
  mech: ['mech', 'mechanical', 'mech_royalty'],
  digital_mech: ['digital_mech', 'digital_mechanical', 'dig_mech'],
  perf: ['perf', 'performance', 'perf_royalty'],
  digital_perf: ['digital_perf', 'digital_performance', 'dig_perf'],
  synch: ['synch', 'sync', 'synchronisation', 'synchronization'],
  other: ['other', 'other_royalty', 'misc'],
  song_total: ['song_total', 'total', 'total_royalty', 'row_total'],
}

export function autoMapSonyPdf(headers: string[]): Partial<Record<SonyPdfColKey, string>> {
  const map: Partial<Record<SonyPdfColKey, string>> = {}
  const normHeaders = headers.map(h => h.trim().toLowerCase().replace(/\s+/g, '_'))
  for (const [field, candidates] of Object.entries(SONY_PDF_HINTS) as [SonyPdfColKey, string[]][]) {
    const idx = normHeaders.findIndex(h => candidates.includes(h))
    if (idx >= 0) map[field] = headers[idx]
  }
  return map
}

export function parseImportAmount(raw: string | null | undefined): number | null {
  if (!raw) return null

  let value = raw.trim()
  const isBracketNegative = value.startsWith('(') && value.endsWith(')')
  if (isBracketNegative) value = value.slice(1, -1).trim()

  value = value.replace(/[^0-9.,-]/g, '')
  if (!value || value === '-') return null

  const hasComma = value.includes(',')
  const hasDot = value.includes('.')

  if (hasDot && hasComma) value = value.replace(/\./g, '').replace(',', '.')
  else if (hasComma && !hasDot) value = value.replace(',', '.')

  const num = Number(value)
  if (!Number.isFinite(num)) return null
  return isBracketNegative ? -Math.abs(num) : num
}

export function looksLikeISWC(value: string | null | undefined): boolean {
  return /^T[-\s]?[\d]{3}[.\s]?[\d]{3}[.\s]?[\d]{3}[-\s]?[\d]$/i.test((value ?? '').trim())
}
