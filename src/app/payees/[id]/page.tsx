'use client'
import { useEffect, useState } from 'react'
import { useParams, useRouter } from 'next/navigation'
import { supabase } from '@/lib/supabase/client'
import {
  Alert, LoadingSpinner, DomainBadge, StatCard, SectionHeader,
  ApprovalBadge, PayableBadge, Amount, EmptyState,
} from '@/components/ui'
import { validateBalanceChain, formatCurrency } from '@/lib/utils/balanceEngine'
import {
  ArrowLeft, AlertTriangle, CheckCircle,
  Edit2, Plus, Trash2, RefreshCw, ExternalLink,
} from 'lucide-react'
import { contractTypeToDomain, type Payee, type StatementPeriod } from '@/lib/types'
import { sortByLabel } from '@/lib/utils/sortOptions'

// ── Local types ───────────────────────────────────────────────────────────────

interface PayeeAlias {
  id: string
  payee_id: string
  alias_name: string
  is_active: boolean
  created_at: string
}

interface ContractLink {
  id: string
  contract_id: string
  payee_id: string
  royalty_share: number
  role: string | null
  statement_name: string | null
  is_active: boolean
  contract: {
    id: string
    contract_name: string
    contract_code: string | null
    contract_type: string
    status: string
    currency: string
  } | null
}

interface StatementRow {
  id: string
  contract_id: string
  statement_period_id: string
  domain: string
  royalty_share_snapshot: number
  opening_balance: number
  current_earnings: number
  deductions: number
  closing_balance_pre_carryover: number
  prior_period_carryover_applied: number
  final_balance_after_carryover: number
  payable_amount: number
  carry_forward_amount: number
  issued_amount: number
  is_payable: boolean
  is_recouping: boolean
  carryover_rule_applied: boolean
  hold_payment_flag: boolean
  balance_confirmed_flag: boolean
  carryover_confirmed_flag: boolean
  balance_model: string
  approval_status: string
  calculation_status: string
  output_generated_flag: boolean
  portal_visible_flag: boolean
  email_status: string
  statement_currency: string | null
  contract: { contract_name: string; contract_code: string | null } | null
  statement_period: { label: string } | null
}

// ── Small shared helpers ──────────────────────────────────────────────────────

function fmtDate(iso: string) {
  return new Date(iso).toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' })
}

// royalty_share is stored as decimal (0–1); display as percentage
function fmtShare(n: number) { return `${(n * 100).toFixed(2)}%` }

function FieldRow({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div className="flex items-start gap-3 py-1.5 border-b last:border-0" style={{ borderColor: 'var(--ops-border)' }}>
      <span style={{ color: 'var(--ops-muted)', fontSize: 13, width: 160, flexShrink: 0 }}>{label}</span>
      <span style={{ color: 'var(--ops-text)', fontSize: 13 }}>{value}</span>
    </div>
  )
}

function ContractStatusBadge({ status }: { status: string }) {
  const map: Record<string, string> = {
    active:     'badge-approved',
    expired:    'badge-pending',
    suspended:  'badge-warning',
    terminated: 'badge-rejected',
  }
  return (
    <span className={map[status] ?? 'badge-pending'} style={{ textTransform: 'capitalize' }}>
      {status}
    </span>
  )
}

// ── Styled modal primitives (used by payee edit form) ─────────────────────────

const fieldStyle: React.CSSProperties = {
  width: '100%',
  padding: '6px 10px',
  borderRadius: '6px',
  border: '1px solid var(--ops-border)',
  backgroundColor: 'var(--ops-input-bg, var(--ops-surface))',
  color: 'var(--ops-text)',
  fontSize: '13px',
  lineHeight: '1.5',
  outline: 'none',
}

function MLabel({ children, sub }: { children: React.ReactNode; sub?: boolean }) {
  return (
    <label style={{
      display: 'block',
      marginBottom: '4px',
      fontSize: sub ? '11px' : '12px',
      fontWeight: 500,
      color: sub ? 'var(--ops-muted)' : 'var(--ops-text)',
      letterSpacing: sub ? '0.02em' : undefined,
    }}>
      {children}
    </label>
  )
}

function MInput(props: React.InputHTMLAttributes<HTMLInputElement>) {
  return <input {...props} style={{ ...fieldStyle, ...props.style }} />
}

function MSelect(props: React.SelectHTMLAttributes<HTMLSelectElement>) {
  return <select {...props} style={{ ...fieldStyle, ...props.style }} />
}

function MTextarea(props: React.TextareaHTMLAttributes<HTMLTextAreaElement>) {
  return <textarea {...props} style={{ ...fieldStyle, ...props.style }} />
}

// ── Main page ─────────────────────────────────────────────────────────────────

export default function PayeeDetailPage() {
  const { id } = useParams<{ id: string }>()
  const router = useRouter()

  const [loading, setLoading]               = useState(true)
  const [payee, setPayee]                   = useState<Payee | null>(null)
  const [aliases, setAliases]               = useState<PayeeAlias[]>([])
  const [links, setLinks]                   = useState<ContractLink[]>([])
  const [statements, setStatements]         = useState<StatementRow[]>([])
  const [periods, setPeriods]               = useState<StatementPeriod[]>([])

  const [selectedPeriodId, setSelectedPeriodId] = useState('')
  const [domainFilter, setDomainFilter]         = useState<'' | 'master' | 'publishing'>('')

  const [editMode, setEditMode] = useState(false)
  const [editForm, setEditForm] = useState<Partial<Payee>>({})
  const [saving, setSaving]     = useState(false)

  const [newAlias, setNewAlias]       = useState('')
  const [addingAlias, setAddingAlias] = useState(false)

  const [error, setError]           = useState<string | null>(null)
  const [successMsg, setSuccessMsg] = useState<string | null>(null)

  useEffect(() => { if (id) loadAll() }, [id])
  useEffect(() => { if (id) loadStatements() }, [selectedPeriodId, domainFilter])

  async function loadAll() {
    setLoading(true)
    const [pRes, alRes, lkRes, pdRes] = await Promise.all([
      supabase.from('payees').select('*').eq('id', id).single(),
      supabase.from('payee_aliases').select('*').eq('payee_id', id).order('alias_name'),
      supabase
        .from('contract_payee_links')
        .select('*, contract:contracts(id,contract_name,contract_code,contract_type,status,currency)')
        .eq('payee_id', id)
        .order('is_active', { ascending: false }),
      supabase.from('statement_periods').select('*').order('year', { ascending: false }).order('half', { ascending: false }),
    ])

    if (!pRes.data) { setError('Payee not found.'); setLoading(false); return }
    setPayee(pRes.data)
    setEditForm(pRes.data)
    setAliases(alRes.data ?? [])
    setLinks(lkRes.data ?? [])
    setPeriods(sortByLabel(pdRes.data ?? [], period => period.label))

    const current = (pdRes.data ?? []).find((p: any) => p.is_current) ?? pdRes.data?.[0]
    if (current) setSelectedPeriodId(current.id)
    setLoading(false)
  }

  async function loadStatements() {
    if (!id) return
    let q = supabase
      .from('statement_records')
      .select('*, contract:contracts(contract_name,contract_code), statement_period:statement_periods(label)')
      .eq('payee_id', id)
      .order('statement_period_id', { ascending: false })
      .order('is_payable', { ascending: false })
      .limit(100)
    if (selectedPeriodId) q = q.eq('statement_period_id', selectedPeriodId)
    if (domainFilter)     q = q.eq('domain', domainFilter)
    const { data } = await q
    setStatements(data ?? [])
  }

  async function savePayee() {
    if (!payee) return
    setSaving(true)
    setError(null)
    const { error: err } = await supabase.from('payees').update({
      payee_name:           editForm.payee_name,
      statement_name:       editForm.statement_name || null,
      primary_contact_name: editForm.primary_contact_name || null,
      primary_email:        editForm.primary_email || null,
      secondary_email:      editForm.secondary_email || null,
      currency:             editForm.currency ?? 'GBP',
      territory:            editForm.territory || null,
      vendor_reference:     editForm.vendor_reference || null,
      active_status:        editForm.active_status ?? true,
      notes:                editForm.notes || null,
    }).eq('id', id)
    if (err) {
      setError(err.message)
    } else {
      const { data: fresh } = await supabase.from('payees').select('*').eq('id', id).single()
      if (fresh) setPayee(fresh)
      setEditMode(false)
      setSuccessMsg('Payee saved.')
      setTimeout(() => setSuccessMsg(null), 3000)
    }
    setSaving(false)
  }

  const addAlias = async () => {
    if (!newAlias.trim()) return
    setAddingAlias(true)
    const { data, error: err } = await supabase
      .from('payee_aliases')
      .insert({ payee_id: id, alias_name: newAlias.trim(), is_active: true })
      .select().single()
    if (err) setError(err.message)
    else { setAliases(a => [...a, data]); setNewAlias('') }
    setAddingAlias(false)
  }

  const toggleAlias = async (aliasId: string, current: boolean) => {
    await supabase.from('payee_aliases').update({ is_active: !current }).eq('id', aliasId)
    setAliases(a => a.map(x => x.id === aliasId ? { ...x, is_active: !current } : x))
  }

  const deleteAlias = async (aliasId: string) => {
    await supabase.from('payee_aliases').delete().eq('id', aliasId)
    setAliases(a => a.filter(x => x.id !== aliasId))
  }

  const activeContracts = links.filter(l => l.is_active)
  const totalPayable    = statements.filter(s => s.is_payable).reduce((n, s) => n + s.payable_amount, 0)
  const totalCarry      = statements.filter(s => !s.is_payable && s.carry_forward_amount > 0).reduce((n, s) => n + s.carry_forward_amount, 0)
  const chainIssues     = statements.filter(s => !validateBalanceChain(s as any).valid)

  const displayName = payee?.statement_name?.trim() || payee?.payee_name || ''

  if (loading) return (
    <div className="flex items-center gap-2 p-8" style={{ color: 'var(--ops-muted)' }}><LoadingSpinner /> Loading payee…</div>
  )

  if (!payee) return (
    <div className="p-8"><Alert type="error">{error ?? 'Payee not found.'}</Alert></div>
  )

  return (
    <div className="space-y-5">

      {/* Header */}
      <div className="page-header">
        <div className="flex items-center gap-3">
          <button onClick={() => router.push('/payees')} className="btn-ghost btn-sm flex items-center gap-1">
            <ArrowLeft size={13} /> Payees
          </button>
          <span style={{ color: 'var(--ops-subtle)' }}>/</span>
          <h1 className="page-title mb-0">{displayName}</h1>
          {displayName !== payee.payee_name && (
            <span style={{ fontSize: 12, color: 'var(--ops-muted)' }}>({payee.payee_name})</span>
          )}
          {!payee.active_status && <span className="badge-pending text-xs">Inactive</span>}
        </div>
        <div className="flex items-center gap-2">
          <button onClick={() => { setEditMode(v => !v); setEditForm(payee) }} className="btn-ghost btn-sm flex items-center gap-1">
            <Edit2 size={12} /> {editMode ? 'Cancel' : 'Edit'}
          </button>
          <button onClick={loadAll} className="btn-ghost btn-sm"><RefreshCw size={13} /></button>
        </div>
      </div>

      {error      && <Alert type="error">{error}</Alert>}
      {successMsg && <Alert type="success">{successMsg}</Alert>}

      {/* Edit form */}
      {editMode && (
        <div className="card" style={{ padding: 16 }}>
          <SectionHeader title="Edit Payee" />
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '12px' }}>
            <div>
              <MLabel>Payee Name *</MLabel>
              <MInput value={editForm.payee_name ?? ''}
                onChange={e => setEditForm(f => ({ ...f, payee_name: e.target.value }))} />
            </div>
            <div>
              <MLabel>Statement Name <span style={{ fontWeight: 400, color: 'var(--ops-muted)', fontSize: 11 }}>(printed on outputs — falls back to Payee Name)</span></MLabel>
              <MInput placeholder={editForm.payee_name ?? 'Defaults to Payee Name'}
                value={editForm.statement_name ?? ''}
                onChange={e => setEditForm(f => ({ ...f, statement_name: e.target.value }))} />
            </div>
            <div>
              <MLabel>Primary Contact</MLabel>
              <MInput value={editForm.primary_contact_name ?? ''}
                onChange={e => setEditForm(f => ({ ...f, primary_contact_name: e.target.value }))} />
            </div>
            <div>
              <MLabel>Primary Email</MLabel>
              <MInput type="email" value={editForm.primary_email ?? ''}
                onChange={e => setEditForm(f => ({ ...f, primary_email: e.target.value }))} />
            </div>
            <div>
              <MLabel>Secondary Email</MLabel>
              <MInput type="email" value={editForm.secondary_email ?? ''}
                onChange={e => setEditForm(f => ({ ...f, secondary_email: e.target.value }))} />
            </div>
            <div>
              <MLabel>Currency</MLabel>
              <MSelect value={editForm.currency ?? 'GBP'}
                onChange={e => setEditForm(f => ({ ...f, currency: e.target.value }))}>
                {['GBP','USD','EUR','AUD','CAD','JPY','CHF','SEK','NOK','DKK'].map(c => (
                  <option key={c} value={c}>{c}</option>
                ))}
              </MSelect>
            </div>
            <div>
              <MLabel>Territory</MLabel>
              <MInput value={editForm.territory ?? ''}
                onChange={e => setEditForm(f => ({ ...f, territory: e.target.value }))} />
            </div>
            <div>
              <MLabel>Vendor Reference</MLabel>
              <MInput value={editForm.vendor_reference ?? ''}
                onChange={e => setEditForm(f => ({ ...f, vendor_reference: e.target.value }))} />
            </div>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, paddingTop: 20 }}>
              <input type="checkbox" id="active_chk" checked={editForm.active_status ?? true}
                onChange={e => setEditForm(f => ({ ...f, active_status: e.target.checked }))}
                style={{ width: 15, height: 15, accentColor: 'var(--ops-accent, #3b82f6)' }} />
              <label htmlFor="active_chk" style={{ fontSize: 13, color: 'var(--ops-text)' }}>Active</label>
            </div>
            <div style={{ gridColumn: '1 / -1' }}>
              <MLabel>Notes</MLabel>
              <MTextarea rows={2} value={editForm.notes ?? ''}
                onChange={e => setEditForm(f => ({ ...f, notes: e.target.value }))} />
            </div>
          </div>
          <div style={{ display: 'flex', gap: 8, marginTop: 14 }}>
            <button className="btn-primary btn-sm" onClick={savePayee} disabled={saving || !editForm.payee_name}>
              {saving ? <LoadingSpinner size={13} /> : 'Save Changes'}
            </button>
            <button className="btn-ghost btn-sm" onClick={() => setEditMode(false)}>Cancel</button>
          </div>
        </div>
      )}

      {/* Info + stats */}
      <div className="grid grid-cols-2 gap-4">
        <div className="card" style={{ padding: 16 }}>
          <SectionHeader title="Payee Details" />
          <div>
            <FieldRow label="Statement Name"
              value={payee.statement_name?.trim()
                ? payee.statement_name
                : <span style={{ color: 'var(--ops-subtle)' }}>— (uses Payee Name: {payee.payee_name})</span>}
            />
            <FieldRow label="Contact" value={payee.primary_contact_name ?? <span style={{ color: 'var(--ops-subtle)' }}>—</span>} />
            <FieldRow
              label="Primary Email"
              value={payee.primary_email
                ? <a href={`mailto:${payee.primary_email}`} style={{ color: 'var(--accent-blue)' }}>{payee.primary_email}</a>
                : <span style={{ color: 'var(--accent-red)', display: 'flex', alignItems: 'center', gap: 4 }}><AlertTriangle size={12} /> Missing — cannot send statements</span>}
            />
            {payee.secondary_email && (
              <FieldRow label="Secondary Email"
                value={<a href={`mailto:${payee.secondary_email}`} style={{ color: 'var(--accent-blue)' }}>{payee.secondary_email}</a>} />
            )}
            <FieldRow label="Currency"    value={payee.currency} />
            <FieldRow label="Territory"   value={payee.territory ?? <span style={{ color: 'var(--ops-subtle)' }}>—</span>} />
            <FieldRow label="Vendor Ref"  value={payee.vendor_reference ?? <span style={{ color: 'var(--ops-subtle)' }}>—</span>} />
            <FieldRow label="Status"
              value={payee.active_status
                ? <span className="badge-approved">Active</span>
                : <span className="badge-pending">Inactive</span>} />
            {payee.notes && <FieldRow label="Notes" value={<span style={{ color: 'var(--ops-muted)' }}>{payee.notes}</span>} />}
          </div>
        </div>
        <div className="space-y-3">
          <div className="grid grid-cols-2 gap-3">
            <StatCard label="Active Contracts" value={activeContracts.length} />
            <StatCard label="Statements" value={statements.length}
              sub={selectedPeriodId ? (periods.find(p => p.id === selectedPeriodId)?.label ?? '') : 'all periods'} />
            {(() => {
              // Check if all payable statements share the same currency
              const payableStmts = statements.filter(s => s.is_payable)
              const ccySet = new Set(payableStmts.map(s => s.statement_currency ?? (s.domain === 'publishing' ? 'EUR' : 'GBP')))
              const singleCcy = ccySet.size === 1 ? Array.from(ccySet)[0] : null
              const carryStmts = statements.filter(s => !s.is_payable && s.carry_forward_amount > 0)
              const carryCcySet = new Set(carryStmts.map(s => s.statement_currency ?? (s.domain === 'publishing' ? 'EUR' : 'GBP')))
              const singleCarryCcy = carryCcySet.size === 1 ? Array.from(carryCcySet)[0] : null
              return (
                <>
                  <StatCard
                    label="Payable"
                    value={singleCcy ? formatCurrency(totalPayable, singleCcy) : `${totalPayable.toFixed(2)} (mixed ccy)`}
                    color="green"
                  />
                  <StatCard
                    label="Carry Forward"
                    value={singleCarryCcy ? formatCurrency(totalCarry, singleCarryCcy) : `${totalCarry.toFixed(2)} (mixed ccy)`}
                    color={totalCarry > 0 ? 'amber' : 'default'}
                  />
                </>
              )
            })()}
          </div>
          {chainIssues.length > 0 && (
            <Alert type="error">{chainIssues.length} balance chain issue{chainIssues.length !== 1 ? 's' : ''} detected.</Alert>
          )}
        </div>
      </div>

      {/* Aliases */}
      <div className="card" style={{ padding: 16 }}>
        <SectionHeader title="Writer Name Aliases" />
        <p style={{ fontSize: 12, color: 'var(--ops-muted)', marginBottom: 12 }}>
          Checked during publishing import matching when the source file name doesn't exactly match. Case-insensitive.
        </p>
        {aliases.length === 0 ? (
          <p style={{ fontSize: 13, color: 'var(--ops-muted)', marginBottom: 12 }}>No aliases defined.</p>
        ) : (
          <div style={{ marginBottom: 12 }}>
            {aliases.map(a => (
              <div key={a.id} style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '5px 0', borderBottom: '1px solid var(--ops-border)' }}>
                <span style={{
                  flex: 1, fontSize: 13, fontFamily: 'monospace',
                  color: a.is_active ? 'var(--ops-text)' : 'var(--ops-subtle)',
                  textDecoration: a.is_active ? 'none' : 'line-through',
                }}>
                  {a.alias_name}
                </span>
                <span style={{ fontSize: 11, color: 'var(--ops-subtle)' }}>{fmtDate(a.created_at)}</span>
                <button className="btn-ghost btn-sm" style={{ fontSize: 11 }} onClick={() => toggleAlias(a.id, a.is_active)}>
                  {a.is_active ? 'Disable' : 'Enable'}
                </button>
                <button className="btn-ghost btn-sm" style={{ fontSize: 11, color: 'var(--accent-red)' }} onClick={() => deleteAlias(a.id)}>
                  <Trash2 size={11} />
                </button>
              </div>
            ))}
          </div>
        )}
        <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
          <MInput
            style={{ flex: 1, fontSize: 13 }}
            placeholder='e.g. "S. Blackwood" or "Blackwood, Sarah"'
            value={newAlias}
            onChange={e => setNewAlias(e.target.value)}
            onKeyDown={e => { if (e.key === 'Enter') addAlias() }}
          />
          <button className="btn-secondary btn-sm" style={{ display: 'flex', alignItems: 'center', gap: 4 }}
            onClick={addAlias} disabled={addingAlias || !newAlias.trim()}>
            {addingAlias ? <LoadingSpinner size={12} /> : <><Plus size={12} /> Add</>}
          </button>
        </div>
      </div>

      {/* Contracts — read-only. Shares are managed on the Contracts page. */}
      <div className="card" style={{ padding: 16 }}>
        <SectionHeader
          title="Contracts"
          action={
            <button
              className="btn-ghost btn-sm"
              style={{ display: 'flex', alignItems: 'center', gap: 4 }}
              onClick={() => router.push('/contracts')}
            >
              <ExternalLink size={12} /> Manage on Contracts page
            </button>
          }
        />
        {links.length === 0 ? (
          <div style={{ padding: '24px 0', textAlign: 'center' }}>
            <p style={{ fontSize: 13, color: 'var(--ops-muted)', marginBottom: 12 }}>No contracts linked yet.</p>
            <button
              className="btn-ghost btn-sm"
              style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}
              onClick={() => router.push('/contracts')}
            >
              <ExternalLink size={12} /> Go to Contracts page to link
            </button>
          </div>
        ) : (
          <>
            <table className="ops-table">
              <thead>
                <tr>
                  <th>Contract</th>
                  <th>Code</th>
                  <th>Type</th>
                  <th>Role</th>
                  <th style={{ textAlign: 'right' }}>Share</th>
                  <th>Contract Status</th>
                  <th>Link</th>
                </tr>
              </thead>
              <tbody>
                {links.map(l => (
                  <tr key={l.id} style={{ opacity: l.is_active ? 1 : 0.45 }}>
                    <td style={{ fontSize: 13 }}>{l.contract?.contract_name ?? l.contract_id}</td>
                    <td style={{ fontFamily: 'monospace', fontSize: 12 }}>{l.contract?.contract_code ?? '—'}</td>
                    <td>{l.contract?.contract_type && contractTypeToDomain(l.contract.contract_type) && <DomainBadge domain={contractTypeToDomain(l.contract.contract_type)!} />}</td>
                    <td style={{ fontSize: 12, color: 'var(--ops-muted)', textTransform: 'capitalize' }}>{l.role ?? '—'}</td>
                    <td style={{ textAlign: 'right', fontFamily: 'monospace', fontSize: 13 }}>{fmtShare(l.royalty_share)}</td>
                    <td><ContractStatusBadge status={l.contract?.status ?? 'unknown'} /></td>
                    <td>
                      {l.is_active
                        ? <span className="badge-approved" style={{ fontSize: 11 }}>Linked</span>
                        : <span className="badge-pending" style={{ fontSize: 11 }}>Inactive link</span>}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            <p style={{ fontSize: 11, color: 'var(--ops-subtle)', marginTop: 8 }}>
              To edit shares or link/unlink payees, go to the Contracts page and expand the contract.
            </p>
          </>
        )}
      </div>

      {/* Statement history */}
      <div className="card" style={{ padding: 16 }}>
        <SectionHeader
          title="Statement History"
          action={
            <div style={{ display: 'flex', gap: 8 }}>
              <select style={{ ...fieldStyle, fontSize: 12, padding: '3px 8px', width: 'auto' }}
                value={selectedPeriodId} onChange={e => setSelectedPeriodId(e.target.value)}>
                <option value="">All periods</option>
                {periods.map(p => (
                  <option key={p.id} value={p.id}>{p.label}{(p as any).is_current ? ' ★' : ''}</option>
                ))}
              </select>
              <select style={{ ...fieldStyle, fontSize: 12, padding: '3px 8px', width: 'auto' }}
                value={domainFilter} onChange={e => setDomainFilter(e.target.value as any)}>
                <option value="">All domains</option>
                <option value="master">Master</option>
                <option value="publishing">Publishing</option>
              </select>
            </div>
          }
        />
        {statements.length === 0 ? (
          <p style={{ fontSize: 13, color: 'var(--ops-muted)', padding: '12px 0' }}>No statement records match the current filters.</p>
        ) : (
          <table className="ops-table">
            <thead>
              <tr>
                <th>Period</th><th>Contract</th><th>Domain</th>
                <th style={{ textAlign: 'right' }}>Earnings</th>
                <th style={{ textAlign: 'right' }}>Final Balance</th>
                <th>State</th><th>Approval</th><th>Output</th><th>Portal</th>
              </tr>
            </thead>
            <tbody>
              {statements.map(s => {
                const chainOk = validateBalanceChain(s as any).valid
                // Use the statement's locked currency; fall back to domain default if null
                const stmtCcy = s.statement_currency ?? (s.domain === 'publishing' ? 'EUR' : 'GBP')
                return (
                  <tr key={s.id}>
                    <td style={{ fontFamily: 'monospace', fontSize: 12 }}>{s.statement_period?.label ?? '—'}</td>
                    <td style={{ fontSize: 12 }}>{s.contract?.contract_code ?? s.contract?.contract_name ?? '—'}</td>
                    <td><DomainBadge domain={s.domain as any} /></td>
                    <td style={{ textAlign: 'right' }}><Amount value={s.current_earnings} currency={stmtCcy} size="small" /></td>
                    <td style={{ textAlign: 'right' }}>
                      <span style={{ display: 'flex', alignItems: 'center', justifyContent: 'flex-end', gap: 4 }}>
                        {!chainOk && <AlertTriangle size={11} style={{ color: 'var(--accent-red)' }} />}
                        <Amount value={s.final_balance_after_carryover} currency={stmtCcy} size="small" />
                      </span>
                    </td>
                    <td><PayableBadge record={s as any} /></td>
                    <td><ApprovalBadge status={s.approval_status} /></td>
                    <td>{s.output_generated_flag
                      ? <CheckCircle size={12} style={{ color: 'var(--accent-green)' }} />
                      : <span style={{ color: 'var(--ops-subtle)', fontSize: 12 }}>—</span>}
                    </td>
                    <td>{s.portal_visible_flag
                      ? <CheckCircle size={12} style={{ color: 'var(--accent-green)' }} />
                      : <span style={{ color: 'var(--ops-subtle)', fontSize: 12 }}>—</span>}
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        )}
      </div>

    </div>
  )
}
