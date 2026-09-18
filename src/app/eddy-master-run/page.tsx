'use client'

import { useEffect, useMemo, useRef, useState } from 'react'
import Papa from 'papaparse'
import {
  ChevronDown, ChevronRight, Clipboard, FileSpreadsheet, Mail,
  Plus, RefreshCw, Save, Search, Trash2, Upload, X,
} from 'lucide-react'
import { supabase } from '@/lib/supabase/client'
import { useAuth } from '@/lib/auth/AuthContext'
import { Alert, EmptyState, LoadingSpinner, StatCard } from '@/components/ui'
import type {
  EddyMasterRun, EddyMasterRunArtist, EddyMasterRunStatus,
  EddyMasterStatement, Payee, PayeeAlias, StatementPeriod,
} from '@/lib/types'
import {
  automaticallyMatchEddyPayee,
  findDuplicateEddyRunPayee,
  normalizeEddyPayeeName,
  searchEddyPayees,
} from '@/lib/utils/eddyPayeeMatching'

type RunWithPeriod = EddyMasterRun & { statement_period: StatementPeriod }
type ArtistRow = EddyMasterRunArtist & {
  payee: Payee | null
  statements: EddyMasterStatement[]
}
type ImportMapping = {
  artist: string
  carryover: string
  email: string
  sourcePeriod: string
}
type ImportPreviewRow = {
  rowNumber: number
  artistName: string
  normalizedName: string
  carryover: number | null
  email: string
  sourcePeriod: string
  matchedPayee: Payee | null
  matchMethod: 'automatic' | 'manual' | null
  issue: string | null
  duplicateIssue: string | null
}

type EddyStatementCsvRow = {
  rowNumber: number
  periodRef: string
  contractName: string
  contractId: string
  payeeName: string
  eddyPayeeId: string
  statementId: string
  finalDue: number | null
}

type EddyStatementImportGroup = {
  key: string
  payeeName: string
  normalizedPayeeName: string
  eddyPayeeId: string
  matchedPayee: Payee | null
  matchMethod: 'automatic' | 'manual' | null
  existingArtist: ArtistRow | null
  statements: EddyStatementCsvRow[]
  issue: string | null
}

type PayeeMatchTarget =
  | { kind: 'preview'; rowNumber: number; importedName: string }
  | { kind: 'artist'; artistId: string; importedName: string }
  | { kind: 'statementPreview'; groupKey: string; importedName: string }

const STATUS_OPTIONS: { value: EddyMasterRunStatus; label: string }[] = [
  { value: 'to_prepare', label: 'To Prepare' },
  { value: 'ready', label: 'Ready' },
  { value: 'sent', label: 'Sent' },
  { value: 'carry_forward', label: 'Carry Forward' },
]

const EDDY_PAYMENT_THRESHOLD = 100

function cleanText(value: unknown) {
  return String(value ?? '').trim().replace(/\s+/g, ' ')
}

function parseAmount(value: unknown): number | null {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null
  const raw = String(value ?? '').trim()
  if (!raw) return null
  const negative = /^\(.*\)$/.test(raw)
  const numeric = Number(raw.replace(/[£€$(),\s]/g, '').replace(/,/g, ''))
  if (!Number.isFinite(numeric)) return null
  return negative ? -numeric : numeric
}

function eddyOpeningCarryover(sourceFinalBalance: number) {
  return sourceFinalBalance > EDDY_PAYMENT_THRESHOLD ? 0 : sourceFinalBalance
}

function formatMoney(value: number, currency: string) {
  const formatted = new Intl.NumberFormat('en-GB', {
    style: 'currency',
    currency,
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(Math.abs(value))
  return value < 0 ? `(${formatted})` : formatted
}

function displayPayeeName(payee: Payee) {
  return payee.display_name?.trim() || payee.statement_name?.trim() || payee.payee_name
}

function statusBadge(status: EddyMasterRunStatus) {
  const meta: Record<EddyMasterRunStatus, { label: string; className: string }> = {
    to_prepare: { label: 'To Prepare', className: 'badge-pending' },
    ready: { label: 'Ready', className: 'badge-info' },
    sent: { label: 'Sent', className: 'badge-sent' },
    carry_forward: { label: 'Carry Forward', className: 'badge-warning' },
  }
  return <span className={meta[status].className}>{meta[status].label}</span>
}

export default function EddyMasterRunPage() {
  const { user } = useAuth()
  const fileRef = useRef<HTMLInputElement>(null)
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const [periods, setPeriods] = useState<StatementPeriod[]>([])
  const [payees, setPayees] = useState<Payee[]>([])
  const [aliases, setAliases] = useState<PayeeAlias[]>([])
  const [runs, setRuns] = useState<RunWithPeriod[]>([])
  const [selectedRunId, setSelectedRunId] = useState('')
  const [artists, setArtists] = useState<ArtistRow[]>([])
  const [expandedArtistId, setExpandedArtistId] = useState<string | null>(null)

  const [showCreateRun, setShowCreateRun] = useState(false)
  const [newRunPeriodId, setNewRunPeriodId] = useState('')
  const [newRunCurrency, setNewRunCurrency] = useState('GBP')
  const [showAddArtist, setShowAddArtist] = useState(false)
  const [artistDraft, setArtistDraft] = useState({ payeeId: '', name: '', email: '', previousCarryover: '0' })
  const [statementDraft, setStatementDraft] = useState({ label: '', amount: '', reference: '' })
  const [artistEdit, setArtistEdit] = useState({ name: '', email: '', previousCarryover: '' })

  const [emailArtist, setEmailArtist] = useState<ArtistRow | null>(null)
  const [emailSubject, setEmailSubject] = useState('')
  const [emailBody, setEmailBody] = useState('')
  const [copied, setCopied] = useState(false)

  const [showImport, setShowImport] = useState(false)
  const [importStep, setImportStep] = useState<'upload' | 'map' | 'preview'>('upload')
  const [importFileName, setImportFileName] = useState('')
  const [importHeaders, setImportHeaders] = useState<string[]>([])
  const [importRows, setImportRows] = useState<Record<string, unknown>[]>([])
  const [importMapping, setImportMapping] = useState<ImportMapping>({ artist: '', carryover: '', email: '', sourcePeriod: '' })
  const [importPreview, setImportPreview] = useState<ImportPreviewRow[]>([])
  const statementFileRef = useRef<HTMLInputElement>(null)
  const [showStatementImport, setShowStatementImport] = useState(false)
  const [statementImportStep, setStatementImportStep] = useState<'upload' | 'period' | 'preview'>('upload')
  const [statementImportFileName, setStatementImportFileName] = useState('')
  const [statementCsvRows, setStatementCsvRows] = useState<EddyStatementCsvRow[]>([])
  const [statementPeriods, setStatementPeriods] = useState<{ periodRef: string; rowCount: number }[]>([])
  const [selectedStatementPeriod, setSelectedStatementPeriod] = useState('')
  const [statementImportGroups, setStatementImportGroups] = useState<EddyStatementImportGroup[]>([])
  const [expandedStatementGroup, setExpandedStatementGroup] = useState<string | null>(null)
  const [payeeMatchTarget, setPayeeMatchTarget] = useState<PayeeMatchTarget | null>(null)
  const [payeeSearch, setPayeeSearch] = useState('')
  const [selectedMatchPayeeId, setSelectedMatchPayeeId] = useState('')
  const [payeeMatchError, setPayeeMatchError] = useState<string | null>(null)

  const selectedRun = runs.find(run => run.id === selectedRunId) ?? null
  const payeeSearchResults = useMemo(
    () => searchEddyPayees(payeeSearch, payees, aliases),
    [payeeSearch, payees, aliases],
  )

  useEffect(() => { void loadBase() }, [])
  useEffect(() => {
    if (selectedRunId) void loadArtists(selectedRunId)
    else setArtists([])
  }, [selectedRunId])

  async function loadBase() {
    setLoading(true)
    setError(null)
    const [periodRes, payeeRes, aliasRes, runRes] = await Promise.all([
      supabase.from('statement_periods').select('*').order('year', { ascending: false }).order('half', { ascending: false }),
      supabase.from('payees').select('*').order('payee_name'),
      supabase.from('payee_aliases').select('*').eq('is_active', true),
      supabase.from('eddy_master_runs').select('*, statement_period:statement_periods(*)').order('created_at', { ascending: false }),
    ])
    if (runRes.error) {
      setError(`${runRes.error.message}. Run migration 007_eddy_master_runs.sql before using this section.`)
    }
    const nextPeriods = (periodRes.data ?? []) as StatementPeriod[]
    const nextRuns = (runRes.data ?? []) as unknown as RunWithPeriod[]
    setPeriods(nextPeriods)
    setPayees((payeeRes.data ?? []) as Payee[])
    setAliases((aliasRes.data ?? []) as PayeeAlias[])
    setRuns(nextRuns)
    setSelectedRunId(current => current && nextRuns.some(run => run.id === current) ? current : nextRuns[0]?.id ?? '')
    const unusedPeriod = nextPeriods.find(period => !nextRuns.some(run => run.statement_period_id === period.id))
    setNewRunPeriodId(unusedPeriod?.id ?? '')
    setLoading(false)
  }

  async function loadArtists(runId: string) {
    setError(null)
    const artistRes = await supabase
      .from('eddy_master_run_artists')
      .select('*, payee:payees(*)')
      .eq('run_id', runId)
      .order('artist_name')
    if (artistRes.error) {
      setError(artistRes.error.message)
      return
    }
    const base = (artistRes.data ?? []) as unknown as (EddyMasterRunArtist & { payee: Payee | null })[]
    let statements: EddyMasterStatement[] = []
    const ids = base.map(artist => artist.id)
    if (ids.length > 0) {
      const freshStatements = await supabase.from('eddy_master_statements').select('*').in('run_artist_id', ids).order('created_at')
      if (freshStatements.error) setError(freshStatements.error.message)
      statements = (freshStatements.data ?? []) as EddyMasterStatement[]
    } else {
      statements = []
    }
    setArtists(base.map(artist => ({
      ...artist,
      previous_carryover: Number(artist.previous_carryover ?? 0),
      imported_final_balance: artist.imported_final_balance === null
        ? null
        : Number(artist.imported_final_balance),
      statements: statements.filter(statement => statement.run_artist_id === artist.id).map(statement => ({
        ...statement,
        amount: Number(statement.amount ?? 0),
      })),
    })))
  }

  function artistTotal(artist: ArtistRow) {
    return artist.statements.reduce((sum, statement) => sum + Number(statement.amount ?? 0), 0)
  }

  function amountDue(artist: ArtistRow) {
    return artistTotal(artist) + Number(artist.previous_carryover ?? 0)
  }

  const summary = useMemo(() => ({
    artistCount: artists.length,
    statementCount: artists.reduce((sum, artist) => sum + artist.statements.length, 0),
    statementValue: artists.reduce((sum, artist) => sum + artistTotal(artist), 0),
    openingCarryover: artists.reduce((sum, artist) => sum + Number(artist.previous_carryover ?? 0), 0),
    amountDue: artists.reduce((sum, artist) => sum + amountDue(artist), 0),
    ready: artists.filter(artist => artist.status === 'ready').length,
    sent: artists.filter(artist => artist.status === 'sent').length,
    carryForward: artists.filter(artist => artist.status === 'carry_forward').length,
  }), [artists])

  async function createRun() {
    if (!newRunPeriodId) return
    setSaving(true)
    setError(null)
    const { data, error: createError } = await supabase.from('eddy_master_runs').insert({
      statement_period_id: newRunPeriodId,
      currency: newRunCurrency.trim().toUpperCase() || 'GBP',
      created_by: user?.id ?? null,
    }).select('*, statement_period:statement_periods(*)').single()
    setSaving(false)
    if (createError) {
      setError(createError.code === '23505' ? 'An Eddy Master Run already exists for that period.' : createError.message)
      return
    }
    setShowCreateRun(false)
    await loadBase()
    setSelectedRunId(data.id)
  }

  async function findLatestCarryover(payeeId: string, artistName: string) {
    if (!selectedRun) return null
    const priorRunIds = runs
      .filter(run => run.id !== selectedRun.id && run.statement_period.period_end < selectedRun.statement_period.period_start)
      .sort((a, b) => b.statement_period.period_end.localeCompare(a.statement_period.period_end))
      .map(run => run.id)
    if (!priorRunIds.length) return null
    let query = supabase.from('eddy_master_run_artists').select('*').in('run_id', priorRunIds).eq('status', 'carry_forward')
    query = payeeId ? query.eq('payee_id', payeeId) : query.eq('normalized_artist_name', normalizeEddyPayeeName(artistName))
    const { data } = await query
    const candidates = (data ?? []) as EddyMasterRunArtist[]
    const latest = priorRunIds.map(id => candidates.find(row => row.run_id === id)).find(Boolean)
    if (!latest) return null
    const { data: entries } = await supabase.from('eddy_master_statements').select('amount').eq('run_artist_id', latest.id)
    const total = (entries ?? []).reduce((sum, entry) => sum + Number(entry.amount ?? 0), Number(latest.previous_carryover ?? 0))
    return { amount: eddyOpeningCarryover(total), sourceArtistId: latest.id }
  }

  async function selectPayeeForArtist(payeeId: string) {
    const payee = payees.find(item => item.id === payeeId)
    if (!payee) {
      setArtistDraft(draft => ({ ...draft, payeeId }))
      return
    }
    const name = displayPayeeName(payee)
    const prior = await findLatestCarryover(payee.id, name)
    setArtistDraft({
      payeeId,
      name,
      email: payee.primary_email ?? '',
      previousCarryover: String(prior?.amount ?? 0),
    })
  }

  async function addArtist() {
    if (!selectedRun || !artistDraft.name.trim()) return
    setSaving(true)
    setError(null)
    const prior = await findLatestCarryover(artistDraft.payeeId, artistDraft.name)
    const { error: insertError } = await supabase.from('eddy_master_run_artists').insert({
      run_id: selectedRun.id,
      payee_id: artistDraft.payeeId || null,
      artist_name: cleanText(artistDraft.name),
      normalized_artist_name: normalizeEddyPayeeName(artistDraft.name),
      email: artistDraft.email.trim() || null,
      previous_carryover: parseAmount(artistDraft.previousCarryover) ?? 0,
      carryover_source_artist_id: prior?.sourceArtistId ?? null,
    })
    setSaving(false)
    if (insertError) {
      setError(insertError.code === '23505' ? 'That artist is already in this run.' : insertError.message)
      return
    }
    setArtistDraft({ payeeId: '', name: '', email: '', previousCarryover: '0' })
    setShowAddArtist(false)
    await loadArtists(selectedRun.id)
  }

  function expandArtist(artist: ArtistRow) {
    const next = expandedArtistId === artist.id ? null : artist.id
    setExpandedArtistId(next)
    if (next) {
      setArtistEdit({
        name: artist.artist_name,
        email: artist.email ?? '',
        previousCarryover: String(artist.previous_carryover ?? 0),
      })
      setStatementDraft({ label: '', amount: '', reference: '' })
    }
  }

  async function saveArtist(artist: ArtistRow) {
    if (!artistEdit.name.trim()) return
    setSaving(true)
    const { error: updateError } = await supabase.from('eddy_master_run_artists').update({
      artist_name: cleanText(artistEdit.name),
      normalized_artist_name: normalizeEddyPayeeName(artistEdit.name),
      email: artistEdit.email.trim() || null,
      previous_carryover: parseAmount(artistEdit.previousCarryover) ?? 0,
    }).eq('id', artist.id)
    setSaving(false)
    if (updateError) setError(updateError.message)
    else if (selectedRun) await loadArtists(selectedRun.id)
  }

  async function deleteArtist(artist: ArtistRow) {
    if (!confirm(`Remove ${artist.artist_name} and all Eddy statement entries from this run?`)) return
    const { error: deleteError } = await supabase.from('eddy_master_run_artists').delete().eq('id', artist.id)
    if (deleteError) setError(deleteError.message)
    else if (selectedRun) await loadArtists(selectedRun.id)
  }

  async function addStatement(artistId: string) {
    const amount = parseAmount(statementDraft.amount)
    if (!statementDraft.label.trim() || amount === null) {
      setError('Statement label and a valid amount are required.')
      return
    }
    setSaving(true)
    const { error: insertError } = await supabase.from('eddy_master_statements').insert({
      run_artist_id: artistId,
      statement_label: statementDraft.label.trim(),
      amount,
      file_reference: statementDraft.reference.trim() || null,
    })
    setSaving(false)
    if (insertError) setError(insertError.message)
    else if (selectedRun) {
      setStatementDraft({ label: '', amount: '', reference: '' })
      await loadArtists(selectedRun.id)
    }
  }

  async function deleteStatement(statementId: string) {
    if (!confirm('Remove this Eddy statement entry?')) return
    const { error: deleteError } = await supabase.from('eddy_master_statements').delete().eq('id', statementId)
    if (deleteError) setError(deleteError.message)
    else if (selectedRun) await loadArtists(selectedRun.id)
  }

  async function setStatus(artist: ArtistRow, status: EddyMasterRunStatus) {
    const { error: updateError } = await supabase.from('eddy_master_run_artists').update({
      status,
      sent_at: status === 'sent' ? new Date().toISOString() : null,
    }).eq('id', artist.id)
    if (updateError) setError(updateError.message)
    else if (selectedRun) await loadArtists(selectedRun.id)
  }

  function generateEmail(artist: ArtistRow) {
    if (!selectedRun) return { subject: '', body: '' }
    const count = artist.statements.length
    const period = selectedRun.statement_period.label
    const currency = selectedRun.currency
    const due = amountDue(artist)
    const greeting = artist.payee?.primary_contact_name?.trim().split(/\s+/)[0]
      || artist.artist_name.trim().split(/\s+/)[0]
      || artist.artist_name
    const attachmentLine = `${count} Eddy master statement${count === 1 ? '' : 's'}`
    const closing = artist.status === 'carry_forward' || due <= 0
      ? 'This balance will be carried forward to your next Eddy master run.'
      : `Please send your invoice for ${formatMoney(due, currency)} using the usual process.`
    return {
      subject: `${artist.artist_name} - Eddy Master Statements - ${period}`,
      body: `Dear ${greeting},\n\nPlease find your ${attachmentLine} for ${period} attached.\n\nEddy statement total: ${formatMoney(artistTotal(artist), currency)}\nPrevious carryover: ${formatMoney(Number(artist.previous_carryover ?? 0), currency)}\nTotal amount due: ${formatMoney(due, currency)}\n\n${closing}`,
    }
  }

  function openEmail(artist: ArtistRow) {
    const generated = generateEmail(artist)
    setEmailArtist(artist)
    setEmailSubject(artist.email_subject ?? generated.subject)
    setEmailBody(artist.email_body ?? generated.body)
    setCopied(false)
  }

  async function saveEmail() {
    if (!emailArtist) return
    setSaving(true)
    const preserveFinalStatus = emailArtist.status === 'sent' || emailArtist.status === 'carry_forward'
    const { error: updateError } = await supabase.from('eddy_master_run_artists').update({
      email_subject: emailSubject,
      email_body: emailBody,
      email_prepared_at: new Date().toISOString(),
      status: preserveFinalStatus ? emailArtist.status : 'ready',
    }).eq('id', emailArtist.id)
    setSaving(false)
    if (updateError) setError(updateError.message)
    else {
      setEmailArtist(null)
      if (selectedRun) await loadArtists(selectedRun.id)
    }
  }

  async function copyEmail() {
    await navigator.clipboard.writeText(`Subject: ${emailSubject}\n\n${emailBody}`)
    setCopied(true)
  }

  function validatePreviewDuplicates(rows: ImportPreviewRow[]) {
    const next = rows.map(row => ({ ...row, duplicateIssue: null }))
    const groups = new Map<string, ImportPreviewRow[]>()
    next.forEach(row => {
      if (!row.normalizedName) return
      const key = row.matchedPayee ? `payee:${row.matchedPayee.id}` : `name:${row.normalizedName}`
      groups.set(key, [...(groups.get(key) ?? []), row])
    })
    groups.forEach(group => {
      if (group.length < 2) return
      const values = new Set(group.map(row => row.carryover).filter(value => value !== null))
      if (values.size > 1) {
        group.forEach(row => { row.duplicateIssue = 'Duplicate payee has conflicting carryover values' })
        return
      }
      group.slice(1).forEach(row => {
        row.duplicateIssue = `Duplicate of row ${group[0].rowNumber}; this row will not import`
      })
    })
    return next
  }

  function resolveStatementRunArtist(payeeName: string, matchedPayee: Payee | null) {
    const normalized = normalizeEddyPayeeName(payeeName)
    const byPayee = matchedPayee ? artists.find(artist => artist.payee_id === matchedPayee.id) ?? null : null
    const byName = artists.find(artist =>
      artist.normalized_artist_name === normalized
      || normalizeEddyPayeeName(artist.imported_artist_name || artist.artist_name) === normalized
    ) ?? null
    if (byPayee && byName && byPayee.id !== byName.id) {
      return {
        artist: null,
        issue: 'Matched payee and Eddy payee name already exist as separate artists in this run',
      }
    }
    return { artist: byPayee || byName, issue: null }
  }

  function applyStatementGroupMatch(group: EddyStatementImportGroup, matchedPayee: Payee | null, method: 'automatic' | 'manual' | null) {
    const resolved = resolveStatementRunArtist(group.payeeName, matchedPayee)
    return {
      ...group,
      matchedPayee,
      matchMethod: method,
      existingArtist: resolved.artist,
      issue: resolved.issue,
    }
  }

  function openPreviewPayeeMatch(row: ImportPreviewRow) {
    setPayeeMatchTarget({ kind: 'preview', rowNumber: row.rowNumber, importedName: row.artistName })
    setPayeeSearch(row.artistName)
    setSelectedMatchPayeeId('')
    setPayeeMatchError(null)
  }

  function openArtistPayeeMatch(artist: ArtistRow) {
    setPayeeMatchTarget({
      kind: 'artist',
      artistId: artist.id,
      importedName: artist.imported_artist_name || artist.artist_name,
    })
    setPayeeSearch(artist.imported_artist_name || artist.artist_name)
    setSelectedMatchPayeeId('')
    setPayeeMatchError(null)
  }

  function openStatementPayeeMatch(group: EddyStatementImportGroup) {
    setPayeeMatchTarget({ kind: 'statementPreview', groupKey: group.key, importedName: group.payeeName })
    setPayeeSearch(group.payeeName)
    setSelectedMatchPayeeId('')
    setPayeeMatchError(null)
  }

  function closePayeeMatch() {
    setPayeeMatchTarget(null)
    setPayeeSearch('')
    setSelectedMatchPayeeId('')
    setPayeeMatchError(null)
  }

  async function confirmPayeeMatch() {
    if (!payeeMatchTarget || !selectedMatchPayeeId) return
    const selectedPayee = payees.find(payee => payee.id === selectedMatchPayeeId)
    if (!selectedPayee) return

    if (payeeMatchTarget.kind === 'preview') {
      const duplicateRow = importPreview.find(row =>
        row.rowNumber !== payeeMatchTarget.rowNumber && row.matchedPayee?.id === selectedPayee.id
      )
      if (duplicateRow) {
        setPayeeMatchError(`This payee is already matched to import row ${duplicateRow.rowNumber}.`)
        return
      }
      setImportPreview(current => validatePreviewDuplicates(current.map(row =>
        row.rowNumber === payeeMatchTarget.rowNumber
          ? { ...row, matchedPayee: selectedPayee, matchMethod: 'manual' }
          : row
      )))
      closePayeeMatch()
      return
    }

    if (payeeMatchTarget.kind === 'statementPreview') {
      const duplicateGroup = statementImportGroups.find(group =>
        group.key !== payeeMatchTarget.groupKey && group.matchedPayee?.id === selectedPayee.id
      )
      if (duplicateGroup) {
        setPayeeMatchError(`This payee is already matched to Eddy payee ${duplicateGroup.payeeName}.`)
        return
      }
      const targetGroup = statementImportGroups.find(group => group.key === payeeMatchTarget.groupKey)
      if (!targetGroup) return
      const updatedGroup = applyStatementGroupMatch(targetGroup, selectedPayee, 'manual')
      if (updatedGroup.issue) {
        setPayeeMatchError(updatedGroup.issue)
        return
      }
      setStatementImportGroups(current => current.map(group => group.key === targetGroup.key ? updatedGroup : group))
      closePayeeMatch()
      return
    }

    const targetArtist = artists.find(artist => artist.id === payeeMatchTarget.artistId)
    if (!targetArtist) return
    const duplicateArtist = findDuplicateEddyRunPayee(artists, selectedPayee.id, targetArtist.id)
    if (duplicateArtist) {
      setPayeeMatchError(`${displayPayeeName(selectedPayee)} is already linked to ${duplicateArtist.artist_name} in this run.`)
      return
    }

    setSaving(true)
    const { error: updateError } = await supabase.from('eddy_master_run_artists').update({
      payee_id: selectedPayee.id,
      email: targetArtist.email || selectedPayee.primary_email || null,
    }).eq('id', targetArtist.id)
    setSaving(false)
    if (updateError) {
      setPayeeMatchError(updateError.code === '23505'
        ? 'That payee is already represented in this Eddy run.'
        : updateError.message)
      return
    }
    closePayeeMatch()
    setNotice(`${targetArtist.artist_name} is now linked to ${displayPayeeName(selectedPayee)}.`)
    if (selectedRun) await loadArtists(selectedRun.id)
  }

  function autoMap(headers: string[]): ImportMapping {
    const find = (...needles: string[]) => headers.find(header => {
      const normalized = normalizeEddyPayeeName(header).replace(/[^a-z0-9]/g, '')
      return needles.some(needle => normalized.includes(needle))
    }) ?? ''
    return {
      artist: find('payeename', 'artistname', 'artist', 'payee'),
      carryover: find('finalbalance', 'previouscarryover', 'carryover', 'balance'),
      email: find('email'),
      sourcePeriod: find('statementperiod', 'period'),
    }
  }

  async function handleImportFile(file: File) {
    setError(null)
    setImportFileName(file.name)
    let rows: Record<string, unknown>[] = []
    if (/\.csv$/i.test(file.name)) {
      const parsed = Papa.parse<Record<string, unknown>>(await file.text(), { header: true, skipEmptyLines: true })
      rows = parsed.data
    } else {
      const XLSX = await import('xlsx')
      const workbook = XLSX.read(await file.arrayBuffer(), { type: 'array' })
      const sheet = workbook.Sheets[workbook.SheetNames[0]]
      rows = XLSX.utils.sheet_to_json<Record<string, unknown>>(sheet, { defval: null, raw: true })
    }
    const headers = Array.from(new Set(rows.flatMap(row => Object.keys(row))))
    setImportRows(rows)
    setImportHeaders(headers)
    setImportMapping(autoMap(headers))
    setImportStep('map')
  }

  function buildImportPreview() {
    if (!importMapping.artist || !importMapping.carryover) {
      setError('Map both Artist and Previous Carryover before previewing.')
      return
    }
    const draft = importRows.map((row, index): ImportPreviewRow => {
      const artistName = cleanText(row[importMapping.artist])
      const carryover = parseAmount(row[importMapping.carryover])
      const automaticMatch = artistName ? automaticallyMatchEddyPayee(artistName, payees, aliases) : null
      return {
        rowNumber: index + 2,
        artistName,
        normalizedName: normalizeEddyPayeeName(artistName),
        carryover,
        email: importMapping.email ? cleanText(row[importMapping.email]) : '',
        sourcePeriod: importMapping.sourcePeriod ? cleanText(row[importMapping.sourcePeriod]) : '',
        matchedPayee: automaticMatch,
        matchMethod: automaticMatch ? 'automatic' : null,
        issue: !artistName ? 'Artist is blank' : carryover === null ? 'Carryover is blank or invalid' : null,
        duplicateIssue: null,
      }
    })
    setImportPreview(validatePreviewDuplicates(draft))
    setImportStep('preview')
  }

  async function commitImport() {
    if (!selectedRun) return
    const valid = importPreview.filter(row => !row.issue && !row.duplicateIssue)
    const deduped = Array.from(new Map(valid.map(row => [
      row.matchedPayee ? `payee:${row.matchedPayee.id}` : `name:${row.normalizedName}`,
      row,
    ])).values())
    if (!deduped.length) {
      setError('There are no valid rows to import.')
      return
    }
    setSaving(true)
    setError(null)
    const sourcePeriods = Array.from(new Set(deduped.map(row => row.sourcePeriod).filter(Boolean)))
    const payload = deduped.map(row => ({
      payee_id: row.matchedPayee?.id ?? null,
      artist_name: row.artistName,
      imported_artist_name: row.artistName,
      normalized_artist_name: row.normalizedName,
      email: row.email || row.matchedPayee?.primary_email || null,
      previous_carryover: row.carryover,
    }))
    const { error: importError } = await supabase.rpc('commit_eddy_master_carryover_import', {
      p_run_id: selectedRun.id,
      p_file_name: importFileName,
      p_source_period_label: sourcePeriods.join(', '),
      p_column_mapping_json: importMapping,
      p_rows: payload,
    })
    setSaving(false)
    if (importError) {
      setError(importError.message)
      return
    }
    const skipped = importPreview.length - deduped.length
    setNotice(`Imported ${deduped.length} artist carryover${deduped.length === 1 ? '' : 's'}${skipped ? `; ${skipped} invalid or duplicate row${skipped === 1 ? '' : 's'} skipped` : ''}.`)
    closeImport()
    await loadArtists(selectedRun.id)
  }

  function closeImport() {
    setShowImport(false)
    setImportStep('upload')
    setImportFileName('')
    setImportHeaders([])
    setImportRows([])
    setImportPreview([])
    if (fileRef.current) fileRef.current.value = ''
  }

  function canonicalPeriod(value: string) {
    const normalized = value.trim().toUpperCase()
    const halfFirst = normalized.match(/^(H[12])\s*[- ]\s*(\d{4})$/)
    if (halfFirst) return `${halfFirst[2]}-${halfFirst[1]}`
    const yearFirst = normalized.match(/^(\d{4})\s*[- ]\s*(H[12])$/)
    if (yearFirst) return `${yearFirst[1]}-${yearFirst[2]}`
    return normalized
  }

  async function handleEddyStatementFile(file: File) {
    setError(null)
    const parsed = Papa.parse<Record<string, string>>(await file.text(), {
      header: true,
      skipEmptyLines: true,
    })
    const requiredHeaders = ['Period Ref', 'Contract Name', 'Contract ID', 'Payee Name', 'Payee ID', 'Statement ID', 'Final Due']
    const missingHeaders = requiredHeaders.filter(header => !parsed.meta.fields?.includes(header))
    if (missingHeaders.length > 0) {
      setError(`This is not a standard Eddy Statements List CSV. Missing: ${missingHeaders.join(', ')}.`)
      return
    }
    const rows = parsed.data.map((row, index): EddyStatementCsvRow => ({
      rowNumber: index + 2,
      periodRef: cleanText(row['Period Ref']),
      contractName: cleanText(row['Contract Name']),
      contractId: cleanText(row['Contract ID']),
      payeeName: cleanText(row['Payee Name']),
      eddyPayeeId: cleanText(row['Payee ID']),
      statementId: cleanText(row['Statement ID']),
      finalDue: parseAmount(row['Final Due']),
    }))
    const periodCounts = rows.reduce<Record<string, number>>((acc, row) => {
      if (row.periodRef) acc[row.periodRef] = (acc[row.periodRef] ?? 0) + 1
      return acc
    }, {})
    const foundPeriods = Object.entries(periodCounts).map(([periodRef, rowCount]) => ({ periodRef, rowCount }))
    const matchingPeriod = foundPeriods.find(period => canonicalPeriod(period.periodRef) === canonicalPeriod(selectedRun?.statement_period.label ?? ''))
    setStatementImportFileName(file.name)
    setStatementCsvRows(rows)
    setStatementPeriods(foundPeriods)
    setSelectedStatementPeriod(matchingPeriod?.periodRef ?? '')
    setStatementImportStep('period')
  }

  function buildEddyStatementPreview() {
    if (!selectedStatementPeriod) {
      setError('Select an Eddy Period Ref before continuing.')
      return
    }
    const selectedRows = statementCsvRows.filter(row => row.periodRef === selectedStatementPeriod)
    const groups = new Map<string, EddyStatementCsvRow[]>()
    selectedRows.forEach(row => {
      const key = row.eddyPayeeId ? `eddy:${row.eddyPayeeId}` : `name:${normalizeEddyPayeeName(row.payeeName)}`
      groups.set(key, [...(groups.get(key) ?? []), row])
    })
    const duplicateStatementIds = new Set<string>()
    const seenStatementIds = new Set<string>()
    selectedRows.forEach(row => {
      if (seenStatementIds.has(row.statementId)) duplicateStatementIds.add(row.statementId)
      seenStatementIds.add(row.statementId)
    })
    const previewGroups = Array.from(groups.entries()).map(([key, rows]): EddyStatementImportGroup => {
      const first = rows[0]
      const automaticMatch = automaticallyMatchEddyPayee(first.payeeName, payees, aliases)
      const invalidRow = rows.find(row => !row.payeeName || !row.contractName || !row.contractId || !row.statementId || row.finalDue === null)
      const duplicateId = rows.find(row => duplicateStatementIds.has(row.statementId))
      const base: EddyStatementImportGroup = {
        key,
        payeeName: first.payeeName,
        normalizedPayeeName: normalizeEddyPayeeName(first.payeeName),
        eddyPayeeId: first.eddyPayeeId,
        matchedPayee: automaticMatch,
        matchMethod: automaticMatch ? 'automatic' : null,
        existingArtist: null,
        statements: rows,
        issue: invalidRow
          ? `Row ${invalidRow.rowNumber} is missing a required value`
          : duplicateId
            ? `Statement ID ${duplicateId.statementId} is duplicated in the selected period`
            : null,
      }
      if (base.issue) return base
      return applyStatementGroupMatch(base, automaticMatch, automaticMatch ? 'automatic' : null)
    }).sort((a, b) => a.payeeName.localeCompare(b.payeeName))
    setStatementImportGroups(previewGroups)
    setExpandedStatementGroup(null)
    setStatementImportStep('preview')
  }

  async function commitEddyStatementImport() {
    if (!selectedRun || !selectedStatementPeriod) return
    const issue = statementImportGroups.find(group => group.issue)
    if (issue) {
      setError(`Resolve the preview issue for ${issue.payeeName} before importing.`)
      return
    }
    const payload = statementImportGroups.flatMap(group => group.statements.map(statement => ({
      payee_id: group.matchedPayee?.id ?? null,
      payee_name: group.payeeName,
      normalized_payee_name: group.normalizedPayeeName,
      email: group.matchedPayee?.primary_email ?? group.existingArtist?.email ?? null,
      eddy_payee_id: group.eddyPayeeId,
      period_ref: statement.periodRef,
      contract_name: statement.contractName,
      contract_id: statement.contractId,
      statement_id: statement.statementId,
      final_due: statement.finalDue,
    })))
    setSaving(true)
    setError(null)
    const { error: importError } = await supabase.rpc('commit_eddy_master_statement_import', {
      p_run_id: selectedRun.id,
      p_file_name: statementImportFileName,
      p_period_ref: selectedStatementPeriod,
      p_rows: payload,
    })
    setSaving(false)
    if (importError) {
      setError(importError.message)
      return
    }
    setNotice(`Imported ${payload.length} Eddy statement${payload.length === 1 ? '' : 's'} for ${selectedStatementPeriod}. Existing Statement IDs were updated without duplication.`)
    closeStatementImport()
    await loadArtists(selectedRun.id)
  }

  function closeStatementImport() {
    setShowStatementImport(false)
    setStatementImportStep('upload')
    setStatementImportFileName('')
    setStatementCsvRows([])
    setStatementPeriods([])
    setSelectedStatementPeriod('')
    setStatementImportGroups([])
    setExpandedStatementGroup(null)
    if (statementFileRef.current) statementFileRef.current.value = ''
  }

  if (loading) return <div className="flex justify-center py-16"><LoadingSpinner size={28} /></div>

  const currency = selectedRun?.currency ?? 'GBP'
  const availablePeriods = periods.filter(period => !runs.some(run => run.statement_period_id === period.id))
  const selectedStatementRows = statementCsvRows.filter(row => row.periodRef === selectedStatementPeriod)
  const statementPreviewTotal = statementImportGroups.reduce(
    (sum, group) => sum + group.statements.reduce((groupSum, statement) => groupSum + Number(statement.finalDue ?? 0), 0),
    0,
  )
  const importedStatementIds = new Set(
    artists.flatMap(artist => artist.statements.map(statement => statement.eddy_statement_id).filter(Boolean)),
  )

  return (
    <div className="space-y-4">
      <div className="page-header">
        <div>
          <h1 className="page-title">Eddy Master Run</h1>
          <p className="page-subtitle">Artist-level administration for master statements already calculated in Eddy</p>
        </div>
        <div className="flex gap-2">
          <button className="btn-ghost btn-sm" onClick={() => { void loadBase(); if (selectedRunId) void loadArtists(selectedRunId) }}><RefreshCw size={13} /></button>
          <button className="btn-secondary" onClick={() => setShowCreateRun(true)}><Plus size={14} /> New Run</button>
        </div>
      </div>

      {error && <Alert type="error">{error}</Alert>}
      {notice && <Alert type="success">{notice}</Alert>}

      {runs.length === 0 ? (
        <div className="card"><EmptyState title="No Eddy Master Runs yet" description="Create a run for a statement period to begin." icon={FileSpreadsheet} /></div>
      ) : (
        <>
          <div className="card p-4 flex flex-wrap items-end gap-3">
            <div className="ops-field min-w-[240px]">
              <label className="ops-label">Run Period</label>
              <select className="ops-select" value={selectedRunId} onChange={event => setSelectedRunId(event.target.value)}>
                {runs.map(run => <option key={run.id} value={run.id}>{run.statement_period.label}</option>)}
              </select>
            </div>
            <div className="ml-auto flex gap-2">
              <button className="btn-secondary" onClick={() => setShowStatementImport(true)}><FileSpreadsheet size={14} /> Import Eddy Statements</button>
              <button className="btn-secondary" onClick={() => setShowImport(true)}><Upload size={14} /> Import Carryover</button>
              <button className="btn-primary" onClick={() => setShowAddArtist(true)}><Plus size={14} /> Add Artist</button>
            </div>
          </div>

          <div className="grid grid-cols-2 md:grid-cols-4 xl:grid-cols-8 gap-3 [&_.stat-value]:!whitespace-nowrap [&_.stat-value]:!break-normal">
            <StatCard label="Artists" value={summary.artistCount} />
            <StatCard label="Eddy Statements" value={summary.statementCount} />
            <StatCard label="Eddy Value" value={formatMoney(summary.statementValue, currency)} color="green" />
            <StatCard label="Eddy Opening Carryover" value={formatMoney(summary.openingCarryover, currency)} />
            <StatCard label="Eddy Amount Due" value={formatMoney(summary.amountDue, currency)} color="blue" />
            <StatCard label="Ready" value={summary.ready} color="cyan" />
            <StatCard label="Sent" value={summary.sent} color="green" />
            <StatCard label="Carry Forward" value={summary.carryForward} color="amber" />
          </div>

          <div className="card overflow-x-auto">
            {artists.length === 0 ? (
              <EmptyState title="No artists in this run" description="Import previous carryovers or add an artist manually." icon={FileSpreadsheet} />
            ) : (
              <table className="ops-table min-w-max whitespace-nowrap">
                <thead><tr>
                  <th className="w-8"></th><th>Artist</th><th>Email</th><th className="text-right">Eddy Statements</th>
                  <th className="text-right">Eddy Total</th><th className="text-right">Eddy Opening Carryover</th>
                  <th className="text-right">Amount Due</th><th>Status</th><th>Actions</th>
                </tr></thead>
                <tbody>
                  {artists.map(artist => (
                    <FragmentRow key={artist.id}>
                      <tr>
                        <td><button className="btn-icon" onClick={() => expandArtist(artist)}>{expandedArtistId === artist.id ? <ChevronDown size={15} /> : <ChevronRight size={15} />}</button></td>
                        <td>
                          <div className="font-medium">{artist.payee ? displayPayeeName(artist.payee) : artist.artist_name}</div>
                          {artist.payee ? (
                            <div className="text-[11px] text-ops-muted">
                              Eddy name: {artist.imported_artist_name || artist.artist_name}
                            </div>
                          ) : (
                            <div className="mt-1"><span className="badge-warning">Unmatched payee</span></div>
                          )}
                        </td>
                        <td className={artist.email ? '' : 'text-red-400'}>{artist.email || 'Missing'}</td>
                        <td className="text-right font-mono whitespace-nowrap">{artist.statements.length}</td>
                        <td className="text-right font-mono whitespace-nowrap">{formatMoney(artistTotal(artist), currency)}</td>
                        <td className="text-right font-mono whitespace-nowrap">
                          <span
                            className={artist.imported_final_balance !== null && artist.imported_final_balance > EDDY_PAYMENT_THRESHOLD ? 'cursor-help underline decoration-dotted underline-offset-2' : undefined}
                            title={artist.imported_final_balance !== null && artist.imported_final_balance > EDDY_PAYMENT_THRESHOLD
                              ? `Source final ${formatMoney(artist.imported_final_balance, currency)}; paid previously`
                              : undefined}
                          >
                            {formatMoney(Number(artist.previous_carryover ?? 0), currency)}
                          </span>
                        </td>
                        <td className="text-right font-mono font-semibold whitespace-nowrap">{formatMoney(amountDue(artist), currency)}</td>
                        <td className="whitespace-nowrap">{statusBadge(artist.status)}</td>
                        <td><div className="flex flex-nowrap gap-1 min-w-max">
                          <button className="btn-secondary btn-sm" onClick={() => openEmail(artist)}><Mail size={12} /> Prepare Email</button>
                          <select className="ops-select !w-auto !py-1 text-xs" value={artist.status} onChange={event => void setStatus(artist, event.target.value as EddyMasterRunStatus)}>
                            {STATUS_OPTIONS.map(option => <option key={option.value} value={option.value}>{option.label}</option>)}
                          </select>
                          {!artist.payee_id && <button className="btn-secondary btn-sm" onClick={() => openArtistPayeeMatch(artist)}><Search size={12} /> Match Payee</button>}
                        </div></td>
                      </tr>
                      {expandedArtistId === artist.id && (
                        <tr><td colSpan={9} className="!p-0"><div className="p-4 space-y-4" style={{ background: 'var(--ops-surface-2)' }}>
                          <div className="grid md:grid-cols-4 gap-3 items-end">
                            <div className="ops-field"><label className="ops-label">Artist</label><input className="ops-input" value={artistEdit.name} onChange={event => setArtistEdit(value => ({ ...value, name: event.target.value }))} /></div>
                            <div className="ops-field"><label className="ops-label">Email</label><input className="ops-input" type="email" value={artistEdit.email} onChange={event => setArtistEdit(value => ({ ...value, email: event.target.value }))} /></div>
                            <div className="ops-field"><label className="ops-label">Eddy Opening Carryover</label><input className="ops-input font-mono" value={artistEdit.previousCarryover} onChange={event => setArtistEdit(value => ({ ...value, previousCarryover: event.target.value }))} /></div>
                            <div className="flex gap-2"><button className="btn-primary btn-sm" disabled={saving} onClick={() => void saveArtist(artist)}><Save size={12} /> Save Artist</button><button className="btn-danger btn-sm" onClick={() => void deleteArtist(artist)}><Trash2 size={12} /> Remove</button></div>
                          </div>
                          <div>
                            <div className="section-title mb-2">Eddy Statement Entries</div>
                            {artist.statements.length > 0 && <div className="rounded border overflow-hidden mb-3" style={{ borderColor: 'var(--ops-border)' }}><table className="ops-table"><thead><tr><th>Statement / Contract Label</th><th>Filename / Reference</th><th className="text-right">Amount</th><th></th></tr></thead><tbody>
                              {artist.statements.map(statement => <tr key={statement.id}><td><div>{statement.statement_label}</div>{statement.eddy_statement_id && <div className="text-[11px] text-ops-muted font-mono">Contract {statement.eddy_contract_id || '—'} · Statement {statement.eddy_statement_id}</div>}</td><td className="text-ops-muted">{statement.file_reference || '—'}</td><td className="text-right font-mono">{formatMoney(statement.amount, currency)}</td><td className="text-right"><button className="btn-icon text-red-400" onClick={() => void deleteStatement(statement.id)}><Trash2 size={13} /></button></td></tr>)}
                            </tbody></table></div>}
                            <div className="grid md:grid-cols-[1fr_160px_1fr_auto] gap-2 items-end">
                              <div className="ops-field"><label className="ops-label">Statement / Contract Label</label><input className="ops-input" value={statementDraft.label} onChange={event => setStatementDraft(value => ({ ...value, label: event.target.value }))} placeholder="e.g. Artist Services Agreement" /></div>
                              <div className="ops-field"><label className="ops-label">Amount</label><input className="ops-input font-mono" value={statementDraft.amount} onChange={event => setStatementDraft(value => ({ ...value, amount: event.target.value }))} placeholder="0.00" /></div>
                              <div className="ops-field"><label className="ops-label">Filename / Reference</label><input className="ops-input" value={statementDraft.reference} onChange={event => setStatementDraft(value => ({ ...value, reference: event.target.value }))} /></div>
                              <button className="btn-primary" disabled={saving} onClick={() => void addStatement(artist.id)}><Plus size={13} /> Add</button>
                            </div>
                          </div>
                        </div></td></tr>
                      )}
                    </FragmentRow>
                  ))}
                </tbody>
              </table>
            )}
          </div>
        </>
      )}

      {showCreateRun && <Modal title="Create Eddy Master Run" onClose={() => setShowCreateRun(false)}>
        <div className="space-y-4">
          <div className="ops-field"><label className="ops-label">Statement Period</label><select className="ops-select" value={newRunPeriodId} onChange={event => setNewRunPeriodId(event.target.value)}><option value="">Select period</option>{availablePeriods.map(period => <option key={period.id} value={period.id}>{period.label}</option>)}</select></div>
          <div className="ops-field"><label className="ops-label">Currency</label><input className="ops-input uppercase" maxLength={3} value={newRunCurrency} onChange={event => setNewRunCurrency(event.target.value)} /></div>
          {availablePeriods.length === 0 && <Alert type="info">Every statement period already has an Eddy Master Run.</Alert>}
          <div className="flex justify-end gap-2"><button className="btn-secondary" onClick={() => setShowCreateRun(false)}>Cancel</button><button className="btn-primary" disabled={saving || !newRunPeriodId} onClick={() => void createRun()}>Create Run</button></div>
        </div>
      </Modal>}

      {showAddArtist && <Modal title="Add Artist" onClose={() => setShowAddArtist(false)}>
        <div className="space-y-3">
          <div className="ops-field"><label className="ops-label">Match Existing Payee (optional)</label><select className="ops-select" value={artistDraft.payeeId} onChange={event => void selectPayeeForArtist(event.target.value)}><option value="">Manual artist</option>{payees.map(payee => <option key={payee.id} value={payee.id}>{displayPayeeName(payee)}</option>)}</select></div>
          <div className="ops-field"><label className="ops-label">Artist</label><input className="ops-input" value={artistDraft.name} onChange={event => setArtistDraft(value => ({ ...value, name: event.target.value }))} /></div>
          <div className="ops-field"><label className="ops-label">Email</label><input className="ops-input" type="email" value={artistDraft.email} onChange={event => setArtistDraft(value => ({ ...value, email: event.target.value }))} /></div>
          <div className="ops-field"><label className="ops-label">Previous Carryover</label><input className="ops-input font-mono" value={artistDraft.previousCarryover} onChange={event => setArtistDraft(value => ({ ...value, previousCarryover: event.target.value }))} /></div>
          <div className="flex justify-end gap-2"><button className="btn-secondary" onClick={() => setShowAddArtist(false)}>Cancel</button><button className="btn-primary" disabled={saving || !artistDraft.name.trim()} onClick={() => void addArtist()}>Add Artist</button></div>
        </div>
      </Modal>}

      {emailArtist && <Modal title={`Prepare Email - ${emailArtist.artist_name}`} wide onClose={() => setEmailArtist(null)}>
        <div className="space-y-3">
          <div className="flex justify-between text-sm"><span className="text-ops-muted">Recipient</span><span className={emailArtist.email ? '' : 'text-red-400'}>{emailArtist.email || 'Email missing'}</span></div>
          <div className="flex justify-between text-sm"><span className="text-ops-muted">Attachments required</span><strong>{emailArtist.statements.length} statement{emailArtist.statements.length === 1 ? '' : 's'}</strong></div>
          <div className="ops-field"><label className="ops-label">Subject</label><input className="ops-input" value={emailSubject} onChange={event => setEmailSubject(event.target.value)} /></div>
          <div className="ops-field"><label className="ops-label">Body</label><textarea className="ops-textarea min-h-[280px] font-mono text-xs" value={emailBody} onChange={event => setEmailBody(event.target.value)} /></div>
          <div className="flex justify-between"><button className="btn-secondary" onClick={() => void copyEmail()}><Clipboard size={13} /> {copied ? 'Copied' : 'Copy Email'}</button><div className="flex gap-2"><button className="btn-secondary" onClick={() => { const generated = generateEmail(emailArtist); setEmailSubject(generated.subject); setEmailBody(generated.body) }}>Regenerate</button><button className="btn-primary" disabled={saving} onClick={() => void saveEmail()}><Save size={13} /> Save as Ready</button></div></div>
        </div>
      </Modal>}

      {showStatementImport && <Modal title="Import Eddy Statements" wide onClose={closeStatementImport}>
        <div className="space-y-4">
          <div className="flex gap-2 text-xs text-ops-muted"><span className={statementImportStep === 'upload' ? 'text-blue-500 font-semibold' : ''}>1. Upload</span><span>›</span><span className={statementImportStep === 'period' ? 'text-blue-500 font-semibold' : ''}>2. Select Period</span><span>›</span><span className={statementImportStep === 'preview' ? 'text-blue-500 font-semibold' : ''}>3. Preview</span></div>
          {statementImportStep === 'upload' && <div className="space-y-3">
            <Alert type="info">Upload the standard Eddy Statements List CSV. You will choose one Period Ref before any rows are previewed or imported.</Alert>
            <button className="w-full border-2 border-dashed rounded-lg p-10 text-center hover:border-blue-500" style={{ borderColor: 'var(--ops-border)' }} onClick={() => statementFileRef.current?.click()}><FileSpreadsheet size={28} className="mx-auto mb-2 text-ops-muted" /><span>Choose Eddy Statements List CSV</span></button>
            <input ref={statementFileRef} type="file" accept=".csv,text/csv" className="hidden" onChange={event => { const file = event.target.files?.[0]; if (file) void handleEddyStatementFile(file) }} />
          </div>}
          {statementImportStep === 'period' && <div className="space-y-4">
            <div className="rounded border p-3 text-sm" style={{ borderColor: 'var(--ops-border)', background: 'var(--ops-surface-2)' }}><div><span className="text-ops-muted">File:</span> {statementImportFileName}</div><div><span className="text-ops-muted">Current Eddy Master Run:</span> {selectedRun?.statement_period.label}</div><div><span className="text-ops-muted">Periods found:</span> {statementPeriods.length}</div></div>
            <div className="grid sm:grid-cols-2 lg:grid-cols-3 gap-2">{statementPeriods.map(period => <button key={period.periodRef} type="button" onClick={() => setSelectedStatementPeriod(period.periodRef)} className="rounded border p-3 text-left transition-colors" style={{ borderColor: selectedStatementPeriod === period.periodRef ? 'var(--accent-blue)' : 'var(--ops-border)', background: selectedStatementPeriod === period.periodRef ? 'var(--sidebar-active-bg)' : 'var(--ops-surface)' }}><div className="font-semibold">{period.periodRef}</div><div className="text-xs text-ops-muted">{period.rowCount} statement row{period.rowCount === 1 ? '' : 's'}</div></button>)}</div>
            {selectedStatementPeriod && <Alert type="warning">Only the <strong>{selectedStatementPeriod}</strong> rows will proceed. The other {statementCsvRows.length - selectedStatementRows.length} rows in this file will not be imported.</Alert>}
            <div className="flex justify-between"><button className="btn-secondary" onClick={() => setStatementImportStep('upload')}>Back</button><button className="btn-primary" disabled={!selectedStatementPeriod} onClick={buildEddyStatementPreview}>Preview {selectedStatementPeriod || 'Selected Period'}</button></div>
          </div>}
          {statementImportStep === 'preview' && <div className="space-y-4">
            <div className="grid sm:grid-cols-3 gap-3"><div className="rounded border p-3" style={{ borderColor: 'var(--ops-border)' }}><div className="text-xs text-ops-muted">Selected Eddy Period</div><div className="font-semibold">{selectedStatementPeriod}</div></div><div className="rounded border p-3" style={{ borderColor: 'var(--ops-border)' }}><div className="text-xs text-ops-muted">Statement Rows</div><div className="font-semibold">{selectedStatementRows.length}</div></div><div className="rounded border p-3" style={{ borderColor: 'var(--ops-border)' }}><div className="text-xs text-ops-muted">Final Due Total</div><div className="font-semibold font-mono">{formatMoney(statementPreviewTotal, currency)}</div></div></div>
            <Alert type="info">Preview grouped into {statementImportGroups.length} artist/payee record{statementImportGroups.length === 1 ? '' : 's'}. Previous Carryover is preserved from the current run and is not taken from this CSV.</Alert>
            <div className="max-h-[480px] overflow-auto rounded border" style={{ borderColor: 'var(--ops-border)' }}><table className="ops-table"><thead><tr><th className="w-8"></th><th>Eddy Payee Name</th><th>App Payee Match</th><th>Run Artist</th><th className="text-right">Previous Carryover</th><th className="text-right">Statements</th><th className="text-right">Eddy Total</th></tr></thead><tbody>{statementImportGroups.map(group => <FragmentRow key={group.key}><tr><td><button className="btn-icon" onClick={() => setExpandedStatementGroup(current => current === group.key ? null : group.key)}>{expandedStatementGroup === group.key ? <ChevronDown size={14} /> : <ChevronRight size={14} />}</button></td><td><div className="font-medium">{group.payeeName}</div><div className="text-[11px] text-ops-muted">Eddy Payee ID: {group.eddyPayeeId || '—'}</div></td><td>{group.matchedPayee ? <div><div>{displayPayeeName(group.matchedPayee)}</div><div className="text-[11px] text-ops-muted">{group.matchMethod === 'manual' ? 'Manually matched' : 'Automatically matched'}</div></div> : <div className="flex items-center gap-2"><span className="badge-warning">Unmatched</span><button className="btn-secondary btn-sm" onClick={() => openStatementPayeeMatch(group)}><Search size={12} /> Find Payee</button></div>}</td><td>{group.issue ? <span className="text-red-400">{group.issue}</span> : group.existingArtist ? <div><span className="badge-info">Existing</span><div className="text-[11px] text-ops-muted mt-1">{group.existingArtist.artist_name}</div></div> : <span className="badge-pending">Will create</span>}</td><td className="text-right font-mono">{formatMoney(Number(group.existingArtist?.previous_carryover ?? 0), currency)}</td><td className="text-right font-mono">{group.statements.length}</td><td className="text-right font-mono font-semibold">{formatMoney(group.statements.reduce((sum, statement) => sum + Number(statement.finalDue ?? 0), 0), currency)}</td></tr>{expandedStatementGroup === group.key && <tr><td colSpan={7} className="!p-0"><div className="p-3" style={{ background: 'var(--ops-surface-2)' }}><table className="ops-table text-xs"><thead><tr><th>Contract Name</th><th>Contract ID</th><th>Statement ID</th><th>Import Status</th><th className="text-right">Final Due</th></tr></thead><tbody>{group.statements.map(statement => <tr key={`${group.key}-${statement.statementId}`}><td>{statement.contractName}</td><td className="font-mono">{statement.contractId}</td><td className="font-mono">{statement.statementId}</td><td>{importedStatementIds.has(statement.statementId) ? <span className="badge-info">Will update</span> : <span className="badge-pending">New</span>}</td><td className="text-right font-mono">{statement.finalDue === null ? '—' : formatMoney(statement.finalDue, currency)}</td></tr>)}</tbody></table></div></td></tr>}</FragmentRow>)}</tbody></table></div>
            <div className="flex justify-between"><button className="btn-secondary" onClick={() => setStatementImportStep('period')}>Back</button><button className="btn-primary" disabled={saving || statementImportGroups.length === 0 || statementImportGroups.some(group => group.issue)} onClick={() => void commitEddyStatementImport()}><Upload size={13} /> Import {selectedStatementRows.length} Statements</button></div>
          </div>}
        </div>
      </Modal>}

      {showImport && <Modal title="Import Previous Carryovers" wide onClose={closeImport}>
        <div className="space-y-4">
          <div className="flex gap-2 text-xs text-ops-muted"><span className={importStep === 'upload' ? 'text-blue-500 font-semibold' : ''}>1. Upload</span><span>›</span><span className={importStep === 'map' ? 'text-blue-500 font-semibold' : ''}>2. Map</span><span>›</span><span className={importStep === 'preview' ? 'text-blue-500 font-semibold' : ''}>3. Preview</span></div>
          {importStep === 'upload' && <div className="space-y-3"><Alert type="info">CSV and Excel files are supported. Source final balances above {formatMoney(EDDY_PAYMENT_THRESHOLD, currency)} are treated as paid and become a zero Eddy opening carryover. Nothing is saved until you review the preview.</Alert><button className="w-full border-2 border-dashed rounded-lg p-10 text-center hover:border-blue-500" style={{ borderColor: 'var(--ops-border)' }} onClick={() => fileRef.current?.click()}><Upload size={28} className="mx-auto mb-2 text-ops-muted" /><span>Choose carryover CSV or Excel file</span></button><input ref={fileRef} type="file" accept=".csv,.xlsx,.xls" className="hidden" onChange={event => { const file = event.target.files?.[0]; if (file) void handleImportFile(file) }} /></div>}
          {importStep === 'map' && <div className="space-y-3"><div className="text-sm text-ops-muted">{importFileName} · {importRows.length} rows</div>{([
            ['artist', 'Artist / Payee Name', true], ['carryover', 'Prior Final Balance', true], ['email', 'Email', false], ['sourcePeriod', 'Source Statement Period', false],
          ] as const).map(([key, label, required]) => <div key={key} className="grid grid-cols-[220px_1fr] gap-3 items-center"><label className="text-sm">{label}{required && <span className="text-red-400"> *</span>}</label><select className="ops-select" value={importMapping[key]} onChange={event => setImportMapping(value => ({ ...value, [key]: event.target.value }))}><option value="">Not mapped</option>{importHeaders.map(header => <option key={header} value={header}>{header}</option>)}</select></div>)}<div className="flex justify-between"><button className="btn-secondary" onClick={() => setImportStep('upload')}>Back</button><button className="btn-primary" onClick={buildImportPreview}>Preview Import</button></div></div>}
          {importStep === 'preview' && <div className="space-y-3"><div className="max-h-[420px] overflow-auto rounded border" style={{ borderColor: 'var(--ops-border)' }}><table className="ops-table"><thead><tr><th>Row</th><th>Imported Eddy Artist</th><th>Payee Match</th><th>Source Period</th><th className="text-right">Source Final Balance</th><th className="text-right">Eddy Opening Carryover</th><th>Check</th></tr></thead><tbody>{importPreview.map(row => <tr key={row.rowNumber}><td>{row.rowNumber}</td><td>{row.artistName || '—'}</td><td>{row.matchedPayee ? <div><div className="font-medium">{displayPayeeName(row.matchedPayee)}</div><div className="text-[11px] text-ops-muted">{row.matchMethod === 'manual' ? 'Manually matched' : 'Automatically matched'}</div></div> : <div className="flex items-center gap-2"><span className="badge-warning">Unmatched</span>{row.artistName && <button className="btn-secondary btn-sm" onClick={() => openPreviewPayeeMatch(row)}><Search size={12} /> Find Payee</button>}</div>}</td><td>{row.sourcePeriod || '—'}</td><td className="text-right font-mono">{row.carryover === null ? '—' : formatMoney(row.carryover, currency)}</td><td className="text-right font-mono">{row.carryover === null ? '—' : formatMoney(eddyOpeningCarryover(row.carryover), currency)}</td><td>{row.issue || row.duplicateIssue ? <span className="text-red-400">{row.issue || row.duplicateIssue}</span> : row.carryover !== null && row.carryover > EDDY_PAYMENT_THRESHOLD ? <span className="text-amber-500">Paid previously · reset to zero</span> : <span className="text-green-500">Carry forward</span>}</td></tr>)}</tbody></table></div><div className="flex justify-between"><button className="btn-secondary" onClick={() => setImportStep('map')}>Back</button><button className="btn-primary" disabled={saving || importPreview.every(row => row.issue || row.duplicateIssue)} onClick={() => void commitImport()}><Upload size={13} /> Import Valid Rows</button></div></div>}
        </div>
      </Modal>}

      {payeeMatchTarget && <Modal title="Match Existing Payee" wide onClose={closePayeeMatch}>
        <div className="space-y-4">
          <Alert type="info">
            Imported Eddy artist: <strong>{payeeMatchTarget.importedName}</strong>. Selecting a payee links this row to an existing record and does not create a new payee.
          </Alert>
          {payeeMatchError && <Alert type="error">{payeeMatchError}</Alert>}
          <div className="ops-field">
            <label className="ops-label">Search Payees</label>
            <div className="relative">
              <Search size={14} className="absolute left-3 top-2.5 text-ops-muted" />
              <input className="ops-input !pl-9" autoFocus value={payeeSearch} onChange={event => { setPayeeSearch(event.target.value); setSelectedMatchPayeeId(''); setPayeeMatchError(null) }} placeholder="Name, display name, statement name, alias, contact, email or vendor reference" />
            </div>
          </div>
          <div className="max-h-[400px] overflow-auto rounded border" style={{ borderColor: 'var(--ops-border)' }}>
            {payeeSearchResults.length === 0 ? <div className="p-6 text-center text-sm text-ops-muted">No existing payees match this search.</div> : payeeSearchResults.map(result => {
              const previewDuplicate = payeeMatchTarget.kind === 'preview'
                ? importPreview.find(row => row.rowNumber !== payeeMatchTarget.rowNumber && row.matchedPayee?.id === result.payee.id)
                : null
              const artistDuplicate = payeeMatchTarget.kind === 'artist'
                ? findDuplicateEddyRunPayee(artists, result.payee.id, payeeMatchTarget.artistId)
                : null
              const existingRunArtist = payeeMatchTarget.kind === 'preview'
                ? artists.find(artist => artist.payee_id === result.payee.id)
                : null
              const statementDuplicate = payeeMatchTarget.kind === 'statementPreview'
                ? statementImportGroups.find(group => group.key !== payeeMatchTarget.groupKey && group.matchedPayee?.id === result.payee.id)
                : null
              const statementExistingArtist = payeeMatchTarget.kind === 'statementPreview'
                ? artists.find(artist => artist.payee_id === result.payee.id)
                : null
              const blocked = Boolean(previewDuplicate || artistDuplicate || existingRunArtist || statementDuplicate)
              return <button key={result.payee.id} type="button" disabled={blocked} onClick={() => { setSelectedMatchPayeeId(result.payee.id); setPayeeMatchError(null) }} className="w-full text-left p-3 border-b last:border-b-0 transition-colors disabled:opacity-50" style={{ borderColor: 'var(--ops-border)', background: selectedMatchPayeeId === result.payee.id ? 'var(--sidebar-active-bg)' : 'var(--ops-surface)' }}>
                <div className="flex items-start justify-between gap-4">
                  <div>
                    <div className="font-semibold">{displayPayeeName(result.payee)}</div>
                    <div className="text-xs text-ops-muted">Legal/internal: {result.payee.payee_name}</div>
                    <div className="text-xs text-ops-muted">{result.payee.primary_contact_name || 'No contact name'} · {result.payee.primary_email || 'No email'} · {result.payee.currency}</div>
                    {result.payee.performer_name && <div className="text-xs text-ops-muted">Performer: {result.payee.performer_name}</div>}
                    {result.aliases.length > 0 && <div className="text-xs text-ops-muted">Aliases: {result.aliases.join(', ')}</div>}
                  </div>
                  <div className="text-right text-xs">
                    {blocked ? <span className="text-red-400">Already matched in this import/run</span> : statementExistingArtist ? <span className="text-amber-500">Uses existing run artist</span> : selectedMatchPayeeId === result.payee.id ? <span className="text-blue-500 font-semibold">Selected</span> : null}
                  </div>
                </div>
              </button>
            })}
          </div>
          <div className="flex justify-end gap-2"><button className="btn-secondary" onClick={closePayeeMatch}>Cancel</button><button className="btn-primary" disabled={saving || !selectedMatchPayeeId} onClick={() => void confirmPayeeMatch()}>Confirm Match</button></div>
        </div>
      </Modal>}
    </div>
  )
}

function FragmentRow({ children }: { children: React.ReactNode }) {
  return <>{children}</>
}

function Modal({ title, children, onClose, wide = false }: { title: string; children: React.ReactNode; onClose: () => void; wide?: boolean }) {
  return <div className="fixed inset-0 z-50 flex items-center justify-center p-4" style={{ background: 'rgba(0,0,0,.5)' }}><div className={`card w-full ${wide ? 'max-w-5xl' : 'max-w-xl'} max-h-[92vh] overflow-auto`}><div className="card-header"><h2 className="font-semibold">{title}</h2><button className="btn-icon" onClick={onClose}><X size={16} /></button></div><div className="card-body">{children}</div></div></div>
}
