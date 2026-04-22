/**
 * IMPORT MATCHING ENGINE — v2
 *
 * Matches imported rows against contracts, payees, and repertoire.
 *
 * CRITICAL MODEL NOTE:
 * Contracts do not have a payee_id. The relationship between contracts
 * and payees is defined by contract_payee_links (a junction table).
 *
 * DOMAIN-SPECIFIC MATCHING BEHAVIOUR:
 *
 *   MASTER imports:
 *     Match order: contract → payee → repertoire (independent)
 *     Both contract + payee must resolve for status = 'matched'.
 *
 *   PUBLISHING imports:
 *     Match order: identifier (Tempo ID primary, ISWC fallback) → repertoire
 *     → contracts linked to that work → valid payable payees
 *     (from contract_repertoire_payee_splits).
 *     Payee name and contract name in source row are NOT required and NOT used
 *     as primary match keys. A row is considered matched if the Tempo ID (or
 *     ISWC fallback) resolves to a repertoire item — payee/contract resolution
 *     happens during allocation.
 *     If identifier matches repertoire → match_status = 'matched' (even without
 *     payee/contract in source row).
 *
 * PAYEE ALIAS MATCHING:
 *   For both domains, payee name matching also checks payee_aliases.alias_name
 *   (case-insensitive, trimmed) in addition to payee_name and statement_name.
 *
 * PUBLISHING ALLOCATION (processPublishingRow):
 *   Once a publishing row is matched to a repertoire item, allocation is computed
 *   per payee using contract_repertoire_payee_splits as the source of truth.
 *   A payee listed in the source CSV who has no split row receives no allocation.
 *
 * Unmatched rows are NEVER discarded silently — they surface in Exceptions.
 */

import type {
  ImportRow,
  Payee,
  PayeeAlias,
  Contract,
  ContractPayeeLink,
  ContractRepertoirePayeeSplit,
  Repertoire,
  PublishingAllocationResult,
} from '@/lib/types'
import { contractTypeToDomain, incomeTypeToRateColumn } from '@/lib/types'

// ============================================================
// TEXT NORMALIZATION
// ============================================================

/** Normalize for fuzzy matching: lowercase, trim, collapse whitespace, strip punctuation */
export function normalizeText(text: string | null | undefined): string {
  if (!text) return ''
  return text
    .toLowerCase()
    .trim()
    .replace(/[^\w\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

/** Normalize an identifier (ISRC, UPC, ISWC, Tempo ID): strip hyphens, spaces, uppercase */
export function normalizeIdentifier(id: string | null | undefined): string {
  if (!id) return ''
  return id.replace(/[-\s.]/g, '').toUpperCase()
}

// ============================================================
// CONTRACT MATCHING
// ============================================================

export interface ContractMatchResult {
  matched_contract_id:  string | null
  match_confidence:     'exact' | 'normalized' | 'none'
}

/**
 * Match a raw contract name/code against known contracts.
 * For publishing, contract matching is secondary — the primary path is
 * Tempo ID → repertoire → contracts linked to that work.
 */
export function matchContract(
  rawContractName:   string | null,
  domain:            string,
  contracts:         Contract[],
  payeeLinks:        ContractPayeeLink[],
  matchedPayeeId:    string | null
): ContractMatchResult {
  const domainContracts = contracts.filter(
    c => contractTypeToDomain(c.contract_type) === domain && c.status === 'active'
  )

  if (!rawContractName) {
    if (matchedPayeeId) {
      const payeeContractIds = new Set(
        payeeLinks
          .filter(l => l.payee_id === matchedPayeeId && l.is_active)
          .map(l => l.contract_id)
      )
      const payeeDomainContracts = domainContracts.filter(c => payeeContractIds.has(c.id))
      if (payeeDomainContracts.length === 1) {
        return { matched_contract_id: payeeDomainContracts[0].id, match_confidence: 'exact' }
      }
    }
    return { matched_contract_id: null, match_confidence: 'none' }
  }

  const normalized = normalizeText(rawContractName)

  const exactName = domainContracts.find(
    c => c.contract_name.toLowerCase().trim() === rawContractName.toLowerCase().trim()
  )
  if (exactName) return { matched_contract_id: exactName.id, match_confidence: 'exact' }

  const exactCode = domainContracts.find(
    c => c.contract_code?.toLowerCase().trim() === rawContractName.toLowerCase().trim()
  )
  if (exactCode) return { matched_contract_id: exactCode.id, match_confidence: 'exact' }

  const normName = domainContracts.find(c => normalizeText(c.contract_name) === normalized)
  if (normName) return { matched_contract_id: normName.id, match_confidence: 'normalized' }

  const normCode = domainContracts.find(c => normalizeText(c.contract_code) === normalized)
  if (normCode) return { matched_contract_id: normCode.id, match_confidence: 'normalized' }

  return { matched_contract_id: null, match_confidence: 'none' }
}

// ============================================================
// PAYEE MATCHING
// Includes alias lookup (case-insensitive, trimmed).
// ============================================================

export interface PayeeMatchResult {
  matched_payee_id:  string | null
  match_confidence:  'exact' | 'normalized' | 'alias' | 'none'
}

/**
 * Match a raw payee name against known payees.
 *
 * Priority:
 *   1. Exact payee_name match
 *   2. Exact statement_name match (payee-level)
 *   3. Exact ContractPayeeLink.statement_name (contract-specific override)
 *   4. Alias match (payee_aliases table, case-insensitive, trimmed)
 *   5. Normalized name match
 */
export function matchPayee(
  rawName:           string | null,
  payees:            Payee[],
  payeeLinks:        ContractPayeeLink[],
  aliases:           PayeeAlias[],           // all active aliases
  matchedContractId: string | null = null
): PayeeMatchResult {
  if (!rawName) return { matched_payee_id: null, match_confidence: 'none' }

  let candidates = payees
  if (matchedContractId) {
    const linkedPayeeIds = new Set(
      payeeLinks
        .filter(l => l.contract_id === matchedContractId && l.is_active)
        .map(l => l.payee_id)
    )
    if (linkedPayeeIds.size > 0) {
      candidates = payees.filter(p => linkedPayeeIds.has(p.id))
    }
  }

  const rawLower   = rawName.toLowerCase().trim()
  const normalized = normalizeText(rawName)

  // 1. Exact payee_name
  const byName = candidates.find(p => p.payee_name.toLowerCase().trim() === rawLower)
  if (byName) return { matched_payee_id: byName.id, match_confidence: 'exact' }

  // 2. Exact statement_name (payee-level)
  const byStmtName = candidates.find(
    p => p.statement_name?.toLowerCase().trim() === rawLower
  )
  if (byStmtName) return { matched_payee_id: byStmtName.id, match_confidence: 'exact' }

  // 3. Exact ContractPayeeLink.statement_name (contract-specific override)
  if (matchedContractId) {
    const byLinkName = payeeLinks.find(
      l =>
        l.contract_id === matchedContractId &&
        l.is_active &&
        l.statement_name?.toLowerCase().trim() === rawLower
    )
    if (byLinkName) return { matched_payee_id: byLinkName.payee_id, match_confidence: 'exact' }
  }

  // 4. Alias match (case-insensitive, trimmed) — searches all active aliases
  const activeAliases = aliases.filter(a => a.is_active)
  const byAlias = activeAliases.find(a => a.alias_name.toLowerCase().trim() === rawLower)
  if (byAlias) {
    // Verify the aliased payee is a valid candidate (or unrestricted if no contract)
    const aliasedPayee = candidates.find(p => p.id === byAlias.payee_id)
    if (aliasedPayee) {
      return { matched_payee_id: aliasedPayee.id, match_confidence: 'alias' }
    }
    // If no contract restriction, try from all payees
    if (!matchedContractId) {
      const globalPayee = payees.find(p => p.id === byAlias.payee_id)
      if (globalPayee) {
        return { matched_payee_id: globalPayee.id, match_confidence: 'alias' }
      }
    }
  }

  // 5. Normalized name match
  const byNorm = candidates.find(
    p =>
      normalizeText(p.payee_name) === normalized ||
      normalizeText(p.statement_name) === normalized
  )
  if (byNorm) return { matched_payee_id: byNorm.id, match_confidence: 'normalized' }

  // 6. Single candidate + matched contract → weak match (will warn)
  if (candidates.length === 1 && matchedContractId) {
    return { matched_payee_id: candidates[0].id, match_confidence: 'normalized' }
  }

  return { matched_payee_id: null, match_confidence: 'none' }
}

// ============================================================
// REPERTOIRE MATCHING
//
// Publishing identifier priority:
//   1. tempo_id exact match  (Tempo ID / Sony Song ID — primary)
//   2. iswc exact match      (fallback if tempo_id missing)
//   3. source_id             (legacy fallback)
//
// Master identifier priority: ISRC → UPC → source_id → internal_code
//
// Title matching applies to both domains as a last resort and results
// in match_confidence = 'exact_title' | 'normalized_title' (treated as
// partial, not full match for publishing).
// ============================================================

export interface RepertoireMatchResult {
  matched_repertoire_id: string | null
  match_confidence:      'exact_identifier' | 'exact_title' | 'normalized_title' | 'none'
  identifier_type?:      'tempo_id' | 'iswc' | 'isrc' | 'upc' | 'source_id' | 'internal_code'
  failure_reason?:       'unmatched' | 'duplicate_title' | 'ambiguous_identifier_mismatch'
}

function looksLikeISWC(value: string | null | undefined): boolean {
  return /^T[-\s]?[\d]{3}[.\s]?[\d]{3}[.\s]?[\d]{3}[-\s]?[\d]$/i.test((value ?? '').trim())
}

function matchPublishingRepertoire(
  rawTempoId: string | null,
  _rawIswc: string | null,
  rawTitle: string | null,
  _rawArtist: string | null,
  repertoire: Repertoire[]
): RepertoireMatchResult {
  const tempoId = normalizeIdentifier(rawTempoId)
  const normTitle = normalizeText(rawTitle)

  if (tempoId) {
    const byTempoId = repertoire.find(r => normalizeIdentifier(r.tempo_id) === tempoId)
    if (byTempoId) {
      return {
        matched_repertoire_id: byTempoId.id,
        match_confidence: 'exact_identifier',
        identifier_type: 'tempo_id',
      }
    }
    return {
      matched_repertoire_id: null,
      match_confidence: 'none',
      failure_reason: 'unmatched',
    }
  }

  if (normTitle) {
    const titleMatches = repertoire.filter(r => normalizeText(r.title) === normTitle)
    if (titleMatches.length === 0) {
      return {
        matched_repertoire_id: null,
        match_confidence: 'none',
        failure_reason: 'unmatched',
      }
    }

    if (titleMatches.some(r => normalizeIdentifier((r as any).tempo_id))) {
      return {
        matched_repertoire_id: null,
        match_confidence: 'none',
        failure_reason: 'ambiguous_identifier_mismatch',
      }
    }

    if (titleMatches.length > 1) {
      return {
        matched_repertoire_id: null,
        match_confidence: 'none',
        failure_reason: 'duplicate_title',
      }
    }

    return {
      matched_repertoire_id: titleMatches[0].id,
      match_confidence: 'normalized_title',
    }
  }

  return {
    matched_repertoire_id: null,
    match_confidence: 'none',
    failure_reason: 'unmatched',
  }
}

export function matchRepertoire(
  rawIdentifier: string | null,
  rawTitle:      string | null,
  rawArtist:     string | null,
  repertoire:    Repertoire[],
  domain:        'master' | 'publishing' = 'master'
): RepertoireMatchResult {
  const normId     = normalizeIdentifier(rawIdentifier)
  const normTitle  = normalizeText(rawTitle)
  const normArtist = normalizeText(rawArtist)

  if (normId) {
    if (domain === 'publishing') {
      // Publishing: Tempo ID is the primary identifier
      // tempo_id is stored on the repertoire row (maps to Sony Song ID)
      const byTempoId = repertoire.find(r => normalizeIdentifier((r as any).tempo_id) === normId)
      if (byTempoId) return {
        matched_repertoire_id: byTempoId.id,
        match_confidence: 'exact_identifier',
        identifier_type: 'tempo_id',
      }

      // Fallback 1: ISWC
      const byISWC = repertoire.find(r => normalizeIdentifier(r.iswc) === normId)
      if (byISWC) return {
        matched_repertoire_id: byISWC.id,
        match_confidence: 'exact_identifier',
        identifier_type: 'iswc',
      }

      // Fallback 2: source_id (may contain Tempo ID or ISWC stored before dedicated columns)
      const bySource = repertoire.find(r => normalizeIdentifier(r.source_id) === normId)
      if (bySource) return {
        matched_repertoire_id: bySource.id,
        match_confidence: 'exact_identifier',
        identifier_type: 'source_id',
      }
    } else {
      // Master: ISRC → UPC → source_id → internal_code
      const byISRC = repertoire.find(r => normalizeIdentifier(r.isrc) === normId)
      if (byISRC) return {
        matched_repertoire_id: byISRC.id,
        match_confidence: 'exact_identifier',
        identifier_type: 'isrc',
      }

      const byUPC = repertoire.find(r => normalizeIdentifier(r.upc) === normId)
      if (byUPC) return {
        matched_repertoire_id: byUPC.id,
        match_confidence: 'exact_identifier',
        identifier_type: 'upc',
      }

      const bySource = repertoire.find(r => normalizeIdentifier(r.source_id) === normId)
      if (bySource) return {
        matched_repertoire_id: bySource.id,
        match_confidence: 'exact_identifier',
        identifier_type: 'source_id',
      }

      const byCode = repertoire.find(r => r.internal_code?.toUpperCase() === normId)
      if (byCode) return {
        matched_repertoire_id: byCode.id,
        match_confidence: 'exact_identifier',
        identifier_type: 'internal_code',
      }
    }
  }

  // Title matching (both domains) — last resort only; titles are not primary keys
  if (rawTitle) {
    const byExact = repertoire.find(
      r => r.title.toLowerCase().trim() === rawTitle.toLowerCase().trim()
    )
    if (byExact) return { matched_repertoire_id: byExact.id, match_confidence: 'exact_title' }
  }

  if (normTitle && normArtist) {
    const byBoth = repertoire.find(
      r => normalizeText(r.title) === normTitle && normalizeText(r.artist_name) === normArtist
    )
    if (byBoth) return { matched_repertoire_id: byBoth.id, match_confidence: 'normalized_title' }
  }

  if (normTitle) {
    const byTitle = repertoire.find(r => normalizeText(r.title) === normTitle)
    if (byTitle) return { matched_repertoire_id: byTitle.id, match_confidence: 'normalized_title' }
  }

  return { matched_repertoire_id: null, match_confidence: 'none' }
}

// ============================================================
// MATCH STATUS
// ============================================================

export type MatchStatus = 'matched' | 'partial' | 'unmatched' | 'manual_override'

/**
 * Resolve overall match_status for master imports.
 * 'matched' = both contract and payee resolved.
 */
export function resolveMatchStatus(
  contractMatch: ContractMatchResult,
  payeeMatch:    PayeeMatchResult
): MatchStatus {
  const hasContract = !!contractMatch.matched_contract_id
  const hasPayee    = !!payeeMatch.matched_payee_id
  if (hasContract && hasPayee) return 'matched'
  if (hasContract || hasPayee) return 'partial'
  return 'unmatched'
}

/**
 * Resolve overall match_status for publishing imports.
 *
 * Publishing rows are considered matched whenever a repertoire row is resolved.
 */
export function resolvePublishingMatchStatus(
  reperMatch: RepertoireMatchResult
): MatchStatus {
  if (!reperMatch.matched_repertoire_id) return 'unmatched'
  return 'matched'
}

// ============================================================
// PUBLISHING ALLOCATION ENGINE
// ============================================================

/**
 * For a matched publishing import row, compute the allocation per payee.
 *
 * Algorithm per row:
 *   1. Row is matched to a repertoire item (via Tempo ID, ISWC fallback, or title).
 *   2. Find all active contract_repertoire_payee_splits for that repertoire item.
 *   3. For each split row (= one payee on one contract for this work):
 *      a. Find the contract's royalty rate for the row's income_type.
 *      b. allocated = source_amount × income_type_rate × split_percent
 *      c. Emit a PublishingAllocationResult for that payee.
 *   4. Payees NOT in contract_repertoire_payee_splits receive ZERO allocation.
 *
 * Important: source CSV writer name is ignored for allocation.
 * Only stored splits determine who gets paid.
 */
export function allocatePublishingRow(
  sourceAmount:    number,
  incomeType:      string | null,
  repertoireId:    string,
  contracts:       Contract[],
  splits:          ContractRepertoirePayeeSplit[]  // all active splits for this repertoire
): PublishingAllocationResult[] {
  const results: PublishingAllocationResult[] = []

  // Filter to active splits for this work
  const workSplits = splits.filter(
    s => s.repertoire_id === repertoireId && s.is_active
  )

  if (workSplits.length === 0) {
    return []  // no authorised payees — exception will be raised by caller
  }

  for (const split of workSplits) {
    const contract = contracts.find(c => c.id === split.contract_id && c.status === 'active')
    if (!contract) continue

    // Determine income-type rate from contract
    const rateCol  = incomeTypeToRateColumn(incomeType)
    const rate     = (contract[rateCol] as number | null) ?? 0

    if (rate === 0) {
      results.push({
        repertoire_id:    repertoireId,
        contract_id:      split.contract_id,
        payee_id:         split.payee_id,
        income_type:      incomeType ?? 'other',
        rate_applied:     0,
        split_percent:    split.split_percent,
        source_amount:    sourceAmount,
        allocated_amount: 0,
        warning: `No ${rateCol} set on contract "${contract.contract_name}". Allocated 0.`,
      })
      continue
    }

    const allocated = Math.round(sourceAmount * rate * split.split_percent * 100) / 100

    results.push({
      repertoire_id:    repertoireId,
      contract_id:      split.contract_id,
      payee_id:         split.payee_id,
      income_type:      incomeType ?? 'other',
      rate_applied:     rate,
      split_percent:    split.split_percent,
      source_amount:    sourceAmount,
      allocated_amount: allocated,
    })
  }

  return results
}

// ============================================================
// FULL ROW PROCESSOR — MASTER
// ============================================================

export interface ProcessedImportRow {
  normalized_title:      string
  normalized_identifier: string
  matched_contract_id:   string | null
  matched_payee_id:      string | null
  matched_repertoire_id: string | null
  match_status:          MatchStatus
  warning_flag:          boolean
  warning_reason:        string | null
  error_flag:            boolean
  error_reason:          string | null
}

/**
 * Process a master import row through the full matching pipeline.
 *
 * Match strategy:
 *   1. Try to match contract from contract_name_raw / contract_code
 *   2. Try to match payee (including alias lookup), narrowed to payees on matched contract
 *   3. If payee matched but not contract, retry contract narrowed by payee
 *   4. Match repertoire independently (ISRC/UPC primary)
 */
export function processMasterImportRow(
  row:        Partial<ImportRow>,
  payees:     Payee[],
  contracts:  Contract[],
  payeeLinks: ContractPayeeLink[],
  aliases:    PayeeAlias[],
  repertoire: Repertoire[]
): ProcessedImportRow {
  const warnings: string[] = []
  const errors:   string[] = []

  const normalized_title      = normalizeText(row.title_raw)
  const normalized_identifier = normalizeIdentifier(row.identifier_raw)

  // Step 1: Contract
  let contractMatch = matchContract(
    row.contract_name_raw || null,
    'master',
    contracts,
    payeeLinks,
    null
  )

  // Step 2: Payee (with alias lookup)
  let payeeMatch = matchPayee(
    row.payee_name_raw || null,
    payees,
    payeeLinks,
    aliases,
    contractMatch.matched_contract_id
  )

  // Step 3: If payee matched but not contract, retry contract narrowed by payee
  if (!contractMatch.matched_contract_id && payeeMatch.matched_payee_id) {
    contractMatch = matchContract(
      row.contract_name_raw || null,
      'master',
      contracts,
      payeeLinks,
      payeeMatch.matched_payee_id
    )
  }

  // Step 4: Repertoire (ISRC/UPC primary for master)
  const reperMatch = matchRepertoire(
    row.identifier_raw || null,
    row.title_raw      || null,
    row.artist_name_raw || null,
    repertoire,
    'master'
  )

  // Warnings / errors
  if (!contractMatch.matched_contract_id) {
    if (row.contract_name_raw) {
      errors.push(`Contract not found: "${row.contract_name_raw}"`)
    } else {
      warnings.push('No contract name in source row.')
    }
  } else if (contractMatch.match_confidence === 'normalized') {
    warnings.push('Contract matched by normalized name.')
  }

  if (!payeeMatch.matched_payee_id) {
    if (row.payee_name_raw) {
      errors.push(`Payee not found: "${row.payee_name_raw}"`)
    } else {
      warnings.push('No payee name in source row.')
    }
  } else if (payeeMatch.match_confidence === 'alias') {
    warnings.push(`Payee matched via alias: "${row.payee_name_raw}"`)
  } else if (payeeMatch.match_confidence === 'normalized') {
    warnings.push(`Payee matched by normalized name: "${row.payee_name_raw}"`)
  }

  if (contractMatch.matched_contract_id && payeeMatch.matched_payee_id) {
    const validLink = payeeLinks.find(
      l =>
        l.contract_id === contractMatch.matched_contract_id &&
        l.payee_id    === payeeMatch.matched_payee_id &&
        l.is_active
    )
    if (!validLink) {
      warnings.push(
        `Payee "${row.payee_name_raw}" is not linked to matched contract. ` +
        'This row may belong to a different statement unit.'
      )
    }
  }

  if (reperMatch.match_confidence === 'none' && row.identifier_raw) {
    warnings.push(`Repertoire not matched for identifier "${row.identifier_raw}"`)
  }

  const match_status = resolveMatchStatus(contractMatch, payeeMatch)

  return {
    normalized_title,
    normalized_identifier,
    matched_contract_id:   contractMatch.matched_contract_id,
    matched_payee_id:      payeeMatch.matched_payee_id,
    matched_repertoire_id: reperMatch.matched_repertoire_id,
    match_status,
    warning_flag:   warnings.length > 0,
    warning_reason: warnings.length > 0 ? warnings.join('; ') : null,
    error_flag:     errors.length > 0,
    error_reason:   errors.length > 0 ? errors.join('; ') : null,
  }
}

// ============================================================
// FULL ROW PROCESSOR — PUBLISHING
// Publishing rows are identifier-driven, not payee-driven.
// Payee/contract resolution happens in allocation, not here.
// ============================================================

export interface ProcessedPublishingRow extends ProcessedImportRow {
  allocations: PublishingAllocationResult[]
}

/**
 * Process a publishing import row.
 *
 * Match strategy:
 *   1. Match repertoire/work using Tempo ID (primary). If Tempo ID exists and
 *      no work matches it, the row stays unmatched.
 *   2. Only if no Tempo ID exists, match by normalized title against works
 *      that also have no Tempo ID.
 *   3. Duplicate title candidates or title matches against works that already
 *      have Tempo IDs are treated as ambiguous and must be resolved manually.
 *      → If identifier matches, row is 'matched' regardless of payee/contract presence.
 *   2. Payee name and contract name from source row are NOT required.
 *      → They are IGNORED as primary match keys for publishing.
 *   3. If repertoire matched, compute per-payee allocations using
 *      contract_repertoire_payee_splits as the source of truth.
 *   4. If no splits exist for the work, raise a warning (not an error —
 *      the work may legitimately have no active contract in this cycle).
 *
 * Does not mutate the input row.
 */
export function processPublishingImportRow(
  row:        Partial<ImportRow>,
  payees:     Payee[],
  contracts:  Contract[],
  payeeLinks: ContractPayeeLink[],
  aliases:    PayeeAlias[],
  repertoire: Repertoire[],
  splits:     ContractRepertoirePayeeSplit[]  // all active splits (pre-loaded)
): ProcessedPublishingRow {
  const warnings: string[] = []
  const errors:   string[] = []

  const normalized_title      = normalizeText(row.title_raw)
  const normalized_identifier = normalizeIdentifier(row.identifier_raw)

  // Step 1: Repertoire match — Tempo ID primary, title fallback.
  // Import flow may store Tempo ID in either row.tempo_id or identifier_raw.
  const rawIdentifier = row.identifier_raw || null
  const rawTempoId = (row as any).tempo_id || (!looksLikeISWC(rawIdentifier) ? rawIdentifier : null)
  const rawIswc = (row as any).iswc || (looksLikeISWC(rawIdentifier) ? rawIdentifier : null)
  const reperMatch = matchPublishingRepertoire(
    rawTempoId,
    rawIswc,
    row.title_raw       || null,
    row.artist_name_raw || null,
    repertoire
  )

  let allocations: PublishingAllocationResult[] = []

  if (!reperMatch.matched_repertoire_id) {
    // No repertoire match — row stays unmatched
    if (reperMatch.failure_reason === 'duplicate_title' && row.title_raw) {
      errors.push(`Duplicate title - multiple possible matches for "${row.title_raw}". Resolve manually in Sales Errors.`)
    } else if (reperMatch.failure_reason === 'ambiguous_identifier_mismatch' && row.title_raw) {
      errors.push(`Ambiguous - identifier mismatch for "${row.title_raw}". Matching title candidates already have Tempo IDs.`)
    } else if (rawTempoId) {
      errors.push(`Work not found for Tempo ID "${rawTempoId}". Add to Repertoire to enable matching.`)
    } else if (row.title_raw) {
      errors.push(`Unmatched - no repertoire work found for "${row.title_raw}".`)
    } else {
      errors.push('Unmatched - no Tempo ID or title available for publishing match.')
    }
  } else {
    // Step 2: Compute allocations using stored splits
    const sourceAmount = row.net_amount ?? row.amount ?? 0
    allocations = allocatePublishingRow(
      sourceAmount,
      row.income_type || null,
      reperMatch.matched_repertoire_id,
      contracts,
      splits
    )

    if (allocations.length === 0) {
      warnings.push(
        `Work matched (id: ${reperMatch.matched_repertoire_id}) but no active payee splits found. ` +
        'No allocation generated. Add splits in Repertoire or Contracts view.'
      )
    } else {
      // Collect any per-allocation warnings
      for (const a of allocations) {
        if (a.warning) warnings.push(a.warning)
      }
    }

    // Informational: note if source row had a payee name that doesn't match any split payee
    if (row.payee_name_raw) {
      const splitPayeeIds = new Set(allocations.map(a => a.payee_id))
      const nameMatch = matchPayee(
        row.payee_name_raw,
        payees,
        payeeLinks,
        aliases,
        null
      )
      if (nameMatch.matched_payee_id && !splitPayeeIds.has(nameMatch.matched_payee_id)) {
        warnings.push(
          `Source row payee "${row.payee_name_raw}" resolved but has no active split for this work. ` +
          'No allocation assigned to them — this is expected if the writer is not on the current contract.'
        )
      }
    }
  }

  // For publishing, match_status depends only on repertoire resolution
  const match_status = resolvePublishingMatchStatus(reperMatch)

  // For single-payee allocation convenience (primary), set matched_payee_id
  // to the first allocation's payee_id (the statement run handles multi-payee).
  // matched_contract_id similarly from first allocation.
  const primaryAlloc = allocations[0] ?? null

  return {
    normalized_title,
    normalized_identifier,
    matched_contract_id:   primaryAlloc?.contract_id   ?? null,
    matched_payee_id:      primaryAlloc?.payee_id      ?? null,
    matched_repertoire_id: reperMatch.matched_repertoire_id,
    match_status,
    allocations,
    warning_flag:   warnings.length > 0,
    warning_reason: warnings.length > 0 ? warnings.join('; ') : null,
    error_flag:     errors.length > 0,
    error_reason:   errors.length > 0 ? errors.join('; ') : null,
  }
}

// ============================================================
// UNIFIED ENTRY POINT
// Delegates to master or publishing processor based on domain.
// ============================================================

/**
 * Process a single import row. Delegates to the correct domain processor.
 *
 * For publishing: passes splits for work-level allocation.
 * For master: uses the legacy contract+payee matching pipeline.
 */
export function processImportRow(
  row:        Partial<ImportRow>,
  payees:     Payee[],
  contracts:  Contract[],
  payeeLinks: ContractPayeeLink[],
  aliases:    PayeeAlias[],
  repertoire: Repertoire[],
  splits:     ContractRepertoirePayeeSplit[] = []
): ProcessedImportRow | ProcessedPublishingRow {
  if (row.domain === 'publishing') {
    return processPublishingImportRow(
      row, payees, contracts, payeeLinks, aliases, repertoire, splits
    )
  }
  return processMasterImportRow(
    row, payees, contracts, payeeLinks, aliases, repertoire
  )
}
