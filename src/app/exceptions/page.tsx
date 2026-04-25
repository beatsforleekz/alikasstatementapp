'use client'
import { useEffect, useState } from 'react'
import { supabase } from '@/lib/supabase/client'
import { DomainBadge, SeverityBadge, Alert, LoadingSpinner, EmptyState, StatCard, getNoticePanelStyle } from '@/components/ui'
import { AlertTriangle, CheckCircle, RefreshCw, Filter } from 'lucide-react'
import Link from 'next/link'
import {
  EXCEPTION_TYPE_LABELS,
  IMPORT_EXCEPTION_ISSUE_TYPES,
  detectStatementExceptions,
  isImportExceptionIssueType,
  SEVERITY_ORDER,
} from '@/lib/utils/exceptionEngine'
import type { Exception, Payee, StatementPeriod, StatementRecord } from '@/lib/types'
import { sortByLabel } from '@/lib/utils/sortOptions'

type ExceptionWithJoins = Exception & {
  payee: { payee_name: string } | null
  statement_period: { label: string } | null
}

type StatementExceptionRecord = StatementRecord & {
  payee: Pick<Payee, 'id' | 'payee_name' | 'primary_email'> | null
}

const STATEMENT_EXCEPTION_ISSUE_TYPES = [
  'missing_email',
  'output_missing',
  'payable_not_approved',
  'issued_payable_mismatch',
  'payable_not_sent',
  'carryover_not_confirmed',
  'carryover_below_threshold',
] as const

export default function ExceptionsPage() {
  const fetchAllPaged = async <T,>(
    buildQuery: (from: number, to: number) => PromiseLike<{ data: T[] | null; error: any }>
  ) => {
    const rows: T[] = []
    for (let from = 0; ; from += 1000) {
      const to = from + 999
      const { data, error: queryError } = await buildQuery(from, to)
      if (queryError) throw queryError
      const batch = (data ?? []) as T[]
      rows.push(...batch)
      if (batch.length < 1000) break
    }
    return rows
  }

  const [loading, setLoading] = useState(true)
  const [exceptions, setExceptions] = useState<ExceptionWithJoins[]>([])
  const [periods, setPeriods] = useState<StatementPeriod[]>([])
  const [domainFilter, setDomainFilter] = useState('')
  const [severityFilter, setSeverityFilter] = useState('')
  const [statusFilter, setStatusFilter] = useState('open')
  const [typeFilter, setTypeFilter] = useState('')
  const [periodFilter, setPeriodFilter] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [clearingAll, setClearingAll] = useState(false)

  useEffect(() => { load() }, [])

  const buildStatementExceptionKey = (statementRecordId: string | null | undefined, issueType: string | null | undefined) =>
    statementRecordId && issueType ? `${statementRecordId}::${issueType}` : ''

  async function syncStatementExceptions(existingExceptions: ExceptionWithJoins[]) {
    const statementRecords = await fetchAllPaged<StatementExceptionRecord>((from, to) =>
      supabase
        .from('statement_records')
        .select('*, payee:payees(id, payee_name, primary_email)')
        .order('statement_period_id', { ascending: false })
        .order('created_at', { ascending: false })
        .range(from, to)
    )

    const desired = new Map<string, ReturnType<typeof detectStatementExceptions>[number]>()
    for (const record of statementRecords) {
      const payee = record.payee
      if (!payee) continue
      const detected = detectStatementExceptions(record, payee as Payee, 0)
      for (const item of detected) {
        const key = buildStatementExceptionKey(item.statement_record_id, item.issue_type)
        if (!key) continue
        desired.set(key, item)
      }
    }

    const existingStatementExceptions = existingExceptions.filter(exception =>
      !!exception.statement_record_id &&
      (STATEMENT_EXCEPTION_ISSUE_TYPES as readonly string[]).includes(exception.issue_type)
    )

    const existingByKey = new Map<string, ExceptionWithJoins>()
    const duplicateIds: string[] = []
    for (const exception of existingStatementExceptions) {
      const key = buildStatementExceptionKey(exception.statement_record_id, exception.issue_type)
      if (!key) continue
      const current = existingByKey.get(key)
      if (!current) {
        existingByKey.set(key, exception)
        continue
      }
      const keepCurrent = current.resolution_status === 'open'
      const keepNext = exception.resolution_status === 'open'
      if (!keepCurrent && keepNext) {
        duplicateIds.push(current.id)
        existingByKey.set(key, exception)
      } else {
        duplicateIds.push(exception.id)
      }
    }

    if (duplicateIds.length > 0) {
      await supabase.from('exceptions').delete().in('id', duplicateIds)
    }

    for (const [key, desiredException] of Array.from(desired.entries())) {
      const existing = existingByKey.get(key)
      const payload = {
        domain: desiredException.domain,
        severity: desiredException.severity,
        issue_type: desiredException.issue_type,
        statement_period_id: desiredException.statement_period_id ?? null,
        payee_id: desiredException.payee_id ?? null,
        contract_id: desiredException.contract_id ?? null,
        import_id: null,
        import_row_id: null,
        statement_record_id: desiredException.statement_record_id ?? null,
        title: desiredException.title,
        detail: desiredException.detail,
        resolution_status: 'open' as const,
        resolution_notes: null,
        resolved_by: null,
        resolved_at: null,
        auto_generated: true,
      }

      if (!existing) {
        await supabase.from('exceptions').insert(payload)
        continue
      }

      await supabase.from('exceptions').update(payload).eq('id', existing.id)
    }

    const staleOpenIds = Array.from(existingByKey.entries())
      .filter(([key, exception]) => !desired.has(key) && exception.resolution_status === 'open')
      .map(([, exception]) => exception.id)

    if (staleOpenIds.length > 0) {
      await supabase.from('exceptions').update({
        resolution_status: 'resolved',
        resolution_notes: 'Auto-resolved: issue no longer detected on refresh.',
        resolved_by: 'System',
        resolved_at: new Date().toISOString(),
      }).in('id', staleOpenIds)
    }
  }

  async function load() {
    setLoading(true)
    setError(null)
    try {
      const [allExc, perRes] = await Promise.all([
        fetchAllPaged<ExceptionWithJoins>((from, to) =>
          supabase
            .from('exceptions')
            .select('*, payee:payees(payee_name), statement_period:statement_periods(label)')
            .order('created_at', { ascending: false })
            .range(from, to)
        ),
        supabase.from('statement_periods').select('*').order('year', { ascending: false }).order('half', { ascending: false }),
      ])

      const importExceptionIds = allExc
        .filter(e => isImportExceptionIssueType(e.issue_type))
        .map(e => e.id)
      const importIds = Array.from(new Set(allExc.map(e => e.import_id).filter(Boolean)))
      let staleExceptionIds: string[] = []
      if (importIds.length > 0) {
        const { data: existingImports } = await supabase
          .from('imports')
          .select('id')
          .in('id', importIds)
        const validImportIds = new Set((existingImports ?? []).map((i: any) => i.id))
        const stale = allExc.filter(e => e.import_id && !validImportIds.has(e.import_id))
        staleExceptionIds = stale.map(e => e.id)
        if (staleExceptionIds.length > 0) {
          await supabase.from('exceptions').delete().in('id', staleExceptionIds)
        }
      }

      if (importExceptionIds.length > 0) {
        await supabase.from('exceptions').delete().in('id', importExceptionIds)
      }

      const remainingExceptions = allExc.filter(e =>
        !staleExceptionIds.includes(e.id) &&
        !importExceptionIds.includes(e.id)
      )

      await syncStatementExceptions(remainingExceptions)

      const refreshedExceptions = await fetchAllPaged<ExceptionWithJoins>((from, to) =>
        supabase
          .from('exceptions')
          .select('*, payee:payees(payee_name), statement_period:statement_periods(label)')
          .order('created_at', { ascending: false })
          .range(from, to)
      )

      setExceptions(refreshedExceptions.filter(e => !isImportExceptionIssueType(e.issue_type)))
      setPeriods(sortByLabel(perRes.data ?? [], period => period.label))
    } catch (e: any) {
      setError(e.message ?? 'Failed to load exceptions.')
      setExceptions([])
    } finally {
      setLoading(false)
    }
  }

  async function resolve(id: string) {
    const notes = prompt('Resolution notes (required):')
    if (!notes?.trim()) return
    const resolvedAt = new Date().toISOString()
    await supabase.from('exceptions').update({
      resolution_status: 'resolved',
      resolution_notes: notes,
      resolved_by: 'User',
      resolved_at: resolvedAt,
    }).eq('id', id)
    setExceptions(prev => prev.map(exception =>
      exception.id === id
        ? {
            ...exception,
            resolution_status: 'resolved',
            resolution_notes: notes,
            resolved_by: 'User',
            resolved_at: resolvedAt,
          }
        : exception
    ))
  }

  async function resolveMany(ids: string[]) {
    if (ids.length === 0) return
    const notes = prompt(`Resolution notes for ${ids.length} exception${ids.length !== 1 ? 's' : ''} (required):`)
    if (!notes?.trim()) return
    const resolvedAt = new Date().toISOString()
    await supabase.from('exceptions').update({
      resolution_status: 'resolved',
      resolution_notes: notes,
      resolved_by: 'User',
      resolved_at: resolvedAt,
    }).in('id', ids)
    const idSet = new Set(ids)
    setExceptions(prev => prev.map(exception =>
      idSet.has(exception.id)
        ? {
            ...exception,
            resolution_status: 'resolved',
            resolution_notes: notes,
            resolved_by: 'User',
            resolved_at: resolvedAt,
          }
        : exception
    ))
  }

  async function dismiss(id: string) {
    const notes = prompt('Reason for dismissing:')
    if (!notes?.trim()) return
    const resolvedAt = new Date().toISOString()
    await supabase.from('exceptions').update({
      resolution_status: 'dismissed',
      resolution_notes: notes,
      resolved_by: 'User',
      resolved_at: resolvedAt,
    }).eq('id', id)
    setExceptions(prev => prev.map(exception =>
      exception.id === id
        ? {
            ...exception,
            resolution_status: 'dismissed',
            resolution_notes: notes,
            resolved_by: 'User',
            resolved_at: resolvedAt,
          }
        : exception
    ))
  }

  async function dismissMany(ids: string[]) {
    if (ids.length === 0) return
    const notes = prompt(`Reason for dismissing ${ids.length} exception${ids.length !== 1 ? 's' : ''}:`)
    if (!notes?.trim()) return
    const resolvedAt = new Date().toISOString()
    await supabase.from('exceptions').update({
      resolution_status: 'dismissed',
      resolution_notes: notes,
      resolved_by: 'User',
      resolved_at: resolvedAt,
    }).in('id', ids)
    const idSet = new Set(ids)
    setExceptions(prev => prev.map(exception =>
      idSet.has(exception.id)
        ? {
            ...exception,
            resolution_status: 'dismissed',
            resolution_notes: notes,
            resolved_by: 'User',
            resolved_at: resolvedAt,
          }
        : exception
    ))
  }

  async function deleteMany(ids: string[]) {
    if (ids.length === 0) return
    if (!confirm(`Delete ${ids.length} exception${ids.length !== 1 ? 's' : ''}? This cannot be undone.`)) return
    await supabase.from('exceptions').delete().in('id', ids)
    const idSet = new Set(ids)
    setExceptions(prev => prev.filter(exception => !idSet.has(exception.id)))
  }

  async function clearAllExceptions() {
    setClearingAll(true)
    setError(null)
    const { error: clearErr } = await supabase.from('exceptions').delete().neq('id', '')
    if (clearErr) {
      setError(clearErr.message)
    }
    setClearingAll(false)
    await load()
  }

  const filtered = exceptions.filter(e => {
    if (domainFilter && e.domain !== domainFilter) return false
    if (severityFilter && e.severity !== severityFilter) return false
    if (statusFilter && e.resolution_status !== statusFilter) return false
    if (typeFilter && e.issue_type !== typeFilter) return false
    if (periodFilter && e.statement_period_id !== periodFilter) return false
    return true
  })

  // Group by severity for display
  const critical = filtered.filter(e => e.severity === 'critical')
  const warning = filtered.filter(e => e.severity === 'warning')
  const info = filtered.filter(e => e.severity === 'info')

  const allOpen = exceptions.filter(e => e.resolution_status === 'open')
  const criticalOpen = allOpen.filter(e => e.severity === 'critical')

  // Issue types present in data (for filter)
  const issueTypes = Array.from(new Set(exceptions.map(e => e.issue_type))).sort()

  return (
    <div className="space-y-4">
      <div className="page-header">
        <div>
          <h1 className="page-title">Exceptions</h1>
          <p className="page-subtitle">
            {allOpen.length} open · {criticalOpen.length > 0 && <span className="text-red-400">{criticalOpen.length} critical</span>}
          </p>
        </div>
        <div className="flex items-center gap-2">
          <button
            onClick={clearAllExceptions}
            className="btn-ghost btn-sm"
            disabled={clearingAll || exceptions.length === 0}
          >
            {clearingAll ? 'Clearing…' : 'Clear All Exceptions'}
          </button>
          <button onClick={load} className="btn-ghost btn-sm"><RefreshCw size={13} /></button>
        </div>
      </div>

      {error && <Alert type="error">{error}</Alert>}
      <div className="card border border-blue-200 bg-blue-50/50">
        <div className="card-body text-xs text-ops-muted">
          Exceptions are statement workflow issues. Import matching and contract-linking issues are handled in Sales Errors.
        </div>
      </div>
      {/* Stats */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
        <StatCard
          label="Critical (open)"
          value={exceptions.filter(e => e.severity === 'critical' && e.resolution_status === 'open').length}
          color="red"
        />
        <StatCard
          label="Warnings (open)"
          value={exceptions.filter(e => e.severity === 'warning' && e.resolution_status === 'open').length}
          color="blue"
        />
        <StatCard
          label="Info (open)"
          value={exceptions.filter(e => e.severity === 'info' && e.resolution_status === 'open').length}
          color="blue"
        />
        <StatCard
          label="Resolved"
          value={exceptions.filter(e => e.resolution_status === 'resolved').length}
          color="default"
        />
      </div>

      {/* Filters */}
      <div className="card p-3 flex items-center gap-2 flex-wrap">
        <Filter size={13} className="text-ops-muted" />
        <select className="ops-select w-32" value={domainFilter} onChange={e => setDomainFilter(e.target.value)}>
          <option value="">All domains</option>
          <option value="master">Master</option>
          <option value="publishing">Publishing</option>
        </select>
        <select className="ops-select w-32" value={severityFilter} onChange={e => setSeverityFilter(e.target.value)}>
          <option value="">All severity</option>
          <option value="info">Info</option>
          <option value="critical">Critical</option>
          <option value="warning">Warning</option>
        </select>
        <select className="ops-select w-36" value={statusFilter} onChange={e => setStatusFilter(e.target.value)}>
          <option value="">All statuses</option>
          <option value="dismissed">Dismissed</option>
          <option value="open">Open</option>
          <option value="resolved">Resolved</option>
        </select>
        <select className="ops-select w-44" value={typeFilter} onChange={e => setTypeFilter(e.target.value)}>
          <option value="">All types</option>
          {issueTypes.map(t => (
            <option key={t} value={t}>{EXCEPTION_TYPE_LABELS[t] ?? t}</option>
          ))}
        </select>
        <select className="ops-select w-32" value={periodFilter} onChange={e => setPeriodFilter(e.target.value)}>
          <option value="">All periods</option>
          {periods.map(p => <option key={p.id} value={p.id}>{p.label}</option>)}
        </select>
        {(domainFilter || severityFilter || typeFilter || periodFilter || statusFilter !== 'open') && (
          <button className="btn-ghost btn-sm" onClick={() => {
            setDomainFilter(''); setSeverityFilter(''); setTypeFilter(''); setPeriodFilter(''); setStatusFilter('open')
          }}>Clear</button>
        )}
      </div>

      {loading ? (
        <div className="flex justify-center py-16"><LoadingSpinner size={22} /></div>
      ) : filtered.length === 0 ? (
        <div className="card">
          <EmptyState
            title="No exceptions"
            description={statusFilter === 'open' ? 'All clear — no open exceptions' : 'No exceptions match filters'}
            icon={CheckCircle}
          />
        </div>
      ) : (
        <div className="space-y-4">
          {/* Critical group */}
          {critical.length > 0 && (
            <ExceptionGroup
              title="Critical"
              exceptions={critical}
              onResolve={resolve}
              onDismiss={dismiss}
              onResolveMany={resolveMany}
              onDismissMany={dismissMany}
              onDeleteMany={deleteMany}
            />
          )}
          {/* Warning group */}
          {warning.length > 0 && (
            <ExceptionGroup
              title="Warnings"
              exceptions={warning}
              onResolve={resolve}
              onDismiss={dismiss}
              onResolveMany={resolveMany}
              onDismissMany={dismissMany}
              onDeleteMany={deleteMany}
            />
          )}
          {/* Info group */}
          {info.length > 0 && (
            <ExceptionGroup
              title="Info"
              exceptions={info}
              onResolve={resolve}
              onDismiss={dismiss}
              onResolveMany={resolveMany}
              onDismissMany={dismissMany}
              onDeleteMany={deleteMany}
            />
          )}
        </div>
      )}
    </div>
  )
}

function ExceptionGroup({
  title, exceptions, onResolve, onDismiss, onResolveMany, onDismissMany, onDeleteMany
}: {
  title: string
  exceptions: ExceptionWithJoins[]
  onResolve: (id: string) => void
  onDismiss: (id: string) => void
  onResolveMany: (ids: string[]) => void
  onDismissMany: (ids: string[]) => void
  onDeleteMany: (ids: string[]) => void
}) {
  const [collapsed, setCollapsed] = useState(false)
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set())
  const tone = title === 'Critical' ? 'error' : title === 'Warnings' ? 'warning' : 'info'
  const iconColor = title === 'Critical' ? 'text-red-400' : title === 'Warnings' ? 'text-amber-400' : 'text-blue-400'
  const openExceptions = exceptions.filter(e => e.resolution_status === 'open')
  const allOpenSelected = openExceptions.length > 0 && openExceptions.every(e => selectedIds.has(e.id))
  const selectedOpenIds = openExceptions.filter(e => selectedIds.has(e.id)).map(e => e.id)

  const toggleOne = (id: string) => {
    setSelectedIds(prev => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  const toggleAll = () => {
    setSelectedIds(prev => {
      if (allOpenSelected) return new Set(Array.from(prev).filter(id => !openExceptions.some(e => e.id === id)))
      const next = new Set(prev)
      openExceptions.forEach(e => next.add(e.id))
      return next
    })
  }

  return (
    <div className="card border" style={{ borderColor: getNoticePanelStyle(tone).borderColor }}>
      <div className="card-header" style={getNoticePanelStyle(tone)}>
        <div className="flex items-center justify-between gap-3 flex-wrap w-full">
          <button
            className="flex items-center gap-2 text-left"
            onClick={() => setCollapsed(!collapsed)}
            type="button"
          >
            <AlertTriangle size={14} className={iconColor} />
            <span className="text-sm font-semibold" style={{ color: 'var(--ops-text)' }}>{title}</span>
            <span className="text-xs text-ops-muted">({exceptions.length})</span>
            <span className="text-xs text-ops-muted">{collapsed ? '▸' : '▾'}</span>
          </button>
          {!collapsed && openExceptions.length > 0 && (
            <label className="flex items-center gap-2 text-xs text-ops-muted">
              <input type="checkbox" checked={allOpenSelected} onChange={toggleAll} />
              Select all open
            </label>
          )}
        </div>
      </div>

      {!collapsed && (
        <div className="divide-y divide-ops-border">
          {selectedOpenIds.length > 0 && (
            <div className="px-4 py-3 flex items-center justify-between gap-3 flex-wrap bg-ops-surface-2">
              <div className="text-xs text-ops-muted">{selectedOpenIds.length} selected</div>
              <div className="flex items-center gap-2 flex-wrap">
                <button onClick={() => onResolveMany(selectedOpenIds)} className="btn-success btn-sm">Resolve selected</button>
                <button onClick={() => onDismissMany(selectedOpenIds)} className="btn-ghost btn-sm">Dismiss selected</button>
                <button onClick={() => onDeleteMany(selectedOpenIds)} className="btn-ghost btn-sm" style={{ color: 'var(--accent-red)' }}>Delete selected</button>
              </div>
            </div>
          )}
          {exceptions.map(e => (
            <div key={e.id} className="px-4 py-3 flex items-start gap-3 group">
              {e.resolution_status === 'open' ? (
                <input
                  type="checkbox"
                  checked={selectedIds.has(e.id)}
                  onChange={() => toggleOne(e.id)}
                  style={{ marginTop: 2 }}
                />
              ) : (
                <span style={{ width: 13, height: 13, marginTop: 2 }} />
              )}
              <div className="flex-1 min-w-0 space-y-1">
                <div className="flex items-center gap-2 flex-wrap">
                  <span className="text-xs font-semibold text-ops-text">{e.title}</span>
                  <DomainBadge domain={e.domain} />
                  <span className="badge-pending text-[10px]">
                    {EXCEPTION_TYPE_LABELS[e.issue_type] ?? e.issue_type}
                  </span>
                </div>
                {e.detail && <div className="text-xs text-ops-muted">{e.detail}</div>}
                <div className="flex items-center gap-3 text-[10px] text-ops-subtle">
                  {e.payee?.payee_name && <span>{e.payee.payee_name}</span>}
                  {e.statement_period?.label && <span className="font-mono">{e.statement_period.label}</span>}
                  <span>{new Date(e.created_at).toLocaleDateString('en-GB')}</span>
                  {e.statement_record_id && (
                    <Link href={`/statements/${e.statement_record_id}`} className="text-blue-400 hover:underline">
                      View statement →
                    </Link>
                  )}
                </div>
                {e.resolution_status !== 'open' && (
                  <div className="text-xs text-green-400 mt-1">
                    ✓ {e.resolution_status}: {e.resolution_notes}
                    {e.resolved_by && <span className="text-ops-muted"> by {e.resolved_by}</span>}
                  </div>
                )}
              </div>
              {e.resolution_status === 'open' && (
                <div className="flex gap-1 shrink-0 opacity-0 group-hover:opacity-100 transition-opacity">
                  <button onClick={() => onResolve(e.id)} className="btn-success btn-sm">Resolve</button>
                  <button onClick={() => onDismiss(e.id)} className="btn-ghost btn-sm">Dismiss</button>
                  <button onClick={() => onDeleteMany([e.id])} className="btn-ghost btn-sm" style={{ color: 'var(--accent-red)' }}>Delete</button>
                </div>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
