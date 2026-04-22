'use client'
import { useEffect, useState } from 'react'
import { useParams, useSearchParams } from 'next/navigation'
import { supabase } from '@/lib/supabase/client'
import {
  DomainBadge, PayableBadge, ApprovalBadge, EmailStatusBadge, OutputBadge,
  Amount, Alert, LoadingSpinner, ConfirmGate, SeverityBadge
} from '@/components/ui'
import {
  checkReadyToIssue, validateBalanceChain, formatCurrency, calculateStatementRecord
} from '@/lib/utils/balanceEngine'
import {
  generateCSV, downloadCSV, downloadExcel, openPrintableHTML
} from '@/lib/utils/outputGenerator'
import {
  activeStatementBuckets,
  buildStatementPivot,
  getStatementCurrency,
  normalizeStatementBucket,
  STATEMENT_BUCKET_LABELS,
  STATEMENT_BUCKETS,
  type StatementIncomeBucket,
} from '@/lib/utils/statementPresentation'
import { LOGO_BASE64 } from '@/lib/constants/statementBrand'
import {
  ChevronLeft, Download, Printer, CheckCircle, XCircle, AlertTriangle,
  Plus, X, Pencil,
} from 'lucide-react'
import Link from 'next/link'
import type { Exception, ApprovalLog, StatementOutput, StatementLineSummary } from '@/lib/types'
import { sortStrings } from '@/lib/utils/sortOptions'

// ── ContractCost local type (mirrors migration_contract_costs.sql) ────────────

const COST_TYPES = [
  'advance', 'recording', 'marketing', 'distribution',
  'mechanical_licence', 'admin_fee', 'legal', 'other',
] as const

type CostAppliedStatus = 'pending' | 'applied' | 'waived' | 'disputed'

interface ContractCost {
  id: string
  contract_id: string
  statement_period_id: string | null
  cost_type: string
  description: string
  cost_date: string | null
  amount: number
  currency: string
  recoupable: boolean
  applied_status: CostAppliedStatus
  applied_at: string | null
  applied_by: string | null
  notes: string | null
  created_at: string
  updated_at: string
}

// ── Cost form state ───────────────────────────────────────────────────────────

interface CostFormState {
  cost_type: string
  description: string
  cost_date: string
  amount: string
  currency: string
  recoupable: boolean
  notes: string
}

const EMPTY_COST_FORM: CostFormState = {
  cost_type: 'other', description: '', cost_date: '',
  amount: '', currency: 'GBP', recoupable: true, notes: '',
}

// ── Costs & Recoupment panel ──────────────────────────────────────────────────

function ContractCostsPanel({
  contractId,
  statementPeriodId,
  currency,
  onCostsChange,
}: {
  contractId: string
  statementPeriodId: string | null
  currency: string
  onCostsChange: (costs: ContractCost[]) => void
}) {
  const [costs, setCosts]         = useState<ContractCost[]>([])
  const [loading, setLoading]     = useState(true)
  const [showForm, setShowForm]   = useState(false)
  const [editingId, setEditingId] = useState<string | null>(null)
  const [form, setForm]           = useState<CostFormState>(EMPTY_COST_FORM)
  const [saving, setSaving]       = useState(false)
  const [err, setErr]             = useState<string | null>(null)

  const fetchCosts = async () => {
    setLoading(true)
    // Fetch costs for this contract that either:
    //   (a) are scoped to this specific statement period, OR
    //   (b) have no period set (applies to all periods) AND are still pending/disputed
    // This prevents already-applied costs from other periods appearing.
    let q = supabase
      .from('contract_costs')
      .select('*')
      .eq('contract_id', contractId)
      .order('cost_date', { ascending: false })

    if (statementPeriodId) {
      // Show costs for this period + unscoped pending costs
      q = q.or(
        `statement_period_id.eq.${statementPeriodId},` +
        `and(statement_period_id.is.null,applied_status.in.(pending,disputed))`
      )
    }

    const { data } = await q
    const result = data ?? []
    setCosts(result)
    onCostsChange(result)
    setLoading(false)
  }

  useEffect(() => { fetchCosts() }, [contractId, statementPeriodId])

  const setF = (k: keyof CostFormState, v: string | boolean) =>
    setForm(f => ({ ...f, [k]: v }))

  const openNew = () => {
    setEditingId(null)
    setForm({ ...EMPTY_COST_FORM, currency, statement_period_id: statementPeriodId ?? '' } as any)
    setShowForm(true)
    setErr(null)
  }

  const openEdit = (c: ContractCost) => {
    setEditingId(c.id)
    setForm({
      cost_type:   c.cost_type,
      description: c.description,
      cost_date:   c.cost_date ?? '',
      amount:      String(c.amount),
      currency:    c.currency,
      recoupable:  c.recoupable,
      notes:       c.notes ?? '',
    })
    setShowForm(true)
    setErr(null)
  }

  const saveCost = async () => {
    if (!form.description.trim()) { setErr('Description required.'); return }
    const amt = parseFloat(form.amount)
    if (isNaN(amt) || amt <= 0) { setErr('Enter a valid positive amount.'); return }
    setSaving(true); setErr(null)

    const payload = {
      contract_id:         contractId,
      statement_period_id: statementPeriodId ?? null,
      cost_type:           form.cost_type || 'other',
      description:         form.description.trim(),
      cost_date:           form.cost_date || null,
      amount:              amt,
      currency:            form.currency || currency,
      recoupable:          form.recoupable,
      notes:               form.notes.trim() || null,
      updated_at:          new Date().toISOString(),
    }

    if (editingId) {
      const { error } = await supabase.from('contract_costs').update(payload).eq('id', editingId)
      if (error) { setErr(error.message); setSaving(false); return }
    } else {
      const { error } = await supabase.from('contract_costs').insert({
        ...payload,
        applied_status: 'pending',
        created_at: new Date().toISOString(),
      })
      if (error) { setErr(error.message); setSaving(false); return }
    }

    setSaving(false)
    setShowForm(false)
    setEditingId(null)
    fetchCosts()
  }

  const deleteCost = async (id: string) => {
    if (!confirm('Remove this cost? This cannot be undone.')) return
    await supabase.from('contract_costs').delete().eq('id', id)
    fetchCosts()
  }

  const markApplied = async (id: string) => {
    await supabase.from('contract_costs').update({
      applied_status: 'applied',
      applied_at: new Date().toISOString(),
      applied_by: 'User',
    }).eq('id', id)
    fetchCosts()
  }

  // Derived totals
  const totalCosts       = costs.reduce((s, c) => s + c.amount, 0)
  const recoupableCosts  = costs.filter(c => c.recoupable && c.applied_status !== 'waived')
  const totalRecoupable  = recoupableCosts.reduce((s, c) => s + c.amount, 0)

  const statusColor = (s: CostAppliedStatus) => ({
    pending:  'var(--accent-amber)',
    applied:  'var(--accent-green)',
    waived:   'var(--ops-subtle)',
    disputed: 'var(--accent-red)',
  }[s] ?? 'var(--ops-muted)')

  const iStyle: React.CSSProperties = {
    padding: '5px 8px', borderRadius: 6,
    border: '1px solid var(--ops-border)',
    background: 'var(--ops-surface)', color: 'var(--ops-text)', fontSize: 13,
  }

  return (
    <div className="card">
      <div className="card-header">
        <span className="text-sm font-semibold">Costs & Recoupment</span>
        <button className="btn-ghost btn-sm" onClick={openNew} style={{ display: 'flex', alignItems: 'center', gap: 4, fontSize: 12 }}>
          <Plus size={12} /> Add Cost
        </button>
      </div>

      {loading ? (
        <div className="p-4 flex justify-center"><LoadingSpinner size={16} /></div>
      ) : costs.length === 0 && !showForm ? (
        <div className="p-4 text-center">
          <p className="text-xs text-ops-muted">No costs recorded for this contract and period.</p>
          <button className="btn-ghost btn-sm mt-2" onClick={openNew} style={{ fontSize: 12 }}>
            <Plus size={12} /> Add first cost
          </button>
        </div>
      ) : (
        <div className="card-body space-y-2">

          {/* Cost rows */}
          {costs.map(c => (
            <div key={c.id} style={{
              display: 'grid', gridTemplateColumns: '1fr auto auto',
              gap: 8, alignItems: 'start', padding: '8px 0',
              borderBottom: '1px solid var(--ops-border)',
            }}>
              <div>
                <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 2 }}>
                  <span style={{ fontSize: 11, fontFamily: 'monospace', color: 'var(--ops-muted)', textTransform: 'uppercase' }}>
                    {c.cost_type.replace(/_/g, ' ')}
                  </span>
                  {c.recoupable ? (
                    <span style={{ fontSize: 10, padding: '1px 5px', borderRadius: 3, background: 'rgba(239,68,68,0.12)', color: 'var(--accent-red)', fontWeight: 600 }}>
                      RECOUPABLE
                    </span>
                  ) : (
                    <span style={{ fontSize: 10, padding: '1px 5px', borderRadius: 3, background: 'var(--ops-surface-2)', color: 'var(--ops-muted)' }}>
                      NON-RECOUPABLE
                    </span>
                  )}
                  <span style={{ fontSize: 10, color: statusColor(c.applied_status), fontWeight: 500 }}>
                    {c.applied_status}
                  </span>
                </div>
                <div style={{ fontSize: 13, color: 'var(--ops-text)', fontWeight: 500 }}>{c.description}</div>
                {c.cost_date && (
                  <div style={{ fontSize: 11, color: 'var(--ops-muted)' }}>
                    {new Date(c.cost_date).toLocaleDateString('en-GB')}
                  </div>
                )}
                {c.notes && (
                  <div style={{ fontSize: 11, color: 'var(--ops-subtle)', fontStyle: 'italic', marginTop: 2 }}>{c.notes}</div>
                )}
              </div>
              <div style={{ textAlign: 'right', fontFamily: 'monospace', fontSize: 13, fontWeight: 600, color: c.recoupable ? 'var(--accent-red)' : 'var(--ops-muted)', whiteSpace: 'nowrap' }}>
                {c.currency !== currency && <span style={{ fontSize: 10, color: 'var(--ops-subtle)', marginRight: 3 }}>{c.currency}</span>}
                {formatCurrency(c.amount, c.currency)}
              </div>
              <div style={{ display: 'flex', gap: 4 }}>
                <button onClick={() => openEdit(c)} style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'var(--ops-muted)', padding: 3 }} title="Edit">
                  <Pencil size={12} />
                </button>
                {c.applied_status === 'pending' && (
                  <button onClick={() => markApplied(c.id)} style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'var(--accent-green)', padding: 3 }} title="Mark applied">
                    <CheckCircle size={12} />
                  </button>
                )}
                <button onClick={() => deleteCost(c.id)} style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'var(--accent-red)', padding: 3 }} title="Remove">
                  <X size={12} />
                </button>
              </div>
            </div>
          ))}

          {/* Totals */}
          {costs.length > 0 && (
            <div style={{ paddingTop: 8, borderTop: '2px solid var(--ops-border)', display: 'flex', flexDirection: 'column', gap: 3, fontSize: 12, fontFamily: 'monospace' }}>
              <div style={{ display: 'flex', justifyContent: 'space-between' }}>
                <span style={{ color: 'var(--ops-muted)' }}>Total costs</span>
                <span style={{ color: 'var(--ops-text)' }}>{formatCurrency(totalCosts, currency)}</span>
              </div>
              <div style={{ display: 'flex', justifyContent: 'space-between' }}>
                <span style={{ color: 'var(--accent-red)' }}>Recoupable (reduces payable)</span>
                <span style={{ color: 'var(--accent-red)', fontWeight: 600 }}>{formatCurrency(totalRecoupable, currency)}</span>
              </div>
            </div>
          )}
        </div>
      )}

      {/* Add/edit cost form */}
      {showForm && (
        <div style={{ borderTop: '1px solid var(--ops-border)', padding: '12px 16px', background: 'var(--ops-surface-2)', display: 'flex', flexDirection: 'column', gap: 10 }}>
          <div style={{ fontSize: 12, fontWeight: 600, color: 'var(--ops-text)' }}>
            {editingId ? 'Edit Cost' : 'New Cost'}
          </div>
          {err && <div style={{ fontSize: 12, color: 'var(--accent-red)' }}>⚠ {err}</div>}

          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8 }}>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 3 }}>
              <label style={{ fontSize: 11, color: 'var(--ops-muted)' }}>Cost Type</label>
              <select style={iStyle} value={form.cost_type} onChange={e => setF('cost_type', e.target.value)}>
                {sortStrings([...COST_TYPES]).map(t => <option key={t} value={t}>{t.replace(/_/g, ' ')}</option>)}
              </select>
            </div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 3 }}>
              <label style={{ fontSize: 11, color: 'var(--ops-muted)' }}>Date</label>
              <input type="date" style={iStyle} value={form.cost_date} onChange={e => setF('cost_date', e.target.value)} />
            </div>
            <div style={{ gridColumn: '1/-1', display: 'flex', flexDirection: 'column', gap: 3 }}>
              <label style={{ fontSize: 11, color: 'var(--ops-muted)' }}>Description *</label>
              <input style={iStyle} value={form.description} onChange={e => setF('description', e.target.value)} placeholder="e.g. Recording advance — Album A" />
            </div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 3 }}>
              <label style={{ fontSize: 11, color: 'var(--ops-muted)' }}>Amount *</label>
              <input type="number" step="0.01" min="0.01" style={{ ...iStyle, fontFamily: 'monospace' }}
                value={form.amount} onChange={e => setF('amount', e.target.value)} placeholder="0.00" />
            </div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 3 }}>
              <label style={{ fontSize: 11, color: 'var(--ops-muted)' }}>Currency</label>
              <input style={{ ...iStyle, fontFamily: 'monospace' }} maxLength={3}
                value={form.currency} onChange={e => setF('currency', e.target.value.toUpperCase())} />
            </div>
            <div style={{ gridColumn: '1/-1', display: 'flex', flexDirection: 'column', gap: 3 }}>
              <label style={{ fontSize: 11, color: 'var(--ops-muted)' }}>Notes</label>
              <input style={iStyle} value={form.notes} onChange={e => setF('notes', e.target.value)} placeholder="Optional" />
            </div>
            <div style={{ gridColumn: '1/-1' }}>
              <label style={{ display: 'flex', alignItems: 'center', gap: 7, cursor: 'pointer', fontSize: 13, color: 'var(--ops-text)' }}>
                <input type="checkbox" checked={form.recoupable} onChange={e => setF('recoupable', e.target.checked)}
                  style={{ width: 14, height: 14, accentColor: '#ef4444', cursor: 'pointer' }} />
                Recoupable — deduct from payable amount
              </label>
              <p style={{ fontSize: 11, color: 'var(--ops-subtle)', marginTop: 3, marginLeft: 21 }}>
                Non-recoupable costs appear on the statement for transparency but do not reduce payable.
              </p>
            </div>
          </div>

          <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
            <button onClick={() => { setShowForm(false); setEditingId(null); setErr(null) }}
              style={{ padding: '5px 12px', borderRadius: 6, fontSize: 13, background: 'var(--ops-surface)', border: '1px solid var(--ops-border)', color: 'var(--ops-muted)', cursor: 'pointer' }}>
              Cancel
            </button>
            <button onClick={saveCost} disabled={saving}
              style={{ padding: '5px 12px', borderRadius: 6, fontSize: 13, background: '#2563eb', border: 'none', color: '#fff', cursor: 'pointer', opacity: saving ? 0.6 : 1 }}>
              {saving ? 'Saving…' : editingId ? 'Save Changes' : 'Add Cost'}
            </button>
          </div>
        </div>
      )}
    </div>
  )
}

// ── Income bucket helpers ─────────────────────────────────────────────────────

type IncomeBucket = StatementIncomeBucket
const BUCKET_COLS: IncomeBucket[] = STATEMENT_BUCKETS
const BUCKET_LABELS = STATEMENT_BUCKET_LABELS

interface PivotRow {
  title: string
  identifier: string | null
  buckets: Partial<Record<IncomeBucket, number>>
  total: number
}

function getLatestManualBalanceOverrideNote(overrideNotes: string | null | undefined): string | null {
  if (!overrideNotes) return null
  const notes = overrideNotes
    .split(' | ')
    .map(note => note.trim())
    .filter(Boolean)
  const manualNotes = notes.filter(note => note.startsWith('Manual balance edit:'))
  if (manualNotes.length > 0) return manualNotes[manualNotes.length - 1]
  return overrideNotes
}

function buildInternalPivotRows(
  lines: StatementLineSummary[],
  amountSelector: (line: StatementLineSummary) => number
): PivotRow[] {
  const map = new Map<string, PivotRow>()

  for (const line of lines) {
    const title = line.title ?? '(No Title)'
    const key = `${title}|||${line.identifier ?? ''}`

    if (!map.has(key)) {
      map.set(key, { title, identifier: line.identifier ?? null, buckets: {}, total: 0 })
    }

    const row = map.get(key)!
    const bucket = normalizeStatementBucket(line.income_type ?? line.line_category)
    const amount = amountSelector(line)

    row.buckets[bucket] = (row.buckets[bucket] ?? 0) + amount
    row.total += amount
  }

  return Array.from(map.values()).sort((a, b) => a.title.localeCompare(b.title))
}

function PivotedStatementTable({
  lines,
  currency,
}: {
  lines: StatementLineSummary[]
  currency: string
}) {
  const [showRaw, setShowRaw] = useState(false)
  const [internalViewMode, setInternalViewMode] = useState<'gross' | 'net'>('gross')
  const earningLines = lines.filter(line => line.line_category !== 'cost')
  const costLines = lines.filter(line => line.line_category === 'cost')
  const costTotal = costLines.reduce((sum, line) => sum + Math.abs(line.deduction_amount ?? line.net_amount ?? 0), 0)

  if (lines.length === 0) {
    return (
      <div className="card">
        <div className="card-header">
          <span className="text-sm font-semibold">Statement Lines</span>
        </div>
        <div className="p-6 text-center">
          <p className="text-xs text-ops-muted">No line summaries for this statement.</p>
          <p className="text-xs text-ops-subtle mt-1">
            Line detail is populated when statement records are generated from import rows,
            or can be added manually in Supabase.
          </p>
        </div>
      </div>
    )
  }

  const rows: PivotRow[] = buildStatementPivot(earningLines)
  const active = activeStatementBuckets(rows)
  const grandTotal = rows.reduce((s, r) => s + r.total, 0)
  const grossRows = buildInternalPivotRows(earningLines, line => line.gross_amount ?? 0)
  const grossActive = activeStatementBuckets(grossRows)
  const grossGrandTotal = grossRows.reduce((sum, row) => sum + row.total, 0)
  const internalRows = internalViewMode === 'gross' ? grossRows : rows
  const internalActive = internalViewMode === 'gross' ? grossActive : active
  const internalGrandTotal = internalViewMode === 'gross' ? grossGrandTotal : grandTotal

  const fmt = (v: number) =>
    v === 0 ? '—' : formatCurrency(v, currency)

  return (
    <>
      {/* Client-facing pivoted view */}
      <div className="card">
        <div className="card-header">
          <span className="text-sm font-semibold">Statement Lines</span>
          <span className="text-xs text-ops-muted">{rows.length} song{rows.length !== 1 ? 's' : ''}</span>
        </div>
        <div className="overflow-x-auto">
          <table className="ops-table">
            <thead>
              <tr>
                <th style={{ minWidth: 160 }}>Song Title</th>
                {active.map(b => (
                  <th key={b} className="text-right">{BUCKET_LABELS[b]}</th>
                ))}
                <th className="text-right">Song Total</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((row, i) => (
                <tr key={i}>
                  <td>
                    <div className="text-xs font-medium">{row.title}</div>
                    {row.identifier && (
                      <div className="font-mono text-[10px] text-ops-subtle mt-0.5">{row.identifier}</div>
                    )}
                  </td>
                  {active.map(b => (
                    <td key={b} className="text-right">
                      <span className={`font-mono text-xs tabular-nums ${
                        (row.buckets[b] ?? 0) !== 0 ? 'text-ops-text' : 'text-ops-subtle'
                      }`}>
                        {fmt(row.buckets[b] ?? 0)}
                      </span>
                    </td>
                  ))}
                  <td className="text-right">
                    <span className="font-mono text-xs tabular-nums font-semibold text-ops-text">
                      {formatCurrency(row.total, currency)}
                    </span>
                  </td>
                </tr>
              ))}
            </tbody>
            <tfoot>
              <tr style={{ borderTop: '2px solid var(--ops-border)' }}>
                <td className="text-xs font-semibold text-ops-muted py-2">Total</td>
                {active.map(b => (
                  <td key={b} className="text-right py-2">
                    <span className="font-mono text-xs tabular-nums font-semibold">
                      {fmt(rows.reduce((s, r) => s + (r.buckets[b] ?? 0), 0))}
                    </span>
                  </td>
                ))}
                <td className="text-right py-2">
                  <span className="font-mono text-xs tabular-nums font-bold text-ops-text">
                    {formatCurrency(grandTotal, currency)}
                  </span>
                </td>
              </tr>
            </tfoot>
          </table>
        </div>
      </div>

      <div className="card">
        <div className="card-header">
          <div>
            <span className="text-sm font-semibold">Internal View</span>
            <p className="text-xs text-ops-subtle mt-0.5">Gross shows pre-contract amounts only. Client outputs stay unchanged.</p>
          </div>
          <div style={{ display: 'flex', borderRadius: 6, overflow: 'hidden', border: '1px solid var(--ops-border)' }}>
            {([
              ['gross', 'Gross'],
              ['net', 'Net'],
            ] as const).map(([mode, label]) => (
              <button
                key={mode}
                onClick={() => setInternalViewMode(mode)}
                style={{
                  padding: '5px 10px',
                  fontSize: 12,
                  border: 'none',
                  cursor: 'pointer',
                  background: internalViewMode === mode ? '#2563eb' : 'var(--ops-surface)',
                  color: internalViewMode === mode ? '#fff' : 'var(--ops-muted)',
                }}
              >
                {label}
              </button>
            ))}
          </div>
        </div>
        <div className="overflow-x-auto">
          <table className="ops-table">
            <thead>
              <tr>
                <th style={{ minWidth: 160 }}>Song Title</th>
                {internalActive.map(bucket => (
                  <th key={bucket} className="text-right">{BUCKET_LABELS[bucket]}</th>
                ))}
                <th className="text-right">Song Total</th>
              </tr>
            </thead>
            <tbody>
              {internalRows.map((row, index) => (
                <tr key={`${internalViewMode}-${index}`}>
                  <td>
                    <div className="text-xs font-medium">{row.title}</div>
                    {row.identifier && (
                      <div className="font-mono text-[10px] text-ops-subtle mt-0.5">{row.identifier}</div>
                    )}
                  </td>
                  {internalActive.map(bucket => (
                    <td key={bucket} className="text-right">
                      <span className={`font-mono text-xs tabular-nums ${
                        (row.buckets[bucket] ?? 0) !== 0 ? 'text-ops-text' : 'text-ops-subtle'
                      }`}>
                        {fmt(row.buckets[bucket] ?? 0)}
                      </span>
                    </td>
                  ))}
                  <td className="text-right">
                    <span className="font-mono text-xs tabular-nums font-semibold text-ops-text">
                      {formatCurrency(row.total, currency)}
                    </span>
                  </td>
                </tr>
              ))}
            </tbody>
            <tfoot>
              <tr style={{ borderTop: '2px solid var(--ops-border)' }}>
                <td className="text-xs font-semibold text-ops-muted py-2">Total</td>
                {internalActive.map(bucket => (
                  <td key={bucket} className="text-right py-2">
                    <span className="font-mono text-xs tabular-nums font-semibold">
                      {fmt(internalRows.reduce((sum, row) => sum + (row.buckets[bucket] ?? 0), 0))}
                    </span>
                  </td>
                ))}
                <td className="text-right py-2">
                  <span className="font-mono text-xs tabular-nums font-bold text-ops-text">
                    {formatCurrency(internalGrandTotal, currency)}
                  </span>
                </td>
              </tr>
            </tfoot>
          </table>
        </div>
      </div>

      {costLines.length > 0 && (
        <div className="card">
          <div className="card-header">
            <span className="text-sm font-semibold">Contract Costs</span>
            <span className="text-xs text-ops-muted">{costLines.length} cost line{costLines.length !== 1 ? 's' : ''}</span>
          </div>
          <div className="overflow-x-auto">
            <table className="ops-table">
              <thead>
                <tr>
                  <th>Description</th>
                  <th>Date</th>
                  <th>Notes</th>
                  <th className="text-right">Amount</th>
                </tr>
              </thead>
              <tbody>
                {costLines.map(line => (
                  <tr key={line.id}>
                    <td className="text-xs font-medium">{line.title ?? 'Contract cost'}</td>
                    <td className="text-xs text-ops-muted">
                      {line.transaction_date ? new Date(line.transaction_date).toLocaleDateString('en-GB') : '—'}
                    </td>
                    <td className="text-xs text-ops-subtle">{line.notes ?? '—'}</td>
                    <td className="text-right">
                      <span className="font-mono text-xs tabular-nums font-semibold text-red-400">
                        {formatCurrency(Math.abs(line.deduction_amount ?? line.net_amount ?? 0), currency)}
                      </span>
                    </td>
                  </tr>
                ))}
              </tbody>
              <tfoot>
                <tr style={{ borderTop: '2px solid var(--ops-border)' }}>
                  <td colSpan={3} className="text-xs font-semibold text-right pr-3 py-2">Total Applied Costs</td>
                  <td className="text-right py-2">
                    <span className="font-mono text-xs tabular-nums font-bold text-red-400">
                      {formatCurrency(costTotal, currency)}
                    </span>
                  </td>
                </tr>
              </tfoot>
            </table>
          </div>
        </div>
      )}

      {/* Raw detail — collapsed by default, internal only */}
      <div className="card">
        <button
          className="card-header w-full text-left"
          onClick={() => setShowRaw(v => !v)}
          style={{ cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}
        >
          <span className="text-sm font-semibold text-ops-muted">Detailed breakdown (internal only)</span>
          <span className="text-xs text-ops-subtle">{showRaw ? '▲ hide' : '▼ show'} · {lines.length} rows</span>
        </button>
        {showRaw && (
          <div className="overflow-x-auto">
            <table className="ops-table">
              <thead>
                <tr>
                  <th>Bucket</th>
                  <th>Title</th>
                  <th>Identifier</th>
                  <th>Channel/Retailer</th>
                  <th>Territory</th>
                  <th className="text-right">Qty</th>
                  <th className="text-right">Gross Amount</th>
                  <th className="text-right">Net Amount</th>
                </tr>
              </thead>
              <tbody>
                {lines.map(l => (
                  <tr key={l.id}>
                    <td>
                      <span className="badge-pending text-[10px]">
                        {BUCKET_LABELS[normalizeStatementBucket(l.income_type ?? l.line_category)]}
                      </span>
                    </td>
                    <td className="text-xs">{l.title ?? '—'}</td>
                    <td className="font-mono text-xs text-ops-muted">{l.identifier ?? '—'}</td>
                    <td className="text-xs">{l.retailer_channel ?? '—'}</td>
                    <td className="text-xs">{l.territory ?? '—'}</td>
                    <td className="text-xs font-mono text-right">
                      {l.quantity != null ? l.quantity.toLocaleString('en-GB') : '—'}
                    </td>
                    <td><Amount value={l.gross_amount ?? 0} currency={currency} size="small" /></td>
                    <td><Amount value={l.net_amount ?? 0} currency={currency} size="small" /></td>
                  </tr>
                ))}
              </tbody>
              <tfoot>
                <tr className="border-t-2 border-ops-border">
                  <td colSpan={6} className="text-xs font-semibold text-right pr-3 py-2">Total</td>
                  <td>
                    <Amount value={lines.reduce((s, l) => s + (l.gross_amount ?? 0), 0)} currency={currency} size="small" />
                  </td>
                  <td>
                    <Amount value={lines.reduce((s, l) => s + (l.net_amount ?? 0), 0)} currency={currency} size="small" />
                  </td>
                </tr>
              </tfoot>
            </table>
          </div>
        )}
      </div>
    </>
  )
}

// ── Main page ─────────────────────────────────────────────────────────────────

export default function StatementDetailPage() {
  const params = useParams()
  const searchParams = useSearchParams()
  const id = params.id as string
  const returnTo = searchParams.get('returnTo') || '/statements'

  const [loading, setLoading]           = useState(true)
  const [record, setRecord]             = useState<any>(null)
  const [exceptions, setExceptions]     = useState<Exception[]>([])
  const [approvalLog, setApprovalLog]   = useState<ApprovalLog[]>([])
  const [outputs, setOutputs]           = useState<StatementOutput[]>([])
  const [lines, setLines]               = useState<StatementLineSummary[]>([])
  const [costs, setCosts]               = useState<ContractCost[]>([])
  const [error, setError]               = useState<string | null>(null)
  const [actionLoading, setActionLoading] = useState<string | null>(null)
  const [overrideNotes, setOverrideNotes] = useState('')
  const [approverName, setApproverName]   = useState('')
  // Currency edit state — only usable before approval
  const [editingCurrency, setEditingCurrency]   = useState(false)
  const [currencyInput, setCurrencyInput]       = useState('')
  const [fxRateInput, setFxRateInput]           = useState('')
  const [currencySaving, setCurrencySaving]     = useState(false)
  const [currencyError, setCurrencyError]       = useState<string | null>(null)
  const [editingManualBalances, setEditingManualBalances] = useState(false)
  const [manualOpeningBalance, setManualOpeningBalance] = useState('')
  const [manualCarryoverApplied, setManualCarryoverApplied] = useState('')
  const [manualBalanceError, setManualBalanceError] = useState<string | null>(null)

  useEffect(() => { if (id) load() }, [id])

  async function load() {
    try {
      setLoading(true)
      const [recRes, excRes, logRes, outRes, lineRes] = await Promise.all([
        supabase
          .from('statement_records')
          .select('*, payee:payees(*), contract:contracts(*), statement_period:statement_periods(*)')
          .eq('id', id)
          .single(),
        supabase
          .from('exceptions')
          .select('*')
          .eq('statement_record_id', id)
          .order('severity'),
        supabase
          .from('approval_log')
          .select('*')
          .eq('statement_record_id', id)
          .order('approved_at', { ascending: false }),
        supabase
          .from('statement_outputs')
          .select('*')
          .eq('statement_record_id', id)
          .order('generated_at', { ascending: false }),
        supabase
          .from('statement_line_summaries')
          .select('*')
          .eq('statement_record_id', id)
          .order('line_category'),
      ])
      if (recRes.error) throw recRes.error
      setRecord(recRes.data)
      setExceptions(excRes.data ?? [])
      setApprovalLog(logRes.data ?? [])
      setOutputs(outRes.data ?? [])
      setLines(lineRes.data ?? [])
    } catch (e: any) {
      setError(e.message)
    } finally {
      setLoading(false)
    }
  }

  async function confirmBalance() {
    if (!record) return
    if (record.manual_override_flag && !confirm('This record has a manual override. Confirm balance anyway?')) return
    setActionLoading('balance')
    const { error } = await supabase
      .from('statement_records')
      .update({ balance_confirmed_flag: true, updated_at: new Date().toISOString() })
      .eq('id', id)
    if (!error) await load()
    setActionLoading(null)
  }

  async function confirmCarryover() {
    if (!record) return
    setActionLoading('carryover')
    const { error } = await supabase
      .from('statement_records')
      .update({ carryover_confirmed_flag: true, updated_at: new Date().toISOString() })
      .eq('id', id)
    if (!error) await load()
    setActionLoading(null)
  }

  async function advanceApproval(stage: string) {
    if (!record || !approverName.trim()) {
      alert('Enter your name before advancing approval.')
      return
    }
    setActionLoading('approval')
    const updates: any = {
      review_status: stage === 'checked' ? 'reviewed' : record.review_status,
      approval_status: stage === 'approved' ? 'approved' : stage === 'rejected' ? 'rejected' : 'pending',
      updated_at: new Date().toISOString(),
    }
    if (stage === 'checked') { updates.checked_by = approverName; updates.checked_at = new Date().toISOString() }
    if (stage === 'approved') { updates.approved_by = approverName; updates.approved_at = new Date().toISOString() }

    const [updateRes] = await Promise.all([
      supabase.from('statement_records').update(updates).eq('id', id),
      supabase.from('approval_log').insert({
        statement_record_id: id,
        approval_stage: stage,
        previous_stage: record.approval_status,
        approved_by: approverName,
        approved_at: new Date().toISOString(),
        comments: overrideNotes || null,
      }),
    ])
    if (updateRes.error) alert(updateRes.error.message)
    await load()
    setActionLoading(null)
    setApproverName('')
    setOverrideNotes('')
  }

  async function recordOutputGenerated(outputType: 'excel' | 'csv' | 'html') {
    const existingOfType = outputs.filter(o => o.output_type === outputType)
    const nextVersion = existingOfType.length + 1
    const ext: Record<string, string> = { excel: 'xlsx', csv: 'csv', html: 'html' }
    const payeeName    = record?.payee?.payee_name?.replace(/[^a-zA-Z0-9]/g, '_') ?? 'stmt'
    const contractCode = (record?.contract?.contract_code ?? record?.contract?.contract_name?.replace(/[^a-zA-Z0-9]/g,'_') ?? 'NOCONTRACT')
    const period = record?.statement_period?.label ?? ''

    await Promise.all([
      supabase.from('statement_outputs').insert({
        statement_record_id: id,
        output_type: outputType,
        file_name: `${payeeName}_${contractCode}_${period}_v${nextVersion}.${ext[outputType]}`,
        version_number: nextVersion,
        output_status: 'generated',
        generated_by: approverName || 'User',
        generated_at: new Date().toISOString(),
      }),
      supabase.from('statement_records').update({
        output_generated_flag: true,
        output_status: 'generated',
        updated_at: new Date().toISOString(),
      }).eq('id', id),
    ])
    await load()
  }

  function handleDownloadCSV() {
    if (!record) return
    const data = buildOutputData()
    const csv = generateCSV(data)
    const csvContractCode = record.contract?.contract_code ?? record.contract?.contract_name?.replace(/[^a-zA-Z0-9]/g,'_') ?? 'NOCONTRACT'
    downloadCSV(csv, `${record.payee?.payee_name?.replace(/[^a-zA-Z0-9]/g,'_')}_${csvContractCode}_${record.statement_period?.label}.csv`)
    recordOutputGenerated('csv')
  }

  async function handleDownloadExcel() {
    if (!record) return
    const xlContractCode = record.contract?.contract_code ?? record.contract?.contract_name?.replace(/[^a-zA-Z0-9]/g,'_') ?? 'NOCONTRACT'
    await downloadExcel(buildOutputData(), `${record.payee?.payee_name?.replace(/[^a-zA-Z0-9]/g,'_')}_${xlContractCode}_${record.statement_period?.label}.xlsx`)
    recordOutputGenerated('excel')
  }

  function handlePrint() {
    if (!record) return
    try {
      const printWindow = openPrintableHTML(buildOutputData(), { autoPrint: true })
      if (!printWindow) {
        setError('Could not open the statement print view. Please allow pop-ups and try again.')
        return
      }
      setError(null)
    } catch (e: any) {
      setError(e?.message
        ? `Could not open the statement print view: ${e.message}`
        : 'Could not open the statement print view. Please try again.')
      return
    }
    recordOutputGenerated('html')
  }

  function buildOutputData() {
  return {
    record,
    payee_name:     record.payee?.payee_name ?? '',
    statement_name: record.payee?.statement_name ?? record.payee?.payee_name ?? '',
    contract_name:  record.contract?.contract_name ?? '',
    contract_code:  record.contract?.contract_code ?? null,
    period_label:   record.statement_period?.label ?? '',
    period_start:   record.statement_period?.period_start ?? '',
    period_end:     record.statement_period?.period_end ?? '',
    currency:       getStatementCurrency(record),
    lines,
  }
}

  async function markSent() {
    setActionLoading('sent')
    await supabase.from('statement_records').update({
      email_status: 'sent',
      sent_date: new Date().toISOString().split('T')[0],
      updated_at: new Date().toISOString(),
    }).eq('id', id)
    await load()
    setActionLoading(null)
  }

  // Task 6: update statement currency before approval
  // Only allowed when approval_status !== 'approved'
  async function updateCurrency() {
    const newCcy = currencyInput.trim().toUpperCase()
    if (!newCcy || newCcy.length < 2 || newCcy.length > 3) {
      setCurrencyError('Enter a valid 2–3 letter currency code.')
      return
    }
    const prevCcy = record.statement_currency ?? record.payee?.currency ?? 'GBP'
    const fxRate  = fxRateInput.trim() ? parseFloat(fxRateInput.trim()) : null
    if (fxRateInput.trim() && (isNaN(fxRate!) || fxRate! <= 0)) {
      setCurrencyError('FX rate must be a positive number.')
      return
    }
    setCurrencySaving(true); setCurrencyError(null)
    const { error: err } = await supabase.from('statement_records').update({
      statement_currency:    newCcy,
      exchange_rate_snapshot: fxRate,
      // Record the override in override_notes for auditability
      override_notes: [
        record.override_notes,
        `Currency changed ${prevCcy} \u2192 ${newCcy} at approval stage${fxRate ? ` (FX @ ${fxRate})` : ''}`,
      ].filter(Boolean).join(' | '),
      updated_at: new Date().toISOString(),
    }).eq('id', id)
    if (err) { setCurrencyError(err.message); setCurrencySaving(false); return }
    setCurrencySaving(false)
    setEditingCurrency(false)
    setCurrencyInput('')
    setFxRateInput('')
    await load()
  }

  function openManualBalanceEditor() {
    setManualOpeningBalance(String(record?.opening_balance ?? 0))
    setManualCarryoverApplied(String(record?.prior_period_carryover_applied ?? 0))
    setManualBalanceError(null)
    setEditingManualBalances(true)
  }

  async function saveManualBalances() {
    const parsedOpening = parseFloat(manualOpeningBalance.trim())
    const parsedCarryover = parseFloat(manualCarryoverApplied.trim())

    if (Number.isNaN(parsedOpening) || Number.isNaN(parsedCarryover)) {
      setManualBalanceError('Enter valid numeric values for opening balance and carry-over.')
      return
    }

    const calc = calculateStatementRecord(
      parsedOpening,
      Number(record.current_earnings ?? 0),
      Number(record.deductions ?? 0),
      parsedCarryover,
      contract ?? null,
      record.hold_payment_flag
    )
    const priorOverrideNotes = (record.override_notes ?? '')
      .split(' | ')
      .map((note: string) => note.trim())
      .filter((note: string) => note && !note.startsWith('Manual balance edit:'))
    const manualBalanceNote = `Manual balance edit: opening ${parsedOpening.toFixed(2)}, prior carry-over ${parsedCarryover.toFixed(2)}`

    setActionLoading('manual-balances')
    setManualBalanceError(null)

    const summaryParts = [
      `Current period income ${formatCurrency(Number(record.current_earnings ?? 0), currency)}`,
      `Opening balance brought forward ${formatCurrency(parsedOpening, currency)}`,
      `Prior carry-over applied ${formatCurrency(parsedCarryover, currency)}`,
      calc.carry_forward_amount > 0
        ? `Carry-over to next statement ${formatCurrency(calc.carry_forward_amount, currency)}`
        : `Carry-over to next statement ${formatCurrency(0, currency)}`,
    ]

    const { error: err } = await supabase
      .from('statement_records')
      .update({
        opening_balance: calc.opening_balance,
        closing_balance_pre_carryover: calc.closing_balance_pre_carryover,
        prior_period_carryover_applied: calc.prior_period_carryover_applied,
        final_balance_after_carryover: calc.final_balance_after_carryover,
        payable_amount: calc.payable_amount,
        carry_forward_amount: calc.carry_forward_amount,
        is_payable: calc.is_payable,
        is_recouping: calc.is_recouping,
        carryover_rule_applied: true,
        manual_override_flag: true,
        balance_confirmed_flag: false,
        carryover_confirmed_flag: false,
        balance_source_summary: summaryParts.join(' · '),
        override_notes: [...priorOverrideNotes, manualBalanceNote].join(' | '),
        updated_at: new Date().toISOString(),
      })
      .eq('id', id)

    setActionLoading(null)
    if (err) {
      setManualBalanceError(err.message)
      return
    }

    setEditingManualBalances(false)
    await load()
  }

  if (loading) return <div className="flex items-center justify-center h-64"><LoadingSpinner size={24} /></div>
  if (error)   return <Alert type="error">{error}</Alert>
  if (!record) return <Alert type="error">Statement not found.</Alert>

  const payee    = record.payee
  const period   = record.statement_period
  const contract = record.contract

  // FIX: use statement_currency locked at generation time, fall back to payee currency
  const currency = getStatementCurrency(record)

  const criticalExceptions = exceptions.filter(e => e.severity === 'critical' && e.resolution_status === 'open')
  const latestOverrideNote = getLatestManualBalanceOverrideNote(record.override_notes)
  const readyCheck = checkReadyToIssue(
    record,
    payee ?? { primary_email: null, active_status: false },
    criticalExceptions.length
  )
  const chainCheck = validateBalanceChain(record)

  // Costs derived totals for balance summary
  const recoupableCosts = costs.filter(c => c.recoupable && c.applied_status !== 'waived')
  const totalRecoupable = recoupableCosts.reduce((s, c) => s + c.amount, 0)

  return (
    <div className="space-y-5">
      {/* Header */}
      <div className="flex items-center gap-3">
        <Link href={returnTo} className="btn-ghost btn-sm"><ChevronLeft size={14} /></Link>
        <div className="flex-1 flex items-start gap-3">
          <img
            src={LOGO_BASE64}
            alt="MMS logo"
            style={{ height: 60, width: 'auto', objectFit: 'contain', flexShrink: 0 }}
          />
          <div className="flex items-center gap-2 flex-wrap">
            <div>
              <div className="flex items-center gap-2 flex-wrap">
                <h1 className="page-title">{payee?.payee_name}</h1>
                <DomainBadge domain={record.domain} />
                <PayableBadge record={record} />
                <ApprovalBadge status={record.approval_status} />
                {currency && (
                  <span style={{ fontSize: 11, fontFamily: 'monospace', padding: '2px 7px', borderRadius: 4, background: 'var(--ops-surface-2)', color: record.exchange_rate_snapshot ? 'var(--accent-cyan)' : 'var(--ops-muted)', border: '1px solid var(--ops-border)' }}>
                    {currency}
                    {record.exchange_rate_snapshot ? ` (FX @ ${record.exchange_rate_snapshot})` : ''}
                  </span>
                )}
              </div>
              <p className="page-subtitle font-mono">
                {period?.label}
                {payee?.primary_email
                  ? <> · {payee.primary_email}</>
                  : <> · <span className="text-red-400">No email address</span></>}
              </p>
            </div>
          </div>
        </div>
        <div className="flex gap-2">
          <button onClick={handlePrint} className="btn-secondary btn-sm"><Printer size={13} /> Print</button>
          <button onClick={handleDownloadCSV} className="btn-secondary btn-sm"><Download size={13} /> CSV</button>
          <button onClick={handleDownloadExcel} className="btn-secondary btn-sm"><Download size={13} /> Excel</button>
        </div>
      </div>

      {/* Balance chain warning */}
      {!chainCheck.valid && (
        <Alert type="error">
          <div className="font-semibold mb-1">⚠ Balance chain inconsistency detected</div>
          {chainCheck.issues.map((issue, i) => <div key={i} className="text-xs">• {issue}</div>)}
        </Alert>
      )}

      {/* Manual override warning */}
      {record.manual_override_flag && (
        <Alert type="warning">
          <div className="font-semibold">Manual override active</div>
          {latestOverrideNote && <div className="text-xs mt-1">{latestOverrideNote}</div>}
          {record.override_by && (
            <div className="text-xs text-ops-muted mt-0.5">
              By {record.override_by}{record.override_at ? ` · ${new Date(record.override_at).toLocaleDateString('en-GB')}` : ''}
            </div>
          )}
        </Alert>
      )}

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">

        {/* Left column: Balance + costs + lines + exceptions */}
        <div className="lg:col-span-2 space-y-4">

          {/* Balance summary */}
          <div className="card">
            <div className="card-header">
              <span className="text-sm font-semibold">Balance Summary</span>
              <span className="text-xs font-mono text-ops-muted">{currency}</span>
            </div>
            <div className="card-body space-y-1">
              <BalanceLine label="Opening Balance B/F" value={record.opening_balance} currency={currency} />
              <BalanceLine label="Current Period Income" value={record.current_earnings} currency={currency} />
              <BalanceLine label="Deductions" value={-record.deductions} currency={currency} />

              <div className="border-t border-ops-border pt-1 mt-1">
                <BalanceLine label="Closing Balance (pre-carryover)" value={record.closing_balance_pre_carryover} currency={currency} bold />
              </div>
              {record.prior_period_carryover_applied !== 0 && (
                <BalanceLine label="Prior Period Carryover Applied" value={record.prior_period_carryover_applied} currency={currency} />
              )}
              <div className="border-t border-ops-border pt-1 mt-1">
                <BalanceLine label="Final Balance" value={record.final_balance_after_carryover} currency={currency} bold />
              </div>

              {/* Payable / recouping / carry-forward result box */}
              <div
                className="mt-4 rounded-lg border p-4 flex items-center justify-between"
                style={{
                  borderColor: record.is_payable ? '#22c55e' : record.is_recouping ? '#ef4444' : '#f59e0b',
                  background:  record.is_payable ? 'rgba(34,197,94,0.05)' : record.is_recouping ? 'rgba(239,68,68,0.05)' : 'rgba(245,158,11,0.05)',
                }}
              >
                <div>
                  <div className="text-xs font-bold uppercase tracking-wider text-ops-muted">
                    {record.is_payable ? 'Payable This Period'
                      : record.is_recouping ? 'Recouping'
                      : 'Carried Forward'}
                  </div>
                  {record.carryover_rule_applied && (
                    <div className="text-xs text-ops-muted mt-0.5">Threshold rule applied</div>
                  )}
                  {record.hold_payment_flag && (
                    <div className="text-xs text-amber-400 mt-0.5">Payment hold active</div>
                  )}
                  {totalRecoupable > 0 && (
                    <div className="text-xs mt-0.5" style={{ color: 'var(--ops-muted)' }}>
                      {formatCurrency(totalRecoupable, currency)} recoupable costs recorded separately
                    </div>
                  )}
                </div>
                <div
                  className="text-2xl font-bold font-mono"
                  style={{ color: record.is_payable ? '#22c55e' : record.is_recouping ? '#ef4444' : '#f59e0b' }}
                >
                  {formatCurrency(
                    record.is_payable ? record.payable_amount
                      : record.is_recouping ? record.final_balance_after_carryover
                      : record.carry_forward_amount,
                    currency
                  )}
                </div>
              </div>

              {record.issued_amount > 0 && (
                <div className="flex justify-between text-sm pt-2 border-t border-ops-border mt-2">
                  <span className="text-ops-muted">Issued Amount</span>
                  <Amount value={record.issued_amount} currency={currency} />
                </div>
              )}

              {record.balance_source_summary && (
                <div className="text-xs text-ops-muted pt-2 border-t border-ops-border mt-2 leading-relaxed">
                  <span className="text-ops-subtle">Source: </span>{record.balance_source_summary}
                </div>
              )}
            </div>

            {/* Statement summary table — mirrors persisted statement record only */}
            {record.current_earnings > 0 && (
              <div style={{ borderTop: '1px solid var(--ops-border)', padding: '12px 16px', background: 'var(--ops-surface-2)' }}>
                <p style={{ fontSize: 11, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.06em', color: 'var(--ops-muted)', marginBottom: 8 }}>
                  Statement Summary
                </p>
                <div style={{ display: 'flex', flexDirection: 'column', gap: 3, fontSize: 12, fontFamily: 'monospace' }}>
                  {[
                    ['Total Income Received',           record.current_earnings,               'var(--ops-text)'],
                    ['Total Deductions',                -record.deductions,                    record.deductions > 0 ? 'var(--accent-red)' : 'var(--ops-muted)'],
                    ['Opening Balance B/F',             record.opening_balance,                'var(--ops-muted)'],
                    ['Prior Period Carryover',           record.prior_period_carryover_applied, 'var(--ops-muted)'],
                    ['Final Balance',                    record.final_balance_after_carryover,  'var(--ops-text)'],
                    ['Total Payable',                    record.payable_amount,                 record.is_payable ? 'var(--accent-green)' : 'var(--ops-muted)'],
                    ['Carry Forward To Next Statement',  record.carry_forward_amount,            record.carry_forward_amount > 0 ? 'var(--accent-amber)' : 'var(--ops-muted)'],
                  ].map(([label, value, color], i) => (
                    <div key={i} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '2px 0', borderTop: [3, 5].includes(i) ? '1px solid var(--ops-border)' : 'none', paddingTop: [3, 5].includes(i) ? 6 : 2 }}>
                      <span style={{ color: 'var(--ops-muted)', fontSize: 11 }}>{label as string}</span>
                      <span style={{ fontWeight: [5].includes(i) ? 700 : 400, color: color as string }}>
                        {formatCurrency(value as number, currency)}
                      </span>
                    </div>
                  ))}
                </div>
                {costs.length > 0 && (
                  <div style={{ marginTop: 10, paddingTop: 10, borderTop: '1px dashed var(--ops-border)', fontSize: 11, color: 'var(--ops-muted)' }}>
                    Recorded contract costs are folded into persisted statement totals when the statement is rerun, and recoupable costs also appear in the statement line output.
                  </div>
                )}
              </div>
            )}
          </div>

          {/* Client-facing pivoted statement */}
          <PivotedStatementTable lines={lines} currency={currency} />

          {/* Exceptions */}
          {exceptions.length > 0 && (
            <div className="card">
              <div className="card-header">
                <span className="text-sm font-semibold">Exceptions ({exceptions.length})</span>
                {criticalExceptions.length > 0 && (
                  <span className="badge-critical">{criticalExceptions.length} critical</span>
                )}
              </div>
              <div className="divide-y divide-ops-border">
                {exceptions.map(e => (
                  <ExceptionRow key={e.id} exception={e} onResolve={load} />
                ))}
              </div>
            </div>
          )}

          {/* Output history */}
          {outputs.length > 0 && (
            <div className="card">
              <div className="card-header">
                <span className="text-sm font-semibold">Output History</span>
              </div>
              <div className="overflow-x-auto">
                <table className="ops-table">
                  <thead>
                    <tr><th>Type</th><th>File</th><th>Version</th><th>Generated</th><th>By</th></tr>
                  </thead>
                  <tbody>
                    {outputs.map(o => (
                      <tr key={o.id}>
                        <td><span className="badge-pending text-[10px] uppercase">{o.output_type}</span></td>
                        <td className="font-mono text-xs text-ops-muted">{o.file_name}</td>
                        <td className="text-xs">v{o.version_number}</td>
                        <td className="text-xs text-ops-muted">{new Date(o.generated_at).toLocaleDateString('en-GB')}</td>
                        <td className="text-xs text-ops-muted">{o.generated_by}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          )}
        </div>

        {/* Right column */}
        <div className="space-y-4">

          {/* Payee + contract info */}
          <div className="card">
            <div className="card-header"><span className="text-sm font-semibold">Payee</span></div>
            <div className="card-body space-y-2 text-sm">
              <Link href={`/payees/${payee?.id}`} className="text-blue-400 hover:underline font-medium block">
                {payee?.payee_name}
              </Link>
              {payee?.primary_contact_name && (
                <div className="text-xs text-ops-muted">{payee.primary_contact_name}</div>
              )}
              {payee?.primary_email
                ? <div className="text-xs font-mono">{payee.primary_email}</div>
                : <div className="text-xs text-red-400">⚠ No email address</div>
              }
              <div className="text-xs text-ops-muted">{payee?.currency} · {payee?.territory}</div>
              {contract && (
                <div className="pt-2 border-t border-ops-border space-y-0.5">
                  <div className="text-xs text-ops-muted uppercase tracking-wider">Contract</div>
                  <div className="text-xs font-medium">{contract.contract_name}</div>
                  {contract.contract_code && (
                    <div className="text-xs text-ops-muted font-mono">{contract.contract_code}</div>
                  )}
                  {record.royalty_share_snapshot != null && (
                    <div className="text-xs text-ops-muted">
                      {(record.royalty_share_snapshot * 100).toFixed(2)}% royalty share (snapshot)
                    </div>
                  )}
                  {contract.minimum_payment_threshold_override != null && (
                    <div className="text-xs text-amber-400">
                      Threshold override: {formatCurrency(contract.minimum_payment_threshold_override, currency)}
                    </div>
                  )}
                  {contract.hold_payment_flag && (
                    <span className="badge-hold mt-1">Payment Hold</span>
                  )}
                </div>
              )}
            </div>
          </div>

          {/* ── Statement Currency (editable before approval) ───────────────── */}
          {record.approval_status !== 'approved' ? (
            <div className="card">
              <div className="card-header">
                <span className="text-sm font-semibold">Statement Currency</span>
                {!editingCurrency && (
                  <button
                    className="btn-ghost btn-sm"
                    style={{ fontSize: 11 }}
                    onClick={() => {
                      setCurrencyInput(currency)
                      setFxRateInput(record.exchange_rate_snapshot ? String(record.exchange_rate_snapshot) : '')
                      setEditingCurrency(true)
                      setCurrencyError(null)
                    }}
                  >
                    Edit
                  </button>
                )}
              </div>
              <div className="card-body space-y-2">
                <div style={{ fontFamily: 'monospace', fontSize: 13 }}>
                  <span style={{ color: 'var(--ops-muted)', fontSize: 11, marginRight: 4 }}>Current:</span>
                  <strong>{currency}</strong>
                  {record.exchange_rate_snapshot && (
                    <span style={{ color: 'var(--accent-cyan)', fontSize: 11, marginLeft: 6 }}>
                      FX @ {record.exchange_rate_snapshot}
                    </span>
                  )}
                </div>
                {record.override_notes?.includes('Currency changed') && (
                  <div style={{ fontSize: 11, color: 'var(--accent-amber)', padding: '4px 8px', borderRadius: 4, background: 'rgba(234,179,8,0.08)', border: '1px solid rgba(234,179,8,0.25)' }}>
                    Currency overridden at approval stage
                  </div>
                )}
                {editingCurrency && (
                  <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                    {currencyError && (
                      <div style={{ fontSize: 12, color: 'var(--accent-red)' }}>&#9888; {currencyError}</div>
                    )}
                    <div style={{ display: 'flex', gap: 4, flexWrap: 'wrap' }}>
                      {['GBP','EUR','USD','AUD','CAD','SEK','NOK','DKK','CHF','JPY'].map(ccy => (
                        <button key={ccy} onClick={() => setCurrencyInput(ccy)}
                          style={{
                            padding: '3px 8px', borderRadius: 4, fontSize: 12, fontFamily: 'monospace',
                            fontWeight: 600, cursor: 'pointer', border: '1px solid var(--ops-border)',
                            background: currencyInput === ccy ? '#2563eb' : 'var(--ops-surface)',
                            color: currencyInput === ccy ? '#fff' : 'var(--ops-muted)',
                          }}>
                          {ccy}
                        </button>
                      ))}
                    </div>
                    <input
                      style={{ padding: '5px 8px', borderRadius: 6, border: '1px solid var(--ops-border)', background: 'var(--ops-surface)', color: 'var(--ops-text)', fontSize: 13, fontFamily: 'monospace', width: 90 }}
                      placeholder="or type…"
                      maxLength={3}
                      value={currencyInput}
                      onChange={e => setCurrencyInput(e.target.value.toUpperCase())}
                    />
                    <div>
                      <label style={{ fontSize: 11, color: 'var(--ops-muted)' }}>
                        FX rate (optional — if conversion applies)
                      </label>
                      <input
                        type="number" step="0.0001" min="0"
                        style={{ padding: '5px 8px', borderRadius: 6, border: '1px solid var(--ops-border)', background: 'var(--ops-surface)', color: 'var(--ops-text)', fontSize: 13, fontFamily: 'monospace', width: '100%', marginTop: 3 }}
                        placeholder="e.g. 0.8612"
                        value={fxRateInput}
                        onChange={e => setFxRateInput(e.target.value)}
                      />
                      {!fxRateInput && currencyInput && currencyInput !== currency && (
                        <p style={{ fontSize: 11, color: 'var(--accent-amber)', marginTop: 3 }}>
                          Changing from {currency} to {currencyInput} &#8212; enter FX rate if amounts need converting.
                        </p>
                      )}
                    </div>
                    <div style={{ display: 'flex', gap: 6 }}>
                      <button
                        onClick={updateCurrency}
                        disabled={currencySaving || !currencyInput}
                        style={{
                          padding: '5px 12px', borderRadius: 6, fontSize: 13,
                          background: '#2563eb', color: '#fff', border: 'none',
                          cursor: currencySaving || !currencyInput ? 'not-allowed' : 'pointer',
                          opacity: currencySaving || !currencyInput ? 0.6 : 1,
                        }}
                      >
                        {currencySaving ? 'Saving\u2026' : 'Apply Currency Change'}
                      </button>
                      <button
                        onClick={() => { setEditingCurrency(false); setCurrencyError(null) }}
                        style={{ padding: '5px 10px', borderRadius: 6, fontSize: 13, background: 'var(--ops-surface)', color: 'var(--ops-muted)', border: '1px solid var(--ops-border)', cursor: 'pointer' }}
                      >
                        Cancel
                      </button>
                    </div>
                    <p style={{ fontSize: 11, color: 'var(--ops-subtle)' }}>
                      This change is recorded in the audit trail. Once approved, currency is read-only.
                    </p>
                  </div>
                )}
              </div>
            </div>
          ) : (
            <div className="card">
              <div className="card-header">
                <span className="text-sm font-semibold">Statement Currency</span>
                <span style={{ fontSize: 11, color: 'var(--ops-subtle)' }}>locked (approved)</span>
              </div>
              <div className="card-body">
                <div style={{ fontFamily: 'monospace', fontSize: 13 }}>
                  <strong>{currency}</strong>
                  {record.exchange_rate_snapshot && (
                    <span style={{ color: 'var(--accent-cyan)', fontSize: 11, marginLeft: 6 }}>
                      FX @ {record.exchange_rate_snapshot}
                    </span>
                  )}
                </div>
                {record.override_notes?.includes('Currency changed') && (
                  <div style={{ fontSize: 11, color: 'var(--accent-amber)', marginTop: 6, padding: '4px 8px', borderRadius: 4, background: 'rgba(234,179,8,0.08)', border: '1px solid rgba(234,179,8,0.25)' }}>
                    Currency overridden at approval stage
                  </div>
                )}
              </div>
            </div>
          )}

          <div className="card">
            <div className="card-header">
              <span className="text-sm font-semibold">Manual Opening / Carry-over</span>
              {!editingManualBalances && (
                <button className="btn-ghost btn-sm" style={{ fontSize: 11 }} onClick={openManualBalanceEditor}>
                  Edit
                </button>
              )}
            </div>
            <div className="card-body space-y-3">
              <div className="grid grid-cols-2 gap-3 text-sm">
                <div>
                  <div className="text-xs text-ops-muted mb-1">Current Period Income</div>
                  <Amount value={record.current_earnings} currency={currency} />
                </div>
                <div>
                  <div className="text-xs text-ops-muted mb-1">Carry-over To Next Statement</div>
                  <Amount value={record.carry_forward_amount} currency={currency} />
                </div>
              </div>
              {manualBalanceError && <Alert type="error">{manualBalanceError}</Alert>}
              {editingManualBalances ? (
                <div className="space-y-3">
                  <div className="grid grid-cols-2 gap-3">
                    <div>
                      <label className="ops-label">Opening Balance B/F</label>
                      <input
                        className="ops-input font-mono"
                        type="number"
                        step="0.01"
                        value={manualOpeningBalance}
                        onChange={e => setManualOpeningBalance(e.target.value)}
                      />
                    </div>
                    <div>
                      <label className="ops-label">Prior Carry-over Applied</label>
                      <input
                        className="ops-input font-mono"
                        type="number"
                        step="0.01"
                        value={manualCarryoverApplied}
                        onChange={e => setManualCarryoverApplied(e.target.value)}
                      />
                    </div>
                  </div>
                  <p className="text-xs text-ops-subtle">
                    Current-period income comes from imported statement lines. Opening balance and prior carry-over here are admin overrides.
                    The carry-forward to next statement is recalculated from the updated balance chain when you save.
                  </p>
                  <div className="flex gap-2">
                    <button
                      className="btn-primary btn-sm"
                      onClick={saveManualBalances}
                      disabled={actionLoading === 'manual-balances'}
                    >
                      {actionLoading === 'manual-balances' ? 'Saving…' : 'Save Balances'}
                    </button>
                    <button
                      className="btn-secondary btn-sm"
                      onClick={() => { setEditingManualBalances(false); setManualBalanceError(null) }}
                      disabled={actionLoading === 'manual-balances'}
                    >
                      Cancel
                    </button>
                  </div>
                </div>
              ) : (
                <p className="text-xs text-ops-subtle">
                  Use this only when an opening balance or brought-forward carry-over needs a manual admin correction.
                </p>
              )}
            </div>
          </div>

          {/* Costs & Recoupment management — CRUD panel */}
          {record.contract_id && (
            <ContractCostsPanel
              contractId={record.contract_id}
              statementPeriodId={record.statement_period_id ?? null}
              currency={currency}
              onCostsChange={setCosts}
            />
          )}

          {/* Confirmation gates */}
          <div className="card">
            <div className="card-header">
              <span className="text-sm font-semibold">Confirmation Gates</span>
            </div>
            <div className="card-body">
              <ConfirmGate
                label="Balance confirmed"
                confirmed={record.balance_confirmed_flag}
                onConfirm={confirmBalance}
                disabled={actionLoading === 'balance'}
              />
              <ConfirmGate
                label="Carryover confirmed"
                confirmed={record.carryover_confirmed_flag}
                onConfirm={confirmCarryover}
                disabled={actionLoading === 'carryover'}
              />
              {record.carryover_rule_applied && !record.carryover_confirmed_flag && (
                <p className="text-xs text-amber-400 mt-1">
                  Carryover rule was applied. Review the balance above before confirming.
                </p>
              )}
            </div>
          </div>

          {/* Approval workflow */}
          <div className="card">
            <div className="card-header"><span className="text-sm font-semibold">Approval</span></div>
            <div className="card-body space-y-3">
              <div className="space-y-2">
                <ApprovalStep stage="Prepared" done={true} by={null} at={null} />
                <ApprovalStep stage="Checked" done={record.review_status === 'reviewed'} by={record.checked_by} at={record.checked_at} />
                <ApprovalStep stage="Approved" done={record.approval_status === 'approved'} by={record.approved_by} at={record.approved_at} />
              </div>

              {record.approval_status !== 'approved' && (
                <div className="space-y-2 pt-2 border-t border-ops-border">
                  <input
                    className="ops-input"
                    placeholder="Your name (required)"
                    value={approverName}
                    onChange={e => setApproverName(e.target.value)}
                  />
                  <textarea
                    className="ops-textarea"
                    placeholder="Comments (optional)"
                    value={overrideNotes}
                    onChange={e => setOverrideNotes(e.target.value)}
                    rows={2}
                  />
                  <div className="flex gap-2">
                    {record.review_status !== 'reviewed' && (
                      <button
                        className="btn-secondary btn-sm flex-1"
                        onClick={() => advanceApproval('checked')}
                        disabled={actionLoading === 'approval' || !approverName.trim()}
                      >
                        Mark Checked
                      </button>
                    )}
                    {record.review_status === 'reviewed' && record.approval_status !== 'approved' && (
                      <button
                        className="btn-primary btn-sm flex-1"
                        onClick={() => advanceApproval('approved')}
                        disabled={
                          actionLoading === 'approval' ||
                          !approverName.trim() ||
                          !record.balance_confirmed_flag ||
                          !record.carryover_confirmed_flag
                        }
                      >
                        Approve
                      </button>
                    )}
                  </div>
                  {record.review_status === 'reviewed' && (!record.balance_confirmed_flag || !record.carryover_confirmed_flag) && (
                    <p className="text-xs text-amber-400">Both gates must be confirmed before approving.</p>
                  )}
                </div>
              )}
            </div>
          </div>

          {/* Output & send */}
          <div className="card">
            <div className="card-header"><span className="text-sm font-semibold">Output & Send</span></div>
            <div className="card-body space-y-2">
              <OutputBadge generated={record.output_generated_flag} />
              {record.approval_status !== 'approved' && !record.output_generated_flag && (
                <p className="text-xs text-ops-muted">Approve the statement before generating output.</p>
              )}
              <div className="flex gap-2">
                <button onClick={handleDownloadExcel} disabled={record.approval_status !== 'approved'} className="btn-secondary btn-sm flex-1">
                  <Download size={12} /> Excel
                </button>
                <button onClick={handleDownloadCSV} disabled={record.approval_status !== 'approved'} className="btn-secondary btn-sm flex-1">
                  <Download size={12} /> CSV
                </button>
                <button onClick={handlePrint} disabled={record.approval_status !== 'approved'} className="btn-secondary btn-sm flex-1">
                  <Printer size={12} /> Print
                </button>
              </div>
              <div className="border-t border-ops-border pt-2">
                <EmailStatusBadge status={record.email_status} />
                {record.sent_date && (
                  <div className="text-xs text-ops-muted mt-1">Sent: {new Date(record.sent_date).toLocaleDateString('en-GB')}</div>
                )}
                {record.email_status !== 'sent' && record.output_generated_flag && (
                  <button className="btn-success btn-sm w-full mt-2" onClick={markSent} disabled={actionLoading === 'sent'}>
                    <CheckCircle size={13} /> Mark as Sent
                  </button>
                )}
              </div>
            </div>
          </div>

          {/* Ready-to-issue checklist */}
          <div className="card">
            <div className="card-header">
              <span className="text-sm font-semibold">Ready to Issue</span>
              {readyCheck.ready
                ? <CheckCircle size={14} className="text-green-400" />
                : <XCircle size={14} className="text-red-400" />}
            </div>
            <div className="card-body space-y-1.5">
              {readyCheck.blockers.map((b, i) => (
                <div key={i} className="flex gap-1.5 text-xs text-red-400">
                  <XCircle size={12} className="shrink-0 mt-0.5" /><span>{b}</span>
                </div>
              ))}
              {readyCheck.warnings.map((w, i) => (
                <div key={i} className="flex gap-1.5 text-xs text-amber-400">
                  <AlertTriangle size={12} className="shrink-0 mt-0.5" /><span>{w}</span>
                </div>
              ))}
              {readyCheck.ready && (
                <div className="text-xs text-green-400 flex items-center gap-1.5">
                  <CheckCircle size={12} /> All checks passed
                </div>
              )}
            </div>
          </div>

          {/* Approval history */}
          {approvalLog.length > 0 && (
            <div className="card">
              <div className="card-header"><span className="text-sm font-semibold">Approval History</span></div>
              <div className="card-body space-y-3">
                {approvalLog.map(log => (
                  <div key={log.id} className="text-xs border-b border-ops-border/50 pb-2 last:border-0 last:pb-0">
                    <div className="flex justify-between items-start">
                      <span className="font-medium text-ops-text capitalize">{log.approval_stage}</span>
                      <span className="text-ops-muted">{new Date(log.approved_at).toLocaleDateString('en-GB')}</span>
                    </div>
                    <div className="text-ops-muted mt-0.5">by {log.approved_by}</div>
                    {log.comments && <div className="text-ops-subtle mt-0.5 italic">{log.comments}</div>}
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  )
}

// ── Sub-components ────────────────────────────────────────────────────────────

function BalanceLine({ label, value, currency, bold }: {
  label: string; value: number; currency: string; bold?: boolean
}) {
  return (
    <div className={`flex justify-between items-center ${bold ? 'py-1.5' : 'py-0.5'}`}>
      <span className={`text-sm ${bold ? 'font-semibold text-ops-text' : 'text-ops-muted'}`}>{label}</span>
      <span className={`font-mono text-sm tabular-nums ${bold ? 'font-bold' : ''} ${value > 0 ? 'text-green-400' : value < 0 ? 'text-red-400' : 'text-ops-muted'}`}>
        {formatCurrency(value, currency)}
      </span>
    </div>
  )
}

function ApprovalStep({ stage, done, by, at }: {
  stage: string; done: boolean; by: string | null; at: string | null
}) {
  return (
    <div className="flex items-center gap-2">
      <div className={`w-5 h-5 rounded-full border-2 flex items-center justify-center shrink-0 ${done ? 'border-green-500 bg-green-500/20' : 'border-ops-border'}`}>
        {done && <CheckCircle size={10} className="text-green-400" />}
      </div>
      <div className="flex-1 flex items-center gap-1.5">
        <span className={`text-xs font-medium ${done ? 'text-green-400' : 'text-ops-muted'}`}>{stage}</span>
        {done && by && <span className="text-[10px] text-ops-muted">by {by}</span>}
        {done && at && <span className="text-[10px] text-ops-subtle">{new Date(at).toLocaleDateString('en-GB')}</span>}
      </div>
    </div>
  )
}

function ExceptionRow({ exception: e, onResolve }: {
  exception: Exception; onResolve: () => void
}) {
  const [resolving, setResolving] = useState(false)

  async function resolve() {
    const notes = prompt('Resolution notes (required):')
    if (!notes?.trim()) return
    setResolving(true)
    await supabase.from('exceptions').update({
      resolution_status: 'resolved',
      resolution_notes: notes,
      resolved_by: 'User',
      resolved_at: new Date().toISOString(),
    }).eq('id', e.id)
    await onResolve()
    setResolving(false)
  }

  return (
    <div className="px-4 py-3 flex items-start gap-3">
      <SeverityBadge severity={e.severity} />
      <div className="flex-1 min-w-0">
        <div className="text-xs font-medium">{e.title}</div>
        {e.detail && <div className="text-xs text-ops-muted mt-0.5 leading-relaxed">{e.detail}</div>}
        {e.resolution_status === 'resolved' && (
          <div className="text-xs text-green-400 mt-0.5">✓ Resolved: {e.resolution_notes}</div>
        )}
      </div>
      {e.resolution_status === 'open' && (
        <button className="btn-ghost btn-sm shrink-0" onClick={resolve} disabled={resolving}>Resolve</button>
      )}
    </div>
  )
}
