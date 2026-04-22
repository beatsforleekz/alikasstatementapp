'use client'
import React, { useEffect, useRef, useState } from 'react'
import Link from 'next/link'
import { useRouter, useSearchParams } from 'next/navigation'
import { supabase } from '@/lib/supabase/client'
import { Alert, LoadingSpinner, EmptyState } from '@/components/ui'
import {
  FileText, Plus, RefreshCw, Search, Upload, X, CheckCircle,
  AlertTriangle, FileDown, ChevronDown, ChevronRight, Trash2, Edit, Link2, UserMinus,
} from 'lucide-react'
import {
  CONTRACT_TYPE_OPTIONS,
  contractTypeLabel,
  contractTypeToDomain,
  isMasterContractType,
  isPublishingContractType,
  normalizeContractType,
  PUBLISHING_CONTRACT_DEFAULTS,
  type Contract,
} from '@/lib/types'
import { sortByLabel } from '@/lib/utils/sortOptions'

// ── Types ─────────────────────────────────────────────────────────────────────

interface ContractRow extends Contract {
  sending_party?: Contract['sending_party']
  _payee_link_count?: number
  _repertoire_link_count?: number
  import_batch_id?: string | null
}

type LinkedWorkRow = {
  id: string
  repertoire_id: string
  royalty_rate: number | null
  repertoire: {
    id: string
    title: string | null
    tempo_id: string | null
  } | null
}

const CONTRACT_TEMPLATE_HEADERS = [
  'contract_name', 'contract_code', 'contract_type', 'currency', 'territory',
  'start_date', 'end_date', 'status', 'source_system', 'source_reference',
  'minimum_payment_threshold_override', 'hold_payment_flag', 'approval_required',
  'notes', 'sending_party_id', 'cross_recoup_group', 'statement_frequency',
  'pre_term_included', 'exclusion_notes', 'artist_share_percent',
  'mechanical_rate', 'digital_mechanical_rate', 'performance_rate',
  'digital_performance_rate', 'synch_rate', 'other_rate', 'is_recoupable',
] as const

const CONTRACT_REF_FETCH_PAGE_SIZE = 1000

type ContractImportRow = {
  _rowNum:                             number
  selected:                            boolean
  _warning:                            string | null
  contract_name:                       string
  contract_code:                       string
  contract_type:                       string
  currency:                            string
  territory:                           string
  start_date:                          string
  end_date:                            string
  status:                              string
  source_system:                       string
  source_reference:                    string
  minimum_payment_threshold_override:  string
  hold_payment_flag:                   boolean
  approval_required:                   boolean
  notes:                               string
  sending_party_id:                    string
  cross_recoup_group:                  string
  statement_frequency:                 string
  pre_term_included:                   boolean
  exclusion_notes:                     string
  artist_share_percent:                string
  mechanical_rate:                     string
  digital_mechanical_rate:             string
  performance_rate:                    string
  digital_performance_rate:            string
  synch_rate:                          string
  other_rate:                          string
  is_recoupable:                       boolean
}

// ── CSV helpers ────────────────────────────────────────────────────────────────

function parseContractCsv(text: string): { rows: ContractImportRow[]; unknownHeaders: string[] } {
  const cleaned = text.replace(/^\uFEFF/, '')
  const lines = cleaned.replace(/\r\n/g, '\n').replace(/\r/g, '\n').split('\n').filter(l => l.trim())
  if (lines.length < 2) return { rows: [], unknownHeaders: [] }

  const sample = lines[0]
  const delim = (sample.match(/;/g) ?? []).length >= (sample.match(/,/g) ?? []).length ? ';' : ','
  const rawHeaders = lines[0].split(delim).map(h => h.trim().replace(/^"|"$/g, '').toLowerCase().replace(/\s+/g, '_'))
  const knownSet = new Set<string>(CONTRACT_TEMPLATE_HEADERS)
  const unknownHeaders = rawHeaders.filter(h => !knownSet.has(h))

  const get = (obj: Record<string, string>, key: string) => (obj[key] ?? '').trim()
  const parseBool = (v: string): boolean => {
    const lc = v.toLowerCase()
    return lc === 'true' || lc === '1' || lc === 'yes'
  }

  const rows: ContractImportRow[] = []
  for (let i = 1; i < lines.length; i++) {
    const vals = lines[i].split(delim).map(v => v.trim().replace(/^"|"$/g, ''))
    if (vals.every(v => !v)) continue
    const obj: Record<string, string> = {}
    rawHeaders.forEach((h, idx) => { obj[h] = vals[idx] ?? '' })

    const contract_name = get(obj, 'contract_name')
    const rawType = get(obj, 'contract_type') || 'publishing'
    const contract_type = normalizeContractType(rawType) ?? 'publishing'
    const rawStatus = get(obj, 'status') || 'active'
    const status = ['active', 'inactive', 'expired', 'draft'].includes(rawStatus) ? rawStatus : 'active'
    const rawFreq = get(obj, 'statement_frequency')
    const statement_frequency = ['monthly', 'quarterly', 'bi-annual', 'annual'].includes(rawFreq) ? rawFreq : ''

    let _warning: string | null = null
    if (!contract_name) _warning = 'No contract_name — row will be skipped'
    else if (!normalizeContractType(rawType))
      _warning = `Unknown type "${rawType}" — defaulted to "publishing"`

    rows.push({
      _rowNum: i, selected: !!contract_name, _warning,
      contract_name,
      contract_code:   get(obj, 'contract_code'),
      contract_type,
      currency:        get(obj, 'currency') || 'GBP',
      territory:       get(obj, 'territory'),
      start_date:      get(obj, 'start_date'),
      end_date:        get(obj, 'end_date'),
      status,
      source_system:   get(obj, 'source_system'),
      source_reference: get(obj, 'source_reference'),
      minimum_payment_threshold_override: get(obj, 'minimum_payment_threshold_override'),
      hold_payment_flag:  parseBool(get(obj, 'hold_payment_flag')),
      approval_required:  parseBool(get(obj, 'approval_required')),
      notes:           get(obj, 'notes'),
      sending_party_id: get(obj, 'sending_party_id'),
      cross_recoup_group: get(obj, 'cross_recoup_group'),
      statement_frequency,
      pre_term_included: parseBool(get(obj, 'pre_term_included')),
      exclusion_notes: get(obj, 'exclusion_notes'),
      artist_share_percent:    get(obj, 'artist_share_percent'),
      mechanical_rate:         get(obj, 'mechanical_rate'),
      digital_mechanical_rate: get(obj, 'digital_mechanical_rate'),
      performance_rate:        get(obj, 'performance_rate'),
      digital_performance_rate: get(obj, 'digital_performance_rate'),
      synch_rate:              get(obj, 'synch_rate'),
      other_rate:              get(obj, 'other_rate'),
      is_recoupable:           parseBool(get(obj, 'is_recoupable')),
    })
  }
  return { rows, unknownHeaders }
}

type ContractFormState = {
  contract_name: string
  contract_code: string
  contract_type: string
  currency: string
  territory: string
  start_date: string
  end_date: string
  status: string
  source_system: string
  source_reference: string
  statement_frequency: string
  cross_recoup_group: string
  hold_payment_flag: boolean
  approval_required: boolean
  is_recoupable: boolean
  pre_term_included: boolean
  minimum_payment_threshold_override: string
  artist_share_percent: string
  mechanical_rate: string
  digital_mechanical_rate: string
  performance_rate: string
  digital_performance_rate: string
  synch_rate: string
  other_rate: string
  notes: string
  exclusion_notes: string
}

function buildContractFormState(contract: ContractRow | null, initialValues?: Partial<ContractFormState>): ContractFormState {
  const isCreateMode = !contract?.id
  return {
    contract_name:    contract?.contract_name    ?? initialValues?.contract_name    ?? '',
    contract_code:    contract?.contract_code    ?? initialValues?.contract_code    ?? '',
    contract_type:    normalizeContractType(contract?.contract_type) ?? initialValues?.contract_type ?? 'publishing',
    currency:         contract?.currency         ?? initialValues?.currency         ?? (isCreateMode ? PUBLISHING_CONTRACT_DEFAULTS.currency : 'GBP'),
    territory:        contract?.territory        ?? initialValues?.territory        ?? (isCreateMode ? PUBLISHING_CONTRACT_DEFAULTS.territory : ''),
    start_date:       contract?.start_date       ?? initialValues?.start_date       ?? '',
    end_date:         contract?.end_date         ?? initialValues?.end_date         ?? '',
    status:           contract?.status           ?? initialValues?.status           ?? PUBLISHING_CONTRACT_DEFAULTS.status,
    source_system:    contract?.source_system    ?? initialValues?.source_system    ?? '',
    source_reference: contract?.source_reference ?? initialValues?.source_reference ?? '',
    statement_frequency:  (contract?.statement_frequency  ?? initialValues?.statement_frequency  ?? (isCreateMode ? PUBLISHING_CONTRACT_DEFAULTS.statement_frequency : '')) as string,
    cross_recoup_group:   contract?.cross_recoup_group    ?? initialValues?.cross_recoup_group    ?? '',
    hold_payment_flag:    contract?.hold_payment_flag     ?? initialValues?.hold_payment_flag     ?? PUBLISHING_CONTRACT_DEFAULTS.hold_payment_flag,
    approval_required:    contract?.approval_required     ?? initialValues?.approval_required     ?? PUBLISHING_CONTRACT_DEFAULTS.approval_required,
    is_recoupable:        contract?.is_recoupable         ?? initialValues?.is_recoupable         ?? PUBLISHING_CONTRACT_DEFAULTS.is_recoupable,
    pre_term_included:    contract?.pre_term_included     ?? initialValues?.pre_term_included     ?? PUBLISHING_CONTRACT_DEFAULTS.pre_term_included,
    minimum_payment_threshold_override:
      contract?.minimum_payment_threshold_override != null
        ? String(contract.minimum_payment_threshold_override)
        : initialValues?.minimum_payment_threshold_override ?? '',
    artist_share_percent:     contract?.artist_share_percent     != null ? String(contract.artist_share_percent)     : initialValues?.artist_share_percent     ?? '',
    mechanical_rate:          contract?.mechanical_rate          != null ? formatRateInput(contract.mechanical_rate)          : initialValues?.mechanical_rate          ?? PUBLISHING_CONTRACT_DEFAULTS.mechanical_rate,
    digital_mechanical_rate:  contract?.digital_mechanical_rate  != null ? formatRateInput(contract.digital_mechanical_rate)  : initialValues?.digital_mechanical_rate  ?? PUBLISHING_CONTRACT_DEFAULTS.digital_mechanical_rate,
    performance_rate:         contract?.performance_rate         != null ? formatRateInput(contract.performance_rate)         : initialValues?.performance_rate         ?? PUBLISHING_CONTRACT_DEFAULTS.performance_rate,
    digital_performance_rate: contract?.digital_performance_rate != null ? formatRateInput(contract.digital_performance_rate) : initialValues?.digital_performance_rate ?? PUBLISHING_CONTRACT_DEFAULTS.digital_performance_rate,
    synch_rate:               contract?.synch_rate               != null ? formatRateInput(contract.synch_rate)               : initialValues?.synch_rate               ?? PUBLISHING_CONTRACT_DEFAULTS.synch_rate,
    other_rate:               contract?.other_rate               != null ? formatRateInput(contract.other_rate)               : initialValues?.other_rate               ?? PUBLISHING_CONTRACT_DEFAULTS.other_rate,
    notes:           contract?.notes           ?? initialValues?.notes           ?? '',
    exclusion_notes: contract?.exclusion_notes ?? initialValues?.exclusion_notes ?? '',
  }
}

function parseRate(v: string): number | null {
  if (!v.trim()) return null
  const n = parseFloat(v)
  return isNaN(n) ? null : n
}

function normalizeStoredRate(v: number | null | undefined): number | null {
  if (v == null || Number.isNaN(v)) return null
  return v > 1 ? v / 100 : v
}

function parseStoredRate(v: string): number | null {
  return normalizeStoredRate(parseRate(v))
}

function formatRateInput(v: number | null | undefined): string {
  const normalized = normalizeStoredRate(v)
  if (normalized == null) return ''
  const pct = normalized * 100
  return Number.isInteger(pct) ? String(pct) : String(parseFloat(pct.toFixed(4)))
}

function generateBatchId(): string {
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, c => {
    const r = Math.random() * 16 | 0
    return (c === 'x' ? r : (r & 0x3 | 0x8)).toString(16)
  })
}

function downloadContractTemplate() {
  const header = CONTRACT_TEMPLATE_HEADERS.join(',')
  const example = 'My Publishing Contract,PUB-001,Publishing,GBP,Worldwide,2024-01-01,,active,,,,,false,,,,quarterly,false,,,,,,,,,'
  const blob = new Blob([header + '\n' + example + '\n'], { type: 'text/csv' })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = 'Contract_Import_Template.csv'
  a.click()
  URL.revokeObjectURL(url)
}

// ── Helpers ────────────────────────────────────────────────────────────────────

function fmtDate(s: string | null | undefined) {
  if (!s) return '—'
  return new Date(s).toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' })
}

function statusBadge(status: string) {
  const cls =
    status === 'active'   ? 'badge-approved' :
    status === 'expired'  ? 'badge-critical' :
    status === 'draft'    ? 'badge-pending'  : 'badge-warning'
  return <span className={cls}>{status}</span>
}

function typeBadge(t: string) {
  return (
    <span className={contractTypeToDomain(t) === 'master' ? 'badge-master' : 'badge-publishing'}>
      {contractTypeLabel(t)}
    </span>
  )
}

// ── Contract Import Modal ──────────────────────────────────────────────────────

function ContractImportModal({ onClose, onSaved }: {
  onClose: () => void
  onSaved: () => void
}) {
  const fileRef = useRef<HTMLInputElement>(null)
  const [step, setStep]                     = useState<'upload' | 'review'>('upload')
  const [fileName, setFileName]             = useState('')
  const [rows, setRows]                     = useState<ContractImportRow[]>([])
  const [unknownHeaders, setUnknownHeaders] = useState<string[]>([])
  const [saving, setSaving]                 = useState(false)
  const [savedCount, setSavedCount]         = useState<number | null>(null)
  const [error, setError]                   = useState<string | null>(null)

  const updateRow = (i: number, key: keyof ContractImportRow, val: string | boolean) =>
    setRows(prev => prev.map((r, idx) => idx === i ? { ...r, [key]: val } : r))

  function handleFile(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0]
    if (!file) return
    setFileName(file.name)
    setError(null)
    const reader = new FileReader()
    reader.onload = ev => {
      const { rows: parsed, unknownHeaders: unk } = parseContractCsv(ev.target?.result as string)
      if (parsed.length === 0) {
        setError('No data rows found. Check the file has a header row and at least one data row.')
        return
      }
      setRows(parsed)
      setUnknownHeaders(unk)
      setStep('review')
    }
    reader.readAsText(file, 'utf-8')
  }

  async function saveAll() {
    const toSave = rows.filter(r => r.selected && r.contract_name.trim())
    if (toSave.length === 0) { setError('No valid rows selected.'); return }

    setSaving(true)
    setError(null)

    const batchId = generateBatchId()
    const now = new Date().toISOString()

    const payload = toSave.map(row => ({
      contract_name:    row.contract_name.trim(),
      contract_code:    row.contract_code    || null,
      contract_type:    normalizeContractType(row.contract_type) ?? 'publishing',
      currency:         row.currency         || 'GBP',
      territory:        row.territory        || null,
      start_date:       row.start_date       || null,
      end_date:         row.end_date         || null,
      status:           row.status           || 'active',
      source_system:    row.source_system    || null,
      source_reference: row.source_reference || null,
      minimum_payment_threshold_override: parseRate(row.minimum_payment_threshold_override),
      hold_payment_flag:  row.hold_payment_flag,
      approval_required:  row.approval_required,
      is_recoupable:      row.is_recoupable,
      cross_recoup_group: row.cross_recoup_group   || null,
      statement_frequency: (row.statement_frequency || null) as any,
      pre_term_included:  row.pre_term_included,
      exclusion_notes:    row.exclusion_notes    || null,
      sending_party_id:   row.sending_party_id   || null,
      artist_share_percent:    parseStoredRate(row.artist_share_percent),
      mechanical_rate:         parseStoredRate(row.mechanical_rate),
      digital_mechanical_rate: parseStoredRate(row.digital_mechanical_rate),
      performance_rate:        parseStoredRate(row.performance_rate),
      digital_performance_rate: parseStoredRate(row.digital_performance_rate),
      synch_rate:              parseStoredRate(row.synch_rate),
      other_rate:              parseStoredRate(row.other_rate),
      notes:                   row.notes || null,
      import_batch_id:         batchId,
      created_at:              now,
      updated_at:              now,
    }))

    const { data: inserted, error: insertErr } = await supabase
      .from('contracts')
      .insert(payload)
      .select('id')

    setSaving(false)

    if (insertErr) {
      setError(`Import failed: ${insertErr.message}`)
      return
    }

    const count = inserted?.length ?? payload.length
    setSavedCount(count)
    if (count > 0) setTimeout(onSaved, 1400)
  }

  const selected = rows.filter(r => r.selected && r.contract_name.trim()).length
  const warnings = rows.filter(r => r._warning).length

  return (
    <div className="fixed inset-0 bg-black/70 z-50 flex items-center justify-center p-4">
      <div className="bg-ops-surface border border-ops-border rounded-xl w-full max-w-5xl max-h-[90vh] flex flex-col">
        <div className="flex items-center justify-between p-4 border-b border-ops-border flex-shrink-0">
          <div>
            <span className="font-semibold">Bulk Import Contracts</span>
            <span className="ml-2 text-xs text-ops-muted">
              {step === 'upload'
                ? 'Import contracts from a CSV — catalogue/contract setup only, not sales or income'
                : `${rows.length} rows parsed · ${selected} selected`}
            </span>
          </div>
          <button onClick={onClose} className="btn-ghost btn-sm"><X size={14} /></button>
        </div>

        <div className="flex-1 overflow-y-auto p-4 space-y-4">
          {error && <Alert type="error">{error}</Alert>}

          {savedCount !== null && (
            <Alert type="success">
              {savedCount} contract{savedCount !== 1 ? 's' : ''} imported successfully. Closing…
            </Alert>
          )}

          {saving && (
            <div className="flex items-center gap-2 text-sm text-ops-muted">
              <LoadingSpinner size={13} />
              Inserting {selected} contracts…
            </div>
          )}

          {step === 'upload' && (
            <div className="space-y-4">
              <div className="rounded border p-3 text-xs space-y-2" style={{ borderColor: 'var(--ops-border)', background: 'var(--ops-surface-2)' }}>
                <p className="font-semibold text-ops-text">Expected CSV headers (Contract_Import_Template.csv)</p>
                <p className="font-mono text-ops-muted break-all text-[11px]">{CONTRACT_TEMPLATE_HEADERS.join(', ')}</p>
                <ul className="text-ops-subtle space-y-0.5 list-disc list-inside">
                  <li><span className="font-semibold text-ops-text">contract_name</span> — required. All other columns optional.</li>
                  <li><span className="font-semibold text-ops-text">contract_type</span> — one of <code>Publishing</code>, <code>Single Song Assignment</code>, <code>Master</code>, <code>Add-Producer</code>, or <code>Remix</code>. Defaults to <code>Publishing</code>.</li>
                  <li><span className="font-semibold text-ops-text">status</span> — <code>active</code>, <code>inactive</code>, <code>expired</code>, or <code>draft</code>.</li>
                  <li><span className="font-semibold text-ops-text">hold_payment_flag / approval_required / is_recoupable / pre_term_included</span> — <code>true</code> or <code>false</code>.</li>
                  <li>Rate columns (<code>mechanical_rate</code> etc.) — decimal values, e.g. <code>0.85</code> for 85%.</li>
                </ul>
              </div>
              <button className="btn-ghost btn-sm flex items-center gap-1.5" onClick={downloadContractTemplate}>
                <FileDown size={13} /> Download template CSV
              </button>
              <div
                className="border-2 border-dashed rounded-lg p-12 text-center cursor-pointer transition-colors hover:border-blue-500"
                style={{ borderColor: 'var(--ops-border)' }}
                onClick={() => fileRef.current?.click()}
              >
                <Upload size={28} className="mx-auto text-ops-muted mb-3" />
                <p className="text-sm text-ops-text">Click to choose a CSV file</p>
                <p className="text-xs text-ops-muted mt-1">Comma or semicolon delimited · UTF-8 or UTF-8 BOM</p>
                {fileName && <p className="text-xs text-green-400 mt-3 font-mono">{fileName}</p>}
              </div>
              <input ref={fileRef} type="file" accept=".csv,.txt" className="hidden" onChange={handleFile} />
            </div>
          )}

          {step === 'review' && (
            <div className="space-y-3">
              {unknownHeaders.length > 0 && (
                <Alert type="warning">
                  Unrecognised columns ignored: <span className="font-mono">{unknownHeaders.join(', ')}</span>
                </Alert>
              )}
              {warnings > 0 && (
                <Alert type="warning">
                  {warnings} row{warnings !== 1 ? 's have' : ' has'} warnings — see the Warning column for details. Rows with no contract_name are deselected automatically.
                </Alert>
              )}
              <div className="overflow-x-auto">
                <table className="ops-table text-xs">
                  <thead>
                    <tr>
                      <th>
                        <input
                          type="checkbox"
                          checked={rows.filter(r => r.contract_name.trim()).every(r => r.selected)}
                          onChange={e => setRows(prev => prev.map(r => ({ ...r, selected: r.contract_name.trim() ? e.target.checked : false })))}
                        />
                      </th>
                      <th>#</th>
                      <th>Contract Name *</th>
                      <th>Code</th>
                      <th>Type</th>
                      <th>Currency</th>
                      <th>Status</th>
                      <th>Start</th>
                      <th>End</th>
                      <th>Territory</th>
                      <th>Notes</th>
                      <th>Warning</th>
                    </tr>
                  </thead>
                  <tbody>
                    {rows.map((row, i) => (
                      <tr key={i} className={!row.selected || !row.contract_name.trim() ? 'opacity-40' : ''}>
                        <td>
                          <input
                            type="checkbox"
                            checked={row.selected && !!row.contract_name.trim()}
                            disabled={!row.contract_name.trim()}
                            onChange={e => updateRow(i, 'selected', e.target.checked)}
                          />
                        </td>
                        <td className="font-mono text-ops-subtle">{row._rowNum}</td>
                        <td>
                          <input className="ops-input text-xs" value={row.contract_name} placeholder="Required" onChange={e => updateRow(i, 'contract_name', e.target.value)} />
                        </td>
                        <td>
                          <input className="ops-input text-xs font-mono" value={row.contract_code} onChange={e => updateRow(i, 'contract_code', e.target.value)} />
                        </td>
                        <td>
                          <select className="ops-select text-xs" value={row.contract_type} onChange={e => updateRow(i, 'contract_type', e.target.value)}>
                            {CONTRACT_TYPE_OPTIONS.map(option => (
                              <option key={option.value} value={option.value}>{option.label}</option>
                            ))}
                          </select>
                        </td>
                        <td>
                          <input className="ops-input text-xs font-mono" value={row.currency} onChange={e => updateRow(i, 'currency', e.target.value.toUpperCase())} style={{ width: 52 }} />
                        </td>
                        <td>
                          <select className="ops-select text-xs" value={row.status} onChange={e => updateRow(i, 'status', e.target.value)}>
                            <option value="active">active</option>
                            <option value="inactive">inactive</option>
                            <option value="expired">expired</option>
                            <option value="draft">draft</option>
                          </select>
                        </td>
                        <td>
                          <input className="ops-input text-xs font-mono" value={row.start_date} placeholder="YYYY-MM-DD" onChange={e => updateRow(i, 'start_date', e.target.value)} style={{ width: 96 }} />
                        </td>
                        <td>
                          <input className="ops-input text-xs font-mono" value={row.end_date} placeholder="YYYY-MM-DD" onChange={e => updateRow(i, 'end_date', e.target.value)} style={{ width: 96 }} />
                        </td>
                        <td>
                          <input className="ops-input text-xs" value={row.territory} onChange={e => updateRow(i, 'territory', e.target.value)} style={{ width: 90 }} />
                        </td>
                        <td>
                          <input className="ops-input text-xs" value={row.notes} onChange={e => updateRow(i, 'notes', e.target.value)} />
                        </td>
                        <td style={{ minWidth: 180 }}>
                          {row._warning && (
                            <span className="flex items-start gap-1" style={{ color: 'var(--accent-amber)', fontSize: 11, lineHeight: 1.35 }}>
                              <AlertTriangle size={11} style={{ flexShrink: 0, marginTop: 1 }} />
                              {row._warning}
                            </span>
                          )}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          )}
        </div>

        <div className="flex items-center justify-between gap-3 p-4 border-t border-ops-border flex-shrink-0">
          <span className="text-xs text-ops-muted">
            {step === 'review' && `${selected} of ${rows.length} rows selected for import`}
          </span>
          <div className="flex items-center gap-2">
            {step === 'review' && (
              <button className="btn-ghost btn-sm" onClick={() => { setStep('upload'); setRows([]); setFileName(''); setError(null); setSavedCount(null) }}>
                ← Choose different file
              </button>
            )}
            <button className="btn-secondary btn-sm" onClick={onClose}>Cancel</button>
            {step === 'review' && (
              <button
                className="btn-primary btn-sm flex items-center gap-1.5"
                disabled={saving || selected === 0 || savedCount !== null}
                onClick={saveAll}
              >
                {saving
                  ? <><LoadingSpinner size={13} /> Inserting…</>
                  : <><CheckCircle size={13} /> Import {selected} contract{selected !== 1 ? 's' : ''}</>
                }
              </button>
            )}
          </div>
        </div>
      </div>
    </div>
  )
}

// ── Contract Edit Modal ────────────────────────────────────────────────────────

function ContractEditModal({
  contract,
  initialValues,
  onClose,
  onSaved,
}: {
  contract: ContractRow | null
  initialValues?: Partial<ContractFormState>
  onClose: () => void
  onSaved: () => void
}) {
  const isCreateMode = !contract?.id
  const [form, setForm] = useState<ContractFormState>(() => buildContractFormState(contract, initialValues))
  const [saving, setSaving] = useState(false)
  const [error, setError]   = useState<string | null>(null)

  useEffect(() => {
    setForm(buildContractFormState(contract, initialValues))
  }, [contract, initialValues])

  function set(key: string, val: string | boolean) {
    setForm(prev => ({ ...prev, [key]: val }))
  }

  function applyPublishingDefaults(typeValue: string) {
    if (!isCreateMode || !isPublishingContractType(typeValue)) return
    setForm(prev => ({
      ...prev,
      contract_type: normalizeContractType(typeValue) ?? 'publishing',
      status: PUBLISHING_CONTRACT_DEFAULTS.status,
      currency: PUBLISHING_CONTRACT_DEFAULTS.currency,
      territory: PUBLISHING_CONTRACT_DEFAULTS.territory,
      statement_frequency: PUBLISHING_CONTRACT_DEFAULTS.statement_frequency,
      hold_payment_flag: PUBLISHING_CONTRACT_DEFAULTS.hold_payment_flag,
      approval_required: PUBLISHING_CONTRACT_DEFAULTS.approval_required,
      is_recoupable: PUBLISHING_CONTRACT_DEFAULTS.is_recoupable,
      pre_term_included: PUBLISHING_CONTRACT_DEFAULTS.pre_term_included,
      mechanical_rate: PUBLISHING_CONTRACT_DEFAULTS.mechanical_rate,
      digital_mechanical_rate: PUBLISHING_CONTRACT_DEFAULTS.digital_mechanical_rate,
      performance_rate: PUBLISHING_CONTRACT_DEFAULTS.performance_rate,
      digital_performance_rate: PUBLISHING_CONTRACT_DEFAULTS.digital_performance_rate,
      synch_rate: PUBLISHING_CONTRACT_DEFAULTS.synch_rate,
      other_rate: PUBLISHING_CONTRACT_DEFAULTS.other_rate,
    }))
  }

  function handleContractTypeChange(typeValue: string) {
    if (isCreateMode && isPublishingContractType(typeValue)) {
      applyPublishingDefaults(typeValue)
      return
    }
    set('contract_type', typeValue)
  }

  async function save() {
    if (!form.contract_name.trim()) { setError('Contract name is required.'); return }
    setSaving(true)
    setError(null)

    const payload: Record<string, any> = {
      contract_name:    form.contract_name.trim(),
      contract_code:    form.contract_code    || null,
      contract_type:    normalizeContractType(form.contract_type) ?? 'publishing',
      currency:         form.currency         || 'GBP',
      territory:        form.territory        || null,
      start_date:       form.start_date       || null,
      end_date:         form.end_date         || null,
      status:           form.status,
      source_system:    form.source_system    || null,
      source_reference: form.source_reference || null,
      statement_frequency:  (form.statement_frequency  || null) as any,
      cross_recoup_group:   form.cross_recoup_group    || null,
      hold_payment_flag:    form.hold_payment_flag,
      approval_required:    form.approval_required,
      is_recoupable:        form.is_recoupable,
      pre_term_included:    form.pre_term_included,
      minimum_payment_threshold_override: parseRate(form.minimum_payment_threshold_override),
      artist_share_percent:     parseStoredRate(form.artist_share_percent),
      mechanical_rate:          parseStoredRate(form.mechanical_rate),
      digital_mechanical_rate:  parseStoredRate(form.digital_mechanical_rate),
      performance_rate:         parseStoredRate(form.performance_rate),
      digital_performance_rate: parseStoredRate(form.digital_performance_rate),
      synch_rate:               parseStoredRate(form.synch_rate),
      other_rate:               parseStoredRate(form.other_rate),
      notes:           form.notes           || null,
      exclusion_notes: form.exclusion_notes || null,
      updated_at:      new Date().toISOString(),
    }

    const result = contract?.id
      ? await supabase.from('contracts').update(payload).eq('id', contract.id)
      : await supabase.from('contracts').insert({
          ...payload,
          created_at: new Date().toISOString(),
        })

    const err = result.error
    setSaving(false)
    if (err) { setError(err.message); return }
    onSaved()
  }

  const isMaster = isMasterContractType(form.contract_type)

  return (
    <div className="fixed inset-0 bg-black/70 z-50 flex items-center justify-center p-4">
      <div className="bg-ops-surface border border-ops-border rounded-xl w-full max-w-2xl max-h-[90vh] flex flex-col">
        <div className="flex items-center justify-between p-4 border-b border-ops-border flex-shrink-0">
          <span className="font-semibold">{contract?.id ? `Edit Contract — ${contract.contract_name}` : 'New Contract'}</span>
          <button onClick={onClose} className="btn-ghost btn-sm"><X size={14} /></button>
        </div>

        <div className="flex-1 overflow-y-auto p-4 space-y-4">
          {error && <Alert type="error">{error}</Alert>}

          <div className="grid grid-cols-2 gap-3">
            <div className="col-span-2 ops-field">
              <label className="ops-label">Contract Name *</label>
              <input className="ops-input" value={form.contract_name} onChange={e => set('contract_name', e.target.value)} />
            </div>
            <div className="ops-field">
              <label className="ops-label">Contract Code</label>
              <input className="ops-input font-mono" value={form.contract_code} onChange={e => set('contract_code', e.target.value)} />
            </div>
            <div className="ops-field">
              <label className="ops-label">Type</label>
              <select className="ops-select" value={form.contract_type} onChange={e => handleContractTypeChange(e.target.value)}>
                {CONTRACT_TYPE_OPTIONS.map(option => (
                  <option key={option.value} value={option.value}>{option.label}</option>
                ))}
              </select>
            </div>
            <div className="ops-field">
              <label className="ops-label">Status</label>
              <select className="ops-select" value={form.status} onChange={e => set('status', e.target.value)}>
                <option value="active">Active</option>
                <option value="inactive">Inactive</option>
                <option value="expired">Expired</option>
                <option value="draft">Draft</option>
              </select>
            </div>
            <div className="ops-field">
              <label className="ops-label">Currency</label>
              <select className="ops-select" value={form.currency} onChange={e => set('currency', e.target.value)}>
                <option value="GBP">GBP</option>
                <option value="USD">USD</option>
                <option value="EUR">EUR</option>
                <option value="CAD">CAD</option>
                <option value="AUD">AUD</option>
              </select>
            </div>
            <div className="ops-field">
              <label className="ops-label">Territory</label>
              <input className="ops-input" value={form.territory} onChange={e => set('territory', e.target.value)} placeholder="e.g. UK, WW" />
            </div>
            <div className="ops-field">
              <label className="ops-label">Statement Frequency</label>
              <select className="ops-select" value={form.statement_frequency} onChange={e => set('statement_frequency', e.target.value)}>
                <option value="">— none —</option>
                <option value="monthly">Monthly</option>
                <option value="quarterly">Quarterly</option>
                <option value="bi-annual">Bi-annual</option>
                <option value="annual">Annual</option>
              </select>
            </div>
            <div className="ops-field">
              <label className="ops-label">Start Date</label>
              <input className="ops-input font-mono" type="date" value={form.start_date} onChange={e => set('start_date', e.target.value)} />
            </div>
            <div className="ops-field">
              <label className="ops-label">End Date</label>
              <input className="ops-input font-mono" type="date" value={form.end_date} onChange={e => set('end_date', e.target.value)} />
            </div>
            <div className="ops-field">
              <label className="ops-label">Source System</label>
              <input className="ops-input font-mono" value={form.source_system} onChange={e => set('source_system', e.target.value)} />
            </div>
            <div className="ops-field">
              <label className="ops-label">Source Reference</label>
              <input className="ops-input font-mono" value={form.source_reference} onChange={e => set('source_reference', e.target.value)} />
            </div>
            <div className="ops-field">
              <label className="ops-label">Cross Recoup Group</label>
              <input className="ops-input font-mono" value={form.cross_recoup_group} onChange={e => set('cross_recoup_group', e.target.value)} />
            </div>
            <div className="ops-field">
              <label className="ops-label">Min Payment Threshold Override</label>
              <input className="ops-input font-mono" value={form.minimum_payment_threshold_override} onChange={e => set('minimum_payment_threshold_override', e.target.value)} placeholder="e.g. 50" />
            </div>
          </div>

          {/* Flags */}
          <div className="grid grid-cols-2 gap-2">
            {([
              ['hold_payment_flag', 'Hold Payment'],
              ['approval_required', 'Approval Required'],
              ['is_recoupable',     'Recoupable'],
              ['pre_term_included', 'Pre-term Included'],
            ] as [string, string][]).map(([key, label]) => (
              <label key={key} className="flex items-center gap-2 text-sm text-ops-text cursor-pointer">
                <input
                  type="checkbox"
                  checked={form[key as keyof typeof form] as boolean}
                  onChange={e => set(key, e.target.checked)}
                  className="rounded"
                />
                {label}
              </label>
            ))}
          </div>

          {/* Rates */}
          {isMaster ? (
            <div className="ops-field">
              <label className="ops-label">Artist Share (decimal, e.g. 0.85)</label>
              <input className="ops-input font-mono" value={form.artist_share_percent} onChange={e => set('artist_share_percent', e.target.value)} placeholder="0.85" />
            </div>
          ) : (
            <div>
              <p className="ops-label mb-2">Publishing Rates (decimal)</p>
              <div className="grid grid-cols-3 gap-3">
                {([
                  ['mechanical_rate',          'Mechanical'],
                  ['digital_mechanical_rate',  'Digital Mech'],
                  ['performance_rate',         'Performance'],
                  ['digital_performance_rate', 'Digital Perf'],
                  ['synch_rate',               'Synch'],
                  ['other_rate',               'Other'],
                ] as [string, string][]).map(([key, label]) => (
                  <div key={key} className="ops-field">
                    <label className="ops-label">{label}</label>
                    <input className="ops-input font-mono text-xs" value={form[key as keyof typeof form] as string} onChange={e => set(key, e.target.value)} placeholder="0.00" />
                  </div>
                ))}
              </div>
            </div>
          )}

          <div className="ops-field">
            <label className="ops-label">Notes</label>
            <textarea className="ops-textarea" rows={2} value={form.notes} onChange={e => set('notes', e.target.value)} />
          </div>
          <div className="ops-field">
            <label className="ops-label">Exclusion Notes</label>
            <textarea className="ops-textarea" rows={2} value={form.exclusion_notes} onChange={e => set('exclusion_notes', e.target.value)} />
          </div>
        </div>

        <div className="flex justify-end gap-2 p-4 border-t border-ops-border flex-shrink-0">
          <button onClick={onClose} className="btn-secondary btn-sm" disabled={saving}>Cancel</button>
          <button onClick={save} disabled={saving} className="btn-primary btn-sm flex items-center gap-1.5">
            {saving ? <><LoadingSpinner size={13} /> Saving…</> : <><CheckCircle size={13} /> {contract?.id ? 'Save Changes' : 'Create Contract'}</>}
          </button>
        </div>
      </div>
    </div>
  )
}

// ── Payee Links Panel (shown inside expanded contract row) ─────────────────────

type PayeeLinkRow = {
  contract_id: string
  payee_id: string
  royalty_share: number
  is_active: boolean
  payee: { id: string; payee_name: string } | null
}

type NewPayeeFormState = {
  payee_name: string
  statement_name: string
  primary_contact_name: string
  primary_email: string
  secondary_email: string
  currency: string
  territory: string
  vendor_reference: string
  notes: string
  active_status: boolean
}

function normalizePayeeName(value: string | null | undefined) {
  return (value ?? '').trim().replace(/\s+/g, ' ').toLowerCase()
}

// royalty_share is stored as decimal (0–1); UI shows as percentage (0–100)
function ContractPayeeLinksPanel({
  contractId,
  onChanged,
}: {
  contractId: string
  onChanged: () => void
}) {
  const [links, setLinks]                     = useState<PayeeLinkRow[]>([])
  const [allPayees, setAllPayees]             = useState<{ id: string; payee_name: string }[]>([])
  const [loading, setLoading]                 = useState(true)
  const [selectedPayeeId, setSelectedPayeeId] = useState('')
  const [newShare, setNewShare]               = useState('100')
  const [saving, setSaving]                   = useState(false)
  const [error, setError]                     = useState<string | null>(null)
  const [showCreatePayee, setShowCreatePayee] = useState(false)
  const [newPayee, setNewPayee]               = useState<NewPayeeFormState>({
    payee_name: '',
    statement_name: '',
    primary_contact_name: '',
    primary_email: '',
    secondary_email: '',
    currency: 'GBP',
    territory: '',
    vendor_reference: '',
    notes: '',
    active_status: true,
  })
  // inline share editing: map of payee_id -> draft string value
  const [editingShares, setEditingShares]     = useState<Record<string, string>>({})
  const [savingShare, setSavingShare]         = useState<string | null>(null)

  useEffect(() => { loadAll() }, [contractId])

  async function loadAll() {
    setLoading(true)
    const [linksRes, payeesRes] = await Promise.all([
      supabase
        .from('contract_payee_links')
        .select('contract_id, payee_id, royalty_share, is_active, payee:payees(id, payee_name)')
        .eq('contract_id', contractId),
      supabase.from('payees').select('id, payee_name').order('payee_name'),
    ])
    setLinks(
  (linksRes.data ?? []).map((row: any) => ({
    ...row,
    payee: Array.isArray(row.payee) ? row.payee[0] ?? null : row.payee ?? null,
  })) as PayeeLinkRow[]
)
    setAllPayees((payeesRes.data ?? []) as { id: string; payee_name: string }[])
    setEditingShares({})
    setLoading(false)
  }

  const linkedPayeeIds = new Set(links.map(l => l.payee_id))
  const availablePayees = sortByLabel(allPayees.filter(p => !linkedPayeeIds.has(p.id)), payee => payee.payee_name)
  const activeLinks = links.filter(link => link.is_active)
  const activeShareTotal = activeLinks.reduce((sum, link) => sum + Number(link.royalty_share ?? 0), 0)
  const activeSharePct = Math.round(activeShareTotal * 10000) / 100
  const hasActivePayeeLinks = activeLinks.length > 0
  const sharesOver = activeShareTotal > 1.0005
  const sharesUnder = !sharesOver && hasActivePayeeLinks && activeShareTotal < 0.9995
  const sharesComplete = hasActivePayeeLinks && !sharesOver && !sharesUnder

  // royalty_share is stored as decimal (0–1); UI shows as percentage (0–100)
  function toDisplayPct(stored: number) { return parseFloat((stored * 100).toFixed(4)) }

  function validateShare(v: string): number | null {
    const n = parseFloat(v)
    if (isNaN(n) || n <= 0 || n > 100) return null
    return n
  }

  function setNewPayeeField<K extends keyof NewPayeeFormState>(key: K, value: NewPayeeFormState[K]) {
    setNewPayee(prev => ({ ...prev, [key]: value }))
  }

  function resetNewPayee() {
    setNewPayee({
      payee_name: '',
      statement_name: '',
      primary_contact_name: '',
      primary_email: '',
      secondary_email: '',
      currency: 'GBP',
      territory: '',
      vendor_reference: '',
      notes: '',
      active_status: true,
    })
  }

  async function activateContractIfNeedsLinking() {
    const { error: err } = await supabase
      .from('contracts')
      .update({
        status: 'active',
        updated_at: new Date().toISOString(),
      })
      .eq('id', contractId)
      .eq('status', 'needs_linking')

    if (err) {
      setError(err.message)
      return false
    }
    return true
  }

  async function addLink() {
    if (!selectedPayeeId) return
    if (links.some(link => link.payee_id === selectedPayeeId)) {
      setError('This payee is already linked to the contract.')
      return
    }
    const share = validateShare(newShare)
    if (share === null) {
      setError('Share must be a number between 1 and 100.')
      return
    }
    setSaving(true)
    setError(null)
    const { error: err } = await supabase.from('contract_payee_links').insert({
      contract_id:   contractId,
      payee_id:      selectedPayeeId,
      royalty_share: share / 100,
      is_active:     true,
    })
    setSaving(false)
    if (err) { setError(err.message); return }
    const activated = await activateContractIfNeedsLinking()
    if (!activated) return
    setSelectedPayeeId('')
    setNewShare('100')
    await loadAll()
    onChanged()
  }

  async function createAndLinkPayee() {
    const payeeName = newPayee.payee_name.trim()
    if (!payeeName) {
      setError('Payee name is required.')
      return
    }
    const duplicatePayee = allPayees.find(payee => normalizePayeeName(payee.payee_name) === normalizePayeeName(payeeName))
    if (duplicatePayee) {
      if (linkedPayeeIds.has(duplicatePayee.id)) {
        setError(`"${duplicatePayee.payee_name}" already exists and is already linked to this contract.`)
      } else {
        setError(`"${duplicatePayee.payee_name}" already exists. Link the existing payee instead of creating a duplicate.`)
      }
      return
    }
    const share = validateShare(newShare)
    if (share === null) {
      setError('Share must be a number between 1 and 100.')
      return
    }
    setSaving(true)
    setError(null)

    const timestamp = new Date().toISOString()
    const payeePayload = {
      payee_name: payeeName,
      statement_name: newPayee.statement_name.trim() || null,
      primary_contact_name: newPayee.primary_contact_name.trim() || null,
      primary_email: newPayee.primary_email.trim() || null,
      secondary_email: newPayee.secondary_email.trim() || null,
      currency: newPayee.currency || 'GBP',
      territory: newPayee.territory.trim() || null,
      vendor_reference: newPayee.vendor_reference.trim() || null,
      notes: newPayee.notes.trim() || null,
      active_status: newPayee.active_status,
      created_at: timestamp,
      updated_at: timestamp,
    }

    const { data: createdPayee, error: payeeError } = await supabase
      .from('payees')
      .insert(payeePayload)
      .select('id')
      .single()

    if (payeeError || !createdPayee) {
      setSaving(false)
      setError(payeeError?.message ?? 'Failed to create payee.')
      return
    }

    const { error: linkError } = await supabase.from('contract_payee_links').insert({
      contract_id: contractId,
      payee_id: createdPayee.id,
      royalty_share: share / 100,
      is_active: true,
    })

    setSaving(false)
    if (linkError) {
      setError(linkError.message)
      return
    }
    const activated = await activateContractIfNeedsLinking()
    if (!activated) return

    resetNewPayee()
    setShowCreatePayee(false)
    setNewShare('100')
    await loadAll()
    onChanged()
  }

  async function saveShare(payeeId: string) {
    const draft = editingShares[payeeId]
    if (draft === undefined) return
    const share = validateShare(draft)
    if (share === null) { setError('Share must be a number between 1 and 100.'); return }
    setSavingShare(payeeId)
    setError(null)
    const { error: err } = await supabase
      .from('contract_payee_links')
      .update({ royalty_share: share / 100 })
      .eq('contract_id', contractId)
      .eq('payee_id', payeeId)
    setSavingShare(null)
    if (err) { setError(err.message); return }
    await loadAll()
    onChanged()
  }

  async function removeLink(payeeId: string) {
    setError(null)
    const { error: err } = await supabase
      .from('contract_payee_links')
      .delete()
      .eq('contract_id', contractId)
      .eq('payee_id', payeeId)
    if (err) { setError(err.message); return }
    await loadAll()
    onChanged()
  }

  async function toggleActive(link: PayeeLinkRow) {
    // Warn before deactivating: an inactive link excludes the payee from all future statement runs
    if (link.is_active) {
      const confirmed = window.confirm(
        `Deactivate the link for "${link.payee?.payee_name ?? link.payee_id}"?\n\n` +
        `⚠ An inactive payee link is excluded from future statement runs. ` +
        `This payee will receive no allocations until the link is reactivated.`
      )
      if (!confirmed) return
    }
    const { error: err } = await supabase
      .from('contract_payee_links')
      .update({ is_active: !link.is_active })
      .eq('contract_id', contractId)
      .eq('payee_id', link.payee_id)
    if (err) { setError(err.message); return }
    await loadAll()
  }

  if (loading) {
    return (
      <div className="flex items-center gap-2 py-2 text-xs text-ops-muted">
        <LoadingSpinner size={12} /> Loading payee links…
      </div>
    )
  }

  return (
    <div className="space-y-3">
      {error && <Alert type="error">{error}</Alert>}

      {links.length === 0 ? (
        <Alert type="warning">
          No payees are linked to this contract yet. Add at least one active payee before using this contract in statement allocation.
        </Alert>
      ) : !hasActivePayeeLinks ? (
        <Alert type="warning">
          This contract has payee links, but none are active. Reactivate at least one payee before using this contract in statement allocation.
        </Alert>
      ) : sharesOver ? (
        <Alert type="warning">
          Active contract payee shares total {activeSharePct.toFixed(2)}%. Reduce the shares so the active total comes back to 100%.
        </Alert>
      ) : sharesUnder ? (
        <Alert type="warning">
          Active contract payee shares total {activeSharePct.toFixed(2)}%. Add the missing {(100 - activeSharePct).toFixed(2)}% so the contract is fully allocated.
        </Alert>
      ) : (
        <div className="text-xs text-ops-subtle">
          Active contract payee shares total <span className="font-mono text-ops-text">{activeSharePct.toFixed(2)}%</span>.
        </div>
      )}

      <div className="rounded-lg border px-3 py-2 text-xs space-y-1" style={{ borderColor: 'var(--ops-border)', background: 'var(--ops-surface)' }}>
        <p className="font-semibold text-ops-muted">Payee setup</p>
        <p className="text-ops-subtle">
          Link an existing payee below, or create a new payee here and it will be linked to this contract automatically.
          Set the share % during linking and add more payees later if needed.
        </p>
      </div>

      {links.length === 0 ? (
        <p className="text-xs text-ops-subtle">No payees linked to this contract yet.</p>
      ) : (
        <table className="ops-table text-xs w-full">
          <thead>
            <tr>
              <th>Payee</th>
              <th>Share %</th>
              <th>Active</th>
              <th style={{ width: 36 }} />
            </tr>
          </thead>
          <tbody>
            {links.map(link => {
              const displayPct = toDisplayPct(link.royalty_share)
              const isDirty = editingShares[link.payee_id] !== undefined &&
                editingShares[link.payee_id] !== String(displayPct)
              const displayVal = editingShares[link.payee_id] ?? String(displayPct)
              return (
                <tr key={link.payee_id}>
                  <td className="font-medium">{link.payee?.payee_name ?? link.payee_id}</td>
                  <td>
                    <div className="flex items-center gap-1">
                      <input
                        className="ops-input font-mono text-xs"
                        style={{ width: 64 }}
                        value={displayVal}
                        onChange={e => setEditingShares(prev => ({ ...prev, [link.payee_id]: e.target.value }))}
                        onKeyDown={e => { if (e.key === 'Enter') saveShare(link.payee_id) }}
                      />
                      <span className="text-ops-muted">%</span>
                      {isDirty && (
                        <button
                          className="btn-primary btn-sm px-1.5 py-0.5 text-[10px]"
                          disabled={savingShare === link.payee_id}
                          onClick={() => saveShare(link.payee_id)}
                          title="Save share"
                        >
                          {savingShare === link.payee_id ? <LoadingSpinner size={10} /> : '✓'}
                        </button>
                      )}
                    </div>
                  </td>
                  <td>
                    <button
                      className={`badge text-[10px] cursor-pointer ${link.is_active ? 'badge-approved' : 'badge-pending'}`}
                      title="Toggle active"
                      onClick={() => toggleActive(link)}
                    >
                      {link.is_active ? 'Active' : 'Inactive'}
                    </button>
                  </td>
                  <td>
                    <button
                      className="btn-ghost btn-sm"
                      title="Remove link"
                      onClick={() => removeLink(link.payee_id)}
                    >
                      <UserMinus size={12} className="text-red-400" />
                    </button>
                  </td>
                </tr>
              )
            })}
          </tbody>
        </table>
      )}

      {availablePayees.length > 0 && (
        <div className="flex items-center gap-2 flex-wrap">
          <select
            className="ops-select text-xs"
            value={selectedPayeeId}
            onChange={e => setSelectedPayeeId(e.target.value)}
            style={{ minWidth: 180 }}
          >
            <option value="">— select payee to link —</option>
            {availablePayees.map(p => (
              <option key={p.id} value={p.id}>{p.payee_name}</option>
            ))}
          </select>
          <div className="flex items-center gap-1">
            <input
              className="ops-input font-mono text-xs"
              style={{ width: 64 }}
              value={newShare}
              onChange={e => setNewShare(e.target.value)}
              placeholder="100"
              title="Royalty share %"
            />
            <span className="text-xs text-ops-muted">%</span>
          </div>
          <button
            className="btn-primary btn-sm flex items-center gap-1.5"
            disabled={!selectedPayeeId || saving}
            onClick={addLink}
          >
            {saving ? <LoadingSpinner size={12} /> : <Link2 size={12} />}
            Link Payee
          </button>
        </div>
      )}
      <div className="rounded-lg border p-3 space-y-3" style={{ borderColor: 'var(--ops-border)', background: 'var(--ops-surface)' }}>
        <div className="flex items-center justify-between gap-3">
          <div>
            <p className="text-xs font-semibold text-ops-muted">Create and link new payee</p>
            <p className="text-[11px] text-ops-subtle">Adds the payee to the main payees table, then links it to this contract.</p>
          </div>
          <button
            className="btn-ghost btn-sm flex items-center gap-1.5"
            onClick={() => {
              setShowCreatePayee(prev => {
                const next = !prev
                if (!next) resetNewPayee()
                return next
              })
            }}
            type="button"
          >
            <Plus size={12} />
            {showCreatePayee ? 'Hide' : 'New Payee'}
          </button>
        </div>

        {showCreatePayee && (
          <>
            <div className="grid grid-cols-2 gap-3">
              <div className="ops-field">
                <label className="ops-label">Payee Name *</label>
                <input className="ops-input text-xs" value={newPayee.payee_name} onChange={e => setNewPayeeField('payee_name', e.target.value)} />
              </div>
              <div className="ops-field">
                <label className="ops-label">Statement Name</label>
                <input className="ops-input text-xs" value={newPayee.statement_name} onChange={e => setNewPayeeField('statement_name', e.target.value)} />
              </div>
              <div className="ops-field">
                <label className="ops-label">Primary Contact</label>
                <input className="ops-input text-xs" value={newPayee.primary_contact_name} onChange={e => setNewPayeeField('primary_contact_name', e.target.value)} />
              </div>
              <div className="ops-field">
                <label className="ops-label">Primary Email</label>
                <input className="ops-input text-xs" type="email" value={newPayee.primary_email} onChange={e => setNewPayeeField('primary_email', e.target.value)} />
              </div>
              <div className="ops-field">
                <label className="ops-label">Currency</label>
                <select className="ops-select text-xs" value={newPayee.currency} onChange={e => setNewPayeeField('currency', e.target.value)}>
                  <option value="GBP">GBP</option>
                  <option value="USD">USD</option>
                  <option value="EUR">EUR</option>
                  <option value="CAD">CAD</option>
                  <option value="AUD">AUD</option>
                </select>
              </div>
              <div className="ops-field">
                <label className="ops-label">Territory</label>
                <input className="ops-input text-xs" value={newPayee.territory} onChange={e => setNewPayeeField('territory', e.target.value)} placeholder="e.g. WW" />
              </div>
              <div className="ops-field">
                <label className="ops-label">Vendor Ref</label>
                <input className="ops-input text-xs" value={newPayee.vendor_reference} onChange={e => setNewPayeeField('vendor_reference', e.target.value)} />
              </div>
              <div className="ops-field">
                <label className="ops-label">Share %</label>
                <div className="flex items-center gap-1">
                  <input
                    className="ops-input font-mono text-xs"
                    style={{ width: 80 }}
                    value={newShare}
                    onChange={e => setNewShare(e.target.value)}
                    placeholder="100"
                  />
                  <span className="text-xs text-ops-muted">%</span>
                </div>
              </div>
            </div>
            <div className="ops-field">
              <label className="ops-label">Notes</label>
              <textarea className="ops-textarea text-xs" rows={2} value={newPayee.notes} onChange={e => setNewPayeeField('notes', e.target.value)} />
            </div>
            <label className="flex items-center gap-2 text-xs text-ops-text">
              <input type="checkbox" checked={newPayee.active_status} onChange={e => setNewPayeeField('active_status', e.target.checked)} className="rounded" />
              Active
            </label>
            <div className="flex items-center justify-end gap-2">
              <button
                className="btn-secondary btn-sm"
                type="button"
                onClick={() => {
                  resetNewPayee()
                  setShowCreatePayee(false)
                }}
                disabled={saving}
              >
                Cancel
              </button>
              <button
                className="btn-primary btn-sm flex items-center gap-1.5"
                type="button"
                onClick={createAndLinkPayee}
                disabled={saving}
              >
                {saving ? <LoadingSpinner size={12} /> : <Plus size={12} />}
                Create & Link Payee
              </button>
            </div>
          </>
        )}
      </div>
      {availablePayees.length === 0 && allPayees.length > 0 && links.length > 0 && (
        <p className="text-xs text-ops-subtle">All payees are already linked to this contract.</p>
      )}
    </div>
  )
}

function ContractLinkedWorksPanel({
  contractId,
  onChanged,
}: {
  contractId: string
  onChanged: () => void
}) {
  const [links, setLinks] = useState<LinkedWorkRow[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [unlinkingId, setUnlinkingId] = useState<string | null>(null)

  useEffect(() => {
    loadAll()
  }, [contractId])

  async function loadAll() {
    setLoading(true)
    setError(null)
    const { data, error: err } = await supabase
      .from('contract_repertoire_links')
      .select('id, repertoire_id, royalty_rate, repertoire:repertoire(id, title, tempo_id)')
      .eq('contract_id', contractId)

    if (err) {
      setError(err.message)
      setLoading(false)
      return
    }

    setLinks(sortByLabel(
      ((data ?? []) as any[]).map(row => ({
        id: row.id,
        repertoire_id: row.repertoire_id,
        royalty_rate: row.royalty_rate ?? null,
        repertoire: Array.isArray(row.repertoire) ? row.repertoire[0] ?? null : row.repertoire ?? null,
      })),
      link => link.repertoire?.title ?? ''
    ))
    setLoading(false)
  }

  async function unlinkWork(link: LinkedWorkRow) {
    const confirmed = window.confirm(
      `Unlink "${link.repertoire?.title ?? 'this work'}" from this contract?\n\nThis removes the work -> contract link for future statement runs.`
    )
    if (!confirmed) return
    setUnlinkingId(link.id)
    setError(null)
    const { error: err } = await supabase
      .from('contract_repertoire_links')
      .delete()
      .eq('id', link.id)
    setUnlinkingId(null)
    if (err) {
      setError(err.message)
      return
    }
    await loadAll()
    onChanged()
  }

  return (
    <div className="space-y-3">
      {error && <Alert type="error">{error}</Alert>}

      <div className="flex items-center justify-between gap-3 flex-wrap">
        <div>
          <p className="font-semibold text-ops-muted">Linked Works</p>
          <p className="text-xs text-ops-subtle">All repertoire currently linked to this contract.</p>
        </div>
        <div className="text-xs text-ops-muted">
          Total linked works: <span className="font-mono text-ops-text">{links.length}</span>
        </div>
      </div>

      {loading ? (
        <div className="flex items-center gap-2 py-2 text-xs text-ops-muted">
          <LoadingSpinner size={12} /> Loading linked works…
        </div>
      ) : links.length === 0 ? (
        <p className="text-xs text-ops-subtle">No works are linked to this contract yet.</p>
      ) : (
        <table className="ops-table text-xs w-full">
          <thead>
            <tr>
              <th>Title</th>
              <th>Tempo ID</th>
              <th>Share %</th>
              <th style={{ width: 44 }} />
            </tr>
          </thead>
          <tbody>
            {links.map(link => (
              <tr key={link.id}>
                <td className="font-medium">
                  {link.repertoire?.title ?? 'Untitled work'}
                </td>
                <td className="font-mono text-ops-muted">
                  {link.repertoire?.tempo_id ?? '—'}
                </td>
                <td className="font-mono text-ops-muted">
                  {link.royalty_rate != null ? `${(link.royalty_rate * 100).toFixed(2)}%` : '—'}
                </td>
                <td>
                  <button
                    className="btn-ghost btn-sm"
                    title="Unlink work"
                    onClick={() => unlinkWork(link)}
                    disabled={unlinkingId === link.id}
                  >
                    {unlinkingId === link.id ? (
                      <LoadingSpinner size={12} />
                    ) : (
                      <X size={12} className="text-red-400" />
                    )}
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  )
}

// ── Contract detail expand panel ───────────────────────────────────────────────

function ContractDetailPanel({
  contract,
  onEdit,
  onChanged,
}: {
  contract: ContractRow
  onEdit: () => void
  onChanged: () => void
}) {
  const hasRates = [
    contract.mechanical_rate, contract.digital_mechanical_rate,
    contract.performance_rate, contract.digital_performance_rate,
    contract.synch_rate, contract.other_rate,
  ].some(r => r != null)

  const fmtRate = (v: number | null) => {
    const normalized = normalizeStoredRate(v)
    return normalized == null ? '—' : `${(normalized * 100).toFixed(2)}%`
  }

  return (
    <div
      className="p-3 border-t space-y-3 text-xs"
      style={{ borderColor: 'var(--ops-border)', background: 'var(--ops-surface-2)' }}
    >
      {/* Edit button */}
      <div className="flex justify-end">
        <button
          className="btn-ghost btn-sm flex items-center gap-1.5"
          onClick={onEdit}
        >
          <Edit size={12} /> Edit Contract
        </button>
      </div>

      <div className="rounded-lg border p-3" style={{ borderColor: 'var(--ops-border)', background: 'var(--ops-surface)' }}>
        <div className="flex items-center gap-2 flex-wrap">
          <span className="font-semibold text-sm text-ops-text">{contract.contract_name}</span>
          {typeBadge(contract.contract_type)}
          {statusBadge(contract.status)}
        </div>
      </div>

      {/* Core fields */}
      <div className="grid grid-cols-3 gap-x-6 gap-y-1.5">
        {contract.territory && (
          <div><span className="text-ops-muted">Territory: </span><span>{contract.territory}</span></div>
        )}
        {contract.statement_frequency && (
          <div><span className="text-ops-muted">Frequency: </span><span className="capitalize">{contract.statement_frequency}</span></div>
        )}
        {contract.sending_party?.name && (
          <div><span className="text-ops-muted">Sending party: </span><span>{contract.sending_party.name}</span></div>
        )}
        {contract.source_system && (
          <div><span className="text-ops-muted">Source system: </span><span className="font-mono">{contract.source_system}</span></div>
        )}
        {contract.source_reference && (
          <div><span className="text-ops-muted">Source ref: </span><span className="font-mono">{contract.source_reference}</span></div>
        )}
        {contract.minimum_payment_threshold_override != null && (
          <div><span className="text-ops-muted">Min threshold: </span><span className="font-mono">{contract.minimum_payment_threshold_override}</span></div>
        )}
        {contract.cross_recoup_group && (
          <div><span className="text-ops-muted">Recoup group: </span><span className="font-mono">{contract.cross_recoup_group}</span></div>
        )}
        {contract.import_batch_id && (
          <div className="col-span-3">
            <span className="text-ops-muted">Import batch: </span>
            <span className="font-mono text-ops-subtle">{contract.import_batch_id}</span>
          </div>
        )}
      </div>

      {/* Flags */}
      <div className="flex items-center gap-3 flex-wrap">
        {contract.hold_payment_flag && <span className="badge-critical text-[10px]">Hold payment</span>}
        {contract.approval_required && <span className="badge-warning text-[10px]">Approval required</span>}
        {contract.is_recoupable && <span className="badge-info text-[10px]">Recoupable</span>}
        {contract.pre_term_included && <span className="badge-pending text-[10px]">Pre-term included</span>}
        {(contract._payee_link_count ?? 0) === 0 && (
          <span className="badge-warning text-[10px]">No payee linked</span>
        )}
      </div>

      {/* Rates */}
      {isMasterContractType(contract.contract_type) && contract.artist_share_percent != null && (
        <div>
          <span className="text-ops-muted">Artist share: </span>
          <span className="font-mono font-semibold">{fmtRate(contract.artist_share_percent)}</span>
        </div>
      )}
      {isPublishingContractType(contract.contract_type) && hasRates && (
        <div>
          <div className="text-ops-muted mb-1 font-semibold">Publishing rates</div>
          <div className="grid grid-cols-3 gap-x-4 gap-y-1">
            {[
              ['Mechanical',          contract.mechanical_rate],
              ['Digital mechanical',  contract.digital_mechanical_rate],
              ['Performance',         contract.performance_rate],
              ['Digital performance', contract.digital_performance_rate],
              ['Synch',               contract.synch_rate],
              ['Other',               contract.other_rate],
            ].filter(([, v]) => v != null).map(([label, v]) => (
              <div key={label as string}>
                <span className="text-ops-subtle">{label}: </span>
                <span className="font-mono">{fmtRate(v as number | null)}</span>
              </div>
            ))}
          </div>
        </div>
      )}

      {contract.notes && (
        <div><span className="text-ops-muted">Notes: </span><span className="text-ops-subtle">{contract.notes}</span></div>
      )}
      {contract.exclusion_notes && (
        <div><span className="text-ops-muted">Exclusions: </span><span className="text-ops-subtle">{contract.exclusion_notes}</span></div>
      )}

      {(contract._payee_link_count ?? 0) === 0 && (
        <Alert type="warning">
          No active payee is linked to this contract yet. Statement rows cannot be assigned until you add a payee link below.
        </Alert>
      )}

      {/* Payee links */}
      <div className="border-t pt-3" style={{ borderColor: 'var(--ops-border)' }}>
        <p className="font-semibold text-ops-muted mb-2 flex items-center gap-1.5">
          <Link2 size={11} /> Linked Payees
        </p>
        <p className="text-xs text-ops-subtle mb-3">
          Use this section to finish contract setup in one place: link an existing payee, or create and link a new one with its share % straight away.
        </p>
        <ContractPayeeLinksPanel contractId={contract.id} onChanged={onChanged} />
      </div>

      <div className="border-t pt-3" style={{ borderColor: 'var(--ops-border)' }}>
        <ContractLinkedWorksPanel contractId={contract.id} onChanged={onChanged} />
      </div>
    </div>
  )
}

// ── Delete single contract modal ───────────────────────────────────────────────

function DeleteContractModal({
  contract,
  onClose,
  onDeleted,
}: {
  contract: ContractRow
  onClose: () => void
  onDeleted: () => void
}) {
  const [checking, setChecking]     = useState(true)
  const [payeeLinks, setPayeeLinks] = useState(0)
  const [repLinks, setRepLinks]     = useState(0)
  const [statementCount, setStatementCount] = useState(0)
  const [deleting, setDeleting]     = useState(false)
  const [error, setError]           = useState<string | null>(null)

  useEffect(() => {
    async function checkDeps() {
      const [pRes, rRes, sRes] = await Promise.all([
        supabase.from('contract_payee_links').select('id', { count: 'exact', head: true }).eq('contract_id', contract.id),
        supabase.from('contract_repertoire_links').select('id', { count: 'exact', head: true }).eq('contract_id', contract.id),
        supabase.from('statement_records').select('id', { count: 'exact', head: true }).eq('contract_id', contract.id),
      ])
      setPayeeLinks(pRes.count ?? 0)
      setRepLinks(rRes.count ?? 0)
      setStatementCount(sRes.count ?? 0)
      setChecking(false)
    }
    checkDeps()
  }, [contract.id])

  const blocked = repLinks > 0 || statementCount > 0

  async function handleDelete() {
    setDeleting(true)
    setError(null)
    if (blocked) {
      setError('Cannot delete contract with linked repertoire or statements. Remove linked data first.')
      setDeleting(false)
      return
    }

    if (payeeLinks > 0) {
      const { error: e } = await supabase.from('contract_payee_links').delete().eq('contract_id', contract.id)
      if (e) { setError(`Failed to remove payee links: ${e.message}`); setDeleting(false); return }
    }
    const { error: delErr } = await supabase.from('contracts').delete().eq('id', contract.id)
    if (delErr) { setError(delErr.message); setDeleting(false); return }
    onDeleted()
  }

  return (
    <div className="fixed inset-0 bg-black/70 z-50 flex items-center justify-center p-4">
      <div className="bg-ops-surface border border-ops-border rounded-xl w-full max-w-md p-5 space-y-4">
        <div className="flex items-center gap-2 text-red-400">
          <Trash2 size={16} />
          <span className="font-semibold">Delete Contract</span>
        </div>
        <p className="text-sm text-ops-text">
          Delete <span className="font-semibold">"{contract.contract_name}"</span>?
        </p>
        {checking ? (
          <div className="flex items-center gap-2 text-xs text-ops-muted">
            <LoadingSpinner size={12} /> Checking dependencies…
          </div>
        ) : blocked ? (
          <div className="rounded border p-3 text-xs space-y-1.5" style={{ borderColor: 'rgba(220,38,38,0.35)', background: 'rgba(220,38,38,0.06)' }}>
            <p className="font-semibold text-red-400 flex items-center gap-1.5">
              <AlertTriangle size={12} /> This contract cannot be deleted yet
            </p>
            {repLinks > 0 && <p className="text-ops-muted">{repLinks} repertoire link{repLinks !== 1 ? 's' : ''} still attached.</p>}
            {statementCount > 0 && <p className="text-ops-muted">{statementCount} statement record{statementCount !== 1 ? 's' : ''} still attached.</p>}
            <p className="text-ops-subtle">Cannot delete contract with linked repertoire or statements. Remove linked data first.</p>
          </div>
        ) : payeeLinks > 0 ? (
          <div className="rounded border p-3 text-xs space-y-1.5" style={{ borderColor: 'var(--ops-border)', background: 'var(--ops-surface-2)' }}>
            <p className="font-semibold text-ops-text">Payee links will be removed</p>
            <p className="text-ops-muted">{payeeLinks} payee link{payeeLinks !== 1 ? 's' : ''} will be removed before deleting this contract.</p>
          </div>
        ) : (
          <p className="text-xs text-ops-muted">This contract has no linked repertoire, statements, or payee links. It can be safely deleted.</p>
        )}
        {error && <Alert type="error">{error}</Alert>}
        <div className="flex justify-end gap-2">
          <button className="btn-secondary btn-sm" onClick={onClose} disabled={deleting}>Cancel</button>
          <button
            className="btn-primary btn-sm flex items-center gap-1.5"
            style={{ background: '#dc2626', borderColor: '#dc2626' }}
            onClick={handleDelete}
            disabled={deleting || checking}
          >
            {deleting ? <><LoadingSpinner size={13} /> Deleting…</> : <><Trash2 size={13} /> Delete</>}
          </button>
        </div>
      </div>
    </div>
  )
}

// ── Delete entire import batch modal ──────────────────────────────────────────

function DeleteBatchModal({
  batchId,
  batchContracts,
  onClose,
  onDeleted,
}: {
  batchId: string
  batchContracts: ContractRow[]
  onClose: () => void
  onDeleted: () => void
}) {
  const [deleting, setDeleting] = useState(false)
  const [error, setError]       = useState<string | null>(null)
  const [blockedSummary, setBlockedSummary] = useState<{ repLinks: number; statements: number } | null>(null)

  useEffect(() => {
    async function checkDeps() {
      const ids = batchContracts.map(c => c.id)
      if (ids.length === 0) { setBlockedSummary({ repLinks: 0, statements: 0 }); return }
      const [repRes, statementRes] = await Promise.all([
        supabase.from('contract_repertoire_links').select('id', { count: 'exact', head: true }).in('contract_id', ids),
        supabase.from('statement_records').select('id', { count: 'exact', head: true }).in('contract_id', ids),
      ])
      setBlockedSummary({
        repLinks: repRes.count ?? 0,
        statements: statementRes.count ?? 0,
      })
    }
    checkDeps()
  }, [batchContracts])

  async function handleDelete() {
    setDeleting(true)
    setError(null)

    const ids = batchContracts.map(c => c.id)
    if ((blockedSummary?.repLinks ?? 0) > 0 || (blockedSummary?.statements ?? 0) > 0) {
      setError('Cannot delete contract with linked repertoire or statements. Remove linked data first.')
      setDeleting(false)
      return
    }

    const { error: pRes } = await supabase.from('contract_payee_links').delete().in('contract_id', ids)
    if (pRes) { setError(`Failed to remove payee links: ${pRes.message}`); setDeleting(false); return }

    const { error: delErr } = await supabase.from('contracts').delete().in('id', ids)
    if (delErr) { setError(delErr.message); setDeleting(false); return }

    onDeleted()
  }

  return (
    <div className="fixed inset-0 bg-black/70 z-50 flex items-center justify-center p-4">
      <div className="bg-ops-surface border border-ops-border rounded-xl w-full max-w-md p-5 space-y-4">
        <div className="flex items-center gap-2 text-red-400">
          <Trash2 size={16} />
          <span className="font-semibold">Delete Import Batch</span>
        </div>
        <div className="text-sm text-ops-text space-y-1">
          <p>
            Delete all <span className="font-semibold">{batchContracts.length} contracts</span>
            {batchId === '__selected__' ? ' currently selected?' : ' from this import batch?'}
          </p>
          {batchId !== '__selected__' && <p className="text-xs font-mono text-ops-subtle break-all">{batchId}</p>}
        </div>
        {blockedSummary && ((blockedSummary.repLinks > 0) || (blockedSummary.statements > 0)) ? (
          <div className="rounded border p-3 text-xs space-y-1.5" style={{ borderColor: 'rgba(220,38,38,0.35)', background: 'rgba(220,38,38,0.06)' }}>
            <p className="text-red-400 font-semibold flex items-center gap-1.5">
              <AlertTriangle size={12} /> Batch cannot be deleted yet
            </p>
            {blockedSummary.repLinks > 0 && <p className="text-ops-muted">{blockedSummary.repLinks} repertoire link{blockedSummary.repLinks !== 1 ? 's' : ''} still attached.</p>}
            {blockedSummary.statements > 0 && <p className="text-ops-muted">{blockedSummary.statements} statement record{blockedSummary.statements !== 1 ? 's' : ''} still attached.</p>}
            <p className="text-ops-subtle">Cannot delete contract with linked repertoire or statements. Remove linked data first.</p>
          </div>
        ) : (
          <div className="rounded border p-3 text-xs space-y-1.5" style={{ borderColor: 'var(--ops-border)', background: 'var(--ops-surface-2)' }}>
            <p className="text-ops-text font-semibold flex items-center gap-1.5">
              <AlertTriangle size={12} /> Payee links will be removed first
            </p>
            <p className="text-ops-muted">Any payee links attached to these contracts will be deleted before the contracts themselves. This cannot be undone.</p>
          </div>
        )}
        {error && <Alert type="error">{error}</Alert>}
        <div className="flex justify-end gap-2">
          <button className="btn-secondary btn-sm" onClick={onClose} disabled={deleting}>Cancel</button>
          <button
            className="btn-primary btn-sm flex items-center gap-1.5"
            style={{ background: '#dc2626', borderColor: '#dc2626' }}
            onClick={handleDelete}
            disabled={deleting || !!blockedSummary && (blockedSummary.repLinks > 0 || blockedSummary.statements > 0)}
          >
            {deleting
              ? <><LoadingSpinner size={13} /> Deleting…</>
              : <><Trash2 size={13} /> Delete {batchContracts.length} contracts</>
            }
          </button>
        </div>
      </div>
    </div>
  )
}

// ── Main page ──────────────────────────────────────────────────────────────────

export default function ContractsPage() {
  const router = useRouter()
  const searchParams = useSearchParams()
  const [loading, setLoading]           = useState(true)
  const [contracts, setContracts]       = useState<ContractRow[]>([])
  const [search, setSearch]             = useState('')
  const [typeFilter, setTypeFilter]     = useState('')
  const [statusFilter, setStatusFilter] = useState('')
  const [batchFilter, setBatchFilter]   = useState('')
  const [expandedId, setExpandedId]     = useState<string | null>(null)
  const [showImport, setShowImport]     = useState(false)
  const [showCreate, setShowCreate]     = useState(false)
  const [error, setError]               = useState<string | null>(null)
  const [selectedIds, setSelectedIds]   = useState<Set<string>>(new Set())
  const [editingContract, setEditingContract]       = useState<ContractRow | null>(null)
  const [confirmDelete, setConfirmDelete]           = useState<ContractRow | null>(null)
  const [confirmDeleteBatch, setConfirmDeleteBatch] = useState<string | null>(null)

  useEffect(() => { load() }, [])

  const salesErrorReturnTo = searchParams.get('returnTo') || ''
  const createFromSalesError = searchParams.get('create') === '1' && searchParams.get('source') === 'sales-errors'
  const salesErrorTitle = searchParams.get('title') || ''
  const salesErrorPayee = searchParams.get('payee') || ''
  const salesErrorIdentifier = searchParams.get('identifier') || ''
  const salesErrorRowNumber = searchParams.get('row') || ''
  const initialCreateValues: Partial<ContractFormState> | undefined = createFromSalesError ? {
    contract_name: searchParams.get('contract_name') || searchParams.get('title') || '',
    contract_type: 'publishing',
    status: 'active',
    source_system: 'sales_errors',
    source_reference: searchParams.get('source_reference') || searchParams.get('identifier') || '',
    notes: searchParams.get('notes') || '',
  } : undefined

  useEffect(() => {
    if (createFromSalesError) setShowCreate(true)
  }, [createFromSalesError])

  function clearSalesErrorCreateContext() {
    if (!createFromSalesError && !salesErrorReturnTo) return
    const next = new URLSearchParams(searchParams.toString())
    ;[
      'create',
      'source',
      'contract_name',
      'source_reference',
      'notes',
      'title',
      'payee',
      'identifier',
      'row',
      'returnTo',
    ].forEach(key => next.delete(key))
    router.replace(next.toString() ? `/contracts?${next.toString()}` : '/contracts')
  }

  async function fetchAllPaged<T>(
    buildQuery: (from: number, to: number) => PromiseLike<{ data: T[] | null; error: any }>
  ) {
    let from = 0
    let all: T[] = []
    while (true) {
      const { data, error } = await buildQuery(from, from + CONTRACT_REF_FETCH_PAGE_SIZE - 1)
      if (error) throw error
      const batch = (data ?? []) as T[]
      if (batch.length === 0) break
      all = all.concat(batch)
      if (batch.length < CONTRACT_REF_FETCH_PAGE_SIZE) break
      from += CONTRACT_REF_FETCH_PAGE_SIZE
    }
    return all
  }

  async function load() {
    setLoading(true)
    setError(null)
    const { data, error: err } = await supabase
      .from('contracts')
      .select('*, sending_party:sending_parties(name)')
      .order('contract_name')
    if (err) { setError(err.message); setLoading(false); return }

    const rows = (data ?? []) as ContractRow[]

    const [payeeLinkRes, repLinkRows] = await Promise.all([
      supabase.from('contract_payee_links').select('contract_id').eq('is_active', true),
      fetchAllPaged<{ contract_id: string }>((from, to) =>
        supabase
          .from('contract_repertoire_links')
          .select('contract_id')
          .order('contract_id')
          .range(from, to)
      ),
    ])
    const payeeCounts: Record<string, number> = {}
    for (const r of (payeeLinkRes.data ?? [])) {
      payeeCounts[r.contract_id] = (payeeCounts[r.contract_id] ?? 0) + 1
    }
    const repCounts: Record<string, number> = {}
    for (const r of repLinkRows) {
      repCounts[r.contract_id] = (repCounts[r.contract_id] ?? 0) + 1
    }

    setContracts(sortByLabel(rows.map(c => ({
      ...c,
      _payee_link_count:      payeeCounts[c.id] ?? 0,
      _repertoire_link_count: repCounts[c.id] ?? 0,
    })), contract => contract.contract_name))
    setSelectedIds(prev => new Set(Array.from(prev).filter(id => rows.some(c => c.id === id))))
    setLoading(false)
  }

  const importBatches = Array.from(
    new Set(contracts.map(c => c.import_batch_id).filter(Boolean) as string[])
  )

  const filtered = contracts.filter(c => {
    if (typeFilter && normalizeContractType(c.contract_type) !== typeFilter) return false
    if (statusFilter && c.status !== statusFilter) return false
    if (batchFilter && c.import_batch_id !== batchFilter) return false
    if (search) {
      const q = search.toLowerCase()
      if (
        !c.contract_name.toLowerCase().includes(q) &&
        !(c.contract_code?.toLowerCase().includes(q)) &&
        !(c.territory?.toLowerCase().includes(q)) &&
        !(c.source_reference?.toLowerCase().includes(q))
      ) return false
    }
    return true
  })

  const masterCount     = contracts.filter(c => isMasterContractType(c.contract_type)).length
  const publishingCount = contracts.filter(c => isPublishingContractType(c.contract_type)).length
  const activeCount     = contracts.filter(c => c.status === 'active').length

  const batchContractsForDelete = confirmDeleteBatch
    ? confirmDeleteBatch === '__selected__'
      ? contracts.filter(c => selectedIds.has(c.id))
      : contracts.filter(c => c.import_batch_id === confirmDeleteBatch)
    : []
  const allFilteredSelected = filtered.length > 0 && filtered.every(c => selectedIds.has(c.id))
  const someSelected = selectedIds.size > 0

  const toggleSelected = (id: string) => {
    setSelectedIds(prev => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  const toggleSelectAllFiltered = () => {
    if (allFilteredSelected) {
      setSelectedIds(prev => {
        const next = new Set(prev)
        filtered.forEach(contract => next.delete(contract.id))
        return next
      })
      return
    }
    setSelectedIds(prev => new Set([...Array.from(prev), ...filtered.map(contract => contract.id)]))
  }

  return (
    <div className="space-y-4">

      {/* Header */}
      <div className="page-header">
        <div>
          <h1 className="page-title">Contracts</h1>
          <p className="page-subtitle">
            {contracts.length} contracts · {masterCount} master · {publishingCount} publishing · {activeCount} active
          </p>
        </div>
        <div className="flex items-center gap-2">
          <button onClick={load} className="btn-ghost btn-sm"><RefreshCw size={13} /></button>
          <button onClick={() => setShowCreate(true)} className="btn-primary btn-sm flex items-center gap-1.5">
            <Plus size={13} /> New Contract
          </button>
          <button onClick={() => setShowImport(true)} className="btn-secondary btn-sm flex items-center gap-1.5">
            <Upload size={13} /> Bulk Import
          </button>
        </div>
      </div>

      {error && <Alert type="error">{error}</Alert>}
      {createFromSalesError && (
        <Alert type="info">
          <div className="flex items-center justify-between gap-3 flex-wrap">
            <div className="space-y-1">
              <div className="font-medium text-ops-text">Creating a contract from Sales Errors</div>
              <div className="text-xs text-ops-muted">
                {salesErrorRowNumber ? `Row #${salesErrorRowNumber}` : 'Sales Error'}
                {salesErrorTitle ? ` · ${salesErrorTitle}` : ''}
                {salesErrorIdentifier ? ` · ${salesErrorIdentifier}` : ''}
                {salesErrorPayee ? ` · payee ${salesErrorPayee}` : ''}
              </div>
              <div className="text-xs text-ops-subtle">
                Save the contract, link it to the work, then return to Sales Errors to refresh and resolve the row.
              </div>
            </div>
            <div className="flex items-center gap-2">
              {salesErrorReturnTo && (
                <Link href={salesErrorReturnTo} className="btn-secondary btn-sm">
                  Back to Sales Errors
                </Link>
              )}
              <button className="btn-ghost btn-sm" onClick={clearSalesErrorCreateContext}>
                Clear
              </button>
            </div>
          </div>
        </Alert>
      )}

      {/* Summary stats */}
      {!loading && contracts.length > 0 && (
        <div className="grid grid-cols-3 gap-3">
          <div className="card p-3 text-center">
            <div className="text-2xl font-bold text-ops-text">{activeCount}</div>
            <div className="text-xs text-ops-muted mt-0.5">Active</div>
          </div>
          <div className="card p-3 text-center">
            <div className="text-2xl font-bold text-ops-text">{masterCount}</div>
            <div className="text-xs text-ops-muted mt-0.5">Master</div>
          </div>
          <div className="card p-3 text-center">
            <div className="text-2xl font-bold text-ops-text">{publishingCount}</div>
            <div className="text-xs text-ops-muted mt-0.5">Publishing</div>
          </div>
        </div>
      )}

      {/* Filters */}
      <div className="card p-3 flex items-center gap-2 flex-wrap">
        <div className="relative">
          <Search size={13} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-ops-muted" />
          <input
            className="ops-input pl-8 w-64"
            placeholder="Search name, code, territory, ref…"
            value={search}
            onChange={e => setSearch(e.target.value)}
          />
        </div>
        <select className="ops-select w-36" value={typeFilter} onChange={e => setTypeFilter(e.target.value)}>
          <option value="">All types</option>
          {CONTRACT_TYPE_OPTIONS.map(option => (
            <option key={option.value} value={option.value}>{option.label}</option>
          ))}
        </select>
        <select className="ops-select w-36" value={statusFilter} onChange={e => setStatusFilter(e.target.value)}>
          <option value="">All statuses</option>
          <option value="active">Active</option>
          <option value="inactive">Inactive</option>
          <option value="expired">Expired</option>
          <option value="draft">Draft</option>
        </select>

        {importBatches.length > 0 && (
          <select
            className="ops-select"
            style={{ maxWidth: 230 }}
            value={batchFilter}
            onChange={e => setBatchFilter(e.target.value)}
          >
            <option value="">All batches</option>
            {importBatches.map((b, idx) => {
              const count = contracts.filter(c => c.import_batch_id === b).length
              return (
                <option key={b} value={b}>
                  Batch {idx + 1} · {count} contracts · {b.slice(0, 8)}…
                </option>
              )
            })}
          </select>
        )}

        {batchFilter && (
          <button
            className="btn-ghost btn-sm flex items-center gap-1"
            style={{ color: 'var(--accent-red)' }}
            onClick={() => setConfirmDeleteBatch(batchFilter)}
          >
            <Trash2 size={12} /> Delete batch
          </button>
        )}

        {(search || typeFilter || statusFilter || batchFilter) && (
          <button
            className="btn-ghost btn-sm text-ops-muted"
            onClick={() => { setSearch(''); setTypeFilter(''); setStatusFilter(''); setBatchFilter('') }}
          >
            Clear filters
          </button>
        )}
        <span className="text-xs text-ops-muted ml-auto">
          {filtered.length} of {contracts.length}
        </span>
      </div>

      {someSelected && (
        <div className="card p-3 flex items-center justify-between gap-3 flex-wrap">
          <span className="text-sm text-ops-text">{selectedIds.size} contract{selectedIds.size !== 1 ? 's' : ''} selected</span>
          <div className="flex items-center gap-2">
            <button className="btn-ghost btn-sm" onClick={() => setSelectedIds(new Set())}>Clear</button>
            <button
              className="btn-ghost btn-sm flex items-center gap-1"
              style={{ color: 'var(--accent-red)' }}
              onClick={() => setConfirmDeleteBatch('__selected__')}
            >
              <Trash2 size={12} /> Delete selected
            </button>
          </div>
        </div>
      )}

      {/* Contracts list */}
      <div className="card">
        {loading ? (
          <div className="flex justify-center py-16"><LoadingSpinner size={22} /></div>
        ) : filtered.length === 0 ? (
          <EmptyState
            title="No contracts found"
            icon={FileText}
            description={contracts.length === 0
              ? 'Import contracts using the Bulk Import button above.'
              : 'No contracts match your filters.'
            }
          />
        ) : (
          <div className="overflow-x-auto">
            <table className="ops-table">
              <thead>
                <tr>
                  <th style={{ width: 32 }}>
                    <input type="checkbox" checked={allFilteredSelected} onChange={toggleSelectAllFiltered} />
                  </th>
                  <th style={{ width: 24 }} />
                  <th>Contract Name</th>
                  <th>Code</th>
                  <th>Type</th>
                  <th>Status</th>
                  <th>Currency</th>
                  <th>Start</th>
                  <th>End</th>
                  <th>Payees</th>
                  <th>Works</th>
                  <th style={{ width: 36 }} />
                </tr>
              </thead>
              <tbody>
                {filtered.map(c => {
                  const isExp = expandedId === c.id
                  return (
                    <React.Fragment key={c.id}>
                      <tr
                        style={{ cursor: 'pointer' }}
                        onClick={() => setExpandedId(isExp ? null : c.id)}
                        title="Click to expand details"
                      >
                        <td onClick={e => e.stopPropagation()}>
                          <input type="checkbox" checked={selectedIds.has(c.id)} onChange={() => toggleSelected(c.id)} />
                        </td>
                        <td>
                          {isExp
                            ? <ChevronDown size={13} className="text-ops-muted" />
                            : <ChevronRight size={13} className="text-ops-muted" />
                          }
                        </td>
                        <td className="font-medium text-sm">{c.contract_name}</td>
                        <td className="font-mono text-xs text-ops-muted">{c.contract_code ?? '—'}</td>
                        <td>{typeBadge(c.contract_type)}</td>
                        <td>{statusBadge(c.status)}</td>
                        <td className="font-mono text-xs">{c.currency}</td>
                        <td className="text-xs text-ops-muted font-mono">{fmtDate(c.start_date)}</td>
                        <td className="text-xs text-ops-muted font-mono">{fmtDate(c.end_date)}</td>
                        <td className="text-xs">
                          {(c._payee_link_count ?? 0) > 0
                            ? <span style={{ color: 'var(--accent-green)' }}>{c._payee_link_count} linked</span>
                            : <span style={{ color: 'var(--accent-amber)' }}>No payee linked</span>
                          }
                        </td>
                        <td className="text-xs">
                          {(c._repertoire_link_count ?? 0) > 0
                            ? <span style={{ color: 'var(--accent-green)' }}>{c._repertoire_link_count} linked</span>
                            : <span className="text-ops-subtle">—</span>
                          }
                        </td>
                        <td onClick={e => e.stopPropagation()}>
                          <button
                            className="btn-ghost btn-sm"
                            title="Delete this contract"
                            onClick={() => setConfirmDelete(c)}
                          >
                            <Trash2 size={13} className="text-red-400" />
                          </button>
                        </td>
                      </tr>
                      {isExp && (
                        <tr>
                          <td colSpan={12} style={{ padding: 0 }}>
                            <ContractDetailPanel
                              contract={c}
                              onEdit={() => setEditingContract(c)}
                              onChanged={load}
                            />
                          </td>
                        </tr>
                      )}
                    </React.Fragment>
                  )
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {showImport && (
        <ContractImportModal
          onClose={() => setShowImport(false)}
          onSaved={() => { setShowImport(false); load() }}
        />
      )}

      {showCreate && (
        <ContractEditModal
          contract={null}
          initialValues={initialCreateValues}
          onClose={() => {
            setShowCreate(false)
            clearSalesErrorCreateContext()
          }}
          onSaved={() => {
            setShowCreate(false)
            clearSalesErrorCreateContext()
            load()
          }}
        />
      )}

      {editingContract && (
        <ContractEditModal
          contract={editingContract}
          onClose={() => setEditingContract(null)}
          onSaved={() => { setEditingContract(null); load() }}
        />
      )}

      {confirmDelete && (
        <DeleteContractModal
          contract={confirmDelete}
          onClose={() => setConfirmDelete(null)}
          onDeleted={() => { setConfirmDelete(null); load() }}
        />
      )}

      {confirmDeleteBatch && batchContractsForDelete.length > 0 && (
        <DeleteBatchModal
          batchId={confirmDeleteBatch}
          batchContracts={batchContractsForDelete}
          onClose={() => setConfirmDeleteBatch(null)}
          onDeleted={() => { setConfirmDeleteBatch(null); setBatchFilter(''); setSelectedIds(new Set()); load() }}
        />
      )}
    </div>
  )
}
