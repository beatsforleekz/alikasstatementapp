'use client'
import { useEffect, useState } from 'react'
import { supabase } from '@/lib/supabase/client'
import { Alert, LoadingSpinner, DomainBadge, Amount } from '@/components/ui'
import { validateBalanceChain, formatCurrency } from '@/lib/utils/balanceEngine'
import { GitMerge, AlertTriangle, CheckCircle, RefreshCw } from 'lucide-react'
import Link from 'next/link'
import type { StatementPeriod } from '@/lib/types'
import { sortByLabel } from '@/lib/utils/sortOptions'

export default function ReconciliationPage() {
  const [loading, setLoading] = useState(true)
  const [periods, setPeriods] = useState<StatementPeriod[]>([])
  const [selectedPeriodId, setSelectedPeriodId] = useState('')
  const [comparePeriodId, setComparePeriodId] = useState('')
  const [records, setRecords] = useState<any[]>([])
  const [compareRecords, setCompareRecords] = useState<any[]>([])
  const [domainFilter, setDomainFilter] = useState('')
  const [error, setError] = useState<string | null>(null)

  useEffect(() => { loadPeriods() }, [])
  useEffect(() => { if (selectedPeriodId) loadRecords() }, [selectedPeriodId, domainFilter])
  useEffect(() => { if (comparePeriodId) loadCompareRecords() }, [comparePeriodId, domainFilter])

  async function loadPeriods() {
    const { data } = await supabase
      .from('statement_periods')
      .select('*')
      .order('year', { ascending: false })
      .order('half', { ascending: false })
    setPeriods(sortByLabel(data ?? [], period => period.label))
    if (data && data.length > 0) {
      setSelectedPeriodId(data[0].id)
      if (data.length > 1) setComparePeriodId(data[1].id)
    }
    setLoading(false)
  }

  async function loadRecords() {
    let q = supabase
      .from('statement_records')
      .select('*, payee:payees(payee_name, currency), contract:contracts(contract_name, contract_code), statement_period:statement_periods(label)')
      .eq('statement_period_id', selectedPeriodId)
    if (domainFilter) q = q.eq('domain', domainFilter)
    const { data } = await q.order('is_payable', { ascending: false })
    setRecords(data ?? [])
  }

  async function loadCompareRecords() {
    if (!comparePeriodId) return
    let q = supabase
      .from('statement_records')
      .select('*, payee:payees(payee_name, currency), contract:contracts(contract_name, contract_code)')
      .eq('statement_period_id', comparePeriodId)
    if (domainFilter) q = q.eq('domain', domainFilter)
    const { data } = await q
    setCompareRecords(data ?? [])
  }

  // Match by contract_id + payee_id — the correct statement unit
  // A payee can have multiple statements in the same period (one per contract)
  function getCompareRecord(contractId: string, payeeId: string) {
    return compareRecords.find(r => r.contract_id === contractId && r.payee_id === payeeId)
  }

  // Chain validation issues across all records
  const chainIssues = records
    .map(r => ({ record: r, check: validateBalanceChain(r) }))
    .filter(x => !x.check.valid)

  // Issued vs payable discrepancies
  const issuedMismatches = records.filter(r =>
    r.issued_amount > 0 &&
    r.payable_amount > 0 &&
    Math.abs(r.issued_amount - r.payable_amount) > 0.01 &&
    !r.override_notes
  )

  // Payable but no carryover confirmed
  const carryoverIssues = records.filter(r =>
    r.carryover_rule_applied && !r.carryover_confirmed_flag
  )

  const selectedPeriod = periods.find(p => p.id === selectedPeriodId)
  const comparePeriod = periods.find(p => p.id === comparePeriodId)

  const totalPayable = records.filter(r => r.is_payable).reduce((s, r) => s + r.payable_amount, 0)
  const totalPayablePrior = compareRecords.filter(r => r.is_payable).reduce((s, r) => s + r.payable_amount, 0)
  const payableDelta = totalPayable - totalPayablePrior

  return (
    <div className="space-y-5">
      <div className="page-header">
        <div>
          <h1 className="page-title">Reconciliation</h1>
          <p className="page-subtitle">Balance chain validation, carryover audit, period comparisons</p>
        </div>
        <button onClick={() => { loadRecords(); loadCompareRecords() }} className="btn-ghost btn-sm">
          <RefreshCw size={13} />
        </button>
      </div>

      {error && <Alert type="error">{error}</Alert>}

      {/* Controls */}
      <div className="card p-4 flex items-end gap-4 flex-wrap">
        <div className="ops-field">
          <label className="ops-label">Current Period</label>
          <select className="ops-select w-36" value={selectedPeriodId} onChange={e => setSelectedPeriodId(e.target.value)}>
            {periods.map(p => <option key={p.id} value={p.id}>{p.label}</option>)}
          </select>
        </div>
        <div className="ops-field">
          <label className="ops-label">Compare To</label>
          <select className="ops-select w-36" value={comparePeriodId} onChange={e => setComparePeriodId(e.target.value)}>
            <option value="">— No comparison —</option>
            {periods.filter(p => p.id !== selectedPeriodId).map(p => (
              <option key={p.id} value={p.id}>{p.label}</option>
            ))}
          </select>
        </div>
        <div className="ops-field">
          <label className="ops-label">Domain</label>
          <select className="ops-select w-36" value={domainFilter} onChange={e => setDomainFilter(e.target.value)}>
            <option value="">All</option>
            <option value="master">Master</option>
            <option value="publishing">Publishing</option>
          </select>
        </div>
      </div>

      {loading ? (
        <div className="flex justify-center py-16"><LoadingSpinner size={22} /></div>
      ) : (
        <>
          {/* Balance chain validation issues */}
          {chainIssues.length > 0 && (
            <div className="card border border-red-800/60">
              <div className="card-header bg-red-950/30">
                <div className="flex items-center gap-2">
                  <AlertTriangle size={14} className="text-red-400" />
                  <span className="text-sm font-semibold text-red-300">Balance Chain Inconsistencies ({chainIssues.length})</span>
                </div>
              </div>
              <div className="divide-y divide-ops-border">
                {chainIssues.map(({ record: r, check }) => (
                  <div key={r.id} className="px-4 py-3">
                    <div className="flex items-center gap-2 mb-1">
                      <span className="text-xs font-medium">{r.payee?.payee_name}</span>
                      {r.contract?.contract_name && <span className="text-xs text-ops-muted">— {r.contract.contract_name}</span>}
                      <DomainBadge domain={r.domain} />
                      <Link href={`/statements/${r.id}`} className="text-xs text-blue-400 hover:underline">View →</Link>
                    </div>
                    {check.issues.map((issue, i) => (
                      <div key={i} className="text-xs text-red-400">• {issue}</div>
                    ))}
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* Issued vs Payable mismatches */}
          {issuedMismatches.length > 0 && (
            <div className="card border border-amber-800/50">
              <div className="card-header bg-amber-950/20">
                <div className="flex items-center gap-2">
                  <AlertTriangle size={14} className="text-amber-400" />
                  <span className="text-sm font-semibold text-amber-300">Issued ≠ Payable (no override notes)</span>
                </div>
              </div>
              <div className="overflow-x-auto">
                <table className="ops-table">
                  <thead>
                    <tr><th>Payee</th><th>Domain</th><th>Payable</th><th>Issued</th><th>Difference</th><th></th></tr>
                  </thead>
                  <tbody>
                    {issuedMismatches.map(r => (
                      <tr key={r.id}>
                        <td className="text-xs font-medium">{r.payee?.payee_name}</td>
                        <td><DomainBadge domain={r.domain} /></td>
                        <td><Amount value={r.payable_amount} currency={r.payee?.currency} size="small" /></td>
                        <td><Amount value={r.issued_amount} currency={r.payee?.currency} size="small" /></td>
                        <td>
                          <span className="text-red-400 font-mono text-xs">
                            {formatCurrency(r.issued_amount - r.payable_amount, r.payee?.currency)}
                          </span>
                        </td>
                        <td><Link href={`/statements/${r.id}`} className="btn-ghost btn-sm">Fix →</Link></td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          )}

          {/* Unconfirmed carryovers */}
          {carryoverIssues.length > 0 && (
            <Alert type="warning">
              <div className="font-semibold mb-1">
                {carryoverIssues.length} statement(s) have carryover applied but not confirmed
              </div>
              <div className="flex flex-wrap gap-2 mt-1">
                {carryoverIssues.map(r => (
                  <Link key={r.id} href={`/statements/${r.id}`} className="text-xs underline hover:text-amber-300">
                    {r.payee?.payee_name}
                  </Link>
                ))}
              </div>
            </Alert>
          )}

          {/* Period comparison summary */}
          {comparePeriodId && (
            <div className="card">
              <div className="card-header">
                <span className="text-sm font-semibold">
                  Period Comparison: {selectedPeriod?.label} vs {comparePeriod?.label}
                </span>
              </div>
              <div className="card-body">
                <div className="grid grid-cols-3 gap-4 mb-4">
                  <div className="text-center">
                    <div className="text-xs text-ops-muted mb-1">Current Payable Total</div>
                    <div className="text-xl font-bold font-mono text-green-400">
                      {formatCurrency(totalPayable)}
                    </div>
                  </div>
                  <div className="text-center">
                    <div className="text-xs text-ops-muted mb-1">Prior Payable Total</div>
                    <div className="text-xl font-bold font-mono text-ops-muted">
                      {formatCurrency(totalPayablePrior)}
                    </div>
                  </div>
                  <div className="text-center">
                    <div className="text-xs text-ops-muted mb-1">Movement</div>
                    <div className={`text-xl font-bold font-mono ${payableDelta >= 0 ? 'text-green-400' : 'text-red-400'}`}>
                      {payableDelta >= 0 ? '+' : ''}{formatCurrency(payableDelta)}
                    </div>
                  </div>
                </div>
              </div>
            </div>
          )}

          {/* Full reconciliation table */}
          <div className="card">
            <div className="card-header">
              <span className="text-sm font-semibold">
                {selectedPeriod?.label} — Full Balance Reconciliation ({records.length} statements)
              </span>
            </div>
            {records.length === 0 ? (
              <div className="p-8 text-center text-xs text-ops-muted">No statements for this period.</div>
            ) : (
              <div className="overflow-x-auto">
                <table className="ops-table">
                  <thead>
                    <tr>
                      <th>Payee</th>
                      <th>Contract</th>
                      <th>Domain</th>
                      <th>Opening</th>
                      <th>Earnings</th>
                      <th>Deductions</th>
                      <th>Closing (pre)</th>
                      <th>Carryover In</th>
                      <th>Final Balance</th>
                      <th>Payable</th>
                      <th>Carry Fwd</th>
                      <th>Issued</th>
                      {comparePeriodId && <th>Prior Final</th>}
                      {comparePeriodId && <th>Movement</th>}
                      <th>Chain ✓</th>
                      <th></th>
                    </tr>
                  </thead>
                  <tbody>
                    {records.map(r => {
                      const prior = getCompareRecord(r.contract_id, r.payee_id)
                      const movement = prior ? r.final_balance_after_carryover - prior.final_balance_after_carryover : null
                      const chainOk = validateBalanceChain(r).valid

                      return (
                        <tr key={r.id} className="group">
                          <td className="text-xs font-medium">{r.payee?.payee_name}</td>
                          <td>
                            <div className="text-xs">{r.contract?.contract_name ?? '—'}</div>
                            {r.contract?.contract_code && <div className="text-[10px] font-mono text-ops-muted">{r.contract.contract_code}</div>}
                          </td>
                          <td><DomainBadge domain={r.domain} /></td>
                          <td><Num val={r.opening_balance} currency={r.payee?.currency} /></td>
                          <td><Num val={r.current_earnings} currency={r.payee?.currency} /></td>
                          <td><Num val={-r.deductions} currency={r.payee?.currency} /></td>
                          <td><Num val={r.closing_balance_pre_carryover} currency={r.payee?.currency} bold /></td>
                          <td>
                            {r.prior_period_carryover_applied !== 0
                              ? <Num val={r.prior_period_carryover_applied} currency={r.payee?.currency} />
                              : <span className="text-ops-subtle text-xs">—</span>}
                          </td>
                          <td><Num val={r.final_balance_after_carryover} currency={r.payee?.currency} bold /></td>
                          <td>
                            {r.is_payable
                              ? <Num val={r.payable_amount} currency={r.payee?.currency} />
                              : <span className="text-ops-subtle text-xs">—</span>}
                          </td>
                          <td>
                            {r.carry_forward_amount > 0
                              ? <span className="text-amber-400 font-mono text-xs">{formatCurrency(r.carry_forward_amount, r.payee?.currency)}</span>
                              : <span className="text-ops-subtle text-xs">—</span>}
                          </td>
                          <td>
                            {r.issued_amount > 0
                              ? <Num val={r.issued_amount} currency={r.payee?.currency} />
                              : <span className="text-ops-subtle text-xs">—</span>}
                          </td>
                          {comparePeriodId && (
                            <td>
                              {prior
                                ? <Num val={prior.final_balance_after_carryover} currency={r.payee?.currency} />
                                : <span className="text-ops-subtle text-xs">—</span>}
                            </td>
                          )}
                          {comparePeriodId && (
                            <td>
                              {movement !== null
                                ? <span className={`font-mono text-xs ${movement > 0 ? 'text-green-400' : movement < 0 ? 'text-red-400' : 'text-ops-muted'}`}>
                                    {movement > 0 ? '+' : ''}{formatCurrency(movement, r.payee?.currency)}
                                  </span>
                                : <span className="text-ops-subtle text-xs">New</span>}
                            </td>
                          )}
                          <td>
                            {chainOk
                              ? <CheckCircle size={13} className="text-green-500" />
                              : <span title="Balance chain inconsistency"><AlertTriangle size={13} className="text-red-400" /></span>}
                          </td>
                          <td>
                            <Link href={`/statements/${r.id}`} className="btn-ghost btn-sm opacity-0 group-hover:opacity-100">→</Link>
                          </td>
                        </tr>
                      )
                    })}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        </>
      )}
    </div>
  )
}

function Num({ val, currency = 'GBP', bold }: { val: number; currency?: string; bold?: boolean }) {
  return (
    <span className={`font-mono text-xs ${val > 0 ? 'text-green-400' : val < 0 ? 'text-red-400' : 'text-ops-muted'} ${bold ? 'font-bold' : ''}`}>
      {formatCurrency(val, currency)}
    </span>
  )
}
