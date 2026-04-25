'use client'
import { useEffect, useState } from 'react'
import { supabase } from '@/lib/supabase/client'
import { DomainBadge, SeverityBadge, Alert, LoadingSpinner, EmptyState, StatCard, getNoticePanelStyle } from '@/components/ui'
import { AlertTriangle, CheckCircle, RefreshCw, Filter } from 'lucide-react'
import Link from 'next/link'
import { EXCEPTION_TYPE_LABELS, IMPORT_EXCEPTION_ISSUE_TYPES, isImportExceptionIssueType, SEVERITY_ORDER } from '@/lib/utils/exceptionEngine'
import type { Exception, StatementPeriod } from '@/lib/types'
import { sortByLabel } from '@/lib/utils/sortOptions'

type ExceptionWithJoins = Exception & {
  payee: { payee_name: string } | null
  statement_period: { label: string } | null
}

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

  async function load() {
    setLoading(true)
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
      // Identify exceptions whose import no longer exists
      const stale = allExc.filter(e => e.import_id && !validImportIds.has(e.import_id))
      staleExceptionIds = stale.map(e => e.id)
      // Delete stale exceptions from DB so they don't reappear on refresh
      if (staleExceptionIds.length > 0) {
        await supabase.from('exceptions').delete().in('id', staleExceptionIds)
      }
    }

    if (importExceptionIds.length > 0) {
      await supabase.from('exceptions').delete().in('id', importExceptionIds)
    }

    const freshExceptions = allExc.filter(e =>
      !staleExceptionIds.includes(e.id) &&
      !importExceptionIds.includes(e.id)
    )
    setExceptions(freshExceptions)
    setPeriods(sortByLabel(perRes.data ?? [], period => period.label))
    setLoading(false)
  }

  async function resolve(id: string) {
    const notes = prompt('Resolution notes (required):')
    if (!notes?.trim()) return
    await supabase.from('exceptions').update({
      resolution_status: 'resolved',
      resolution_notes: notes,
      resolved_by: 'User',
      resolved_at: new Date().toISOString(),
    }).eq('id', id)
    await load()
  }

  async function dismiss(id: string) {
    const notes = prompt('Reason for dismissing:')
    if (!notes?.trim()) return
    await supabase.from('exceptions').update({
      resolution_status: 'dismissed',
      resolution_notes: notes,
      resolved_by: 'User',
      resolved_at: new Date().toISOString(),
    }).eq('id', id)
    await load()
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
            />
          )}
          {/* Warning group */}
          {warning.length > 0 && (
            <ExceptionGroup
              title="Warnings"
              exceptions={warning}
              onResolve={resolve}
              onDismiss={dismiss}
            />
          )}
          {/* Info group */}
          {info.length > 0 && (
            <ExceptionGroup
              title="Info"
              exceptions={info}
              onResolve={resolve}
              onDismiss={dismiss}
            />
          )}
        </div>
      )}
    </div>
  )
}

function ExceptionGroup({
  title, exceptions, onResolve, onDismiss
}: {
  title: string
  exceptions: ExceptionWithJoins[]
  onResolve: (id: string) => void
  onDismiss: (id: string) => void
}) {
  const [collapsed, setCollapsed] = useState(false)
  const tone = title === 'Critical' ? 'error' : title === 'Warnings' ? 'warning' : 'info'
  const iconColor = title === 'Critical' ? 'text-red-400' : title === 'Warnings' ? 'text-amber-400' : 'text-blue-400'

  return (
    <div className="card border" style={{ borderColor: getNoticePanelStyle(tone).borderColor }}>
      <button
        className="w-full card-header text-left"
        style={getNoticePanelStyle(tone)}
        onClick={() => setCollapsed(!collapsed)}
      >
        <div className="flex items-center gap-2">
          <AlertTriangle size={14} className={iconColor} />
          <span className="text-sm font-semibold" style={{ color: 'var(--ops-text)' }}>{title}</span>
          <span className="text-xs text-ops-muted">({exceptions.length})</span>
        </div>
        <span className="text-xs text-ops-muted">{collapsed ? '▸' : '▾'}</span>
      </button>

      {!collapsed && (
        <div className="divide-y divide-ops-border">
          {exceptions.map(e => (
            <div key={e.id} className="px-4 py-3 flex items-start gap-3 group">
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
                </div>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
