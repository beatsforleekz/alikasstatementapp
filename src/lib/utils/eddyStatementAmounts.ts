export type EddyNetImportRow = {
  periodRef: string
  contractId: string
  payeeName: string
  eddyPayeeId: string
  payeeSplitPercent: number | null
  netPayeeSubtotal: number | null
}

export type EddyNetCorrection = {
  autoCorrectedNetPayeeSubtotal: number | null
  netPayeeSubtotalCorrectionSource: number | null
  netPayeeSubtotalCorrectionReason: string | null
  netPayeeSubtotalReviewIssue: string | null
}

const EDDY_EFFECTIVE_ZERO = 0.00000001

function amountKey(value: number) {
  return value.toFixed(12)
}

function payeeKey(row: EddyNetImportRow) {
  return row.eddyPayeeId.trim() || row.payeeName.trim().toLowerCase()
}

export function applyDuplicatedNegativeCorrections<T extends EddyNetImportRow>(rows: T[]): Array<T & EddyNetCorrection> {
  const corrected = rows.map(row => ({
    ...row,
    autoCorrectedNetPayeeSubtotal: null,
    netPayeeSubtotalCorrectionSource: null,
    netPayeeSubtotalCorrectionReason: null,
    netPayeeSubtotalReviewIssue: null,
  }))
  const contractGroups = new Map<string, Array<T & EddyNetCorrection>>()

  corrected.forEach(row => {
    const key = `${row.periodRef}\u0000${row.contractId}`
    contractGroups.set(key, [...(contractGroups.get(key) ?? []), row])
  })

  contractGroups.forEach(contractRows => {
    const distinctPayees = new Set(contractRows.map(payeeKey).filter(Boolean))
    if (distinctPayees.size < 2) return

    const negativeRows = contractRows.filter(row => row.netPayeeSubtotal != null && row.netPayeeSubtotal < -EDDY_EFFECTIVE_ZERO)
    const effectivelyZeroRows = contractRows.filter(row => row.netPayeeSubtotal != null && Math.abs(row.netPayeeSubtotal) <= EDDY_EFFECTIVE_ZERO)
    const uniqueNegativeValues = new Set(negativeRows.map(row => amountKey(Number(row.netPayeeSubtotal))))
    const isSharedContractNegative = negativeRows.length > 0
      && uniqueNegativeValues.size === 1
      && negativeRows.length + effectivelyZeroRows.length === contractRows.length

    if (!isSharedContractNegative) return

    if (contractRows.some(row => row.payeeSplitPercent == null)) {
      contractRows.forEach(row => {
        row.netPayeeSubtotalReviewIssue = 'Shared negative Eddy contract balance has a missing Payee Split %'
      })
      return
    }

    const splitTotal = contractRows.reduce((sum, row) => sum + Number(row.payeeSplitPercent), 0)
    if (Math.abs(splitTotal - 100) > 0.000001) {
      contractRows.forEach(row => {
        row.netPayeeSubtotalReviewIssue = `Shared negative Eddy contract payee splits total ${splitTotal}% instead of 100%`
      })
      return
    }

    const contractNegative = Number(negativeRows[0].netPayeeSubtotal)
    contractRows.forEach(row => {
      const split = Number(row.payeeSplitPercent)
      row.autoCorrectedNetPayeeSubtotal = Number((contractNegative * (split / 100)).toFixed(12))
      row.netPayeeSubtotalCorrectionSource = contractNegative
      row.netPayeeSubtotalCorrectionReason = `Adjusted from Eddy contract-level negative balance using ${split}% payee split`
    })
  })

  return corrected
}

export function effectiveImportedNetPayeeSubtotal(row: EddyNetImportRow & Partial<EddyNetCorrection>) {
  return row.autoCorrectedNetPayeeSubtotal ?? row.netPayeeSubtotal
}

export function effectiveEddyNetPayeeSubtotal(
  rawValue: number | null,
  autoCorrectedValue: number | null,
  manualOverride: number | null,
) {
  return manualOverride ?? autoCorrectedValue ?? rawValue
}
