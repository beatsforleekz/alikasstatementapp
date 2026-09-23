export type EddyFinalDueRow = {
  periodRef: string
  contractId: string
  contractName: string
  payeeId: string
  splitPercent: number | null
  finalDue: number
  manualOverride?: number | null
}

export type EddyFinalDueResult = {
  amount: number
  source: 'manual override' | 'feature-contract protected' | 'shared-deficit corrected' | 'raw'
  needsVerification: boolean
}

const DUST = 0.00001

type VerifiedSharedDeficit = {
  payeeCount: number
  sharedBalance: 'repeated-final-due' | number
}

const VERIFIED_SHARED_DEFICITS: Record<string, VerifiedSharedDeficit> = {
  'H1 2026:399496': { payeeCount: 2, sharedBalance: 'repeated-final-due' },
  'H1 2026:399497': { payeeCount: 2, sharedBalance: 'repeated-final-due' },
  'H1 2026:379441': { payeeCount: 2, sharedBalance: 'repeated-final-due' },
  'H1 2026:374299': { payeeCount: 2, sharedBalance: 'repeated-final-due' },
  'H1 2026:384774': { payeeCount: 2, sharedBalance: 'repeated-final-due' },
  // Eddy exported dust for Casa Bap even though both PDFs show this shared deficit.
  'H1 2026:384775': { payeeCount: 2, sharedBalance: -233.38 },
  // Eddy exported dust for CLARAA even though the sole-payee PDF shows this deficit.
  'H1 2026:384496': { payeeCount: 1, sharedBalance: -732.72 },
  // Two Dommage CSV rows contain dust, but all five PDFs show this shared deficit.
  'H1 2026:399494': { payeeCount: 5, sharedBalance: -542.509723691 },
  // Eddy placed the full Liquid Light deficit on one payee and dust on the other.
  'H1 2026:399492': { payeeCount: 2, sharedBalance: -674.597790053 },
  // Both What If You Fly PDFs identify the repeated deficit as shared contract costs.
  'H1 2026:399493': { payeeCount: 2, sharedBalance: -752.63738014 },
  // Eddy exported dust for all Night Whispers payees; all PDFs show this shared deficit.
  'H1 2026:379447': { payeeCount: 3, sharedBalance: -311.29 },
  // Eddy placed the full PIYS deficit on one payee and dust on the other.
  'H1 2026:374303': { payeeCount: 2, sharedBalance: -135.723897799 },
}

export function normalizeEddyDust(value: number) {
  return Math.abs(value) < DUST ? 0 : value
}

export function futureEddyOpeningCarryover(priorClosingBalance: number) {
  const rounded = Math.round((priorClosingBalance + Number.EPSILON) * 100) / 100
  return rounded > 0 && rounded < 100 ? rounded : 0
}

export function isEddyFeatureContract(name: string) {
  // FAC must be a token: "Face Front" is not a feature contract.
  return /feat|\bfac\b/i.test(name)
}

function samePenny(a: number, b: number) {
  return Math.round(normalizeEddyDust(a) * 100) === Math.round(normalizeEddyDust(b) * 100)
}

export function effectiveEddyFinalDue(row: EddyFinalDueRow, allRows: EddyFinalDueRow[]): EddyFinalDueResult {
  if (row.manualOverride != null) {
    return { amount: normalizeEddyDust(row.manualOverride), source: 'manual override', needsVerification: false }
  }

  const raw = normalizeEddyDust(row.finalDue)
  if (isEddyFeatureContract(row.contractName)) {
    return { amount: raw, source: 'feature-contract protected', needsVerification: false }
  }

  const contractRows = allRows.filter(other => other.periodRef === row.periodRef && other.contractId === row.contractId)
  const verifiedSharedDeficit = VERIFIED_SHARED_DEFICITS[`${row.periodRef}:${row.contractId}`]
  const validSharedContract = verifiedSharedDeficit
    && contractRows.length === verifiedSharedDeficit.payeeCount
    && new Set(contractRows.map(other => other.payeeId)).size === verifiedSharedDeficit.payeeCount
    && contractRows.every(other => !isEddyFeatureContract(other.contractName)
      && other.splitPercent != null && other.splitPercent > 0)
    && Math.abs(contractRows.reduce((sum, other) => sum + Number(other.splitPercent), 0) - 100) < 0.01
  const repeatedFinalDue = validSharedContract
    && verifiedSharedDeficit.sharedBalance === 'repeated-final-due'
    && contractRows.every(other => other.finalDue < -DUST && samePenny(other.finalDue, contractRows[0].finalDue))
  const fixedSharedBalance = validSharedContract && typeof verifiedSharedDeficit.sharedBalance === 'number'
    ? verifiedSharedDeficit.sharedBalance
    : null

  if (repeatedFinalDue || fixedSharedBalance != null) {
    const sharedBalance = fixedSharedBalance ?? contractRows[0].finalDue
    return {
      amount: normalizeEddyDust(sharedBalance * Number(row.splitPercent) / 100),
      source: 'shared-deficit corrected',
      needsVerification: false,
    }
  }

  const negativeRows = contractRows.filter(other => normalizeEddyDust(other.finalDue) < 0)
  const sameNegative = negativeRows.length > 1
    && negativeRows.some(other => other.payeeId !== row.payeeId && samePenny(other.finalDue, row.finalDue))
  const zeroAndNegative = negativeRows.length > 0
    && contractRows.some(other => normalizeEddyDust(other.finalDue) === 0)

  return {
    amount: raw,
    source: 'raw',
    needsVerification: row.contractId !== '192433' && (sameNegative || zeroAndNegative),
  }
}
