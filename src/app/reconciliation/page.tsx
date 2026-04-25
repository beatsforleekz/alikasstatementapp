'use client'

import { useEffect, useState } from 'react'
import Link from 'next/link'
import { AlertTriangle, CheckCircle, RefreshCw } from 'lucide-react'
import { supabase } from '@/lib/supabase/client'
import { Alert, DomainBadge, LoadingSpinner } from '@/components/ui'
import { validateBalanceChain, formatCurrency } from '@/lib/utils/balanceEngine'
import type { StatementPeriod } from '@/lib/types'
import { isPublishingContractType } from '@/lib/types'
import { buildPublishingAllocationRoutes, type ContractRepertoireAllocationLink } from '@/lib/utils/publishingAllocation'
import { sortByLabel } from '@/lib/utils/sortOptions'

const IMPORT_ROW_FETCH_PAGE_SIZE = 1000
const REFERENCE_FETCH_PAGE_SIZE = 1000

type DomainFilter = '' | 'master' | 'publishing'
type SortOption = 'az' | 'za' | 'highest_payable' | 'lowest_payable' | 'highest_final_balance' | 'highest_movement'
type RecoupFilter = '' | 'recouping' | 'not_recouping'

type ReconRecord = any
type ReconImport = any
type ReconImportRow = any

interface CoverageRow {
  importId: string
  importName: string
  rowCount: number
  currencyLabel: string
  importTotal: number
  grossInScope: number
  onStatements: number
  unmatchedOrError: number
  excluded: number
  roundingAdjustment: number
  difference: number
}

interface SummaryAmount {
  total: number
  currencies: string[]
}

interface UnclassifiedBreakdownRow {
  id: string
  importId: string
  rawRowNumber: number | null
  title: string
  amount: number
  currency: string
  state: string
  reason: string
}

interface RowStatusMeta {
  status: 'Reconciled' | 'Difference' | 'Carry-forward' | 'Manual override' | 'On hold' | 'Needs review'
  tone: 'green' | 'red' | 'amber' | 'slate'
  flags: string[]
  hasMismatch: boolean
}

function isPublishingStatementEligibleRow(
  row: Pick<ReconImportRow, 'domain' | 'match_status' | 'matched_repertoire_id'>,
  linkedRepertoireIds: Set<string>
) {
  if (row.domain !== 'publishing') return row.match_status === 'matched'
  if (row.match_status === 'matched') return true
  return row.match_status === 'partial' &&
    !!row.matched_repertoire_id &&
    linkedRepertoireIds.has(row.matched_repertoire_id)
}

function buildPublishingContractPathSet(
  links: Array<{ repertoire_id: string | null | undefined }>,
  splits: Array<{ repertoire_id: string | null | undefined }>
) {
  return new Set([
    ...links.map(link => link.repertoire_id).filter(Boolean) as string[],
    ...splits.map(split => split.repertoire_id).filter(Boolean) as string[],
  ])
}

function hasLivePublishingContractPath(
  repertoireId: string | null | undefined,
  contracts: any[],
  links: ContractRepertoireAllocationLink[],
  splits: any[],
) {
  if (!repertoireId) return false
  const activePublishingContractIds = new Set(
    contracts
      .filter(contract => contract.status === 'active' && isPublishingContractType(contract.contract_type))
      .map(contract => contract.id)
  )
  return (
    links.some(link => link.repertoire_id === repertoireId && activePublishingContractIds.has(link.contract_id)) ||
    splits.some(split => split.repertoire_id === repertoireId && split.is_active && activePublishingContractIds.has(split.contract_id))
  )
}

function hasLivePublishingAllocationRoute(
  row: ReconImportRow,
  contracts: any[],
  payeeLinks: any[],
  splits: any[],
  links: ContractRepertoireAllocationLink[],
) {
  if (row.domain !== 'publishing' || !row.matched_repertoire_id) return false
  return buildPublishingAllocationRoutes({
    repertoireId: row.matched_repertoire_id,
    incomeType: row.income_type,
    contracts,
    payeeLinks,
    splits,
    contractRepertoireLinks: links,
  }).length > 0
}

function isLiveUnresolvedRow(
  row: ReconImportRow,
  contracts: any[],
  payeeLinks: any[],
  splits: any[],
  links: ContractRepertoireAllocationLink[],
) {
  if (row.domain !== 'publishing') {
    const activeContractIds = new Set(contracts.filter(contract => contract.status === 'active').map(contract => contract.id))
    const hasPayeePath = payeeLinks.some(payeeLink =>
      payeeLink.contract_id === row.matched_contract_id &&
      payeeLink.is_active &&
      Number(payeeLink.royalty_share ?? 1) > 0
    )
    return row.match_status !== 'matched' || !row.matched_contract_id || !activeContractIds.has(row.matched_contract_id) || !hasPayeePath
  }
  if (!row.matched_repertoire_id) return true
  if (row.domain === 'publishing' && !hasLivePublishingContractPath(row.matched_repertoire_id, contracts, links, splits)) {
    return true
  }
  if (row.domain === 'publishing' && !hasLivePublishingAllocationRoute(row, contracts, payeeLinks, splits, links)) {
    return true
  }
  return false
}

function resolveImportRowGross(
  row: Pick<ReconImportRow, 'amount' | 'amount_converted' | 'net_amount' | 'row_type'>,
  importSummary?: Pick<ReconImport, 'exchange_rate'>
) {
  if (row.row_type === 'deduction') return 0
  const hasFx = !!(importSummary?.exchange_rate && importSummary.exchange_rate !== 1)
  if (hasFx && row.amount_converted != null) return Number(row.amount_converted ?? 0)
  return Number(row.net_amount ?? row.amount ?? 0)
}

function defaultCurrencyForDomain(domain: DomainFilter) {
  return domain === 'master' ? 'GBP' : 'EUR'
}

function formatAggregateAmount(
  amount: number,
  currencies: string[],
  fallbackCurrency: string
) {
  const cleanCurrencies = Array.from(new Set(currencies.filter(Boolean)))
  if (amount === 0 || cleanCurrencies.length === 0) {
    return new Intl.NumberFormat('en-GB', {
      style: 'currency',
      currency: fallbackCurrency,
      minimumFractionDigits: 2,
      maximumFractionDigits: 2,
    }).format(0)
  }
  if (cleanCurrencies.length === 1) {
    return new Intl.NumberFormat('en-GB', {
      style: 'currency',
      currency: cleanCurrencies[0],
      minimumFractionDigits: 2,
      maximumFractionDigits: 2,
    }).format(amount)
  }
  return `${amount.toLocaleString('en-GB', { minimumFractionDigits: 2, maximumFractionDigits: 2 })} · mixed currencies`
}

function formatUnclassifiedAmount(amount: number, currencies: string[], fallbackCurrency: string) {
  const displayAmount = Math.round(amount * 100) === 0 ? 0 : amount
  return formatAggregateAmount(displayAmount, currencies, fallbackCurrency)
}

function deriveRowStatus(record: ReconRecord, prior: ReconRecord | undefined): RowStatusMeta {
  const chain = validateBalanceChain(record)
  const issuedMismatch =
    Number(record.issued_amount ?? 0) > 0 &&
    Number(record.payable_amount ?? 0) > 0 &&
    Math.abs(Number(record.issued_amount ?? 0) - Number(record.payable_amount ?? 0)) > 0.01 &&
    !record.override_notes
  const movement = prior
    ? Number(record.final_balance_after_carryover ?? 0) - Number(prior.final_balance_after_carryover ?? 0)
    : null
  const flags: string[] = []

  if (record.manual_override_flag) flags.push('Manual override')
  if (record.hold_payment_flag || record.approval_status === 'on_hold') flags.push('On hold')
  if (record.is_recouping) flags.push('Recouping')
  if (Number(record.carry_forward_amount ?? 0) > 0 && !record.is_recouping) flags.push('Carry forward')
  if (!record.balance_confirmed_flag) flags.push('Balance unconfirmed')
  if (record.carryover_rule_applied && !record.carryover_confirmed_flag) flags.push('Carryover unconfirmed')
  if (record.approval_status !== 'approved') flags.push(`Approval: ${record.approval_status}`)
  if (issuedMismatch) flags.push('Issued/payable mismatch')
  if (!chain.valid) flags.push('Balance chain mismatch')
  if (movement !== null && Math.abs(movement) > 0.01) flags.push(`Movement ${movement > 0 ? 'up' : 'down'}`)

  if (!chain.valid || issuedMismatch) {
    return { status: 'Difference', tone: 'red', flags, hasMismatch: true }
  }
  if (record.manual_override_flag) {
    return { status: 'Manual override', tone: 'amber', flags, hasMismatch: false }
  }
  if (record.hold_payment_flag || record.approval_status === 'on_hold') {
    return { status: 'On hold', tone: 'amber', flags, hasMismatch: false }
  }
  if (Number(record.carry_forward_amount ?? 0) > 0 && !record.is_recouping) {
    return { status: 'Carry-forward', tone: 'amber', flags, hasMismatch: false }
  }
  if (!record.balance_confirmed_flag || (record.carryover_rule_applied && !record.carryover_confirmed_flag) || record.approval_status !== 'approved') {
    return { status: 'Needs review', tone: 'slate', flags, hasMismatch: false }
  }
  return { status: 'Reconciled', tone: 'green', flags, hasMismatch: false }
}

export default function ReconciliationPage() {
  const [loading, setLoading] = useState(true)
  const [refreshing, setRefreshing] = useState(false)
  const [periods, setPeriods] = useState<StatementPeriod[]>([])
  const [selectedPeriodId, setSelectedPeriodId] = useState('')
  const [comparePeriodId, setComparePeriodId] = useState('')
  const [records, setRecords] = useState<ReconRecord[]>([])
  const [compareRecords, setCompareRecords] = useState<ReconRecord[]>([])
  const [imports, setImports] = useState<ReconImport[]>([])
  const [importRows, setImportRows] = useState<ReconImportRow[]>([])
  const [statementedRowIds, setStatementedRowIds] = useState<string[]>([])
  const [roundingAdjustmentTotal, setRoundingAdjustmentTotal] = useState(0)
  const [roundingAdjustmentCount, setRoundingAdjustmentCount] = useState(0)
  const [roundingAdjustmentCurrencies, setRoundingAdjustmentCurrencies] = useState<string[]>([])
  const [roundingAdjustmentsByImport, setRoundingAdjustmentsByImport] = useState<Map<string, number>>(new Map())
  const [roundingRowIds, setRoundingRowIds] = useState<Set<string>>(new Set())
  const [contracts, setContracts] = useState<any[]>([])
  const [payeeLinks, setPayeeLinks] = useState<any[]>([])
  const [splits, setSplits] = useState<any[]>([])
  const [contractRepertoireLinks, setContractRepertoireLinks] = useState<ContractRepertoireAllocationLink[]>([])
  const [domainFilter, setDomainFilter] = useState<DomainFilter>('')
  const [payableOnly, setPayableOnly] = useState(false)
  const [carryForwardOnly, setCarryForwardOnly] = useState(false)
  const [differenceOnly, setDifferenceOnly] = useState(false)
  const [recoupFilter, setRecoupFilter] = useState<RecoupFilter>('')
  const [sortOption, setSortOption] = useState<SortOption>('highest_payable')
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    void loadPeriods()
  }, [])

  useEffect(() => {
    if (!selectedPeriodId) return
    void loadPageData()
  }, [selectedPeriodId, comparePeriodId, domainFilter])

  const fetchAllPaged = async <T,>(
    buildQuery: (from: number, to: number) => PromiseLike<{ data: T[] | null; error: any }>
  ): Promise<T[]> => {
    const rows: T[] = []
    for (let from = 0; ; from += REFERENCE_FETCH_PAGE_SIZE) {
      const to = from + REFERENCE_FETCH_PAGE_SIZE - 1
      const { data, error: queryError } = await buildQuery(from, to)
      if (queryError) throw queryError
      const batch = (data ?? []) as T[]
      rows.push(...batch)
      if (batch.length < REFERENCE_FETCH_PAGE_SIZE) break
    }
    return rows
  }

  const fetchAllImportRows = async (importIds: string[]) => {
    const rows: ReconImportRow[] = []
    for (let from = 0; ; from += IMPORT_ROW_FETCH_PAGE_SIZE) {
      let query = supabase
        .from('import_rows')
        .select('*')
        .in('import_id', importIds)
        .order('import_id')
        .order('raw_row_number')
        .range(from, from + IMPORT_ROW_FETCH_PAGE_SIZE - 1)
      if (domainFilter) query = query.eq('domain', domainFilter)
      const { data, error: queryError } = await query
      if (queryError) throw queryError
      const batch = (data ?? []) as ReconImportRow[]
      rows.push(...batch)
      if (batch.length < IMPORT_ROW_FETCH_PAGE_SIZE) break
    }
    return rows
  }

  async function loadPeriods() {
    try {
      const { data, error: periodsError } = await supabase
        .from('statement_periods')
        .select('*')
        .order('year', { ascending: false })
        .order('half', { ascending: false })
      if (periodsError) throw periodsError
      const sorted = sortByLabel(data ?? [], period => period.label)
      setPeriods(sorted)
      if (sorted.length > 0) {
        setSelectedPeriodId(current => current || sorted[0].id)
        if (sorted.length > 1) {
          setComparePeriodId(current => current || sorted.find(period => period.id !== sorted[0].id)?.id || '')
        }
      }
    } catch (e: any) {
      setError(e.message ?? 'Failed to load periods.')
    } finally {
      setLoading(false)
    }
  }

  async function loadPageData() {
    try {
      setRefreshing(true)
      setError(null)

      let recordQuery = supabase
        .from('statement_records')
        .select('*, payee:payees(payee_name, currency), contract:contracts(contract_name, contract_code), statement_period:statement_periods(label)')
        .eq('statement_period_id', selectedPeriodId)
      if (domainFilter) recordQuery = recordQuery.eq('domain', domainFilter)

      let compareQuery = supabase
        .from('statement_records')
        .select('*, payee:payees(payee_name, currency), contract:contracts(contract_name, contract_code)')
        .eq('statement_period_id', comparePeriodId || '__none__')
      if (domainFilter) compareQuery = compareQuery.eq('domain', domainFilter)

      let importQuery = supabase
        .from('imports')
        .select('id, import_type, domain, source_name, row_count, success_count, source_currency, reporting_currency, exchange_rate')
        .eq('statement_period_id', selectedPeriodId)
      if (domainFilter) importQuery = importQuery.eq('domain', domainFilter)

      const [
        { data: recordData, error: recordError },
        { data: compareData, error: compareError },
        { data: importData, error: importError },
      ] = await Promise.all([
        recordQuery.order('is_payable', { ascending: false }).order('payable_amount', { ascending: false }),
        comparePeriodId ? compareQuery : Promise.resolve({ data: [], error: null } as any),
        importQuery.order('source_name'),
      ])

      if (recordError) throw recordError
      if (compareError) throw compareError
      if (importError) throw importError

      const currentRecords = (recordData ?? []) as ReconRecord[]
      const currentImports = (importData ?? []) as ReconImport[]
      const importIds = currentImports.map(item => item.id)
      const statementIds = currentRecords.map(record => record.id)

      const [rows, links, splits, contracts, payeeLinks, lineRows, microRows] = await Promise.all([
        importIds.length > 0 ? fetchAllImportRows(importIds) : Promise.resolve([] as ReconImportRow[]),
        fetchAllPaged<{ contract_id: string; repertoire_id: string | null; royalty_rate: number | null }>((from, to) =>
          supabase
            .from('contract_repertoire_links')
            .select('contract_id, repertoire_id, royalty_rate')
            .order('repertoire_id')
            .order('contract_id')
            .range(from, to)
        ),
        fetchAllPaged<any>((from, to) =>
          supabase
            .from('contract_repertoire_payee_splits')
            .select('contract_id, repertoire_id, payee_id, split_percent, is_active')
            .eq('is_active', true)
            .order('repertoire_id')
            .order('contract_id')
            .range(from, to)
        ),
        fetchAllPaged<any>((from, to) =>
          supabase
            .from('contracts')
            .select('id, contract_type, status')
            .order('contract_name')
            .range(from, to)
        ),
        fetchAllPaged<any>((from, to) =>
          supabase
            .from('contract_payee_links')
            .select('contract_id, payee_id, royalty_share, is_active')
            .eq('is_active', true)
            .order('contract_id')
            .order('payee_id')
            .range(from, to)
        ),
        statementIds.length > 0
          ? fetchAllPaged<{ source_import_row_id: string | null; notes: string | null; statement_record_id: string; net_amount: number | null; deduction_amount: number | null }>((from, to) =>
              supabase
                .from('statement_line_summaries')
                .select('statement_record_id, source_import_row_id, net_amount, deduction_amount, notes')
                .in('statement_record_id', statementIds)
                .order('statement_record_id')
                .range(from, to)
            )
          : Promise.resolve([] as { source_import_row_id: string | null; notes: string | null; statement_record_id: string; net_amount: number | null; deduction_amount: number | null }[]),
        fetchAllPaged<{ source_import_row_id: string | null; statement_period_id: string; raw_amount: number; currency: string; status: string }>((from, to) => {
          let query = supabase
            .from('micro_allocation_ledger')
            .select('source_import_row_id, statement_period_id, raw_amount, currency, status')
            .eq('statement_period_id', selectedPeriodId)
            .order('carry_key')
            .range(from, to)
          if (domainFilter) query = query.eq('domain', domainFilter)
          return query
        }),
      ])

      setRecords(currentRecords)
      setCompareRecords((compareData ?? []) as ReconRecord[])
      setImports(currentImports)
      setImportRows(rows)
      const statementedSourceRowIds = new Set(lineRows.map(row => row.source_import_row_id).filter(Boolean) as string[])
      setStatementedRowIds(Array.from(statementedSourceRowIds))
      const importIdByRowId = new Map(rows.map(row => [row.id, row.import_id]))
      const roundingByImport = new Map<string, number>()
      const roundingSourceRowIds = new Set<string>()
      const scopedMicroRows = microRows.filter(row =>
        !!row.source_import_row_id &&
        importIdByRowId.has(row.source_import_row_id) &&
        !statementedSourceRowIds.has(row.source_import_row_id)
      )
      for (const row of scopedMicroRows) {
        const importId = row.source_import_row_id ? importIdByRowId.get(row.source_import_row_id) : null
        if (!importId) continue
        roundingSourceRowIds.add(row.source_import_row_id!)
      }
      for (const row of rows) {
        if (!roundingSourceRowIds.has(row.id)) continue
        const importSummary = currentImports.find(item => item.id === row.import_id)
        roundingByImport.set(row.import_id, (roundingByImport.get(row.import_id) ?? 0) + resolveImportRowGross(row, importSummary))
      }
      setRoundingAdjustmentTotal(rows.reduce((sum, row) => roundingSourceRowIds.has(row.id) ? sum + resolveImportRowGross(row, currentImports.find(item => item.id === row.import_id)) : sum, 0))
      setRoundingAdjustmentCount(roundingSourceRowIds.size)
      setRoundingAdjustmentCurrencies(scopedMicroRows.map(row => row.currency))
      setRoundingAdjustmentsByImport(roundingByImport)
      setRoundingRowIds(roundingSourceRowIds)
      setContracts(contracts)
      setPayeeLinks(payeeLinks)
      setSplits(splits)
      setContractRepertoireLinks(
        links.filter(link => !!link.repertoire_id) as ContractRepertoireAllocationLink[]
      )
    } catch (e: any) {
      setError(e.message ?? 'Failed to load reconciliation data.')
      setRecords([])
      setCompareRecords([])
      setImports([])
      setImportRows([])
      setStatementedRowIds([])
      setRoundingAdjustmentTotal(0)
      setRoundingAdjustmentCount(0)
      setRoundingAdjustmentCurrencies([])
      setRoundingAdjustmentsByImport(new Map())
      setRoundingRowIds(new Set())
      setContracts([])
      setPayeeLinks([])
      setSplits([])
      setContractRepertoireLinks([])
    } finally {
      setRefreshing(false)
      setLoading(false)
    }
  }

  const selectedPeriod = periods.find(period => period.id === selectedPeriodId)
  const comparePeriod = periods.find(period => period.id === comparePeriodId)
  const compareMap = new Map(compareRecords.map(record => [`${record.contract_id}:${record.payee_id}`, record]))
  const statementedRowIdSet = new Set(statementedRowIds)

  const [currentSummary, importCoverage, unclassifiedRows] = (() => {
    return buildReconciliationData({
      imports,
      importRows,
      statementedRowIdSet,
      roundingRowIds,
      contracts,
      payeeLinks,
      splits,
      links: contractRepertoireLinks,
      roundingAdjustmentsByImport,
      fallbackCurrency: defaultCurrencyForDomain(domainFilter),
    })
  })()

  const chainIssues = records
    .map(record => ({ record, check: validateBalanceChain(record) }))
    .filter(item => !item.check.valid)

  const issuedMismatches = records.filter(record =>
    Number(record.issued_amount ?? 0) > 0 &&
    Number(record.payable_amount ?? 0) > 0 &&
    Math.abs(Number(record.issued_amount ?? 0) - Number(record.payable_amount ?? 0)) > 0.01 &&
    !record.override_notes
  )

  const carryoverIssues = records.filter(record => record.carryover_rule_applied && !record.carryover_confirmed_flag)

  const enrichedRecords = records.map(record => {
    const prior = compareMap.get(`${record.contract_id}:${record.payee_id}`)
    const movement = prior
      ? Number(record.final_balance_after_carryover ?? 0) - Number(prior.final_balance_after_carryover ?? 0)
      : null
    const status = deriveRowStatus(record, prior)
    return { record, prior, movement, status }
  })

  const filteredRecords = enrichedRecords
    .filter(item => !payableOnly || item.record.is_payable)
    .filter(item => !carryForwardOnly || Number(item.record.carry_forward_amount ?? 0) > 0)
    .filter(item => !differenceOnly || item.status.hasMismatch)
    .filter(item => {
      if (!recoupFilter) return true
      if (recoupFilter === 'recouping') return !!item.record.is_recouping
      return !item.record.is_recouping
    })
    .slice()
    .sort((a, b) => {
      if (sortOption === 'az') return (a.record.payee?.payee_name ?? '').localeCompare(b.record.payee?.payee_name ?? '')
      if (sortOption === 'za') return (b.record.payee?.payee_name ?? '').localeCompare(a.record.payee?.payee_name ?? '')
      if (sortOption === 'lowest_payable') return Number(a.record.payable_amount ?? 0) - Number(b.record.payable_amount ?? 0)
      if (sortOption === 'highest_final_balance') return Number(b.record.final_balance_after_carryover ?? 0) - Number(a.record.final_balance_after_carryover ?? 0)
      if (sortOption === 'highest_movement') return Math.abs(Number(b.movement ?? 0)) - Math.abs(Number(a.movement ?? 0))
      return Number(b.record.payable_amount ?? 0) - Number(a.record.payable_amount ?? 0)
    })

  const currentPayable = records.filter(record => record.is_payable).reduce((sum, record) => sum + Number(record.payable_amount ?? 0), 0)
  const priorPayable = compareRecords.filter(record => record.is_payable).reduce((sum, record) => sum + Number(record.payable_amount ?? 0), 0)
  const payableDelta = currentPayable - priorPayable
  const currentPayableValue = formatAggregateAmount(
    currentPayable,
    records.filter(record => record.is_payable).map(record => record.statement_currency ?? record.payee?.currency ?? defaultCurrencyForDomain(domainFilter)),
    defaultCurrencyForDomain(domainFilter)
  )
  const priorPayableValue = formatAggregateAmount(
    priorPayable,
    compareRecords.filter(record => record.is_payable).map(record => record.statement_currency ?? record.payee?.currency ?? defaultCurrencyForDomain(domainFilter)),
    defaultCurrencyForDomain(domainFilter)
  )
  const payableDeltaValue = formatAggregateAmount(
    payableDelta,
    [
      ...records.filter(record => record.is_payable).map(record => record.statement_currency ?? record.payee?.currency ?? defaultCurrencyForDomain(domainFilter)),
      ...compareRecords.filter(record => record.is_payable).map(record => record.statement_currency ?? record.payee?.currency ?? defaultCurrencyForDomain(domainFilter)),
    ],
    defaultCurrencyForDomain(domainFilter)
  )
  const roundingAdjustmentValue = formatAggregateAmount(
    roundingAdjustmentTotal,
    roundingAdjustmentCurrencies,
    defaultCurrencyForDomain(domainFilter)
  )

  return (
    <div className="space-y-5">
      <div className="page-header">
        <div>
          <h1 className="page-title">Reconciliation</h1>
          <p className="page-subtitle">Check that imports, statements, exclusions, and balances tie out cleanly</p>
        </div>
        <button onClick={() => { void loadPageData() }} className="btn-ghost btn-sm" disabled={refreshing || !selectedPeriodId}>
          <RefreshCw size={13} className={refreshing ? 'animate-spin' : ''} />
        </button>
      </div>

      {error && <Alert type="error">{error}</Alert>}

      <div className="card p-4 flex items-end gap-4 flex-wrap">
        <div className="ops-field">
          <label className="ops-label">Current Period</label>
          <select className="ops-select w-40" value={selectedPeriodId} onChange={e => setSelectedPeriodId(e.target.value)}>
            {periods.map(period => <option key={period.id} value={period.id}>{period.label}</option>)}
          </select>
        </div>
        <div className="ops-field">
          <label className="ops-label">Compare To</label>
          <select className="ops-select w-40" value={comparePeriodId} onChange={e => setComparePeriodId(e.target.value)}>
            <option value="">No comparison</option>
            {periods.filter(period => period.id !== selectedPeriodId).map(period => (
              <option key={period.id} value={period.id}>{period.label}</option>
            ))}
          </select>
        </div>
        <div className="ops-field">
          <label className="ops-label">Domain</label>
          <select className="ops-select w-36" value={domainFilter} onChange={e => setDomainFilter(e.target.value as DomainFilter)}>
            <option value="">All</option>
            <option value="master">Master</option>
            <option value="publishing">Publishing</option>
          </select>
        </div>
        <div className="ops-field">
          <label className="ops-label">Recoupment</label>
          <select className="ops-select w-40" value={recoupFilter} onChange={e => setRecoupFilter(e.target.value as RecoupFilter)}>
            <option value="">All</option>
            <option value="recouping">Recouping</option>
            <option value="not_recouping">Not recouping</option>
          </select>
        </div>
        <div className="ops-field">
          <label className="ops-label">Sort</label>
          <select className="ops-select w-44" value={sortOption} onChange={e => setSortOption(e.target.value as SortOption)}>
            <option value="az">A–Z</option>
            <option value="za">Z–A</option>
            <option value="highest_payable">Highest payable</option>
            <option value="lowest_payable">Lowest payable</option>
            <option value="highest_final_balance">Highest final balance</option>
            <option value="highest_movement">Highest movement</option>
          </select>
        </div>
        <label className="flex items-center gap-2 text-xs text-ops-muted">
          <input type="checkbox" checked={payableOnly} onChange={e => setPayableOnly(e.target.checked)} />
          Payable only
        </label>
        <label className="flex items-center gap-2 text-xs text-ops-muted">
          <input type="checkbox" checked={carryForwardOnly} onChange={e => setCarryForwardOnly(e.target.checked)} />
          Carry-forward only
        </label>
        <label className="flex items-center gap-2 text-xs text-ops-muted">
          <input type="checkbox" checked={differenceOnly} onChange={e => setDifferenceOnly(e.target.checked)} />
          Has difference only
        </label>
      </div>

      {loading ? (
        <div className="flex justify-center py-16"><LoadingSpinner size={22} /></div>
      ) : (
        <>
          <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-6 gap-3">
            <ReconStatCard
              label="Import Total"
              value={formatAggregateAmount(currentSummary.importTotal.total, currentSummary.importTotal.currencies, defaultCurrencyForDomain(domainFilter))}
              sub={`${importRows.length.toLocaleString()} import row(s) in this scope`}
            />
            <ReconStatCard
              label="Gross In Scope"
              value={formatAggregateAmount(currentSummary.grossInScope.total, currentSummary.grossInScope.currencies, defaultCurrencyForDomain(domainFilter))}
              sub="Matched and in live statement scope"
              accent="cyan"
            />
            <ReconStatCard
              label="On Statements"
              value={formatAggregateAmount(currentSummary.onStatements.total, currentSummary.onStatements.currencies, defaultCurrencyForDomain(domainFilter))}
              sub={`${statementedRowIds.length.toLocaleString()} import row(s) written to statements`}
              accent="green"
            />
            <ReconStatCard
              label="Unmatched / Errors"
              value={formatAggregateAmount(currentSummary.unmatchedOrError.total, currentSummary.unmatchedOrError.currencies, defaultCurrencyForDomain(domainFilter))}
              sub="Live unresolved rows"
              accent={currentSummary.unmatchedOrError.total !== 0 ? 'amber' : 'default'}
            />
            <ReconStatCard
              label="Rounding Carry / Micro Ledger"
              value={roundingAdjustmentValue}
              sub={roundingAdjustmentCount > 0
                ? `${roundingAdjustmentCount.toLocaleString()} sub-cent allocation${roundingAdjustmentCount !== 1 ? 's' : ''} captured durably`
                : 'No pending sub-cent allocations'}
              accent={roundingAdjustmentTotal !== 0 ? 'amber' : 'default'}
            />
            <ReconStatCard
              label="Excluded"
              value={formatAggregateAmount(currentSummary.excluded.total, currentSummary.excluded.currencies, defaultCurrencyForDomain(domainFilter))}
              sub="Explicitly excluded rows"
              accent={currentSummary.excluded.total !== 0 ? 'amber' : 'default'}
            />
            <ReconStatCard
              label="Unclassified Difference"
              value={formatUnclassifiedAmount(currentSummary.difference.total, currentSummary.difference.currencies, defaultCurrencyForDomain(domainFilter))}
              sub="Anything not yet explained by a visible bucket"
              accent={currentSummary.difference.total !== 0 ? 'red' : 'default'}
            />
          </div>

          <div className={`card border ${currentSummary.difference.total === 0 ? 'border-green-200 bg-green-50/60' : 'border-amber-200 bg-amber-50/70'}`}>
            <div className="card-header">
              <span className="text-sm font-semibold">Reconciliation Rule</span>
            </div>
            <div className="card-body space-y-2 text-sm">
              <div className="text-ops-text">
                Import Total = On Statements + Unmatched / Errors + Excluded + Rounding Carry / Micro Ledger + Unclassified Difference
              </div>
              <div className="text-xs text-ops-muted">
                {formatAggregateAmount(currentSummary.importTotal.total, currentSummary.importTotal.currencies, defaultCurrencyForDomain(domainFilter))}
                {' = '}
                {formatAggregateAmount(currentSummary.onStatements.total, currentSummary.onStatements.currencies, defaultCurrencyForDomain(domainFilter))}
                {' + '}
                {formatAggregateAmount(currentSummary.unmatchedOrError.total, currentSummary.unmatchedOrError.currencies, defaultCurrencyForDomain(domainFilter))}
                {' + '}
                {formatAggregateAmount(currentSummary.excluded.total, currentSummary.excluded.currencies, defaultCurrencyForDomain(domainFilter))}
                {' + '}
                {roundingAdjustmentValue}
                {' + '}
                {formatUnclassifiedAmount(currentSummary.difference.total, currentSummary.difference.currencies, defaultCurrencyForDomain(domainFilter))}
              </div>
              {roundingAdjustmentTotal !== 0 && <div className="text-xs text-amber-700">Sub-cent allocations are tracked in the micro ledger; pending balances wait there until they release as a payable cent.</div>}
            </div>
          </div>

          {comparePeriodId && (
            <div className="card">
              <div className="card-header">
                <span className="text-sm font-semibold">
                  Statement Movement: {selectedPeriod?.label} vs {comparePeriod?.label}
                </span>
              </div>
              <div className="card-body">
                <div className="grid grid-cols-3 gap-4">
                  <div className="text-center">
                    <div className="text-xs text-ops-muted mb-1">Current payable</div>
                    <div className="text-xl font-bold font-mono text-green-400">{currentPayableValue}</div>
                  </div>
                  <div className="text-center">
                    <div className="text-xs text-ops-muted mb-1">Prior payable</div>
                    <div className="text-xl font-bold font-mono text-ops-muted">{priorPayableValue}</div>
                  </div>
                  <div className="text-center">
                    <div className="text-xs text-ops-muted mb-1">Movement</div>
                    <div className={`text-xl font-bold font-mono ${payableDelta >= 0 ? 'text-green-400' : 'text-red-400'}`}>
                      {payableDelta >= 0 && !payableDeltaValue.startsWith('-') ? '+' : ''}{payableDeltaValue}
                    </div>
                  </div>
                </div>
              </div>
            </div>
          )}

          <div className="card">
            <div className="card-header">
              <span className="text-sm font-semibold">
                Import Coverage ({importCoverage.length} import{importCoverage.length !== 1 ? 's' : ''})
              </span>
            </div>
            {importCoverage.length === 0 ? (
              <div className="p-6 text-xs text-ops-muted">No imports found for this period/domain.</div>
            ) : (
              <div className="overflow-x-auto">
                <table className="ops-table">
                  <thead>
                    <tr>
                      <th>Import</th>
                      <th>Rows</th>
                      <th>Import Total</th>
                      <th>Gross In Scope</th>
                      <th>On Statements</th>
                      <th>Unmatched / Errors</th>
                      <th>Excluded</th>
                      <th>Rounding</th>
                      <th>Unclassified</th>
                    </tr>
                  </thead>
                  <tbody>
                    {importCoverage.map(row => (
                      <tr key={row.importId} className={Math.abs(row.difference) > 0.01 ? 'bg-amber-50/40' : ''}>
                        <td>
                          <div className="text-xs font-medium">{row.importName}</div>
                          <div className="text-[10px] text-ops-muted">{row.currencyLabel}</div>
                        </td>
                        <td className="text-xs text-ops-muted">{row.rowCount.toLocaleString()}</td>
                        <td><Num val={row.importTotal} currency={row.currencyLabel} /></td>
                        <td><Num val={row.grossInScope} currency={row.currencyLabel} /></td>
                        <td><Num val={row.onStatements} currency={row.currencyLabel} /></td>
                        <td><Num val={row.unmatchedOrError} currency={row.currencyLabel} /></td>
                        <td><Num val={row.excluded} currency={row.currencyLabel} /></td>
                        <td><Num val={row.roundingAdjustment} currency={row.currencyLabel} /></td>
                        <td><Num val={row.difference} currency={row.currencyLabel} bold /></td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>

          {unclassifiedRows.length > 0 && (
            <div className="card border border-amber-300">
              <div className="card-header bg-amber-50/70">
                <div className="flex items-center gap-2">
                  <AlertTriangle size={14} className="text-amber-500" />
                  <span className="text-sm font-semibold text-amber-700">
                    Unclassified Difference Breakdown ({unclassifiedRows.length} row{unclassifiedRows.length !== 1 ? 's' : ''})
                  </span>
                </div>
              </div>
              <div className="overflow-x-auto">
                <table className="ops-table">
                  <thead>
                    <tr>
                      <th>Import Row</th>
                      <th>Title</th>
                      <th>Amount</th>
                      <th>Current State</th>
                      <th>Why It Is Unclassified</th>
                    </tr>
                  </thead>
                  <tbody>
                    {unclassifiedRows.map(row => (
                      <tr key={row.id}>
                        <td>
                          <div className="font-mono text-xs">{row.id.slice(0, 8)}</div>
                          <div className="text-[10px] text-ops-muted">
                            {row.rawRowNumber != null ? `source row ${row.rawRowNumber}` : row.importId.slice(0, 8)}
                          </div>
                        </td>
                        <td className="text-xs font-medium">{row.title}</td>
                        <td><Num val={row.amount} currency={row.currency} bold /></td>
                        <td className="text-xs">{row.state}</td>
                        <td className="text-xs text-ops-muted">{row.reason}</td>
                      </tr>
                    ))}
                  </tbody>
                  <tfoot>
                    <tr style={{ borderTop: '2px solid var(--ops-border)' }}>
                      <td colSpan={2} className="text-xs font-semibold text-right pr-3 py-2">Total unclassified</td>
                      <td className="py-2">
                        <Num
                          val={unclassifiedRows.reduce((sum, row) => sum + row.amount, 0)}
                          currency={unclassifiedRows[0]?.currency ?? defaultCurrencyForDomain(domainFilter)}
                          bold
                        />
                      </td>
                      <td colSpan={2}></td>
                    </tr>
                  </tfoot>
                </table>
              </div>
            </div>
          )}

          {chainIssues.length > 0 && (
            <div className="card border border-red-800/30">
              <div className="card-header bg-red-50/70">
                <div className="flex items-center gap-2">
                  <AlertTriangle size={14} className="text-red-500" />
                  <span className="text-sm font-semibold text-red-700">Balance Chain Differences ({chainIssues.length})</span>
                </div>
              </div>
              <div className="divide-y divide-ops-border">
                {chainIssues.map(({ record, check }) => (
                  <div key={record.id} className="px-4 py-3">
                    <div className="flex items-center gap-2 mb-1 flex-wrap">
                      <span className="text-xs font-medium">{record.payee?.payee_name}</span>
                      {record.contract?.contract_name && <span className="text-xs text-ops-muted">· {record.contract.contract_name}</span>}
                      <DomainBadge domain={record.domain} />
                      <Link href={`/statements/${record.id}`} className="text-xs text-blue-500 hover:underline">View</Link>
                    </div>
                    {check.issues.map((issue: string, index: number) => (
                      <div key={index} className="text-xs text-red-500">• {issue}</div>
                    ))}
                  </div>
                ))}
              </div>
            </div>
          )}

          {issuedMismatches.length > 0 && (
            <div className="card border border-amber-300">
              <div className="card-header bg-amber-50/70">
                <div className="flex items-center gap-2">
                  <AlertTriangle size={14} className="text-amber-500" />
                  <span className="text-sm font-semibold text-amber-700">Issued vs Payable Needs Review ({issuedMismatches.length})</span>
                </div>
              </div>
              <div className="overflow-x-auto">
                <table className="ops-table">
                  <thead>
                    <tr>
                      <th>Payee</th>
                      <th>Domain</th>
                      <th>Payable</th>
                      <th>Issued</th>
                      <th>Difference</th>
                      <th></th>
                    </tr>
                  </thead>
                  <tbody>
                    {issuedMismatches.map(record => (
                      <tr key={record.id}>
                        <td className="text-xs font-medium">{record.payee?.payee_name}</td>
                        <td><DomainBadge domain={record.domain} /></td>
                        <td><Num val={Number(record.payable_amount ?? 0)} currency={record.statement_currency ?? record.payee?.currency ?? defaultCurrencyForDomain(domainFilter)} /></td>
                        <td><Num val={Number(record.issued_amount ?? 0)} currency={record.statement_currency ?? record.payee?.currency ?? defaultCurrencyForDomain(domainFilter)} /></td>
                        <td><Num val={Number(record.issued_amount ?? 0) - Number(record.payable_amount ?? 0)} currency={record.statement_currency ?? record.payee?.currency ?? defaultCurrencyForDomain(domainFilter)} /></td>
                        <td><Link href={`/statements/${record.id}`} className="btn-ghost btn-sm">Open</Link></td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          )}

          {carryoverIssues.length > 0 && (
            <Alert type="warning">
              <div className="font-semibold mb-1">
                {carryoverIssues.length} statement{carryoverIssues.length !== 1 ? 's have' : ' has'} carryover applied but not confirmed
              </div>
              <div className="flex flex-wrap gap-2 mt-1">
                {carryoverIssues.map(record => (
                  <Link key={record.id} href={`/statements/${record.id}`} className="text-xs underline hover:text-amber-300">
                    {record.payee?.payee_name}
                  </Link>
                ))}
              </div>
            </Alert>
          )}

          <div className="card">
            <div className="card-header">
              <div className="flex items-center justify-between gap-3 flex-wrap">
                <span className="text-sm font-semibold">
                  {selectedPeriod?.label} Statement Reconciliation ({filteredRecords.length} of {records.length} statements)
                </span>
                <span className="text-xs text-ops-muted">
                  Healthy rows stay neutral; mismatches and overrides are highlighted for review.
                </span>
              </div>
            </div>
            {filteredRecords.length === 0 ? (
              <div className="p-8 text-center text-xs text-ops-muted">No statements match the current filters.</div>
            ) : (
              <div className="overflow-x-auto">
                <table className="ops-table">
                  <thead>
                    <tr>
                      <th>Status</th>
                      <th>Payee</th>
                      <th>Contract</th>
                      <th>Domain</th>
                      <th>Opening</th>
                      <th>Current Income</th>
                      <th>Deductions</th>
                      <th>Pre-Carry Close</th>
                      <th>Carry In</th>
                      <th>Final Balance</th>
                      <th>Payable</th>
                      <th>Carry Fwd</th>
                      <th>Issued</th>
                      {comparePeriodId && <th>Prior Final</th>}
                      {comparePeriodId && <th>Movement</th>}
                      <th>Flags</th>
                      <th></th>
                    </tr>
                  </thead>
                  <tbody>
                    {filteredRecords.map(({ record, prior, movement, status }) => {
                      const currency = record.statement_currency ?? record.payee?.currency ?? defaultCurrencyForDomain(domainFilter)
                      const rowClass = status.hasMismatch
                        ? 'bg-red-50/45'
                        : status.status === 'Manual override'
                          ? 'bg-amber-50/35'
                          : status.status === 'On hold' || status.status === 'Carry-forward'
                            ? 'bg-amber-50/20'
                            : ''

                      return (
                        <tr key={record.id} className={`group ${rowClass}`}>
                          <td><StatusPill status={status.status} tone={status.tone} /></td>
                          <td className="text-xs font-medium">{record.payee?.payee_name}</td>
                          <td>
                            <div className="text-xs">{record.contract?.contract_name ?? '—'}</div>
                            {record.contract?.contract_code && <div className="text-[10px] font-mono text-ops-muted">{record.contract.contract_code}</div>}
                          </td>
                          <td><DomainBadge domain={record.domain} /></td>
                          <td><Num val={Number(record.opening_balance ?? 0)} currency={currency} /></td>
                          <td><Num val={Number(record.current_earnings ?? 0)} currency={currency} /></td>
                          <td><Num val={-Number(record.deductions ?? 0)} currency={currency} /></td>
                          <td><Num val={Number(record.closing_balance_pre_carryover ?? 0)} currency={currency} bold /></td>
                          <td>
                            {Number(record.prior_period_carryover_applied ?? 0) !== 0
                              ? <Num val={Number(record.prior_period_carryover_applied ?? 0)} currency={currency} />
                              : <span className="text-ops-subtle text-xs">—</span>}
                          </td>
                          <td><Num val={Number(record.final_balance_after_carryover ?? 0)} currency={currency} bold /></td>
                          <td>
                            {record.is_payable
                              ? <Num val={Number(record.payable_amount ?? 0)} currency={currency} />
                              : <span className="text-ops-subtle text-xs">—</span>}
                          </td>
                          <td>
                            {Number(record.carry_forward_amount ?? 0) > 0
                              ? <Num val={Number(record.carry_forward_amount ?? 0)} currency={currency} />
                              : <span className="text-ops-subtle text-xs">—</span>}
                          </td>
                          <td>
                            {Number(record.issued_amount ?? 0) > 0
                              ? <Num val={Number(record.issued_amount ?? 0)} currency={currency} />
                              : <span className="text-ops-subtle text-xs">—</span>}
                          </td>
                          {comparePeriodId && (
                            <td>
                              {prior
                                ? <Num val={Number(prior.final_balance_after_carryover ?? 0)} currency={currency} />
                                : <span className="text-ops-subtle text-xs">—</span>}
                            </td>
                          )}
                          {comparePeriodId && (
                            <td>
                              {movement !== null
                                ? <Num val={movement} currency={currency} />
                                : <span className="text-ops-subtle text-xs">New</span>}
                            </td>
                          )}
                          <td>
                            <div className="flex flex-wrap gap-1 max-w-[220px]">
                              {status.flags.length === 0 ? (
                                <span className="text-[10px] text-green-600 flex items-center gap-1">
                                  <CheckCircle size={11} /> Healthy
                                </span>
                              ) : (
                                status.flags.slice(0, 4).map(flag => <MiniFlagPill key={flag} label={flag} />)
                              )}
                            </div>
                          </td>
                          <td>
                            <Link href={`/statements/${record.id}`} className="btn-ghost btn-sm opacity-0 group-hover:opacity-100">Open</Link>
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

function buildReconciliationData({
  imports,
  importRows,
  statementedRowIdSet,
  roundingRowIds,
  contracts,
  payeeLinks,
  splits,
  links,
  roundingAdjustmentsByImport,
  fallbackCurrency,
}: {
  imports: ReconImport[]
  importRows: ReconImportRow[]
  statementedRowIdSet: Set<string>
  roundingRowIds: Set<string>
  contracts: any[]
  payeeLinks: any[]
  splits: any[]
  links: ContractRepertoireAllocationLink[]
  roundingAdjustmentsByImport: Map<string, number>
  fallbackCurrency: string
}) {
  const importById = new Map(imports.map(item => [item.id, item]))
  const linkedRepertoireIds = buildPublishingContractPathSet(links, splits)

  const totals = {
    importTotal: { total: 0, currencies: [] as string[] },
    grossInScope: { total: 0, currencies: [] as string[] },
    onStatements: { total: 0, currencies: [] as string[] },
    unmatchedOrError: { total: 0, currencies: [] as string[] },
    excluded: { total: 0, currencies: [] as string[] },
    difference: { total: 0, currencies: [] as string[] },
  }

  const coverageMap = new Map<string, CoverageRow>()
  const unclassifiedRows: UnclassifiedBreakdownRow[] = []

  const pushAmount = (bucket: SummaryAmount, amount: number, currency: string) => {
    bucket.total += amount
    if (amount !== 0 && currency) bucket.currencies.push(currency)
  }

  for (const row of importRows) {
    const importSummary = importById.get(row.import_id)
    const amount = resolveImportRowGross(row, importSummary)
    const currency = importSummary?.reporting_currency ?? importSummary?.source_currency ?? fallbackCurrency
    const coverage = coverageMap.get(row.import_id) ?? {
      importId: row.import_id,
      importName: importSummary?.source_name ?? importSummary?.import_type ?? row.import_id,
      rowCount: 0,
      currencyLabel: currency,
      importTotal: 0,
      grossInScope: 0,
      onStatements: 0,
      unmatchedOrError: 0,
      excluded: 0,
      roundingAdjustment: 0,
      difference: 0,
    }

    coverage.rowCount += 1
    coverage.importTotal += amount
    pushAmount(totals.importTotal, amount, currency)

    let classified = false
    let state = 'Unclassified'
    let reason = 'Row did not match any visible reconciliation bucket.'

    if (row.excluded_flag) {
      coverage.excluded += amount
      pushAmount(totals.excluded, amount, currency)
      classified = true
    } else if (isLiveUnresolvedRow(row, contracts, payeeLinks, splits, links)) {
      coverage.unmatchedOrError += amount
      pushAmount(totals.unmatchedOrError, amount, currency)
      classified = true
    } else if (roundingRowIds.has(row.id)) {
      coverage.roundingAdjustment += amount
      classified = true
    } else if (isPublishingStatementEligibleRow(row, linkedRepertoireIds)) {
      coverage.grossInScope += amount
      pushAmount(totals.grossInScope, amount, currency)
      state = 'In scope but not written'
      reason = 'Row is matched and has a live setup path, but it is not on statement lines, Sales Errors, Excluded, or Rounding Carry.'
    }

    if (statementedRowIdSet.has(row.id)) {
      coverage.onStatements += amount
      pushAmount(totals.onStatements, amount, currency)
      classified = true
    }

    if (!classified && amount !== 0) {
      unclassifiedRows.push({
        id: row.id,
        importId: row.import_id,
        rawRowNumber: row.raw_row_number ?? null,
        title: row.title_raw ?? row.identifier_raw ?? '(untitled)',
        amount,
        currency,
        state,
        reason,
      })
    }

    coverageMap.set(row.import_id, coverage)
  }

  const coverageRows = Array.from(coverageMap.values())
    .map(row => ({
      ...row,
      roundingAdjustment: row.roundingAdjustment || roundingAdjustmentsByImport.get(row.importId) || 0,
      difference: row.importTotal - row.onStatements - row.unmatchedOrError - row.excluded - (row.roundingAdjustment || roundingAdjustmentsByImport.get(row.importId) || 0),
    }))
    .sort((a, b) => a.importName.localeCompare(b.importName))

  for (const row of coverageRows) {
    pushAmount(totals.difference, row.difference, row.currencyLabel)
  }

  return [totals, coverageRows, unclassifiedRows] as const
}

function ReconStatCard({
  label,
  value,
  sub,
  accent = 'default',
}: {
  label: string
  value: string
  sub?: string
  accent?: 'default' | 'green' | 'amber' | 'red' | 'cyan'
}) {
  const tone = accent === 'green'
    ? 'border-green-200 bg-green-50/70'
    : accent === 'amber'
      ? 'border-amber-200 bg-amber-50/70'
      : accent === 'red'
        ? 'border-red-200 bg-red-50/70'
        : accent === 'cyan'
          ? 'border-cyan-200 bg-cyan-50/70'
          : 'border-ops-border bg-white'

  return (
    <div className={`card border ${tone}`}>
      <div className="card-body space-y-1">
        <div className="text-[11px] uppercase tracking-wide text-ops-muted">{label}</div>
        <div className="text-lg font-semibold font-mono text-ops-text">{value}</div>
        {sub && <div className="text-[11px] text-ops-muted">{sub}</div>}
      </div>
    </div>
  )
}

function StatusPill({ status, tone }: { status: string; tone: RowStatusMeta['tone'] }) {
  const cls = tone === 'green'
    ? 'bg-green-100 text-green-700 border-green-200'
    : tone === 'red'
      ? 'bg-red-100 text-red-700 border-red-200'
      : tone === 'amber'
        ? 'bg-amber-100 text-amber-700 border-amber-200'
        : 'bg-slate-100 text-slate-700 border-slate-200'
  return <span className={`inline-flex items-center rounded-full border px-2 py-1 text-[10px] font-semibold ${cls}`}>{status}</span>
}

function MiniFlagPill({ label }: { label: string }) {
  return (
    <span className="inline-flex items-center rounded-full border border-ops-border bg-ops-surface px-2 py-1 text-[10px] text-ops-muted">
      {label}
    </span>
  )
}

function Num({ val, currency = 'GBP', bold }: { val: number; currency?: string; bold?: boolean }) {
  return (
    <span className={`font-mono text-xs ${val > 0 ? 'text-green-600' : val < 0 ? 'text-red-500' : 'text-ops-muted'} ${bold ? 'font-bold' : ''}`}>
      {formatCurrency(val, currency)}
    </span>
  )
}
