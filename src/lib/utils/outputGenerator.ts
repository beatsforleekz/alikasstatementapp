/**
 * STATEMENT OUTPUT GENERATION
 *
 * Generates Excel, CSV, and printable HTML outputs for statement records.
 * All generation happens client-side using xlsx and native browser APIs.
 * No server-side file generation required — Netlify-compatible by design.
 */

import type { StatementRecord, StatementLineSummary } from '@/lib/types'
import { formatCurrency } from '@/lib/utils/balanceEngine'
import { LOGO_BASE64 } from '@/lib/constants/statementBrand'
import {
  activeStatementBuckets,
  buildStatementPivot,
  STATEMENT_BUCKET_LABELS,
  type StatementIncomeBucket,
} from '@/lib/utils/statementPresentation'

// ============================================================
// SONY WIDE-FORMAT PIVOT HELPERS
// ============================================================

interface SonyPivotRow {
  title: string
  identifier: string | null
  buckets: Partial<Record<StatementIncomeBucket, number>>
  total: number
}

interface OutputCostRow {
  description: string
  cost_date: string | null
  notes: string | null
  amount: number
}

function buildOutputPivot(lines: StatementLineSummary[]): SonyPivotRow[] {
  return buildStatementPivot(lines)
}

function activeSonyBuckets(rows: SonyPivotRow[]): StatementIncomeBucket[] {
  return activeStatementBuckets(rows)
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
  contract_name: string      // included so payees know which deal this statement is for
  contract_code: string | null
  period_label: string
  period_start: string
  period_end: string
  currency: string
  lines: StatementLineSummary[]
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
export function generateCSV(data: StatementOutputData): string {
  const { record, payee_name, period_label, currency, lines } = data
  const { earningLines, costLines } = splitStatementLines(lines)
  const costRows = buildCostRows(costLines)
  const rows: string[] = []

  // Header block
  rows.push(csvRow(['STATEMENT OF ACCOUNT']))
  rows.push(csvRow(['Payee', payee_name]))
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
  rows.push(csvRow(['Closing Balance (Pre-Carryover)', record.closing_balance_pre_carryover]))
  rows.push(csvRow(['Prior Period Carryover Applied', record.prior_period_carryover_applied]))
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

  // Line summaries — Sony wide-format pivot
  if (earningLines.length > 0) {
    const pivotRows = buildOutputPivot(earningLines)
    const active    = activeSonyBuckets(pivotRows)

    rows.push(csvRow(['LINE DETAIL']))
    rows.push(csvRow([
      'Song Title',
      'Identifier',
      ...active.map(b => STATEMENT_BUCKET_LABELS[b]),
      'Song Total',
    ]))
    for (const row of pivotRows) {
      rows.push(csvRow([
        row.title,
        row.identifier ?? '',
        ...active.map(b => row.buckets[b] ?? 0),
        row.total,
      ]))
    }
    // Totals row
    rows.push(csvRow([
      'TOTAL',
      '',
      ...active.map(b => pivotRows.reduce((s, r) => s + (r.buckets[b] ?? 0), 0)),
      pivotRows.reduce((s, r) => s + r.total, 0),
    ]))
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
  data: StatementOutputData,
  filename: string
): Promise<void> {
  const XLSX = await import('xlsx')
  const { record, payee_name, period_label, currency, lines } = data
  const { earningLines, costLines } = splitStatementLines(lines)
  const costRows = buildCostRows(costLines)

  const wb = XLSX.utils.book_new()

  // ---- Summary Sheet ----
  const summaryRows: (string | number | null)[][] = [
    ['STATEMENT OF ACCOUNT'],
    [],
    ['Payee', payee_name],
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
    ['Closing Balance (Pre-Carryover)', record.closing_balance_pre_carryover],
    ['Prior Period Carryover Applied', record.prior_period_carryover_applied],
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

  summaryRows.push([])
  summaryRows.push(['Issued Amount', record.issued_amount])
  summaryRows.push(['Approval Status', record.approval_status])
  if (record.approved_by) summaryRows.push(['Approved By', record.approved_by])
  if (record.approved_at) summaryRows.push(['Approved At', record.approved_at])

  const summarySheet = XLSX.utils.aoa_to_sheet(summaryRows)

  // Column widths
  summarySheet['!cols'] = [{ wch: 36 }, { wch: 20 }]

  XLSX.utils.book_append_sheet(wb, summarySheet, 'Summary')

  // ---- Line Detail Sheet — Sony wide-format ----
  if (earningLines.length > 0) {
    const pivotRows = buildOutputPivot(earningLines)
    const active    = activeSonyBuckets(pivotRows)

    const lineHeaders = [
      'Song Title',
      'Identifier',
      ...active.map(b => STATEMENT_BUCKET_LABELS[b]),
      'Song Total',
    ]

    const lineData = pivotRows.map(row => [
      row.title,
      row.identifier ?? '',
      ...active.map(b => row.buckets[b] ?? 0),
      row.total,
    ])

    // Totals row
    lineData.push([
      'TOTAL',
      '',
      ...active.map(b => pivotRows.reduce((s, r) => s + (r.buckets[b] ?? 0), 0)),
      pivotRows.reduce((s, r) => s + r.total, 0),
    ])

    const lineSheet = XLSX.utils.aoa_to_sheet([lineHeaders, ...lineData])
    // Col widths: title, identifier, then one per active bucket, then total
    lineSheet['!cols'] = [
      { wch: 36 },
      { wch: 16 },
      ...active.map(() => ({ wch: 14 })),
      { wch: 14 },
    ]
    XLSX.utils.book_append_sheet(wb, lineSheet, 'Line Detail')
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

// ============================================================
// HTML STATEMENT VIEW (printable)
// ============================================================

export function buildPrintableHTMLDocument(data: StatementOutputData): string {
  const { record, payee_name, statement_name, period_label, currency, lines } = data
  const { earningLines, costLines } = splitStatementLines(lines)
  const costRows = buildCostRows(costLines)
  const headerName = payee_name || statement_name
  const showPublishingLogo = record.domain === 'publishing'

  const balanceRows = [
    ['Opening Balance', record.opening_balance],
    ['Current Period Earnings', record.current_earnings],
    ['Deductions', `(${record.deductions.toFixed(2)})`],
    ['Closing Balance', record.closing_balance_pre_carryover],
    ...(record.prior_period_carryover_applied !== 0
      ? [['Prior Period Carryover', record.prior_period_carryover_applied] as [string, number]]
      : []),
    ['Final Balance', record.final_balance_after_carryover],
  ]

  const linesHTML = (() => {
    if (earningLines.length === 0) return ''
    const pivotRows = buildOutputPivot(earningLines)
    const active    = activeSonyBuckets(pivotRows)
    const grandTotal = pivotRows.reduce((s, r) => s + r.total, 0)

    const headerCells = [
      '<th>Song Title</th>',
      '<th>Identifier</th>',
      ...active.map(b => `<th class="num">${STATEMENT_BUCKET_LABELS[b]}</th>`),
      '<th class="num">Song Total</th>',
    ].join('')

    const dataRows = pivotRows.map(row => {
      const bucketCells = active.map(b => {
        const v = row.buckets[b] ?? 0
        return `<td class="num">${v !== 0 ? v.toFixed(2) : '—'}</td>`
      }).join('')
      return `<tr>
        <td>${row.title}</td>
        <td class="mono">${row.identifier ?? ''}</td>
        ${bucketCells}
        <td class="num"><strong>${row.total.toFixed(2)}</strong></td>
      </tr>`
    }).join('')

    const totalCells = active.map(b => {
      const v = pivotRows.reduce((s, r) => s + (r.buckets[b] ?? 0), 0)
      return `<td class="num"><strong>${v !== 0 ? v.toFixed(2) : '—'}</strong></td>`
    }).join('')

    return `
    <h2>Line Detail</h2>
    <table class="lines">
      <thead>
        <tr>${headerCells}</tr>
      </thead>
      <tbody>
        ${dataRows}
      </tbody>
      <tfoot>
        <tr style="border-top:2px solid #ccc;">
          <td><strong>Total</strong></td>
          <td></td>
          ${totalCells}
          <td class="num"><strong>${grandTotal.toFixed(2)}</strong></td>
        </tr>
      </tfoot>
    </table>`
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
        <div class="statement-subtitle">MUSIC MATTERS SONGS PUBLISHING STATEMENT</div>
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
        const isFinal = i === balanceRows.length - 1
        const cls = isFinal ? 'total' : label === 'Closing Balance' ? 'subtotal' : ''
        return `<tr class="${cls}"><td>${label}</td><td>${typeof val === 'number' ? val.toFixed(2) : val}</td></tr>`
      })
      .join('')}
  </table>

  ${payableBlock}

  ${linesHTML}
  ${costsHTML}

  <div class="footer">
    <div>Approved by: ${record.approved_by ?? '—'} &nbsp;|&nbsp; ${record.approved_at ? new Date(record.approved_at).toLocaleDateString('en-GB') : ''}</div>
    <div>Generated: ${new Date().toLocaleDateString('en-GB')}</div>
  </div>
</body>
</html>`

  return html
}

/**
 * Generate a printable HTML statement.
 * Opens in a new tab and can optionally trigger the browser print dialog.
 */
export function openPrintableHTML(
  data: StatementOutputData,
  options?: { autoPrint?: boolean }
): Window | null {
  const html = buildPrintableHTMLDocument(data)
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
