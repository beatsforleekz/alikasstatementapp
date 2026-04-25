'use client'
import { useEffect, useState } from 'react'
import { supabase } from '@/lib/supabase/client'
import { Alert, LoadingSpinner, DomainBadge, Amount, EmptyState } from '@/components/ui'
import { Mail, CheckCircle, RefreshCw, Filter, AlertTriangle, Send, Copy, Trash2 } from 'lucide-react'
import Link from 'next/link'
import type { StatementPeriod } from '@/lib/types'
import { getStatementCurrency } from '@/lib/utils/statementPresentation'
import { sortByLabel } from '@/lib/utils/sortOptions'

function splitPayeeNames(name: string) {
  return name
    .split(/\s*(?:,|&|\/|\band\b)\s*/i)
    .map(part => part.trim())
    .filter(Boolean)
}

function getContractPayeeNames(record: any) {
  return (record.contract_payees ?? [])
    .map((link: any) => String(link?.payee?.payee_name ?? '').trim())
    .filter(Boolean)
}

function getGreetingFirstNames(record: any) {
  const contractPayeeNames = getContractPayeeNames(record)
  const names = (contractPayeeNames.length > 0 ? contractPayeeNames : splitPayeeNames(String(record.payee?.statement_name ?? record.payee?.payee_name ?? '').trim()))
    .map((name: string) => name.split(/\s+/).filter(Boolean)[0] ?? '')
    .filter(Boolean)
  return names.join(', ')
}

function getPayeeFullName(record: any) {
  const contractPayeeNames = getContractPayeeNames(record)
  if (contractPayeeNames.length > 0) return contractPayeeNames.join(', ')
  return String(record.payee?.statement_name ?? record.payee?.payee_name ?? '').trim()
}

export default function EmailPrepPage() {
  const [loading, setLoading] = useState(true)
  const [records, setRecords] = useState<any[]>([])
  const [periods, setPeriods] = useState<StatementPeriod[]>([])
  const [periodFilter, setPeriodFilter] = useState('')
  const [domainFilter, setDomainFilter] = useState('')
  const [statusFilter, setStatusFilter] = useState('not_sent')
  const [error, setError] = useState<string | null>(null)
  const [editingRecord, setEditingRecord] = useState<string | null>(null)
  const [draftSubject, setDraftSubject] = useState('')
  const [draftBody, setDraftBody] = useState('')
  const [savingId, setSavingId] = useState<string | null>(null)

  useEffect(() => { load() }, [])

  async function load() {
    setLoading(true)
    const [recRes, perRes] = await Promise.all([
      supabase
        .from('statement_records')
        .select('*, payee:payees(payee_name, statement_name, primary_email, secondary_email, currency), contract:contracts(contract_name, contract_code), statement_period:statement_periods(label)')
        .eq('approval_status', 'approved')
        .eq('output_generated_flag', true)
        .order('created_at', { ascending: false }),
      supabase.from('statement_periods').select('*').order('year', { ascending: false }).order('half', { ascending: false }),
    ])
    const baseRecords = (recRes.data ?? []) as any[]
    const contractIds = Array.from(new Set(baseRecords.map(record => record.contract_id).filter(Boolean)))
    let contractPayeeLinks: any[] = []

    if (contractIds.length > 0) {
      const { data: payeeLinks } = await supabase
        .from('contract_payee_links')
        .select('contract_id, payee_id, royalty_share, is_active, payee:payees(payee_name, statement_name, primary_email, secondary_email, currency)')
        .eq('is_active', true)
        .in('contract_id', contractIds)
      contractPayeeLinks = payeeLinks ?? []
    }

    const payeesByContractId = contractPayeeLinks.reduce<Record<string, any[]>>((acc, link) => {
      const contractId = String(link.contract_id ?? '')
      if (!contractId) return acc
      if (!acc[contractId]) acc[contractId] = []
      acc[contractId].push(link)
      return acc
    }, {})

    setRecords(baseRecords.map(record => ({
      ...record,
      contract_payees: payeesByContractId[record.contract_id] ?? [],
    })))
    setPeriods(sortByLabel(perRes.data ?? [], period => period.label))
    if (perRes.data && perRes.data.length > 0 && !periodFilter) {
      setPeriodFilter(perRes.data[0].id)
    }
    setLoading(false)
  }

  const filtered = records.filter(r => {
    if (periodFilter && r.statement_period_id !== periodFilter) return false
    if (domainFilter && r.domain !== domainFilter) return false
    if (statusFilter === 'not_sent' && r.email_status === 'sent') return false
    if (statusFilter === 'sent' && r.email_status !== 'sent') return false
    if (statusFilter === 'prepared' && r.email_status !== 'prepared') return false
    if (statusFilter === 'missing_email' && r.payee?.primary_email) return false
    return true
  })

  function startEdit(record: any) {
    setEditingRecord(record.id)
    setDraftSubject(record.email_prepared_subject ?? generateDefaultSubject(record))
    setDraftBody(record.email_prepared_body ?? generateDefaultBody(record))
  }

  function generateDefaultSubject(record: any) {
    const name     = getPayeeFullName(record)
    const period   = record.statement_period?.label ?? ''
    const contract = record.contract?.contract_name ?? ''
    const type     = record.domain === 'master' ? 'Master Royalty' : 'Publishing'
    if (record.domain === 'publishing') {
      return `${period} MMS Statement`
    }
    // Include contract name so subject uniquely identifies this statement
    return `${name} — ${contract} — ${type} Statement — ${period}`
  }

  function generateDefaultBody(record: any) {
    const greetingName = getGreetingFirstNames(record) || getPayeeFullName(record)
    const period = record.statement_period?.label ?? ''
    const currency = getStatementCurrency(record)
    const payableAmount = new Intl.NumberFormat('en-GB', {
      style: 'currency',
      currency,
      minimumFractionDigits: 2,
      maximumFractionDigits: 2,
    }).format(Number(record.payable_amount ?? 0))

    if (record.is_payable && Number(record.payable_amount ?? 0) > 0) {
      return `Dear ${greetingName},

Please find your statement for ${period} attached.

Please send invoice for ${payableAmount} to

Music Matters BYpittbull Ltd
465C Hornsey Road
London N19 4DR

Ref: ${period} Statement - Your Full Name`
    }

    return `Dear ${greetingName},

Please find your statements for ${period} attached.

As payable balance is below €100 it will be forwarded onto your next statement.`
  }

  async function saveEmailPrep(recordId: string) {
    setSavingId(recordId)
    await supabase.from('statement_records').update({
      email_prepared_subject: draftSubject,
      email_prepared_body: draftBody,
      email_status: 'prepared',
      email_prepared_at: new Date().toISOString(),
      email_prepared_by: 'User',
      updated_at: new Date().toISOString(),
    }).eq('id', recordId)
    setEditingRecord(null)
    setSavingId(null)
    await load()
  }

  async function markSent(recordId: string) {
    if (!confirm('Mark this statement as sent?')) return
    await supabase.from('statement_records').update({
      email_status: 'sent',
      sent_date: new Date().toISOString().split('T')[0],
      updated_at: new Date().toISOString(),
    }).eq('id', recordId)
    await load()
  }

  async function deleteEmailPrep(recordId: string) {
    if (!confirm('Delete this prepared email?')) return
    await supabase.from('statement_records').update({
      email_prepared_subject: null,
      email_prepared_body: null,
      email_status: 'not_prepared',
      email_prepared_at: null,
      email_prepared_by: null,
      updated_at: new Date().toISOString(),
    }).eq('id', recordId)
    if (editingRecord === recordId) {
      setEditingRecord(null)
      setDraftSubject('')
      setDraftBody('')
    }
    await load()
  }

  async function markAllSent() {
    const toSend = filtered.filter(r => r.email_status === 'prepared' && r.payee?.primary_email)
    if (!toSend.length) { alert('No prepared statements with email addresses ready to mark.'); return }
    if (!confirm(`Mark ${toSend.length} statement(s) as sent?`)) return
    const today = new Date().toISOString().split('T')[0]
    await Promise.all(toSend.map(r =>
      supabase.from('statement_records').update({
        email_status: 'sent',
        sent_date: today,
        updated_at: new Date().toISOString(),
      }).eq('id', r.id)
    ))
    await load()
  }

  const sentCount = filtered.filter(r => r.email_status === 'sent').length
  const preparedCount = filtered.filter(r => r.email_status === 'prepared').length
  const missingEmailCount = filtered.filter(r => !r.payee?.primary_email).length

  return (
    <div className="space-y-4">
      <div className="page-header">
        <div>
          <h1 className="page-title">Email Prep</h1>
          <p className="page-subtitle">
            Approved statements with output generated · {sentCount} sent · {preparedCount} prepared · {missingEmailCount > 0 && <span className="text-red-400">{missingEmailCount} missing email</span>}
          </p>
        </div>
        <div className="flex gap-2">
          <button onClick={load} className="btn-ghost btn-sm"><RefreshCw size={13} /></button>
          {preparedCount > 0 && (
            <button onClick={markAllSent} className="btn-success">
              <Send size={13} /> Mark All Prepared as Sent ({preparedCount})
            </button>
          )}
        </div>
      </div>

      {error && <Alert type="error">{error}</Alert>}

      {/* Filters */}
      <div className="card p-3 flex items-center gap-2 flex-wrap">
        <Filter size={13} className="text-ops-muted" />
        <select className="ops-select w-36" value={periodFilter} onChange={e => setPeriodFilter(e.target.value)}>
          <option value="">All periods</option>
          {periods.map(p => <option key={p.id} value={p.id}>{p.label}</option>)}
        </select>
        <select className="ops-select w-32" value={domainFilter} onChange={e => setDomainFilter(e.target.value)}>
          <option value="">All domains</option>
          <option value="master">Master</option>
          <option value="publishing">Publishing</option>
        </select>
        <select className="ops-select w-40" value={statusFilter} onChange={e => setStatusFilter(e.target.value)}>
          <option value="">All</option>
          <option value="missing_email">Missing email</option>
          <option value="not_sent">Not sent</option>
          <option value="prepared">Prepared</option>
          <option value="sent">Sent</option>
        </select>
      </div>

      {loading ? (
        <div className="flex justify-center py-16"><LoadingSpinner size={22} /></div>
      ) : filtered.length === 0 ? (
        <div className="card">
          <EmptyState
            title="No statements match"
            description="All approved statements with outputs are shown here"
            icon={Mail}
          />
        </div>
      ) : (
        <div className="space-y-3">
          {filtered.map(r => (
            <EmailPrepCard
              key={r.id}
              record={r}
              isEditing={editingRecord === r.id}
              draftSubject={editingRecord === r.id ? draftSubject : ''}
              draftBody={editingRecord === r.id ? draftBody : ''}
              onSubjectChange={setDraftSubject}
              onBodyChange={setDraftBody}
              onEdit={() => startEdit(r)}
              onSave={() => saveEmailPrep(r.id)}
              onMarkSent={() => markSent(r.id)}
              onDelete={() => deleteEmailPrep(r.id)}
              onCancel={() => setEditingRecord(null)}
              saving={savingId === r.id}
            />
          ))}
        </div>
      )}
    </div>
  )
}

function EmailPrepCard({
  record: r, isEditing, draftSubject, draftBody,
  onSubjectChange, onBodyChange, onEdit, onSave, onMarkSent, onDelete, onCancel, saving
}: {
  record: any
  isEditing: boolean
  draftSubject: string
  draftBody: string
  onSubjectChange: (v: string) => void
  onBodyChange: (v: string) => void
  onEdit: () => void
  onSave: () => void
  onMarkSent: () => void
  onDelete: () => void
  onCancel: () => void
  saving: boolean
}) {
  const isSent = r.email_status === 'sent'
  const isPrepared = r.email_status === 'prepared'
  const hasEmail = !!r.payee?.primary_email
  const [copied, setCopied] = useState(false)

  async function copyPreparedEmail() {
    const subject = String(r.email_prepared_subject ?? '').trim()
    const body = String(r.email_prepared_body ?? '').trim()
    const copyText = [
      subject ? `Subject: ${subject}` : '',
      body,
    ].filter(Boolean).join('\n\n')

    if (!copyText) return

    try {
      await navigator.clipboard.writeText(copyText)
      setCopied(true)
      window.setTimeout(() => setCopied(false), 2000)
    } catch {
      window.alert('Could not copy email text. Please copy it manually from the preview.')
    }
  }

  return (
    <div className={`card ${isSent ? 'opacity-60' : ''}`}>
      <div className="card-header">
        <div className="flex items-center gap-3 flex-wrap">
          <span className="text-sm font-semibold">{r.payee?.payee_name}</span>
          <span className="text-sm text-ops-muted">—</span>
          <span className="text-sm font-medium text-ops-text">{r.contract?.contract_name ?? '—'}</span>
          {r.contract?.contract_code && <span className="font-mono text-xs text-ops-muted">{r.contract.contract_code}</span>}
          <DomainBadge domain={r.domain} />
          <span className="font-mono text-xs text-ops-muted">{r.statement_period?.label}</span>
          {r.is_payable && (
            <span className="text-green-400 font-mono text-xs font-bold">
              {r.payable_amount.toFixed(2)} {r.payee?.currency}
            </span>
          )}
          {r.is_recouping && <span className="badge-recouping">Recouping</span>}
          {r.carry_forward_amount > 0 && <span className="badge-warning">Carry Fwd</span>}
        </div>
        <div className="flex items-center gap-2">
          {isSent && <span className="badge-sent flex items-center gap-1"><CheckCircle size={10} />Sent {r.sent_date && `· ${new Date(r.sent_date).toLocaleDateString('en-GB')}`}</span>}
          {isPrepared && !isSent && <span className="badge-info">Prepared</span>}
          {!isPrepared && !isSent && <span className="badge-pending">Not Prepared</span>}
        </div>
      </div>

      <div className="card-body space-y-3">
        {/* Email address */}
        <div className="flex items-center gap-2">
          <Mail size={13} className="text-ops-muted" />
          {hasEmail ? (
            <div>
              <span className="text-xs font-mono">{r.payee.primary_email}</span>
              {r.payee.secondary_email && (
                <span className="text-xs text-ops-muted ml-2">CC: {r.payee.secondary_email}</span>
              )}
            </div>
          ) : (
            <span className="text-xs text-red-400 flex items-center gap-1">
              <AlertTriangle size={11} /> No email address — <Link href={`/payees/${r.payee_id}`} className="underline hover:text-red-300">Add email →</Link>
            </span>
          )}
        </div>

        {/* Email content (edit or view) */}
        {isEditing ? (
          <div className="space-y-2">
            <div className="ops-field">
              <label className="ops-label">Subject</label>
              <input
                className="ops-input"
                value={draftSubject}
                onChange={e => onSubjectChange(e.target.value)}
              />
            </div>
            <div className="ops-field">
              <label className="ops-label">Body</label>
              <textarea
                className="ops-textarea font-mono text-xs"
                rows={8}
                value={draftBody}
                onChange={e => onBodyChange(e.target.value)}
              />
            </div>
            <div className="flex justify-end gap-2">
              <button onClick={onCancel} className="btn-secondary">Cancel</button>
              <button onClick={onSave} disabled={saving} className="btn-primary">
                {saving ? 'Saving…' : 'Save Email Prep'}
              </button>
            </div>
          </div>
        ) : (
          <>
            {r.email_prepared_subject && (
              <div>
                <div className="text-xs text-ops-muted mb-0.5">Subject</div>
                <div className="text-xs font-medium">{r.email_prepared_subject}</div>
              </div>
            )}
            {r.email_prepared_body && (
              <div>
                <div className="text-xs text-ops-muted mb-0.5">Body preview</div>
                <div className="text-xs text-ops-muted font-mono whitespace-pre-wrap bg-ops-bg rounded p-2 max-h-24 overflow-y-auto">
                  {r.email_prepared_body}
                </div>
              </div>
            )}
            {r.email_prepared_at && (
              <div className="text-[10px] text-ops-subtle">
                Prepared {new Date(r.email_prepared_at).toLocaleDateString('en-GB')} by {r.email_prepared_by}
              </div>
            )}
          </>
        )}

        {/* Actions */}
        {!isEditing && !isSent && (
          <div className="flex gap-2 pt-1">
            <button onClick={onEdit} className="btn-secondary btn-sm">
              {isPrepared ? 'Edit Email' : 'Prepare Email'}
            </button>
            {isPrepared && (
              <button onClick={copyPreparedEmail} className="btn-ghost btn-sm" disabled={!r.email_prepared_subject && !r.email_prepared_body}>
                <Copy size={12} /> {copied ? 'Copied' : 'Copy Email'}
              </button>
            )}
            {isPrepared && hasEmail && (
              <button onClick={onMarkSent} className="btn-success btn-sm">
                <CheckCircle size={12} /> Mark as Sent
              </button>
            )}
            {isPrepared && (
              <button onClick={onDelete} className="btn-ghost btn-sm">
                <Trash2 size={12} /> Delete Email Prep
              </button>
            )}
            <Link href={`/statements/${r.id}`} className="btn-ghost btn-sm">
              View Statement →
            </Link>
          </div>
        )}
      </div>
    </div>
  )
}
