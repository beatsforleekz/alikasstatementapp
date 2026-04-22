import type {
  Contract,
  ContractPayeeLink,
  ContractRepertoirePayeeSplit,
} from '@/lib/types'
import { incomeTypeToRateColumn, isPublishingContractType } from '@/lib/types'

export interface ContractRepertoireAllocationLink {
  contract_id: string
  repertoire_id: string
  royalty_rate: number | null
}

export interface PublishingAllocationRoute {
  tier: 'tier1' | 'tier2'
  contract_id: string
  payee_id: string
  allocation_multiplier: number
  pre_split_multiplier: number
  split_percent_applied: number | null
  rate_applied: number | null
  notes: string
}

interface EffectivePublishingContractLink extends ContractRepertoireAllocationLink {
  effective_royalty_rate: number
  inferred: boolean
}

const EXACT_INCOME_TYPE_MAP: Record<string, string> = {
  genperf: 'performance',
  perf: 'performance',
  'tv perf': 'performance',
  lperf: 'performance',
  filmperf: 'performance',
  dpdprf: 'performance',
  strmprf: 'performance',
  mstrmprf: 'performance',
  konlnper: 'performance',
  mechperf: 'mechanical',
  dpdmech: 'mechanical',
  'phy mech': 'mechanical',
  strmmech: 'mechanical',
  mstrmmch: 'mechanical',
  mdpdmech: 'mechanical',
  isync: 'synch',
  sync: 'synch',
  syncvid: 'synch',
}

export function normalizePublishingIncomeType(raw: string | null | undefined): string {
  if (!raw) return 'other'
  const key = raw.trim().toLowerCase()

  if (EXACT_INCOME_TYPE_MAP[key]) return EXACT_INCOME_TYPE_MAP[key]
  if (key === 'mechanical' || key === 'digital_mechanical' || key === 'performance' || key === 'digital_performance' || key === 'synch' || key === 'other') {
    return key
  }
  if (key.includes('sync')) return 'synch'
  if (key.includes('mech')) return 'mechanical'
  if (key.includes('perf')) return 'performance'
  return 'other'
}

interface PublishingAllocationCheckInput {
  repertoireId: string | null | undefined
  incomeType: string | null | undefined
  contracts: Contract[]
  payeeLinks: ContractPayeeLink[]
  splits: ContractRepertoirePayeeSplit[]
  contractRepertoireLinks: ContractRepertoireAllocationLink[]
  candidateContractId?: string | null
}

export function buildPublishingAllocationRoutes({
  repertoireId,
  incomeType,
  contracts,
  payeeLinks,
  splits,
  contractRepertoireLinks,
  candidateContractId = null,
}: PublishingAllocationCheckInput): PublishingAllocationRoute[] {
  if (!repertoireId) return []

  const normalizedIncomeType = normalizePublishingIncomeType(incomeType)
  const activeContracts = new Map(
    contracts
      .filter(contract => contract.status === 'active' && isPublishingContractType(contract.contract_type))
      .map(contract => [contract.id, contract])
  )

  const eligibleSplits = splits.filter(split =>
    split.repertoire_id === repertoireId &&
    split.is_active &&
    (!candidateContractId || split.contract_id === candidateContractId)
  )
  const splitScopedContractIds = new Set(eligibleSplits.map(split => split.contract_id))

  const tier1Routes: PublishingAllocationRoute[] = []
  for (const split of eligibleSplits) {
    const contract = activeContracts.get(split.contract_id)
    if (!contract) continue

    const rateColumn = incomeTypeToRateColumn(normalizedIncomeType)
    const rate = Number(contract[rateColumn] ?? 0)
    if (rate <= 0) continue

    const allocationMultiplier = rate * Number(split.split_percent ?? 0)
    if (allocationMultiplier <= 0) continue

    tier1Routes.push({
      tier: 'tier1',
      contract_id: split.contract_id,
      payee_id: split.payee_id,
      allocation_multiplier: allocationMultiplier,
      pre_split_multiplier: rate,
      split_percent_applied: split.split_percent,
      rate_applied: rate,
      notes: 'tier1:splits',
    })
  }

  const eligibleContractLinks = contractRepertoireLinks.filter(link =>
    link.repertoire_id === repertoireId &&
    (!candidateContractId || link.contract_id === candidateContractId) &&
    !splitScopedContractIds.has(link.contract_id)
  )

  const activeEligibleContractLinks = eligibleContractLinks.filter(link =>
    activeContracts.has(link.contract_id)
  )

  const explicitShareLinks = activeEligibleContractLinks.filter(link =>
    link.royalty_rate != null && link.royalty_rate > 0
  )

  const effectiveContractLinks: EffectivePublishingContractLink[] = explicitShareLinks.map(link => ({
    ...link,
    effective_royalty_rate: Number(link.royalty_rate ?? 0),
    inferred: false,
  }))

  // Legacy publishing links may exist with no stored royalty_rate. If a work has
  // exactly one active linked publishing contract and no explicit share, treat it
  // as 100% so historical links still allocate without manual relinking.
  if (effectiveContractLinks.length === 0 && activeEligibleContractLinks.length === 1) {
    effectiveContractLinks.push({
      ...activeEligibleContractLinks[0],
      effective_royalty_rate: 1,
      inferred: true,
    })
  }

  const totalShare = effectiveContractLinks.reduce((sum, link) => sum + link.effective_royalty_rate, 0)
  if (totalShare > 1.0005) return []

  const tier2Routes: PublishingAllocationRoute[] = []
  for (const link of effectiveContractLinks) {
    const contract = activeContracts.get(link.contract_id)
    if (!contract) continue

    const activePayeeLinks = payeeLinks.filter(payeeLink =>
      payeeLink.contract_id === link.contract_id &&
      payeeLink.is_active &&
      Number(payeeLink.royalty_share ?? 0) > 0
    )

    const contractShare = link.effective_royalty_rate
    if (contractShare <= 0) continue

    const rateColumn = incomeTypeToRateColumn(normalizedIncomeType)
    const rate = Number(contract[rateColumn] ?? 0)
    const preSplitMultiplier = contractShare * (rate > 0 ? rate : 1)

    for (const payeeLink of activePayeeLinks) {
      const payeeShare = Number(payeeLink.royalty_share ?? 0)
      const allocationMultiplier = preSplitMultiplier * payeeShare
      if (allocationMultiplier <= 0) continue

      tier2Routes.push({
        tier: 'tier2',
        contract_id: link.contract_id,
        payee_id: payeeLink.payee_id,
        allocation_multiplier: allocationMultiplier,
        pre_split_multiplier: preSplitMultiplier,
        split_percent_applied: contractShare,
        rate_applied: rate > 0 ? rate : null,
        notes: link.inferred
          ? 'tier2:crl+cpl:share=100.00%(inferred_single_link)'
          : `tier2:crl+cpl:share=${(contractShare * 100).toFixed(2)}%`,
      })
    }
  }

  return [...tier1Routes, ...tier2Routes]
}

export function canAllocatePublishingStatementRow(input: PublishingAllocationCheckInput): boolean {
  return buildPublishingAllocationRoutes(input).length > 0
}
