'use client'

import { useMemo, useRef, useState } from 'react'
import { Alert, LoadingSpinner, getNoticePanelStyle } from '@/components/ui'
import { CheckCircle, FileUp, Plus, Table2, Trash2, X } from 'lucide-react'
import {
  SONY_PDF_COL_FIELDS,
  SONY_PDF_BUCKET_MAP,
  autoMapSonyPdf,
  parseImportAmount,
  type SonyPdfColKey,
} from '@/lib/utils/sonyPdfImport'
import { extractPdfTables, type ExtractedPdfTable } from '@/lib/utils/pdfTableExtractor'

interface EditablePdfRow {
  id: string
  included: boolean
  cells: string[]
}

interface ValidationIssue {
  key: string
  level: 'warning' | 'info'
  message: string
}

interface Props {
  onConfirm: (payload: {
    fileName: string
    headers: string[]
    rows: Record<string, string>[]
    mapping: Partial<Record<SonyPdfColKey, string>>
  }) => Promise<void> | void
}

function makeHeadersUnique(headers: string[]): string[] {
  const seen = new Map<string, number>()
  return headers.map((header, idx) => {
    const base = header.trim() || `Column ${idx + 1}`
    const count = seen.get(base) ?? 0
    seen.set(base, count + 1)
    return count === 0 ? base : `${base} (${count + 1})`
  })
}

function buildEditableRows(rows: string[][], width: number): EditablePdfRow[] {
  return rows.map((row, idx) => ({
    id: `row-${idx + 1}`,
    included: true,
    cells: Array.from({ length: width }, (_, colIdx) => row[colIdx] ?? ''),
  }))
}

export default function PdfStatementWorkbench({ onConfirm }: Props) {
  const fileRef = useRef<HTMLInputElement>(null)
  const [fileName, setFileName] = useState('')
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [tables, setTables] = useState<ExtractedPdfTable[]>([])
  const [selectedTableId, setSelectedTableId] = useState<string | null>(null)
  const [headers, setHeaders] = useState<string[]>([])
  const [rows, setRows] = useState<EditablePdfRow[]>([])
  const [mapping, setMapping] = useState<Partial<Record<SonyPdfColKey, string>>>({})
  const [confirming, setConfirming] = useState(false)

  const selectedTable = tables.find(table => table.id === selectedTableId) ?? null

  const includedRows = useMemo(() => rows.filter(row => row.included), [rows])

  const validation = useMemo(() => {
    const issues: ValidationIssue[] = []
    const invalidCells = new Set<string>()
    const titleHeader = mapping.title ?? null
    const titleIndex = titleHeader ? headers.indexOf(titleHeader) : -1
    if (!mapping.title) {
      issues.push({ key: 'missing-title', level: 'warning', message: 'Song Title is not mapped yet.' })
    }

    const mappedBuckets = Object.keys(SONY_PDF_BUCKET_MAP)
      .map(key => key as SonyPdfColKey)
      .filter(key => mapping[key])

    if (mappedBuckets.length === 0) {
      issues.push({ key: 'missing-buckets', level: 'warning', message: 'No income bucket columns are mapped yet.' })
    }

    const numericKeys = [...mappedBuckets, 'song_total'] as SonyPdfColKey[]
    for (const row of includedRows) {
      if (titleIndex >= 0 && !(row.cells[titleIndex] ?? '').trim()) {
        invalidCells.add(`${row.id}:${titleIndex}`)
      }

      let bucketSum = 0
      for (const key of numericKeys) {
        const header = mapping[key]
        if (!header) continue
        const idx = headers.indexOf(header)
        if (idx < 0) continue
        const raw = row.cells[idx] ?? ''
        if (!raw.trim()) continue
        const num = parseImportAmount(raw)
        if (num == null) {
          invalidCells.add(`${row.id}:${idx}`)
          issues.push({
            key: `${row.id}:${idx}`,
            level: 'warning',
            message: `Row ${rows.indexOf(row) + 1}: "${header}" is not a valid number.`,
          })
          continue
        }
        if (key !== 'song_total') bucketSum += num
      }

      if (mapping.song_total) {
        const totalIdx = headers.indexOf(mapping.song_total)
        const totalRaw = totalIdx >= 0 ? row.cells[totalIdx] ?? '' : ''
        const total = parseImportAmount(totalRaw)
        if (total != null && Math.abs(total - bucketSum) > 0.005) {
          invalidCells.add(`${row.id}:${totalIdx}`)
          issues.push({
            key: `${row.id}:song_total`,
            level: 'info',
            message: `Row ${rows.indexOf(row) + 1}: bucket sum ${bucketSum.toFixed(2)} does not match Song Total ${total.toFixed(2)}.`,
          })
        }
      }
    }

    return { issues, invalidCells }
  }, [headers, includedRows, mapping, rows])

  function selectTable(table: ExtractedPdfTable) {
    const width = Math.max(table.headers.length, ...table.rows.map(row => row.length), 1)
    const nextHeaders = makeHeadersUnique(Array.from({ length: width }, (_, idx) => table.headers[idx] ?? `Column ${idx + 1}`))
    setSelectedTableId(table.id)
    setHeaders(nextHeaders)
    setRows(buildEditableRows(table.rows, width))
    setMapping(autoMapSonyPdf(nextHeaders))
  }

  async function handleFile(file: File) {
    setLoading(true)
    setError(null)
    setFileName(file.name)
    try {
      const detectedTables = await extractPdfTables(file)
      setTables(detectedTables)
      if (detectedTables[0]) selectTable(detectedTables[0])
    } catch (err: any) {
      setError(err?.message ?? 'Failed to parse PDF. You can still build the table manually after retrying.')
    } finally {
      setLoading(false)
    }
  }

  function setCell(rowId: string, colIdx: number, value: string) {
    setRows(prev => prev.map(row => row.id === rowId ? {
      ...row,
      cells: row.cells.map((cell, idx) => idx === colIdx ? value : cell),
    } : row))
  }

  function setHeader(colIdx: number, value: string) {
    setHeaders(prev => prev.map((header, idx) => idx === colIdx ? value : header))
  }

  function addRow() {
    setRows(prev => [...prev, {
      id: `row-${Date.now()}`,
      included: true,
      cells: Array.from({ length: headers.length }, () => ''),
    }])
  }

  function removeRow(rowId: string) {
    setRows(prev => prev.filter(row => row.id !== rowId))
  }

  function addColumn() {
    setHeaders(prev => [...prev, `Column ${prev.length + 1}`])
    setRows(prev => prev.map(row => ({ ...row, cells: [...row.cells, ''] })))
  }

  function removeColumn(colIdx: number) {
    const removedHeader = headers[colIdx]
    setHeaders(prev => prev.filter((_, idx) => idx !== colIdx))
    setRows(prev => prev.map(row => ({
      ...row,
      cells: row.cells.filter((_, idx) => idx !== colIdx),
    })))
    setMapping(prev => {
      const next = { ...prev }
      for (const key of Object.keys(next) as SonyPdfColKey[]) {
        if (next[key] === removedHeader) delete next[key]
      }
      return next
    })
  }

  async function handleConfirm() {
    const uniqueHeaders = makeHeadersUnique(headers)
    const exportedRows = includedRows.map(row =>
      Object.fromEntries(uniqueHeaders.map((header, idx) => [header, row.cells[idx] ?? '']))
    )
    setConfirming(true)
    try {
      await onConfirm({
        fileName,
        headers: uniqueHeaders,
        rows: exportedRows,
        mapping,
      })
    } finally {
      setConfirming(false)
    }
  }

  return (
    <div className="space-y-4 rounded-xl border p-4" style={{ borderColor: 'var(--ops-border)', background: 'var(--ops-surface-2)' }}>
      <div className="flex items-start justify-between gap-3">
        <div>
          <div className="text-sm font-semibold text-ops-text">PDF Statement Review Tool</div>
          <p className="text-xs text-ops-muted mt-1">
            Upload a Sony statement PDF or image, review the extracted table, map columns, fix values, then send the confirmed rows into the existing import flow.
          </p>
        </div>
        <button className="btn-secondary btn-sm flex items-center gap-1.5" onClick={() => fileRef.current?.click()}>
          <FileUp size={13} />
          Upload PDF / Image
        </button>
        <input
          ref={fileRef}
          type="file"
          accept=".pdf,application/pdf,image/*"
          className="hidden"
          onChange={e => {
            const file = e.target.files?.[0]
            if (file) void handleFile(file)
          }}
        />
      </div>

      {error && <Alert type="error">{error}</Alert>}

      {!loading && selectedTable && selectedTable.confidence === 'manual' && (
        <Alert type="info">
          OCR text extraction is not available for this file on the current setup, so the tool opened a manual review table. You can still add/edit rows and columns before confirming the import.
        </Alert>
      )}

      {loading && (
        <div className="flex items-center gap-2 text-sm text-ops-muted">
          <LoadingSpinner size={13} />
          Parsing PDF and detecting tables…
        </div>
      )}

      {!loading && tables.length > 0 && (
        <>
          <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
            <div className="rounded-lg border p-3 space-y-2" style={{ borderColor: 'var(--ops-border)', background: 'var(--ops-surface)' }}>
              <div className="text-xs font-semibold text-ops-text">Detected Tables</div>
              <div className="space-y-2">
                {tables.map(table => (
                  <button
                    key={table.id}
                    className={`w-full rounded-lg border px-3 py-2 text-left text-xs ${selectedTableId === table.id ? 'ring-1 ring-cyan-500' : ''}`}
                    style={{ borderColor: 'var(--ops-border)', background: 'var(--ops-surface-2)' }}
                    onClick={() => selectTable(table)}
                  >
                    <div className="font-medium text-ops-text">{table.label}</div>
                    <div className="text-ops-muted mt-1">
                      {table.rows.length} row{table.rows.length !== 1 ? 's' : ''} · {table.confidence}
                    </div>
                  </button>
                ))}
              </div>
            </div>

            <div className="rounded-lg border p-3 md:col-span-2" style={{ borderColor: 'var(--ops-border)', background: 'var(--ops-surface)' }}>
              <div className="flex items-center justify-between gap-3">
                <div>
                  <div className="text-xs font-semibold text-ops-text">Review Summary</div>
                  <div className="text-xs text-ops-muted mt-1">
                    {fileName || 'No PDF selected'} · {includedRows.length} included row{includedRows.length !== 1 ? 's' : ''}
                  </div>
                </div>
                <div className="flex items-center gap-2">
                  <button className="btn-ghost btn-sm flex items-center gap-1" onClick={addColumn}>
                    <Plus size={12} /> Column
                  </button>
                  <button className="btn-ghost btn-sm flex items-center gap-1" onClick={addRow}>
                    <Plus size={12} /> Row
                  </button>
                </div>
              </div>

              <div className="mt-3 grid grid-cols-1 lg:grid-cols-2 gap-3">
                <div className="rounded-lg border p-3" style={{ borderColor: 'var(--ops-border)', background: 'var(--ops-surface-2)' }}>
                  <div className="text-xs font-semibold text-ops-text mb-2">Column Mapping</div>
                  <div className="space-y-2">
                    {SONY_PDF_COL_FIELDS.map(field => (
                      <div key={field.key} className="grid grid-cols-[150px,1fr] gap-2 items-center">
                        <label className="text-xs text-ops-text">{field.label}</label>
                        <select
                          className="input-field text-xs"
                          value={mapping[field.key] ?? ''}
                          onChange={e => setMapping(prev => ({
                            ...prev,
                            [field.key]: e.target.value || undefined,
                          }))}
                        >
                          <option value="">— not mapped —</option>
                          {headers.map(header => <option key={header} value={header}>{header}</option>)}
                        </select>
                      </div>
                    ))}
                  </div>
                </div>

                <div className="rounded-lg border p-3 space-y-2" style={{ borderColor: 'var(--ops-border)', background: 'var(--ops-surface-2)' }}>
                  <div className="text-xs font-semibold text-ops-text">Validation</div>
                  {validation.issues.length === 0 ? (
                    <div className="flex items-center gap-2 text-xs" style={getNoticePanelStyle('success')}>
                      <CheckCircle size={12} />
                      Review checks passed. You can still edit before confirming.
                    </div>
                  ) : (
                    <div className="space-y-2 max-h-48 overflow-y-auto">
                      {validation.issues.slice(0, 12).map(issue => (
                        <div
                          key={issue.key}
                          className="rounded-lg border px-3 py-2 text-xs"
                          style={getNoticePanelStyle(issue.level === 'warning' ? 'warning' : 'info')}
                        >
                          {issue.message}
                        </div>
                      ))}
                      {validation.issues.length > 12 && (
                        <div className="text-xs text-ops-muted">…and {validation.issues.length - 12} more</div>
                      )}
                    </div>
                  )}
                </div>
              </div>
            </div>
          </div>

          <div className="overflow-x-auto rounded-lg border" style={{ borderColor: 'var(--ops-border)' }}>
            <table className="ops-table text-xs">
              <thead>
                <tr>
                  <th>Use</th>
                  {headers.map((header, idx) => (
                    <th key={`header-${idx}`}>
                      <div className="flex items-center gap-1">
                        <input
                          className="input-field text-xs min-w-[120px]"
                          value={header}
                          onChange={e => setHeader(idx, e.target.value)}
                        />
                        <button className="btn-ghost btn-sm" onClick={() => removeColumn(idx)} title="Remove column">
                          <X size={12} />
                        </button>
                      </div>
                    </th>
                  ))}
                  <th />
                </tr>
              </thead>
              <tbody>
                {rows.map((row, rowIdx) => (
                  <tr key={row.id}>
                    <td>
                      <input
                        type="checkbox"
                        checked={row.included}
                        onChange={() => setRows(prev => prev.map(item => item.id === row.id ? { ...item, included: !item.included } : item))}
                      />
                    </td>
                    {headers.map((_, colIdx) => (
                      <td key={`${row.id}-${colIdx}`}>
                        <input
                          className="input-field text-xs min-w-[120px]"
                          value={row.cells[colIdx] ?? ''}
                          onChange={e => setCell(row.id, colIdx, e.target.value)}
                          style={validation.invalidCells.has(`${row.id}:${colIdx}`) ? {
                            borderColor: 'rgba(217,119,6,0.55)',
                            background: 'rgba(217,119,6,0.08)',
                          } : undefined}
                        />
                      </td>
                    ))}
                    <td>
                      <button className="btn-ghost btn-sm" onClick={() => removeRow(row.id)} title={`Remove row ${rowIdx + 1}`}>
                        <Trash2 size={12} />
                      </button>
                    </td>
                  </tr>
                ))}
                {rows.length === 0 && (
                  <tr>
                    <td colSpan={headers.length + 2}>
                      <div className="p-4 text-xs text-ops-muted flex items-center gap-2">
                        <Table2 size={13} />
                        No rows detected yet. Add rows manually or upload another PDF.
                      </div>
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>

          <div className="flex items-center justify-between gap-3">
            <div className="text-xs text-ops-muted">
              Skipped rows are excluded from the confirmed import payload. Missing required fields raise warnings but do not block confirmation.
            </div>
            <button
              className="btn-primary btn-sm flex items-center gap-1.5"
              disabled={confirming || headers.length === 0}
              onClick={() => void handleConfirm()}
            >
              {confirming ? <LoadingSpinner size={13} /> : <CheckCircle size={13} />}
              {confirming ? 'Sending to import…' : 'Confirm PDF Table'}
            </button>
          </div>
        </>
      )}
    </div>
  )
}
