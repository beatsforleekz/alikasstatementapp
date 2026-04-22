'use client'
import { useCallback, useEffect, useRef, useState } from 'react'
import { supabase } from '@/lib/supabase/client'
import { StatCard, Alert, DomainBadge, PayableBadge, SeverityBadge, Amount } from '@/components/ui'
import { AlertTriangle, CheckCircle, FileText, Disc3, Calendar, ChevronDown, RefreshCw } from 'lucide-react'
import Link from 'next/link'
import type { StatementPeriod, StatementRecord, Exception } from '@/lib/types'
import { createOpsLiveChannel } from '@/lib/utils/liveOps'
import { IMPORT_EXCEPTION_ISSUE_TYPES } from '@/lib/utils/exceptionEngine'

export default function DashboardPage() {
  const [loading, setLoading] = useState(true)
  const [periods, setPeriods] = useState<StatementPeriod[]>([])
  const [records, setRecords] = useState<(StatementRecord & { payee: { payee_name: string; primary_email: string | null; currency: string } })[]>([])
  const [exceptions, setExceptions] = useState<Exception[]>([])
  const [activePeriodId, setActivePeriodId] = useState<string | null>(null)
  const [showPeriodPicker, setShowPeriodPicker] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const refreshTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  const loadDashboard = useCallback(async () => {
    try {
      setLoading(true)
      let exceptionsQuery = supabase
        .from('exceptions')
        .select('*, payee:payees(payee_name)')
        .eq('resolution_status', 'open')
        .order('created_at', { ascending: false })
      for (const issueType of IMPORT_EXCEPTION_ISSUE_TYPES) {
        exceptionsQuery = exceptionsQuery.neq('issue_type', issueType)
      }

      const [periodsRes, recordsRes, exceptionsRes] = await Promise.all([
        supabase
          .from('statement_periods')
          .select('*')
          .order('year', { ascending: false })
          .order('half', { ascending: false })
          .limit(10),
        supabase
          .from('statement_records')
          .select('*, payee:payees(payee_name, primary_email, currency), statement_period:statement_periods(label, year, half)')
          .order('created_at', { ascending: false })
          .limit(200),
        exceptionsQuery,
      ])
      if (periodsRes.error) throw periodsRes.error
      if (recordsRes.error) throw recordsRes.error
      if (exceptionsRes.error) throw exceptionsRes.error

      const allPeriods = periodsRes.data ?? []
      setPeriods(allPeriods)
      setRecords((recordsRes.data ?? []) as any)
      setExceptions(exceptionsRes.data ?? [])

      setActivePeriodId(prev => {
        if (prev && allPeriods.some(p => p.id === prev)) return prev
        const currentPeriod = allPeriods.find(p => p.is_current)
          ?? allPeriods.find(p => p.status === 'open')
          ?? allPeriods[0]
        return currentPeriod?.id ?? null
      })
      setError(null)
    } catch (e: any) {
      setError(e.message)
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    void loadDashboard()
    const scheduleRefresh = () => {
      if (refreshTimerRef.current) clearTimeout(refreshTimerRef.current)
      refreshTimerRef.current = setTimeout(() => { void loadDashboard() }, 150)
    }
    const channel = createOpsLiveChannel(`dashboard-live-${Date.now()}`, scheduleRefresh)
    return () => {
      if (refreshTimerRef.current) clearTimeout(refreshTimerRef.current)
      supabase.removeChannel(channel)
    }
  }, [loadDashboard])

  async function setCurrentPeriod(periodId: string) {
    // Update is_current flag: clear all, then set selected
    await supabase
      .from('statement_periods')
      .update({ is_current: false })
      .neq('id', periodId)
    await supabase
      .from('statement_periods')
      .update({ is_current: true })
      .eq('id', periodId)
    setActivePeriodId(periodId)
    setShowPeriodPicker(false)
    // Refresh periods to reflect change
    const { data } = await supabase
      .from('statement_periods')
      .select('*')
      .order('year', { ascending: false })
      .order('half', { ascending: false })
      .limit(10)
    if (data) setPeriods(data)
  }

  const currentPeriod = periods.find(p => p.id === activePeriodId) ?? periods[0]
  const currentRecords = records.filter(r => r.statement_period_id === currentPeriod?.id)

  const masterRecords      = currentRecords.filter(r => r.domain === 'master')
  const publishingRecords  = currentRecords.filter(r => r.domain === 'publishing')
  const payableRecords     = currentRecords.filter(r => r.is_payable)
  const recoupingRecords   = currentRecords.filter(r => r.is_recouping)
  const approvedRecords    = currentRecords.filter(r => r.approval_status === 'approved')
  const sentRecords        = currentRecords.filter(r => r.email_status === 'sent')
  const missingEmailPayable = payableRecords.filter(r => !(r.payee as any)?.primary_email)
  const outputMissing      = currentRecords.filter(r => r.approval_status === 'approved' && !r.output_generated_flag)

  const criticalExceptions = exceptions.filter(e => e.severity === 'critical')
  const warningExceptions  = exceptions.filter(e => e.severity === 'warning')

  const totalPayableMaster     = masterRecords.filter(r => r.is_payable).reduce((s, r) => s + r.payable_amount, 0)
  const totalPayablePublishing = publishingRecords.filter(r => r.is_payable).reduce((s, r) => s + r.payable_amount, 0)

  if (loading) return (
    <div className="flex items-center justify-center h-64 text-ops-muted text-sm">
      Loading dashboard…
    </div>
  )

  if (error) return <Alert type="error">{error}</Alert>

  return (
    <div className="space-y-6">
      {/* Page header + current period selector */}
      <div className="page-header">
        <div>
          <h1 className="page-title">Dashboard</h1>
          {/* Current period selector */}
          <div className="flex items-center gap-2 mt-1 relative">
            <Calendar size={13} className="text-ops-muted" />
            <button
              onClick={() => setShowPeriodPicker(v => !v)}
              className="flex items-center gap-1 text-sm text-ops-text hover:text-blue-400 transition-colors"
            >
              <span className="font-semibold">{currentPeriod?.label ?? 'Select period'}</span>
              {currentPeriod && (
                <span className="text-ops-subtle text-xs ml-1">
                  {new Date(currentPeriod.period_start).toLocaleDateString('en-GB', { day: '2-digit', month: 'short' })} –{' '}
                  {new Date(currentPeriod.period_end).toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' })}
                </span>
              )}
              <ChevronDown size={13} className="text-ops-muted" />
            </button>
            {currentPeriod?.is_current && (
              <span className="badge badge-approved text-[10px]">Current</span>
            )}
            {showPeriodPicker && (
              <div
                className="absolute top-7 left-0 z-30 border border-ops-border rounded-lg shadow-xl py-1 min-w-56"
                style={{ backgroundColor: 'var(--ops-surface)' }}
              >
                <div className="px-3 py-1.5 text-[10px] text-ops-subtle uppercase tracking-wider font-semibold border-b border-ops-border mb-1">
                  Switch active period
                </div>
                {periods.map(p => (
                  <button
                    key={p.id}
                    onClick={() => setCurrentPeriod(p.id)}
                    className="w-full flex items-center justify-between px-3 py-1.5 text-sm hover:bg-ops-surface-2 transition-colors text-left"
                  >
                    <span className={p.id === activePeriodId ? 'text-blue-400 font-semibold' : 'text-ops-text'}>
                      {p.label}
                    </span>
                    <div className="flex items-center gap-1">
                      {p.is_current && <span className="badge badge-approved text-[10px]">Current</span>}
                      <span className={`badge ${p.status === 'locked' ? 'badge-approved' : 'badge-pending'} text-[10px]`}>
                        {p.status}
                      </span>
                    </div>
                  </button>
                ))}
                <div className="border-t border-ops-border mt-1 px-3 py-1.5">
                  <span className="text-[10px] text-ops-subtle">
                    Selecting a period sets it as the app-wide default. It does not auto-select the most recent period.
                  </span>
                </div>
              </div>
            )}
          </div>
        </div>
        <div className="flex gap-2">
          <button onClick={() => void loadDashboard()} className="btn-ghost">
            <RefreshCw size={14} /> Refresh
          </button>
          <Link
            href={`/statement-run?domain=master${currentPeriod ? `&period=${currentPeriod.id}` : ''}`}
            className="btn-secondary"
          >
            <Disc3 size={14} /> Master Run
          </Link>
          <Link
            href={`/statement-run?domain=publishing${currentPeriod ? `&period=${currentPeriod.id}` : ''}`}
            className="btn-secondary"
          >
            <FileText size={14} /> Publishing Run
          </Link>
        </div>
      </div>

      {/* Critical exceptions banner */}
      {criticalExceptions.length > 0 && (
        <Alert type="error">
          <div className="flex items-center gap-2 font-semibold mb-1">
            <AlertTriangle size={14} />
            {criticalExceptions.length} critical exception{criticalExceptions.length !== 1 ? 's' : ''} require attention
          </div>
          <div className="space-y-1 mt-2">
            {criticalExceptions.slice(0, 3).map(e => (
              <div key={e.id} className="text-xs opacity-80">• {e.title}</div>
            ))}
            {criticalExceptions.length > 3 && (
              <Link href="/exceptions" className="text-xs text-red-400 hover:underline">
                + {criticalExceptions.length - 3} more →
              </Link>
            )}
          </div>
        </Alert>
      )}

      {/* Stat grid */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
        <StatCard label="Payable Statements"  value={payableRecords.length}    sub={`${approvedRecords.filter(r => r.is_payable).length} approved`} color="green" />
        <StatCard label="Recouping"           value={recoupingRecords.length}  color="amber" />
        <StatCard label="Approved"            value={approvedRecords.length}   sub={`of ${currentRecords.length} total`} color="blue" />
        <StatCard label="Sent"                value={sentRecords.length}       sub={`of ${approvedRecords.length} approved`} color="cyan" />
      </div>

      <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
        <StatCard label="Critical Exceptions" value={criticalExceptions.length}  color={criticalExceptions.length > 0 ? 'red' : 'default'} />
        <StatCard label="Warnings"            value={warningExceptions.length}   color={warningExceptions.length > 0 ? 'amber' : 'default'} />
        <StatCard label="Missing Email (Payable)" value={missingEmailPayable.length} color={missingEmailPayable.length > 0 ? 'red' : 'default'} />
        <StatCard label="Output Missing (Approved)" value={outputMissing.length}  color={outputMissing.length > 0 ? 'amber' : 'default'} />
      </div>

      {/* Payable totals by domain */}
      <div className="grid grid-cols-2 gap-3">
        <div className="card">
          <div className="card-header">
            <span className="text-sm font-semibold text-ops-muted">Master — Payable Total</span>
            <span className="badge-master">Master</span>
          </div>
          <div className="card-body">
            <div className="text-3xl font-bold font-mono text-green-400">
              £{totalPayableMaster.toLocaleString('en-GB', { minimumFractionDigits: 2 })}
            </div>
            <div className="text-xs text-ops-muted mt-1">
              {masterRecords.filter(r => r.is_payable).length} payable statements
            </div>
          </div>
        </div>
        <div className="card">
          <div className="card-header">
            <span className="text-sm font-semibold text-ops-muted">Publishing — Payable Total</span>
            <span className="badge-publishing">Publishing</span>
          </div>
          <div className="card-body">
            <div className="text-3xl font-bold font-mono text-green-400">
              £{totalPayablePublishing.toLocaleString('en-GB', { minimumFractionDigits: 2 })}
            </div>
            <div className="text-xs text-ops-muted mt-1">
              {publishingRecords.filter(r => r.is_payable).length} payable statements
            </div>
          </div>
        </div>
      </div>

      {/* Recent statements + exceptions */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        <div className="card">
          <div className="card-header">
            <span className="text-sm font-semibold">Statements Needing Action</span>
            <Link href="/statements" className="text-xs text-blue-400 hover:underline">View all →</Link>
          </div>
          <div className="overflow-x-auto">
            <table className="ops-table">
              <thead>
                <tr>
                  <th>Payee</th>
                  <th>Domain</th>
                  <th>Status</th>
                  <th>Payable</th>
                </tr>
              </thead>
              <tbody>
                {currentRecords
                  .filter(r => r.approval_status !== 'approved' || r.email_status !== 'sent')
                  .slice(0, 8)
                  .map(r => (
                    <tr key={r.id}>
                      <td>
                        <Link href={`/statements/${r.id}`} className="text-ops-text hover:text-blue-400 font-medium text-xs">
                          {(r.payee as any)?.payee_name ?? '—'}
                        </Link>
                      </td>
                      <td><DomainBadge domain={r.domain} /></td>
                      <td>
                        <div className="flex gap-1 flex-wrap">
                          <PayableBadge record={r} />
                        </div>
                      </td>
                      <td>
                        {r.is_payable ? (
                          <Amount value={r.payable_amount} currency={(r.payee as any)?.currency} />
                        ) : (
                          <span className="text-ops-subtle text-xs">—</span>
                        )}
                      </td>
                    </tr>
                  ))}
                {currentRecords.length === 0 && (
                  <tr>
                    <td colSpan={4} className="text-center text-ops-subtle py-8 text-xs">
                      No statements for current period
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        </div>

        <div className="card">
          <div className="card-header">
            <span className="text-sm font-semibold">Open Exceptions</span>
            <Link href="/exceptions" className="text-xs text-blue-400 hover:underline">View all →</Link>
          </div>
          <div className="overflow-x-auto">
            <table className="ops-table">
              <thead>
                <tr>
                  <th>Severity</th>
                  <th>Issue</th>
                  <th>Domain</th>
                </tr>
              </thead>
              <tbody>
                {exceptions.slice(0, 8).map(e => (
                  <tr key={e.id}>
                    <td><SeverityBadge severity={e.severity} /></td>
                    <td>
                      <div className="text-xs font-medium text-ops-text">{e.title}</div>
                      {(e as any).payee?.payee_name && (
                        <div className="text-xs text-ops-muted">{(e as any).payee.payee_name}</div>
                      )}
                    </td>
                    <td><DomainBadge domain={e.domain} /></td>
                  </tr>
                ))}
                {exceptions.length === 0 && (
                  <tr>
                    <td colSpan={3} className="text-center py-8">
                      <div className="flex flex-col items-center gap-1">
                        <CheckCircle size={20} className="text-green-500" />
                        <span className="text-xs text-ops-muted">No open exceptions</span>
                      </div>
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        </div>
      </div>

      {/* All periods table */}
      <div className="card">
        <div className="card-header">
          <span className="text-sm font-semibold">All Periods</span>
          <span className="text-xs text-ops-muted">Click a period to make it the active dashboard period</span>
        </div>
        <div className="overflow-x-auto">
          <table className="ops-table">
            <thead>
              <tr>
                <th>Period</th>
                <th>Start</th>
                <th>End</th>
                <th>Status</th>
                <th>Master</th>
                <th>Publishing</th>
                <th>Action</th>
              </tr>
            </thead>
            <tbody>
              {periods.map(p => {
                const pRecords  = records.filter(r => r.statement_period_id === p.id)
                const mCount    = pRecords.filter(r => r.domain === 'master').length
                const pubCount  = pRecords.filter(r => r.domain === 'publishing').length
                const isActive  = p.id === activePeriodId
                return (
                  <tr key={p.id} className={isActive ? 'bg-blue-950/20' : ''}>
                    <td>
                      <div className="flex items-center gap-1.5">
                        <span className="font-semibold font-mono text-xs">{p.label}</span>
                        {p.is_current && <span className="badge badge-approved text-[10px]">Current</span>}
                        {isActive && !p.is_current && <span className="badge badge-info text-[10px]">Viewing</span>}
                      </div>
                    </td>
                    <td className="text-xs text-ops-muted">{new Date(p.period_start).toLocaleDateString('en-GB')}</td>
                    <td className="text-xs text-ops-muted">{new Date(p.period_end).toLocaleDateString('en-GB')}</td>
                    <td>
                      <span className={`badge ${p.status === 'locked' ? 'badge-approved' : 'badge-pending'}`}>
                        {p.status}
                      </span>
                    </td>
                    <td className="text-xs">{mCount}</td>
                    <td className="text-xs">{pubCount}</td>
                    <td>
                      <div className="flex gap-1">
                        {!isActive && (
                          <button
                            onClick={() => setActivePeriodId(p.id)}
                            className="btn-ghost btn-sm text-[10px]"
                          >
                            View
                          </button>
                        )}
                        {!p.is_current && (
                          <button
                            onClick={() => setCurrentPeriod(p.id)}
                            className="btn-ghost btn-sm text-[10px]"
                          >
                            Set Current
                          </button>
                        )}
                        <Link href={`/statement-run?domain=master&period=${p.id}`} className="btn-ghost btn-sm text-[10px]">
                          Master
                        </Link>
                        <Link href={`/statement-run?domain=publishing&period=${p.id}`} className="btn-ghost btn-sm text-[10px]">
                          Pub
                        </Link>
                      </div>
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  )
}
