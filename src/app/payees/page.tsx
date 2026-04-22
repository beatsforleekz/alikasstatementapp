'use client'
import { useEffect, useState } from 'react'
import { supabase } from '@/lib/supabase/client'
import { Alert, LoadingSpinner, EmptyState } from '@/components/ui'
import { Users, Plus, Mail, AlertTriangle, Search, RefreshCw, Edit, Trash2 } from 'lucide-react'
import Link from 'next/link'
import { contractTypeToDomain, isMasterContractType, isPublishingContractType, type Payee } from '@/lib/types'

type ContractLinkWithContract = {
  contract_id: string
  payee_id: string
  royalty_share: number
  is_active: boolean
  contract: {
    contract_type: string
    hold_payment_flag: boolean
    contract_name: string
    contract_code: string | null
  } | null
}
type PayeeWithLinks = Payee & { contract_links: ContractLinkWithContract[] }

function normalizePayeeName(value: string | null | undefined) {
  return (value ?? '').trim().replace(/\s+/g, ' ').toLowerCase()
}

export default function PayeesPage() {
  const [loading, setLoading] = useState(true)
  const [payees, setPayees] = useState<PayeeWithLinks[]>([])
  const [search, setSearch] = useState('')
  const [domainFilter, setDomainFilter] = useState('')
  const [activeFilter, setActiveFilter] = useState('active')
  const [error, setError] = useState<string | null>(null)
  const [deleteError, setDeleteError] = useState<string | null>(null)
  const [deletingId, setDeletingId] = useState<string | null>(null)
  const [showForm, setShowForm] = useState(false)
  const [editingPayee, setEditingPayee] = useState<Payee | null>(null)

  useEffect(() => { load() }, [])

  async function load() {
    setLoading(true)
    try {
      const { data, error } = await supabase
        .from('payees')
        .select('*, contract_links:contract_payee_links(contract_id, payee_id, royalty_share, is_active, contract:contracts(contract_type, hold_payment_flag, contract_name, contract_code))')
        .order('payee_name')
      if (error) throw error
      setPayees((data ?? []) as PayeeWithLinks[])
    } catch (e: any) {
      setError(e.message)
    } finally {
      setLoading(false)
    }
  }

  function openEdit(payee: Payee) {
    setEditingPayee(payee)
    setShowForm(true)
  }

  function openNew() {
    setEditingPayee(null)
    setShowForm(true)
  }

  async function deletePayee(payee: Payee) {
    const confirmed = window.confirm(`Delete payee "${payee.payee_name}"?\n\nThis is only allowed when the payee has no linked contracts or statements.`)
    if (!confirmed) return
    setDeletingId(payee.id)
    setDeleteError(null)
    const [linkRes, statementRes] = await Promise.all([
      supabase.from('contract_payee_links').select('payee_id', { count: 'exact', head: true }).eq('payee_id', payee.id),
      supabase.from('statement_records').select('payee_id', { count: 'exact', head: true }).eq('payee_id', payee.id),
    ])
    if ((linkRes.count ?? 0) > 0 || (statementRes.count ?? 0) > 0) {
      setDeleteError(`"${payee.payee_name}" cannot be deleted yet because it is still linked to contracts or statement records.`)
      setDeletingId(null)
      return
    }
    await supabase.from('payee_aliases').delete().eq('payee_id', payee.id)
    const { error: deleteErr } = await supabase.from('payees').delete().eq('id', payee.id)
    if (deleteErr) setDeleteError(deleteErr.message)
    else await load()
    setDeletingId(null)
  }

  const filtered = payees.filter(p => {
    if (activeFilter === 'active' && !p.active_status) return false
    if (activeFilter === 'inactive' && p.active_status) return false
    if (domainFilter === 'master' && !p.contract_links.some(l => l.is_active && isMasterContractType(l.contract?.contract_type))) return false
    if (domainFilter === 'publishing' && !p.contract_links.some(l => l.is_active && isPublishingContractType(l.contract?.contract_type))) return false
    if (search) {
      const q = search.toLowerCase()
      if (!p.payee_name.toLowerCase().includes(q) &&
        !(p.primary_email?.toLowerCase().includes(q)) &&
        !(p.vendor_reference?.toLowerCase().includes(q))) return false
    }
    return true
  })

  const missingEmail = filtered.filter(p => !p.primary_email && p.active_status)

  return (
    <div className="space-y-4">
      <div className="page-header">
        <div>
          <h1 className="page-title">Payees & Contracts</h1>
          <p className="page-subtitle">
            {filtered.length} payees
            {missingEmail.length > 0 && (
              <span className="text-red-400 ml-2">· {missingEmail.length} missing email</span>
            )}
          </p>
        </div>
        <button onClick={openNew} className="btn-primary">
          <Plus size={14} /> Add Payee
        </button>
      </div>

      {error && <Alert type="error">{error}</Alert>}
      {deleteError && <Alert type="warning">{deleteError}</Alert>}

      {/* Filters */}
      <div className="card p-3 flex items-center gap-2 flex-wrap">
        <div className="relative">
          <Search size={13} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-ops-muted" />
          <input
            className="ops-input pl-8 w-48"
            placeholder="Search payees…"
            value={search}
            onChange={e => setSearch(e.target.value)}
          />
        </div>
        <select className="ops-select w-36" value={domainFilter} onChange={e => setDomainFilter(e.target.value)}>
          <option value="">All domains</option>
          <option value="master">Master</option>
          <option value="publishing">Publishing</option>
        </select>
        <select className="ops-select w-32" value={activeFilter} onChange={e => setActiveFilter(e.target.value)}>
          <option value="active">Active</option>
          <option value="inactive">Inactive</option>
          <option value="">All</option>
        </select>
        <button onClick={load} className="btn-ghost btn-sm"><RefreshCw size={13} /></button>
      </div>

      {/* Missing email warning */}
      {missingEmail.length > 0 && (
        <Alert type="warning">
          <div className="flex items-center gap-2 font-semibold">
            <AlertTriangle size={13} />
            {missingEmail.length} active payee(s) have no email address:
          </div>
          <div className="flex flex-wrap gap-2 mt-1">
            {missingEmail.map(p => (
              <button
                key={p.id}
                onClick={() => openEdit(p)}
                className="text-xs underline hover:text-amber-300"
              >
                {p.payee_name}
              </button>
            ))}
          </div>
        </Alert>
      )}

      {/* Payees table */}
      <div className="card">
        {loading ? (
          <div className="flex items-center justify-center py-20"><LoadingSpinner size={22} /></div>
        ) : filtered.length === 0 ? (
          <EmptyState title="No payees found" icon={Users} description="Add payees to get started" />
        ) : (
          <div className="overflow-x-auto">
            <table className="ops-table">
              <thead>
                <tr>
                  <th>Payee</th>
                  <th>Email</th>
                  <th>Domains</th>
                  <th>Contracts</th>
                  <th>Currency</th>
                  <th>Ref</th>
                  <th>Status</th>
                  <th></th>
                </tr>
              </thead>
              <tbody>
                {filtered.map(p => {
                  const masterContracts    = p.contract_links.filter(l => l.is_active && isMasterContractType(l.contract?.contract_type))
                  const publishingContracts = p.contract_links.filter(l => l.is_active && isPublishingContractType(l.contract?.contract_type))
                  const hasHold            = p.contract_links.some(l => l.is_active && l.contract?.hold_payment_flag)

                  return (
                    <tr key={p.id} className="group">
                      <td>
                        <Link href={`/payees/${p.id}`} className="font-medium text-xs hover:text-blue-400">
                          {p.payee_name}
                        </Link>
                        {p.statement_name && p.statement_name !== p.payee_name && (
                          <div className="text-[10px] text-ops-muted">Stmt: {p.statement_name}</div>
                        )}
                        {p.primary_contact_name && (
                          <div className="text-[10px] text-ops-subtle">{p.primary_contact_name}</div>
                        )}
                      </td>
                      <td>
                        {p.primary_email ? (
                          <a href={`mailto:${p.primary_email}`} className="text-xs font-mono text-ops-muted hover:text-blue-400 flex items-center gap-1">
                            <Mail size={11} />{p.primary_email}
                          </a>
                        ) : (
                          <span className="text-xs text-red-400 flex items-center gap-1">
                            <AlertTriangle size={11} /> Missing
                          </span>
                        )}
                        {p.secondary_email && (
                          <div className="text-[10px] text-ops-subtle">{p.secondary_email}</div>
                        )}
                      </td>
                      <td>
                        <div className="flex gap-1 flex-wrap">
                          {masterContracts.length > 0 && <span className="badge-master">Master</span>}
                          {publishingContracts.length > 0 && <span className="badge-publishing">Publishing</span>}
                        </div>
                      </td>
                      <td className="text-xs">
                        <div className="text-ops-text">
                          {p.contract_links.filter(l => l.is_active).length} contract{p.contract_links.filter(l => l.is_active).length !== 1 ? 's' : ''}
                        </div>
                        {hasHold && <span className="badge-hold text-[10px]">Hold</span>}
                      </td>
                      <td className="text-xs font-mono text-ops-muted">{p.currency}</td>
                      <td className="text-xs font-mono text-ops-subtle">{p.vendor_reference}</td>
                      <td>
                        <span className={`badge ${p.active_status ? 'badge-approved' : 'badge-pending'}`}>
                          {p.active_status ? 'Active' : 'Inactive'}
                        </span>
                      </td>
                      <td>
                        {/* BUG FIX: Edit button now correctly opens the edit modal */}
                        <div className="flex gap-1 opacity-0 group-hover:opacity-100">
                          <Link href={`/payees/${p.id}`} className="btn-ghost btn-sm">View</Link>
                          <button
                            onClick={() => openEdit(p)}
                            className="btn-ghost btn-sm"
                            title="Edit payee"
                          >
                            <Edit size={12} />
                          </button>
                          <button
                            onClick={() => { void deletePayee(p) }}
                            className="btn-ghost btn-sm"
                            title="Delete payee"
                            disabled={deletingId === p.id}
                          >
                            {deletingId === p.id ? <LoadingSpinner size={12} /> : <Trash2 size={12} />}
                          </button>
                        </div>
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {showForm && (
        <PayeeFormModal
          payee={editingPayee}
          existingPayees={payees}
          onClose={() => { setShowForm(false); setEditingPayee(null) }}
          onSaved={() => { setShowForm(false); setEditingPayee(null); load() }}
        />
      )}
    </div>
  )
}

// ---- Payee form modal ----
function PayeeFormModal({
  payee, existingPayees, onClose, onSaved
}: {
  payee: Payee | null
  existingPayees: Array<Pick<Payee, 'id' | 'payee_name'>>
  onClose: () => void
  onSaved: () => void
}) {
  const isEdit = !!payee
  const [form, setForm] = useState({
    payee_name:           payee?.payee_name           ?? '',
    statement_name:       payee?.statement_name       ?? '',
    primary_contact_name: payee?.primary_contact_name ?? '',
    primary_email:        payee?.primary_email        ?? '',
    secondary_email:      payee?.secondary_email      ?? '',
    currency:             payee?.currency             ?? 'GBP',
    territory:            payee?.territory            ?? '',
    vendor_reference:     payee?.vendor_reference     ?? '',
    notes:                payee?.notes                ?? '',
    active_status:        payee?.active_status        ?? true,
  })
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [duplicatePayeeId, setDuplicatePayeeId] = useState<string | null>(null)

  function set(key: string, val: string | boolean) {
    setForm(prev => ({ ...prev, [key]: val }))
  }

  async function save() {
    if (!form.payee_name.trim()) { setError('Payee name is required.'); return }
    const normalizedName = normalizePayeeName(form.payee_name)
    const duplicate = existingPayees.find(existing =>
      normalizePayeeName(existing.payee_name) === normalizedName &&
      existing.id !== payee?.id
    )
    if (duplicate) {
      setDuplicatePayeeId(duplicate.id)
      setError(`A payee named "${duplicate.payee_name}" already exists. Open the existing payee instead of creating a duplicate.`)
      return
    }
    setSaving(true)
    setError(null)
    setDuplicatePayeeId(null)
    const payload = { ...form, updated_at: new Date().toISOString() }
    const { error } = isEdit
      ? await supabase.from('payees').update(payload).eq('id', payee!.id)
      : await supabase.from('payees').insert({ ...payload, created_at: new Date().toISOString() })
    if (error) { setError(error.message); setSaving(false); return }
    onSaved()
  }

  return (
    <div className="fixed inset-0 bg-black/70 z-50 flex items-center justify-center p-4">
      <div className="bg-ops-surface border border-ops-border rounded-xl w-full max-w-lg max-h-[90vh] overflow-y-auto">
        <div className="flex items-center justify-between p-4 border-b border-ops-border">
          <span className="font-semibold">{isEdit ? `Edit Payee — ${payee!.payee_name}` : 'New Payee'}</span>
          <button onClick={onClose} className="btn-ghost btn-sm">✕</button>
        </div>
        <div className="p-4 space-y-3">
          {error && <Alert type="error">{error}</Alert>}
          {duplicatePayeeId && (
            <div className="text-xs">
              <Link href={`/payees/${duplicatePayeeId}`} className="text-blue-400 hover:text-blue-300 underline">
                Open existing payee
              </Link>
            </div>
          )}
          <FormField label="Payee Name *">
            <input className="ops-input" value={form.payee_name} onChange={e => set('payee_name', e.target.value)} />
          </FormField>
          <FormField label="Statement Name (if different)">
            <input className="ops-input" value={form.statement_name} onChange={e => set('statement_name', e.target.value)} placeholder="Appears on statement outputs" />
          </FormField>
          <div className="grid grid-cols-2 gap-3">
            <FormField label="Contact Name">
              <input className="ops-input" value={form.primary_contact_name} onChange={e => set('primary_contact_name', e.target.value)} />
            </FormField>
            <FormField label="Vendor Ref">
              <input className="ops-input" value={form.vendor_reference} onChange={e => set('vendor_reference', e.target.value)} />
            </FormField>
          </div>
          <FormField label="Primary Email">
            <input className="ops-input" type="email" value={form.primary_email} onChange={e => set('primary_email', e.target.value)} />
          </FormField>
          <FormField label="Secondary Email">
            <input className="ops-input" type="email" value={form.secondary_email} onChange={e => set('secondary_email', e.target.value)} />
          </FormField>
          <div className="grid grid-cols-2 gap-3">
            <FormField label="Currency">
              <select className="ops-select" value={form.currency} onChange={e => set('currency', e.target.value)}>
                <option value="GBP">GBP</option>
                <option value="USD">USD</option>
                <option value="EUR">EUR</option>
                <option value="CAD">CAD</option>
                <option value="AUD">AUD</option>
              </select>
            </FormField>
            <FormField label="Territory">
              <input className="ops-input" value={form.territory} onChange={e => set('territory', e.target.value)} placeholder="e.g. UK, WW" />
            </FormField>
          </div>
          <FormField label="Notes">
            <textarea className="ops-textarea" value={form.notes} onChange={e => set('notes', e.target.value)} rows={2} />
          </FormField>
          <div className="flex items-center gap-2">
            <input type="checkbox" id="active" checked={form.active_status} onChange={e => set('active_status', e.target.checked)} className="rounded" />
            <label htmlFor="active" className="text-sm text-ops-text">Active</label>
          </div>
        </div>
        <div className="flex justify-end gap-2 p-4 border-t border-ops-border">
          <button onClick={onClose} className="btn-secondary">Cancel</button>
          <button onClick={save} disabled={saving} className="btn-primary">
            {saving ? 'Saving…' : isEdit ? 'Save Changes' : 'Create Payee'}
          </button>
        </div>
      </div>
    </div>
  )
}

function FormField({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="ops-field">
      <label className="ops-label">{label}</label>
      {children}
    </div>
  )
}
