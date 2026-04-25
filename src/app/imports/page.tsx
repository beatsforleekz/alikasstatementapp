'use client'
import { useEffect, useState, useRef } from 'react'
import Link from 'next/link'
import { supabase } from '@/lib/supabase/client'
import PdfStatementWorkbench from '@/components/imports/PdfStatementWorkbench'
import {
  Alert, LoadingSpinner, DomainBadge, StatCard, SectionHeader, EmptyState,
} from '@/components/ui'
import {
  Upload, RefreshCw, CheckCircle, AlertTriangle, Clock,
  ChevronDown, ChevronRight, FileText, X, Trash2, Play,
} from 'lucide-react'
import type { StatementPeriod, Payee, Contract, ContractPayeeLink, Repertoire } from '@/lib/types'
import { processImportRow } from '@/lib/utils/matchingEngine'
import {
  SONY_PDF_BUCKET_MAP,
  SONY_PDF_COL_FIELDS,
  autoMapSonyPdf,
  parseImportAmount,
  looksLikeISWC,
  type SonyPdfColKey,
  type SonyPdfTotalMismatch,
} from '@/lib/utils/sonyPdfImport'
import { sortByLabel, sortStrings } from '@/lib/utils/sortOptions'

// ── Types ─────────────────────────────────────────────────────────────────────

interface ImportRecord {
  id: string
  import_type: string
  domain: 'master' | 'publishing'
  source_name: string | null
  file_name: string | null
  statement_period_id: string | null
  imported_at: string
  imported_by_name: string | null
  row_count: number
  success_count: number
  warning_count: number
  error_count: number
  import_status: string
  source_currency: string | null
  reporting_currency: string | null
  exchange_rate: number | null
  exchange_rate_date: string | null
  notes: string | null
  statement_period?: { label: string } | null
}

interface ParsedRow {
  raw_row_number: number
  payee_name_raw: string | null
  contract_name_raw: string | null
  artist_name_raw: string | null
  title_raw: string | null
  identifier_raw: string | null
  country_raw: string | null
  income_type: string | null
  amount: number | null
  currency: string | null
  row_type: string | null
  _raw: Record<string, string>
  matched_payee_id: string | null
  matched_contract_id: string | null
  matched_repertoire_id: string | null
  match_status: 'matched' | 'partial' | 'unmatched' | 'manual_override'
  warning_flag: boolean
  warning_reason: string | null
  error_flag: boolean
  error_reason: string | null
  normalized_title: string
  normalized_identifier: string
  amount_converted: number | null
}

type ColMapKey =
  | 'payee_name_raw' | 'contract_name_raw' | 'artist_name_raw'
  | 'title_raw' | 'tempo_id_raw' | 'identifier_raw' | 'country_raw'
  | 'income_type' | 'amount' | 'currency' | 'row_type'

// ── Import type config ────────────────────────────────────────────────────────

const IMPORT_TYPE_OPTIONS = [
  { value: 'believe',             label: 'Believe Automatic Report',     domain: 'master'     as const, badge: 'primary'   },
  { value: 'eddy',                label: 'Eddy Export (Legacy)',          domain: 'master'     as const, badge: 'legacy'    },
  { value: 'sony_csv',            label: 'Sony CSV (Wide)',              domain: 'publishing' as const, badge: 'primary'   },
  { value: 'sony_publishing_pdf', label: 'Sony Publishing PDF (Wide)',   domain: 'publishing' as const, badge: 'primary'   },
  { value: 'publishing_csv',      label: 'Publishing CSV (In-house)',    domain: 'publishing' as const, badge: 'secondary' },
  { value: 'sony_balance',        label: 'Sony Balance Import',          domain: 'publishing' as const, badge: 'secondary' },
]

const REF_FETCH_PAGE_SIZE = 1000

const COL_HINTS: Record<string, Partial<Record<ColMapKey, string[]>>> = {
  believe: {
    // Believe uses semicolon-delimited files with these exact column names (normalized to lowercase + underscores by parseCSV)
    // Maps to import_rows fields per believeParser.BELIEVE_COLUMN_MAP
    payee_name_raw: ['artist_name'],
    artist_name_raw: ['artist_name'],
    title_raw: ['track_title'],
    identifier_raw: ['isrc', 'upc'],
    amount: ['net_revenue'],
    currency: ['client_payment_currency'],
    country_raw: ['country_/_region', 'country_region', 'country'],
    row_type: ['sales_type'],
  },
  eddy: {
    payee_name_raw: ['artist_name', 'payee_name', 'artist'],
    title_raw: ['title', 'track_title'],
    identifier_raw: ['isrc', 'upc'],
    amount: ['net_amount', 'final_contract_amount', 'amount'],
    currency: ['currency'],
    country_raw: ['country'],
  },
  sony_publishing: {
    payee_name_raw: ['writer', 'writer_name', 'payee', 'artist'],
    title_raw: ['work_title', 'title', 'composition'],
    tempo_id_raw: ['tempo_id', 'song_id', 'sony_song_id', 'tempoid'],
    identifier_raw: ['iswc', 'work_id', 'identifier'],
    income_type: ['income_type', 'royalty_type', 'category'],
    amount: ['amount', 'royalty_amount', 'net_amount'],
    currency: ['currency', 'ccy'],
    country_raw: ['country', 'territory'],
  },
  publishing_csv: {
    payee_name_raw: ['writer', 'writer_name', 'payee'],
    title_raw: ['title', 'work_title'],
    tempo_id_raw: ['tempo_id', 'song_id', 'sony_song_id', 'tempoid'],
    identifier_raw: ['iswc', 'identifier'],
    income_type: ['income_type', 'type', 'category'],
    amount: ['amount', 'net_amount'],
    currency: ['currency'],
  },
  sony_balance: {
    payee_name_raw: ['payee', 'artist', 'writer'],
    amount: ['balance', 'amount'],
    currency: ['currency'],
  },
}

// Long-format column fields — used for all import types except Sony wide imports
const MASTER_COL_FIELDS: { key: ColMapKey; label: string }[] = [
  { key: 'payee_name_raw',    label: 'Payee / Writer Name' },
  { key: 'artist_name_raw',   label: 'Artist Name' },
  { key: 'title_raw',         label: 'Title' },
  { key: 'identifier_raw',    label: 'Identifier (ISRC / ISWC / UPC)' },
  { key: 'income_type',       label: 'Income Type' },
  { key: 'amount',            label: 'Amount' },
  { key: 'currency',          label: 'Currency' },
  { key: 'country_raw',       label: 'Country / Territory' },
  { key: 'row_type',          label: 'Row Type' },
]

const PUBLISHING_COL_FIELDS: { key: ColMapKey; label: string }[] = [
  { key: 'payee_name_raw',    label: 'Payee / Writer Name' },
  { key: 'artist_name_raw',   label: 'Artist Name' },
  { key: 'title_raw',         label: 'Title' },
  { key: 'tempo_id_raw',      label: 'Tempo ID (primary)' },
  { key: 'identifier_raw',    label: 'Fallback Identifier (ISWC / legacy)' },
  { key: 'income_type',       label: 'Income Type' },
  { key: 'amount',            label: 'Amount' },
  { key: 'currency',          label: 'Currency' },
  { key: 'country_raw',       label: 'Country / Territory' },
  { key: 'row_type',          label: 'Row Type' },
]

// ── CSV helpers ───────────────────────────────────────────────────────────────

function detectDelimiter(text: string): ',' | ';' | '\t' {
  const sample = text.split('\n')[0] ?? ''
  const sc = (sample.match(/;/g) || []).length
  const tc = (sample.match(/\t/g) || []).length
  const cc = (sample.match(/,/g) || []).length
  if (sc >= cc && sc >= tc) return ';'
  if (tc >= cc) return '\t'
  return ','
}

/**
 * Parse a single CSV/TSV record into fields, correctly handling:
 *   - quoted fields that contain the delimiter or newlines
 *   - escaped quotes ("") inside quoted fields
 *   - unquoted fields
 */
function parseCSVRecord(line: string, delim: string): string[] {
  const fields: string[] = []
  let i = 0
  const n = line.length

  while (i <= n) {
    if (i === n) {
      fields.push('')
      break
    }

    if (line[i] === '"') {
      i++
      let field = ''
      while (i < n) {
        if (line[i] === '"') {
          if (i + 1 < n && line[i + 1] === '"') {
            field += '"'
            i += 2
          } else {
            i++
            break
          }
        } else {
          field += line[i]
          i++
        }
      }
      fields.push(field.trim())
      if (i < n && line[i] === delim) i++
    } else {
      const start = i
      while (i < n && line[i] !== delim) i++
      fields.push(line.slice(start, i).trim())
      if (i < n) i++
    }
  }

  return fields
}

function parseCSV(text: string): { headers: string[]; rows: Record<string, string>[] } {
  const delim = detectDelimiter(text)
  const cleaned = text.replace(/^\uFEFF/, '')

  const records: string[] = []
  let current = ''
  let inQuotes = false
  for (let i = 0; i < cleaned.length; i++) {
    const ch = cleaned[i]
    if (ch === '"') {
      inQuotes = !inQuotes
      current += ch
    } else if (!inQuotes && (ch === '\n' || (ch === '\r' && cleaned[i + 1] !== '\n'))) {
      if (current.trim()) records.push(current)
      current = ''
      if (ch === '\r') i++
    } else if (!inQuotes && ch === '\r' && cleaned[i + 1] === '\n') {
      if (current.trim()) records.push(current)
      current = ''
      i++
    } else {
      current += ch
    }
  }
  if (current.trim()) records.push(current)

  if (!records.length) return { headers: [], rows: [] }

  const headers = parseCSVRecord(records[0], delim).map(
    h => h.toLowerCase().replace(/\s+/g, '_')
  )

  const rows: Record<string, string>[] = []
  for (let i = 1; i < records.length; i++) {
    const vals = parseCSVRecord(records[i], delim)
    const row: Record<string, string> = {}
    headers.forEach((h, idx) => { row[h] = vals[idx] ?? '' })
    rows.push(row)
  }

  return { headers, rows }
}

function autoMap(headers: string[], hints: Partial<Record<ColMapKey, string[]>>): Partial<Record<ColMapKey, string>> {
  const map: Partial<Record<ColMapKey, string>> = {}
  const used = new Set<string>()
  for (const [field, candidates] of Object.entries(hints) as [ColMapKey, string[]][]) {
    for (const c of candidates) {
      if (headers.includes(c) && !used.has(c)) { map[field] = c; used.add(c); break }
    }
  }
  return map
}

// ── Sony PDF wide-format expansion ───────────────────────────────────────────
//
// Each source row represents one song. Expand non-zero income buckets into
// individual income rows matched against the publishing repertoire by tempo_id.
// song_total is optional: used only for validation, never emitted as a row.
// believeParser is NOT involved in this path.

function expandSonyPdfRows(
  csvRows: Record<string, string>[],
  colMap: Partial<Record<SonyPdfColKey, string>>,
  rate: number | null,
  currency: string,
  payees: Payee[],
  contracts: Contract[],
  payeeLinks: ContractPayeeLink[],
  aliases: unknown[],
  repertoire: Repertoire[],
  splits: unknown[]
): { rows: ParsedRow[]; totalMismatches: SonyPdfTotalMismatch[] } {
  const expandedRows: ParsedRow[] = []
  const totalMismatches: SonyPdfTotalMismatch[] = []

  let globalRowNum = 0

  const getCol = (raw: Record<string, string>, key: SonyPdfColKey): string => {
    const col = colMap[key]
    return col ? (raw[col]?.trim() ?? '') : ''
  }

  for (let srcIdx = 0; srcIdx < csvRows.length; srcIdx++) {
    const raw = csvRows[srcIdx]

    const title = getCol(raw, 'title')
    const tempoId = getCol(raw, 'tempo_id')
    const iswc = getCol(raw, 'iswc')

    // Skip rows with no identifying information
    if (!title && !tempoId && !iswc) continue

    // Parse all bucket amounts; collect non-zero ones
    const nonZeroBuckets: Array<{ key: string; incomeType: string; amount: number }> = []
    let bucketSum = 0

    for (const bucketKey of Object.keys(SONY_PDF_BUCKET_MAP)) {
      const rawAmt = getCol(raw, bucketKey as SonyPdfColKey)
      const amt    = parseImportAmount(rawAmt)
      if (amt !== null && amt !== 0) {
        nonZeroBuckets.push({
          key:        bucketKey,
          incomeType: SONY_PDF_BUCKET_MAP[bucketKey],
          amount:     amt,
        })
        bucketSum += amt
      }
    }

    // Validate against song_total if present — warning only, never blocks import
    const songTotalRaw = getCol(raw, 'song_total')
    if (songTotalRaw) {
      const songTotal = parseImportAmount(songTotalRaw)
      if (songTotal !== null && Math.abs(songTotal - bucketSum) > 0.005) {
        totalMismatches.push({
          sourceRowIdx: srcIdx,
          title:        title || tempoId,
          expected:     songTotal,
          actual:       bucketSum,
        })
      }
    }

    // If all buckets are zero/absent, emit one placeholder row so the song
    // is visible in the preview and can surface as an exception.
    if (nonZeroBuckets.length === 0) {
      globalRowNum++
      const partial = {
        domain:            'publishing' as const,
        title_raw:         title || null,
        identifier_raw:    tempoId || iswc || null,
        tempo_id:          tempoId || null,
        iswc:              iswc || null,
        payee_name_raw:    null as null,
        contract_name_raw: null as null,
        artist_name_raw:   null as null,
        country_raw:       null as null,
        row_type:          null as null,
        income_type:       null as null,
        amount:            0,
        currency:          currency || null,
        raw_row_number:    globalRowNum,
      }
      const result = processImportRow(
        partial, payees, contracts, payeeLinks,
        aliases as Parameters<typeof processImportRow>[4],
        repertoire,
        splits as Parameters<typeof processImportRow>[6]
      )
      expandedRows.push({
        raw_row_number:        globalRowNum,
        payee_name_raw:        null,
        contract_name_raw:     null,
        artist_name_raw:       null,
        title_raw:             title || null,
        identifier_raw:        tempoId || iswc || null,
        country_raw:           null,
        income_type:           null,
        amount:                0,
        currency:              currency || null,
        row_type:              null,
        _raw:                  raw,
        matched_payee_id:      result.matched_payee_id,
        matched_contract_id:   result.matched_contract_id,
        matched_repertoire_id: result.matched_repertoire_id,
        match_status:          result.match_status,
        warning_flag:          true,
        warning_reason:        'No non-zero income buckets for this song.',
        error_flag:            result.error_flag,
        error_reason:          result.error_reason,
        normalized_title:      result.normalized_title,
        normalized_identifier: result.normalized_identifier,
        amount_converted:      null,
      })
      continue
    }

    // Emit one row per non-zero bucket
    for (const bucket of nonZeroBuckets) {
      globalRowNum++
      const amount = bucket.amount

      const partial = {
        domain:            'publishing' as const,
        title_raw:         title || null,
        identifier_raw:    tempoId || iswc || null,
        tempo_id:          tempoId || null,
        iswc:              iswc || null,
        payee_name_raw:    null as null,
        contract_name_raw: null as null,
        artist_name_raw:   null as null,
        country_raw:       null as null,
        row_type:          null as null,
        income_type:       bucket.incomeType,
        amount,
        currency:          currency || null,
        raw_row_number:    globalRowNum,
      }

      const result = processImportRow(
        partial, payees, contracts, payeeLinks,
        aliases as Parameters<typeof processImportRow>[4],
        repertoire,
        splits as Parameters<typeof processImportRow>[6]
      )
      const amount_converted = (rate !== null && amount !== null)
        ? Math.round(amount * rate * 1e6) / 1e6
        : null

      expandedRows.push({
        raw_row_number:        globalRowNum,
        payee_name_raw:        null,
        contract_name_raw:     null,
        artist_name_raw:       null,
        title_raw:             title || null,
        identifier_raw:        tempoId || iswc || null,
        country_raw:           null,
        income_type:           bucket.incomeType,
        amount,
        currency:              currency || null,
        row_type:              null,
        _raw:                  raw,
        matched_payee_id:      result.matched_payee_id,
        matched_contract_id:   result.matched_contract_id,
        matched_repertoire_id: result.matched_repertoire_id,
        match_status:          result.match_status,
        warning_flag:          result.warning_flag,
        warning_reason:        result.warning_reason,
        error_flag:            result.error_flag,
        error_reason:          result.error_reason,
        normalized_title:      result.normalized_title,
        normalized_identifier: result.normalized_identifier,
        amount_converted,
      })
    }
  }

  return { rows: expandedRows, totalMismatches }
}

// ── Display helpers ───────────────────────────────────────────────────────────

function statusIcon(s: string) {
  if (s === 'complete') return <CheckCircle size={13} className="text-green-400" />
  if (s === 'failed')   return <AlertTriangle size={13} className="text-red-400" />
  if (s === 'partial')  return <AlertTriangle size={13} className="text-amber-400" />
  return <Clock size={13} className="text-ops-muted" />
}

function matchBadge(s: string) {
  const m: Record<string, string> = { matched: 'badge-approved', partial: 'badge-pending', unmatched: 'badge-critical', manual_override: 'badge-info' }
  return <span className={m[s] ?? 'badge-pending'}>{s.replace('_', ' ')}</span>
}

function fmtDate(iso: string) {
  return new Date(iso).toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' })
}
function fmtTime(iso: string) {
  return new Date(iso).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' })
}

// ── PeriodCombobox ────────────────────────────────────────────────────────────

interface PeriodComboboxProps {
  periods: StatementPeriod[]
  value: string
  onChange: (label: string, id: string | undefined) => void
}

function PeriodCombobox({ periods, value, onChange }: PeriodComboboxProps) {
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState(value)
  const ref = useRef<HTMLDivElement>(null)

  useEffect(() => { setQuery(value) }, [value])

  useEffect(() => {
    function onClickOutside(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false)
    }
    document.addEventListener('mousedown', onClickOutside)
    return () => document.removeEventListener('mousedown', onClickOutside)
  }, [])

  const filtered = query.trim()
    ? periods.filter(p => p.label.toLowerCase().includes(query.trim().toLowerCase()))
    : periods

  const exactMatch = periods.find(p => p.label.toLowerCase() === query.trim().toLowerCase())
  const showCreate = query.trim() && !exactMatch && /^\d{4}-(H1|H2)$/i.test(query.trim())

  function select(label: string, id: string | undefined) {
    setQuery(label)
    onChange(label, id)
    setOpen(false)
  }

  return (
    <div ref={ref} style={{ position: 'relative' }}>
      <input
        className="input-field"
        placeholder="e.g. 2025-H1"
        value={query}
        onChange={e => {
          setQuery(e.target.value)
          onChange(e.target.value, undefined)
          setOpen(true)
        }}
        onFocus={() => setOpen(true)}
        autoComplete="off"
      />
      {open && (filtered.length > 0 || showCreate) && (
        <div style={{
          position: 'absolute', top: '100%', left: 0, right: 0, zIndex: 100,
          background: 'var(--ops-surface)', border: '1px solid var(--ops-border)',
          borderRadius: 6, marginTop: 2, maxHeight: 200, overflowY: 'auto',
          boxShadow: '0 4px 12px rgba(0,0,0,0.4)',
        }}>
          {filtered.map(p => (
            <button
              key={p.id}
              type="button"
              style={{
                display: 'block', width: '100%', textAlign: 'left',
                padding: '6px 12px', fontSize: 13, background: 'none', border: 'none',
                color: 'var(--ops-text)', cursor: 'pointer',
              }}
              onMouseDown={e => { e.preventDefault(); select(p.label, p.id) }}
            >
              {p.label}
              {p.status !== 'open' && (
                <span style={{ marginLeft: 6, fontSize: 11, color: 'var(--ops-muted)' }}>({p.status})</span>
              )}
            </button>
          ))}
          {showCreate && (
            <button
              type="button"
              style={{
                display: 'block', width: '100%', textAlign: 'left',
                padding: '6px 12px', fontSize: 13, background: 'none', border: 'none',
                borderTop: filtered.length ? '1px solid var(--ops-border)' : 'none',
                color: 'var(--accent-cyan)', cursor: 'pointer',
              }}
              onMouseDown={e => { e.preventDefault(); select(query.trim(), undefined) }}
            >
              + Create "{query.trim()}"
            </button>
          )}
        </div>
      )}
    </div>
  )
}

// ── Main page ─────────────────────────────────────────────────────────────────

export default function ImportsPage() {
  const EXPANDED_PAGE_SIZE = 250

  // Reference data
  const [periods, setPeriods]       = useState<StatementPeriod[]>([])
  const [payees, setPayees]         = useState<Payee[]>([])
  const [contracts, setContracts]   = useState<Contract[]>([])
  const [payeeLinks, setPayeeLinks] = useState<ContractPayeeLink[]>([])
  const [repertoire, setRepertoire] = useState<Repertoire[]>([])
  const [aliases, setAliases]       = useState<any[]>([])
  const [splits, setSplits]         = useState<any[]>([])
  const [contractRepertoireLinks, setContractRepertoireLinks] = useState<any[]>([])

  // History
  const [imports, setImports] = useState<ImportRecord[]>([])
  const [loadingHistory, setLoadingHistory] = useState(true)
  const [selectedPeriodId, setSelectedPeriodId] = useState('')
  const [expandedId, setExpandedId]     = useState<string | null>(null)
  const [expandedRows, setExpandedRows] = useState<any[]>([])
  const [expandedLoading, setExpandedLoading] = useState(false)
  const [historyRowFilter, setHistoryRowFilter] = useState<'' | 'unmatched' | 'error'>('')
  const [expandedPage, setExpandedPage] = useState(0)
  const [expandedCounts, setExpandedCounts] = useState<{ all: number; unmatched: number; error: number }>({
    all: 0,
    unmatched: 0,
    error: 0,
  })
  // Full-import aggregate totals fetched separately so Source Total is never capped by the row display limit
  const [expandedTotals, setExpandedTotals] = useState<{ srcTotal: number; convTotal: number; srcCcy: string; convCcy: string; hasFx: boolean } | null>(null)

  // Wizard
  const [showWizard, setShowWizard]   = useState(false)
  const [step, setStep]               = useState<'config' | 'upload' | 'map' | 'preview'>('config')

  // Config
  const [importType, setImportType]   = useState('believe')
  const [domain, setDomain]           = useState<'master' | 'publishing'>('master')
  const [wizardPeriodId, setWizardPeriodId] = useState('')
  const [wizardPeriodLabel, setWizardPeriodLabel] = useState('')
  const [sourceName, setSourceName]   = useState('')
  const [sourceCurrency, setSourceCurrency] = useState('')
  const [reportingCurrency, setReportingCurrency] = useState('GBP')
  const [exchangeRate, setExchangeRate] = useState('')
  const [exchangeRateDate, setExchangeRateDate] = useState('')
  const [wizardNotes, setWizardNotes] = useState('')

  // Upload / parse
  const fileRef = useRef<HTMLInputElement>(null)
  const [fileName, setFileName]     = useState('')
  const [headers, setHeaders]       = useState<string[]>([])
  const [csvRows, setCsvRows]       = useState<Record<string, string>[]>([])

  // Column map — standard long format
  const [colMap, setColMap]         = useState<Partial<Record<ColMapKey, string>>>({})

  // Column map — Sony PDF wide format
  const [sonyPdfColMap, setSonyPdfColMap] = useState<Partial<Record<SonyPdfColKey, string>>>({})

  // Sony PDF song-total validation warnings (shown in preview, do not block save)
  const [sonyPdfTotalMismatches, setSonyPdfTotalMismatches] = useState<SonyPdfTotalMismatch[]>([])

  // Preview
  const [parsedRows, setParsedRows] = useState<ParsedRow[]>([])
  const [matching, setMatching]     = useState(false)
  const [previewFilter, setPreviewFilter] = useState<'' | 'unmatched' | 'error'>('')

  // Save / delete
  const [saving, setSaving]         = useState(false)
  const [savingPhase, setSavingPhase] = useState<string | null>(null)
  const [deletingId, setDeletingId] = useState<string | null>(null)
  const [pdfCompletionNotice, setPdfCompletionNotice] = useState<null | {
    importId: string
    unmatched: number
  }>(null)

  // Feedback
  const [error, setError]           = useState<string | null>(null)
  const [successMsg, setSuccessMsg] = useState<string | null>(null)

  // Derived: Sony CSV and Sony PDF share the same wide-format expansion flow.
  const isSonyWide = importType === 'sony_publishing_pdf' || importType === 'sony_csv'
  const isSonyPdf = importType === 'sony_publishing_pdf'

  useEffect(() => { loadRefData() }, [])
  useEffect(() => { if (selectedPeriodId) loadImports() }, [selectedPeriodId])
  useEffect(() => {
    if (!expandedId) return
    loadExpandedRows(expandedId, historyRowFilter, expandedPage)
  }, [expandedId, historyRowFilter, expandedPage])

  async function fetchAllPaged<T>(
    buildQuery: (from: number, to: number) => PromiseLike<{ data: T[] | null; error: any }>
  ) {
    let from = 0
    let all: T[] = []
    while (true) {
      const { data, error: err } = await buildQuery(from, from + REF_FETCH_PAGE_SIZE - 1)
      if (err) throw err
      const batch = (data ?? []) as T[]
      if (batch.length === 0) break
      all = all.concat(batch)
      if (batch.length < REF_FETCH_PAGE_SIZE) break
      from += REF_FETCH_PAGE_SIZE
    }
    return all
  }

  async function loadRefData() {
    const [pd, py, co, pl, rp, al, sp, crl] = await Promise.all([
      supabase.from('statement_periods').select('*').order('year', { ascending: false }).order('half', { ascending: false }),
      fetchAllPaged((from, to) =>
        supabase
          .from('payees')
          .select('*')
          .eq('active_status', true)
          .order('payee_name')
          .range(from, to)
      ),
      fetchAllPaged((from, to) =>
        supabase.from('contracts').select('*').eq('status', 'active').order('contract_name').range(from, to)
      ),
      fetchAllPaged((from, to) =>
        supabase
          .from('contract_payee_links')
          .select('*')
          .eq('is_active', true)
          .order('contract_id')
          .order('payee_id')
          .range(from, to)
      ),
      fetchAllPaged((from, to) =>
        supabase.from('repertoire').select('*').order('title').range(from, to)
      ),
      fetchAllPaged((from, to) =>
        supabase
          .from('payee_aliases')
          .select('*')
          .eq('is_active', true)
          .order('alias_name')
          .range(from, to)
      ),
      fetchAllPaged((from, to) =>
        supabase
          .from('contract_repertoire_payee_splits')
          .select('*')
          .eq('is_active', true)
          .order('repertoire_id')
          .order('contract_id')
          .range(from, to)
      ),
      fetchAllPaged((from, to) =>
        supabase
          .from('contract_repertoire_links')
          .select('*')
          .order('repertoire_id')
          .order('contract_id')
          .range(from, to)
      ),
    ])
    setPeriods(sortByLabel(pd.data ?? [], period => period.label))
    setPayees(sortByLabel(py ?? [], payee => payee.payee_name))
    setContracts(sortByLabel(co ?? [], contract => contract.contract_name))
    setPayeeLinks(pl ?? [])
    setRepertoire(rp ?? [])
    setAliases(al ?? [])
    setSplits(sp ?? [])
    setContractRepertoireLinks(crl ?? [])
    const current = (pd.data ?? []).find((p: any) => p.is_current) ?? pd.data?.[0]
    if (current) {
      setSelectedPeriodId(current.id)
      setWizardPeriodId(current.id)
      setWizardPeriodLabel(current.label)
    }
    setLoadingHistory(false)
  }

  async function loadImports() {
    const { data } = await supabase
      .from('imports')
      .select('*, statement_period:statement_periods(label)')
      .eq('statement_period_id', selectedPeriodId)
      .order('imported_at', { ascending: false })
    setImports(data ?? [])
  }

  async function loadExpandedRows(id: string, filter: '' | 'unmatched' | 'error', page: number) {
    setExpandedLoading(true)

    let query = supabase
      .from('import_rows')
      .select('*')
      .eq('import_id', id)
      .order('raw_row_number')
      .range(page * EXPANDED_PAGE_SIZE, ((page + 1) * EXPANDED_PAGE_SIZE) - 1)

    if (filter === 'unmatched') query = query.eq('match_status', 'unmatched')
    if (filter === 'error') query = query.eq('error_flag', true)

    const { data, error: err } = await query
    if (err) {
      setError(err.message)
      setExpandedRows([])
    } else {
      setExpandedRows(data ?? [])
    }

    setExpandedLoading(false)
  }

  async function loadExpandedFullTotals(id: string) {
    const pageSize = 1000
    let from = 0
    let srcTotal = 0
    let convTotal = 0
    let hasFx = false
    let srcCcy = ''
    let convCcy = ''

    while (true) {
      const { data, error: err } = await supabase
        .from('import_rows')
        .select('amount, amount_converted, currency, converted_currency')
        .eq('import_id', id)
        .order('raw_row_number')
        .range(from, from + pageSize - 1)

      if (err) throw err
      if (!data || data.length === 0) break

      srcTotal += data.reduce((sum: number, row: any) => sum + (Number(row.amount) || 0), 0)
      convTotal += data.reduce((sum: number, row: any) => sum + (Number(row.amount_converted) || 0), 0)
      hasFx = hasFx || data.some((row: any) => row.amount_converted != null)
      srcCcy = srcCcy || data.find((row: any) => row.currency)?.currency || ''
      convCcy = convCcy || data.find((row: any) => row.converted_currency)?.converted_currency || ''

      if (data.length < pageSize) break
      from += pageSize
    }

    return { srcTotal, convTotal, hasFx, srcCcy, convCcy }
  }

  async function loadExpandedMeta(id: string) {
    const allCountQuery = supabase
      .from('import_rows')
      .select('*', { count: 'exact', head: true })
      .eq('import_id', id)

    const unmatchedCountQuery = supabase
      .from('import_rows')
      .select('*', { count: 'exact', head: true })
      .eq('import_id', id)
      .eq('match_status', 'unmatched')

    const errorCountQuery = supabase
      .from('import_rows')
      .select('*', { count: 'exact', head: true })
      .eq('import_id', id)
      .eq('error_flag', true)

    const [
      { count: allCount, error: allCountErr },
      { count: unmatchedCount, error: unmatchedCountErr },
      { count: errorCount, error: errorCountErr },
      totalsResult,
    ] = await Promise.all([
      allCountQuery,
      unmatchedCountQuery,
      errorCountQuery,
      loadExpandedFullTotals(id).then(data => ({ data, error: null as Error | null })).catch(error => ({ data: null, error })),
    ])

    const aggErr = totalsResult.error
    const aggData = totalsResult.data

    if (allCountErr || unmatchedCountErr || errorCountErr || aggErr) {
      setError(allCountErr?.message || unmatchedCountErr?.message || errorCountErr?.message || aggErr?.message || 'Failed to load import detail metadata.')
      setExpandedCounts({ all: 0, unmatched: 0, error: 0 })
      setExpandedTotals(null)
      return
    }

    setExpandedCounts({
      all: allCount ?? 0,
      unmatched: unmatchedCount ?? 0,
      error: errorCount ?? 0,
    })

    if (aggData) {
      setExpandedTotals(aggData)
    } else {
      setExpandedTotals({ srcTotal: 0, convTotal: 0, hasFx: false, srcCcy: '', convCcy: '' })
    }
  }

  async function toggleExpand(id: string) {
    if (expandedId === id) {
      setExpandedId(null)
      setExpandedTotals(null)
      setExpandedRows([])
      setExpandedPage(0)
      setExpandedCounts({ all: 0, unmatched: 0, error: 0 })
      return
    }
    setExpandedId(id)
    setHistoryRowFilter('')
    setExpandedPage(0)
    setExpandedRows([])
    setError(null)
    setExpandedTotals(null)
    await loadExpandedMeta(id)
  }

  // ── Delete ─────────────────────────────────────────────────────────────────

  async function handleDelete(imp: ImportRecord) {
    if (!confirm(`Delete "${imp.source_name ?? imp.file_name ?? imp.import_type}"? This cannot be undone.`)) return
    setDeletingId(imp.id)
    setError(null)
    // Remove exceptions tied to this import from DB before deleting the import.
    await supabase.from('exceptions').delete().eq('import_id', imp.id)
    const { data, error: err } = await supabase.rpc('delete_import_safe', { p_import_id: imp.id })
    if (err) {
      setError(err.message)
    } else if (data && data.success === false) {
      setError(data.message ?? 'Delete blocked. The import may have linked statement records.')
    } else {
      setImports(prev => prev.filter(i => i.id !== imp.id))
      if (expandedId === imp.id) setExpandedId(null)
    }
    setDeletingId(null)
  }

  // ── Wizard helpers ─────────────────────────────────────────────────────────

  function openWizard() {
    setStep('config')
    setFileName('')
    setHeaders([])
    setCsvRows([])
    setColMap({})
    setSonyPdfColMap({})
    setSonyPdfTotalMismatches([])
    setParsedRows([])
    setPdfCompletionNotice(null)
    setError(null)
    setSuccessMsg(null)
    setShowWizard(true)
    const opt = IMPORT_TYPE_OPTIONS.find(o => o.value === importType)
    if (opt) setDomain(opt.domain)
    // Keep wizard period in sync with currently selected history period
    const current = periods.find(p => p.id === wizardPeriodId) ?? periods.find(p => p.is_current) ?? periods[0]
    if (current) {
      setWizardPeriodId(current.id)
      setWizardPeriodLabel(current.label)
    }
  }

  function handleTypeChange(type: string) {
    setImportType(type)
    const opt = IMPORT_TYPE_OPTIONS.find(o => o.value === type)
    if (opt) setDomain(opt.domain)
  }

  function handleFileChange(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0]
    if (!file) return
    setFileName(file.name)
    const reader = new FileReader()
    reader.onload = ev => {
      const text = ev.target?.result as string
      const { headers: h, rows } = parseCSV(text)
      setHeaders(h)
      setCsvRows(rows)
      // Route to the correct column-map auto-mapper
      if (isSonyWide) {
        setSonyPdfColMap(autoMapSonyPdf(h))
      } else {
        setColMap(autoMap(h, COL_HINTS[importType] ?? {}))
      }
      setStep('map')
    }
    reader.readAsText(file, 'utf-8')
  }

  async function runMatchingFromSource(
    sourceRows: Record<string, string>[] = csvRows,
    sourceSonyMap: Partial<Record<SonyPdfColKey, string>> = sonyPdfColMap,
  ): Promise<ParsedRow[]> {
    setMatching(true)
    setError(null)
    setSonyPdfTotalMismatches([])

    const rate = exchangeRate ? parseFloat(exchangeRate) : null

    console.debug('[runMatching] importType:', importType, '| domain:', domain, '| repertoire:', repertoire.length, '| splits:', splits.length, '| csvRows:', sourceRows.length)

    // Yield to browser so spinner renders before the synchronous matching loop
    await new Promise(resolve => setTimeout(resolve, 10))

    let rows: ParsedRow[]

    if (isSonyWide) {
      // ── Sony PDF wide-format branch ─────────────────────────────────────────
      // Does NOT use believeParser. Expansion and matching handled entirely here.
      const { rows: expanded, totalMismatches } = expandSonyPdfRows(
        sourceRows,
        sourceSonyMap,
        rate,
        sourceCurrency,
        payees,
        contracts,
        payeeLinks,
        aliases,
        repertoire,
        splits
      )
      rows = expanded
      setSonyPdfTotalMismatches(totalMismatches)
    } else {
      // ── Standard long-format branch ─────────────────────────────────────────
      rows = sourceRows.map((raw, idx) => {
        const get = (k: ColMapKey): string | null => {
          const col = colMap[k]
          return col ? (raw[col]?.trim() || null) : null
        }
        const amtStr = get('amount')
        const amount = parseImportAmount(amtStr)

        let income_type = get('income_type')
        if (!income_type && domain === 'publishing') {
          const rt = (get('row_type') ?? '').toLowerCase()
          if (rt.includes('mechanical'))        income_type = 'mechanical'
          else if (rt.includes('digital_mech')) income_type = 'digital_mechanical'
          else if (rt.includes('perform'))      income_type = 'performance'
          else if (rt.includes('sync'))         income_type = 'synch'
        }

        const tempoIdentifier = domain === 'publishing' ? get('tempo_id_raw') : null
        const fallbackIdentifier = get('identifier_raw')
        const chosenIdentifier = domain === 'publishing'
          ? (tempoIdentifier || fallbackIdentifier)
          : fallbackIdentifier

        const partial: Partial<any> = {
          domain,
          payee_name_raw:    get('payee_name_raw'),
          contract_name_raw: get('contract_name_raw'),
          artist_name_raw:   get('artist_name_raw'),
          title_raw:         get('title_raw'),
          identifier_raw:    chosenIdentifier,
          tempo_id:          domain === 'publishing' ? tempoIdentifier : null,
          iswc:              domain === 'publishing' && !tempoIdentifier && looksLikeISWC(fallbackIdentifier) ? fallbackIdentifier : null,
          country_raw:       get('country_raw'),
          row_type:          get('row_type'),
          income_type,
          amount,
          currency:          get('currency'),
          raw_row_number:    idx + 1,
        }

        // identifier_raw: trim whitespace so normalizeIdentifier works correctly
        if (partial.identifier_raw) {
          partial.identifier_raw = partial.identifier_raw.trim()
        }

        const result = processImportRow(partial, payees, contracts, payeeLinks, aliases, repertoire, splits)
        const amount_converted = (rate && amount !== null) ? Math.round(amount * rate * 1e6) / 1e6 : null

        return {
          raw_row_number:        idx + 1,
          payee_name_raw:        partial.payee_name_raw ?? null,
          contract_name_raw:     partial.contract_name_raw ?? null,
          artist_name_raw:       partial.artist_name_raw ?? null,
          title_raw:             partial.title_raw ?? null,
          identifier_raw:        partial.identifier_raw ?? null,
          country_raw:           partial.country_raw ?? null,
          income_type,
          amount,
          currency:              partial.currency ?? null,
          row_type:              partial.row_type ?? null,
          _raw:                  raw,
          matched_payee_id:      result.matched_payee_id,
          matched_contract_id:   result.matched_contract_id,
          matched_repertoire_id: result.matched_repertoire_id,
          match_status:          result.match_status,
          warning_flag:          result.warning_flag,
          warning_reason:        result.warning_reason,
          error_flag:            result.error_flag,
          error_reason:          result.error_reason,
          normalized_title:      result.normalized_title,
          normalized_identifier: result.normalized_identifier,
          amount_converted,
        }
      })
    }

    setParsedRows(rows)
    setPreviewFilter('')
    setMatching(false)
    setStep('preview')
    return rows
  }

  async function runMatching() {
    await runMatchingFromSource(csvRows, sonyPdfColMap)
  }

  async function handlePdfWorkbenchConfirm(payload: {
    fileName: string
    headers: string[]
    rows: Record<string, string>[]
    mapping: Partial<Record<SonyPdfColKey, string>>
  }) {
    setFileName(payload.fileName)
    setHeaders(payload.headers)
    setCsvRows(payload.rows)
    setSonyPdfColMap(payload.mapping)
    const rows = await runMatchingFromSource(payload.rows, payload.mapping)
    await saveImportRows(rows, { pdfNotice: true })
  }

  async function saveImportRows(rowsToSave: ParsedRow[], options?: { pdfNotice?: boolean }) {
    setSaving(true)
    setSavingPhase('Creating import record…')
    setError(null)

    const matched   = rowsToSave.filter(r => r.match_status === 'matched').length
    const unmatched = rowsToSave.filter(r => r.match_status === 'unmatched').length
    const warnings  = rowsToSave.filter(r => r.warning_flag).length
    // error_flag = true system/parse failures only, not unmatched rows
    const errors    = rowsToSave.filter(r => r.error_flag).length
    const rate      = exchangeRate ? parseFloat(exchangeRate) : null

    const { data: imp, error: impErr } = await supabase
      .from('imports')
      .insert({
        import_type:         importType,
        domain,
        source_name:         sourceName || fileName || importType,
        file_name:           fileName || null,
        statement_period_id: wizardPeriodId,
        imported_by_name:    'Staff',
        row_count:           rowsToSave.length,
        success_count:       matched,
        warning_count:       warnings,
        error_count:         errors,
        import_status:       errors > rowsToSave.length * 0.5 ? 'partial' : 'complete',
        source_currency:     sourceCurrency || null,
        reporting_currency:  reportingCurrency || 'GBP',
        exchange_rate:       rate,
        exchange_rate_date:  exchangeRateDate || null,
        notes:               wizardNotes || null,
      })
      .select()
      .single()

    if (impErr || !imp) {
      setError(impErr?.message ?? 'Failed to create import record.')
      setSaving(false)
      return
    }

    // Insert rows in batches
    const BATCH = 100
    for (let i = 0; i < rowsToSave.length; i += BATCH) {
      const batch = rowsToSave.slice(i, i + BATCH).map(r => ({
        import_id:             imp.id,
        raw_row_number:        r.raw_row_number,
        domain,
        statement_period_id:   wizardPeriodId,
        payee_name_raw:        r.payee_name_raw,
        contract_name_raw:     r.contract_name_raw,
        artist_name_raw:       r.artist_name_raw,
        title_raw:             r.title_raw,
        identifier_raw:        r.identifier_raw,
        country_raw:           r.country_raw,
        income_type:           r.income_type,
        amount:                r.amount,
        currency:              r.currency,
        row_type:              r.row_type,
        amount_converted:      r.amount_converted,
        converted_currency:    r.amount_converted ? (reportingCurrency || 'GBP') : null,
        exchange_rate_used:    r.amount_converted ? rate : null,
        normalized_title:      r.normalized_title,
        normalized_identifier: r.normalized_identifier,
        matched_payee_id:      r.matched_payee_id,
        matched_contract_id:   r.matched_contract_id,
        matched_repertoire_id: r.matched_repertoire_id,
        match_status:          r.match_status,
        error_flag:            r.error_flag,
        error_reason:          r.error_reason,
        warning_flag:          r.warning_flag,
        warning_reason:        r.warning_reason,
        excluded_flag:         false,
        net_amount:            r.amount,
      }))
      const { error: bErr } = await supabase.from('import_rows').insert(batch)
      if (bErr) { setError(bErr.message); setSaving(false); return }
    }

    setSaving(false)
    setSavingPhase(null)
    await loadImports()

    if (options?.pdfNotice) {
      setPdfCompletionNotice({ importId: imp.id, unmatched })
      setStep('preview')
      setSuccessMsg(null)
      return imp
    }

    setShowWizard(false)
    setSuccessMsg(
      `Import saved: ${rowsToSave.length} rows — ${matched} matched, ${unmatched} unmatched${unmatched > 0 ? ' (visible in Sales Errors)' : ''}.`
    )
    return imp
  }

  async function saveImport() {
    await saveImportRows(parsedRows)
  }

  // ── Period helpers ─────────────────────────────────────────────────────────

  async function createPeriodIfNeeded(label: string): Promise<string | null> {
    const existing = periods.find(p => p.label.toLowerCase() === label.toLowerCase())
    if (existing) return existing.id
    const m = label.trim().match(/^(\d{4})-(H1|H2)$/i)
    if (!m) {
      setError(`Invalid period format. Use YYYY-H1 or YYYY-H2 (e.g. 2025-H1).`)
      return null
    }
    const year = parseInt(m[1], 10)
    const half = m[2].toUpperCase() as 'H1' | 'H2'
    const period_start = half === 'H1' ? `${year}-01-01` : `${year}-07-01`
    const period_end   = half === 'H1' ? `${year}-06-30` : `${year}-12-31`
    const { data, error: err } = await supabase
      .from('statement_periods')
      .insert({ year, half, label: label.trim(), period_start, period_end, status: 'open', is_current: false })
      .select()
      .single()
    if (err || !data) {
      setError(err?.message ?? 'Failed to create statement period.')
      return null
    }
    setPeriods(prev => [data, ...prev])
    return data.id
  }

  // ── Derived ────────────────────────────────────────────────────────────────

  const selectedPeriod = periods.find(p => p.id === selectedPeriodId)
  const totalRows    = imports.reduce((s, i) => s + i.row_count, 0)
  const totalMatched = imports.reduce((s, i) => s + i.success_count, 0)
  const totalErrors  = imports.reduce((s, i) => s + i.error_count, 0)

  const historyFiltered = expandedRows
  const expandedFilteredCount = historyRowFilter === 'unmatched'
    ? expandedCounts.unmatched
    : historyRowFilter === 'error'
    ? expandedCounts.error
    : expandedCounts.all
  const expandedVisibleCount = historyFiltered.length
  const expandedRangeStart = expandedVisibleCount === 0 ? 0 : (expandedPage * EXPANDED_PAGE_SIZE) + 1
  const expandedRangeEnd = expandedVisibleCount === 0 ? 0 : (expandedPage * EXPANDED_PAGE_SIZE) + expandedVisibleCount
  const expandedDisplayedTotal = historyFiltered.reduce((sum, row: any) => sum + (Number(row.amount) || 0), 0)
  const expandedDisplayedConvertedTotal = historyFiltered.reduce((sum, row: any) => sum + (Number(row.amount_converted) || 0), 0)
  const expandedDifference = (expandedTotals?.srcTotal ?? 0) - expandedDisplayedTotal
  const expandedHasPrevPage = expandedPage > 0
  const expandedHasNextPage = expandedRangeEnd < expandedFilteredCount

  const previewFiltered = previewFilter === 'unmatched'
    ? parsedRows.filter(r => r.match_status === 'unmatched')
    : previewFilter === 'error'
    ? parsedRows.filter(r => r.error_flag)
    : parsedRows

  const WIZARD_STEPS = ['config', 'upload', 'map', 'preview'] as const

  // ── Render ─────────────────────────────────────────────────────────────────

  return (
    <div className="space-y-5">

      {/* Header */}
      <div className="page-header">
        <div>
          <h1 className="page-title">Sales Imports</h1>
          <p className="page-subtitle">Upload, parse, match, and save royalty income files</p>
        </div>
        <div className="flex items-center gap-2">
          <button onClick={() => loadImports()} className="btn-ghost btn-sm"><RefreshCw size={13} /></button>
          <button onClick={openWizard} className="btn-primary btn-sm flex items-center gap-1.5">
            <Upload size={13} /> New Import
          </button>
        </div>
      </div>

      {error      && <Alert type="error">{error}</Alert>}
      {successMsg && <Alert type="success">{successMsg}</Alert>}

      {/* Period selector + stats */}
      <div className="flex items-center gap-3 flex-wrap">
        <select
          className="input-field text-sm py-1 px-2 pr-7"
          value={selectedPeriodId}
          onChange={e => setSelectedPeriodId(e.target.value)}
        >
          {periods.map(p => (
            <option key={p.id} value={p.id}>
              {p.label}
            </option>
          ))}
        </select>
      </div>

      <div className="grid grid-cols-4 gap-3">
        <StatCard label="Imports" value={imports.length} sub={selectedPeriod?.label} />
        <StatCard label="Total Rows" value={totalRows.toLocaleString()} />
        <StatCard label="Matched" value={totalMatched.toLocaleString()} color="green" />
        <StatCard label="Errors" value={totalErrors.toLocaleString()} color={totalErrors > 0 ? 'red' : 'default'} />
      </div>

      {/* Import history */}
      {loadingHistory ? (
        <div className="flex items-center gap-2 text-ops-muted text-sm p-4"><LoadingSpinner size={14} /> Loading…</div>
      ) : imports.length === 0 ? (
        <EmptyState icon={FileText} title="No imports for this period" description="Click New Import to upload a file." />
      ) : (
        <div className="space-y-2">
          {imports.map(imp => {
            const isExp = expandedId === imp.id
            const matchRate = imp.row_count > 0 ? Math.round((imp.success_count / imp.row_count) * 100) : null
            const typeOpt = IMPORT_TYPE_OPTIONS.find(o => o.value === imp.import_type)

            return (
              <div key={imp.id} className="card">
                <div className="flex items-center gap-3 cursor-pointer select-none" onClick={() => toggleExpand(imp.id)}>
                  <div className="flex-shrink-0">
                    {isExp ? <ChevronDown size={14} className="text-ops-muted" /> : <ChevronRight size={14} className="text-ops-muted" />}
                  </div>
                  <div className="flex-shrink-0">{statusIcon(imp.import_status)}</div>

                  <div className="flex items-center gap-1.5 flex-shrink-0">
                    <DomainBadge domain={imp.domain} />
                    {typeOpt && (
                      <span className={typeOpt.badge === 'primary' ? 'badge-info' : typeOpt.badge === 'legacy' ? 'badge-pending' : 'badge-pending'}>
                        {typeOpt.label}
                      </span>
                    )}
                  </div>

                  <div className="flex-1 min-w-0">
                    <div className="text-sm font-medium text-ops-text truncate">
                      {imp.source_name ?? imp.file_name ?? imp.import_type}
                    </div>
                    {imp.file_name && imp.source_name && (
                      <div className="text-xs text-ops-muted font-mono truncate">{imp.file_name}</div>
                    )}
                  </div>

                  {imp.exchange_rate && (
                    <div className="text-xs font-mono text-ops-muted flex-shrink-0">
                      {imp.source_currency}→{imp.reporting_currency} @ {imp.exchange_rate}
                    </div>
                  )}

                  <div className="flex items-center gap-3 text-xs font-mono flex-shrink-0">
                    <span className="text-ops-muted">{imp.row_count.toLocaleString()} rows</span>
                    {matchRate !== null && (
                      <span className={matchRate === 100 ? 'text-green-400' : matchRate > 80 ? 'text-amber-400' : 'text-red-400'}>
                        {matchRate}%
                      </span>
                    )}
                    {imp.warning_count > 0 && <span className="text-amber-400">{imp.warning_count}w</span>}
                    {imp.error_count   > 0 && <span className="text-red-400">{imp.error_count}e</span>}
                  </div>

                  <div className="text-xs text-ops-muted text-right flex-shrink-0">
                    <div>{fmtDate(imp.imported_at)}</div>
                    <div>{fmtTime(imp.imported_at)}</div>
                  </div>

                  {/* Delete */}
                  <button
                    className="btn-ghost btn-sm text-red-400 flex-shrink-0 ml-1"
                    disabled={deletingId === imp.id}
                    onClick={e => { e.stopPropagation(); handleDelete(imp) }}
                  >
                    {deletingId === imp.id ? <LoadingSpinner size={12} /> : <Trash2 size={13} />}
                  </button>
                </div>

                {/* Expanded row detail */}
                {isExp && (
                  <div className="mt-3 border-t pt-3 space-y-3" style={{ borderColor: 'var(--ops-border)' }}>
                    <div className="grid grid-cols-3 gap-3 text-xs">
                      <div><span className="text-ops-muted">Status: </span><span className="capitalize">{imp.import_status}</span></div>
                      <div><span className="text-ops-muted">By: </span>{imp.imported_by_name ?? '—'}</div>
                      {imp.notes && <div><span className="text-ops-muted">Notes: </span>{imp.notes}</div>}
                      {imp.exchange_rate && (
                        <div className="col-span-2">
                          <span className="text-ops-muted">FX: </span>
                          <span className="font-mono">{imp.source_currency} → {imp.reporting_currency} @ {imp.exchange_rate}{imp.exchange_rate_date ? ` (${imp.exchange_rate_date})` : ''}</span>
                        </div>
                      )}
                    </div>

                    <div className="flex items-center gap-1">
                      {(['', 'unmatched', 'error'] as const).map(f => (
                        <button
                          key={f}
                          className={`btn-sm ${historyRowFilter === f ? 'btn-primary' : 'btn-ghost'}`}
                          onClick={() => {
                            setHistoryRowFilter(f)
                            setExpandedPage(0)
                          }}
                        >
                          {f === ''          ? `All (${expandedCounts.all})`
                          : f === 'unmatched' ? `Unmatched (${expandedCounts.unmatched})`
                          :                    `Errors (${expandedCounts.error})`}
                        </button>
                      ))}
                    </div>

                    {/* Source Total uses full aggregate (all rows), while Displayed Total uses only the current page */}
                    {expandedTotals && (() => {
                      const { srcTotal, convTotal, hasFx, srcCcy, convCcy } = expandedTotals
                      return (
                        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 16, fontSize: 12, padding: '6px 10px', borderRadius: 6, border: '1px solid var(--ops-border)', background: 'var(--ops-surface-2)' }}>
                          <span>
                            <span style={{ color: 'var(--ops-muted)' }}>Rows: </span>
                            <span style={{ fontFamily: 'monospace', fontWeight: 600, color: 'var(--ops-text)' }}>
                              {expandedRangeStart.toLocaleString()}–{expandedRangeEnd.toLocaleString()} of {expandedFilteredCount.toLocaleString()}
                            </span>
                            <span style={{ color: 'var(--ops-muted)' }}> shown</span>
                            <span style={{ color: 'var(--ops-muted)' }}> · full import {expandedCounts.all.toLocaleString()}</span>
                          </span>
                          <span>
                            <span style={{ color: 'var(--ops-muted)' }}>Source Total{srcCcy ? ` (${srcCcy})` : ''}: </span>
                            <span style={{ fontFamily: 'monospace', fontWeight: 600, color: 'var(--ops-text)' }}>
                              {srcTotal.toLocaleString('en-GB', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
                            </span>
                          </span>
                          <span>
                            <span style={{ color: 'var(--ops-muted)' }}>Displayed Total{srcCcy ? ` (${srcCcy})` : ''}: </span>
                            <span style={{ fontFamily: 'monospace', fontWeight: 600, color: 'var(--accent-cyan)' }}>
                              {expandedDisplayedTotal.toLocaleString('en-GB', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
                            </span>
                          </span>
                          <span>
                            <span style={{ color: 'var(--ops-muted)' }}>Difference{srcCcy ? ` (${srcCcy})` : ''}: </span>
                            <span style={{ fontFamily: 'monospace', fontWeight: 600, color: expandedDifference === 0 ? 'var(--accent-green)' : 'var(--accent-amber)' }}>
                              {expandedDifference.toLocaleString('en-GB', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
                            </span>
                          </span>
                          {hasFx && (
                            <span>
                              <span style={{ color: 'var(--ops-muted)' }}>Full Import Converted{convCcy ? ` (${convCcy})` : ''}: </span>
                              <span style={{ fontFamily: 'monospace', fontWeight: 600, color: 'var(--accent-cyan)' }}>
                                {convTotal.toLocaleString('en-GB', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
                              </span>
                            </span>
                          )}
                          {hasFx && (
                            <span>
                              <span style={{ color: 'var(--ops-muted)' }}>Displayed Converted{convCcy ? ` (${convCcy})` : ''}: </span>
                              <span style={{ fontFamily: 'monospace', fontWeight: 600, color: 'var(--accent-cyan)' }}>
                                {expandedDisplayedConvertedTotal.toLocaleString('en-GB', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
                              </span>
                            </span>
                          )}
                        </div>
                      )
                    })()}

                    {expandedLoading ? (
                      <div className="flex items-center gap-2 py-3 text-ops-muted text-sm"><LoadingSpinner size={14} /> Loading…</div>
                    ) : historyFiltered.length === 0 ? (
                      <p className="text-sm text-ops-muted py-2">No rows match.</p>
                    ) : (
                      <div className="overflow-x-auto">
                        <table className="ops-table text-xs">
                          <thead>
                            <tr>
                              <th>#</th>
                              <th>Payee / Name</th>
                              <th>Title</th>
                              {imp.domain === 'publishing' && <th>Income Type</th>}
                              <th>Identifier</th>
                              <th className="text-right">Amount</th>
                              {imp.exchange_rate && <th className="text-right">Converted</th>}
                              <th>Match</th>
                              <th>Flags</th>
                            </tr>
                          </thead>
                          <tbody>
                            {historyFiltered.map((row: any) => (
                              <tr key={row.id}>
                                <td className="font-mono text-ops-muted">{row.raw_row_number ?? '—'}</td>
                                <td className="max-w-[140px] truncate">{row.payee_name_raw ?? row.contract_name_raw ?? '—'}</td>
                                <td className="max-w-[140px] truncate">{row.title_raw ?? '—'}</td>
                                {imp.domain === 'publishing' && (
                                  <td className="capitalize">{row.income_type?.replace(/_/g, ' ') ?? '—'}</td>
                                )}
                                <td className="font-mono">{row.identifier_raw ?? '—'}</td>
                                <td className="text-right font-mono">
                                  {row.amount != null ? `${row.currency ?? ''} ${Number(row.amount).toFixed(2)}` : '—'}
                                </td>
                                {imp.exchange_rate && (
                                  <td className="text-right font-mono text-cyan-400">
                                    {row.amount_converted != null ? `${row.converted_currency ?? ''} ${Number(row.amount_converted).toFixed(2)}` : '—'}
                                  </td>
                                )}
                                <td>{matchBadge(row.match_status)}</td>
                                <td>
                                  <div className="flex gap-1">
                                    {row.error_flag    && <span className="badge-critical text-[10px]">E</span>}
                                    {row.warning_flag  && <span className="badge-pending text-[10px]">W</span>}
                                    {row.excluded_flag && <span className="badge-pending text-[10px]">X</span>}
                                    {!row.error_flag && !row.warning_flag && !row.excluded_flag && <span className="text-ops-subtle">—</span>}
                                  </div>
                                </td>
                              </tr>
                            ))}
                          </tbody>
                        </table>
                        <div className="mt-2 flex items-center justify-between gap-3 text-xs text-ops-muted">
                          <p>
                            Showing {expandedRangeStart.toLocaleString()}–{expandedRangeEnd.toLocaleString()} of {expandedFilteredCount.toLocaleString()} rows
                            {historyRowFilter ? ` (${historyRowFilter})` : ''} · Full import {expandedCounts.all.toLocaleString()} rows
                          </p>
                          <div className="flex items-center gap-2">
                            <button
                              className="btn-sm btn-ghost"
                              disabled={!expandedHasPrevPage || expandedLoading}
                              onClick={() => setExpandedPage(p => Math.max(0, p - 1))}
                            >
                              Previous
                            </button>
                            <span className="font-mono">Page {(expandedPage + 1).toLocaleString()}</span>
                            <button
                              className="btn-sm btn-ghost"
                              disabled={!expandedHasNextPage || expandedLoading}
                              onClick={() => setExpandedPage(p => p + 1)}
                            >
                              Next
                            </button>
                          </div>
                        </div>
                      </div>
                    )}
                  </div>
                )}
              </div>
            )
          })}
        </div>
      )}

      {/* ── Import Wizard Modal ─────────────────────────────────────────────── */}
      {showWizard && (
        <div className="fixed inset-0 bg-black/70 z-50 flex items-center justify-center p-4">
          <div className="bg-ops-surface border border-ops-border rounded-xl w-full max-w-3xl max-h-[92vh] flex flex-col">

            {/* Header */}
            <div className="flex items-center justify-between px-5 py-3 border-b flex-shrink-0" style={{ borderColor: 'var(--ops-border)' }}>
              <div className="flex items-center gap-3">
                <span className="font-semibold text-ops-text">New Import</span>
                <div className="flex items-center gap-1 text-xs">
                  {WIZARD_STEPS.map((s, i) => (
                    <span key={s} className="flex items-center gap-1">
                      <span className={`px-2 py-0.5 rounded ${step === s ? 'bg-blue-600 text-white' : 'text-ops-subtle'}`}>
                        {i + 1}. {s.charAt(0).toUpperCase() + s.slice(1)}
                      </span>
                      {i < WIZARD_STEPS.length - 1 && <span className="text-ops-subtle">›</span>}
                    </span>
                  ))}
                </div>
              </div>
              <button onClick={() => setShowWizard(false)} className="btn-ghost btn-sm"><X size={14} /></button>
            </div>

            {/* Body */}
            <div className="flex-1 overflow-y-auto px-5 py-4">

              {/* Step 1: Config */}
              {step === 'config' && (
                <div className="space-y-4">
                  <p className="text-sm text-ops-muted">Configure the import before uploading a file.</p>
                  <div className="grid grid-cols-2 gap-4">
                    <div>
                      <label className="form-label">Import Type *</label>
                      <select className="input-field" value={importType} onChange={e => handleTypeChange(e.target.value)}>
                        <optgroup label="Master">
                          {sortByLabel(IMPORT_TYPE_OPTIONS.filter(o => o.domain === 'master'), o => o.label).map(o => (
                            <option key={o.value} value={o.value}>{o.label}</option>
                          ))}
                        </optgroup>
                        <optgroup label="Publishing">
                          {sortByLabel(IMPORT_TYPE_OPTIONS.filter(o => o.domain === 'publishing'), o => o.label).map(o => (
                            <option key={o.value} value={o.value}>{o.label}</option>
                          ))}
                        </optgroup>
                      </select>
                    </div>
                    <div>
                      <label className="form-label">Domain</label>
                      <select className="input-field" value={domain} onChange={e => setDomain(e.target.value as 'master' | 'publishing')}>
                        <option value="master">Master</option>
                        <option value="publishing">Publishing</option>
                      </select>
                    </div>
                    <div>
                      <label className="form-label">Statement Period *</label>
                      <PeriodCombobox
                        periods={periods}
                        value={wizardPeriodLabel}
                        onChange={(label, id) => {
                          setWizardPeriodLabel(label)
                          setWizardPeriodId(id ?? '')
                        }}
                      />
                    </div>
                    <div>
                      <label className="form-label">Source Name</label>
                      <input
                        className="input-field"
                        placeholder={
                          importType === 'sony_publishing_pdf' ? 'Sony Publishing PDF 2024-H2' :
                          importType === 'sony_csv'            ? 'Sony CSV 2024-H2' :
                          importType === 'believe'             ? 'Believe 2024-H2 Master' : ''
                        }
                        value={sourceName}
                        onChange={e => setSourceName(e.target.value)}
                      />
                    </div>
                  </div>

                  {/* Currency conversion */}
                  <div>
                    <p className="form-label mb-2">Currency Conversion <span className="text-ops-subtle font-normal text-xs">(optional — leave blank if not needed)</span></p>
                    <div className="grid grid-cols-4 gap-3">
                      <div>
                        <label className="form-label text-xs text-ops-muted">Source Currency</label>
                        <input className="input-field" placeholder="USD" maxLength={3}
                          value={sourceCurrency} onChange={e => setSourceCurrency(e.target.value.toUpperCase())} />
                      </div>
                      <div>
                        <label className="form-label text-xs text-ops-muted">Reporting Currency</label>
                        <input className="input-field" placeholder="GBP" maxLength={3}
                          value={reportingCurrency} onChange={e => setReportingCurrency(e.target.value.toUpperCase())} />
                      </div>
                      <div>
                        <label className="form-label text-xs text-ops-muted">Exchange Rate</label>
                        <input className="input-field" type="number" step="0.00000001" placeholder="0.79"
                          value={exchangeRate} onChange={e => setExchangeRate(e.target.value)} />
                      </div>
                      <div>
                        <label className="form-label text-xs text-ops-muted">Rate Date</label>
                        <input className="input-field" type="date"
                          value={exchangeRateDate} onChange={e => setExchangeRateDate(e.target.value)} />
                      </div>
                    </div>
                  </div>

                  <div>
                    <label className="form-label">Notes</label>
                    <input className="input-field" placeholder="Optional" value={wizardNotes} onChange={e => setWizardNotes(e.target.value)} />
                  </div>

                  {isSonyWide && (
                    <Alert type="info">
                      <strong>Sony Wide format:</strong> Each CSV row represents one song with
                      separate amount columns per income type (mech, perf, etc.). Each non-zero bucket expands
                      into a separate income row. Tempo ID is used as the primary matching identifier.
                    </Alert>
                  )}
                </div>
              )}

              {/* Step 2: Upload */}
              {step === 'upload' && (
                <div className="space-y-4">
                  {isSonyWide ? (
                    <div className="space-y-4">
                      {isSonyPdf && (
                        <Alert type="info">
                          Use either a prepared CSV export or the PDF review tool below. Both routes feed into the same Sony Wide matching and validation flow.
                        </Alert>
                      )}
                      <div
                        className="border-2 border-dashed rounded-lg p-8 text-center cursor-pointer hover:border-blue-500 transition-colors"
                        style={{ borderColor: 'var(--ops-border)' }}
                        onClick={() => fileRef.current?.click()}
                      >
                        <Upload size={28} className="mx-auto text-ops-muted mb-3" />
                        <p className="text-sm text-ops-text">Upload Sony Wide CSV</p>
                        <p className="text-xs text-ops-muted mt-1">Use this for parser-generated Sony CSV files.</p>
                        {fileName && <p className="text-xs text-green-400 mt-3 font-mono">{fileName}</p>}
                      </div>
                      <input ref={fileRef} type="file" accept=".csv,.txt,.tsv" className="hidden" onChange={handleFileChange} />
                      {isSonyPdf && <PdfStatementWorkbench onConfirm={handlePdfWorkbenchConfirm} />}
                    </div>
                  ) : (
                    <>
                      <p className="text-sm text-ops-muted">Upload a CSV file. Delimiter (comma, semicolon, tab) is detected automatically.</p>
                      <div
                        className="border-2 border-dashed rounded-lg p-12 text-center cursor-pointer hover:border-blue-500 transition-colors"
                        style={{ borderColor: 'var(--ops-border)' }}
                        onClick={() => fileRef.current?.click()}
                      >
                        <Upload size={32} className="mx-auto text-ops-muted mb-3" />
                        <p className="text-sm text-ops-text">Click to choose a file</p>
                        <p className="text-xs text-ops-muted mt-1">CSV, semicolon-delimited, or TSV</p>
                        {fileName && <p className="text-xs text-green-400 mt-3 font-mono">{fileName}</p>}
                      </div>
                      <input ref={fileRef} type="file" accept=".csv,.txt,.tsv" className="hidden" onChange={handleFileChange} />
                    </>
                  )}
                </div>
              )}

              {/* Step 3: Column mapping */}
              {step === 'map' && (
                <div className="space-y-4">
                  <div className="flex items-center justify-between">
                    <p className="text-sm text-ops-muted">
                      Map CSV columns to expected fields. Auto-mapped where possible.
                    </p>
                    <span className="text-xs text-ops-muted">{csvRows.length.toLocaleString()} rows · {headers.length} columns</span>
                  </div>

                  {isSonyWide ? (
                    /* ── Sony PDF wide-format column mapping ── */
                    <div className="space-y-2">
                      {SONY_PDF_COL_FIELDS.map(({ key, label, required, isAmount }) => (
                        <div key={key} className="flex items-center gap-3">
                          <label className="text-sm text-ops-text w-56 flex-shrink-0">
                            {label}
                            {required && <span className="text-red-400 ml-0.5">*</span>}
                            {isAmount && (
                              <span className="ml-1.5 text-[10px] font-mono text-ops-subtle bg-ops-surface-2 px-1 rounded">
                                £
                              </span>
                            )}
                          </label>
                          <select
                            className="input-field flex-1"
                            value={sonyPdfColMap[key] ?? ''}
                            onChange={e => setSonyPdfColMap(m => {
                              const next = { ...m }
                              if (e.target.value) next[key] = e.target.value
                              else delete next[key]
                              return next
                            })}
                          >
                            <option value="">— not mapped —</option>
                            {sortStrings(headers).map(h => <option key={h} value={h}>{h}</option>)}
                          </select>
                          {sonyPdfColMap[key] && (
                            <span className="text-xs font-mono text-ops-muted w-36 truncate flex-shrink-0">
                              e.g. {csvRows[0]?.[sonyPdfColMap[key]!] ?? ''}
                            </span>
                          )}
                        </div>
                      ))}
                      <Alert type="info">
                        <strong>Wide format:</strong> Non-zero bucket values expand into separate income rows.
                        Song Total (optional) is used only for validation — mismatches show as warnings
                        and do not block import.
                      </Alert>
                    </div>
                  ) : (
                    /* ── Standard long-format column mapping ── */
                    <div className="space-y-2">
                      {(domain === 'publishing' ? PUBLISHING_COL_FIELDS : MASTER_COL_FIELDS).map(({ key, label }) => (
                        <div key={key} className="flex items-center gap-3">
                          <label className="text-sm text-ops-text w-56 flex-shrink-0">{label}</label>
                          <select
                            className="input-field flex-1"
                            value={colMap[key] ?? ''}
                            onChange={e => setColMap(m => {
                              const next = { ...m }
                              if (e.target.value) next[key] = e.target.value
                              else delete next[key]
                              return next
                            })}
                          >
                            <option value="">— not mapped —</option>
                            {sortStrings(headers).map(h => <option key={h} value={h}>{h}</option>)}
                          </select>
                          {colMap[key] && (
                            <span className="text-xs font-mono text-ops-muted w-36 truncate flex-shrink-0">
                              e.g. {csvRows[0]?.[colMap[key]!] ?? ''}
                            </span>
                          )}
                        </div>
                      ))}

                      {domain === 'publishing' && (
                        <Alert type="info">
                          <strong>Publishing note:</strong> Tempo ID is the primary publishing identifier. If Tempo ID is missing, ISWC is used as the fallback before title matching. Writer names in the source are informational only.
                        </Alert>
                      )}
                    </div>
                  )}

                  {/* Raw data preview */}
                  {csvRows.length > 0 && headers.length > 0 && (
                    <div>
                      <p className="text-xs text-ops-muted mb-1">First 3 rows (raw):</p>
                      <div className="overflow-x-auto">
                        <table className="ops-table text-xs">
                          <thead><tr>{headers.map(h => <th key={h}>{h}</th>)}</tr></thead>
                          <tbody>
                            {csvRows.slice(0, 3).map((row, i) => (
                              <tr key={i}>{headers.map(h => <td key={h} className="max-w-[100px] truncate">{row[h]}</td>)}</tr>
                            ))}
                          </tbody>
                        </table>
                      </div>
                    </div>
                  )}
                </div>
              )}

              {/* Step 4: Preview */}
              {step === 'preview' && (
                <div className="space-y-3">
                  {pdfCompletionNotice ? (
                    <div className="space-y-4">
                      <Alert type="warning">
                        <strong>Check for unresolved rows on the Sales Errors page before attempting a Statement Run.</strong>
                      </Alert>
                      <div className="rounded-lg border p-4 space-y-3" style={{ borderColor: 'var(--ops-border)', background: 'var(--ops-surface-2)' }}>
                        <div className="text-sm font-medium text-ops-text">
                          PDF import saved successfully.
                        </div>
                        <div className="text-xs text-ops-muted">
                          Import rows are now in the system. Resolve any unmatched or missing-contract rows in Sales Errors before running statements.
                        </div>
                        <div className="flex items-center gap-3">
                          <Link href="/sales-errors" className="btn-primary btn-sm">
                            Go to Sales Errors
                          </Link>
                          <span className="text-xs text-ops-muted">
                            Import ID: <span className="font-mono">{pdfCompletionNotice.importId.slice(0, 8)}</span>
                            {' · '}
                            Unmatched rows: <span className="font-mono">{pdfCompletionNotice.unmatched}</span>
                          </span>
                        </div>
                      </div>
                    </div>
                  ) : (
                    <>

                  {/* Sony PDF song-total mismatch warnings — non-blocking */}
                  {isSonyWide && sonyPdfTotalMismatches.length > 0 && (
                    <Alert type="warning">
                      <strong>{sonyPdfTotalMismatches.length} song{sonyPdfTotalMismatches.length !== 1 ? 's' : ''} — Song Total mismatch.</strong>{' '}
                      Bucket columns do not sum to the Song Total value. Import is not blocked — check source data if unexpected.
                      {sonyPdfTotalMismatches.slice(0, 5).map((m, i) => (
                        <div key={i} className="font-mono text-xs mt-1 text-ops-muted">
                          "{m.title}": expected {m.expected.toFixed(2)}, got {m.actual.toFixed(2)}
                        </div>
                      ))}
                      {sonyPdfTotalMismatches.length > 5 && (
                        <div className="text-xs mt-1 text-ops-muted">…and {sonyPdfTotalMismatches.length - 5} more</div>
                      )}
                    </Alert>
                  )}

                  <div className="grid grid-cols-4 gap-3">
                    <StatCard label="Rows" value={parsedRows.length} />
                    <StatCard label="Matched"   value={parsedRows.filter(r => r.match_status === 'matched').length} color="green" />
                    <StatCard label="Partial"   value={parsedRows.filter(r => r.match_status === 'partial').length} color="amber" />
                    <StatCard label="Unmatched" value={parsedRows.filter(r => r.match_status === 'unmatched').length}
                      color={parsedRows.some(r => r.match_status === 'unmatched') ? 'red' : 'default'} />
                  </div>

                  {/* Task 5: Import totals */}
                  {parsedRows.length > 0 && (() => {
                    // Source Total = sum of CSV amount column values only — no allocations, no match logic
                    const sourceTotal    = parsedRows.reduce((s, r) => s + (r.amount ?? 0), 0)
                    const convertedTotal = parsedRows.filter(r => r.amount_converted != null).reduce((s, r) => s + (r.amount_converted ?? 0), 0)
                    const hasConverted   = parsedRows.some(r => r.amount_converted != null)
                    const srcCcy         = parsedRows.find(r => r.currency)?.currency ?? sourceCurrency ?? ''
                    return (
                      <div style={{
                        display: 'grid',
                        gridTemplateColumns: hasConverted ? '1fr 1fr' : '1fr',
                        gap: 1,
                        borderRadius: 8, border: '1px solid var(--ops-border)',
                        overflow: 'hidden', fontSize: 13,
                      }}>
                        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '8px 14px', background: 'var(--ops-surface-2)' }}>
                          <span style={{ color: 'var(--ops-muted)' }}>Source Total {srcCcy ? `(${srcCcy})` : ''}</span>
                          <span style={{ fontFamily: 'monospace', fontWeight: 600, color: 'var(--ops-text)' }}>
                            {sourceTotal.toLocaleString('en-GB', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
                          </span>
                        </div>
                        {hasConverted && (
                          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '8px 14px', background: 'var(--ops-surface-2)', borderLeft: '1px solid var(--ops-border)' }}>
                            <span style={{ color: 'var(--ops-muted)' }}>Converted Total ({reportingCurrency})</span>
                            <span style={{ fontFamily: 'monospace', fontWeight: 600, color: 'var(--accent-cyan)' }}>
                              {convertedTotal.toLocaleString('en-GB', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
                            </span>
                          </div>
                        )}
                      </div>
                    )
                  })()}

                  {parsedRows.some(r => r.match_status === 'unmatched') && (
                    <Alert type="warning">
                      Some rows could not be matched. They will be saved as unmatched and appear in{' '}
                      <a href="/sales-errors" className="underline font-medium">Sales Errors</a>. You can still save.
                    </Alert>
                  )}

                  <div className="flex items-center gap-1">
                    {(['', 'unmatched', 'error'] as const).map(f => (
                      <button key={f} className={`btn-sm ${previewFilter === f ? 'btn-primary' : 'btn-ghost'}`} onClick={() => setPreviewFilter(f)}>
                        {f === ''          ? `All (${parsedRows.length})`
                        : f === 'unmatched' ? `Unmatched (${parsedRows.filter(r => r.match_status === 'unmatched').length})`
                        :                    `Errors (${parsedRows.filter(r => r.error_flag).length})`}
                      </button>
                    ))}
                  </div>

                  <div className="overflow-x-auto">
                    <table className="ops-table text-xs">
                      <thead>
                        <tr>
                          <th>#</th>
                          <th>Title</th>
                          <th>Identifier</th>
                          {!isSonyWide && <th>Payee / Name</th>}
                          <th>Income Type</th>
                          <th className="text-right">Amount</th>
                          {exchangeRate && <th className="text-right">Converted</th>}
                          <th>Match</th>
                          <th>Notes</th>
                        </tr>
                      </thead>
                      <tbody>
                        {previewFiltered.slice(0, 200).map(row => (
                          <tr key={row.raw_row_number}>
                            <td className="font-mono text-ops-muted">{row.raw_row_number}</td>
                            <td className="max-w-[130px] truncate">{row.title_raw ?? '—'}</td>
                            <td className="font-mono text-xs">{row.identifier_raw ?? '—'}</td>
                            {!isSonyWide && (
                              <td className="max-w-[130px] truncate">{row.payee_name_raw ?? row.contract_name_raw ?? '—'}</td>
                            )}
                            <td className="capitalize">{row.income_type?.replace(/_/g, ' ') ?? '—'}</td>
                            <td className="text-right font-mono">
                              {row.amount != null ? `${row.currency ?? ''} ${row.amount.toFixed(2)}` : '—'}
                            </td>
                            {exchangeRate && (
                              <td className="text-right font-mono text-cyan-400">
                                {row.amount_converted != null ? `${reportingCurrency} ${row.amount_converted.toFixed(2)}` : '—'}
                              </td>
                            )}
                            <td>{matchBadge(row.match_status)}</td>
                            <td className="max-w-[180px] truncate text-ops-muted">
                              {row.error_reason ?? row.warning_reason ?? ''}
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                    {previewFiltered.length > 200 && (
                      <p className="text-xs text-ops-muted mt-1">Showing 200 of {previewFiltered.length} rows.</p>
                    )}
                  </div>
                </>
                  )}
                </div>
              )}
            </div>

            {/* Footer */}
            <div className="flex items-center justify-between px-5 py-3 border-t flex-shrink-0 gap-3" style={{ borderColor: 'var(--ops-border)' }}>
              <div className="text-sm text-red-400">{error ?? ''}</div>
              <div className="flex items-center gap-2">
                {/* Back */}
                {step !== 'config' && (
                  <button
                    className="btn-ghost btn-sm"
                    onClick={() => {
                      const prev: Record<'config' | 'upload' | 'map' | 'preview', 'config' | 'upload' | 'map' | 'preview'> = {
                        config:  'config',
                        upload:  'config',
                        map:     'upload',
                        preview: 'map',
                      }
                      setStep(prev[step] ?? 'config')
                    }}
                  >
                    ← Back
                  </button>
                )}
                {/* Forward / action */}
                {step === 'config' && (
                  <button
                    className="btn-primary btn-sm"
                    onClick={async () => {
                      if (!wizardPeriodLabel.trim()) { setError('Enter a statement period.'); return }
                      setError(null)
                      let pid = wizardPeriodId
                      if (!pid) {
                        pid = await createPeriodIfNeeded(wizardPeriodLabel.trim()) ?? ''
                        if (!pid) return
                        setWizardPeriodId(pid)
                      }
                      setStep('upload')
                    }}
                  >
                    Next: Upload →
                  </button>
                )}

                {step === 'upload' && (
                  <p className="text-sm text-ops-muted">Choose a file above to continue.</p>
                )}

                {step === 'map' && (
                  <button
                    className="btn-primary btn-sm flex items-center gap-1.5"
                    disabled={matching || csvRows.length === 0}
                    onClick={runMatching}
                  >
                    {matching ? <LoadingSpinner size={13} /> : <Play size={13} />}
                    {matching ? 'Matching rows…' : 'Run Matching →'}
                  </button>
                )}

                {step === 'preview' && (
                  pdfCompletionNotice ? (
                    <button className="btn-ghost btn-sm" onClick={() => setShowWizard(false)}>Close</button>
                  ) : (
                    <button
                      className="btn-primary btn-sm flex items-center gap-1.5"
                      disabled={saving}
                      onClick={saveImport}
                    >
                      {saving ? <LoadingSpinner size={13} /> : <CheckCircle size={13} />}
                      {saving ? (savingPhase ?? 'Saving…') : `Save Import (${parsedRows.length} rows)`}
                    </button>
                  )
                )}

                <button className="btn-ghost btn-sm" onClick={() => setShowWizard(false)}>Cancel</button>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
