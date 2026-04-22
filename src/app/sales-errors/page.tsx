'use client'
import { useEffect, useState, useCallback, useRef } from 'react'
import { supabase } from '@/lib/supabase/client'
import {
  Alert, LoadingSpinner, DomainBadge, EmptyState, StatCard, getNoticePanelStyle,
} from '@/components/ui'
import {
  AlertTriangle, CheckCircle, RefreshCw, Search, Link2, Play,
  ExternalLink, X, Plus,
} from 'lucide-react'
import Link from 'next/link'
import { useSearchParams } from 'next/navigation'
import { processImportRow } from '@/lib/utils/matchingEngine'
import { isPublishingContractType, type Repertoire, type Contract } from '@/lib/types'
import {
  buildPublishingAllocationRoutes,
  type ContractRepertoireAllocationLink,
} from '@/lib/utils/publishingAllocation'
import { sortByLabel } from '@/lib/utils/sortOptions'

// ── Types ─────────────────────────────────────────────────────────────────────

const SALES_ERRORS_PAGE_SIZE = 50
const SALES_ERRORS_FETCH_PAGE_SIZE = 1000

interface ImportRow {
  id: string
  import_id: string
  raw_row_number: number
  domain: 'master' | 'publishing'
  statement_period_id: string | null
  payee_name_raw: string | null
  contract_name_raw: string | null
  artist_name_raw?: string | null
  title_raw: string | null
  identifier_raw: string | null
  tempo_id?: string | null
  income_type: string | null
  amount: number | null
  currency: string | null
  amount_converted: number | null
  converted_currency: string | null
  match_status: 'unmatched' | 'matched' | 'partial' | 'manual_override'
  matched_repertoire_id: string | null
  matched_contract_id: string | null
  matched_payee_id: string | null
  error_flag: boolean
  error_reason: string | null
  warning_flag: boolean
  warning_reason: string | null
  excluded_flag: boolean
  exclusion_reason?: string | null
}

interface ImportRecord {
  id: string
  source_name: string | null
  domain: 'master' | 'publishing'
  statement_period_id: string | null
  imported_at: string
  row_count: number
  import_status: string
  statement_period?: { label: string } | null
}

type ErrorType = 'excluded' | 'unmatched_repertoire' | 'missing_contract' | 'missing_allocation'

/**
 * Derive the actionable error type from a row's matching state.
 *
 * Source of truth for contract resolution is contract_repertoire_links,
 * NOT matched_contract_id on the import row. A row whose matched repertoire
 * work already has one or more active contract_repertoire_links must NOT be
 * classified as missing_contract, even if matched_contract_id is null on the
 * import row itself (stale / not yet back-filled).
 */
function hasContractPath(
  repertoireId: string | null | undefined,
  contracts: Contract[],
  contractRepertoireLinks: ContractRepertoireAllocationLink[],
  splits: any[] = [],
): boolean {
  if (!repertoireId) return false
  const activePublishingContractIds = new Set(
    contracts
      .filter(contract => contract.status === 'active' && isPublishingContractType(contract.contract_type))
      .map(contract => contract.id)
  )
  return (
    contractRepertoireLinks.some(link =>
      link.repertoire_id === repertoireId &&
      activePublishingContractIds.has(link.contract_id)
    ) ||
    splits.some((split: any) =>
      split.repertoire_id === repertoireId &&
      split.is_active &&
      activePublishingContractIds.has(split.contract_id)
    )
  )
}

function hasPublishingAllocationRoute(
  row: ImportRow,
  contracts: Contract[],
  payeeLinks: any[],
  splits: any[],
  contractRepertoireLinks: ContractRepertoireAllocationLink[],
): boolean {
  if (row.domain !== 'publishing' || !row.matched_repertoire_id) return false

  return buildPublishingAllocationRoutes({
    repertoireId: row.matched_repertoire_id,
    incomeType: row.income_type,
    contracts,
    payeeLinks,
    splits,
    contractRepertoireLinks,
  }).length > 0
}

function getMissingAllocationReason(
  row: ImportRow,
  contracts: Contract[],
  payeeLinks: any[],
  splits: any[],
  contractRepertoireLinks: ContractRepertoireAllocationLink[],
): string | null {
  if (row.domain !== 'publishing' || !row.matched_repertoire_id) return null

  const activePublishingContractIds = new Set(
    contracts
      .filter(contract => contract.status === 'active' && isPublishingContractType(contract.contract_type))
      .map(contract => contract.id)
  )

  const linkedContractIds = contractRepertoireLinks
    .filter(link =>
      link.repertoire_id === row.matched_repertoire_id &&
      activePublishingContractIds.has(link.contract_id)
    )
    .map(link => link.contract_id)

  const splitContractIds = splits
    .filter((split: any) =>
      split.repertoire_id === row.matched_repertoire_id &&
      split.is_active &&
      activePublishingContractIds.has(split.contract_id)
    )
    .map((split: any) => split.contract_id)

  const contractIds = Array.from(new Set([...linkedContractIds, ...splitContractIds]))
  if (contractIds.length === 0) return null

  const hasActivePayeeLink = contractIds.some(contractId =>
    payeeLinks.some((payeeLink: any) =>
      payeeLink.contract_id === contractId &&
      payeeLink.is_active &&
      Number(payeeLink.royalty_share ?? 0) > 0
    )
  )

  if (!hasActivePayeeLink) {
    return 'No active payee is linked to the contract yet.'
  }

  return 'The work is linked, but the current contract/share setup still does not create a payout route.'
}

function buildCreateContractHref(row: ImportRow) {
  const params = new URLSearchParams()
  params.set('create', '1')
  params.set('source', 'sales-errors')
  if (row.raw_row_number != null) params.set('row', String(row.raw_row_number))
  if (row.title_raw) {
    params.set('title', row.title_raw)
    params.set('contract_name', row.contract_name_raw?.trim() || row.title_raw)
  } else if (row.contract_name_raw?.trim()) {
    params.set('contract_name', row.contract_name_raw.trim())
  }
  if (row.payee_name_raw) params.set('payee', row.payee_name_raw)
  if (row.identifier_raw) {
    params.set('identifier', row.identifier_raw)
    params.set('source_reference', row.identifier_raw)
  }
  params.set('returnTo', `/sales-errors?resolve=${row.id}`)
  const notes = [
    row.title_raw ? `Created from Sales Error row ${row.raw_row_number}: ${row.title_raw}` : `Created from Sales Error row ${row.raw_row_number}`,
    row.payee_name_raw ? `Payee: ${row.payee_name_raw}` : null,
    row.identifier_raw ? `Identifier: ${row.identifier_raw}` : null,
    row.income_type ? `Income type: ${row.income_type}` : null,
  ].filter(Boolean).join(' | ')
  if (notes) params.set('notes', notes)
  return `/contracts?${params.toString()}`
}

function getErrorType(
  row: ImportRow,
  contracts: Contract[],
  payeeLinks: any[],
  splits: any[],
  contractRepertoireLinks: ContractRepertoireAllocationLink[],
): ErrorType | null {
  if (row.excluded_flag) return 'excluded'
  if (!row.matched_repertoire_id) return 'unmatched_repertoire'
  if (row.domain === 'publishing' && !hasContractPath(row.matched_repertoire_id, contracts, contractRepertoireLinks, splits)) {
    return 'missing_contract'
  }
  if (row.domain === 'publishing' && !hasPublishingAllocationRoute(row, contracts, payeeLinks, splits, contractRepertoireLinks)) {
    return 'missing_allocation'
  }
  return null
}

function getPublishingIdentifierLabel(rep: Repertoire | null | undefined): string {
  if (!rep) return '—'
  return (rep as any).tempo_id || rep.iswc || rep.isrc || rep.source_id || '—'
}

function normalizeOpsIdentifier(value: string | null | undefined): string {
  return (value ?? '').trim().replace(/[-\s.]/g, '').toUpperCase()
}

function looksLikeISWC(value: string | null | undefined): boolean {
  return /^T[-\s]?[\d]{3}[.\s]?[\d]{3}[.\s]?[\d]{3}[-\s]?[\d]$/i.test((value ?? '').trim())
}

function getRowTempoId(row: ImportRow): string {
  const explicitTempo = normalizeOpsIdentifier((row as any).tempo_id)
  if (explicitTempo) return explicitTempo
  const rawIdentifier = row.identifier_raw ?? null
  if (!rawIdentifier || looksLikeISWC(rawIdentifier)) return ''
  return normalizeOpsIdentifier(rawIdentifier)
}

function hasTempoIdentifierConflict(row: ImportRow, repertoire: Repertoire[]): boolean {
  if (row.domain !== 'publishing' || !row.matched_repertoire_id) return false
  const rowTempo = getRowTempoId(row)
  if (!rowTempo) return false
  const rep = repertoire.find(item => item.id === row.matched_repertoire_id)
  if (!rep) return false
  const repTempo = normalizeOpsIdentifier((rep as any).tempo_id)
  return !!repTempo && repTempo !== rowTempo
}

function getUnmatchedLabel(row: ImportRow, duplicateTitleIds: Set<string>): string {
  const reason = row.error_reason?.toLowerCase() ?? ''
  if (duplicateTitleIds.has(row.id)) return 'Duplicate title – multiple identifiers'
  if (reason.includes('duplicate title')) return 'Duplicate title – multiple matches'
  if (reason.includes('ambiguous - identifier mismatch')) return 'Ambiguous – identifier mismatch'
  return 'Unmatched'
}

// ── Main page ─────────────────────────────────────────────────────────────────

export default function SalesErrorsPage() {
  const searchParams = useSearchParams()
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [successMsg, setSuccessMsg] = useState<string | null>(null)

  // Reference data
  const [repertoire, setRepertoire] = useState<Repertoire[]>([])
  const [contracts, setContracts] = useState<Contract[]>([])
  const [payees, setPayees] = useState<any[]>([])
  const [payeeLinks, setPayeeLinks] = useState<any[]>([])
  const [aliases, setAliases] = useState<any[]>([])
  const [splits, setSplits] = useState<any[]>([])
  const [contractRepertoireLinks, setContractRepertoireLinks] = useState<ContractRepertoireAllocationLink[]>([])

  // Imports with errors
  const [imports, setImports] = useState<ImportRecord[]>([])
  const [errorRows, setErrorRows] = useState<ImportRow[]>([])

  // Filters
  const [domainFilter, setDomainFilter] = useState<'' | 'master' | 'publishing'>('')
  const [typeFilter, setTypeFilter] = useState<'' | 'excluded' | 'unmatched_repertoire' | 'missing_contract' | 'missing_allocation'>('')
  const [importFilter, setImportFilter] = useState('')
  const [currentPage, setCurrentPage] = useState(1)

  // Selection
  const [selected, setSelected] = useState<Set<string>>(new Set())

  // Active resolution panel
  const [resolvingRow, setResolvingRow] = useState<ImportRow | null>(null)
  const [resolveType, setResolveType] = useState<ErrorType | null>(null)
  const [openCreateWork, setOpenCreateWork] = useState(false)

  // Bulk match to work panel
  const [showBulkMatch, setShowBulkMatch] = useState(false)

  // Re-run state
  const [reRunning, setReRunning] = useState(false)
  const [reRunProgress, setReRunProgress] = useState<string | null>(null)
  const resolveRowId = searchParams.get('resolve')

  useEffect(() => { loadAll() }, [])

  // Auto-clears success message once it has been set; the banner dismisses itself
  // so stale "Refreshing…" text never lingers after the list has already updated.
  const successTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  function flashSuccess(msg: string) {
    setSuccessMsg(msg)
    if (successTimerRef.current) clearTimeout(successTimerRef.current)
    successTimerRef.current = setTimeout(() => setSuccessMsg(null), 3000)
  }

  const fetchAllPaged = async <T,>(
    buildQuery: (from: number, to: number) => PromiseLike<{ data: T[] | null; error: any }>
  ): Promise<T[]> => {
    const rows: T[] = []
    for (let from = 0; ; from += SALES_ERRORS_FETCH_PAGE_SIZE) {
      const to = from + SALES_ERRORS_FETCH_PAGE_SIZE - 1
      const { data, error } = await buildQuery(from, to)
      if (error) throw error
      const batch = (data ?? []) as T[]
      rows.push(...batch)
      if (batch.length < SALES_ERRORS_FETCH_PAGE_SIZE) break
    }
    return rows
  }

  async function fetchRefData() {
    const [rpRes, coRes, pyRes, plRes, alRes, spRes, crlRes] = await Promise.all([
      fetchAllPaged<Repertoire>((from, to) =>
        supabase
          .from('repertoire')
          .select('*')
          .order('title')
          .range(from, to)
      ),
      fetchAllPaged<Contract>((from, to) =>
        supabase.from('contracts').select('*').eq('status', 'active').order('contract_name').range(from, to)
      ),
      supabase.from('payees').select('*').eq('active_status', true),
      fetchAllPaged<any>((from, to) =>
        supabase
          .from('contract_payee_links')
          .select('*')
          .eq('is_active', true)
          .order('contract_id')
          .order('payee_id')
          .range(from, to)
      ),
      supabase.from('payee_aliases').select('*').eq('is_active', true),
      fetchAllPaged<any>((from, to) =>
        supabase
          .from('contract_repertoire_payee_splits')
          .select('*')
          .eq('is_active', true)
          .order('repertoire_id')
          .order('contract_id')
          .range(from, to)
      ),
      // Fetch ALL contract_repertoire_links — any row for a repertoire_id means
      // that work has a linked contract. No is_active column exists on this table.
      fetchAllPaged<ContractRepertoireAllocationLink>((from, to) =>
        supabase
          .from('contract_repertoire_links')
          .select('contract_id,repertoire_id,royalty_rate')
          .order('repertoire_id')
          .order('contract_id')
          .range(from, to)
      ),
    ])
    const fresh = {
      repertoire:              rpRes,
      contracts:               coRes,
      payees:                  pyRes.data ?? [],
      payeeLinks:              plRes,
      aliases:                 alRes.data ?? [],
      splits:                  spRes,
      contractRepertoireLinks: crlRes,
    }
    setRepertoire(sortByLabel(fresh.repertoire, rep => rep.title))
    setContracts(sortByLabel(fresh.contracts, contract => contract.contract_name))
    setPayees(sortByLabel(fresh.payees, payee => payee.payee_name))
    setPayeeLinks(fresh.payeeLinks)
    setAliases(fresh.aliases)
    setSplits(fresh.splits)
    setContractRepertoireLinks(fresh.contractRepertoireLinks)
    return fresh
  }

  async function loadAll() {
    setLoading(true)
    await fetchRefData()
    await loadErrorRows()
    setLoading(false)
  }

  async function loadErrorRows() {
    // 1. Rows with no repertoire match (truly unmatched)
    let unmatchedRows: ImportRow[]
    try {
      unmatchedRows = await fetchAllPaged<ImportRow>((from, to) =>
        supabase
          .from('import_rows')
          .select('*')
          .in('match_status', ['unmatched', 'partial'])
          .is('matched_repertoire_id', null)
          .order('import_id')
          .order('raw_row_number')
          .range(from, to)
      )
    } catch (rowErr: any) {
      setError(rowErr.message)
      return
    }

    // 2. Rows with a repertoire match but no contract on the import row.
    //    We fetch all such rows and then filter client-side against
    //    contract_repertoire_links — rows whose matched repertoire work already
    //    has an active contract link are suppressed (false Missing Contract).
    //    We rely on the contractRepertoireLinks already loaded in state; if
    //    this function is called standalone (e.g. after a resolve) the caller
    //    must ensure ref data is fresh, or we re-fetch here.
    const candidateErrorRows = await fetchAllPaged<ImportRow>((from, to) =>
      supabase
        .from('import_rows')
        .select('*')
        .not('matched_repertoire_id', 'is', null)
        .order('import_id')
        .order('raw_row_number')
        .range(from, to)
    )

    // Fetch fresh publishing allocation refs so rows that are linked to a work
    // but still cannot allocate do not disappear from both statements and errors.
    const [
      freshLinks,
      freshContracts,
      freshPayeeLinks,
      freshSplits,
    ] = await Promise.all([
      fetchAllPaged<ContractRepertoireAllocationLink>((from, to) =>
        supabase
          .from('contract_repertoire_links')
          .select('contract_id,repertoire_id,royalty_rate')
          .order('repertoire_id')
          .order('contract_id')
          .range(from, to)
      ),
      fetchAllPaged<Contract>((from, to) =>
        supabase.from('contracts').select('*').eq('status', 'active').order('contract_name').range(from, to)
      ),
      fetchAllPaged<any>((from, to) =>
        supabase
          .from('contract_payee_links')
          .select('*')
          .eq('is_active', true)
          .order('contract_id')
          .order('payee_id')
          .range(from, to)
      ),
      fetchAllPaged<any>((from, to) =>
        supabase
          .from('contract_repertoire_payee_splits')
          .select('*')
          .eq('is_active', true)
          .order('repertoire_id')
          .order('contract_id')
          .range(from, to)
      ),
    ])

    const activeLinks = freshLinks
    const activeContracts = freshContracts
    const activePayeeLinks = freshPayeeLinks
    const activeSplits = freshSplits

    // Update state so the rest of the UI is consistent
    setContracts(sortByLabel(activeContracts, contract => contract.contract_name))
    setPayeeLinks(activePayeeLinks)
    setSplits(activeSplits)
    setContractRepertoireLinks(activeLinks)

    const classifiedRows = (candidateErrorRows ?? []).filter(
      (row: ImportRow) =>
        getErrorType(row, activeContracts, activePayeeLinks, activeSplits, activeLinks) !== null,
    )

    const allRows = [
      ...unmatchedRows,
      ...classifiedRows,
    ]
    const uniqueRows = Array.from(
      new Map(allRows.map(r => [r.id, r])).values(),
    ) as ImportRow[]
    setErrorRows(uniqueRows)

    // Load import records for these rows
    const importIds = Array.from(new Set(uniqueRows.map(r => r.import_id)))
    if (importIds.length > 0) {
      const { data: imps } = await supabase
        .from('imports')
        .select('*, statement_period:statement_periods(label)')
        .in('id', importIds)
        .order('imported_at', { ascending: false })
      setImports((imps ?? []) as ImportRecord[])
    } else {
      setImports([])
    }
  }

  // ── Filters ────────────────────────────────────────────────────────────────

  const filtered = errorRows.filter(row => {
    if (domainFilter && row.domain !== domainFilter) return false
    if (importFilter && row.import_id !== importFilter) return false
    if (typeFilter) {
      const et = getErrorType(row, contracts, payeeLinks, splits, contractRepertoireLinks)
      if (et !== typeFilter) return false
    }
    return true
  })
  const totalFiltered = filtered.length
  const totalPages = Math.max(1, Math.ceil(totalFiltered / SALES_ERRORS_PAGE_SIZE))
  const safeCurrentPage = Math.min(currentPage, totalPages)
  const pageStart = totalFiltered === 0 ? 0 : (safeCurrentPage - 1) * SALES_ERRORS_PAGE_SIZE
  const pageEnd = Math.min(pageStart + SALES_ERRORS_PAGE_SIZE, totalFiltered)
  const visibleRows = filtered.slice(pageStart, pageEnd)
  const resolveErrorAmount = (row: ImportRow) => row.amount_converted ?? row.amount ?? 0
  const filteredErrorAmount = filtered.reduce((sum, row) => sum + resolveErrorAmount(row), 0)
  const totalErrorAmount = errorRows.reduce((sum, row) => sum + resolveErrorAmount(row), 0)

  const duplicateTitleIds = (() => {
    const byTitle = new Map<string, { ids: string[]; identifiers: Set<string> }>()
    for (const row of errorRows) {
      if (row.domain !== 'publishing' || row.matched_repertoire_id || !(row.title_raw ?? '').trim()) continue
      const titleKey = row.title_raw!.trim().toLowerCase()
      const entry = byTitle.get(titleKey) ?? { ids: [], identifiers: new Set<string>() }
      entry.ids.push(row.id)
      entry.identifiers.add((row.identifier_raw ?? '').trim() || `row:${row.raw_row_number}`)
      byTitle.set(titleKey, entry)
    }
    const flagged = new Set<string>()
    for (const entry of Array.from(byTitle.values())) {
      if (entry.ids.length > 1 && entry.identifiers.size > 1) {
        entry.ids.forEach((id: string) => flagged.add(id))
      }
    }
    return flagged
  })()

  const unmatchedCount = errorRows.filter(
    r => getErrorType(r, contracts, payeeLinks, splits, contractRepertoireLinks) === 'unmatched_repertoire',
  ).length
  const missingContractCount = errorRows.filter(
    r => getErrorType(r, contracts, payeeLinks, splits, contractRepertoireLinks) === 'missing_contract',
  ).length
  const missingAllocationCount = errorRows.filter(
    r => getErrorType(r, contracts, payeeLinks, splits, contractRepertoireLinks) === 'missing_allocation',
  ).length
  const excludedCount = errorRows.filter(
    r => getErrorType(r, contracts, payeeLinks, splits, contractRepertoireLinks) === 'excluded',
  ).length

  useEffect(() => {
    setCurrentPage(1)
  }, [domainFilter, typeFilter, importFilter, errorRows.length])

  useEffect(() => {
    if (currentPage > totalPages) {
      setCurrentPage(totalPages)
    }
  }, [currentPage, totalPages])

  // ── Selection ──────────────────────────────────────────────────────────────

  function toggleSelect(id: string) {
    setSelected(prev => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  function selectAll() {
    setSelected(new Set(filtered.map(r => r.id)))
  }

  function clearSelection() {
    setSelected(new Set())
  }

  // ── Re-run matching ────────────────────────────────────────────────────────
  // Shared engine: fetches fresh ref data, re-processes given row IDs, updates DB.
  // Pass `null` to process all current error rows.

  async function runReMatch(idsToProcess: string[] | null) {
    const ids = idsToProcess ?? errorRows.map(r => r.id)
    if (ids.length === 0) return 0

    // Always fetch fresh ref data — never use potentially stale state
    const fresh = await fetchRefData()

    // Fetch the actual import_row records from DB
    // Process in chunks to avoid URL-length limits
    const CHUNK = 200
    let rowsToMatch: ImportRow[] = []
    for (let i = 0; i < ids.length; i += CHUNK) {
      const { data } = await supabase
        .from('import_rows')
        .select('*')
        .in('id', ids.slice(i, i + CHUNK))
      if (data) rowsToMatch = rowsToMatch.concat(data as ImportRow[])
    }

    if (rowsToMatch.length === 0) return 0

    // A work has a linked contract if ANY row exists in contract_repertoire_links
    // for its repertoire_id — no is_active column exists on this table.
    let updatedCount = 0
    const BATCH = 50
    for (let i = 0; i < rowsToMatch.length; i += BATCH) {
      const batch = rowsToMatch.slice(i, i + BATCH)
      setReRunProgress(`Processing ${Math.min(i + BATCH, rowsToMatch.length)} / ${rowsToMatch.length}…`)

      for (const r of batch) {
        if (r.matched_repertoire_id) {
          const hasLink = hasContractPath(r.matched_repertoire_id, fresh.contracts, fresh.contractRepertoireLinks, fresh.splits)
          const { error: upErr } = await supabase.from('import_rows').update({
            matched_repertoire_id: r.matched_repertoire_id,
            match_status: hasLink ? 'matched' : 'partial',
            error_flag: false,
            error_reason: null,
            warning_flag: !hasLink,
            warning_reason: !hasLink ? 'Matched to repertoire but no active publishing contract path exists yet.' : null,
          }).eq('id', r.id)
          if (!upErr) updatedCount++
          continue
        }

        const result = processImportRow(
          r,
          fresh.payees,
          fresh.contracts,
          fresh.payeeLinks,
          fresh.aliases,
          fresh.repertoire,
          fresh.splits,
        )

        const repId = result.matched_repertoire_id
        const hasLink = hasContractPath(repId, fresh.contracts, fresh.contractRepertoireLinks, fresh.splits)
        const { error: upErr } = await supabase.from('import_rows').update({
          matched_repertoire_id: repId,
          matched_contract_id:   result.matched_contract_id,
          matched_payee_id:      result.matched_payee_id,
          match_status:          repId ? (hasLink ? 'matched' : 'partial') : 'unmatched',
          warning_flag:          repId ? !hasLink : false,
          warning_reason:        repId && !hasLink ? 'Matched to repertoire but no active publishing contract path exists yet.' : null,
          error_flag:            !repId,
          error_reason:          !repId ? result.error_reason : null,
          normalized_title:      result.normalized_title,
          normalized_identifier: result.normalized_identifier,
        }).eq('id', r.id)
        if (!upErr) updatedCount++
      }
    }
    return updatedCount
  }

  async function reRunSelected() {
    const ids = selected.size > 0 ? Array.from(selected) : filtered.map(r => r.id)
    if (ids.length === 0) return
    setReRunning(true)
    setReRunProgress(`Re-matching ${ids.length} rows…`)
    const updatedCount = await runReMatch(ids)
    setReRunProgress(null)
    setReRunning(false)
    flashSuccess(`Re-matched ${updatedCount} rows.`)
    setSelected(new Set())
    await loadErrorRows()
  }

  async function reRunAll() {
    setReRunning(true)
    setReRunProgress(`Re-matching all ${errorRows.length} error rows…`)
    const updatedCount = await runReMatch(null)
    setReRunProgress(null)
    setReRunning(false)
    flashSuccess(`Re-ran matching: ${updatedCount} rows updated.`)
    setSelected(new Set())
    await loadErrorRows()
  }

  // ── Re-run single row ─────────────────────────────────────────────────────

  async function reRunRow(rowId: string) {
    await runReMatch([rowId])
    await loadErrorRows()
  }

  // ── Bulk match selected rows to a single repertoire work ──────────────────

  async function bulkMatchToWork(repId: string) {
    // Apply to all selected rows that are unmatched_repertoire
      const ids = Array.from(selected).filter(id => {
      const row = errorRows.find(r => r.id === id)
      return row && getErrorType(row, contracts, payeeLinks, splits, contractRepertoireLinks) === 'unmatched_repertoire'
    })
    if (ids.length === 0) return

    const { error: upErr } = await supabase
      .from('import_rows')
      .update({
        matched_repertoire_id: repId,
        match_status: hasContractPath(repId, contracts, contractRepertoireLinks, splits) ? 'matched' : 'partial',
        error_flag: false,
        error_reason: null,
        warning_flag: !hasContractPath(repId, contracts, contractRepertoireLinks, splits),
        warning_reason: !hasContractPath(repId, contracts, contractRepertoireLinks, splits) ? 'Matched to repertoire but no active publishing contract path exists yet.' : null,
      })
      .in('id', ids)

    if (upErr) { setError(upErr.message); return }

    // Verify how many actually cleared
    const { data: stillUnresolved } = await supabase
      .from('import_rows')
      .select('id')
      .in('id', ids)
      .is('matched_repertoire_id', null)
    const stillCount = (stillUnresolved ?? []).length
    const clearedCount = ids.length - stillCount

    setShowBulkMatch(false)
    setSelected(new Set())
    await loadErrorRows()

    if (clearedCount > 0) {
      flashSuccess(`${clearedCount} row${clearedCount > 1 ? 's' : ''} matched to work.`)
    } else {
      flashSuccess(`${ids.length} row${ids.length > 1 ? 's' : ''} updated — check status below.`)
    }
  }

  // ── Open resolve panel ─────────────────────────────────────────────────────

  function openResolve(row: ImportRow) {
    setResolvingRow(row)
    setResolveType(getErrorType(row, contracts, payeeLinks, splits, contractRepertoireLinks))
    setOpenCreateWork(false)
  }

  function openCreateWorkFlow(row: ImportRow) {
    setResolvingRow(row)
    setResolveType(getErrorType(row, contracts, payeeLinks, splits, contractRepertoireLinks))
    setOpenCreateWork(true)
  }

  useEffect(() => {
    if (!resolveRowId || loading || errorRows.length === 0 || resolvingRow) return
    const row = errorRows.find(item => item.id === resolveRowId)
    if (!row) return
    openResolve(row)
  }, [resolveRowId, loading, errorRows, resolvingRow, contracts, payeeLinks, splits, contractRepertoireLinks])

  if (loading) return <div className="flex justify-center py-20"><LoadingSpinner size={22} /></div>

  return (
    <div className="space-y-4">
      {/* Header */}
      <div className="page-header">
        <div>
          <h1 className="page-title">Sales Error Resolution</h1>
          <p className="page-subtitle">Fix unmatched rows and missing contracts from imports</p>
        </div>
        <div className="flex items-center gap-2">
          <button onClick={loadAll} className="btn-ghost btn-sm"><RefreshCw size={13} /></button>
          <button
            className="btn-ghost btn-sm flex items-center gap-1.5"
            disabled={reRunning || errorRows.length === 0}
            onClick={reRunAll}
            title="Re-run matching for all unresolved rows using fresh data"
          >
            {reRunning ? <LoadingSpinner size={13} /> : <RefreshCw size={13} />}
            Re-run All Errors
          </button>
          <button
            className="btn-primary btn-sm flex items-center gap-1.5"
            disabled={reRunning || filtered.length === 0}
            onClick={reRunSelected}
          >
            {reRunning ? <LoadingSpinner size={13} /> : <Play size={13} />}
            {reRunning
              ? reRunProgress ?? 'Running…'
              : selected.size > 0
                ? `Re-run (${selected.size} selected)`
                : `Re-run Filtered (${filtered.length})`}
          </button>
        </div>
      </div>

      {error      && <Alert type="error">{error}</Alert>}
      {successMsg && <Alert type="success">{successMsg}</Alert>}

      {/* Stats */}
      <div className="grid grid-cols-2 md:grid-cols-6 gap-3">
        <StatCard label="Total Rows" value={errorRows.length} color={errorRows.length > 0 ? 'red' : 'default'} />
        <StatCard
          label="Error Amount (EUR)"
          value={filteredErrorAmount.toLocaleString('en-GB', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
          sub={filtered.length === errorRows.length
            ? 'all current error rows'
            : `${filtered.length} filtered row(s) · ${totalErrorAmount.toLocaleString('en-GB', { minimumFractionDigits: 2, maximumFractionDigits: 2 })} total`}
          color={filteredErrorAmount > 0 ? 'amber' : 'default'}
        />
        <StatCard label="Unmatched Repertoire" value={unmatchedCount} color={unmatchedCount > 0 ? 'red' : 'default'} />
        <StatCard label="Missing Contract" value={missingContractCount} color={missingContractCount > 0 ? 'amber' : 'default'} />
        <StatCard label="Missing Allocation" value={missingAllocationCount} color={missingAllocationCount > 0 ? 'amber' : 'default'} />
        <StatCard label="Explicitly Excluded" value={excludedCount} color={excludedCount > 0 ? 'default' : 'default'} />
        <StatCard label="Matched Works" value={errorRows.length - unmatchedCount} color="blue" />
      </div>

      {/* Filters */}
      <div className="card p-3 flex items-center gap-2 flex-wrap">
        <select className="ops-select w-32" value={domainFilter} onChange={e => setDomainFilter(e.target.value as '' | 'master' | 'publishing')}>
          <option value="">All domains</option>
          <option value="master">Master</option>
          <option value="publishing">Publishing</option>
        </select>
        <select className="ops-select w-44" value={typeFilter} onChange={e => setTypeFilter(e.target.value as '' | 'excluded' | 'unmatched_repertoire' | 'missing_contract' | 'missing_allocation')}>
          <option value="">All error types</option>
          <option value="excluded">Explicitly Excluded</option>
          <option value="missing_allocation">Missing Allocation</option>
          <option value="missing_contract">Missing Contract</option>
          <option value="unmatched_repertoire">Unmatched Repertoire</option>
        </select>
        <select className="ops-select w-52" value={importFilter} onChange={e => setImportFilter(e.target.value)}>
          <option value="">All imports</option>
          {sortByLabel(imports, imp => `${imp.source_name ?? imp.id.slice(0, 8)} (${imp.statement_period?.label ?? '—'})`).map(imp => (
            <option key={imp.id} value={imp.id}>
              {imp.source_name ?? imp.id.slice(0, 8)} ({imp.statement_period?.label ?? '—'})
            </option>
          ))}
        </select>
        {(domainFilter || typeFilter || importFilter) && (
          <button className="btn-ghost btn-sm" onClick={() => { setDomainFilter(''); setTypeFilter(''); setImportFilter('') }}>Clear</button>
        )}
        <div className="text-xs text-ops-muted">
          Showing {totalFiltered === 0 ? 0 : pageStart + 1}-{pageEnd} of {totalFiltered} filtered
          {totalFiltered !== errorRows.length ? ` · ${errorRows.length} total` : ''}
        </div>
        <div className="flex-1" />
        {selected.size > 0 ? (
          <div className="flex items-center gap-2">
            <span className="text-xs text-blue-400">{selected.size} selected</span>
            {Array.from(selected).some(id => {
              const row = errorRows.find(r => r.id === id)
              return row && getErrorType(row, contracts, payeeLinks, splits, contractRepertoireLinks) === 'unmatched_repertoire'
            }) && (
              <button
                className="btn-ghost btn-sm text-xs flex items-center gap-1"
                onClick={() => setShowBulkMatch(true)}
              >
                <Search size={11} /> Match to Work
              </button>
            )}
            <button className="btn-ghost btn-sm" onClick={clearSelection}><X size={13} /></button>
          </div>
        ) : (
          <button className="btn-ghost btn-sm text-xs" onClick={selectAll}>Select all ({filtered.length})</button>
        )}
      </div>

      {/* Table */}
      {totalFiltered === 0 ? (
        <div className="card">
          <EmptyState
            icon={CheckCircle}
            title="No errors"
            description="All import rows are matched."
          />
        </div>
      ) : (
        <div className="card overflow-x-auto">
          <table className="ops-table text-xs">
            <thead>
              <tr>
                <th style={{ width: 28 }}>
                  <input
                    type="checkbox"
                    checked={visibleRows.length > 0 && visibleRows.every(row => selected.has(row.id))}
                    onChange={e => {
                      if (e.target.checked) {
                        setSelected(prev => new Set([...Array.from(prev), ...visibleRows.map(row => row.id)]))
                      } else {
                        setSelected(prev => {
                          const next = new Set(prev)
                          visibleRows.forEach(row => next.delete(row.id))
                          return next
                        })
                      }
                    }}
                  />
                </th>
                <th>#</th>
                <th>Import</th>
                <th>Error Type</th>
                <th>Title / Identifier</th>
                <th>Income Type</th>
                <th className="text-right">Amount</th>
                <th>Repertoire</th>
                <th>Contract</th>
                <th>Actions</th>
              </tr>
            </thead>
            <tbody>
              {visibleRows.map(row => {
                const errType = getErrorType(row, contracts, payeeLinks, splits, contractRepertoireLinks)
                const imp = imports.find(i => i.id === row.import_id)
                const repItem = repertoire.find(r => r.id === row.matched_repertoire_id)
                const linkedContracts = contractRepertoireLinks.filter(link => link.repertoire_id === row.matched_repertoire_id)
                const isSelected = selected.has(row.id)

                return (
                  <tr key={row.id} className={isSelected ? 'bg-blue-950/20' : undefined}>
                    <td>
                      <input type="checkbox" checked={isSelected} onChange={() => toggleSelect(row.id)} />
                    </td>
                    <td className="font-mono text-ops-muted">{row.raw_row_number}</td>
                    <td>
                      <div className="flex items-center gap-1">
                        <DomainBadge domain={row.domain} />
                        <span className="text-ops-muted truncate max-w-[100px]">
                          {imp?.source_name ?? row.import_id.slice(0, 8)}
                        </span>
                      </div>
                    </td>
                    <td>
                      {errType === 'unmatched_repertoire' && (
                        <span className="badge-critical text-[10px]">{getUnmatchedLabel(row, duplicateTitleIds)}</span>
                      )}
                      {errType === 'excluded' && (
                        <span className="badge-pending text-[10px]">Excluded</span>
                      )}
                      {errType === 'missing_contract' && (
                        <span className="badge-warning text-[10px]">Missing Contract</span>
                      )}
                      {errType === 'missing_allocation' && (
                        <span className="badge-warning text-[10px]">Missing Allocation</span>
                      )}
                    </td>
                    <td>
                      <div className="max-w-[220px] space-y-0.5">
                        <div className="truncate font-medium text-ops-text">{row.title_raw ?? '—'}</div>
                        {row.identifier_raw && (
                          <div className="font-mono text-ops-muted text-[10px]">{row.identifier_raw}</div>
                        )}
                        {errType === 'excluded' && (
                          <div className="text-[10px] text-ops-subtle line-clamp-2">{row.exclusion_reason ?? 'Excluded from statements.'}</div>
                        )}
                      {errType === 'unmatched_repertoire' && row.error_reason && (
                        <div className="text-[10px] text-ops-subtle line-clamp-2">{row.error_reason}</div>
                      )}
                      {errType === 'missing_allocation' && (
                        <div className="text-[10px] text-ops-subtle line-clamp-2">
                          {getMissingAllocationReason(row, contracts, payeeLinks, splits, contractRepertoireLinks) ?? 'This row is still missing a valid payout route.'}
                        </div>
                      )}
                    </div>
                  </td>
                    <td className="capitalize text-ops-muted">
                      {row.income_type?.replace(/_/g, ' ') ?? '—'}
                    </td>
                    <td className="text-right font-mono">
                      {row.amount != null
                        ? `${row.currency ?? ''} ${Number(row.amount).toFixed(2)}`
                        : '—'}
                    </td>
                    <td>
                      {repItem ? (
                        <Link
                          href={`/repertoire?edit=${repItem.id}`}
                          className="text-blue-400 hover:underline flex items-center gap-1 text-[10px]"
                        >
                          <span className="truncate max-w-[100px]">{repItem.title ?? repItem.iswc ?? repItem.isrc ?? '—'}</span>
                          <ExternalLink size={10} />
                        </Link>
                      ) : (
                        <span className="text-ops-subtle text-[10px]">—</span>
                      )}
                    </td>
                    <td>
                      {linkedContracts.length > 0 ? (
                        <span className="text-[10px] text-ops-text">
                          {linkedContracts.length} linked
                        </span>
                      ) : (
                        <span className="text-ops-subtle text-[10px]">—</span>
                      )}
                    </td>
                    <td>
                      <div className="flex items-center gap-1">
                        {errType && (
                          <button
                            className="btn-primary btn-sm text-[10px] flex items-center gap-1"
                            onClick={() => openResolve(row)}
                            disabled={errType === 'excluded'}
                          >
                            {errType === 'unmatched_repertoire' ? <Search size={10} /> : <Link2 size={10} />}
                            {errType === 'unmatched_repertoire' ? 'Find Work' : errType === 'missing_contract' ? 'Manage Links' : errType === 'excluded' ? 'Excluded' : 'Review Setup'}
                          </button>
                        )}
                        {errType === 'unmatched_repertoire' && (
                          <button
                            className="btn-secondary btn-sm text-[10px] flex items-center gap-1"
                            onClick={() => openCreateWorkFlow(row)}
                          >
                            <CheckCircle size={10} />
                            Create Work
                          </button>
                        )}
                        {errType === 'missing_contract' && (
                          <Link
                            href={buildCreateContractHref(row)}
                            className="btn-secondary btn-sm text-[10px] flex items-center gap-1"
                          >
                            <Plus size={10} />
                            Create Contract
                          </Link>
                        )}
                        <button
                          className="btn-ghost btn-sm text-[10px] flex items-center gap-1"
                          title="Re-run matching for this row"
                          onClick={() => reRunRow(row.id)}
                          disabled={errType === 'excluded'}
                        >
                          <Play size={9} />
                        </button>
                      </div>
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
          <div className="flex items-center justify-between gap-3 border-t px-3 py-2 text-xs" style={{ borderColor: 'var(--ops-border)' }}>
            <div className="text-ops-muted">
              Page {safeCurrentPage} of {totalPages} · showing {visibleRows.length} row{visibleRows.length !== 1 ? 's' : ''}
            </div>
            <div className="flex items-center gap-2">
              <button
                className="btn-ghost btn-sm"
                disabled={safeCurrentPage <= 1}
                onClick={() => setCurrentPage(prev => Math.max(1, prev - 1))}
              >
                Previous
              </button>
              <button
                className="btn-ghost btn-sm"
                disabled={safeCurrentPage >= totalPages}
                onClick={() => setCurrentPage(prev => Math.min(totalPages, prev + 1))}
              >
                Next
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Bulk Match to Work Panel */}
      {showBulkMatch && (
        <BulkMatchToWork
          selectedIds={selected}
          errorRows={errorRows}
          contractRepertoireLinks={contractRepertoireLinks}
          repertoire={repertoire}
          contracts={contracts}
          payeeLinks={payeeLinks}
          splits={splits}
          onClose={() => setShowBulkMatch(false)}
          onMatch={bulkMatchToWork}
        />
      )}

      {/* Resolution Panel */}
      {resolvingRow && resolveType && (
        <ResolutionPanel
          row={resolvingRow}
          errorType={resolveType}
          initialCreateMode={openCreateWork}
          allRows={errorRows}
          repertoire={repertoire}
          contracts={contracts}
          payees={payees}
          payeeLinks={payeeLinks}
          aliases={aliases}
          splits={splits}
          contractRepertoireLinks={contractRepertoireLinks}
          onClose={() => { setResolvingRow(null); setResolveType(null); setOpenCreateWork(false) }}
          onResolved={async (siblingIds, resolvedErrorType, toastOverride) => {
            setResolvingRow(null)
            setResolveType(null)
            setOpenCreateWork(false)
            // Do NOT re-run matching here — handleSave already wrote the correct
            // matched_repertoire_id / match_status to all sibling rows.
            // Calling runReMatch would overwrite the manual fix.
            const fresh = await fetchRefData()
            await loadErrorRows()

            // If ResolutionPanel computed a specific toast message, use it directly.
            if (toastOverride) {
              flashSuccess(toastOverride)
              return
            }

            // Re-query to count how many actually left the actionable error state.
            const { data: refreshedRows } = await supabase
              .from('import_rows')
              .select('*')
              .in('id', siblingIds)
            const stillCount = ((refreshedRows ?? []) as ImportRow[]).filter((currentRow: ImportRow) =>
              getErrorType(
                currentRow,
                fresh.contracts as Contract[],
                fresh.payeeLinks,
                fresh.splits,
                fresh.contractRepertoireLinks,
              ) === resolvedErrorType
            ).length
            const clearedCount = siblingIds.length - stillCount
            if (clearedCount > 0) {
              flashSuccess(
                clearedCount > 1
                  ? `${clearedCount} rows resolved and cleared.`
                  : 'Row resolved and cleared.'
              )
            } else {
              flashSuccess(`${siblingIds.length} row${siblingIds.length > 1 ? 's' : ''} updated — check status below.`)
            }
          }}
        />
      )}
    </div>
  )
}

// ── BulkMatchToWork ───────────────────────────────────────────────────────────
// Modal that lets the user search for one repertoire work and apply it to all
// selected unmatched_repertoire rows in one action.

function BulkMatchToWork({
  selectedIds,
  errorRows,
  contractRepertoireLinks,
  repertoire,
  contracts,
  payeeLinks,
  splits,
  onClose,
  onMatch,
}: {
  selectedIds: Set<string>
  errorRows: ImportRow[]
  contractRepertoireLinks: ContractRepertoireAllocationLink[]
  repertoire: Repertoire[]
  contracts: Contract[]
  payeeLinks: any[]
  splits: any[]
  onClose: () => void
  onMatch: (repId: string) => Promise<void>
}) {
  const [search, setSearch] = useState('')
  const [repResults, setRepResults] = useState<Repertoire[]>([])
  const [repSearching, setRepSearching] = useState(false)
  const [selectedRepId, setSelectedRepId] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)

  const searchDebounceRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  function normIdStr(s: string | null | undefined): string {
    if (!s) return ''
    return s.trim().replace(/[-\s.]/g, '').toUpperCase()
  }

  async function runRepSearch(term: string) {
    const t = term.trim()
    if (!t) { setRepResults([]); return }
    setRepSearching(true)
    const normId = normIdStr(t)
    const { data, error: qErr } = await supabase
      .from('repertoire')
      .select('*')
      .or([
        `tempo_id.ilike.%${t}%`,
        `iswc.ilike.%${t}%`,
        `isrc.ilike.%${t}%`,
        `source_id.ilike.%${t}%`,
        `title.ilike.%${t}%`,
      ].join(','))
      .limit(30)
    if (qErr) { setRepSearching(false); return }
    const rows = (data ?? []) as Repertoire[]
    const idMatches = rows.filter(r =>
      normIdStr((r as any).tempo_id) === normId ||
      normIdStr(r.iswc) === normId ||
      normIdStr(r.isrc) === normId ||
      normIdStr(r.source_id) === normId
    )
    const rest = rows.filter(r => !idMatches.some(m => m.id === r.id))
    setRepResults([...idMatches, ...rest])
    setRepSearching(false)
  }

  function handleSearchChange(val: string) {
    setSearch(val)
    if (searchDebounceRef.current) clearTimeout(searchDebounceRef.current)
    searchDebounceRef.current = setTimeout(() => runRepSearch(val), 250)
  }

  const unmatchedSelected = Array.from(selectedIds).filter(id => {
    const row = errorRows.find(r => r.id === id)
    return row && getErrorType(row, contracts, payeeLinks, splits, contractRepertoireLinks) === 'unmatched_repertoire'
  })

  const selectedRep = repResults.find(r => r.id === selectedRepId)

  async function handleSave() {
    if (!selectedRepId) return
    setSaving(true)
    await onMatch(selectedRepId)
    setSaving(false)
  }

  return (
    <div className="fixed inset-0 bg-black/70 z-50 flex items-end sm:items-center justify-center p-4">
      <div
        className="bg-ops-surface border border-ops-border rounded-xl w-full max-w-xl flex flex-col"
        style={{ maxHeight: '80vh' }}
      >
        <div className="flex items-center justify-between px-5 py-3 border-b flex-shrink-0" style={{ borderColor: 'var(--ops-border)' }}>
          <div>
            <div className="font-semibold text-ops-text text-sm flex items-center gap-2">
              <Search size={13} className="text-blue-400" /> Bulk Match to Repertoire Work
            </div>
            <div className="text-xs text-ops-muted">
              {unmatchedSelected.length} unmatched row{unmatchedSelected.length !== 1 ? 's' : ''} selected
            </div>
          </div>
          <button onClick={onClose} className="btn-ghost btn-sm"><X size={14} /></button>
        </div>

        <div className="flex-1 overflow-y-auto px-5 py-4 space-y-4">
          <div className="space-y-2">
            <label className="form-label">Search Repertoire</label>
            <div className="relative">
              <Search size={13} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-ops-muted" />
              <input
                className="input-field pl-8"
                placeholder="Tempo ID, title, ISWC, or ISRC…"
                value={search}
                onChange={e => handleSearchChange(e.target.value)}
                autoFocus
              />
            </div>
            {repSearching && (
              <div className="text-xs text-ops-muted py-2 flex items-center gap-1.5">
                <LoadingSpinner size={11} /> Searching…
              </div>
            )}
            {repResults.length > 0 && (
              <div className="rounded-lg overflow-hidden border" style={{ borderColor: 'var(--ops-border)' }}>
                {repResults.map(rep => (
                  <button
                    key={rep.id}
                    className={`w-full text-left px-3 py-2.5 text-xs border-b hover:bg-ops-surface-2 flex items-center justify-between ${selectedRepId === rep.id ? 'bg-blue-950/30' : ''}`}
                    style={{ borderColor: 'var(--ops-border)' }}
                    onClick={() => setSelectedRepId(rep.id)}
                  >
                    <div>
                      <div className="font-medium text-ops-text">{rep.title ?? '—'}</div>
                      <div className="text-ops-muted text-[10px] font-mono">
                        {getPublishingIdentifierLabel(rep)}
                        {rep.artist_name && ` · ${rep.artist_name}`}
                      </div>
                    </div>
                    <div className="flex items-center gap-2 flex-shrink-0">
                      {selectedRepId === rep.id && <CheckCircle size={13} className="text-blue-400" />}
                      <Link href={`/repertoire?edit=${rep.id}`} target="_blank" onClick={e => e.stopPropagation()}>
                        <ExternalLink size={11} className="text-ops-muted hover:text-blue-400" />
                      </Link>
                    </div>
                  </button>
                ))}
              </div>
            )}
            {search.trim() && repResults.length === 0 && !repSearching && (
              <p className="text-xs text-ops-muted">No results. <Link href="/repertoire" className="text-blue-400 hover:underline">Add to Repertoire →</Link></p>
            )}
            {selectedRep && (
              <div className="text-xs p-2 rounded-lg border flex items-center justify-between" style={getNoticePanelStyle('info')}>
                <div>
                  <span className="font-medium" style={{ color: 'var(--ops-text)' }}>Selected: </span>
                  <span className="text-ops-text">{selectedRep.title}</span>
                  <span className="text-ops-muted ml-2 font-mono text-[10px]">{getPublishingIdentifierLabel(selectedRep)}</span>
                </div>
                <button onClick={() => setSelectedRepId(null)} className="text-ops-muted hover:text-red-400"><X size={11} /></button>
              </div>
            )}
          </div>
        </div>

        {/* Footer */}
        <div className="flex items-center justify-between px-5 py-3 border-t flex-shrink-0" style={{ borderColor: 'var(--ops-border)' }}>
          <button className="btn-ghost btn-sm" onClick={onClose}>Cancel</button>
          <button
            className="btn-primary btn-sm flex items-center gap-1.5"
            disabled={saving || !selectedRepId}
            onClick={handleSave}
          >
            {saving ? <LoadingSpinner size={13} /> : <CheckCircle size={13} />}
            {saving ? 'Saving…' : `Apply to ${unmatchedSelected.length} row${unmatchedSelected.length !== 1 ? 's' : ''}`}
          </button>
        </div>
      </div>
    </div>
  )
}

function WorkContractLinksEditor({
  repertoireId,
  contracts,
  onChanged,
}: {
  repertoireId: string
  contracts: Contract[]
  onChanged: (hasLinks: boolean) => void
}) {
  const [links, setLinks] = useState<ContractRepertoireAllocationLink[]>([])
  const [selectedContractId, setSelectedContractId] = useState('')
  const [shareInput, setShareInput] = useState('')
  const [editingContractId, setEditingContractId] = useState<string | null>(null)
  const [editShareInput, setEditShareInput] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)

  const loadLinks = useCallback(async () => {
    setLoading(true)
    const { data } = await supabase
      .from('contract_repertoire_links')
      .select('contract_id, repertoire_id, royalty_rate')
      .eq('repertoire_id', repertoireId)
    setLinks((data ?? []) as any)
    setLoading(false)
    onChanged((data ?? []).length > 0)
  }, [repertoireId, onChanged])

  useEffect(() => { loadLinks() }, [loadLinks])

  const parseShare = (value: string) => {
    const n = parseFloat(value)
    if (!value.trim() || isNaN(n) || n <= 0 || n > 100) return null
    return Math.round(n * 10000) / 1000000
  }

  const totalShare = links.reduce((sum, link) => sum + Number(link.royalty_rate ?? 0), 0)
  const availableContracts = contracts.filter(
    contract => isPublishingContractType(contract.contract_type) && !links.some(link => link.contract_id === contract.id)
  )

  const addLink = async () => {
    if (!selectedContractId) { setError('Select a contract.'); return }
    const share = parseShare(shareInput)
    if (share == null) { setError('Enter a valid share between 0 and 100.'); return }
    setSaving(true)
    setError(null)
    const { error: upErr } = await supabase.from('contract_repertoire_links').upsert({
      contract_id: selectedContractId,
      repertoire_id: repertoireId,
      royalty_rate: share,
    }, { onConflict: 'contract_id,repertoire_id' })
    setSaving(false)
    if (upErr) { setError(upErr.message); return }
    setSelectedContractId('')
    setShareInput('')
    await loadLinks()
  }

  const saveEdit = async (contractId: string) => {
    const share = parseShare(editShareInput)
    if (share == null) { setError('Enter a valid share between 0 and 100.'); return }
    const { error: upErr } = await supabase
      .from('contract_repertoire_links')
      .update({ royalty_rate: share })
      .eq('contract_id', contractId)
      .eq('repertoire_id', repertoireId)
    if (upErr) { setError(upErr.message); return }
    setEditingContractId(null)
    setEditShareInput('')
    await loadLinks()
  }

  const removeLink = async (contractId: string) => {
    await supabase
      .from('contract_repertoire_links')
      .delete()
      .eq('contract_id', contractId)
      .eq('repertoire_id', repertoireId)
    await loadLinks()
  }

  return (
    <div className="space-y-2">
      {error && <Alert type="error">{error}</Alert>}
      <div className="rounded-lg border" style={{ borderColor: 'var(--ops-border)', background: 'var(--ops-surface-2)' }}>
        <div className="px-3 py-2 border-b text-xs font-semibold" style={{ borderColor: 'var(--ops-border)', color: 'var(--ops-text)' }}>
          Linked Contracts
        </div>
        <div className="p-3 space-y-2">
          {loading ? (
            <div className="text-xs text-ops-muted flex items-center gap-1.5"><LoadingSpinner size={11} /> Loading links…</div>
          ) : links.length === 0 ? (
            <div className="text-xs text-ops-muted">No contracts linked yet.</div>
          ) : links.map(link => {
            const contract = contracts.find(c => c.id === link.contract_id)
            return (
              <div key={link.contract_id} className="flex items-center justify-between gap-3 rounded border px-3 py-2 text-xs" style={{ borderColor: 'var(--ops-border)', background: 'var(--ops-surface)' }}>
                <div>
                  <div className="font-medium text-ops-text">{contract?.contract_name ?? link.contract_id}</div>
                  <div className="text-ops-muted font-mono">{contract?.contract_code ?? ''}</div>
                </div>
                <div className="flex items-center gap-2">
                  {editingContractId === link.contract_id ? (
                    <>
                      <input className="input-field w-20 text-xs font-mono" value={editShareInput} onChange={e => setEditShareInput(e.target.value)} />
                      <button className="btn-secondary btn-sm" onClick={() => saveEdit(link.contract_id)}>Save</button>
                    </>
                  ) : (
                    <button className="btn-ghost btn-sm text-xs" onClick={() => { setEditingContractId(link.contract_id); setEditShareInput(((Number(link.royalty_rate ?? 0) * 100).toFixed(2))) }}>
                      {link.royalty_rate != null ? `${(Number(link.royalty_rate) * 100).toFixed(2)}%` : 'Set share'}
                    </button>
                  )}
                  <button className="btn-ghost btn-sm text-xs" style={{ color: 'var(--accent-red)' }} onClick={() => removeLink(link.contract_id)}>Remove</button>
                </div>
              </div>
            )
          })}
        </div>
      </div>
      <div className="rounded-lg border p-3 space-y-2" style={{ borderColor: 'var(--ops-border)', background: 'var(--ops-surface-2)' }}>
        <div className="text-xs font-semibold text-ops-text">Add Contract Link</div>
        <div className="flex items-center gap-2">
          <select className="input-field text-xs" value={selectedContractId} onChange={e => setSelectedContractId(e.target.value)}>
            <option value="">Select contract…</option>
            {availableContracts.map(contract => (
              <option key={contract.id} value={contract.id}>{contract.contract_name}</option>
            ))}
          </select>
          <input className="input-field w-20 text-xs font-mono" placeholder="50" value={shareInput} onChange={e => setShareInput(e.target.value)} />
          <button className="btn-primary btn-sm" onClick={addLink} disabled={saving || !selectedContractId}>Add</button>
        </div>
        <div className="text-[11px] text-ops-muted">Current total share: {(totalShare * 100).toFixed(2)}%</div>
      </div>
    </div>
  )
}

// ── ResolutionPanel ───────────────────────────────────────────────────────────
//
// For errorType === 'unmatched_repertoire':
//   Purpose: repertoire matching ONLY. No contract linking here.
//   Contract management belongs on the Repertoire record.
//
// For errorType === 'missing_contract' / 'missing_allocation':
//   Shows matched work info + contract setup review.

function ResolutionPanel({
  row,
  errorType,
  initialCreateMode,
  allRows,
  repertoire,
  contracts,
  payees,
  payeeLinks,
  aliases,
  splits,
  contractRepertoireLinks,
  onClose,
  onResolved,
}: {
  row: ImportRow
  errorType: ErrorType
  initialCreateMode?: boolean
  allRows: ImportRow[]
  repertoire: Repertoire[]
  contracts: Contract[]
  payees: any[]
  payeeLinks: any[]
  aliases: any[]
  splits: any[]
  contractRepertoireLinks: ContractRepertoireAllocationLink[]
  onClose: () => void
  onResolved: (siblingIds: string[], errorType: ErrorType, toastOverride?: string) => void
}) {
  const [search, setSearch] = useState(row.title_raw ?? row.identifier_raw ?? '')
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [createMode, setCreateMode] = useState(!!initialCreateMode)
  const [selectedRepId, setSelectedRepId] = useState<string | null>(row.matched_repertoire_id)
  const [selectedRepHasContract, setSelectedRepHasContract] = useState(
    row.matched_repertoire_id ? hasContractPath(row.matched_repertoire_id, contracts, contractRepertoireLinks, splits) : false
  )
  const [createForm, setCreateForm] = useState(() => {
    const rawIdentifier = (row.identifier_raw ?? '').trim()
    const tempoId = row.tempo_id?.trim() || (rawIdentifier && !looksLikeISWC(rawIdentifier) ? rawIdentifier : '')
    const iswc = rawIdentifier && looksLikeISWC(rawIdentifier) ? rawIdentifier : ''
    return {
      title: row.title_raw ?? '',
      writer_name: row.artist_name_raw ?? '',
      tempo_id: tempoId,
      iswc,
      artist_name: row.artist_name_raw ?? '',
      notes: '',
    }
  })

  // Live DB search results
  const [repResults, setRepResults] = useState<Repertoire[]>([])
  const [repSearching, setRepSearching] = useState(false)

  function normIdStr(s: string | null | undefined): string {
    if (!s) return ''
    return s.trim().replace(/[-\s.]/g, '').toUpperCase()
  }

  async function runRepSearch(term: string) {
    const t = term.trim()
    if (!t) { setRepResults([]); return }
    setRepSearching(true)
    const normId = normIdStr(t)
    const { data, error: qErr } = await supabase
      .from('repertoire')
      .select('*')
      .or(
        [
          `tempo_id.ilike.%${t}%`,
          `iswc.ilike.%${t}%`,
          `isrc.ilike.%${t}%`,
          `source_id.ilike.%${t}%`,
          `title.ilike.%${t}%`,
        ].join(',')
      )
      .limit(30)
    if (qErr) { setRepSearching(false); return }
    const rows = (data ?? []) as Repertoire[]
    const idMatches = rows.filter(r =>
      normIdStr((r as any).tempo_id) === normId ||
      normIdStr(r.iswc) === normId ||
      normIdStr(r.isrc) === normId ||
      normIdStr(r.source_id) === normId
    )
    const rest = rows.filter(r => !idMatches.some(m => m.id === r.id))
    setRepResults([...idMatches, ...rest])
    setRepSearching(false)
  }

  const searchDebounceRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  function handleSearchChange(val: string) {
    setSearch(val)
    if (searchDebounceRef.current) clearTimeout(searchDebounceRef.current)
    searchDebounceRef.current = setTimeout(() => runRepSearch(val), 250)
  }

  useEffect(() => { if (search.trim()) runRepSearch(search) }, [])

  const selectedRep = repertoire.find(r => r.id === selectedRepId)
    ?? repResults.find(r => r.id === selectedRepId)

  useEffect(() => {
    setSelectedRepHasContract(selectedRepId !== null && hasContractPath(selectedRepId, contracts, contractRepertoireLinks, splits))
  }, [selectedRepId, contracts, contractRepertoireLinks, splits])

  useEffect(() => {
    setCreateMode(!!initialCreateMode)
  }, [initialCreateMode, row.id])

  const setCreateField = (key: keyof typeof createForm, value: string) =>
    setCreateForm(prev => ({ ...prev, [key]: value }))

  async function handleSave() {
    setSaving(true)
    setError(null)

    function pnid(s: string | null | undefined) {
      return (s ?? '').trim().replace(/[-\s.]/g, '').toUpperCase()
    }
    const normId = pnid(row.identifier_raw)
    const siblingIds: string[] = normId
      ? allRows
          .filter(r => {
            const rId = pnid(r.identifier_raw)
            return rId !== '' && rId === normId
          })
          .map(r => r.id)
      : [row.id]
    if (!siblingIds.includes(row.id)) siblingIds.push(row.id)

    if (errorType === 'unmatched_repertoire') {
      // This modal handles repertoire matching ONLY — no contract linking.
      if (!selectedRepId) { setError('Select a repertoire item first.'); setSaving(false); return }

      const { error: upErr } = await supabase
        .from('import_rows')
        .update({
          matched_repertoire_id: selectedRepId,
          match_status:          hasContractPath(selectedRepId, contracts, contractRepertoireLinks, splits) ? 'matched' : 'partial',
          error_flag:            false,
          error_reason:          null,
          warning_flag:          !hasContractPath(selectedRepId, contracts, contractRepertoireLinks, splits),
          warning_reason:        !hasContractPath(selectedRepId, contracts, contractRepertoireLinks, splits) ? 'Matched to repertoire but no active publishing contract path exists yet.' : null,
        })
        .in('id', siblingIds)
      if (upErr) { setError(upErr.message); setSaving(false); return }

      const workTitle = selectedRep?.title ?? selectedRepId
      const toast = hasContractPath(selectedRepId, contracts, contractRepertoireLinks, splits)
        ? `Matched to "${workTitle}".`
        : `Matched to "${workTitle}". No active publishing contract path exists yet.`

      setSaving(false)
      onResolved(siblingIds, errorType, toast)

    } else {
      const repId = row.matched_repertoire_id ?? selectedRepId
      const [{ data: refreshedLinks }, { data: refreshedSplits }] = await Promise.all([
        supabase
          .from('contract_repertoire_links')
          .select('contract_id,repertoire_id,royalty_rate')
          .eq('repertoire_id', repId),
        supabase
          .from('contract_repertoire_payee_splits')
          .select('repertoire_id,is_active')
          .eq('repertoire_id', repId)
          .eq('is_active', true),
      ])
      const hasLink = hasContractPath(repId, contracts, (refreshedLinks ?? []) as ContractRepertoireAllocationLink[], refreshedSplits ?? [])

      const { error: upErr } = await supabase
        .from('import_rows')
        .update({
          match_status:        hasLink ? 'matched' : 'partial',
          warning_flag:        !hasLink,
          warning_reason:      !hasLink ? 'Matched to repertoire but no active publishing contract path exists yet.' : null,
          error_flag:          false,
          error_reason:        null,
        })
        .in('id', siblingIds)
      if (upErr) { setError(upErr.message); setSaving(false); return }

      setSaving(false)
      onResolved(siblingIds, errorType)
    }
  }

  async function handleCreateWork() {
    const title = createForm.title.trim()
    const writerName = createForm.writer_name.trim()
    const tempoId = createForm.tempo_id.trim()
    const iswc = createForm.iswc.trim().toUpperCase()

    if (!title) { setError('Title is required.'); return }
    if (!writerName) { setError('At least one writer is required.'); return }

    let dupQuery = supabase
      .from('repertoire')
      .select('id,title')
      .eq('repertoire_type', 'work')
      .eq('title', title)

    dupQuery = tempoId
      ? dupQuery.eq('tempo_id', tempoId)
      : dupQuery.is('tempo_id', null)

    const { data: duplicateRows, error: duplicateErr } = await dupQuery.limit(1)
    if (duplicateErr) { setError(duplicateErr.message); return }
    if ((duplicateRows ?? []).length > 0) {
      setError(`A work with this title${tempoId ? ` and Tempo ID ${tempoId}` : ''} already exists.`)
      return
    }

    setSaving(true)
    setError(null)

    const payload = {
      repertoire_type: 'work',
      title,
      writer_name: writerName,
      artist_name: createForm.artist_name.trim() || null,
      tempo_id: tempoId || null,
      iswc: iswc || null,
      active_status: true,
      draft_status: 'needs_linking',
      notes: createForm.notes.trim() || null,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    }

    const { data: created, error: createErr } = await supabase
      .from('repertoire')
      .insert(payload)
      .select('id,title')
      .single()
    if (createErr || !created) {
      setError(createErr?.message ?? 'Failed to create work.')
      setSaving(false)
      return
    }

    function pnid(s: string | null | undefined) {
      return (s ?? '').trim().replace(/[-\s.]/g, '').toUpperCase()
    }
    const normId = pnid(row.identifier_raw)
    const siblingIds: string[] = normId
      ? allRows.filter(r => pnid(r.identifier_raw) === normId).map(r => r.id)
      : [row.id]
    if (!siblingIds.includes(row.id)) siblingIds.push(row.id)

    const hasLink = hasContractPath(created.id, contracts, contractRepertoireLinks, splits)
    const { error: updateErr } = await supabase
      .from('import_rows')
      .update({
        matched_repertoire_id: created.id,
        match_status: hasLink ? 'matched' : 'partial',
        error_flag: false,
        error_reason: null,
        warning_flag: !hasLink,
        warning_reason: !hasLink ? 'Matched to repertoire but no active publishing contract path exists yet.' : null,
      })
      .in('id', siblingIds)
    if (updateErr) {
      setError(updateErr.message)
      setSaving(false)
      return
    }

    setSaving(false)
    onResolved(siblingIds, errorType, `Created "${created.title}" and linked ${siblingIds.length} row${siblingIds.length !== 1 ? 's' : ''}.`)
  }

  return (
    <div className="fixed inset-0 bg-black/70 z-50 flex items-end sm:items-center justify-center p-4">
      <div
        className="bg-ops-surface border border-ops-border rounded-xl w-full max-w-xl flex flex-col"
        style={{ maxHeight: '85vh' }}
      >
        {/* Header */}
        <div className="flex items-center justify-between px-5 py-3 border-b flex-shrink-0" style={{ borderColor: 'var(--ops-border)' }}>
          <div>
            <div className="font-semibold text-ops-text text-sm flex items-center gap-2">
              {errorType === 'unmatched_repertoire' ? (
                <><Search size={13} className="text-red-400" /> Find Work in Repertoire</>
              ) : errorType === 'missing_allocation' ? (
                <><AlertTriangle size={13} className="text-amber-400" /> Review Allocation Setup</>
              ) : (
                <><Link2 size={13} className="text-amber-400" /> Link Contract — Work Already Matched</>
              )}
            </div>
            <div className="text-xs text-ops-muted">
              Row #{row.raw_row_number} · {row.title_raw ?? row.identifier_raw ?? '—'}
              {row.identifier_raw && row.title_raw && (
                <span className="font-mono ml-1 text-ops-subtle">({row.identifier_raw})</span>
              )}
              {row.amount != null && ` · ${row.currency ?? ''} ${Number(row.amount).toFixed(2)}`}
            </div>
          </div>
          <button onClick={onClose} className="btn-ghost btn-sm"><X size={14} /></button>
        </div>

        <div className="flex-1 overflow-y-auto px-5 py-4 space-y-4">
          {error && <Alert type="error">{error}</Alert>}

          {/* Row info */}
          <div className="grid grid-cols-2 gap-2 text-xs p-3 rounded-lg" style={{ background: 'var(--ops-surface-2)', border: '1px solid var(--ops-border)' }}>
            <div><span className="text-ops-muted">Title: </span>{row.title_raw ?? '—'}</div>
            <div><span className="text-ops-muted">Identifier: </span><span className="font-mono">{row.identifier_raw ?? '—'}</span></div>
            <div><span className="text-ops-muted">Payee: </span>{row.payee_name_raw ?? '—'}</div>
            <div><span className="text-ops-muted">Income Type: </span><span className="capitalize">{row.income_type?.replace(/_/g, ' ') ?? '—'}</span></div>
            <div><span className="text-ops-muted">Amount: </span><span className="font-mono">{row.currency ?? ''} {row.amount != null ? Number(row.amount).toFixed(2) : '—'}</span></div>
            <div><span className="text-ops-muted">Domain: </span><span className="capitalize">{row.domain}</span></div>
          </div>

          {/* Identifier-wide resolution notice */}
          {(() => {
            const sNormId = (row.identifier_raw ?? '').trim().replace(/[-\s.]/g, '').toUpperCase()
            const siblingCount = sNormId
              ? allRows.filter(r => {
                  const rId = (r.identifier_raw ?? '').trim().replace(/[-\s.]/g, '').toUpperCase()
                  return rId !== '' && rId === sNormId
                }).length
              : 1
            if (siblingCount <= 1) return null
            return (
              <div className="flex items-center gap-2 px-3 py-2 rounded-lg text-xs border" style={getNoticePanelStyle('info')}>
                <AlertTriangle size={11} className="shrink-0" />
                <span>
                  <strong>{siblingCount} rows</strong> share identifier <span className="font-mono">{row.identifier_raw}</span>.
                  Resolving this will fix all of them automatically.
                </span>
              </div>
            )
          })()}

          {/* ── Repertoire search — unmatched_repertoire flow only ── */}
          {errorType === 'unmatched_repertoire' && (
            <div className="space-y-2">
              <div className="flex items-center justify-between gap-3">
                <label className="form-label">Search Repertoire</label>
                <button
                  className="btn-secondary btn-sm text-xs"
                  onClick={() => setCreateMode(v => !v)}
                >
                  {createMode ? 'Back to Find Work' : 'Create Work'}
                </button>
              </div>
              {createMode && (
                <div className="rounded-lg border p-3 space-y-3" style={{ borderColor: 'var(--ops-border)', background: 'var(--ops-surface-2)' }}>
                  <div className="text-xs font-semibold text-ops-text">Create New Work</div>
                  <div className="grid grid-cols-2 gap-3">
                    <div className="col-span-2">
                      <label className="form-label">Title *</label>
                      <input className="input-field" value={createForm.title} onChange={e => setCreateField('title', e.target.value)} />
                    </div>
                    <div className="col-span-2">
                      <label className="form-label">Writer(s) *</label>
                      <input className="input-field" value={createForm.writer_name} onChange={e => setCreateField('writer_name', e.target.value)} placeholder="Comma-separated if multiple" />
                    </div>
                    <div>
                      <label className="form-label">Tempo ID</label>
                      <input className="input-field font-mono" value={createForm.tempo_id} onChange={e => setCreateField('tempo_id', e.target.value)} />
                    </div>
                    <div>
                      <label className="form-label">ISWC</label>
                      <input className="input-field font-mono" value={createForm.iswc} onChange={e => setCreateField('iswc', e.target.value.toUpperCase())} />
                    </div>
                    <div className="col-span-2">
                      <label className="form-label">Artist / Display Name</label>
                      <input className="input-field" value={createForm.artist_name} onChange={e => setCreateField('artist_name', e.target.value)} />
                    </div>
                    <div className="col-span-2">
                      <label className="form-label">Notes</label>
                      <textarea className="ops-textarea" rows={2} value={createForm.notes} onChange={e => setCreateField('notes', e.target.value)} />
                    </div>
                  </div>
                  <div className="text-[11px] text-ops-muted">
                    A new publishing work will be created as <span className="font-medium text-ops-text">Needs Linking</span>. If no contract is linked yet, the row may move to a missing-contract warning after creation.
                  </div>
                  <div className="flex items-center justify-end gap-2">
                    <button className="btn-ghost btn-sm" onClick={() => setCreateMode(false)} disabled={saving}>Cancel</button>
                    <button className="btn-primary btn-sm flex items-center gap-1.5" onClick={handleCreateWork} disabled={saving}>
                      {saving ? <LoadingSpinner size={13} /> : <CheckCircle size={13} />}
                      {saving ? 'Creating…' : 'Save Work'}
                    </button>
                  </div>
                </div>
              )}
              {!createMode && (
                <>
              <div className="relative">
                <Search size={13} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-ops-muted" />
                <input
                  className="input-field pl-8"
                  placeholder="Tempo ID, title, ISWC, or ISRC…"
                  value={search}
                  onChange={e => handleSearchChange(e.target.value)}
                  autoFocus
                />
              </div>
              {repSearching && (
                <div className="text-xs text-ops-muted py-2 flex items-center gap-1.5">
                  <LoadingSpinner size={11} /> Searching…
                </div>
              )}
              {repResults.length > 0 && (
                <div className="rounded-lg overflow-hidden border" style={{ borderColor: 'var(--ops-border)' }}>
                  {repResults.map(rep => (
                    <button
                      key={rep.id}
                      className={`w-full text-left px-3 py-2.5 text-xs border-b hover:bg-ops-surface-2 flex items-center justify-between ${selectedRepId === rep.id ? 'bg-blue-950/30' : ''}`}
                      style={{ borderColor: 'var(--ops-border)' }}
                      onClick={() => setSelectedRepId(rep.id)}
                    >
                      <div>
                        <div className="font-medium text-ops-text">{rep.title ?? '—'}</div>
                        <div className="text-ops-muted text-[10px] font-mono">
                          {getPublishingIdentifierLabel(rep)}
                          {rep.artist_name && ` · ${rep.artist_name}`}
                        </div>
                      </div>
                      <div className="flex items-center gap-2 flex-shrink-0">
                        {selectedRepId === rep.id && <CheckCircle size={13} className="text-blue-400" />}
                        <Link href={`/repertoire?edit=${rep.id}`} target="_blank" onClick={e => e.stopPropagation()}>
                          <ExternalLink size={11} className="text-ops-muted hover:text-blue-400" />
                        </Link>
                      </div>
                    </button>
                  ))}
                </div>
              )}
              {search.trim() && repResults.length === 0 && !repSearching && (
                <p className="text-xs text-ops-muted">
                  No results.{' '}
                  <Link href="/repertoire" className="text-blue-400 hover:underline">Add to Repertoire →</Link>
                </p>
              )}
              {selectedRep && (
                <div className="text-xs p-2 rounded-lg border flex items-center justify-between" style={getNoticePanelStyle('info')}>
                  <div>
                    <span className="font-medium" style={{ color: 'var(--ops-text)' }}>Selected: </span>
                    <span className="text-ops-text">{selectedRep.title}</span>
                    <span className="text-ops-muted ml-2 font-mono text-[10px]">{getPublishingIdentifierLabel(selectedRep)}</span>
                  </div>
                  <button onClick={() => setSelectedRepId(null)} className="text-ops-muted hover:text-red-400"><X size={11} /></button>
                </div>
              )}

              {/* Passive no-contract warning — shown only when a work is selected and has no contract link */}
              {selectedRepId && !selectedRepHasContract && (
                <div className="flex items-start gap-2.5 px-3 py-2.5 rounded-lg text-xs border" style={getNoticePanelStyle('warning')}>
                  <AlertTriangle size={12} className="shrink-0 mt-0.5" />
                  <div className="space-y-1.5">
                    <p>
                      <strong>No publishing contract linked to this work.</strong>{' '}
                      This income can be matched now, but it will not appear in statements until a contract is added on the repertoire record.
                    </p>
                    {selectedRep && (
                      <Link
                        href={`/repertoire?edit=${selectedRep.id}`}
                        target="_blank"
                        className="inline-flex items-center gap-1 underline underline-offset-2"
                        style={{ color: 'var(--ops-text)' }}
                      >
                        Open Work in Repertoire <ExternalLink size={10} />
                      </Link>
                    )}
                  </div>
                </div>
              )}
                </>
              )}
            </div>
          )}

          {/* ── linked publishing issue flow: matched work info ── */}
          {(errorType === 'missing_contract' || errorType === 'missing_allocation') && (
            <div className="text-xs p-3 rounded-lg border" style={{ borderColor: 'var(--ops-border)', background: 'var(--ops-surface-2)' }}>
              <div className="text-ops-muted mb-1 font-medium">Matched Work</div>
              {selectedRep ? (
                <div className="flex items-center justify-between">
                    <div>
                      <div className="font-medium text-ops-text">{selectedRep.title}</div>
                      {selectedRep.writer_name && (
                        <div className="text-[11px] text-ops-subtle max-w-[360px] truncate" title={selectedRep.writer_name}>
                          Writers: {selectedRep.writer_name}
                        </div>
                      )}
                      <div className="font-mono text-ops-muted text-[10px]">
                        {getPublishingIdentifierLabel(selectedRep)}
                        {selectedRep.artist_name && ` · ${selectedRep.artist_name}`}
                      </div>
                    </div>
                  <Link href={`/repertoire?edit=${selectedRep.id}`} target="_blank" className="text-blue-400 hover:underline flex items-center gap-1">
                    View <ExternalLink size={10} />
                  </Link>
                </div>
              ) : (
                <div className="text-amber-400 text-[11px]">
                  Repertoire item not loaded — re-open this panel after refreshing.
                </div>
              )}
              <div className="mt-2 px-2 py-1.5 rounded text-[11px] border" style={getNoticePanelStyle('info')}>
                <strong style={{ color: 'var(--ops-text)' }}>Note:</strong>{' '}
                {errorType === 'missing_contract'
                  ? 'Manage one or more contract links and shares below. This updates the same work-level contract links used elsewhere in the app.'
                  : 'This work is linked, but no statement allocation route is currently valid. Check contract link shares here, then confirm the linked contract has active payee links and usable publishing rates or splits.'}
              </div>
              {errorType === 'missing_contract' && (
                <div className="mt-2 flex items-center gap-2 flex-wrap">
                  <Link href={buildCreateContractHref(row)} className="btn-secondary btn-sm flex items-center gap-1.5">
                    <Plus size={12} />
                    Create Contract
                  </Link>
                  <Link href="/contracts" className="btn-ghost btn-sm flex items-center gap-1.5">
                    <ExternalLink size={12} />
                    Open Contracts
                  </Link>
                  <span className="text-[11px] text-ops-subtle">
                    After creating or linking the contract, return here and refresh this error.
                  </span>
                </div>
              )}
              {errorType === 'missing_allocation' && (
                <div className="mt-2 px-2 py-1.5 rounded text-[11px] border" style={getNoticePanelStyle('warning')}>
                  <strong style={{ color: 'var(--ops-text)' }}>Clear action:</strong>{' '}
                  {getMissingAllocationReason(row, contracts, payeeLinks, splits, contractRepertoireLinks) ?? 'Add the missing payout setup, then refresh Sales Errors.'}
                </div>
              )}
            </div>
          )}

          {/* ── linked publishing issue flow: contract link management ── */}
          {(errorType === 'missing_contract' || errorType === 'missing_allocation') && (
            <div className="space-y-2">
              <label className="form-label">{errorType === 'missing_contract' ? 'Manage Contract Links' : 'Review Contract Links'}</label>
              {selectedRepId && (
                <WorkContractLinksEditor
                  repertoireId={selectedRepId}
                  contracts={contracts}
                  onChanged={setSelectedRepHasContract}
                />
              )}
            </div>
          )}
        </div>

        {/* Footer */}
        <div className="flex items-center justify-between px-5 py-3 border-t flex-shrink-0" style={{ borderColor: 'var(--ops-border)' }}>
          <button className="btn-ghost btn-sm" onClick={onClose}>Cancel</button>
          <button
            className="btn-primary btn-sm flex items-center gap-1.5"
            disabled={saving || createMode || !selectedRepId}
            onClick={handleSave}
          >
            {saving ? <LoadingSpinner size={13} /> : <CheckCircle size={13} />}
            {saving ? 'Saving…' : 'Save & Continue'}
          </button>
        </div>
      </div>
    </div>
  )
}
