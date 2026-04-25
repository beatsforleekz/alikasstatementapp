import { calculateStatementRecord } from '@/lib/utils/balanceEngine'
import {
  buildPublishingAllocationRoutes,
  normalizePublishingIncomeType,
  type ContractRepertoireAllocationLink,
} from '@/lib/utils/publishingAllocation'
import type {
  Contract,
  ContractPayeeLink,
  ContractRepertoirePayeeSplit,
  Domain,
  ImportRow,
} from '@/lib/types'
import { isPublishingContractType } from '@/lib/types'

export interface StatementGenerationImportInfo {
  id: string
  source_name: string | null
  source_currency: string | null
  reporting_currency: string | null
  exchange_rate: number | null
}

export interface StatementGenerationCarryover {
  contract_id: string
  payee_id: string
  carried_amount: number | null
}

export interface StatementGenerationPreviousStatementCarryover {
  contract_id: string
  payee_id: string
  carry_forward_amount: number | null
  final_balance_after_carryover: number | null
  is_recouping: boolean | null
}

export interface StatementGenerationContractCost {
  id: string
  contract_id: string
  statement_period_id: string | null
  cost_type: string
  description: string
  cost_date: string | null
  amount: number
  currency: string
  recoupable: boolean
  applied_status: 'pending' | 'applied' | 'waived' | 'disputed'
  notes: string | null
}

export interface StatementGenerationMicroAllocation {
  id?: string
  source_import_row_id: string | null
  statement_period_id?: string | null
  contract_id: string
  payee_id: string
  domain: Domain
  carry_key: string
  title: string | null
  identifier: string | null
  income_type: string | null
  currency: string
  raw_amount: number
  status?: 'pending' | 'released'
}

export interface StatementGenerationDiagnostic {
  imports_found: number
  rows_fetched: number
  rows_repertoire_only: number
  rows_missing_payee: number
  rows_missing_contract: number
  rows_missing_splits: number
  rows_statement_ready: number
  rows_excluded: number
  statements_created: number
  statements_updated: number
  statements_skipped: number
  lines_written: number
  user_fixable: string[]
  system_issues: string[]
  currency_notes: string[]
  exclusion_reasons: string[]
  excluded_zero_value: number
  excluded_missing_setup: number
  excluded_manual: number
}

export interface PendingStatementLine {
  source_import_row_id: string | null
  line_category: string
  title: string | null
  identifier: string | null
  income_type: string | null
  transaction_date: string | null
  retailer_channel: string | null
  territory: string | null
  quantity: number | null
  gross_amount: number
  net_amount: number
  deduction_amount: number
  split_percent_applied: number | null
  rate_applied: number | null
  pre_split_amount: number | null
  notes: string | null
}

export interface StatementDraft {
  key: string
  contract_id: string
  payee_id: string
  statement_currency: string
  exchange_rate_snapshot: number | null
  payload: {
    contract_id: string
    payee_id: string
    statement_period_id: string
    domain: Domain
    royalty_share_snapshot: number
    opening_balance: number
    statement_currency: string
    exchange_rate_snapshot: number | null
    current_earnings: number
    deductions: number
    closing_balance_pre_carryover: number
    prior_period_carryover_applied: number
    final_balance_after_carryover: number
    payable_amount: number
    carry_forward_amount: number
    is_payable: boolean
    is_recouping: boolean
    hold_payment_flag: boolean
    balance_model: 'approach_b'
    calculation_status: 'calculated'
    last_calculated_at: string
  }
  lines: PendingStatementLine[]
  appliedCostIds: string[]
  microCarryReleaseKeys: string[]
  microCarryResidualRows: StatementGenerationMicroAllocation[]
}

interface StatementGenerationInput {
  domain: Domain
  statementPeriodId: string
  imports: StatementGenerationImportInfo[]
  rows: ImportRow[]
  contracts: Contract[]
  payeeLinks: ContractPayeeLink[]
  carryovers: StatementGenerationCarryover[]
  previousStatementCarryovers: StatementGenerationPreviousStatementCarryover[]
  contractCosts: StatementGenerationContractCost[]
  microAllocations: StatementGenerationMicroAllocation[]
  splits: ContractRepertoirePayeeSplit[]
  contractRepertoireLinks: ContractRepertoireAllocationLink[]
  outputCurrencyOverride: string
  selectedContractIds?: string[]
  restrictToSelectedContracts?: boolean
}

const roundMoney = (value: number) => Math.round(value * 100) / 100
const MICRO_RELEASE_THRESHOLD = 0.01

const addUnique = (arr: string[], message: string) => {
  if (!arr.includes(message)) arr.push(message)
}

const describeRow = (row: ImportRow): string => {
  const importRef = row.import_id
  const rowNumber = row.raw_row_number != null ? `row ${row.raw_row_number}` : `row ${row.id.slice(0, 8)}`
  const title = row.title_raw?.trim() || row.identifier_raw?.trim() || 'untitled row'
  const incomeType = row.income_type ? ` · ${row.income_type}` : ''
  return `${importRef} · ${rowNumber} · ${title}${incomeType}`
}

const buildMicroCarryKey = (parts: {
  domain: Domain
  contractId: string
  payeeId: string
  currency: string
  incomeType: string | null | undefined
  identifier: string | null | undefined
  title: string | null | undefined
}) => [
  parts.domain,
  parts.contractId,
  parts.payeeId,
  parts.currency,
  (parts.incomeType ?? 'other').trim().toLowerCase(),
  (parts.identifier ?? '').trim().toLowerCase(),
  (parts.title ?? '').trim().toLowerCase(),
].join('::')

export function generateStatementRunData({
  domain,
  statementPeriodId,
  imports,
  rows,
  contracts,
  payeeLinks,
  carryovers,
  previousStatementCarryovers,
  contractCosts,
  microAllocations,
  splits,
  contractRepertoireLinks,
  outputCurrencyOverride,
  selectedContractIds = [],
  restrictToSelectedContracts = selectedContractIds.length > 0,
}: StatementGenerationInput): {
  diagnostic: StatementGenerationDiagnostic
  drafts: StatementDraft[]
  microCarryRows: StatementGenerationMicroAllocation[]
} {
  const diagnostic: StatementGenerationDiagnostic = {
    imports_found: imports.length,
    rows_fetched: 0,
    rows_repertoire_only: 0,
    rows_missing_payee: 0,
    rows_missing_contract: 0,
    rows_missing_splits: 0,
    rows_statement_ready: 0,
    rows_excluded: 0,
    statements_created: 0,
    statements_updated: 0,
    statements_skipped: 0,
    lines_written: 0,
    user_fixable: [],
    system_issues: [],
    currency_notes: [],
    exclusion_reasons: [],
    excluded_zero_value: 0,
    excluded_missing_setup: 0,
    excluded_manual: 0,
  }

  const contractMap = new Map(contracts.map(contract => [contract.id, contract]))
  const selectedSet = new Set(selectedContractIds.filter(Boolean))
  const importCurrencyMap = new Map<string, StatementGenerationImportInfo>()
  const override = outputCurrencyOverride.trim().toUpperCase()
  const domainFallback = domain === 'publishing' ? 'EUR' : 'GBP'

  for (const imp of imports) {
    const hasFx = !!(imp.exchange_rate && imp.exchange_rate !== 1)
    const effectiveOutput = override || imp.reporting_currency || domainFallback
    importCurrencyMap.set(imp.id, { ...imp, reporting_currency: effectiveOutput })

    if (override) {
      if (effectiveOutput !== imp.reporting_currency && imp.reporting_currency) {
        diagnostic.currency_notes.push(
          `${imp.source_name ?? imp.id}: source=${imp.source_currency ?? '?'}, import output=${imp.reporting_currency}, OVERRIDE applied -> statement currency=${effectiveOutput}`
        )
      } else {
        diagnostic.currency_notes.push(
          `${imp.source_name ?? imp.id}: source=${imp.source_currency ?? '?'}, override=${effectiveOutput} (matches import output)`
        )
      }
    } else if (hasFx) {
      diagnostic.currency_notes.push(
        `${imp.source_name ?? imp.id}: source=${imp.source_currency ?? '?'} -> output=${effectiveOutput ?? '?'} via FX @ ${imp.exchange_rate}`
      )
    } else {
      diagnostic.currency_notes.push(
        `${imp.source_name ?? imp.id}: source=${imp.source_currency ?? '?'}, no FX -> statement currency=${effectiveOutput ?? imp.source_currency ?? domainFallback}`
      )
    }
  }

  const selectedLinks = restrictToSelectedContracts
    ? contractRepertoireLinks.filter(link => selectedSet.has(link.contract_id))
    : contractRepertoireLinks
  const selectedSplits = restrictToSelectedContracts
    ? splits.filter(split => selectedSet.has(split.contract_id))
    : splits
  const selectedPayeeLinks = restrictToSelectedContracts
    ? payeeLinks.filter(link => selectedSet.has(link.contract_id))
    : payeeLinks

  const eligiblePublishingRepertoireIds = restrictToSelectedContracts
    ? new Set([
        ...selectedLinks.map(link => link.repertoire_id),
        ...selectedSplits.map(split => split.repertoire_id),
      ])
    : null

  const matchedRows = rows.filter(row => {
    if (row.match_status === 'matched') return true
    if (domain !== 'publishing') return false
    if (row.match_status !== 'partial' || !row.matched_repertoire_id) return false
    const hasCurrentContractLink = selectedLinks.some(link => link.repertoire_id === row.matched_repertoire_id)
    return hasCurrentContractLink
  })

  const scopedRows = matchedRows.filter(row => {
    if (!restrictToSelectedContracts) return true
    if (domain === 'master') return !!row.matched_contract_id && selectedSet.has(row.matched_contract_id)
    return !!row.matched_repertoire_id && eligiblePublishingRepertoireIds?.has(row.matched_repertoire_id)
  })

  diagnostic.rows_fetched = scopedRows.length

  type Key = string
  const earningsMap = new Map<Key, number>()
  const deductionsMap = new Map<Key, number>()
  const pendingLines = new Map<Key, PendingStatementLine[]>()
  const appliedCostIdsMap = new Map<Key, string[]>()
  const statementCurrencyMap = new Map<Key, { currency: string; exchange_rate: number | null }>()
  const microCarryRows: StatementGenerationMicroAllocation[] = []
  const microCarryReleaseKeysByStatement = new Map<Key, Set<string>>()
  const microCarryResidualRowsByStatement = new Map<Key, StatementGenerationMicroAllocation[]>()
  const existingPendingMicroByCarryKey = new Map<string, StatementGenerationMicroAllocation[]>()
  const existingMicroSourceKeys = new Set(
    microAllocations
      .filter(entry => entry.source_import_row_id)
      .map(entry => `${entry.source_import_row_id}::${entry.contract_id}::${entry.payee_id}::${entry.carry_key}`)
  )

  for (const entry of microAllocations.filter(entry => entry.status !== 'released')) {
    const list = existingPendingMicroByCarryKey.get(entry.carry_key) ?? []
    list.push(entry)
    existingPendingMicroByCarryKey.set(entry.carry_key, list)
  }

  const addLine = (key: Key, line: PendingStatementLine) => {
    const list = pendingLines.get(key) ?? []
    list.push(line)
    pendingLines.set(key, list)
  }
  const addAppliedCostId = (key: Key, costId: string) => {
    const list = appliedCostIdsMap.get(key) ?? []
    list.push(costId)
    appliedCostIdsMap.set(key, list)
  }
  const addMicroCarryRow = (
    key: Key,
    row: ImportRow,
    rawAmount: number,
    currency: string,
    incomeType: string | null,
  ) => {
    const [contractId, payeeId] = key.split('::')
    const carryKey = buildMicroCarryKey({
      domain,
      contractId,
      payeeId,
      currency,
      incomeType,
      identifier: row.identifier_raw ?? null,
      title: row.title_raw ?? null,
    })
    const sourceKey = `${row.id}::${contractId}::${payeeId}::${carryKey}`
    if (existingMicroSourceKeys.has(sourceKey)) return true
    const microRow: StatementGenerationMicroAllocation = {
      source_import_row_id: row.id,
      statement_period_id: statementPeriodId,
      contract_id: contractId,
      payee_id: payeeId,
      domain,
      carry_key: carryKey,
      title: row.title_raw ?? null,
      identifier: row.identifier_raw ?? null,
      income_type: incomeType,
      currency,
      raw_amount: rawAmount,
      status: 'pending',
    }
    microCarryRows.push(microRow)
    existingMicroSourceKeys.add(sourceKey)

    const pendingTotal = (existingPendingMicroByCarryKey.get(carryKey) ?? [])
      .reduce((sum, entry) => sum + Number(entry.raw_amount ?? 0), 0)
    const combinedTotal = pendingTotal + rawAmount
    const releaseAmount = Math.trunc(combinedTotal * 100) / 100
    if (Math.abs(releaseAmount) < MICRO_RELEASE_THRESHOLD) return true
    const residualAmount = combinedTotal - releaseAmount

    if (!statementCurrencyMap.has(key)) {
      statementCurrencyMap.set(key, { currency, exchange_rate: null })
    }
    if (releaseAmount > 0) {
      earningsMap.set(key, (earningsMap.get(key) ?? 0) + releaseAmount)
    } else {
      deductionsMap.set(key, (deductionsMap.get(key) ?? 0) + Math.abs(releaseAmount))
    }
    addLine(key, {
      source_import_row_id: null,
      line_category: releaseAmount > 0 ? 'income' : 'deduction',
      title: row.title_raw ? `${row.title_raw} - rounding carry release` : 'Rounding carry release',
      identifier: row.identifier_raw ?? null,
      income_type: incomeType,
      transaction_date: null,
      retailer_channel: null,
      territory: null,
      quantity: null,
      gross_amount: 0,
      net_amount: releaseAmount > 0 ? releaseAmount : 0,
      deduction_amount: releaseAmount < 0 ? Math.abs(releaseAmount) : 0,
      split_percent_applied: null,
      rate_applied: null,
      pre_split_amount: combinedTotal,
      notes: `micro_allocation_release:${carryKey}; raw_total=${combinedTotal.toFixed(12)}`,
    })
    const releaseKeys = microCarryReleaseKeysByStatement.get(key) ?? new Set<string>()
    releaseKeys.add(carryKey)
    microCarryReleaseKeysByStatement.set(key, releaseKeys)
    existingPendingMicroByCarryKey.set(carryKey, [])
    if (Math.abs(residualAmount) > 0.000000000001) {
      const residualRows = microCarryResidualRowsByStatement.get(key) ?? []
      residualRows.push({
        source_import_row_id: null,
        statement_period_id: statementPeriodId,
        contract_id: contractId,
        payee_id: payeeId,
        domain,
        carry_key: carryKey,
        title: row.title_raw ?? null,
        identifier: row.identifier_raw ?? null,
        income_type: incomeType,
        currency,
        raw_amount: residualAmount,
        status: 'pending',
      })
      microCarryResidualRowsByStatement.set(key, residualRows)
    }
    return true
  }
  const excludeRow = (
    row: ImportRow,
    reason: string,
    bucket: 'user_fixable' | 'system_issues' = 'user_fixable',
    category: 'zero_value' | 'missing_setup' | 'manual' = 'missing_setup'
  ) => {
    diagnostic.rows_excluded++
    if (category === 'zero_value') diagnostic.excluded_zero_value++
    else if (category === 'manual') diagnostic.excluded_manual++
    else diagnostic.excluded_missing_setup++
    diagnostic.exclusion_reasons.push(`${describeRow(row)} -> ${reason}`)
    addUnique(diagnostic[bucket], reason)
  }

  const resolveAmount = (row: ImportRow, key: Key): number => {
    const impInfo = importCurrencyMap.get(row.import_id)
    const hasFx = !!(impInfo?.exchange_rate && impInfo.exchange_rate !== 1)

    if (!statementCurrencyMap.has(key)) {
      statementCurrencyMap.set(key, {
        currency: impInfo?.reporting_currency ?? impInfo?.source_currency ?? domainFallback,
        exchange_rate: hasFx ? (impInfo?.exchange_rate ?? null) : null,
      })
    }

    if (hasFx && row.amount_converted != null) return row.amount_converted
    return row.net_amount ?? row.amount ?? 0
  }

  if (domain === 'master') {
    for (const row of scopedRows) {
      if (!row.matched_contract_id) {
        diagnostic.rows_missing_contract++
        excludeRow(row, 'matched row missing matched_contract_id - re-run import matching', 'system_issues')
        continue
      }
      if (!row.matched_payee_id) {
        diagnostic.rows_missing_payee++
        excludeRow(row, 'matched row missing matched_payee_id - re-run import matching', 'system_issues')
        continue
      }

      const contract = contractMap.get(row.matched_contract_id)
      const artistShare = Number(contract?.artist_share_percent ?? 0)
      if (artistShare <= 0) {
        diagnostic.rows_missing_splits++
        excludeRow(
          row,
          `master contract "${contract?.contract_name ?? row.matched_contract_id}" has no artist_share_percent set - open the contract and enter the artist-side share`
        )
        continue
      }

      const key = `${row.matched_contract_id}::${row.matched_payee_id}`
      const grossAmount = resolveAmount(row, key)
      const currencyInfo = statementCurrencyMap.get(key)
      const currency = currencyInfo?.currency ?? importCurrencyMap.get(row.import_id)?.reporting_currency ?? importCurrencyMap.get(row.import_id)?.source_currency ?? domainFallback
      const isDeduction = row.row_type === 'deduction'
      const rawArtistAmount = grossAmount * artistShare
      const roundedArtistAmount = roundMoney(rawArtistAmount)
      const artistAmount = roundedArtistAmount

      if (rawArtistAmount !== 0 && roundedArtistAmount === 0) {
        const released = addMicroCarryRow(key, row, rawArtistAmount, currency, row.income_type ?? null)
        if (released) diagnostic.rows_statement_ready++
        continue
      }

      if (isDeduction) {
        deductionsMap.set(key, (deductionsMap.get(key) ?? 0) + Math.abs(roundedArtistAmount))
      } else {
        earningsMap.set(key, (earningsMap.get(key) ?? 0) + roundedArtistAmount)
      }

      diagnostic.rows_statement_ready++
      addLine(key, {
        source_import_row_id: row.id,
        line_category: isDeduction ? 'deduction' : 'income',
        title: row.title_raw ?? null,
        identifier: row.identifier_raw ?? null,
        income_type: row.income_type ?? null,
        transaction_date: row.transaction_date ?? null,
        retailer_channel: row.retailer ?? row.channel ?? null,
        territory: row.country_raw ?? null,
        quantity: row.quantity ?? null,
        gross_amount: isDeduction ? 0 : grossAmount,
        net_amount: isDeduction ? 0 : artistAmount,
        deduction_amount: isDeduction ? Math.abs(artistAmount) : 0,
        split_percent_applied: artistShare,
        rate_applied: artistShare,
        pre_split_amount: grossAmount,
        notes: `master:artist_share=${(artistShare * 100).toFixed(4)}%`,
      })
    }
  } else {
    diagnostic.rows_repertoire_only = scopedRows.filter(row => {
      if (!row.matched_repertoire_id) return false

      const hasSplitPath = selectedSplits.some(split =>
        split.repertoire_id === row.matched_repertoire_id &&
        split.is_active
      )

      if (hasSplitPath) return false

      const publishingLinks = selectedLinks.filter(link => {
        const contract = contractMap.get(link.contract_id)
        return (
          link.repertoire_id === row.matched_repertoire_id &&
          contract?.status === 'active' &&
          isPublishingContractType(contract.contract_type)
        )
      })

      if (publishingLinks.length === 0) return true

      const hasActivePayeePath = publishingLinks.some(link =>
        selectedPayeeLinks.some(payeeLink =>
          payeeLink.contract_id === link.contract_id &&
          payeeLink.is_active &&
          Number(payeeLink.royalty_share ?? 0) > 0
        )
      )

      return !hasActivePayeePath
    }).length

    for (const row of scopedRows) {
      if (!row.matched_repertoire_id) {
        diagnostic.rows_missing_contract++
        excludeRow(row, 'matched row missing matched_repertoire_id - re-run import matching', 'system_issues')
        continue
      }

      const normalizedIncomeType = normalizePublishingIncomeType(row.income_type)
      const isDeduction = row.row_type === 'deduction'
      const matchingSplits = selectedSplits.filter(split =>
        split.repertoire_id === row.matched_repertoire_id && split.is_active
      )

      if (matchingSplits.length > 0) {
        const routes = buildPublishingAllocationRoutes({
          repertoireId: row.matched_repertoire_id,
          incomeType: row.income_type,
          contracts,
          payeeLinks: selectedPayeeLinks,
          splits: selectedSplits,
          contractRepertoireLinks: selectedLinks,
        })

        if (routes.length === 0) {
          diagnostic.rows_missing_splits++
          excludeRow(row, 'splits exist but produced zero allocation - check income-type rates on contract')
          continue
        }

        let wroteLine = false
        for (const route of routes) {
          const key = `${route.contract_id}::${route.payee_id}`
          const sourceAmount = resolveAmount(row, key)
          const currencyInfo = statementCurrencyMap.get(key)
          const currency = currencyInfo?.currency ?? importCurrencyMap.get(row.import_id)?.reporting_currency ?? importCurrencyMap.get(row.import_id)?.source_currency ?? domainFallback
          const rawAllocation = sourceAmount * route.allocation_multiplier
          const roundedAllocation = roundMoney(rawAllocation)
          const allocation = roundedAllocation
          if (rawAllocation !== 0 && roundedAllocation === 0) {
            const released = addMicroCarryRow(key, row, rawAllocation, currency, normalizedIncomeType)
            wroteLine = wroteLine || released
            continue
          }
          if (allocation === 0) continue

          if (isDeduction) {
            deductionsMap.set(key, (deductionsMap.get(key) ?? 0) + Math.abs(roundedAllocation))
          } else {
            earningsMap.set(key, (earningsMap.get(key) ?? 0) + roundedAllocation)
          }

          addLine(key, {
            source_import_row_id: row.id,
            line_category: isDeduction ? 'deduction' : 'income',
            title: row.title_raw ?? null,
            identifier: row.identifier_raw ?? null,
            income_type: normalizedIncomeType,
            transaction_date: row.transaction_date ?? null,
            retailer_channel: row.retailer ?? row.channel ?? null,
            territory: row.country_raw ?? null,
            quantity: row.quantity ?? null,
            gross_amount: isDeduction ? 0 : sourceAmount,
            net_amount: isDeduction ? 0 : allocation,
            deduction_amount: isDeduction ? Math.abs(allocation) : 0,
            split_percent_applied: route.split_percent_applied,
            rate_applied: route.rate_applied,
            pre_split_amount: sourceAmount,
            notes: route.notes,
          })
          wroteLine = true
        }

        if (!wroteLine) {
          diagnostic.rows_missing_splits++
          excludeRow(row, 'allocation routes resolved but every line item amount was 0', 'user_fixable', 'zero_value')
          continue
        }

        diagnostic.rows_statement_ready++
        continue
      }

      const publishingLinks = selectedLinks.filter(link => {
        const contract = contractMap.get(link.contract_id)
        return (
          link.repertoire_id === row.matched_repertoire_id &&
          contract?.status === 'active' &&
          isPublishingContractType(contract.contract_type)
        )
      })

      if (publishingLinks.length === 0) {
        diagnostic.rows_missing_contract++
        excludeRow(row, 'work not linked to an active publishing contract - use "Link Work"')
        continue
      }

      const nullShareEntries = publishingLinks.filter(link => link.royalty_rate == null)
      const canInferSingleLinkShare = publishingLinks.length === 1 && nullShareEntries.length === 1
      if (nullShareEntries.length > 0 && !canInferSingleLinkShare) {
        diagnostic.rows_missing_splits++
        addUnique(
          diagnostic.user_fixable,
          `${nullShareEntries.length} contract link(s) have no share set - open the work in Repertoire and set a share % for each contract link`
        )
      }

      const totalShare = publishingLinks.reduce((sum, link) => sum + Number(link.royalty_rate ?? 0), 0)
      if (totalShare > 1.0005) {
        diagnostic.rows_missing_splits++
        excludeRow(
          row,
          `work has contract shares totalling ${(totalShare * 100).toFixed(1)}% (over 100%) - fix shares in Repertoire to prevent over-allocation`,
          'system_issues'
        )
        continue
      }

      const routes = buildPublishingAllocationRoutes({
        repertoireId: row.matched_repertoire_id,
        incomeType: row.income_type,
        contracts,
        payeeLinks: selectedPayeeLinks,
        splits: selectedSplits,
        contractRepertoireLinks: selectedLinks,
      }).filter(route => route.tier === 'tier2')

      const hasActivePayeeLink = publishingLinks.some(link =>
        selectedPayeeLinks.some(payeeLink =>
          payeeLink.contract_id === link.contract_id &&
          payeeLink.is_active &&
          Number(payeeLink.royalty_share ?? 0) > 0
        )
      )

      if (!hasActivePayeeLink) {
        diagnostic.rows_missing_payee++
        addUnique(diagnostic.user_fixable, 'contract has no active payee links - add payees to the contract')
      }

      if (routes.length === 0) {
        diagnostic.rows_missing_splits++
        excludeRow(
          row,
          'work->contract->payee produced zero allocation - check payee royalty_share, income-type rates, and contract share %'
        )
        continue
      }

      let wroteLine = false
      for (const route of routes) {
        const key = `${route.contract_id}::${route.payee_id}`
        const sourceAmount = resolveAmount(row, key)
        const currencyInfo = statementCurrencyMap.get(key)
        const currency = currencyInfo?.currency ?? importCurrencyMap.get(row.import_id)?.reporting_currency ?? importCurrencyMap.get(row.import_id)?.source_currency ?? domainFallback
        const rawAllocation = sourceAmount * route.allocation_multiplier
        const roundedAllocation = roundMoney(rawAllocation)
        const allocation = roundedAllocation
        if (rawAllocation !== 0 && roundedAllocation === 0) {
          const released = addMicroCarryRow(key, row, rawAllocation, currency, normalizedIncomeType)
          wroteLine = wroteLine || released
          continue
        }
        if (allocation === 0) continue

        if (isDeduction) {
          deductionsMap.set(key, (deductionsMap.get(key) ?? 0) + Math.abs(roundedAllocation))
        } else {
          earningsMap.set(key, (earningsMap.get(key) ?? 0) + roundedAllocation)
        }

        addLine(key, {
          source_import_row_id: row.id,
          line_category: isDeduction ? 'deduction' : 'income',
          title: row.title_raw ?? null,
          identifier: row.identifier_raw ?? null,
          income_type: normalizedIncomeType,
          transaction_date: row.transaction_date ?? null,
          retailer_channel: row.retailer ?? row.channel ?? null,
          territory: row.country_raw ?? null,
          quantity: row.quantity ?? null,
          gross_amount: isDeduction ? 0 : sourceAmount,
          net_amount: isDeduction ? 0 : allocation,
          deduction_amount: isDeduction ? Math.abs(allocation) : 0,
          split_percent_applied: route.split_percent_applied,
          rate_applied: route.rate_applied,
          pre_split_amount: sourceAmount,
          notes: route.notes,
        })
        wroteLine = true
      }

      if (!wroteLine) {
        diagnostic.rows_missing_splits++
        excludeRow(row, 'allocation routes resolved but every line item amount was 0', 'user_fixable', 'zero_value')
        continue
      }

      diagnostic.rows_statement_ready++
    }
  }

  const carryoverMap = new Map(
    carryovers.map(carryover => [`${carryover.contract_id}::${carryover.payee_id}`, carryover])
  )
  const previousStatementCarryoverMap = new Map(
    previousStatementCarryovers.map(previous => [`${previous.contract_id}::${previous.payee_id}`, previous])
  )
  const payeeLinkMap = new Map(
    selectedPayeeLinks.map(link => [`${link.contract_id}::${link.payee_id}`, link])
  )

  for (const cost of contractCosts.filter(cost => cost.applied_status !== 'waived' && cost.applied_status !== 'disputed')) {
    const costPayeeLinks = selectedPayeeLinks.filter(link =>
      link.contract_id === cost.contract_id &&
      link.is_active &&
      Number(link.royalty_share ?? 0) > 0
    )

    for (const payeeLink of costPayeeLinks) {
      const key = `${cost.contract_id}::${payeeLink.payee_id}`
      const allocatedCost = roundMoney(Number(cost.amount ?? 0) * Number(payeeLink.royalty_share ?? 0))
      if (allocatedCost === 0) continue

      if (!statementCurrencyMap.has(key)) {
        statementCurrencyMap.set(key, {
          currency: cost.currency || domainFallback,
          exchange_rate: null,
        })
      }

      if (cost.recoupable) {
        deductionsMap.set(key, (deductionsMap.get(key) ?? 0) + Math.abs(allocatedCost))
      }

      addLine(key, {
        source_import_row_id: null,
        line_category: 'cost',
        title: cost.description || `Contract cost: ${cost.cost_type}`,
        identifier: null,
        income_type: 'other',
        transaction_date: cost.cost_date ?? null,
        retailer_channel: null,
        territory: null,
        quantity: null,
        gross_amount: 0,
        net_amount: cost.recoupable ? -Math.abs(allocatedCost) : 0,
        deduction_amount: cost.recoupable ? Math.abs(allocatedCost) : 0,
        split_percent_applied: payeeLink.royalty_share ?? null,
        rate_applied: null,
        pre_split_amount: Number(cost.amount ?? 0),
        notes: `${cost.recoupable ? 'recoupable' : 'non-recoupable'} cost · ${cost.cost_type}`,
      })
      addAppliedCostId(key, cost.id)
    }
  }

  const allKeys = Array.from(new Set([
    ...Array.from(earningsMap.keys()),
    ...Array.from(deductionsMap.keys()),
    ...Array.from(appliedCostIdsMap.keys()),
  ]))
  const drafts: StatementDraft[] = []
  for (const key of allKeys) {
    const [contract_id, payee_id] = key.split('::')
    const earnings = earningsMap.get(key) ?? 0
    const deductions = deductionsMap.get(key) ?? 0

    if (earnings === 0 && deductions === 0) {
      diagnostic.statements_skipped++
      continue
    }

    const contract = contractMap.get(contract_id) ?? null
    const carryover = carryoverMap.get(key)
    const previousStatementCarryover = previousStatementCarryoverMap.get(key)
    const inferredPreviousCarryover = previousStatementCarryover
      ? (
          previousStatementCarryover.is_recouping
            ? Number(previousStatementCarryover.final_balance_after_carryover ?? 0)
            : Number(previousStatementCarryover.carry_forward_amount ?? 0)
        )
      : 0
    const priorCarryover = carryover?.carried_amount ?? inferredPreviousCarryover
    const calc = calculateStatementRecord(0, earnings, deductions, priorCarryover, contract)
    const payeeLink = payeeLinkMap.get(key)
    const royaltyShare = payeeLink?.royalty_share ?? 0
    const currencyInfo = statementCurrencyMap.get(key)

    drafts.push({
      key,
      contract_id,
      payee_id,
      statement_currency: currencyInfo?.currency ?? domainFallback,
      exchange_rate_snapshot: currencyInfo?.exchange_rate ?? null,
      payload: {
        contract_id,
        payee_id,
        statement_period_id: statementPeriodId,
        domain,
        royalty_share_snapshot: royaltyShare,
        opening_balance: 0,
        statement_currency: currencyInfo?.currency ?? domainFallback,
        exchange_rate_snapshot: currencyInfo?.exchange_rate ?? null,
        current_earnings: calc.current_earnings,
        deductions: calc.deductions,
        closing_balance_pre_carryover: calc.closing_balance_pre_carryover,
        prior_period_carryover_applied: calc.prior_period_carryover_applied,
        final_balance_after_carryover: calc.final_balance_after_carryover,
        payable_amount: calc.payable_amount,
        carry_forward_amount: calc.carry_forward_amount,
        is_payable: calc.is_payable,
        is_recouping: calc.is_recouping,
        hold_payment_flag: Boolean(contract?.hold_payment_flag ?? false),
        balance_model: 'approach_b',
        calculation_status: 'calculated',
        last_calculated_at: new Date().toISOString(),
      },
      lines: pendingLines.get(key) ?? [],
      appliedCostIds: appliedCostIdsMap.get(key) ?? [],
      microCarryReleaseKeys: Array.from(microCarryReleaseKeysByStatement.get(key) ?? []),
      microCarryResidualRows: microCarryResidualRowsByStatement.get(key) ?? [],
    })
  }

  return { diagnostic, drafts, microCarryRows }
}
