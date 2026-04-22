'use client'
import { useEffect, useState } from 'react'
import { usePathname, useRouter, useSearchParams } from 'next/navigation'
import { supabase } from '@/lib/supabase/client'
import {
  Alert, LoadingSpinner, DomainBadge, StatCard, SectionHeader,
  ApprovalBadge, PayableBadge, Amount, EmptyState,
} from '@/components/ui'
import {
  PlayCircle, RefreshCw, CheckCircle, AlertTriangle,
  ChevronDown, ChevronRight, Lock, Unlock, Plus, X, Link2, Download,
} from 'lucide-react'
import Link from 'next/link'
import { calculateStatementRecord } from '@/lib/utils/balanceEngine'
import {
  CONTRACT_TYPE_OPTIONS,
  contractTypeToDomain,
  isMasterContractType,
  isPublishingContractType,
  normalizeContractType,
  PUBLISHING_CONTRACT_DEFAULTS,
  type StatementPeriod,
  type Domain,
} from '@/lib/types'
import {
  generateStatementRunData,
  type StatementGenerationDiagnostic as RunDiagnostic,
  type StatementGenerationContractCost,
  type StatementGenerationPreviousStatementCarryover,
} from '@/lib/utils/statementGeneration'
import type { StatementOutputData } from '@/lib/utils/outputGenerator'
import { generateStatementPdf } from '@/lib/utils/statementPdf'
import { buildZipArchive } from '@/lib/utils/simpleZip'
import {
  buildPublishingAllocationRoutes,
  type ContractRepertoireAllocationLink,
} from '@/lib/utils/publishingAllocation'
import { sortByLabel, sortOptionEntries } from '@/lib/utils/sortOptions'

// ── Types ─────────────────────────────────────────────────────────────────────

interface RunRecord {
  id: string
  contract_id: string
  payee_id: string
  domain: Domain
  royalty_share_snapshot: number
  // Currency locked at generation time — never changes after generation
  statement_currency: string
  exchange_rate_snapshot: number | null
  current_earnings: number
  deductions: number
  opening_balance: number
  closing_balance_pre_carryover: number
  prior_period_carryover_applied: number
  final_balance_after_carryover: number
  payable_amount: number
  carry_forward_amount: number
  is_payable: boolean
  is_recouping: boolean
  carryover_rule_applied: boolean
  hold_payment_flag: boolean
  balance_confirmed_flag: boolean
  carryover_confirmed_flag: boolean
  calculation_status: string
  approval_status: string
  output_generated_flag: boolean
  email_status: string
  payee?: { payee_name: string; primary_email: string | null; currency: string } | null
  contract?: { contract_name: string; contract_code: string | null } | null
  statement_period?: { label: string } | null
}

interface ImportSummary {
  import_id: string
  import_type: string
  domain: Domain
  source_name: string | null
  row_count: number
  success_count: number
  unresolved: number
  unresolved_amount: number
  // Currency info for display in the import summary table
  source_currency: string | null
  reporting_currency: string | null
  exchange_rate: number | null
}

interface ScopeRow {
  id: string
  domain?: Domain
  import_id: string
  raw_row_number: number | null
  title_raw: string | null
  artist_name_raw: string | null
  identifier_raw: string | null
  tempo_id?: string | null
  income_type: string | null
  amount: number | null
  amount_converted: number | null
  net_amount: number | null
  currency: string | null
  row_type: string | null
  match_status: string | null
  matched_contract_id: string | null
  matched_repertoire_id: string | null
  excluded_flag?: boolean
}

type UnresolvedImportRow = {
  domain: Domain
  import_id: string
  matched_repertoire_id: string | null
  income_type: string | null
  amount: number | null
  amount_converted: number | null
  net_amount: number | null
  row_type: string | null
  excluded_flag: boolean
}

function getStatementListAmount(record: Pick<RunRecord, 'final_balance_after_carryover'>) {
  return Number(record.final_balance_after_carryover ?? 0)
}

function isPublishingStatementEligibleRow(
  row: Pick<ScopeRow, 'match_status' | 'matched_repertoire_id'>,
  domain: Domain,
  linkedRepertoireIds: Set<string>
): boolean {
  if (domain !== 'publishing') return row.match_status === 'matched'
  if (row.match_status === 'matched') return true
  return row.match_status === 'partial' &&
    !!row.matched_repertoire_id &&
    linkedRepertoireIds.has(row.matched_repertoire_id)
}

const buildPublishingContractPathSet = (
  links: Array<{ repertoire_id: string | null | undefined }>,
  splits: Array<{ repertoire_id: string | null | undefined }>
) => new Set([
  ...links.map(link => link.repertoire_id).filter(Boolean) as string[],
  ...splits.map(split => split.repertoire_id).filter(Boolean) as string[],
])

function hasLivePublishingContractPath(
  repertoireId: string | null | undefined,
  contracts: any[],
  links: ContractRepertoireAllocationLink[],
  splits: any[],
): boolean {
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
  row: UnresolvedImportRow,
  contracts: any[],
  payeeLinks: any[],
  splits: any[],
  links: ContractRepertoireAllocationLink[],
): boolean {
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
  row: UnresolvedImportRow,
  contracts: any[],
  payeeLinks: any[],
  splits: any[],
  links: ContractRepertoireAllocationLink[],
): boolean {
  if (row.excluded_flag) return true
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
  row: Pick<UnresolvedImportRow, 'amount' | 'amount_converted' | 'net_amount' | 'row_type'>,
  importSummary?: Pick<ImportSummary, 'exchange_rate'>
) {
  if (row.row_type === 'deduction') return 0
  const hasFx = !!(importSummary?.exchange_rate && importSummary.exchange_rate !== 1)
  if (hasFx && row.amount_converted != null) return row.amount_converted
  return row.net_amount ?? row.amount ?? 0
}

const IMPORT_ROW_FETCH_PAGE_SIZE = 1000
const REFERENCE_FETCH_PAGE_SIZE = 1000
const SCOPE_PREVIEW_PAGE_SIZE = 250

const calcStatusBadge = (status: string) => {
  const map: Record<string, string> = {
    calculated:   'badge-approved',
    needs_review: 'badge-warning',
    error:        'badge-critical',
    pending:      'badge-pending',
  }
  return <span className={map[status] ?? 'badge-pending'}>{status.replace('_', ' ')}</span>
}

const fmtShare = (n: number) => `${(n * 100).toFixed(2)}%`

// ── Run Diagnostic Panel ──────────────────────────────────────────────────────

function RunDiagnosticPanel({ diag }: { diag: RunDiagnostic }) {
  const total = diag.statements_created + diag.statements_updated
  const realMissingPayoutPathCount = Math.max(0, diag.rows_missing_splits - diag.excluded_zero_value)
  const hasHardWarnings = diag.rows_missing_contract > 0 || diag.rows_missing_payee > 0 || diag.rows_missing_splits > 0 || diag.excluded_missing_setup > 0 || diag.excluded_manual > 0 || diag.system_issues.length > 0
  const hasSoftNotes = diag.excluded_zero_value > 0 || diag.statements_skipped > 0
  const type = diag.rows_fetched === 0 ? 'error' : hasHardWarnings ? 'warning' : 'success'
  const cls = type === 'success'
    ? 'bg-green-50 border-green-200 text-green-800'
    : type === 'error'
      ? 'bg-red-50 border-red-200 text-red-800'
      : 'bg-amber-50 border-amber-200 text-amber-900'

  const attentionItems: string[] = []

  if (diag.rows_missing_contract > 0) {
    attentionItems.push(`${diag.rows_missing_contract} row${diag.rows_missing_contract !== 1 ? 's are' : ' is'} matched to a work but still not linked to a publishing contract.`)
  }
  if (diag.rows_missing_payee > 0) {
    attentionItems.push(`${diag.rows_missing_payee} row${diag.rows_missing_payee !== 1 ? 's' : ''} still need an active payee on the contract.`)
  }
  if (realMissingPayoutPathCount > 0) {
    attentionItems.push(`${realMissingPayoutPathCount} row${realMissingPayoutPathCount !== 1 ? 's still have' : ' still has'} a payout setup problem. Check contract shares, payee shares, and income-type rates.`)
  }
  if (diag.excluded_missing_setup > 0) {
    attentionItems.push(`${diag.excluded_missing_setup} row${diag.excluded_missing_setup !== 1 ? 's were' : ' was'} left out because setup or payout path is still missing.`)
  }
  if (diag.excluded_manual > 0) {
    attentionItems.push(`${diag.excluded_manual} row${diag.excluded_manual !== 1 ? 's were' : ' was'} intentionally skipped by manual admin choice.`)
  }
  if (diag.excluded_zero_value > 0) {
    attentionItems.push(`${diag.excluded_zero_value} row${diag.excluded_zero_value !== 1 ? 's' : ''} were allocated successfully but ended at 0.00, so no line item was written.`)
  }
  if (diag.statements_skipped > 0) {
    attentionItems.push(`${diag.statements_skipped} statement${diag.statements_skipped !== 1 ? 's produced' : ' produced'} no payable movement, so no refreshed record was written.`)
  }

  return (
    <div className={`rounded border px-4 py-3 text-sm space-y-3 ${cls}`}>
      <div className="font-semibold">
        {total > 0
          ? `Run complete — ${total} statement${total !== 1 ? 's' : ''} refreshed`
          : 'Run complete — no statements were refreshed'}
      </div>
      <div className="grid grid-cols-2 gap-x-8 gap-y-1 text-xs">
        <span className="opacity-75">Imports included</span>      <span>{diag.imports_found}</span>
        <span className="opacity-75">Rows checked</span>          <span>{diag.rows_fetched}</span>
        <span className="opacity-75">Ready to pay</span>         <span>{diag.rows_statement_ready}</span>
        <span className="opacity-75">Statements refreshed</span> <span>{total}</span>
        {diag.statements_created > 0 && <>
          <span className="opacity-75">New statements</span>     <span>{diag.statements_created}</span>
        </>}
        {diag.statements_updated > 0 && <>
          <span className="opacity-75">Updated statements</span> <span>{diag.statements_updated}</span>
        </>}
      </div>
      {attentionItems.length > 0 && (
        <div className="text-xs space-y-1 pt-2 border-t border-current/20">
          <div className="font-semibold">Needs attention</div>
          {attentionItems.map((item, i) => <div key={i} className="opacity-95">· {item}</div>)}
        </div>
      )}
      {diag.user_fixable.length > 0 && (
        <div className="text-xs space-y-1 pt-2 border-t border-current/20">
          <div className="font-semibold">Setup notes</div>
          {diag.user_fixable.map((r, i) => <div key={i} className="opacity-90">· {r}</div>)}
        </div>
      )}
      {diag.system_issues.length > 0 && (
        <div className="text-xs space-y-1 pt-2 border-t border-current/20">
          <div className="font-semibold">System notes</div>
          {diag.system_issues.map((r, i) => <div key={i} className="opacity-90">· {r}</div>)}
        </div>
      )}
      {diag.exclusion_reasons.length > 0 && (
        <div className="text-xs space-y-1 pt-2 border-t border-current/20">
          <div className="font-semibold">Excluded rows</div>
          <div className="opacity-90">
            {diag.excluded_zero_value > 0 && <div>· Zero final payable amount: {diag.excluded_zero_value}</div>}
            {diag.excluded_missing_setup > 0 && <div>· Missing setup / payout path: {diag.excluded_missing_setup}</div>}
            {diag.excluded_manual > 0 && <div>· Manual / intentionally skipped: {diag.excluded_manual}</div>}
          </div>
          {diag.exclusion_reasons.map((r, i) => <div key={i} className="opacity-90 font-mono">· {r}</div>)}
        </div>
      )}
      {diag.currency_notes.length > 0 && (
        <div className="text-xs space-y-1 pt-2 border-t border-current/20">
          <div className="font-semibold">Currency resolution (per import):</div>
          {diag.currency_notes.map((r, i) => <div key={i} className="opacity-80 font-mono">· {r}</div>)}
        </div>
      )}
    </div>
  )
}

// ── Link Work → Contract Modal ────────────────────────────────────────────────

function LinkWorkModal({ onClose, onSaved }: { onClose: () => void; onSaved: () => void }) {
  const [repertoire, setRepertoire]             = useState<any[]>([])
  const [pubContracts, setPubContracts]         = useState<any[]>([])
  const [linked, setLinked]                     = useState<any[]>([])
  const [selectedWork, setSelectedWork]         = useState('')
  const [selectedContract, setSelectedContract] = useState('')
  const [workSearch, setWorkSearch]             = useState('')
  const [saving, setSaving]                     = useState(false)
  const [deleting, setDeleting]                 = useState<string | null>(null)
  const [loadingLinks, setLoadingLinks]         = useState(false)
  const [err, setErr]                           = useState<string | null>(null)

  const fetchAllPaged = async <T,>(
    buildQuery: (from: number, to: number) => PromiseLike<{ data: T[] | null; error: any }>
  ): Promise<T[]> => {
    const rows: T[] = []
    for (let from = 0; ; from += REFERENCE_FETCH_PAGE_SIZE) {
      const to = from + REFERENCE_FETCH_PAGE_SIZE - 1
      const { data, error } = await buildQuery(from, to)
      if (error) throw error
      const batch = (data ?? []) as T[]
      rows.push(...batch)
      if (batch.length < REFERENCE_FETCH_PAGE_SIZE) break
    }
    return rows
  }

  useEffect(() => {
    Promise.all([
      fetchAllPaged<any>((from, to) =>
        supabase
          .from('repertoire')
          .select('id, title, iswc, writer_name')
          .eq('active_status', true)
          .order('title')
          .range(from, to)
      ),
      fetchAllPaged<any>((from, to) =>
        supabase
          .from('contracts')
          .select('id, contract_name, contract_code, contract_type')
          .eq('status', 'active')
          .order('contract_name')
          .range(from, to)
      ),
    ]).then(([rep, con]) => {
      setRepertoire(sortByLabel(rep, item => `${item.title}${item.iswc ? ` · ${item.iswc}` : ''}${item.writer_name ? ` · ${item.writer_name}` : ''}`))
      setPubContracts(sortByLabel(con.filter(contract => isPublishingContractType(contract.contract_type)), contract => `${contract.contract_name}${contract.contract_code ? ` (${contract.contract_code})` : ''}`))
    })
  }, [])

  useEffect(() => {
    if (!selectedWork) { setLinked([]); return }
    setLoadingLinks(true)
    supabase
      .from('contract_repertoire_links')
      .select('id, contract_id, contract:contracts(contract_name, contract_code)')
      .eq('repertoire_id', selectedWork)
      .then(({ data }) => { setLinked(data ?? []); setLoadingLinks(false) })
  }, [selectedWork])

  const filteredWorks = repertoire.filter(r =>
    !workSearch ||
    r.title.toLowerCase().includes(workSearch.toLowerCase()) ||
    (r.iswc ?? '').toLowerCase().includes(workSearch.toLowerCase()) ||
    (r.writer_name ?? '').toLowerCase().includes(workSearch.toLowerCase())
  )

  const selectedWorkObj = repertoire.find(r => r.id === selectedWork)

  const addLink = async () => {
    if (!selectedWork || !selectedContract) { setErr('Select both a work and a contract.'); return }
    if (linked.some((l: any) => l.contract_id === selectedContract)) { setErr('Already linked to that contract.'); return }
    setSaving(true); setErr(null)
    const { error: e } = await supabase.from('contract_repertoire_links')
      .insert({ repertoire_id: selectedWork, contract_id: selectedContract })
    if (e) { setErr(e.message); setSaving(false); return }
    const { data } = await supabase
      .from('contract_repertoire_links')
      .select('id, contract_id, contract:contracts(contract_name, contract_code)')
      .eq('repertoire_id', selectedWork)
    setLinked(data ?? [])
    setSelectedContract('')
    setSaving(false)
    onSaved()
  }

  const removeLink = async (linkId: string) => {
    setDeleting(linkId)
    await supabase.from('contract_repertoire_links').delete().eq('id', linkId)
    setLinked(l => l.filter((x: any) => x.id !== linkId))
    setDeleting(null)
    onSaved()
  }

  const inputStyle: React.CSSProperties = { width: '100%', padding: '6px 10px', borderRadius: 6, border: '1px solid var(--ops-border)', background: 'var(--ops-surface)', color: 'var(--ops-text)', fontSize: 13 }

  return (
    <div className="fixed inset-0 bg-black/70 z-50 flex items-center justify-center p-4">
      <div style={{ background: 'var(--ops-surface)', border: '1px solid var(--ops-border)', borderRadius: 12, width: '100%', maxWidth: 620, maxHeight: '90vh', display: 'flex', flexDirection: 'column' }}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '14px 20px', borderBottom: '1px solid var(--ops-border)', flexShrink: 0 }}>
          <span style={{ fontWeight: 600, color: 'var(--ops-text)', fontSize: 15 }}>Link Work &#8594; Publishing Contract</span>
          <button onClick={onClose} className="btn-ghost btn-sm"><X size={14} /></button>
        </div>

        <div style={{ flex: 1, overflowY: 'auto', padding: 20, display: 'flex', flexDirection: 'column', gap: 16 }}>
          {err && <Alert type="error">{err}</Alert>}

          <div>
            <label style={{ display: 'block', fontSize: 12, fontWeight: 500, color: 'var(--ops-text)', marginBottom: 4 }}>Search works</label>
            <input style={{ ...inputStyle, marginBottom: 6 }} placeholder="Title, ISWC, or writer…"
              value={workSearch} onChange={e => setWorkSearch(e.target.value)} />
            <select style={inputStyle} size={7} value={selectedWork}
              onChange={e => { setSelectedWork(e.target.value); setErr(null) }}>
              {filteredWorks.length === 0 && <option disabled value="">No works found</option>}
              {filteredWorks.map(r => (
                <option key={r.id} value={r.id}>
                  {r.title}{r.iswc ? ` · ${r.iswc}` : ''}{r.writer_name ? ` · ${r.writer_name}` : ''}
                </option>
              ))}
            </select>
          </div>

          {selectedWork && (
            <>
              <div>
                <div style={{ fontSize: 12, fontWeight: 500, color: 'var(--ops-muted)', marginBottom: 6 }}>
                  Contract links — <span style={{ color: 'var(--ops-text)' }}>{selectedWorkObj?.title}</span>
                </div>
                {loadingLinks ? (
                  <div style={{ display: 'flex', gap: 6, alignItems: 'center', fontSize: 12, color: 'var(--ops-muted)' }}>
                    <LoadingSpinner size={13} /> Loading…
                  </div>
                ) : linked.length === 0 ? (
                  <p style={{ fontSize: 12, color: 'var(--ops-subtle)' }}>No contracts linked yet.</p>
                ) : (
                  <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
                    {linked.map((l: any) => (
                      <div key={l.id} style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '6px 10px', borderRadius: 6, border: '1px solid var(--ops-border)', background: 'var(--ops-surface-2)', fontSize: 13 }}>
                        <span>
                          <span style={{ fontWeight: 500, color: 'var(--ops-text)' }}>{l.contract?.contract_name}</span>
                          {l.contract?.contract_code && <span style={{ color: 'var(--ops-muted)', marginLeft: 6 }}>({l.contract.contract_code})</span>}
                        </span>
                        <button className="btn-ghost btn-sm" style={{ color: 'var(--accent-red)' }}
                          disabled={deleting === l.id} onClick={() => removeLink(l.id)}>
                          {deleting === l.id ? <LoadingSpinner size={11} /> : <X size={12} />}
                        </button>
                      </div>
                    ))}
                  </div>
                )}
              </div>

              <div>
                <label style={{ display: 'block', fontSize: 12, fontWeight: 500, color: 'var(--ops-text)', marginBottom: 4 }}>Add publishing contract link</label>
                <div style={{ display: 'flex', gap: 8 }}>
                  <select style={{ ...inputStyle, flex: 1 }} value={selectedContract}
                    onChange={e => { setSelectedContract(e.target.value); setErr(null) }}>
                    <option value="">— Select publishing contract —</option>
                    {pubContracts.map((c: any) => (
                      <option key={c.id} value={c.id}>{c.contract_name}{c.contract_code ? ` (${c.contract_code})` : ''}</option>
                    ))}
                  </select>
                  <button className="btn-primary btn-sm" onClick={addLink} disabled={saving || !selectedContract} style={{ whiteSpace: 'nowrap' }}>
                    {saving ? <LoadingSpinner size={13} /> : 'Add Link'}
                  </button>
                </div>
                <p style={{ fontSize: 11, color: 'var(--ops-subtle)', marginTop: 4 }}>
                  Enables the work &#8594; contract &#8594; payee allocation path during statement generation.
                </p>
              </div>
            </>
          )}
        </div>

        <div style={{ display: 'flex', justifyContent: 'flex-end', padding: '12px 20px', borderTop: '1px solid var(--ops-border)', flexShrink: 0 }}>
          <button className="btn-secondary btn-sm" onClick={onClose}>Close</button>
        </div>
      </div>
    </div>
  )
}

// ── Contract form modal ───────────────────────────────────────────────────────

interface ContractFormState {
  contract_name: string; contract_code: string; contract_type: string
  currency: string; territory: string; start_date: string; end_date: string; status: string
  sending_party_id: string; minimum_payment_threshold_override: string
  hold_payment_flag: boolean; approval_required: boolean; is_recoupable: boolean
  cross_recoup_group: string; statement_frequency: string; pre_term_included: boolean
  exclusion_notes: string; notes: string; artist_share_percent: string
  mechanical_rate: string; digital_mechanical_rate: string; performance_rate: string
  digital_performance_rate: string; synch_rate: string; other_rate: string
}

const EMPTY_FORM: ContractFormState = {
  contract_name: '', contract_code: '', contract_type: 'master',
  currency: 'GBP', territory: '', start_date: '', end_date: '', status: 'active',
  sending_party_id: '', minimum_payment_threshold_override: '', hold_payment_flag: false,
  approval_required: true, is_recoupable: false, cross_recoup_group: '',
  statement_frequency: '', pre_term_included: false, exclusion_notes: '', notes: '',
  artist_share_percent: '', mechanical_rate: '', digital_mechanical_rate: '',
  performance_rate: '', digital_performance_rate: '', synch_rate: '', other_rate: '',
}

const parseNullableNumber = (v: string) => {
  const n = parseFloat(v)
  return v.trim() && !isNaN(n) ? n : null
}

const normalizeStoredRate = (v: number | string | null | undefined) => {
  if (v == null || v === '') return null
  const numeric = typeof v === 'number' ? v : parseFloat(v)
  if (Number.isNaN(numeric)) return null
  return numeric > 1 ? numeric / 100 : numeric
}

const parseStoredRate = (v: string) => normalizeStoredRate(parseNullableNumber(v))

const formatRateInput = (v: number | string | null | undefined) => {
  const normalized = normalizeStoredRate(v)
  if (normalized == null) return ''
  const pct = normalized * 100
  return Number.isInteger(pct) ? String(pct) : String(parseFloat(pct.toFixed(4)))
}

function ContractFormModal({ initial, sendingParties, onClose, onSaved }: {
  initial?: Partial<ContractFormState>
  sendingParties: { id: string; name: string }[]
  onClose: () => void
  onSaved: (c: any) => void
}) {
  const isEdit = !!(initial as any)?.id
  const [form, setForm] = useState<ContractFormState>({
    ...EMPTY_FORM,
    ...initial,
    mechanical_rate: initial?.mechanical_rate != null ? formatRateInput(initial.mechanical_rate) : EMPTY_FORM.mechanical_rate,
    digital_mechanical_rate: initial?.digital_mechanical_rate != null ? formatRateInput(initial.digital_mechanical_rate) : EMPTY_FORM.digital_mechanical_rate,
    performance_rate: initial?.performance_rate != null ? formatRateInput(initial.performance_rate) : EMPTY_FORM.performance_rate,
    digital_performance_rate: initial?.digital_performance_rate != null ? formatRateInput(initial.digital_performance_rate) : EMPTY_FORM.digital_performance_rate,
    synch_rate: initial?.synch_rate != null ? formatRateInput(initial.synch_rate) : EMPTY_FORM.synch_rate,
    other_rate: initial?.other_rate != null ? formatRateInput(initial.other_rate) : EMPTY_FORM.other_rate,
  })
  const [saving, setSaving] = useState(false)
  const [error, setError]   = useState<string | null>(null)

  const setF = (k: keyof ContractFormState, v: string | boolean) => setForm(f => ({ ...f, [k]: v }))

  const s: React.CSSProperties = { padding: '6px 10px', borderRadius: 6, border: '1px solid var(--ops-border)', background: 'var(--ops-surface)', color: 'var(--ops-text)', fontSize: 13 }

  const applyPublishingDefaults = (typeValue: string) => {
    if (isEdit || !isPublishingContractType(typeValue)) return
    setForm(prev => ({
      ...prev,
      contract_type: normalizeContractType(typeValue) ?? 'publishing',
      status: PUBLISHING_CONTRACT_DEFAULTS.status,
      currency: PUBLISHING_CONTRACT_DEFAULTS.currency,
      territory: PUBLISHING_CONTRACT_DEFAULTS.territory,
      statement_frequency: PUBLISHING_CONTRACT_DEFAULTS.statement_frequency,
      hold_payment_flag: PUBLISHING_CONTRACT_DEFAULTS.hold_payment_flag,
      approval_required: PUBLISHING_CONTRACT_DEFAULTS.approval_required,
      is_recoupable: PUBLISHING_CONTRACT_DEFAULTS.is_recoupable,
      pre_term_included: PUBLISHING_CONTRACT_DEFAULTS.pre_term_included,
      mechanical_rate: PUBLISHING_CONTRACT_DEFAULTS.mechanical_rate,
      digital_mechanical_rate: PUBLISHING_CONTRACT_DEFAULTS.digital_mechanical_rate,
      performance_rate: PUBLISHING_CONTRACT_DEFAULTS.performance_rate,
      digital_performance_rate: PUBLISHING_CONTRACT_DEFAULTS.digital_performance_rate,
      synch_rate: PUBLISHING_CONTRACT_DEFAULTS.synch_rate,
      other_rate: PUBLISHING_CONTRACT_DEFAULTS.other_rate,
    }))
  }

  const handleContractTypeChange = (typeValue: string) => {
    if (!isEdit && isPublishingContractType(typeValue)) {
      applyPublishingDefaults(typeValue)
      return
    }
    setF('contract_type', typeValue)
  }

  const save = async () => {
    if (!form.contract_name.trim()) { setError('Contract name required.'); return }
    setSaving(true); setError(null)
    const payload: Record<string, any> = {
      contract_name: form.contract_name.trim(), contract_code: form.contract_code.trim() || null,
      contract_type: normalizeContractType(form.contract_type) ?? 'master', currency: form.currency || 'GBP',
      territory: form.territory || null, start_date: form.start_date || null,
      end_date: form.end_date || null, status: form.status || 'active',
      sending_party_id: form.sending_party_id || null,
      minimum_payment_threshold_override: parseNullableNumber(form.minimum_payment_threshold_override),
      hold_payment_flag: form.hold_payment_flag, approval_required: form.approval_required,
      is_recoupable: form.is_recoupable, cross_recoup_group: form.cross_recoup_group || null,
      statement_frequency: form.statement_frequency || null, pre_term_included: form.pre_term_included,
      exclusion_notes: form.exclusion_notes || null, notes: form.notes || null,
    }
    if (isMasterContractType(form.contract_type)) {
      payload.artist_share_percent = parseStoredRate(form.artist_share_percent)
    } else {
      payload.mechanical_rate = parseStoredRate(form.mechanical_rate)
      payload.digital_mechanical_rate = parseStoredRate(form.digital_mechanical_rate)
      payload.performance_rate = parseStoredRate(form.performance_rate)
      payload.digital_performance_rate = parseStoredRate(form.digital_performance_rate)
      payload.synch_rate = parseStoredRate(form.synch_rate)
      payload.other_rate = parseStoredRate(form.other_rate)
    }
    const { data, error: err } = isEdit
      ? await supabase.from('contracts').update(payload).eq('id', (initial as any).id).select().single()
      : await supabase.from('contracts').insert(payload).select().single()
    if (err) { setError(err.message); setSaving(false); return }
    onSaved(data)
  }

  const isPub = isPublishingContractType(form.contract_type)

  return (
    <div className="fixed inset-0 bg-black/70 z-50 flex items-center justify-center p-4">
      <div style={{ background: 'var(--ops-surface)', border: '1px solid var(--ops-border)', borderRadius: 12, width: '100%', maxWidth: 680, maxHeight: '92vh', display: 'flex', flexDirection: 'column' }}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '14px 20px', borderBottom: '1px solid var(--ops-border)', flexShrink: 0 }}>
          <span style={{ fontWeight: 600, color: 'var(--ops-text)', fontSize: 15 }}>{(initial as any)?.id ? 'Edit Contract' : 'New Contract'}</span>
          <button onClick={onClose} className="btn-ghost btn-sm"><X size={14} /></button>
        </div>
        <div style={{ flex: 1, overflowY: 'auto', padding: 20, display: 'flex', flexDirection: 'column', gap: 18 }}>
          {error && <Alert type="error">{error}</Alert>}
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
            <div style={{ gridColumn: '1/-1', display: 'flex', flexDirection: 'column', gap: 4 }}>
              <label style={{ fontSize: 12, fontWeight: 500, color: 'var(--ops-text)' }}>Contract Name *</label>
              <input style={s} value={form.contract_name} onChange={e => setF('contract_name', e.target.value)} />
            </div>
            {([
              ['contract_code','Contract Code','text','e.g. ARL-M-001'],
              ['territory','Territory','text','e.g. WW, UK/EU'],
              ['start_date','Start Date','date',''],
              ['end_date','End Date','date',''],
            ] as [keyof ContractFormState, string, string, string][]).map(([k, label, type, ph]) => (
              <div key={k} style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
                <label style={{ fontSize: 12, fontWeight: 500, color: 'var(--ops-text)' }}>{label}</label>
                <input type={type} placeholder={ph} style={s}
                  value={form[k] as string} onChange={e => setF(k, e.target.value)} />
              </div>
            ))}
            {([
              ['contract_type','Type',CONTRACT_TYPE_OPTIONS.map(option => [option.value, option.label] as [string, string])],
              ['currency','Currency',['GBP','USD','EUR','AUD','CAD','JPY','CHF','SEK','NOK','DKK'].map(c=>[c,c])],
              ['status','Status',[['active','Active'],['expired','Expired'],['suspended','Suspended'],['terminated','Terminated']]],
              ['statement_frequency','Frequency',[['','— not set —'],['monthly','Monthly'],['quarterly','Quarterly'],['bi-annual','Bi-annual'],['annual','Annual']]],
            ] as [keyof ContractFormState, string, [string,string][]][]).map(([k, label, opts]) => (
              <div key={k} style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
                <label style={{ fontSize: 12, fontWeight: 500, color: 'var(--ops-text)' }}>{label}</label>
                <select style={s} value={form[k] as string} onChange={e => k === 'contract_type' ? handleContractTypeChange(e.target.value) : setF(k, e.target.value)}>
                  {sortOptionEntries(opts).map(([v, t]) => <option key={v} value={v}>{t}</option>)}
                </select>
              </div>
            ))}
            <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
              <label style={{ fontSize: 12, fontWeight: 500, color: 'var(--ops-text)' }}>Sending Party</label>
              <select style={s} value={form.sending_party_id} onChange={e => setF('sending_party_id', e.target.value)}>
                <option value="">— None —</option>
                {sortByLabel(sendingParties, sp => sp.name).map(sp => <option key={sp.id} value={sp.id}>{sp.name}</option>)}
              </select>
            </div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
              <label style={{ fontSize: 12, fontWeight: 500, color: 'var(--ops-text)' }}>Min Payment Threshold</label>
              <input type="number" step="0.01" placeholder="100" style={{ ...s, fontFamily: 'monospace' }}
                value={form.minimum_payment_threshold_override}
                onChange={e => setF('minimum_payment_threshold_override', e.target.value)} />
            </div>
          </div>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 18 }}>
            {[['hold_payment_flag','Hold Payment'],['approval_required','Approval Required'],['is_recoupable','Recoupable'],['pre_term_included','Pre-term Included']].map(([k, label]) => (
              <label key={k} style={{ display: 'flex', alignItems: 'center', gap: 7, cursor: 'pointer', fontSize: 13, color: 'var(--ops-text)' }}>
                <input type="checkbox" checked={form[k as keyof ContractFormState] as boolean}
                  onChange={e => setF(k as keyof ContractFormState, e.target.checked)}
                  style={{ width: 14, height: 14, accentColor: '#3b82f6', cursor: 'pointer' }} />
                {label}
              </label>
            ))}
          </div>
          {!isPub && (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 4, maxWidth: 200 }}>
              <label style={{ fontSize: 12, fontWeight: 500, color: 'var(--ops-text)' }}>Artist Share % (e.g. 0.18)</label>
              <input type="number" step="0.0001" min="0" max="1" placeholder="0.18"
                style={{ ...s, fontFamily: 'monospace' }}
                value={form.artist_share_percent} onChange={e => setF('artist_share_percent', e.target.value)} />
            </div>
          )}
          {isPub && (
            <div>
              <div style={{ fontSize: 11, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.06em', color: 'var(--ops-muted)', borderBottom: '1px solid var(--ops-border)', paddingBottom: 6, marginBottom: 10 }}>
                Publishing — Income-Type Royalty Rates
              </div>
              <p style={{ fontSize: 12, color: 'var(--ops-muted)', marginBottom: 10 }}>Decimals (0.75 = 75%). Applied before payee split. Leave blank if not applicable.</p>
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: 10 }}>
                {[['mechanical_rate','Mechanical'],['digital_mechanical_rate','Digital Mechanical'],['performance_rate','Performance'],['digital_performance_rate','Digital Perf.'],['synch_rate','Synch'],['other_rate','Other']].map(([k, label]) => (
                  <div key={k} style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
                    <label style={{ fontSize: 11, color: 'var(--ops-muted)', fontWeight: 500 }}>{label}</label>
                    <input type="number" step="0.0001" min="0" max="1" placeholder="e.g. 0.75"
                      style={{ ...s, fontFamily: 'monospace' }}
                      value={form[k as keyof ContractFormState] as string}
                      onChange={e => setF(k as keyof ContractFormState, e.target.value)} />
                  </div>
                ))}
              </div>
            </div>
          )}
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
            {[['exclusion_notes','Exclusion Notes'],['notes','Notes']].map(([k, label]) => (
              <div key={k} style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
                <label style={{ fontSize: 12, fontWeight: 500, color: 'var(--ops-text)' }}>{label}</label>
                <textarea rows={2} style={{ ...s, resize: 'vertical' }}
                  value={form[k as keyof ContractFormState] as string}
                  onChange={e => setF(k as keyof ContractFormState, e.target.value)} />
              </div>
            ))}
          </div>
        </div>
        <div style={{ display: 'flex', gap: 8, padding: '12px 20px', borderTop: '1px solid var(--ops-border)', flexShrink: 0, background: 'var(--ops-surface)' }}>
          <button className="btn-primary btn-sm" onClick={save} disabled={saving}>
            {saving ? <LoadingSpinner size={13} /> : 'Save Contract'}
          </button>
          <button className="btn-ghost btn-sm" onClick={onClose}>Cancel</button>
        </div>
      </div>
    </div>
  )
}

// ── Currency Preview Panel ────────────────────────────────────────────────────
// Shown before the first run when imports are loaded.
// Makes the statement currency explicit and allows a one-click override.

const COMMON_CURRENCIES = ['GBP', 'EUR', 'USD', 'AUD', 'CAD', 'SEK', 'NOK', 'DKK', 'CHF', 'JPY']

function CurrencyPreviewPanel({
  imports,
  domain,
  outputCurrencyOverride,
  onOverrideChange,
}: {
  imports: ImportSummary[]
  domain: Domain
  outputCurrencyOverride: string
  onOverrideChange: (v: string) => void
}) {
  // Domain-aware system fallback: publishing → EUR, master → GBP
  const domainDefault = domain === 'publishing' ? 'EUR' : 'GBP'
  const domainDefaultLabel = domain === 'publishing' ? 'EUR (publishing default)' : 'GBP (master default)'

  // Derive what each import will produce as statement currency
  const previews = imports.map(imp => {
    const override = outputCurrencyOverride.trim().toUpperCase()
    const hasFx    = !!(imp.exchange_rate && imp.exchange_rate !== 1)

    let stmtCcy: string
    let reason: string

    if (override) {
      stmtCcy = override
      reason  = 'manual override'
    } else if (hasFx && imp.reporting_currency) {
      stmtCcy = imp.reporting_currency
      reason  = `import reporting currency (FX applied: ${imp.source_currency} \u2192 ${imp.reporting_currency})`
    } else if (imp.source_currency) {
      stmtCcy = imp.source_currency
      reason  = 'import source currency (no FX set)'
    } else if (imp.reporting_currency) {
      stmtCcy = imp.reporting_currency
      reason  = 'import reporting currency (source not set)'
    } else {
      stmtCcy = domainDefault
      reason  = domainDefaultLabel
    }

    return { imp, stmtCcy, reason, hasFx }
  })

  // Check if all imports will produce the same statement currency
  const currencies  = Array.from(new Set(previews.map(p => p.stmtCcy)))
  const allSame     = currencies.length === 1
  const hasMixing   = currencies.length > 1
  const hasFallback = previews.some(p => p.reason.includes('fallback'))
  const anyFx       = previews.some(p => p.hasFx)

  const borderColor = outputCurrencyOverride
    ? 'rgba(234,179,8,0.4)'
    : hasMixing
    ? 'rgba(239,68,68,0.3)'
    : hasFallback
    ? 'rgba(234,179,8,0.3)'
    : 'rgba(34,197,94,0.25)'

  const bgColor = outputCurrencyOverride
    ? 'rgba(234,179,8,0.05)'
    : hasMixing
    ? 'rgba(239,68,68,0.04)'
    : hasFallback
    ? 'rgba(234,179,8,0.04)'
    : 'rgba(34,197,94,0.04)'

  return (
    <div style={{ borderRadius: 8, border: `1px solid ${borderColor}`, background: bgColor, overflow: 'hidden' }}>
      {/* Header */}
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '10px 14px', borderBottom: `1px solid ${borderColor}` }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <span style={{ fontSize: 12, fontWeight: 700, color: 'var(--ops-text)' }}>
            Statement Output Currency
          </span>
          {allSame && !hasMixing && (
            <span style={{ fontFamily: 'monospace', fontSize: 13, fontWeight: 700, padding: '2px 8px', borderRadius: 4, background: outputCurrencyOverride ? 'rgba(234,179,8,0.15)' : 'rgba(34,197,94,0.12)', color: outputCurrencyOverride ? 'var(--accent-amber)' : 'var(--accent-green)', border: `1px solid ${outputCurrencyOverride ? 'rgba(234,179,8,0.3)' : 'rgba(34,197,94,0.25)'}` }}>
              {currencies[0]}
              {outputCurrencyOverride && <span style={{ fontWeight: 400, fontSize: 10, marginLeft: 5 }}>overridden</span>}
            </span>
          )}
          {hasMixing && (
            <span style={{ fontSize: 11, padding: '2px 8px', borderRadius: 4, background: 'rgba(239,68,68,0.12)', color: 'var(--accent-red)', border: '1px solid rgba(239,68,68,0.3)' }}>
              Mixed currencies — set override below
            </span>
          )}
        </div>
        <span style={{ fontSize: 11, color: 'var(--ops-muted)' }}>
          Set before running statements
        </span>
      </div>

      {/* Per-import breakdown */}
      <div style={{ padding: '10px 14px', display: 'flex', flexDirection: 'column', gap: 6 }}>
        {previews.map(({ imp, stmtCcy, reason, hasFx }) => (
          <div key={imp.import_id} style={{ display: 'grid', gridTemplateColumns: '1fr auto auto 1fr', gap: 10, alignItems: 'center', fontSize: 12 }}>
            {/* Import name */}
            <span style={{ color: 'var(--ops-text)', fontWeight: 500, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
              {(imp as any).source_name ?? imp.import_type}
            </span>
            {/* Source currency */}
            <span style={{ fontFamily: 'monospace', color: 'var(--ops-muted)', textAlign: 'right' }}>
              <span style={{ fontSize: 10, color: 'var(--ops-subtle)', marginRight: 4 }}>SRC</span>
              {imp.source_currency ?? <span style={{ fontStyle: 'italic', color: 'var(--ops-subtle)' }}>not set</span>}
            </span>
            {/* Arrow + rate */}
            <span style={{ color: 'var(--ops-subtle)', fontSize: 11, fontFamily: 'monospace', whiteSpace: 'nowrap' }}>
              {hasFx ? `→ @ ${imp.exchange_rate}` : '→'}
            </span>
            {/* Output currency + reason */}
            <span style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
              <span style={{
                fontFamily: 'monospace', fontWeight: 700, fontSize: 12,
                color: outputCurrencyOverride ? 'var(--accent-amber)' : hasFx ? 'var(--accent-cyan)' : 'var(--ops-text)',
              }}>
                <span style={{ fontSize: 10, color: 'var(--ops-subtle)', marginRight: 4 }}>STMT</span>
                {stmtCcy}
              </span>
              <span style={{ fontSize: 10, color: 'var(--ops-subtle)', fontStyle: 'italic', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                {reason}
              </span>
            </span>
          </div>
        ))}
      </div>

      {/* Override control */}
      <div style={{ padding: '10px 14px', borderTop: `1px solid ${borderColor}`, display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
        <span style={{ fontSize: 12, color: 'var(--ops-muted)', flexShrink: 0 }}>
          Override output currency:
        </span>
        <div style={{ display: 'flex', gap: 4, flexWrap: 'wrap' }}>
          {COMMON_CURRENCIES.map(ccy => (
            <button key={ccy} onClick={() => onOverrideChange(outputCurrencyOverride === ccy ? '' : ccy)}
              style={{
                padding: '3px 9px', borderRadius: 4, fontSize: 12, fontFamily: 'monospace', fontWeight: 600,
                cursor: 'pointer', border: '1px solid var(--ops-border)',
                background: outputCurrencyOverride.toUpperCase() === ccy ? '#2563eb' : 'var(--ops-surface)',
                color: outputCurrencyOverride.toUpperCase() === ccy ? '#fff' : 'var(--ops-muted)',
              }}>
              {ccy}
            </button>
          ))}
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginLeft: 'auto' }}>
          <input
            style={{ padding: '4px 8px', borderRadius: 5, border: '1px solid var(--ops-border)', background: 'var(--ops-surface)', color: 'var(--ops-text)', fontSize: 13, fontFamily: 'monospace', width: 70, textTransform: 'uppercase' }}
            placeholder="e.g. EUR"
            maxLength={3}
            value={outputCurrencyOverride}
            onChange={e => onOverrideChange(e.target.value.toUpperCase())}
          />
          {outputCurrencyOverride && (
            <button onClick={() => onOverrideChange('')}
              style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'var(--ops-muted)', fontSize: 13 }}>
              ×
            </button>
          )}
        </div>
      </div>

      <div style={{ padding: '6px 14px 10px', fontSize: 11, color: 'var(--ops-subtle)', lineHeight: 1.5 }}>
        <strong style={{ color: 'var(--ops-muted)' }}>SRC</strong> = raw import file currency ·{' '}
        <strong style={{ color: 'var(--ops-muted)' }}>STMT</strong> = currency locked into the generated statement ·{' '}
        The override replaces the import reporting currency for this run only.
        Once generated, a statement currency is locked and does not change.
      </div>
    </div>
  )
}

// ── Main page ─────────────────────────────────────────────────────────────────

export default function StatementRunPage() {
  const router = useRouter()
  const pathname = usePathname()
  const searchParams = useSearchParams()
  const urlDomain    = (searchParams.get('domain') ?? '') as '' | Domain
  const urlPeriodId = searchParams.get('period') ?? ''
  const urlApproval = searchParams.get('approval') ?? ''
  const urlPayable = searchParams.get('payable') ?? ''
  const urlRecoup = (searchParams.get('recoup') ?? '') as '' | 'recouped' | 'unrecouped'
  const urlSort = (searchParams.get('sort') ?? '') as '' | 'az' | 'za' | 'highest_payable' | 'lowest_payable'

  const [loading, setLoading]                   = useState(true)
  const [periods, setPeriods]                   = useState<StatementPeriod[]>([])
  const [selectedPeriodId, setSelectedPeriodId] = useState(urlPeriodId)
  const [domain, setDomain]                     = useState<Domain>(urlDomain || 'master')
  const [records, setRecords]                   = useState<RunRecord[]>([])
  const [imports, setImports]                   = useState<ImportSummary[]>([])
  const [selectedImportIds, setSelectedImportIds] = useState<string[]>([])
  const [scopeRows, setScopeRows]               = useState<ScopeRow[]>([])
  const [showScopePreview, setShowScopePreview] = useState(false)
  const [scopeRowsLoading, setScopeRowsLoading] = useState(false)
  const [scopePreviewPage, setScopePreviewPage] = useState(1)
  const [rowSearch, setRowSearch]               = useState('')
  const [debouncedRowSearch, setDebouncedRowSearch] = useState('')
  const [contracts, setContracts]               = useState<any[]>([])
  const [contractRepertoireLinks, setContractRepertoireLinks] = useState<{ contract_id: string; repertoire_id: string }[]>([])
  const [contractRepertoireSplits, setContractRepertoireSplits] = useState<{ contract_id: string; repertoire_id: string }[]>([])
  const [useAllContracts, setUseAllContracts]   = useState(true)
  const [selectedContractIds, setSelectedContractIds] = useState<string[]>([])
  const [contractSearch, setContractSearch]     = useState('')
  const [sendingParties, setSendingParties]     = useState<{ id: string; name: string }[]>([])
  const [expandedId, setExpandedId]             = useState<string | null>(null)
  const [selectedRecordIds, setSelectedRecordIds] = useState<Set<string>>(new Set())
  const [approvalFilter, setApprovalFilter]     = useState(urlApproval)
  const [payableFilter, setPayableFilter]       = useState(urlPayable)
  const [statementSort, setStatementSort]       = useState<'az' | 'za' | 'highest_payable' | 'lowest_payable'>(urlSort || 'highest_payable')
  const [recoupFilter, setRecoupFilter]         = useState<'' | 'recouped' | 'unrecouped'>(urlRecoup)
  const [running, setRunning]                   = useState(false)
  const [runSoftBlock, setRunSoftBlock]         = useState<null | { unresolvedImports: ImportSummary[]; totalUnresolved: number }>(null)
  const [saving, setSaving]                     = useState<string | null>(null)
  const [error, setError]                       = useState<string | null>(null)
  const [runDiagnostic, setRunDiagnostic]       = useState<RunDiagnostic | null>(null)
  const [highlightedRecordIds, setHighlightedRecordIds] = useState<Set<string>>(new Set())
  const [showContractForm, setShowContractForm] = useState(false)
  const [showLinkModal, setShowLinkModal]       = useState(false)
  // Currency override: when set, overrides the reporting_currency from all imports for this run.
  // Blank = derive automatically from import.reporting_currency (or source_currency as fallback).
  const [outputCurrencyOverride, setOutputCurrencyOverride] = useState('')

  useEffect(() => { loadPeriods() }, [])
  useEffect(() => {
    if (urlDomain === 'master' || urlDomain === 'publishing') setDomain(urlDomain)
  }, [urlDomain])
  useEffect(() => {
    setSelectedContractIds([])
    setUseAllContracts(true)
    setSelectedRecordIds(new Set())
    setSelectedImportIds([])
    setScopeRows([])
    setRowSearch('')
    setDebouncedRowSearch('')
    setContractSearch('')
    setHighlightedRecordIds(new Set())
    setRunSoftBlock(null)
  }, [domain])
  useEffect(() => {
    const timer = window.setTimeout(() => setDebouncedRowSearch(rowSearch.trim().toLowerCase()), 150)
    return () => window.clearTimeout(timer)
  }, [rowSearch])
  useEffect(() => {
    if (selectedPeriodId) { loadRecords(); loadImports() }
  }, [selectedPeriodId, domain, approvalFilter, payableFilter, selectedContractIds.join(','), useAllContracts])
  useEffect(() => {
    const params = new URLSearchParams(searchParams.toString())
    params.set('domain', domain)
    if (selectedPeriodId) params.set('period', selectedPeriodId)
    else params.delete('period')
    if (approvalFilter) params.set('approval', approvalFilter)
    else params.delete('approval')
    if (payableFilter) params.set('payable', payableFilter)
    else params.delete('payable')
    if (recoupFilter) params.set('recoup', recoupFilter)
    else params.delete('recoup')
    if (statementSort && statementSort !== 'highest_payable') params.set('sort', statementSort)
    else params.delete('sort')
    const next = `${pathname}?${params.toString()}`
    const current = `${pathname}?${searchParams.toString()}`
    if (next !== current) router.replace(next, { scroll: false })
  }, [pathname, router, searchParams, domain, selectedPeriodId, approvalFilter, payableFilter, recoupFilter, statementSort])
  useEffect(() => {
    if (!selectedPeriodId) return
    void loadScopeRows()
  }, [selectedPeriodId, domain, selectedImportIds.join(',')])

  const fetchAllPaged = async <T,>(
    buildQuery: (from: number, to: number) => PromiseLike<{ data: T[] | null; error: any }>
  ): Promise<T[]> => {
    const rows: T[] = []
    for (let from = 0; ; from += REFERENCE_FETCH_PAGE_SIZE) {
      const to = from + REFERENCE_FETCH_PAGE_SIZE - 1
      const { data, error } = await buildQuery(from, to)
      if (error) throw error
      const batch = (data ?? []) as T[]
      rows.push(...batch)
      if (batch.length < REFERENCE_FETCH_PAGE_SIZE) break
    }
    return rows
  }

  const fetchAllImportRows = async <T,>(
    selectClause: string,
    importIds: string[],
    options?: { includeExcluded?: boolean }
  ): Promise<T[]> => {
    const rows: T[] = []
    for (let from = 0; ; from += IMPORT_ROW_FETCH_PAGE_SIZE) {
      let query = supabase
        .from('import_rows')
        .select(selectClause)
        .in('import_id', importIds)
        .eq('domain', domain)
        .order('import_id')
        .order('raw_row_number')
        .range(from, from + IMPORT_ROW_FETCH_PAGE_SIZE - 1)
      if (!options?.includeExcluded) query = query.eq('excluded_flag', false)
      const { data, error } = await query
      if (error) throw error
      const batch = (data ?? []) as T[]
      rows.push(...batch)
      if (batch.length < IMPORT_ROW_FETCH_PAGE_SIZE) break
    }
    return rows
  }

  const loadCurrentLinkageState = async () => {
    const [crl, splitLinks] = await Promise.all([
      fetchAllPaged<{ contract_id: string; repertoire_id: string }>((from, to) =>
        supabase
          .from('contract_repertoire_links')
          .select('contract_id, repertoire_id')
          .order('repertoire_id')
          .order('contract_id')
          .range(from, to)
      ),
      fetchAllPaged<{ contract_id: string; repertoire_id: string }>((from, to) =>
        supabase
          .from('contract_repertoire_payee_splits')
          .select('contract_id, repertoire_id')
          .eq('is_active', true)
          .order('repertoire_id')
          .order('contract_id')
          .range(from, to)
      ),
    ])
    setContractRepertoireLinks(crl)
    setContractRepertoireSplits(splitLinks)
  }

  const loadReferenceData = async () => {
    const [cd, sp] = await Promise.all([
      fetchAllPaged<any>((from, to) =>
        supabase.from('contracts').select('*').order('contract_name').range(from, to)
      ),
      supabase.from('sending_parties').select('id, name').eq('is_active', true),
      loadCurrentLinkageState(),
    ])
    setContracts(sortByLabel(cd, contract => `${contract.contract_name}${contract.contract_code ? ` (${contract.contract_code})` : ''}`))
    setSendingParties(sortByLabel(sp.data ?? [], party => party.name))
  }

  const loadPeriods = async () => {
    const [pd] = await Promise.all([
      supabase.from('statement_periods').select('*').order('year', { ascending: false }).order('half', { ascending: false }),
      loadReferenceData(),
    ])
    setPeriods(sortByLabel(pd.data ?? [], period => period.label))
    const current = (pd.data ?? []).find((p: any) => p.is_current) ?? pd.data?.[0]
    if (current) setSelectedPeriodId(current.id)
    setLoading(false)
  }

  const loadRecords = async () => {
    if (!useAllContracts && selectedContractIds.length === 0) {
      setRecords([])
      setSelectedRecordIds(new Set())
      return
    }

    let q = supabase
      .from('statement_records')
      .select('*, payee:payees(payee_name,primary_email,currency), contract:contracts(contract_name,contract_code), statement_period:statement_periods(label)')
      .eq('statement_period_id', selectedPeriodId)
      .eq('domain', domain)
      .order('is_payable', { ascending: false })
      .order('payable_amount', { ascending: false })
    if (!useAllContracts) q = q.in('contract_id', selectedContractIds)
    if (approvalFilter) q = q.eq('approval_status', approvalFilter)
    if (payableFilter === 'payable')   q = q.eq('is_payable', true)
    if (payableFilter === 'recouping') q = q.eq('is_recouping', true)
    if (payableFilter === 'carry')     q = q.gt('carry_forward_amount', 0)
    const { data, error: err } = await q
    if (err) setError(err.message)
    else {
      setRecords(data ?? [])
      setSelectedRecordIds(prev => new Set(Array.from(prev).filter(id => (data ?? []).some((record: any) => record.id === id))))
    }
  }

  const loadImports = async () => {
    const { data } = await supabase
      .from('imports')
      .select('id, import_type, domain, source_name, row_count, success_count, source_currency, reporting_currency, exchange_rate')
      .eq('statement_period_id', selectedPeriodId)
      .eq('domain', domain)
    const imports = (data ?? []) as any[]
    const importIds = imports.map(imp => imp.id)

    let unresolvedByImport = new Map<string, number>()
    let unresolvedAmountByImport = new Map<string, number>()
    if (importIds.length > 0) {
      const [rowData, linkData, splitData, contractData, payeeLinkData] = await Promise.all([
        fetchAllImportRows<{
          import_id: string
          domain: Domain
          matched_repertoire_id: string | null
          income_type: string | null
          amount: number | null
          amount_converted: number | null
          net_amount: number | null
          row_type: string | null
          excluded_flag: boolean
        }>(
          'import_id, domain, matched_repertoire_id, income_type, amount, amount_converted, net_amount, row_type, excluded_flag',
          importIds,
          { includeExcluded: true }
        ),
        fetchAllPaged<{ repertoire_id: string | null }>((from, to) =>
          supabase
            .from('contract_repertoire_links')
            .select('contract_id, repertoire_id, royalty_rate')
            .order('repertoire_id')
            .range(from, to)
        ),
        fetchAllPaged<{ repertoire_id: string | null }>((from, to) =>
          supabase
            .from('contract_repertoire_payee_splits')
            .select('contract_id, repertoire_id, is_active')
            .eq('is_active', true)
            .order('repertoire_id')
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
            .select('contract_id, royalty_share, is_active')
            .eq('is_active', true)
            .order('contract_id')
            .range(from, to)
        ),
      ])

      const importSummaryById = new Map(imports.map((imp: any) => [imp.id, imp]))
      for (const row of rowData ?? []) {
        if (!isLiveUnresolvedRow(
          row,
          contractData,
          payeeLinkData,
          splitData,
          linkData as ContractRepertoireAllocationLink[],
        )) continue
        unresolvedByImport.set(row.import_id, (unresolvedByImport.get(row.import_id) ?? 0) + 1)
        unresolvedAmountByImport.set(
          row.import_id,
          (unresolvedAmountByImport.get(row.import_id) ?? 0) + resolveImportRowGross(row, importSummaryById.get(row.import_id))
        )
      }
    }

    const rows = imports.map((imp: any) => ({
      ...imp,
      import_id: imp.id,
      unresolved: unresolvedByImport.get(imp.id) ?? 0,
      unresolved_amount: unresolvedAmountByImport.get(imp.id) ?? 0,
      source_currency: imp.source_currency ?? null,
      reporting_currency: imp.reporting_currency ?? null,
      exchange_rate: imp.exchange_rate ?? null,
    }))
    setImports(rows)
    setSelectedImportIds(prev => {
      const availableIds = rows.map((row: ImportSummary) => row.import_id)
      const storageKey = `statement-run:selected-imports:${domain}:${selectedPeriodId}`
      const saved = typeof window !== 'undefined' ? window.localStorage.getItem(storageKey) : null
      const savedIds = saved ? JSON.parse(saved) as string[] : []
      const validSavedIds = savedIds.filter(id => availableIds.includes(id))
      if (prev.length > 0) {
        const validPrev = prev.filter(id => availableIds.includes(id))
        return validPrev.length > 0 ? validPrev : availableIds
      }
      return validSavedIds.length > 0 ? validSavedIds : availableIds
    })
    setRunSoftBlock(null)
  }

  const loadScopeRows = async () => {
    if (!selectedPeriodId || selectedImportIds.length === 0) {
      setScopeRows([])
      return
    }
    setScopeRowsLoading(true)
    try {
      const [data] = await Promise.all([
        fetchAllImportRows<ScopeRow>(
          'id, import_id, raw_row_number, title_raw, artist_name_raw, identifier_raw, tempo_id, income_type, amount, amount_converted, net_amount, currency, row_type, match_status, matched_contract_id, matched_repertoire_id',
          selectedImportIds
        ),
        loadCurrentLinkageState(),
      ])
      setScopeRows(data)
      setScopePreviewPage(1)
    } catch (rowsError: any) {
      setError(rowsError.message)
      setScopeRows([])
    } finally {
      setScopeRowsLoading(false)
    }
  }

  // ── Run ───────────────────────────────────────────────────────────────────

  const runStatements = async (allowUnresolved = false) => {
    if (!selectedPeriodId) return
    if (selectedImportIds.length === 0) {
      setError('Select at least one import before running statements.')
      return
    }
    if (!allowUnresolved) {
      const unresolvedImports = imports.filter(imp => selectedImportIds.includes(imp.import_id) && imp.unresolved > 0)
      if (unresolvedImports.length > 0) {
        setRunSoftBlock({
          unresolvedImports,
          totalUnresolved: unresolvedImports.reduce((sum, imp) => sum + imp.unresolved, 0),
        })
        return
      }
    }

    setRunning(true); setError(null); setRunDiagnostic(null)
    setRunSoftBlock(null)

    try {
      const { data: pi } = await supabase.from('imports')
        .select('id, source_name, source_currency, reporting_currency, exchange_rate')
        .eq('statement_period_id', selectedPeriodId).eq('domain', domain)
        .in('id', selectedImportIds)

      const importIds = Array.from((pi ?? []).map((i: any) => i.id))

      if (importIds.length === 0) {
        setError('No imports linked to this period. Open the import and assign it to this period.')
        setRunDiagnostic({
          imports_found: 0,
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
        })
        setRunning(false)
        return
      }

      const rowsData = await fetchAllImportRows<any>('*', importIds)

      const periodsChronological = [...periods].sort(
        (a, b) => new Date(a.period_start).getTime() - new Date(b.period_start).getTime()
      )
      const currentPeriodIndex = periodsChronological.findIndex(period => period.id === selectedPeriodId)
      const previousPeriodId = currentPeriodIndex > 0 ? periodsChronological[currentPeriodIndex - 1]?.id ?? null : null
      const nextPeriodId = currentPeriodIndex >= 0 && currentPeriodIndex < periodsChronological.length - 1
        ? periodsChronological[currentPeriodIndex + 1]?.id ?? null
        : null

      const [lD, { data: cvD }, fcD, spD, crlD, costD, previousStatementRows] = await Promise.all([
        fetchAllPaged<any>((from, to) =>
          supabase
            .from('contract_payee_links')
            .select('*')
            .eq('is_active', true)
            .order('contract_id')
            .order('payee_id')
            .range(from, to)
        ),
        supabase.from('carryover_ledger').select('*').eq('to_period_id', selectedPeriodId),
        fetchAllPaged<any>((from, to) =>
          supabase.from('contracts').select('*').order('contract_name').range(from, to)
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
        fetchAllPaged<any>((from, to) =>
          supabase
            .from('contract_repertoire_links')
            .select('contract_id, repertoire_id, royalty_rate')
            .order('repertoire_id')
            .order('contract_id')
            .range(from, to)
        ),
        fetchAllPaged<StatementGenerationContractCost>((from, to) =>
          supabase
            .from('contract_costs')
            .select('id, contract_id, statement_period_id, cost_type, description, cost_date, amount, currency, recoupable, applied_status, notes')
            .eq('statement_period_id', selectedPeriodId)
            .neq('applied_status', 'waived')
            .order('contract_id')
            .order('cost_date', { ascending: false })
            .range(from, to)
        ),
        previousPeriodId
          ? fetchAllPaged<StatementGenerationPreviousStatementCarryover>((from, to) =>
              supabase
                .from('statement_records')
                .select('contract_id, payee_id, carry_forward_amount, final_balance_after_carryover, is_recouping')
                .eq('statement_period_id', previousPeriodId)
                .eq('domain', domain)
                .range(from, to)
            )
          : Promise.resolve([] as StatementGenerationPreviousStatementCarryover[]),
      ])

      const allRows = rowsData ?? []
      const linkedRepertoireIds = buildPublishingContractPathSet(
        crlD as any[],
        spD as any[],
      )
      const matchedRows = allRows.filter((row: any) => isPublishingStatementEligibleRow(row, domain, linkedRepertoireIds))

      if (matchedRows.length === 0) {
        const total = allRows.length
        const unm   = allRows.filter((r: any) => r.match_status === 'unmatched').length
        const part  = allRows.filter((r: any) => r.match_status === 'partial').length
        setError(total === 0
          ? 'Imports exist but contain no rows.'
          : `No matched rows. ${total} total: ${unm} unmatched, ${part} partial. Run import matching first.`)
        setRunDiagnostic({
          imports_found: importIds.length,
          rows_fetched: matchedRows.length,
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
        })
        setRunning(false)
        return
      }

      const { diagnostic: diag, drafts } = generateStatementRunData({
        domain,
        statementPeriodId: selectedPeriodId,
        imports: (pi ?? []) as any[],
        rows: allRows as any[],
        contracts: fcD as any[],
        payeeLinks: lD as any[],
        carryovers: (cvD ?? []) as any[],
        previousStatementCarryovers: previousStatementRows as StatementGenerationPreviousStatementCarryover[],
        contractCosts: costD as any[],
        splits: spD as any[],
        contractRepertoireLinks: crlD as any[],
        outputCurrencyOverride,
        selectedContractIds,
        restrictToSelectedContracts: !useAllContracts,
      })

      const touchedRecordIds = new Set<string>()
      const carryoverLedgerRows: Array<Record<string, any>> = []
      for (const draft of drafts) {
        const { data: existing } = await supabase.from('statement_records')
          .select('id, manual_override_flag, opening_balance, prior_period_carryover_applied, hold_payment_flag, override_notes, balance_confirmed_flag, carryover_confirmed_flag')
          .eq('contract_id', draft.contract_id).eq('payee_id', draft.payee_id).eq('statement_period_id', selectedPeriodId)
          .maybeSingle()

        let recordId: string
        let payload: Record<string, any> = draft.payload
        if (existing) {
          if (existing.manual_override_flag) {
            const contract = (fcD as any[]).find(contractRow => contractRow.id === draft.contract_id) ?? null
            const recalculated = calculateStatementRecord(
              Number(existing.opening_balance ?? 0),
              Number(draft.payload.current_earnings ?? 0),
              Number(draft.payload.deductions ?? 0),
              Number(existing.prior_period_carryover_applied ?? 0),
              contract,
              existing.hold_payment_flag ?? contract?.hold_payment_flag ?? false,
            )
            payload = {
              ...draft.payload,
              opening_balance: recalculated.opening_balance,
              closing_balance_pre_carryover: recalculated.closing_balance_pre_carryover,
              prior_period_carryover_applied: recalculated.prior_period_carryover_applied,
              final_balance_after_carryover: recalculated.final_balance_after_carryover,
              payable_amount: recalculated.payable_amount,
              carry_forward_amount: recalculated.carry_forward_amount,
              is_payable: recalculated.is_payable,
              is_recouping: recalculated.is_recouping,
              manual_override_flag: true,
              hold_payment_flag: existing.hold_payment_flag ?? contract?.hold_payment_flag ?? false,
              override_notes: existing.override_notes ?? null,
              balance_confirmed_flag: existing.balance_confirmed_flag ?? false,
              carryover_confirmed_flag: existing.carryover_confirmed_flag ?? false,
            }
            if (!diag.user_fixable.includes('manual balance overrides were preserved while current-period earnings and lines were refreshed')) {
              diag.user_fixable.push('manual balance overrides were preserved while current-period earnings and lines were refreshed')
            }
          }
          await supabase.from('statement_records').update(payload).eq('id', existing.id)
          recordId = existing.id; diag.statements_updated++
        } else {
          const { data: ins } = await supabase.from('statement_records')
            .insert({ ...payload, approval_status: 'pending' }).select('id').single()
          recordId = ins!.id; diag.statements_created++
        }
        touchedRecordIds.add(recordId)

        if (nextPeriodId) {
          const carryReason = draft.payload.is_recouping
            ? 'recouping'
            : draft.payload.carry_forward_amount > 0
            ? 'below_threshold'
            : null
          const carriedAmount = draft.payload.is_recouping
            ? Number(draft.payload.final_balance_after_carryover ?? 0)
            : Number(draft.payload.carry_forward_amount ?? 0)

          if (carryReason && carriedAmount !== 0) {
            carryoverLedgerRows.push({
              contract_id: draft.contract_id,
              payee_id: draft.payee_id,
              domain,
              from_period_id: selectedPeriodId,
              to_period_id: nextPeriodId,
              carried_amount: carriedAmount,
              currency: draft.payload.statement_currency ?? (domain === 'publishing' ? 'EUR' : 'GBP'),
              carry_reason: carryReason,
              balance_at_carry: Number(draft.payload.final_balance_after_carryover ?? 0),
              threshold_at_carry: null,
              source_statement_record_id: recordId,
              notes: 'Auto-generated on statement run',
              created_by: 'Statement Run',
            })
          }
        }

        await supabase.from('statement_line_summaries').delete().eq('statement_record_id', recordId)
        const lines = draft.lines
        if (lines.length > 0) {
          const lp = lines.map(l => ({ ...l, statement_record_id: recordId }))
          for (let i = 0; i < lp.length; i += 100) {
            const { error: lineErr } = await supabase.from('statement_line_summaries').insert(lp.slice(i, i + 100))
            if (lineErr) {
              if (!diag.system_issues.includes(`line insert failed: ${lineErr.message}`)) {
                diag.system_issues.push(`line insert failed: ${lineErr.message}`)
              }
            } else {
              diag.lines_written += lp.slice(i, i + 100).length
            }
          }
        }
        if (draft.appliedCostIds.length > 0) {
          await supabase
            .from('contract_costs')
            .update({
              applied_status: 'applied',
              applied_at: new Date().toISOString(),
              applied_by: 'Statement Run',
              updated_at: new Date().toISOString(),
            })
            .in('id', draft.appliedCostIds)
        }
      }

      if (nextPeriodId) {
        await supabase
          .from('carryover_ledger')
          .delete()
          .eq('from_period_id', selectedPeriodId)
          .eq('domain', domain)
          .eq('created_by', 'Statement Run')

        if (carryoverLedgerRows.length > 0) {
          await supabase
            .from('carryover_ledger')
            .upsert(carryoverLedgerRows, {
              onConflict: 'contract_id,payee_id,from_period_id,to_period_id',
            })
        }
      }

      setRunDiagnostic(diag)
      setSelectedRecordIds(new Set())
      setHighlightedRecordIds(touchedRecordIds)
      loadRecords()
    } catch (e: any) {
      setError(e.message ?? 'Run failed.')
    }
    setRunning(false)
  }

  // ── Per-record actions ─────────────────────────────────────────────────────

  const updateApproval = async (id: string, status: string) => {
    setSaving(id)
    const { error: err } = await supabase.from('statement_records')
      .update({ approval_status: status, approved_at: new Date().toISOString() }).eq('id', id)
    if (err) setError(err.message)
    else setRecords(rs => rs.map(r => r.id === id ? { ...r, approval_status: status } : r))
    setSaving(null)
  }

  const confirmBalance = async (id: string) => {
    setSaving(id)
    await supabase.from('statement_records').update({ balance_confirmed_flag: true }).eq('id', id)
    setRecords(rs => rs.map(r => r.id === id ? { ...r, balance_confirmed_flag: true } : r))
    setSaving(null)
  }

  const confirmCarryover = async (id: string) => {
    setSaving(id)
    await supabase.from('statement_records').update({ carryover_confirmed_flag: true }).eq('id', id)
    setRecords(rs => rs.map(r => r.id === id ? { ...r, carryover_confirmed_flag: true } : r))
    setSaving(null)
  }

  // Req 5: delete single record + its line summaries
  const deleteRecord = async (id: string) => {
    if (!confirm('Delete this statement record and its line items? This cannot be undone.')) return
    setSaving(id)
    await supabase.from('statement_line_summaries').delete().eq('statement_record_id', id)
    await supabase.from('statement_records').delete().eq('id', id)
    setRecords(rs => rs.filter(r => r.id !== id))
    setSelectedRecordIds(prev => {
      const next = new Set(prev)
      next.delete(id)
      return next
    })
    setSaving(null)
  }

  const deleteSelectedRecords = async () => {
    const ids = Array.from(selectedRecordIds)
    if (ids.length === 0) return
    if (!confirm(`Delete ${ids.length} selected statement${ids.length !== 1 ? 's' : ''} and all related line items? This cannot be undone.`)) return
    setSaving('__bulk_delete__')
    await supabase.from('statement_line_summaries').delete().in('statement_record_id', ids)
    await supabase.from('statement_records').delete().in('id', ids)
    setRecords(rs => rs.filter(r => !selectedRecordIds.has(r.id)))
    setSelectedRecordIds(new Set())
    setSaving(null)
  }

  // ── Derived ────────────────────────────────────────────────────────────────

  const totalPayable   = records.filter(r => r.is_payable).reduce((s, r) => s + r.payable_amount, 0)
  const totalNetAfterRun = records.reduce((sum, record) => sum + Number(record.payable_amount ?? 0) + Number(record.carry_forward_amount ?? 0), 0)
  const payableCount   = records.filter(r => r.is_payable).length
  const approvedCount  = records.filter(r => r.approval_status === 'approved').length
  const scopedImports = imports.filter(imp => selectedImportIds.includes(imp.import_id))
  const unresolvedTotal = scopedImports.reduce((s, i) => s + i.unresolved, 0)
  const selectedPeriod = periods.find(p => p.id === selectedPeriodId)
  const domainContracts = contracts.filter((contract: any) => contractTypeToDomain(contract.contract_type) === domain)
  const filteredDomainContracts = contractSearch.trim()
    ? domainContracts.filter((contract: any) => {
        const query = contractSearch.trim().toLowerCase()
        return `${contract.contract_name ?? ''} ${contract.contract_code ?? ''}`.toLowerCase().includes(query)
      })
    : domainContracts
  const scopedContractsLabel = useAllContracts
    ? `All ${domainContracts.length} ${domain} contracts (none selected)`
    : `${selectedContractIds.length} selected`
  const visibleRecords = records
    .filter(record => {
      if (recoupFilter === 'recouped') return !record.is_recouping
      if (recoupFilter === 'unrecouped') return record.is_recouping
      return true
    })
    .slice()
    .sort((a, b) => {
      if (statementSort === 'az') return (a.payee?.payee_name ?? '').localeCompare(b.payee?.payee_name ?? '')
      if (statementSort === 'za') return (b.payee?.payee_name ?? '').localeCompare(a.payee?.payee_name ?? '')
      if (statementSort === 'lowest_payable') return getStatementListAmount(a) - getStatementListAmount(b)
      return getStatementListAmount(b) - getStatementListAmount(a)
    })
  const allVisibleRecordsSelected = visibleRecords.length > 0 && visibleRecords.every(record => selectedRecordIds.has(record.id))
  const someRecordsSelected = selectedRecordIds.size > 0
  const allVisibleImportsSelected = imports.length > 0 && imports.every(imp => selectedImportIds.includes(imp.import_id))
  const filteredScopeRows = debouncedRowSearch
    ? scopeRows.filter(row => {
        const haystack = [
          row.title_raw ?? '',
          row.artist_name_raw ?? '',
          row.tempo_id ?? '',
          row.identifier_raw ?? '',
        ].join(' ').toLowerCase()
        return haystack.includes(debouncedRowSearch)
      })
    : scopeRows
  const totalScopePreviewRows = filteredScopeRows.length
  const totalScopePreviewPages = Math.max(1, Math.ceil(totalScopePreviewRows / SCOPE_PREVIEW_PAGE_SIZE))
  const safeScopePreviewPage = Math.min(scopePreviewPage, totalScopePreviewPages)
  const scopePreviewStart = totalScopePreviewRows === 0 ? 0 : (safeScopePreviewPage - 1) * SCOPE_PREVIEW_PAGE_SIZE
  const scopePreviewEnd = Math.min(scopePreviewStart + SCOPE_PREVIEW_PAGE_SIZE, totalScopePreviewRows)
  const visibleScopeRows = filteredScopeRows.slice(scopePreviewStart, scopePreviewEnd)
  const groupedScopeRows = scopedImports.map(imp => ({
    importId: imp.import_id,
    importName: imp.source_name ?? imp.import_type,
    rows: visibleScopeRows.filter(row => row.import_id === imp.import_id),
  })).filter(group => group.rows.length > 0 || !debouncedRowSearch)
  const selectedContractSet = new Set(selectedContractIds)
  const eligiblePublishingRepertoireIds = !useAllContracts
    ? new Set([
        ...contractRepertoireLinks.filter(link => selectedContractSet.has(link.contract_id)).map(link => link.repertoire_id),
        ...contractRepertoireSplits.filter(link => selectedContractSet.has(link.contract_id)).map(link => link.repertoire_id),
      ])
    : new Set(contractRepertoireLinks.map(link => link.repertoire_id))
  const scopedRunRows = scopeRows.filter(row => {
    const statementEligible = isPublishingStatementEligibleRow(row, domain, eligiblePublishingRepertoireIds)
    if (!statementEligible) return false
    if (useAllContracts) return true
    if (domain === 'master') return !!row.matched_contract_id && selectedContractSet.has(row.matched_contract_id)
    return !!row.matched_repertoire_id && eligiblePublishingRepertoireIds?.has(row.matched_repertoire_id)
  })
  const resolveScopeGross = (row: ScopeRow) => {
    if (row.row_type === 'deduction') return 0
    const imp = imports.find(item => item.import_id === row.import_id)
    const hasFx = !!(imp?.exchange_rate && imp.exchange_rate !== 1)
    if (hasFx && row.amount_converted != null) return row.amount_converted
    return row.net_amount ?? row.amount ?? 0
  }
  const scopedRunRowIds = new Set(scopedRunRows.map(row => row.id))
  const grossByImport = new Map<string, number>()
  for (const row of scopedRunRows) {
    grossByImport.set(row.import_id, (grossByImport.get(row.import_id) ?? 0) + resolveScopeGross(row))
  }
  const grossInScopeTotal = Array.from(grossByImport.values()).reduce((sum, value) => sum + value, 0)
  const unresolvedScopeImports = imports.filter(imp => selectedImportIds.includes(imp.import_id))
  const unmatchedOrErrorRows = scopeRows.filter(row => !scopedRunRowIds.has(row.id))
  const unmatchedOrErrorAmount = unresolvedScopeImports.reduce((sum, imp) => sum + (imp.unresolved_amount ?? 0), 0)

  const toggleContractSelection = (contractId: string) => {
    setUseAllContracts(false)
    setSelectedContractIds(prev =>
      prev.includes(contractId)
        ? prev.filter(id => id !== contractId)
        : [...prev, contractId]
    )
  }

  const toggleRecordSelection = (recordId: string) => {
    setSelectedRecordIds(prev => {
      const next = new Set(prev)
      if (next.has(recordId)) next.delete(recordId)
      else next.add(recordId)
      return next
    })
  }

  const toggleAllVisibleRecords = () => {
    if (allVisibleRecordsSelected) {
      setSelectedRecordIds(new Set())
      return
    }
    setSelectedRecordIds(new Set(visibleRecords.map(record => record.id)))
  }

  const downloadSelectedStatementsZip = async () => {
    const selected = visibleRecords.filter(record => selectedRecordIds.has(record.id))
    if (selected.length === 0) return
    setSaving('__bulk_download__')
    setError(null)
    try {
      const recordIds = selected.map(record => record.id)
      const lineRows = await fetchAllPaged<any>((from, to) =>
        supabase
          .from('statement_line_summaries')
          .select('*')
          .in('statement_record_id', recordIds)
          .order('statement_record_id')
          .order('title')
          .range(from, to)
      )
      const linesByRecord = new Map<string, any[]>()
      for (const line of lineRows) {
        const list = linesByRecord.get(line.statement_record_id) ?? []
        list.push(line)
        linesByRecord.set(line.statement_record_id, list)
      }
      const files = await Promise.all(selected.map(async record => {
        const payeeName = (record.payee?.payee_name ?? record.payee_id).replace(/[^a-zA-Z0-9]+/g, '_')
        const contractName = (record.contract?.contract_code ?? record.contract?.contract_name ?? record.contract_id).replace(/[^a-zA-Z0-9]+/g, '_')
        const periodLabel = (record.statement_period?.label ?? selectedPeriod?.label ?? 'statement').replace(/[^a-zA-Z0-9]+/g, '_')
        const output: StatementOutputData = {
          record: record as any,
          payee_name: record.payee?.payee_name ?? record.payee_id,
          statement_name: record.payee?.payee_name ?? record.payee_id,
          contract_name: record.contract?.contract_name ?? record.contract_id,
          contract_code: record.contract?.contract_code ?? null,
          period_label: record.statement_period?.label ?? selectedPeriod?.label ?? 'Statement',
          period_start: '',
          period_end: '',
          currency: record.statement_currency ?? record.payee?.currency ?? 'GBP',
          lines: linesByRecord.get(record.id) ?? [],
        }
        return {
          name: `${payeeName}__${contractName}__${periodLabel}.pdf`,
          data: await generateStatementPdf(output),
        }
      }))
      const zipBlob = buildZipArchive(files)
      const url = URL.createObjectURL(zipBlob)
      const link = document.createElement('a')
      link.href = url
      link.download = `${domain}_${selectedPeriod?.label ?? 'statements'}_selected.zip`.replace(/[^a-zA-Z0-9_.-]+/g, '_')
      link.click()
      URL.revokeObjectURL(url)
    } catch (e: any) {
      setError(e?.message
        ? `Statement PDF export failed: ${e.message}`
        : 'Statement PDF export failed. Please try again.')
    } finally {
      setSaving(null)
    }
  }

  const toggleImportSelection = (importId: string) => {
    setSelectedImportIds(prev =>
      prev.includes(importId)
        ? prev.filter(id => id !== importId)
        : [...prev, importId]
    )
  }

  const selectAllImports = () => {
    setSelectedImportIds(imports.map(imp => imp.import_id))
  }

  const deselectAllImports = () => {
    setSelectedImportIds([])
  }
  const statementViewReturnTo = (() => {
    const params = new URLSearchParams()
    params.set('domain', domain)
    if (selectedPeriodId) params.set('period', selectedPeriodId)
    if (approvalFilter) params.set('approval', approvalFilter)
    if (payableFilter) params.set('payable', payableFilter)
    if (recoupFilter) params.set('recoup', recoupFilter)
    if (statementSort) params.set('sort', statementSort)
    return `/statements?${params.toString()}`
  })()

  useEffect(() => {
    setScopePreviewPage(1)
  }, [debouncedRowSearch, selectedImportIds.join(','), domain])

  useEffect(() => {
    if (scopePreviewPage > totalScopePreviewPages) {
      setScopePreviewPage(totalScopePreviewPages)
    }
  }, [scopePreviewPage, totalScopePreviewPages])

  useEffect(() => {
    if (!selectedPeriodId) return
    const storageKey = `statement-run:selected-imports:${domain}:${selectedPeriodId}`
    window.localStorage.setItem(storageKey, JSON.stringify(selectedImportIds))
  }, [domain, selectedImportIds, selectedPeriodId])

  const iStyle: React.CSSProperties = { padding: '5px 8px', borderRadius: 6, border: '1px solid var(--ops-border)', background: 'var(--ops-surface)', color: 'var(--ops-text)', fontSize: 13 }

  if (loading) return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: 32, color: 'var(--ops-muted)' }}>
      <LoadingSpinner /> Loading…
    </div>
  )

  return (
    <div className="space-y-5">

      {/* Header */}
      <div className="page-header">
        <div>
          <h1 className="page-title">Statement Run</h1>
          <p className="page-subtitle">Calculate balances, review statements, approve for output</p>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          {domain === 'publishing' && (
            <button onClick={() => setShowLinkModal(true)} className="btn-ghost btn-sm" style={{ display: 'flex', alignItems: 'center', gap: 5 }}>
              <Link2 size={13} /> Link Work
            </button>
          )}
          <button onClick={() => setShowContractForm(true)} className="btn-ghost btn-sm" style={{ display: 'flex', alignItems: 'center', gap: 5 }}>
            <Plus size={13} /> Contract
          </button>
          <button onClick={() => { void loadReferenceData(); void loadRecords(); void loadImports(); void loadScopeRows() }} className="btn-ghost btn-sm">
            <RefreshCw size={13} />
          </button>
          <button onClick={() => { void runStatements() }} disabled={running || !selectedPeriodId || selectedImportIds.length === 0}
            className="btn-primary btn-sm" style={{ display: 'flex', alignItems: 'center', gap: 5 }}>
            {running ? <LoadingSpinner size={13} /> : <PlayCircle size={13} />}
            {running ? 'Running…' : 'Run Statements'}
          </button>
        </div>
      </div>

      {error         && <Alert type="error">{error}</Alert>}
      {runSoftBlock && (
        <Alert type="warning">
          <div className="space-y-3">
            <div>Some rows from this import are unresolved. Please check the Sales Errors page before running the statement.</div>
            <div className="text-xs text-ops-muted">
              {runSoftBlock.unresolvedImports.map(imp => `${imp.source_name ?? imp.import_type}: ${imp.unresolved}`).join(' · ')}
            </div>
            <div className="flex items-center gap-2">
              <Link href="/sales-errors" className="btn-secondary btn-sm">Go to Sales Errors</Link>
              <button className="btn-primary btn-sm" onClick={() => { void runStatements(true) }}>
                Run Anyway
              </button>
            </div>
          </div>
        </Alert>
      )}
      {runDiagnostic && <RunDiagnosticPanel diag={runDiagnostic} />}

      {/* Controls */}
      <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 8 }}>
        <select style={iStyle} value={selectedPeriodId} onChange={e => setSelectedPeriodId(e.target.value)}>
          {periods.map(p => <option key={p.id} value={p.id}>{p.label}{(p as any).is_current ? ' ★' : ''}</option>)}
        </select>
        <div style={{ display: 'flex', borderRadius: 6, overflow: 'hidden', border: '1px solid var(--ops-border)' }}>
          {(['master','publishing'] as Domain[]).map(d => (
            <button key={d} onClick={() => setDomain(d)} style={{ padding: '5px 12px', fontSize: 13, border: 'none', cursor: 'pointer', background: domain === d ? '#2563eb' : 'var(--ops-surface)', color: domain === d ? '#fff' : 'var(--ops-muted)' }}>
              {d.charAt(0).toUpperCase() + d.slice(1)}
            </button>
          ))}
        </div>
        <select style={iStyle} value={approvalFilter} onChange={e => setApprovalFilter(e.target.value)}>
          <option value="">All approval statuses</option>
          <option value="approved">Approved</option>
          <option value="on_hold">On Hold</option>
          <option value="pending">Pending</option>
          <option value="rejected">Rejected</option>
        </select>
        <select style={iStyle} value={payableFilter} onChange={e => setPayableFilter(e.target.value)}>
          <option value="">All balance states</option>
          <option value="payable">Payable</option>
          <option value="carry">Carry Forward</option>
          <option value="recouping">Recouping</option>
        </select>
        <input
          style={{ ...iStyle, minWidth: 260, flex: '1 1 260px' }}
          value={rowSearch}
          onChange={e => setRowSearch(e.target.value)}
          placeholder="Search scope by work title, writer, Tempo ID, or ISWC"
        />
      </div>

      <div className="card">
        <SectionHeader title="Contract Scope" action={<span style={{ fontSize: 12, color: 'var(--ops-muted)' }}>{scopedContractsLabel}</span>} />
        <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
          <button className="btn-ghost btn-sm" onClick={() => { setUseAllContracts(true); setSelectedContractIds([]) }} disabled={useAllContracts}>
            Use all contracts
          </button>
          <button
            className="btn-ghost btn-sm"
            onClick={() => { setUseAllContracts(false); setSelectedContractIds(domainContracts.map((contract: any) => contract.id)) }}
            disabled={domainContracts.length === 0}
          >
            Select all {domain}
          </button>
          <button
            className="btn-ghost btn-sm"
            onClick={() => { setUseAllContracts(false); setSelectedContractIds([]) }}
            disabled={!useAllContracts && selectedContractIds.length === 0}
          >
            Deselect All
          </button>
          <input
            style={{ ...iStyle, minWidth: 240, flex: '1 1 240px' }}
            value={contractSearch}
            onChange={e => setContractSearch(e.target.value)}
            placeholder="Search contracts by name or code"
          />
        </div>
        <div style={{ maxHeight: 160, overflowY: 'auto', border: '1px solid var(--ops-border)', borderRadius: 8, background: 'var(--ops-surface-2)', padding: 8 }}>
          {domainContracts.length === 0 ? (
            <div style={{ fontSize: 12, color: 'var(--ops-muted)' }}>No {domain} contracts available.</div>
          ) : filteredDomainContracts.length === 0 ? (
            <div style={{ fontSize: 12, color: 'var(--ops-muted)' }}>No contracts match that search.</div>
          ) : (
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(240px, 1fr))', gap: 8 }}>
                {filteredDomainContracts.map((contract: any) => {
                  const checked = !useAllContracts && selectedContractIds.includes(contract.id)
                  return (
                    <label
                      key={contract.id}
                      style={{
                        display: 'flex',
                        alignItems: 'center',
                        gap: 8,
                        padding: '6px 8px',
                        borderRadius: 6,
                        border: '1px solid var(--ops-border)',
                        background: checked ? 'var(--ops-surface)' : 'transparent',
                        fontSize: 12,
                        color: 'var(--ops-text)',
                        cursor: 'pointer',
                      }}
                    >
                      <input
                        type="checkbox"
                        checked={checked}
                        onChange={() => {
                          if (useAllContracts) {
                            setUseAllContracts(false)
                            setSelectedContractIds([contract.id])
                          } else {
                            toggleContractSelection(contract.id)
                          }
                        }}
                      />
                      <span style={{ display: 'flex', flexDirection: 'column', minWidth: 0 }}>
                        <span style={{ fontWeight: 500, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{contract.contract_name}</span>
                        <span style={{ color: 'var(--ops-muted)', fontFamily: 'monospace', fontSize: 11 }}>{contract.contract_code ?? contract.id.slice(0, 8)}</span>
                      </span>
                    </label>
                  )
                })}
              </div>
            )}
          </div>
          <div style={{ fontSize: 11, color: 'var(--ops-subtle)' }}>
            Selected contracts limit the next run and the visible statement list for this period. Use “Use all contracts” to restore the current all-contracts behaviour.
          </div>
        </div>
      </div>

      {/* ── Pre-run currency panel ───────────────────────────────────────────
          Shown when imports are loaded. Makes the statement output currency
          explicit BEFORE the user clicks Run. Allows override.
          ─────────────────────────────────────────────────────────────────── */}
      {scopedImports.length > 0 && records.length === 0 && (
        <CurrencyPreviewPanel
          imports={scopedImports}
          domain={domain}
          outputCurrencyOverride={outputCurrencyOverride}
          onOverrideChange={setOutputCurrencyOverride}
        />
      )}

      {/* ── Post-run currency override notice (runs already exist) ──────── */}
      {scopedImports.length > 0 && records.length > 0 && outputCurrencyOverride && (
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '8px 12px', borderRadius: 6, border: '1px solid rgba(234,179,8,0.3)', background: 'rgba(234,179,8,0.07)', fontSize: 12 }}>
          <AlertTriangle size={13} style={{ color: 'var(--accent-amber)', flexShrink: 0 }} />
          <span style={{ color: 'var(--accent-amber)' }}>
            Output currency override active: <strong>{outputCurrencyOverride.toUpperCase()}</strong>.
            Re-running statements will lock this currency. Clear the override to use import defaults.
          </span>
          <button onClick={() => setOutputCurrencyOverride('')} style={{ marginLeft: 'auto', background: 'none', border: 'none', cursor: 'pointer', color: 'var(--ops-muted)', fontSize: 11 }}>
            Clear ×
          </button>
        </div>
      )}

      {/* Stats */}
      {(() => {
        const defaultStatementCurrency = domain === 'publishing' ? 'EUR' : 'GBP'
        const formatSummaryAmount = (
          amount: number,
          currencies: string[],
          fallbackCurrency: string
        ) => {
          if (amount === 0 || currencies.length === 0) {
            return new Intl.NumberFormat('en-GB', {
              style: 'currency',
              currency: fallbackCurrency,
              minimumFractionDigits: 2,
              maximumFractionDigits: 2,
            }).format(0)
          }
          const distinctCurrencies = Array.from(new Set(currencies))
          if (distinctCurrencies.length === 1) {
            return new Intl.NumberFormat('en-GB', {
              style: 'currency',
              currency: distinctCurrencies[0],
              minimumFractionDigits: 2,
              maximumFractionDigits: 2,
            }).format(amount)
          }
          return `${amount.toLocaleString('en-GB', { minimumFractionDigits: 2, maximumFractionDigits: 2 })} · mixed currencies`
        }

        const payableRows = records.filter(r => Number(r.payable_amount ?? 0) !== 0)
        const netContributingRows = records.filter(
          r => Number(r.payable_amount ?? 0) !== 0 || Number(r.carry_forward_amount ?? 0) !== 0
        )
        const grossContributingRows = scopedRunRows.filter(row => resolveScopeGross(row) !== 0)
        const unmatchedContributingRows = unmatchedOrErrorRows.filter(row => resolveScopeGross(row) !== 0)
        const payableSub = formatSummaryAmount(
          totalPayable,
          payableRows.map(r => r.statement_currency ?? r.payee?.currency ?? defaultStatementCurrency),
          defaultStatementCurrency
        )
        const netAfterRunValue = formatSummaryAmount(
          totalNetAfterRun,
          netContributingRows.map(r => r.statement_currency ?? r.payee?.currency ?? defaultStatementCurrency),
          defaultStatementCurrency
        )
        const grossInScopeValue = formatSummaryAmount(
          grossInScopeTotal,
          grossContributingRows.map(row => {
            const importSummary = imports.find(item => item.import_id === row.import_id)
            return importSummary?.reporting_currency ?? importSummary?.source_currency ?? defaultStatementCurrency
          }),
          defaultStatementCurrency
        )
        const unmatchedOrErrorValue = formatSummaryAmount(
          unmatchedOrErrorAmount,
          unmatchedContributingRows.map(row => {
            const importSummary = imports.find(item => item.import_id === row.import_id)
            return importSummary?.reporting_currency ?? importSummary?.source_currency ?? defaultStatementCurrency
          }),
          defaultStatementCurrency
        )
        return (
          <div className="grid grid-cols-7 gap-3">
            <StatCard label="Statements" value={records.length} sub={`${domain} · ${selectedPeriod?.label ?? '—'}`} />
            <StatCard label="Payable" value={payableCount} sub={payableSub} color="green" />
            <StatCard
              label="Net After Run"
              value={netAfterRunValue}
              sub="writer net after allocation and deductions, including carry-forward"
              color="blue"
            />
            <StatCard
              label="Gross In Scope"
              value={grossInScopeValue}
              sub={`statement total before contract deductions · ${scopedRunRows.length.toLocaleString()} row(s) in scope`}
              color="cyan"
            />
            <StatCard
              label="Unmatched / Errors"
              value={unmatchedOrErrorValue}
              sub={`${unresolvedTotal.toLocaleString()} live unresolved row(s) across selected imports`}
              color={unresolvedTotal > 0 ? 'amber' : 'default'}
            />
            <StatCard label="Approved" value={approvedCount}
              color={approvedCount === records.length && records.length > 0 ? 'green' : 'default'} />
            <StatCard label="Unresolved Rows" value={unresolvedTotal}
              color={unresolvedTotal > 0 ? 'amber' : 'default'} sub={`matches Sales Errors across ${scopedImports.length} selected import(s)`} />
          </div>
        )
      })()}

      {/* Import summary */}
      {imports.length > 0 && (
        <div className="card">
          <SectionHeader
            title="Source Imports"
            action={domain === 'publishing' ? (
              <button className="btn-ghost btn-sm" style={{ display: 'flex', alignItems: 'center', gap: 5, fontSize: 12 }}
                onClick={() => setShowLinkModal(true)}>
                <Link2 size={12} /> Link Work &#8594; Contract
              </button>
            ) : undefined}
          />
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12, marginBottom: 12, flexWrap: 'wrap' }}>
            <div style={{ fontSize: 12, color: 'var(--ops-muted)' }}>
              {selectedImportIds.length === 0
                ? 'No imports selected'
                : `${selectedImportIds.length} of ${imports.length} import(s) selected for the next run`}
            </div>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              <button className="btn-ghost btn-sm" onClick={selectAllImports} disabled={imports.length === 0 || allVisibleImportsSelected}>
                Select All
              </button>
              <button className="btn-ghost btn-sm" onClick={deselectAllImports} disabled={selectedImportIds.length === 0}>
                Deselect All
              </button>
            </div>
          </div>
          <table className="ops-table">
            <thead>
              <tr>
                <th style={{ width: 36, textAlign: 'center' }}>
                  <input type="checkbox" checked={allVisibleImportsSelected} onChange={() => (allVisibleImportsSelected ? deselectAllImports() : selectAllImports())} />
                </th>
                <th>Type</th><th>Name</th>
                <th>Source currency</th>
                <th>Output (stmt)</th>
                <th style={{ textAlign: 'right' }}>Gross in scope</th>
                <th style={{ textAlign: 'right' }}>Rows</th>
                <th style={{ textAlign: 'right' }}>Matched</th>
                <th style={{ textAlign: 'right' }}>Unresolved</th>
              </tr>
            </thead>
            <tbody>
              {imports.map(imp => {
                // Compute effective output currency using same logic as the run
                const effectiveOutput = outputCurrencyOverride.trim().toUpperCase()
                  || imp.reporting_currency
                  || imp.source_currency
                  || (domain === 'publishing' ? 'EUR' : 'GBP')
                const isOverridden = !!(outputCurrencyOverride.trim() && outputCurrencyOverride.trim().toUpperCase() !== imp.reporting_currency)
                const fallbackReason = !imp.reporting_currency && !imp.exchange_rate
                  ? (imp.source_currency ? 'from source' : 'GBP fallback')
                  : null

                return (
                  <tr key={imp.import_id}>
                    <td style={{ textAlign: 'center' }}>
                      <input
                        type="checkbox"
                        checked={selectedImportIds.includes(imp.import_id)}
                        onChange={() => toggleImportSelection(imp.import_id)}
                      />
                    </td>
                    <td><DomainBadge domain={imp.domain} /></td>
                    <td style={{ fontSize: 13 }}>{(imp as any).source_name ?? imp.import_type}</td>
                    {/* Source currency — what the raw file is in */}
                    <td style={{ fontSize: 12, fontFamily: 'monospace' }}>
                      {imp.source_currency
                        ? <span style={{ color: 'var(--ops-text)' }}>{imp.source_currency}</span>
                        : <span style={{ color: 'var(--ops-subtle)', fontStyle: 'italic' }}>not set</span>}
                      {imp.exchange_rate && (
                        <span style={{ color: 'var(--ops-muted)', marginLeft: 4, fontSize: 10 }}>
                          @ {imp.exchange_rate}
                        </span>
                      )}
                    </td>
                    {/* Output (statement) currency — what the statement will be locked to */}
                    <td style={{ fontSize: 12, fontFamily: 'monospace' }}>
                      <span style={{
                        fontWeight: 700,
                        color: isOverridden
                          ? 'var(--accent-amber)'
                          : imp.exchange_rate
                          ? 'var(--accent-cyan)'
                          : 'var(--ops-text)',
                      }}>
                        {effectiveOutput}
                      </span>
                      {isOverridden && (
                        <span style={{ fontSize: 10, color: 'var(--accent-amber)', marginLeft: 4 }}>overridden</span>
                      )}
                      {!isOverridden && imp.exchange_rate && (
                        <span style={{ fontSize: 10, color: 'var(--ops-subtle)', marginLeft: 4 }}>converted</span>
                      )}
                      {fallbackReason && (
                        <span style={{ fontSize: 10, color: 'var(--ops-subtle)', marginLeft: 4 }}>{fallbackReason}</span>
                      )}
                    </td>
                    <td style={{ textAlign: 'right', fontFamily: 'monospace', fontSize: 12, color: 'var(--accent-cyan)' }}>
                      {(grossByImport.get(imp.import_id) ?? 0).toLocaleString('en-GB', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
                    </td>
                    <td style={{ textAlign: 'right', fontFamily: 'monospace', fontSize: 12 }}>{imp.row_count.toLocaleString()}</td>
                    <td style={{ textAlign: 'right', fontFamily: 'monospace', fontSize: 12, color: 'var(--accent-green)' }}>{imp.success_count.toLocaleString()}</td>
                    <td style={{ textAlign: 'right', fontFamily: 'monospace', fontSize: 12 }}>
                      {imp.unresolved > 0
                        ? <span style={{ color: 'var(--accent-amber)' }}>{imp.unresolved}</span>
                        : <span style={{ color: 'var(--ops-subtle)' }}>0</span>}
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
      )}

      {scopedImports.length > 0 && (
        <div className="card">
          <SectionHeader
            title="Run Scope Preview"
            action={<div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
              <span style={{ fontSize: 12, color: 'var(--ops-muted)' }}>
                Showing {totalScopePreviewRows === 0 ? 0 : scopePreviewStart + 1}-{scopePreviewEnd} of {totalScopePreviewRows.toLocaleString()} row(s) in scope
              </span>
              <button className="btn-ghost btn-sm" onClick={() => setShowScopePreview(prev => !prev)}>
                {showScopePreview ? 'Collapse' : 'Expand'}
              </button>
            </div>}
          />
          {showScopePreview && (
            <>
          <div style={{ fontSize: 12, color: 'var(--ops-muted)', marginBottom: 12 }}>
            Search filters the selected imports live. Runs only include the selected imports listed above. The preview is paged, but the statement run fetches the full scoped row set.
          </div>
          <div style={{ maxHeight: 420, overflow: 'auto', border: '1px solid var(--ops-border)', borderRadius: 8 }}>
            <table className="ops-table" style={{ margin: 0 }}>
              <thead style={{ position: 'sticky', top: 0, zIndex: 1 }}>
                <tr>
                  <th>Import</th>
                  <th>Row</th>
                  <th>Work Title</th>
                  <th>Writer</th>
                  <th>Tempo ID / ISWC</th>
                  <th>Income Type</th>
                  <th style={{ textAlign: 'right' }}>Amount</th>
                  <th>Status</th>
                </tr>
              </thead>
              <tbody>
                {scopeRowsLoading ? (
                  <tr>
                    <td colSpan={8}>
                      <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '8px 0', color: 'var(--ops-muted)' }}>
                        <LoadingSpinner size={13} /> Loading scoped rows…
                      </div>
                    </td>
                  </tr>
                ) : groupedScopeRows.length === 0 ? (
                  <tr>
                    <td colSpan={8} style={{ color: 'var(--ops-muted)' }}>
                      {selectedImportIds.length === 0 ? 'Select one or more imports to preview the run scope.' : 'No rows match the current search.'}
                    </td>
                  </tr>
                ) : (
                  groupedScopeRows.map(group => (
                    group.rows.map((row, idx) => (
                      <tr key={row.id} style={idx === 0 ? { borderTop: '1px solid rgba(255,255,255,0.08)' } : undefined}>
                        <td style={{ verticalAlign: 'top' }}>
                          {idx === 0 ? (
                            <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
                              <span style={{ fontSize: 12, fontWeight: 600, color: 'var(--ops-text)' }}>{group.importName}</span>
                              <span style={{ fontSize: 10, color: 'var(--ops-subtle)', fontFamily: 'monospace' }}>{group.importId.slice(0, 8)}</span>
                            </div>
                          ) : (
                            <span style={{ color: 'var(--ops-subtle)' }}>↳</span>
                          )}
                        </td>
                        <td style={{ fontFamily: 'monospace', fontSize: 12 }}>{row.raw_row_number ?? '—'}</td>
                        <td style={{ maxWidth: 240 }}>
                          <div style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', color: 'var(--ops-text)' }}>
                            {row.title_raw ?? '—'}
                          </div>
                        </td>
                        <td style={{ maxWidth: 200 }}>
                          <div style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', color: 'var(--ops-muted)' }}>
                            {row.artist_name_raw ?? '—'}
                          </div>
                        </td>
                        <td style={{ fontFamily: 'monospace', fontSize: 12 }}>{row.tempo_id ?? row.identifier_raw ?? '—'}</td>
                        <td style={{ fontSize: 12 }}>{row.income_type ?? '—'}</td>
                        <td style={{ textAlign: 'right', fontFamily: 'monospace', fontSize: 12 }}>
                          {typeof row.amount === 'number' ? `${row.amount.toFixed(2)} ${row.currency ?? ''}`.trim() : '—'}
                        </td>
                        <td style={{ fontSize: 12 }}>
                          {row.match_status === 'matched'
                            ? <span style={{ color: 'var(--accent-green)' }}>Matched</span>
                            : row.match_status === 'partial'
                            ? <span style={{ color: 'var(--accent-amber)' }}>Partial</span>
                            : <span style={{ color: 'var(--accent-red)' }}>{row.match_status ?? 'unmatched'}</span>}
                        </td>
                      </tr>
                    ))
                  ))
                )}
              </tbody>
            </table>
          </div>
          <div style={{ marginTop: 10, display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8 }}>
            <div style={{ fontSize: 11, color: 'var(--ops-subtle)' }}>
              Page {safeScopePreviewPage} of {totalScopePreviewPages} · showing {visibleScopeRows.length.toLocaleString()} visible row(s)
            </div>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              <button
                className="btn-ghost btn-sm"
                disabled={safeScopePreviewPage <= 1}
                onClick={() => setScopePreviewPage(prev => Math.max(1, prev - 1))}
              >
                Previous
              </button>
              <button
                className="btn-ghost btn-sm"
                disabled={safeScopePreviewPage >= totalScopePreviewPages}
                onClick={() => setScopePreviewPage(prev => Math.min(totalScopePreviewPages, prev + 1))}
              >
                Next
              </button>
            </div>
          </div>
          <div style={{ marginTop: 10, fontSize: 11, color: 'var(--ops-subtle)' }}>
            Preview rows are always fetched from the current selected imports, never the full period.
          </div>
            </>
          )}
        </div>
      )}

      {/* Statement records */}
      {records.length === 0 ? (
        <EmptyState icon={PlayCircle} title="No statement records"
          description={`No ${domain} statements for this period yet. Run statements above to generate them.`} />
      ) : (
        <div className="card">
          <SectionHeader
            title={`${domain.charAt(0).toUpperCase() + domain.slice(1)} Statements`}
            action={
              <label style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 12, color: 'var(--ops-muted)' }}>
                <input type="checkbox" checked={allVisibleRecordsSelected} onChange={toggleAllVisibleRecords} />
                {visibleRecords.length} record{visibleRecords.length !== 1 ? 's' : ''}
              </label>
            }
          />
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, margin: '0 4px 12px', flexWrap: 'wrap' }}>
            <select style={iStyle} value={statementSort} onChange={e => setStatementSort(e.target.value as any)}>
              <option value="az">A–Z</option>
              <option value="za">Z–A</option>
              <option value="highest_payable">Highest payable</option>
              <option value="lowest_payable">Lowest payable</option>
            </select>
            <select style={iStyle} value={recoupFilter} onChange={e => setRecoupFilter(e.target.value as any)}>
              <option value="">All recoup states</option>
              <option value="recouped">Recouped</option>
              <option value="unrecouped">Unrecouped</option>
            </select>
          </div>
          {someRecordsSelected && (
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12, margin: '0 4px 12px', padding: '10px 12px', border: '1px solid var(--ops-border)', borderRadius: 8, background: 'var(--ops-surface-2)' }}>
              <label style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 12, color: 'var(--ops-text)' }}>
                <input type="checkbox" checked={allVisibleRecordsSelected} onChange={toggleAllVisibleRecords} />
                {selectedRecordIds.size} selected
              </label>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                <button className="btn-ghost btn-sm" onClick={() => setSelectedRecordIds(new Set())}>Clear</button>
                <button className="btn-secondary btn-sm" onClick={() => { void downloadSelectedStatementsZip() }} disabled={saving === '__bulk_download__'}>
                  {saving === '__bulk_download__' ? <LoadingSpinner size={11} /> : <><Download size={12} /> Download Selected (ZIP)</>}
                </button>
                <button className="btn-ghost btn-sm" style={{ color: 'var(--accent-red)' }} onClick={deleteSelectedRecords} disabled={saving === '__bulk_delete__'}>
                  {saving === '__bulk_delete__' ? <LoadingSpinner size={11} /> : 'Delete selected'}
                </button>
              </div>
            </div>
          )}
          <div style={{ display: 'flex', flexDirection: 'column', gap: 4, padding: '0 4px 4px' }}>
            {visibleRecords.map(rec => {
              const isExpanded = expandedId === rec.id
              const isSaving   = saving === rec.id
              const isSelected = selectedRecordIds.has(rec.id)
              const isHighlighted = highlightedRecordIds.has(rec.id)

              return (
                <div key={rec.id} style={{
                  borderRadius: 6,
                  border: `1px solid ${isHighlighted ? 'rgba(34,197,94,0.35)' : 'var(--ops-border)'}`,
                  background: isSelected
                    ? 'color-mix(in srgb, var(--accent-blue) 6%, var(--ops-surface))'
                    : isHighlighted
                    ? 'color-mix(in srgb, rgba(34,197,94,0.1) 65%, var(--ops-surface))'
                    : 'var(--ops-surface)',
                }}>

                  {/* Collapsed row */}
                  <div style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '8px 12px', cursor: 'pointer', userSelect: 'none' }}
                    onClick={() => setExpandedId(isExpanded ? null : rec.id)}>
                    <div onClick={e => e.stopPropagation()} style={{ flexShrink: 0 }}>
                      <input type="checkbox" checked={isSelected} onChange={() => toggleRecordSelection(rec.id)} />
                    </div>
                    <div style={{ flexShrink: 0, color: 'var(--ops-muted)' }}>
                      {isExpanded ? <ChevronDown size={13} /> : <ChevronRight size={13} />}
                    </div>
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <div style={{ fontSize: 13, fontWeight: 500, color: 'var(--ops-text)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                        {rec.payee?.payee_name ?? rec.payee_id}
                      </div>
                      <div style={{ fontSize: 12, color: 'var(--ops-muted)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                        {rec.contract?.contract_code ? `${rec.contract.contract_code} · ` : ''}
                        {rec.contract?.contract_name ?? rec.contract_id}
                      </div>
                    </div>
                    <div style={{ textAlign: 'right', minWidth: 90 }}>
                      <Amount value={rec.final_balance_after_carryover} currency={rec.statement_currency ?? rec.payee?.currency ?? 'GBP'} size="normal" />
                      {/* Currency badge — shows the locked statement currency, not the payee default */}
                      <div style={{ fontSize: 10, fontFamily: 'monospace', color: rec.exchange_rate_snapshot ? 'var(--accent-cyan)' : 'var(--ops-subtle)', marginTop: 1 }}>
                        {rec.statement_currency ?? rec.payee?.currency ?? 'GBP'}
                        {rec.exchange_rate_snapshot ? ` (FX ${rec.exchange_rate_snapshot})` : ''}
                      </div>
                    </div>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexShrink: 0 }}>
                      <PayableBadge record={rec} />
                      <ApprovalBadge status={rec.approval_status} />
                      {calcStatusBadge(rec.calculation_status)}
                    </div>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 4, flexShrink: 0 }}>
                      {rec.balance_confirmed_flag
                        ? <CheckCircle size={12} style={{ color: 'var(--accent-green)' }} />
                        : <AlertTriangle size={12} style={{ color: 'var(--accent-amber)' }} />}
                      {rec.carryover_confirmed_flag
                        ? <CheckCircle size={12} style={{ color: 'var(--accent-green)' }} />
                        : <AlertTriangle size={12} style={{ color: 'var(--accent-amber)' }} />}
                    </div>
                    {rec.approval_status === 'pending' && (
                      <button className="btn-sm btn-secondary" style={{ flexShrink: 0 }} disabled={isSaving}
                        onClick={e => { e.stopPropagation(); updateApproval(rec.id, 'approved') }}>
                        {isSaving ? <LoadingSpinner size={11} /> : 'Approve'}
                      </button>
                    )}
                  </div>

                  {/* Expanded */}
                  {isExpanded && (
                    <div style={{ borderTop: '1px solid var(--ops-border)', padding: 16, display: 'flex', flexDirection: 'column', gap: 16 }}>

                      {/* Balance chain */}
                      <div>
                        <p style={{ fontSize: 11, fontWeight: 600, color: 'var(--ops-muted)', textTransform: 'uppercase', letterSpacing: '0.06em', marginBottom: 8 }}>Balance Chain</p>
                        <div style={{ display: 'flex', flexDirection: 'column', gap: 4, fontFamily: 'monospace', fontSize: 12 }}>
                          {([
                            ['Opening Balance',         rec.opening_balance,                'always 0 (Approach B)'],
                            ['Current Earnings',        rec.current_earnings,               null],
                            ['Deductions',              -rec.deductions,                    null],
                            ['Closing (pre-carryover)', rec.closing_balance_pre_carryover,  null],
                            ['Prior Period Carryover',  rec.prior_period_carryover_applied, null],
                            ['Final Balance',           rec.final_balance_after_carryover,  null],
                            ['Payable Amount',          rec.payable_amount,                 null],
                            ['Carry Forward',           rec.carry_forward_amount,           null],
                          ] as [string, number, string | null][]).map(([label, val, note]) => (
                            <div key={label} style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
                              <span style={{ color: 'var(--ops-muted)' }}>{label}</span>
                              <span style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                                {note && <span style={{ fontSize: 10, color: 'var(--ops-subtle)' }}>{note}</span>}
                                <Amount value={val} currency={rec.statement_currency ?? rec.payee?.currency ?? 'GBP'} size="small" />
                              </span>
                            </div>
                          ))}
                        </div>
                      </div>

                      {/* Meta */}
                      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: 12, fontSize: 12 }}>
                        <div>
                          <span style={{ color: 'var(--ops-muted)' }}>Statement Currency: </span>
                          <span style={{ fontFamily: 'monospace', fontWeight: 600, color: rec.exchange_rate_snapshot ? 'var(--accent-cyan)' : 'var(--ops-text)' }}>
                            {rec.statement_currency ?? rec.payee?.currency ?? 'GBP'}
                          </span>
                          {rec.exchange_rate_snapshot && (
                            <span style={{ color: 'var(--ops-muted)', fontSize: 11, marginLeft: 4 }}>
                              (FX @ {rec.exchange_rate_snapshot})
                            </span>
                          )}
                        </div>
                        <div><span style={{ color: 'var(--ops-muted)' }}>Royalty Share: </span><span style={{ fontFamily: 'monospace' }}>{fmtShare(rec.royalty_share_snapshot)}</span></div>
                        <div><span style={{ color: 'var(--ops-muted)' }}>Hold Flag: </span><span>{rec.hold_payment_flag ? '⚠ Yes' : 'No'}</span></div>
                        <div><span style={{ color: 'var(--ops-muted)' }}>Email: </span>
                          {rec.payee?.primary_email
                            ? <span>{rec.payee.primary_email}</span>
                            : <span style={{ color: 'var(--accent-red)' }}>missing</span>}
                        </div>
                      </div>

                      {/* Actions */}
                      <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
                        {!rec.balance_confirmed_flag && (
                          <button className="btn-sm btn-secondary" disabled={isSaving} onClick={() => confirmBalance(rec.id)}
                            style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
                            <CheckCircle size={12} /> Confirm Balance
                          </button>
                        )}
                        {!rec.carryover_confirmed_flag && (
                          <button className="btn-sm btn-secondary" disabled={isSaving} onClick={() => confirmCarryover(rec.id)}
                            style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
                            <CheckCircle size={12} /> Confirm Carryover
                          </button>
                        )}
                        {rec.approval_status === 'pending' && (
                          <button className="btn-sm btn-primary" disabled={isSaving} onClick={() => updateApproval(rec.id, 'approved')}
                            style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
                            {isSaving ? <LoadingSpinner size={11} /> : <><Lock size={11} /> Approve</>}
                          </button>
                        )}
                        {rec.approval_status === 'approved' && (
                          <button className="btn-sm btn-ghost" disabled={isSaving} onClick={() => updateApproval(rec.id, 'pending')}
                            style={{ display: 'flex', alignItems: 'center', gap: 4, color: 'var(--accent-amber)' }}>
                            <Unlock size={11} /> Un-approve
                          </button>
                        )}
                        {rec.approval_status !== 'on_hold' && (
                          <button className="btn-sm btn-ghost" disabled={isSaving} onClick={() => updateApproval(rec.id, 'on_hold')}>Hold</button>
                        )}
                        {/* Task 1 FIX: route to /statements/[id] using the statement record id.
                            Previously routed to /statements?contract=...&payee=...&period=...
                            which went to the list page, not the detail view. */}
                        <Link href={`/statements/${rec.id}?returnTo=${encodeURIComponent(statementViewReturnTo)}`}
                          className="btn-sm btn-ghost" style={{ marginLeft: 'auto' }}>
                          View Statement →
                        </Link>
                        {/* Req 5: delete single record */}
                        <button className="btn-sm btn-ghost" disabled={isSaving}
                          onClick={e => { e.stopPropagation(); deleteRecord(rec.id) }}
                          style={{ color: 'var(--accent-red)', display: 'flex', alignItems: 'center', gap: 4 }}>
                          Delete
                        </button>
                      </div>
                    </div>
                  )}
                </div>
              )
            })}
          </div>
        </div>
      )}

      {showContractForm && (
        <ContractFormModal
          sendingParties={sendingParties}
          onClose={() => setShowContractForm(false)}
          onSaved={nc => {
            setContracts(cs => sortByLabel([...cs.filter(c => c.id !== nc.id), nc], contract => `${contract.contract_name}${contract.contract_code ? ` (${contract.contract_code})` : ''}`))
            setShowContractForm(false)
          }}
        />
      )}

      {showLinkModal && (
        <LinkWorkModal
          onClose={() => setShowLinkModal(false)}
          onSaved={() => {
            void loadReferenceData()
            void loadImports()
            void loadScopeRows()
          }}
        />
      )}
    </div>
  )
}
