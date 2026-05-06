/**
 * STATEMENT OUTPUT GENERATION
 *
 * Generates Excel, CSV, and printable HTML outputs for statement records.
 * All generation happens client-side using xlsx and native browser APIs.
 * No server-side file generation required — Netlify-compatible by design.
 */

import type { Payee, StatementPeriod, StatementRecord, StatementLineSummary } from '@/lib/types'
import { formatCurrency } from '@/lib/utils/balanceEngine'
import { LOGO_BASE64 } from '@/lib/constants/statementBrand'
import {
  buildIncomeTypeSections,
  calculateStatementPresentationTotals,
  getLinePresentationValues,
} from '@/lib/utils/statementPresentation'

interface OutputCostRow {
  description: string
  cost_date: string | null
  notes: string | null
  amount: number
}

function splitStatementLines(lines: StatementLineSummary[]) {
  const costLines = lines.filter(line => line.line_category === 'cost')
  const earningLines = lines.filter(line => line.line_category !== 'cost')
  return { earningLines, costLines }
}

function buildCostRows(lines: StatementLineSummary[]): OutputCostRow[] {
  return lines.map(line => ({
    description: line.title ?? 'Contract cost',
    cost_date: line.transaction_date ?? null,
    notes: line.notes ?? null,
    amount: Math.abs(line.deduction_amount ?? line.net_amount ?? 0),
  }))
}

// ============================================================
// STATEMENT DATA SHAPE FOR OUTPUT
// ============================================================

export interface StatementOutputData {
  record: StatementRecord
  payee_name: string
  statement_name: string     // payee name as it appears on statements
  performer_name?: string | null
  contract_name: string      // included so payees know which deal this statement is for
  contract_code: string | null
  period_label: string
  period_start: string
  period_end: string
  currency: string
  lines: StatementLineSummary[]
}

export interface PublishingPackageOutputRecord extends StatementRecord {
  payee?: (Pick<Payee, 'id' | 'payee_name' | 'display_name' | 'performer_name' | 'statement_name'> & {
    currency: string | null
  }) | null
  contract?: {
    id: string
    contract_name: string
    contract_code: string | null
    contract_type?: string | null
  } | null
  statement_period?: Pick<StatementPeriod, 'id' | 'label' | 'year' | 'half'> & {
    period_start?: string
    period_end?: string
  } | null
}

export interface PublishingPackageSectionData {
  record: PublishingPackageOutputRecord
  contract_name: string
  contract_code: string | null
  currency: string
  lines: StatementLineSummary[]
}

export interface PublishingPackageOutputData {
  payee_name: string
  statement_name: string
  performer_name?: string | null
  period_label: string
  period_start: string
  period_end: string
  currency: string
  sections: PublishingPackageSectionData[]
}

function isPublishingPackageData(data: StatementOutputData | PublishingPackageOutputData): data is PublishingPackageOutputData {
  return 'sections' in data
}

function formatPercent(value: number | null | undefined): string {
  return value != null ? `${(value * 100).toFixed(2)}%` : '—'
}

function displayAmount(value: number | null | undefined): string {
  return value == null || value === 0 ? '—' : value.toFixed(2)
}

function packageContractLabel(section: PublishingPackageSectionData): string {
  const code = section.contract_code?.trim()
  const name = section.contract_name?.trim()
  if (code && name && code !== name) return `${name} (${code})`
  return code || name || section.record.contract_id
}

function calculatePublishingPackageTotals(data: PublishingPackageOutputData) {
  return data.sections.reduce((totals, section) => {
    totals.openingBalance += section.record.opening_balance ?? 0
    totals.currentEarnings += section.record.current_earnings ?? 0
    totals.deductions += section.record.deductions ?? 0
    totals.closingBalance += section.record.closing_balance_pre_carryover ?? 0
    totals.priorCarryover += section.record.prior_period_carryover_applied ?? 0
    totals.finalBalance += section.record.final_balance_after_carryover ?? 0
    totals.payableAmount += section.record.payable_amount ?? 0
    totals.carryForward += section.record.carry_forward_amount ?? 0
    return totals
  }, {
    openingBalance: 0,
    currentEarnings: 0,
    deductions: 0,
    closingBalance: 0,
    priorCarryover: 0,
    finalBalance: 0,
    payableAmount: 0,
    carryForward: 0,
  })
}

// ============================================================
// CSV EXPORT
// ============================================================

function escapeCSV(value: string | number | null | undefined): string {
  if (value === null || value === undefined) return ''
  const str = String(value)
  if (str.includes(',') || str.includes('"') || str.includes('\n')) {
    return `"${str.replace(/"/g, '""')}"`
  }
  return str
}

function csvRow(cells: (string | number | null | undefined)[]): string {
  return cells.map(escapeCSV).join(',')
}

/**
 * Generate CSV content for a statement record.
 * Returns a CSV string ready to download.
 */
export function generateCSV(data: StatementOutputData | PublishingPackageOutputData): string {
  if (isPublishingPackageData(data)) {
    return generatePublishingPackageCSV(data)
  }
  const { record, payee_name, period_label, currency, lines } = data
  const { costLines } = splitStatementLines(lines)
  const costRows = buildCostRows(costLines)
  const totals = calculateStatementPresentationTotals(lines)
  const sections = buildIncomeTypeSections(lines)
  const deductionLines = lines.filter(line => line.line_category !== 'income' && line.line_category !== 'cost' && (line.deduction_amount ?? 0) > 0)
  const rows: string[] = []

  // Header block
  rows.push(csvRow(['STATEMENT OF ACCOUNT']))
  rows.push(csvRow(['Payee', data.statement_name || payee_name]))
  if (data.performer_name) rows.push(csvRow(['Performer Name', data.performer_name]))
  rows.push(csvRow(['Contract', data.contract_name + (data.contract_code ? ` (${data.contract_code})` : '')]))
  rows.push(csvRow(['Statement Type', record.domain === 'master' ? 'Master Royalties' : 'Publishing']))
  rows.push(csvRow(['Royalty Share', record.royalty_share_snapshot != null ? `${(record.royalty_share_snapshot * 100).toFixed(2)}%` : '—']))
  rows.push(csvRow(['Period', period_label]))
  rows.push(csvRow(['Currency', currency]))
  rows.push(csvRow([]))

  // Balance summary
  rows.push(csvRow(['BALANCE SUMMARY']))
  rows.push(csvRow(['Opening Balance', record.opening_balance]))
  rows.push(csvRow(['Current Period Earnings', record.current_earnings]))
  rows.push(csvRow(['Deductions', record.deductions]))
  rows.push(csvRow(['Closing Balance', record.closing_balance_pre_carryover]))
  rows.push(csvRow(['Prior Period Carryover', record.prior_period_carryover_applied]))
  rows.push(csvRow(['Final Balance', record.final_balance_after_carryover]))
  rows.push(csvRow([]))

  if (record.is_payable) {
    rows.push(csvRow(['PAYABLE THIS PERIOD', record.payable_amount]))
  } else if (record.carry_forward_amount > 0) {
    rows.push(csvRow(['CARRIED FORWARD (below threshold)', record.carry_forward_amount]))
  } else if (record.is_recouping) {
    rows.push(csvRow(['STATUS', 'Recouping']))
    rows.push(csvRow(['Balance', record.final_balance_after_carryover]))
  }

  rows.push(csvRow([]))

  if (sections.length > 0) {
    rows.push(csvRow(['INCOME TYPE DETAIL']))
    for (const section of sections) {
      rows.push(csvRow([section.label.toUpperCase()]))
      rows.push(csvRow(['Title', 'Identifier', 'Income Type %', 'Gross Amount', 'Net Amount']))
      for (const row of section.rows) {
        rows.push(csvRow([
          row.title,
          row.identifier ?? '',
          row.incomeTypePercent != null ? `${(row.incomeTypePercent * 100).toFixed(2)}%` : '—',
          row.grossBasis,
          row.net,
        ]))
      }
      rows.push(csvRow([
        `${section.label} Total`,
        '',
        '',
        '',
        section.grossBasisTotal,
        section.netTotal,
      ]))
      rows.push(csvRow([]))
    }
  }

  if (deductionLines.length > 0) {
    rows.push(csvRow(['DEDUCTIONS']))
    rows.push(csvRow(['Type', 'Title', 'Identifier', 'Deduction', 'Notes']))
    for (const line of deductionLines) {
      const values = getLinePresentationValues(line)
      rows.push(csvRow([
        line.line_category ?? '',
        line.title ?? '',
        line.identifier ?? '',
        values.deduction,
        line.notes ?? '',
      ]))
    }
    rows.push(csvRow([]))
  }

  if (costRows.length > 0) {
    rows.push(csvRow([]))
    rows.push(csvRow(['CONTRACT COST DETAIL']))
    rows.push(csvRow(['Description', 'Date', 'Notes', 'Amount']))
    for (const cost of costRows) {
      rows.push(csvRow([
        cost.description,
        cost.cost_date ?? '',
        cost.notes ?? '',
        cost.amount,
      ]))
    }
    rows.push(csvRow([
      'TOTAL APPLIED COSTS',
      '',
      '',
      costRows.reduce((sum, cost) => sum + cost.amount, 0),
    ]))
  }

  return rows.join('\n')
}

/**
 * Trigger a CSV file download in the browser.
 */
export function downloadCSV(content: string, filename: string): void {
  const blob = new Blob([content], { type: 'text/csv;charset=utf-8;' })
  const url = URL.createObjectURL(blob)
  const link = document.createElement('a')
  link.href = url
  link.download = filename
  link.click()
  URL.revokeObjectURL(url)
}

// ============================================================
// EXCEL EXPORT (client-side via xlsx)
// ============================================================

/**
 * Generate and download an Excel (.xlsx) statement.
 * Dynamic import of xlsx to keep it out of the initial bundle.
 */
export async function downloadExcel(
  data: StatementOutputData | PublishingPackageOutputData,
  filename: string
): Promise<void> {
  if (isPublishingPackageData(data)) {
    await downloadPublishingPackageExcel(data, filename)
    return
  }
  const XLSX = await import('xlsx')
  const { record, payee_name, period_label, currency, lines } = data
  const { costLines } = splitStatementLines(lines)
  const costRows = buildCostRows(costLines)
  const totals = calculateStatementPresentationTotals(lines)
  const sections = buildIncomeTypeSections(lines)
  const deductionLines = lines.filter(line => line.line_category !== 'income' && line.line_category !== 'cost' && (line.deduction_amount ?? 0) > 0)

  const wb = XLSX.utils.book_new()

  // ---- Summary Sheet ----
  const summaryRows: (string | number | null)[][] = [
    ['STATEMENT OF ACCOUNT'],
    [],
    ['Payee', data.statement_name || payee_name],
    ...(data.performer_name ? [['Performer Name', data.performer_name] as (string | number | null)[]] : []),
    ['Contract', data.contract_name + (data.contract_code ? ` (${data.contract_code})` : '')],
    ['Statement Type', record.domain === 'master' ? 'Master Royalties' : 'Publishing'],
    ['Royalty Share', record.royalty_share_snapshot != null ? `${(record.royalty_share_snapshot * 100).toFixed(2)}%` : '—'],
    ['Period', period_label],
    ['Currency', currency],
    [],
    ['BALANCE SUMMARY'],
    ['Opening Balance', record.opening_balance],
    ['Current Period Earnings', record.current_earnings],
    ['Deductions', record.deductions],
    ['Closing Balance', record.closing_balance_pre_carryover],
    ['Prior Period Carryover', record.prior_period_carryover_applied],
    ['Final Balance', record.final_balance_after_carryover],
    [],
  ]

  if (record.is_payable) {
    summaryRows.push(['PAYABLE THIS PERIOD', record.payable_amount])
  } else if (record.carry_forward_amount > 0) {
    summaryRows.push(['CARRIED FORWARD (below threshold)', record.carry_forward_amount])
    summaryRows.push(['', 'Balance will be carried to the next statement period.'])
  } else if (record.is_recouping) {
    summaryRows.push(['STATUS', 'Recouping'])
    summaryRows.push(['Balance', record.final_balance_after_carryover])
  }

  const summarySheet = XLSX.utils.aoa_to_sheet(summaryRows)

  // Column widths
  summarySheet['!cols'] = [{ wch: 36 }, { wch: 20 }]

  XLSX.utils.book_append_sheet(wb, summarySheet, 'Summary')

  if (sections.length > 0 || deductionLines.length > 0) {
    const detailRows: (string | number | null)[][] = []
    for (const section of sections) {
      detailRows.push([section.label.toUpperCase()])
      detailRows.push(['Title', 'Identifier', 'Income Type %', 'Gross Basis', 'Net Amount'])
      for (const row of section.rows) {
        detailRows.push([
          row.title,
          row.identifier ?? '',
          row.incomeTypePercent != null ? `${(row.incomeTypePercent * 100).toFixed(2)}%` : '—',
          row.grossBasis,
          row.net,
        ])
      }
      detailRows.push([`${section.label} Total`, '', '', '', section.grossBasisTotal, section.netTotal])
      detailRows.push([])
    }

    if (deductionLines.length > 0) {
      detailRows.push(['DEDUCTIONS'])
      detailRows.push(['Type', 'Title', 'Identifier', 'Deduction', 'Notes'])
      for (const line of deductionLines) {
        const values = getLinePresentationValues(line)
        detailRows.push([
          line.line_category ?? '',
          line.title ?? '',
          line.identifier ?? '',
          values.deduction,
          line.notes ?? '',
        ])
      }
    }

    const detailSheet = XLSX.utils.aoa_to_sheet(detailRows)
    detailSheet['!cols'] = [
      { wch: 34 },
      { wch: 18 },
      { wch: 14 },
      { wch: 14 },
      { wch: 14 },
      { wch: 18 },
    ]
    XLSX.utils.book_append_sheet(wb, detailSheet, 'Income Detail')
  }

  if (costRows.length > 0) {
    const costHeaders = ['Description', 'Date', 'Notes', 'Amount']
    const costData = costRows.map(cost => [
      cost.description,
      cost.cost_date ?? '',
      cost.notes ?? '',
      cost.amount,
    ])
    costData.push([
      'TOTAL APPLIED COSTS',
      '',
      '',
      costRows.reduce((sum, cost) => sum + cost.amount, 0),
    ])
    const costSheet = XLSX.utils.aoa_to_sheet([costHeaders, ...costData])
    costSheet['!cols'] = [
      { wch: 34 },
      { wch: 14 },
      { wch: 32 },
      { wch: 14 },
    ]
    XLSX.utils.book_append_sheet(wb, costSheet, 'Contract Costs')
  }

  XLSX.writeFile(wb, filename)
}

function generatePublishingPackageCSV(data: PublishingPackageOutputData): string {
  const totals = calculatePublishingPackageTotals(data)
  const rows: string[] = []

  rows.push(csvRow(['STATEMENT OF ACCOUNT']))
  rows.push(csvRow(['Payee', data.statement_name || data.payee_name]))
  if (data.performer_name) rows.push(csvRow(['Performer Name', data.performer_name]))
  rows.push(csvRow(['Statement Type', 'Publishing']))
  rows.push(csvRow(['Period', data.period_label]))
  rows.push(csvRow(['Currency', data.currency]))
  rows.push(csvRow([]))

  rows.push(csvRow(['BALANCE SUMMARY']))
  rows.push(csvRow(['Opening Balance', totals.openingBalance]))
  rows.push(csvRow(['Current Period Earnings', totals.currentEarnings]))
  rows.push(csvRow(['Deductions', totals.deductions]))
  rows.push(csvRow(['Closing Balance', totals.closingBalance]))
  rows.push(csvRow(['Prior Period Carryover', totals.priorCarryover]))
  rows.push(csvRow(['Final Balance', totals.finalBalance]))
  rows.push(csvRow([]))

  if (totals.payableAmount > 0) {
    rows.push(csvRow(['PAYABLE THIS PERIOD', totals.payableAmount]))
  } else if (totals.carryForward > 0) {
    rows.push(csvRow(['CARRIED FORWARD', totals.carryForward]))
  }

  rows.push(csvRow([]))

  for (const section of data.sections) {
    const incomeSections = buildIncomeTypeSections(section.lines)
    const deductionLines = section.lines.filter(line => line.line_category !== 'income' && line.line_category !== 'cost' && (line.deduction_amount ?? 0) > 0)
    const { costLines } = splitStatementLines(section.lines)
    const costRows = buildCostRows(costLines)

    rows.push(csvRow([packageContractLabel(section).toUpperCase()]))
    rows.push(csvRow(['Contract Current Period Earnings', section.record.current_earnings]))
    rows.push(csvRow(['Contract Deductions', section.record.deductions]))
    rows.push(csvRow(['Contract Prior Period Carryover', section.record.prior_period_carryover_applied]))
    rows.push(csvRow(['Contract Final Balance', section.record.final_balance_after_carryover]))
    rows.push(csvRow(['Contract Payable', section.record.payable_amount]))
    rows.push(csvRow([]))

    for (const incomeSection of incomeSections) {
      rows.push(csvRow([incomeSection.label.toUpperCase()]))
      rows.push(csvRow(['Title', 'Identifier', 'Income Type %', 'Gross Amount', 'Net Amount']))
      for (const row of incomeSection.rows) {
        rows.push(csvRow([
          row.title,
          row.identifier ?? '',
          formatPercent(row.incomeTypePercent),
          row.grossBasis,
          row.net,
        ]))
      }
      rows.push(csvRow([
        `${incomeSection.label} Total`,
        '',
        '',
        incomeSection.grossBasisTotal,
        incomeSection.netTotal,
      ]))
      rows.push(csvRow([]))
    }

    if (deductionLines.length > 0) {
      rows.push(csvRow(['DEDUCTIONS']))
      rows.push(csvRow(['Type', 'Title', 'Identifier', 'Deduction']))
      for (const line of deductionLines) {
        const values = getLinePresentationValues(line)
        rows.push(csvRow([
          line.line_category ?? '',
          line.title ?? '',
          line.identifier ?? '',
          values.deduction,
        ]))
      }
      rows.push(csvRow([]))
    }

    if (costRows.length > 0) {
      rows.push(csvRow(['CONTRACT COST DETAIL']))
      rows.push(csvRow(['Description', 'Date', 'Notes', 'Amount']))
      for (const cost of costRows) {
        rows.push(csvRow([
          cost.description,
          cost.cost_date ?? '',
          cost.notes ?? '',
          cost.amount,
        ]))
      }
      rows.push(csvRow([
        'TOTAL APPLIED COSTS',
        '',
        '',
        costRows.reduce((sum, cost) => sum + cost.amount, 0),
      ]))
      rows.push(csvRow([]))
    }
  }

  return rows.join('\n')
}

async function downloadPublishingPackageExcel(
  data: PublishingPackageOutputData,
  filename: string
): Promise<void> {
  const XLSX = await import('xlsx')
  const wb = XLSX.utils.book_new()
  const totals = calculatePublishingPackageTotals(data)

  const summaryRows: (string | number | null)[][] = [
    ['STATEMENT OF ACCOUNT'],
    [],
    ['Payee', data.statement_name || data.payee_name],
    ...(data.performer_name ? [['Performer Name', data.performer_name] as (string | number | null)[]] : []),
    ['Statement Type', 'Publishing'],
    ['Period', data.period_label],
    ['Currency', data.currency],
    [],
    ['BALANCE SUMMARY'],
    ['Opening Balance', totals.openingBalance],
    ['Current Period Earnings', totals.currentEarnings],
    ['Deductions', totals.deductions],
    ['Closing Balance', totals.closingBalance],
    ['Prior Period Carryover', totals.priorCarryover],
    ['Final Balance', totals.finalBalance],
    [],
    ['Payable This Period', totals.payableAmount],
    ['Carry Forward', totals.carryForward],
  ]

  const summarySheet = XLSX.utils.aoa_to_sheet(summaryRows)
  summarySheet['!cols'] = [{ wch: 36 }, { wch: 20 }]
  XLSX.utils.book_append_sheet(wb, summarySheet, 'Summary')

  for (const section of data.sections) {
    const incomeSections = buildIncomeTypeSections(section.lines)
    const deductionLines = section.lines.filter(line => line.line_category !== 'income' && line.line_category !== 'cost' && (line.deduction_amount ?? 0) > 0)
    const sheetRows: (string | number | null)[][] = [
      [packageContractLabel(section)],
      [],
      ['Current Period Earnings', section.record.current_earnings],
      ['Deductions', section.record.deductions],
      ['Prior Period Carryover', section.record.prior_period_carryover_applied],
      ['Final Balance', section.record.final_balance_after_carryover],
      ['Payable', section.record.payable_amount],
      [],
    ]

    for (const incomeSection of incomeSections) {
      sheetRows.push([incomeSection.label.toUpperCase()])
      sheetRows.push(['Title', 'Identifier', 'Income Type %', 'Gross Amount', 'Net Amount'])
      for (const row of incomeSection.rows) {
        sheetRows.push([
          row.title,
          row.identifier ?? '',
          formatPercent(row.incomeTypePercent),
          row.grossBasis,
          row.net,
        ])
      }
      sheetRows.push([`${incomeSection.label} Total`, '', '', incomeSection.grossBasisTotal, incomeSection.netTotal])
      sheetRows.push([])
    }

    if (deductionLines.length > 0) {
      sheetRows.push(['DEDUCTIONS'])
      sheetRows.push(['Type', 'Title', 'Identifier', 'Deduction'])
      for (const line of deductionLines) {
        const values = getLinePresentationValues(line)
        sheetRows.push([
          line.line_category ?? '',
          line.title ?? '',
          line.identifier ?? '',
          values.deduction,
        ])
      }
    }

    const sheet = XLSX.utils.aoa_to_sheet(sheetRows)
    sheet['!cols'] = [
      { wch: 34 },
      { wch: 18 },
      { wch: 14 },
      { wch: 14 },
      { wch: 14 },
    ]
    const safeSheetName = packageContractLabel(section).slice(0, 31) || 'Contract'
    XLSX.utils.book_append_sheet(wb, sheet, safeSheetName)
  }

  XLSX.writeFile(wb, filename)
}

// ============================================================
// HTML STATEMENT VIEW (printable)
// ============================================================

export function buildPrintableHTMLDocument(
  data: StatementOutputData | PublishingPackageOutputData,
  options?: { internalReview?: boolean }
): string {
  if (isPublishingPackageData(data)) {
    return buildPublishingPackagePrintableHTMLDocument(data)
  }
  const { record, payee_name, statement_name, period_label, currency, lines } = data
  const { costLines } = splitStatementLines(lines)
  const costRows = buildCostRows(costLines)
  const totals = calculateStatementPresentationTotals(lines)
  const sections = buildIncomeTypeSections(lines)
  const deductionLines = lines.filter(line => line.line_category !== 'income' && line.line_category !== 'cost' && (line.deduction_amount ?? 0) > 0)
  const headerName = statement_name || payee_name
  const showPublishingLogo = record.domain === 'publishing'
  const internalReview = Boolean(options?.internalReview)

  const balanceRows = [
    ...(internalReview ? [['Gross Earnings', totals.grossEarnings] as [string, number]] : []),
    ['Opening Balance', record.opening_balance],
    ['Current Period Earnings', record.current_earnings],
    ['Deductions', `(${record.deductions.toFixed(2)})`],
    ['Closing Balance', record.closing_balance_pre_carryover],
    ['Prior Period Carryover', record.prior_period_carryover_applied],
    ['Final Balance', record.final_balance_after_carryover],
    ...(internalReview ? [['Net Earnings', totals.netEarnings] as [string, number]] : []),
  ]

  const linesHTML = (() => {
    if (sections.length === 0) return ''
    return sections.map(section => {
    const rowsHtml = section.rows.map(row => `
        <tr>
          <td>${row.title}</td>
          <td class="mono">${row.identifier ?? ''}</td>
          <td class="num">${row.incomeTypePercent != null ? `${(row.incomeTypePercent * 100).toFixed(2)}%` : '—'}</td>
          <td class="num">${row.grossBasis !== 0 ? row.grossBasis.toFixed(2) : '—'}</td>
          <td class="num"><strong>${row.net !== 0 ? row.net.toFixed(2) : '—'}</strong></td>
        </tr>
      `).join('')
      return `
      <h2>${section.label}</h2>
      <table class="lines">
        <thead>
          <tr>
            <th>Title</th>
            <th>Identifier</th>
            <th class="num">Income Type %</th>
          <th class="num">Gross Amount</th>
            <th class="num">Net Amount</th>
          </tr>
        </thead>
        <tbody>${rowsHtml}</tbody>
        <tfoot>
          <tr style="border-top:2px solid #ccc;">
            <td colspan="3"><strong>${section.label} Total</strong></td>
            <td class="num"><strong>${section.grossBasisTotal.toFixed(2)}</strong></td>
            <td class="num"><strong>${section.netTotal.toFixed(2)}</strong></td>
          </tr>
        </tfoot>
      </table>`
    }).join('')
  })()

  const costsHTML = (() => {
    if (costRows.length === 0) return ''
    const totalCosts = costRows.reduce((sum, cost) => sum + cost.amount, 0)
    const rowsHtml = costRows.map(cost => `
      <tr>
        <td>${cost.description}</td>
        <td>${cost.cost_date ? new Date(cost.cost_date).toLocaleDateString('en-GB') : '—'}</td>
        <td>${cost.notes ?? ''}</td>
        <td class="num"><strong>${cost.amount.toFixed(2)}</strong></td>
      </tr>
    `).join('')
    return `
    <h2>Contract Costs</h2>
    <table class="lines">
      <thead>
        <tr>
          <th>Description</th>
          <th>Date</th>
          <th>Notes</th>
          <th class="num">Amount</th>
        </tr>
      </thead>
      <tbody>
        ${rowsHtml}
      </tbody>
      <tfoot>
        <tr style="border-top:2px solid #ccc;">
          <td><strong>Total Applied Costs</strong></td>
          <td></td>
          <td></td>
          <td class="num"><strong>${totalCosts.toFixed(2)}</strong></td>
        </tr>
      </tfoot>
    </table>`
  })()

  const deductionsHtml = (() => {
    if (deductionLines.length === 0) return ''
    const rowsHtml = deductionLines.map(line => {
      const values = getLinePresentationValues(line)
      return `
      <tr>
        <td>${line.line_category ?? '—'}</td>
        <td>${line.title ?? '—'}</td>
        <td class="mono">${line.identifier ?? '—'}</td>
        <td class="num">${values.deduction !== 0 ? values.deduction.toFixed(2) : '—'}</td>
      </tr>`
    }).join('')
    return `
    <h2>Deductions</h2>
    <table class="lines">
      <thead>
        <tr>
          <th>Type</th>
          <th>Title</th>
          <th>Identifier</th>
          <th class="num">Amount</th>
        </tr>
      </thead>
      <tbody>${rowsHtml}</tbody>
    </table>`
  })()

  const detailedLinesHtml = (() => {
    if (!internalReview) return ''
    const rowsHtml = lines.map(line => {
      const values = getLinePresentationValues(line)
      return `
        <tr>
          <td>${line.line_category ?? '—'}</td>
          <td>${line.title ?? '—'}</td>
          <td class="mono">${line.identifier ?? '—'}</td>
          <td class="num">${values.sourceAmount != null && values.sourceAmount !== 0 ? values.sourceAmount.toFixed(2) : '—'}</td>
          <td class="num">${values.incomeTypePercent != null ? `${(values.incomeTypePercent * 100).toFixed(2)}%` : '—'}</td>
          <td class="num">${values.grossBasis !== 0 ? values.grossBasis.toFixed(2) : '—'}</td>
          <td class="num">${values.deduction !== 0 ? values.deduction.toFixed(2) : '—'}</td>
        <td class="num">${values.net !== 0 ? values.net.toFixed(2) : '—'}</td>
      </tr>`
    }).join('')
    return `
    <h2>Internal Review Detail</h2>
    <table class="lines">
      <thead>
        <tr>
          <th>Type</th>
          <th>Title</th>
          <th>Identifier</th>
          <th class="num">Source Amount</th>
          <th class="num">Income Type %</th>
          <th class="num">Gross Earnings</th>
          <th class="num">Deduction</th>
          <th class="num">Net</th>
        </tr>
      </thead>
      <tbody>
        ${rowsHtml}
      </tbody>
    </table>`
  })()

  const payableBlock = record.is_payable
    ? `<div class="payable-box">
        <span class="label">PAYABLE THIS PERIOD</span>
        <span class="amount">${formatCurrency(record.payable_amount, currency)}</span>
      </div>`
    : record.carry_forward_amount > 0
    ? `<div class="carryover-box">
        <span class="label">CARRIED FORWARD (below threshold)</span>
        <span class="amount">${formatCurrency(record.carry_forward_amount, currency)}</span>
      </div>`
    : `<div class="recouping-box">
        <span class="label">RECOUPING</span>
        <span class="amount">${formatCurrency(record.final_balance_after_carryover, currency)}</span>
      </div>`

  const performerLine = data.performer_name
    ? `<div class="performer-line">Performer Name: ${data.performer_name}</div>`
    : ''
  const subtitle = internalReview
    ? 'MUSIC MATTERS SONGS INTERNAL REVIEW'
    : 'MUSIC MATTERS SONGS PUBLISHING STATEMENT'

  const html = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<base href="${typeof window !== 'undefined' ? window.location.origin : ''}/">
<title>Statement — ${statement_name} — ${data.contract_name} — ${period_label}</title>
<style>
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body { font-family: 'Helvetica Neue', Arial, sans-serif; font-size: 13px; color: #1a1a1a; background: #fff; padding: 40px; max-width: 900px; margin: 0 auto; }
  h1 { font-size: 20px; font-weight: 700; margin-bottom: 4px; }
  h2 { font-size: 14px; font-weight: 700; margin: 28px 0 10px; text-transform: uppercase; letter-spacing: 0.05em; color: #555; border-bottom: 1px solid #ddd; padding-bottom: 4px; }
  .header { display: flex; justify-content: space-between; align-items: flex-start; gap: 20px; margin-bottom: 32px; padding-bottom: 20px; border-bottom: 2px solid #1a1a1a; }
  .header-left { display: flex; align-items: flex-start; gap: 14px; flex: 1; }
  .header-logo { height: 60px; width: auto; object-fit: contain; flex-shrink: 0; }
  .header-copy { min-width: 0; flex: 1; text-align: center; }
  .header-right { text-align: right; font-size: 12px; color: #555; }
  .type-badge { display: inline-block; background: #1a1a1a; color: #fff; padding: 2px 10px; border-radius: 3px; font-size: 11px; font-weight: 700; text-transform: uppercase; letter-spacing: 0.08em; margin-top: 6px; }
  .statement-subtitle { font-size: 12px; font-weight: 700; letter-spacing: 0.08em; color: #555; margin-top: 8px; text-transform: uppercase; }
  .performer-line { font-size: 12px; color: #555; margin-top: 6px; }
  table.balance { width: 380px; border-collapse: collapse; margin-bottom: 8px; }
  table.balance td { padding: 5px 8px; }
  table.balance td:last-child { text-align: right; font-variant-numeric: tabular-nums; }
  table.balance tr.subtotal td { border-top: 1px solid #aaa; font-weight: 600; }
  table.balance tr.total td { border-top: 2px solid #1a1a1a; font-weight: 700; font-size: 14px; }
  .payable-box, .carryover-box, .recouping-box { margin-top: 20px; padding: 14px 20px; border-radius: 6px; display: flex; justify-content: space-between; align-items: center; }
  .payable-box { background: #f0fdf4; border: 2px solid #22c55e; }
  .carryover-box { background: #fffbeb; border: 2px solid #f59e0b; }
  .recouping-box { background: #fef2f2; border: 2px solid #ef4444; }
  .payable-box .label, .carryover-box .label, .recouping-box .label { font-weight: 700; font-size: 12px; text-transform: uppercase; letter-spacing: 0.06em; }
  .payable-box .amount, .carryover-box .amount, .recouping-box .amount { font-weight: 800; font-size: 22px; }
  table.lines { width: 100%; border-collapse: collapse; font-size: 12px; margin-top: 8px; }
  table.lines th { background: #f5f5f5; padding: 6px 8px; text-align: left; font-weight: 700; border-bottom: 2px solid #ddd; }
  table.lines td { padding: 5px 8px; border-bottom: 1px solid #eee; }
  table.lines .num { text-align: right; font-variant-numeric: tabular-nums; }
  .mono { font-family: 'Courier New', monospace; font-size: 11px; }
  .footer { margin-top: 48px; padding-top: 16px; border-top: 1px solid #ddd; font-size: 11px; color: #888; display: flex; justify-content: space-between; }
  @media print {
    body { padding: 20px; }
    @page { margin: 1.5cm; }
  }
</style>
</head>
<body>
  <div class="header">
    <div class="header-left">
      ${showPublishingLogo ? `<img src="${LOGO_BASE64}" alt="MMS logo" class="header-logo">` : ''}
      <div class="header-copy">
        <h1>${headerName}</h1>
        ${performerLine}
        <div class="statement-subtitle">${subtitle}</div>
      </div>
    </div>
    <div class="header-right">
      <div><strong>Statement Period</strong><br>${period_label}</div>
      <div style="margin-top:8px;"><strong>Currency</strong><br>${currency}</div>
    </div>
  </div>

  <h2>Balance Summary</h2>
  <table class="balance">
    ${balanceRows
      .map(([label, val], i) => {
        const isFinal = label === 'Final Balance'
        const cls = isFinal ? 'total' : label === 'Closing Balance' ? 'subtotal' : ''
        return `<tr class="${cls}"><td>${label}</td><td>${typeof val === 'number' ? val.toFixed(2) : val}</td></tr>`
      })
      .join('')}
  </table>

  ${payableBlock}

  ${linesHTML}
  ${deductionsHtml}
  ${detailedLinesHtml}
  ${costsHTML}

  <div class="footer">
    <div>Music Matters Songs</div>
    <div>${period_label}</div>
  </div>
</body>
</html>`

  return html
}

function buildPublishingPackagePrintableHTMLDocument(data: PublishingPackageOutputData): string {
  const totals = calculatePublishingPackageTotals(data)
  const balanceRows: [string, number | string][] = [
    ['Opening Balance', totals.openingBalance],
    ['Current Period Earnings', totals.currentEarnings],
    ['Deductions', `(${totals.deductions.toFixed(2)})`],
    ['Closing Balance', totals.closingBalance],
    ['Prior Period Carryover', totals.priorCarryover],
    ['Final Balance', totals.finalBalance],
  ]

  const sectionsHTML = data.sections.map(section => {
    const incomeSections = buildIncomeTypeSections(section.lines)
    const deductionLines = section.lines.filter(line => line.line_category !== 'income' && line.line_category !== 'cost' && (line.deduction_amount ?? 0) > 0)
    const { costLines } = splitStatementLines(section.lines)
    const costRows = buildCostRows(costLines)

    const incomeHtml = incomeSections.map(incomeSection => {
      const rowsHtml = incomeSection.rows.map(row => `
        <tr>
          <td>${row.title}</td>
          <td class="mono">${row.identifier ?? ''}</td>
          <td class="num">${formatPercent(row.incomeTypePercent)}</td>
          <td class="num">${displayAmount(row.grossBasis)}</td>
          <td class="num"><strong>${displayAmount(row.net)}</strong></td>
        </tr>
      `).join('')

      return `
      <h3>${incomeSection.label}</h3>
      <table class="lines">
        <thead>
          <tr>
            <th>Title</th>
            <th>Identifier</th>
            <th class="num">Income Type %</th>
            <th class="num">Gross Amount</th>
            <th class="num">Net Amount</th>
          </tr>
        </thead>
        <tbody>${rowsHtml}</tbody>
        <tfoot>
          <tr style="border-top:2px solid #ccc;">
            <td colspan="3"><strong>${incomeSection.label} Total</strong></td>
            <td class="num"><strong>${incomeSection.grossBasisTotal.toFixed(2)}</strong></td>
            <td class="num"><strong>${incomeSection.netTotal.toFixed(2)}</strong></td>
          </tr>
        </tfoot>
      </table>`
    }).join('')

    const deductionsHtml = deductionLines.length === 0
      ? ''
      : `
      <h3>Deductions</h3>
      <table class="lines">
        <thead>
          <tr>
            <th>Type</th>
            <th>Title</th>
            <th>Identifier</th>
            <th class="num">Amount</th>
          </tr>
        </thead>
        <tbody>
          ${deductionLines.map(line => {
            const values = getLinePresentationValues(line)
            return `
            <tr>
              <td>${line.line_category ?? '—'}</td>
              <td>${line.title ?? '—'}</td>
              <td class="mono">${line.identifier ?? '—'}</td>
              <td class="num">${displayAmount(values.deduction)}</td>
            </tr>`
          }).join('')}
        </tbody>
      </table>`

    const costsHtml = costRows.length === 0
      ? ''
      : `
      <h3>Contract Costs</h3>
      <table class="lines">
        <thead>
          <tr>
            <th>Description</th>
            <th>Date</th>
            <th>Notes</th>
            <th class="num">Amount</th>
          </tr>
        </thead>
        <tbody>
          ${costRows.map(cost => `
            <tr>
              <td>${cost.description}</td>
              <td>${cost.cost_date ? new Date(cost.cost_date).toLocaleDateString('en-GB') : '—'}</td>
              <td>${cost.notes ?? ''}</td>
              <td class="num">${cost.amount.toFixed(2)}</td>
            </tr>
          `).join('')}
        </tbody>
      </table>`

    return `
    <section class="contract-section">
      <div class="contract-header">
        <div>
          <div class="contract-label">Contract Name:</div>
          <h2>${packageContractLabel(section)}</h2>
        </div>
        <div class="contract-summary">
          <div><span>Current Period Earnings</span><strong>${section.record.current_earnings.toFixed(2)}</strong></div>
          <div><span>Deductions</span><strong>${section.record.deductions.toFixed(2)}</strong></div>
          <div><span>Prior Period Carryover</span><strong>${section.record.prior_period_carryover_applied.toFixed(2)}</strong></div>
          <div><span>Final Balance</span><strong>${section.record.final_balance_after_carryover.toFixed(2)}</strong></div>
          <div><span>Payable</span><strong>${section.record.payable_amount.toFixed(2)}</strong></div>
        </div>
      </div>
      ${incomeHtml}
      ${deductionsHtml}
      ${costsHtml}
    </section>`
  }).join('')

  const payableBlock = totals.payableAmount > 0
    ? `<div class="payable-box">
        <span class="label">PAYABLE THIS PERIOD</span>
        <span class="amount">${formatCurrency(totals.payableAmount, data.currency)}</span>
      </div>`
    : totals.carryForward > 0
    ? `<div class="carryover-box">
        <span class="label">CARRIED FORWARD</span>
        <span class="amount">${formatCurrency(totals.carryForward, data.currency)}</span>
      </div>`
    : `<div class="recouping-box">
        <span class="label">FINAL BALANCE</span>
        <span class="amount">${formatCurrency(totals.finalBalance, data.currency)}</span>
      </div>`

  const performerLine = data.performer_name
    ? `<div class="performer-line">Performer Name: ${data.performer_name}</div>`
    : ''

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<base href="${typeof window !== 'undefined' ? window.location.origin : ''}/">
<title>Statement — ${data.statement_name} — ${data.period_label}</title>
<style>
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body { font-family: 'Helvetica Neue', Arial, sans-serif; font-size: 13px; color: #1a1a1a; background: #fff; padding: 40px; max-width: 900px; margin: 0 auto; }
  h1 { font-size: 20px; font-weight: 700; margin-bottom: 4px; }
  h2 { font-size: 16px; font-weight: 700; }
  h3 { font-size: 14px; font-weight: 700; margin: 22px 0 10px; text-transform: uppercase; letter-spacing: 0.05em; color: #555; border-bottom: 1px solid #ddd; padding-bottom: 4px; }
  .header { display: flex; justify-content: space-between; align-items: flex-start; gap: 20px; margin-bottom: 32px; padding-bottom: 20px; border-bottom: 2px solid #1a1a1a; }
  .header-left { display: flex; align-items: flex-start; gap: 14px; flex: 1; }
  .header-logo { height: 60px; width: auto; object-fit: contain; flex-shrink: 0; }
  .header-copy { min-width: 0; flex: 1; text-align: center; }
  .header-right { text-align: right; font-size: 12px; color: #555; }
  .statement-subtitle { font-size: 12px; font-weight: 700; letter-spacing: 0.08em; color: #555; margin-top: 8px; text-transform: uppercase; }
  .performer-line { font-size: 12px; color: #555; margin-top: 6px; }
  table.balance { width: 380px; border-collapse: collapse; margin-bottom: 8px; }
  table.balance td { padding: 5px 8px; }
  table.balance td:last-child { text-align: right; font-variant-numeric: tabular-nums; }
  table.balance tr.subtotal td { border-top: 1px solid #aaa; font-weight: 600; }
  table.balance tr.total td { border-top: 2px solid #1a1a1a; font-weight: 700; font-size: 14px; }
  .payable-box, .carryover-box, .recouping-box { margin-top: 20px; padding: 14px 20px; border-radius: 6px; display: flex; justify-content: space-between; align-items: center; }
  .payable-box { background: #f0fdf4; border: 2px solid #22c55e; }
  .carryover-box { background: #fffbeb; border: 2px solid #f59e0b; }
  .recouping-box { background: #fef2f2; border: 2px solid #ef4444; }
  .payable-box .label, .carryover-box .label, .recouping-box .label { font-weight: 700; font-size: 12px; text-transform: uppercase; letter-spacing: 0.06em; }
  .payable-box .amount, .carryover-box .amount, .recouping-box .amount { font-weight: 800; font-size: 22px; }
  .contract-section { margin-top: 28px; page-break-inside: avoid; }
  .contract-header { display: flex; justify-content: space-between; gap: 20px; align-items: flex-start; margin-bottom: 12px; padding-bottom: 10px; border-bottom: 1px solid #ddd; }
  .contract-label { font-size: 11px; font-weight: 700; letter-spacing: 0.06em; text-transform: uppercase; color: #777; margin-bottom: 4px; }
  .contract-summary { min-width: 240px; display: flex; flex-direction: column; gap: 4px; font-size: 12px; }
  .contract-summary div { display: flex; justify-content: space-between; gap: 12px; }
  .contract-summary span { color: #666; }
  table.lines { width: 100%; border-collapse: collapse; font-size: 12px; margin-top: 8px; }
  table.lines th { background: #f5f5f5; padding: 6px 8px; text-align: left; font-weight: 700; border-bottom: 2px solid #ddd; }
  table.lines td { padding: 5px 8px; border-bottom: 1px solid #eee; }
  table.lines .num { text-align: right; font-variant-numeric: tabular-nums; }
  .mono { font-family: 'Courier New', monospace; font-size: 11px; }
  .footer { margin-top: 48px; padding-top: 16px; border-top: 1px solid #ddd; font-size: 11px; color: #888; display: flex; justify-content: space-between; }
  @media print {
    body { padding: 20px; }
    @page { margin: 1.5cm; }
  }
</style>
</head>
<body>
  <div class="header">
    <div class="header-left">
      <img src="${LOGO_BASE64}" alt="MMS logo" class="header-logo">
      <div class="header-copy">
        <h1>${data.statement_name || data.payee_name}</h1>
        ${performerLine}
        <div class="statement-subtitle">MUSIC MATTERS SONGS PUBLISHING STATEMENT</div>
      </div>
    </div>
    <div class="header-right">
      <div><strong>Statement Period</strong><br>${data.period_label}</div>
      <div style="margin-top:8px;"><strong>Currency</strong><br>${data.currency}</div>
    </div>
  </div>

  <h3>Balance Summary</h3>
  <table class="balance">
    ${balanceRows.map(([label, val]) => {
      const isFinal = label === 'Final Balance'
      const cls = isFinal ? 'total' : label === 'Closing Balance' ? 'subtotal' : ''
      return `<tr class="${cls}"><td>${label}</td><td>${typeof val === 'number' ? val.toFixed(2) : val}</td></tr>`
    }).join('')}
  </table>

  ${payableBlock}

  ${sectionsHTML}

  <div class="footer">
    <div>Music Matters Songs</div>
    <div>${data.period_label}</div>
  </div>
</body>
</html>`
}

/**
 * Generate a printable HTML statement.
 * Opens in a new tab and can optionally trigger the browser print dialog.
 */
export function openPrintableHTML(
  data: StatementOutputData | PublishingPackageOutputData,
  options?: { autoPrint?: boolean; internalReview?: boolean }
): Window | null {
  const html = buildPrintableHTMLDocument(data, { internalReview: options?.internalReview })
  const win = window.open('', '_blank')
  if (!win) return null

  win.document.write(html)
  win.document.close()

  if (options?.autoPrint) {
    const triggerPrint = () => {
      window.setTimeout(() => {
        try {
          win.focus()
          win.print()
        } catch {
          // Leave the print-view tab open even if auto-print is blocked.
        }
      }, 120)
    }

    if (win.document.readyState === 'complete') triggerPrint()
    else win.onload = triggerPrint
  }
  return win
}

// ============================================================
// RUN REGISTER EXPORT
// ============================================================

export interface RunRegisterRow {
  payee_name: string
  domain: string
  period: string
  opening_balance: number
  current_earnings: number
  deductions: number
  final_balance: number
  payable_amount: number
  carry_forward: number
  issued_amount: number
  is_payable: boolean
  is_recouping: boolean
  approval_status: string
  output_generated: boolean
  email_status: string
  sent_date: string | null
  currency: string
}

export async function downloadRunRegister(
  rows: RunRegisterRow[],
  periodLabel: string,
  domain: string
): Promise<void> {
  const XLSX = await import('xlsx')
  const wb = XLSX.utils.book_new()

  const headers = [
    'Payee', 'Domain', 'Period', 'Opening', 'Earnings', 'Deductions',
    'Final Balance', 'Payable', 'Carry Forward', 'Issued',
    'Is Payable', 'Is Recouping', 'Approval', 'Output', 'Email Status', 'Sent Date', 'Currency'
  ]

  const data = rows.map((r) => [
    r.payee_name, r.domain, r.period,
    r.opening_balance, r.current_earnings, r.deductions,
    r.final_balance, r.payable_amount, r.carry_forward,
    r.issued_amount, r.is_payable ? 'Yes' : 'No',
    r.is_recouping ? 'Yes' : 'No', r.approval_status,
    r.output_generated ? 'Yes' : 'No', r.email_status,
    r.sent_date ?? '', r.currency
  ])

  const sheet = XLSX.utils.aoa_to_sheet([headers, ...data])
  sheet['!cols'] = [
    { wch: 28 }, { wch: 12 }, { wch: 10 }, { wch: 12 }, { wch: 12 }, { wch: 12 },
    { wch: 14 }, { wch: 12 }, { wch: 14 }, { wch: 12 },
    { wch: 10 }, { wch: 12 }, { wch: 12 }, { wch: 8 }, { wch: 14 }, { wch: 12 }, { wch: 10 }
  ]

  XLSX.utils.book_append_sheet(wb, sheet, 'Run Register')
  XLSX.writeFile(wb, `run-register-${domain}-${periodLabel}.xlsx`)
}
