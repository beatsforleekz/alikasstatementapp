'use client'
import React, { useEffect, useState } from 'react'
import { useRouter, useSearchParams } from 'next/navigation'
import { supabase } from '@/lib/supabase/client'
import { Alert, LoadingSpinner, EmptyState } from '@/components/ui'
import { BookOpen, Plus, Search, RefreshCw, Upload, FileDown, X, Link2, AlertTriangle, Trash2, CheckCircle } from 'lucide-react'
import { isPublishingContractType, type Repertoire } from '@/lib/types'
import { sortByLabel } from '@/lib/utils/sortOptions'

interface PayeeMin { id: string; payee_name: string }

interface ContractMin {
  id: string
  contract_name: string
  contract_code: string | null
  contract_type: string
  status: string
}

// A loaded contract_repertoire_link row, including the share field (royalty_rate)
interface CRLink {
  id: string
  contract_id: string
  royalty_rate: number | null   // NULL = legacy link with no explicit share
  contract: {
    contract_name: string
    contract_code: string | null
    contract_type: string
    status: string
  } | null
}

const PAGE_SIZE = 50

// ── Helpers ───────────────────────────────────────────────────────────────────

const parseShare = (v: string): number | null => {
  if (!v.trim()) return null
  const n = parseFloat(v)
  if (isNaN(n) || n <= 0 || n > 100) return null
  return Math.round(n * 10000) / 1000000   // percent → decimal, 6dp
}

const fmtPct = (v: number | null): string =>
  v == null ? '—' : `${(v * 100).toFixed(2)}%`

// ── Work → Contract Links panel ───────────────────────────────────────────────
// Uses contract_repertoire_links.royalty_rate as the work-level contract share.
// e.g. royalty_rate = 0.5 means this contract receives 50% of the work's income.
// Total across all linked contracts should equal 100%.

function WorkContractLinks({ repertoireId, contracts, onLinksChanged }: {
  repertoireId: string
  contracts: ContractMin[]
  onLinksChanged?: () => void
}) {
  const [linked, setLinked]                     = useState<CRLink[]>([])
  const [payeeShareStatus, setPayeeShareStatus] = useState<Record<string, { activePayeeCount: number; activeShareTotal: number }>>({})
  const [loadingLinks, setLoadingLinks]         = useState(true)
  const [selectedContract, setSelectedContract] = useState('')
  const [shareInput, setShareInput]             = useState('')   // entered as %
  const [editingId, setEditingId]               = useState<string | null>(null)
  const [editShareInput, setEditShareInput]     = useState('')
  const [saving, setSaving]                     = useState(false)
  const [savingEdit, setSavingEdit]             = useState(false)
  const [deleting, setDeleting]                 = useState<string | null>(null)
  const [err, setErr]                           = useState<string | null>(null)

  const fetchLinks = async () => {
    setLoadingLinks(true)
    const { data } = await supabase
      .from('contract_repertoire_links')
      .select('id, contract_id, royalty_rate, contract:contracts(contract_name, contract_code, contract_type, status)')
      .eq('repertoire_id', repertoireId)
    const normalized: CRLink[] = (data ?? []).map((row: any) => ({
      id:           row.id,
      contract_id:  row.contract_id,
      royalty_rate: row.royalty_rate ?? null,
      contract:     Array.isArray(row.contract)
                      ? (row.contract[0] ?? null)
                      : (row.contract ?? null),
    }))
    setLinked(normalized)
    const contractIds = normalized.map(link => link.contract_id)
    if (contractIds.length === 0) {
      setPayeeShareStatus({})
      setLoadingLinks(false)
      return
    }
    const { data: payeeLinkRows } = await supabase
      .from('contract_payee_links')
      .select('contract_id, royalty_share, is_active')
      .in('contract_id', contractIds)
      .eq('is_active', true)
    const nextPayeeShareStatus: Record<string, { activePayeeCount: number; activeShareTotal: number }> = {}
    for (const contractId of contractIds) {
      nextPayeeShareStatus[contractId] = { activePayeeCount: 0, activeShareTotal: 0 }
    }
    for (const row of (payeeLinkRows ?? []) as { contract_id: string; royalty_share: number | null; is_active: boolean }[]) {
      const current = nextPayeeShareStatus[row.contract_id] ?? { activePayeeCount: 0, activeShareTotal: 0 }
      current.activePayeeCount += 1
      current.activeShareTotal += Number(row.royalty_share ?? 0)
      nextPayeeShareStatus[row.contract_id] = current
    }
    setPayeeShareStatus(nextPayeeShareStatus)
    setLoadingLinks(false)
  }

  useEffect(() => { fetchLinks() }, [repertoireId])

  // Validation
  const totalShare = linked.reduce((s, l) => s + (l.royalty_rate ?? 0), 0)
  const totalPct   = Math.round(totalShare * 10000) / 100   // as percentage, 2dp
  const hasNull    = linked.some(l => l.royalty_rate == null)
  const isOver     = totalShare > 1.0005                    // allow tiny float drift
  const isUnder    = !isOver && totalShare < 0.9995 && linked.length > 0
  const isComplete = !hasNull && !isOver && !isUnder
  const contractsWithPayeeWarnings = linked.filter(link => {
    const status = payeeShareStatus[link.contract_id]
    if (!status || status.activePayeeCount === 0) return true
    return status.activeShareTotal > 1.0005 || status.activeShareTotal < 0.9995
  })

  const pubContracts  = sortByLabel(
    contracts.filter(c => c.status === 'active' && isPublishingContractType(c.contract_type)),
    c => `${c.contract_name}${c.contract_code ? ` (${c.contract_code})` : ''}`,
  )
  const linkedIds     = new Set(linked.map(l => l.contract_id))
  const available     = pubContracts.filter(c => !linkedIds.has(c.id))

  const addLink = async () => {
    if (!selectedContract) { setErr('Select a contract.'); return }
    const share = parseShare(shareInput)
    if (share === null) { setErr('Enter a valid share between 0 and 100%.'); return }
    const newTotal = totalShare + share
    if (newTotal > 1.0005) {
      setErr(`Adding ${fmtPct(share)} would bring total to ${fmtPct(newTotal)} — over 100%. Reduce other shares first.`)
      return
    }
    setSaving(true); setErr(null)
    const { error: e } = await supabase.from('contract_repertoire_links').insert({
      repertoire_id: repertoireId,
      contract_id:   selectedContract,
      royalty_rate:  share,
    })
    if (e) { setErr(e.message); setSaving(false); return }
    setSelectedContract('')
    setShareInput('')
    setSaving(false)
    fetchLinks()
    onLinksChanged?.()
  }

  const startEdit = (l: CRLink) => {
    setEditingId(l.id)
    setEditShareInput(l.royalty_rate != null ? (l.royalty_rate * 100).toFixed(2) : '')
    setErr(null)
  }

  const saveEdit = async (l: CRLink) => {
    const share = parseShare(editShareInput)
    if (share === null) { setErr('Enter a valid share between 0 and 100%.'); return }
    const otherTotal = linked.filter(x => x.id !== l.id).reduce((s, x) => s + (x.royalty_rate ?? 0), 0)
    if (otherTotal + share > 1.0005) {
      setErr(`This share would bring total to ${fmtPct(otherTotal + share)} — over 100%.`)
      return
    }
    setSavingEdit(true); setErr(null)
    const { error: e } = await supabase.from('contract_repertoire_links')
      .update({ royalty_rate: share }).eq('id', l.id)
    if (e) { setErr(e.message); setSavingEdit(false); return }
    setSavingEdit(false)
    setEditingId(null)
    fetchLinks()
    onLinksChanged?.()
  }

  const removeLink = async (linkId: string) => {
    setDeleting(linkId)
    await supabase.from('contract_repertoire_links').delete().eq('id', linkId)
    setLinked(ls => ls.filter(x => x.id !== linkId))
    setDeleting(null)
    onLinksChanged?.()
  }

  const s: React.CSSProperties = {
    fontSize: 13, padding: '5px 8px', borderRadius: 6,
    border: '1px solid var(--ops-border)',
    background: 'var(--ops-surface)', color: 'var(--ops-text)',
  }

  return (
    <div style={{ border: '1px solid var(--ops-border)', borderRadius: 8, padding: 14, background: 'var(--ops-surface-2)' }}>

      {/* Header + total indicator */}
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 10 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
          <Link2 size={13} style={{ color: 'var(--ops-muted)' }} />
          <span style={{ fontSize: 11, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.05em', color: 'var(--ops-muted)' }}>
            Publishing Contract Links
          </span>
        </div>
        {linked.length > 0 && (
          <span style={{
            fontSize: 12, fontFamily: 'monospace', fontWeight: 600, padding: '2px 8px', borderRadius: 4,
            background: isOver ? 'rgba(220,38,38,0.15)' : isUnder ? 'rgba(217,119,6,0.15)' : 'rgba(34,197,94,0.12)',
            color: isOver ? 'var(--accent-red)' : isUnder ? 'var(--accent-amber)' : 'var(--accent-green)',
            border: `1px solid ${isOver ? 'rgba(220,38,38,0.3)' : isUnder ? 'rgba(217,119,6,0.3)' : 'rgba(34,197,94,0.25)'}`,
          }}>
            Total: {totalPct.toFixed(2)}%
          </span>
        )}
      </div>

      {err && (
        <div style={{ fontSize: 12, color: 'var(--accent-red)', marginBottom: 8, display: 'flex', alignItems: 'center', gap: 5 }}>
          <AlertTriangle size={12} /> {err}
        </div>
      )}

      {/* Validation warnings */}
      {hasNull && (
        <div style={{ fontSize: 12, color: 'var(--accent-amber)', marginBottom: 8, padding: '6px 10px', borderRadius: 6, border: '1px solid rgba(217,119,6,0.3)', background: 'rgba(217,119,6,0.08)' }}>
          ⚠ One or more links have no share set (legacy links). Set the share % for each before running statements — they will be excluded from allocation until fixed.
        </div>
      )}
      {isOver && (
        <div style={{ fontSize: 12, color: 'var(--accent-red)', marginBottom: 8, padding: '6px 10px', borderRadius: 6, border: '1px solid rgba(220,38,38,0.3)', background: 'rgba(220,38,38,0.08)' }}>
          ✕ Total shares exceed 100% ({totalPct.toFixed(2)}%). This will cause over-allocation. Reduce shares until total ≤ 100%.
        </div>
      )}
      {isUnder && (
        <div style={{ fontSize: 12, color: 'var(--accent-amber)', marginBottom: 8, padding: '6px 10px', borderRadius: 6, border: '1px solid rgba(217,119,6,0.3)', background: 'rgba(217,119,6,0.08)' }}>
          ⚠ Total shares are {totalPct.toFixed(2)}% — under 100%. The remaining {(100 - totalPct).toFixed(2)}% will not be allocated to any contract.
        </div>
      )}
      {isComplete && linked.length > 0 && (
        <div style={{ fontSize: 12, color: 'var(--accent-green)', marginBottom: 8, padding: '4px 10px', borderRadius: 6, border: '1px solid rgba(34,197,94,0.25)', background: 'rgba(34,197,94,0.08)' }}>
          ✓ Shares fully allocated across {linked.length} contract{linked.length !== 1 ? 's' : ''}.
        </div>
      )}
      {contractsWithPayeeWarnings.length > 0 && (
        <div style={{ fontSize: 12, color: 'var(--accent-amber)', marginBottom: 8, padding: '6px 10px', borderRadius: 6, border: '1px solid rgba(217,119,6,0.3)', background: 'rgba(217,119,6,0.08)' }}>
          ⚠ One or more linked contracts still have payee shares missing or not totalling 100%. Review the contract payee setup before relying on statement allocation.
        </div>
      )}

      {/* Linked contracts list */}
      {loadingLinks ? (
        <div style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 12, color: 'var(--ops-muted)', marginBottom: 8 }}>
          <LoadingSpinner size={12} /> Loading…
        </div>
      ) : linked.length === 0 ? (
        <p style={{ fontSize: 12, color: 'var(--ops-subtle)', marginBottom: 10 }}>
          No contracts linked. Add one below to enable statement generation for this work.
        </p>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 4, marginBottom: 12 }}>
          {/* Column headers */}
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 110px auto', gap: 8, fontSize: 10, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.05em', color: 'var(--ops-muted)', paddingBottom: 4, borderBottom: '1px solid var(--ops-border)' }}>
            <span>Contract</span>
            <span style={{ textAlign: 'right' }}>Share %</span>
            <span />
          </div>

          {linked.map(l => (
            <div key={l.id} style={{
              display: 'grid', gridTemplateColumns: '1fr 110px auto', gap: 8, alignItems: 'center',
              padding: '5px 8px', borderRadius: 6,
              border: `1px solid ${l.royalty_rate == null ? 'rgba(217,119,6,0.4)' : 'var(--ops-border)'}`,
              background: l.royalty_rate == null ? 'rgba(217,119,6,0.06)' : 'var(--ops-surface)',
            }}>
              <div style={{ fontSize: 13 }}>
                <span>
                  <span style={{ fontWeight: 500, color: 'var(--ops-text)' }}>{l.contract?.contract_name}</span>
                  {l.contract?.contract_code && (
                    <span style={{ color: 'var(--ops-muted)', marginLeft: 6, fontSize: 11 }}>
                      ({l.contract.contract_code})
                    </span>
                  )}
                  {l.contract?.status && l.contract.status !== 'active' && (
                    <span style={{ color: 'var(--accent-amber)', marginLeft: 6, fontSize: 11 }}>[{l.contract.status}]</span>
                  )}
                </span>
                {(() => {
                  const status = payeeShareStatus[l.contract_id]
                  if (!status || status.activePayeeCount === 0) {
                    return (
                      <div style={{ color: 'var(--accent-amber)', fontSize: 11, marginTop: 2 }}>
                        No active payee linked on this contract yet.
                      </div>
                    )
                  }
                  const payeeSharePct = Math.round(status.activeShareTotal * 10000) / 100
                  if (status.activeShareTotal > 1.0005) {
                    return (
                      <div style={{ color: 'var(--accent-amber)', fontSize: 11, marginTop: 2 }}>
                        Active payee shares total {payeeSharePct.toFixed(2)}% on this contract.
                      </div>
                    )
                  }
                  if (status.activeShareTotal < 0.9995) {
                    return (
                      <div style={{ color: 'var(--accent-amber)', fontSize: 11, marginTop: 2 }}>
                        Active payee shares total {payeeSharePct.toFixed(2)}% on this contract.
                      </div>
                    )
                  }
                  return null
                })()}
              </div>

              {/* Share — inline edit */}
              {editingId === l.id ? (
                <div style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
                  <input
                    type="number" min="0.01" max="100" step="0.01"
                    style={{ ...s, width: 64, fontFamily: 'monospace', textAlign: 'right', padding: '3px 6px' }}
                    value={editShareInput}
                    onChange={e => setEditShareInput(e.target.value)}
                    onKeyDown={e => { if (e.key === 'Enter') saveEdit(l); if (e.key === 'Escape') setEditingId(null) }}
                    autoFocus
                  />
                  <span style={{ fontSize: 11, color: 'var(--ops-muted)' }}>%</span>
                  <button
                    onClick={() => saveEdit(l)}
                    disabled={savingEdit}
                    style={{ background: '#2563eb', border: 'none', borderRadius: 4, color: '#fff', fontSize: 11, padding: '3px 8px', cursor: 'pointer' }}
                  >
                    {savingEdit ? '…' : '✓'}
                  </button>
                  <button
                    onClick={() => setEditingId(null)}
                    style={{ background: 'none', border: 'none', color: 'var(--ops-muted)', cursor: 'pointer', fontSize: 13, padding: 2 }}
                  >✕</button>
                </div>
              ) : (
                <button
                  onClick={() => startEdit(l)}
                  style={{
                    textAlign: 'right', fontFamily: 'monospace', fontSize: 13, fontWeight: 600,
                    background: 'none', border: 'none', cursor: 'pointer',
                    color: l.royalty_rate == null ? 'var(--accent-amber)' : 'var(--ops-text)',
                    padding: '2px 4px', borderRadius: 4,
                    textDecoration: 'underline dotted',
                  }}
                  title="Click to edit share"
                >
                  {l.royalty_rate == null ? 'Set share' : `${(l.royalty_rate * 100).toFixed(2)}%`}
                </button>
              )}

              <button
                onClick={() => removeLink(l.id)}
                disabled={deleting === l.id}
                style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'var(--accent-red)', display: 'flex', alignItems: 'center', padding: 4 }}
                title="Remove link"
              >
                {deleting === l.id ? <LoadingSpinner size={11} /> : <X size={13} />}
              </button>
            </div>
          ))}
        </div>
      )}

      {/* Add new link */}
      {available.length > 0 ? (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 90px 28px auto', gap: 6, alignItems: 'center' }}>
            <select
              style={s}
              value={selectedContract}
              onChange={e => { setSelectedContract(e.target.value); setErr(null) }}
            >
              <option value="">— Select publishing contract —</option>
              {available.map(c => (
                <option key={c.id} value={c.id}>
                  {c.contract_name}{c.contract_code ? ` (${c.contract_code})` : ''}
                </option>
              ))}
            </select>
            <input
              type="number" min="0.01" max="100" step="0.01"
              placeholder={linked.length === 0 ? '100' : String(Math.max(0, 100 - totalPct).toFixed(2))}
              style={{ ...s, fontFamily: 'monospace', textAlign: 'right' }}
              value={shareInput}
              onChange={e => { setShareInput(e.target.value); setErr(null) }}
              title="Share as percentage (e.g. 50 = 50%)"
            />
            <span style={{ fontSize: 12, color: 'var(--ops-muted)' }}>%</span>
            <button
              onClick={addLink}
              disabled={saving || !selectedContract || !shareInput}
              style={{
                padding: '5px 12px', borderRadius: 6, fontSize: 13,
                background: saving || !selectedContract || !shareInput ? 'var(--ops-surface-2)' : '#2563eb',
                color: saving || !selectedContract || !shareInput ? 'var(--ops-muted)' : '#fff',
                border: '1px solid var(--ops-border)',
                cursor: saving || !selectedContract || !shareInput ? 'not-allowed' : 'pointer',
                whiteSpace: 'nowrap', display: 'flex', alignItems: 'center', gap: 4,
              }}
            >
              {saving ? <LoadingSpinner size={12} /> : <Link2 size={12} />}
              Add
            </button>
          </div>
          {linked.length > 0 && (
            <p style={{ fontSize: 11, color: 'var(--ops-subtle)' }}>
              Remaining to allocate: <span style={{ fontFamily: 'monospace', fontWeight: 600 }}>{Math.max(0, 100 - totalPct).toFixed(2)}%</span>
            </p>
          )}
        </div>
      ) : (
        <p style={{ fontSize: 11, color: 'var(--ops-subtle)' }}>
          {pubContracts.length === 0
            ? 'No active publishing contracts found. Create one in Payees & Contracts first.'
            : 'All active publishing contracts are already linked to this work.'}
        </p>
      )}

      <p style={{ fontSize: 11, color: 'var(--ops-subtle)', marginTop: 10 }}>
        Share (%) determines how this work's income is split across linked contracts before payee splits are applied.
        Only active publishing contracts shown.
        Links with no share set are excluded from statement allocation until fixed.
      </p>
    </div>
  )
}

// ── Bulk Link Contracts Modal ─────────────────────────────────────────────────
// Applies the same contract/share set to multiple selected works at once.

type BulkContractRow = { contractId: string; share: string }

function BulkLinkContractsModal({
  selectedItems,
  contracts,
  onClose,
  onSaved,
}: {
  selectedItems: (Repertoire & { linked_payee: PayeeMin | null })[]
  contracts: ContractMin[]
  onClose: () => void
  onSaved: (linkedWorkIds: string[]) => void
}) {
  const pubContracts = sortByLabel(
    contracts.filter(c => c.status === 'active' && isPublishingContractType(c.contract_type)),
    c => `${c.contract_name}${c.contract_code ? ` (${c.contract_code})` : ''}`,
  )

  // Contract rows to apply
  const [rows, setRows] = useState<BulkContractRow[]>([{ contractId: '', share: '' }])

  // Per-item existing link counts (loaded on mount)
  type ItemInfo = { id: string; title: string; existingCount: number }
  const [itemInfos, setItemInfos] = useState<ItemInfo[]>([])
  const [loadingCheck, setLoadingCheck] = useState(true)

  // Mode: append (safe) or replace
  const [mode, setMode] = useState<'append' | 'replace'>('append')

  const [saving, setSaving] = useState(false)
  const [result, setResult] = useState<{ saved: number; skipped: number } | null>(null)
  const [err, setErr] = useState<string | null>(null)

  // Load existing link counts for selected works
  useEffect(() => {
    async function check() {
      setLoadingCheck(true)
      const ids = selectedItems.map(r => r.id)
      const { data } = await supabase
        .from('contract_repertoire_links')
        .select('repertoire_id')
        .in('repertoire_id', ids)
      const counts: Record<string, number> = {}
      for (const row of (data ?? [])) {
        counts[row.repertoire_id] = (counts[row.repertoire_id] ?? 0) + 1
      }
      setItemInfos(selectedItems.map(r => ({
        id: r.id,
        title: r.title,
        existingCount: counts[r.id] ?? 0,
      })))
      setLoadingCheck(false)
    }
    check()
  }, [])

  const addRow = () => setRows(prev => [...prev, { contractId: '', share: '' }])
  const removeRow = (i: number) => setRows(prev => prev.length === 1 ? prev : prev.filter((_, j) => j !== i))
  const updateRow = (i: number, key: keyof BulkContractRow, val: string) =>
    setRows(prev => prev.map((r, j) => j === i ? { ...r, [key]: val } : r))

  // Derived validation
  const usedContractIds = new Set(rows.map(r => r.contractId).filter(Boolean))
  const totalShareNum = rows.reduce((s, r) => {
    const n = parseFloat(r.share)
    return s + (isNaN(n) ? 0 : n)
  }, 0)
  const totalShareDecimal = Math.round(totalShareNum * 10000) / 1000000
  const shareOver  = totalShareDecimal > 1.0005
  const shareUnder = !shareOver && totalShareDecimal < 0.9995 && rows.some(r => r.share.trim())

  const itemsWithExisting = itemInfos.filter(i => i.existingCount > 0)
  const showWarning = itemsWithExisting.length > 0

  // Selected contract ids that are already linked to at least one selected work
  // (only relevant for append mode to skip duplicates)

  async function handleSave() {
    // Validate rows
    const validRows = rows.filter(r => r.contractId && r.share.trim())
    if (validRows.length === 0) { setErr('Add at least one contract with a share.'); return }

    for (const r of validRows) {
      const parsed = parseShare(r.share)
      if (parsed === null) { setErr(`Invalid share "${r.share}" — must be between 0 and 100.`); return }
    }

    // Check for duplicate contracts within the bulk set
    const contractIds = validRows.map(r => r.contractId)
    if (new Set(contractIds).size !== contractIds.length) {
      setErr('Duplicate contracts in the list — each contract can appear only once.')
      return
    }

    setSaving(true)
    setErr(null)

    let saved = 0
    let skipped = 0

    for (const item of itemInfos) {
      if (mode === 'replace' && item.existingCount > 0) {
        // Delete all existing links for this work
        await supabase.from('contract_repertoire_links').delete().eq('repertoire_id', item.id)
      }

      // Fetch current links (after possible deletion) to avoid duplication in append mode
      const { data: currentLinks } = await supabase
        .from('contract_repertoire_links')
        .select('contract_id')
        .eq('repertoire_id', item.id)
      const existingContractIds = new Set((currentLinks ?? []).map((l: any) => l.contract_id))

      for (const r of validRows) {
        if (mode === 'append' && existingContractIds.has(r.contractId)) {
          skipped++
          continue
        }
        const share = parseShare(r.share)!
        const { error: e } = await supabase.from('contract_repertoire_links').insert({
          repertoire_id: item.id,
          contract_id:   r.contractId,
          royalty_rate:  share,
        })
        if (!e) saved++
        else skipped++
      }
    }

    setSaving(false)
    setResult({ saved, skipped })
    onSaved(itemInfos.map(item => item.id))
  }

  const inputStyle: React.CSSProperties = {
    fontSize: 13, padding: '5px 8px', borderRadius: 6,
    border: '1px solid var(--ops-border)',
    background: 'var(--ops-surface)', color: 'var(--ops-text)',
  }

  return (
    <div className="fixed inset-0 bg-black/70 z-50 flex items-center justify-center p-4">
      <div className="bg-ops-surface border border-ops-border rounded-xl w-full max-w-2xl max-h-[90vh] flex flex-col">

        {/* Header */}
        <div className="flex items-center justify-between p-4 border-b border-ops-border flex-shrink-0">
          <div>
            <span className="font-semibold">Bulk Link Contracts</span>
            <span className="ml-2 text-xs text-ops-muted">
              Applying to {selectedItems.length} work{selectedItems.length !== 1 ? 's' : ''}
            </span>
          </div>
          <button onClick={onClose} className="btn-ghost btn-sm"><X size={14} /></button>
        </div>

        <div className="flex-1 overflow-y-auto p-4 space-y-4">

          {err && <Alert type="error">{err}</Alert>}
          {result && (
            <Alert type="success">
              {result.saved} link{result.saved !== 1 ? 's' : ''} created
              {result.skipped > 0 ? `, ${result.skipped} skipped (already linked or error)` : ''}. Closing…
            </Alert>
          )}

          {/* Selected works summary */}
          <div>
            <div className="text-xs font-semibold text-ops-muted uppercase tracking-wider mb-2">
              Selected works ({selectedItems.length})
            </div>
            <div className="rounded border text-xs divide-y" style={{ borderColor: 'var(--ops-border)', background: 'var(--ops-surface-2)' }}>
              {loadingCheck ? (
                <div className="flex items-center gap-2 px-3 py-2 text-ops-muted">
                  <LoadingSpinner size={12} /> Checking existing links…
                </div>
              ) : itemInfos.map(item => (
                <div key={item.id} className="flex items-center justify-between px-3 py-1.5">
                  <span style={{ color: 'var(--ops-text)' }}>{item.title}</span>
                  {item.existingCount > 0 ? (
                    <span style={{ color: 'var(--accent-amber)', fontFamily: 'monospace', fontSize: 11 }}>
                      {item.existingCount} existing link{item.existingCount !== 1 ? 's' : ''}
                    </span>
                  ) : (
                    <span style={{ color: 'var(--ops-subtle)', fontSize: 11 }}>no links</span>
                  )}
                </div>
              ))}
            </div>
          </div>

          {/* Warning for works with existing links */}
          {!loadingCheck && showWarning && (
            <div style={{ fontSize: 12, color: 'var(--accent-amber)', padding: '8px 12px', borderRadius: 6, border: '1px solid rgba(217,119,6,0.35)', background: 'rgba(217,119,6,0.08)', display: 'flex', gap: 8, alignItems: 'flex-start' }}>
              <AlertTriangle size={13} style={{ marginTop: 1, flexShrink: 0 }} />
              <div>
                <strong>{itemsWithExisting.length} of {selectedItems.length} works</strong> already have contract links.
                Choose how to handle them below.
              </div>
            </div>
          )}

          {/* Append vs Replace mode */}
          {!loadingCheck && showWarning && (
            <div>
              <div className="text-xs font-semibold text-ops-muted uppercase tracking-wider mb-2">Behaviour</div>
              <div className="flex flex-col gap-2">
                <label className="flex items-start gap-2 cursor-pointer text-sm" style={{ color: 'var(--ops-text)' }}>
                  <input
                    type="radio"
                    name="bulk-mode"
                    value="append"
                    checked={mode === 'append'}
                    onChange={() => setMode('append')}
                    style={{ marginTop: 2 }}
                  />
                  <div>
                    <span className="font-medium">Append</span>
                    <span className="block text-xs mt-0.5" style={{ color: 'var(--ops-muted)' }}>
                      Add only the new contracts. Skip any contract that is already linked to a given work. Safe and non-destructive.
                    </span>
                  </div>
                </label>
                <label className="flex items-start gap-2 cursor-pointer text-sm" style={{ color: 'var(--ops-text)' }}>
                  <input
                    type="radio"
                    name="bulk-mode"
                    value="replace"
                    checked={mode === 'replace'}
                    onChange={() => setMode('replace')}
                    style={{ marginTop: 2 }}
                  />
                  <div>
                    <span className="font-medium">Replace</span>
                    <span className="block text-xs mt-0.5" style={{ color: 'var(--accent-red)' }}>
                      Delete all existing contract links for the selected works, then apply the new set. Cannot be undone.
                    </span>
                  </div>
                </label>
              </div>
            </div>
          )}

          {/* Contract rows to apply */}
          <div>
            <div className="text-xs font-semibold text-ops-muted uppercase tracking-wider mb-2">
              Contracts to apply
            </div>

            {pubContracts.length === 0 ? (
              <p className="text-xs text-ops-muted">No active publishing contracts found.</p>
            ) : (
              <div className="flex flex-col gap-2">
                {rows.map((row, i) => {
                  const isDuplicate = row.contractId && rows.some((r, j) => j !== i && r.contractId === row.contractId)
                  const availableForRow = pubContracts.filter(c =>
                    c.id === row.contractId || !usedContractIds.has(c.id)
                  )
                  return (
                    <div key={i} style={{ display: 'grid', gridTemplateColumns: '1fr 90px 24px 28px', gap: 6, alignItems: 'center' }}>
                      <select
                        style={{ ...inputStyle, borderColor: isDuplicate ? 'var(--accent-red)' : 'var(--ops-border)' }}
                        value={row.contractId}
                        onChange={e => updateRow(i, 'contractId', e.target.value)}
                      >
                        <option value="">— Select contract —</option>
                        {availableForRow.map(c => (
                          <option key={c.id} value={c.id}>
                            {c.contract_name}{c.contract_code ? ` (${c.contract_code})` : ''}
                          </option>
                        ))}
                      </select>
                      <input
                        type="number" min="0.01" max="100" step="0.01"
                        placeholder="share"
                        style={{ ...inputStyle, fontFamily: 'monospace', textAlign: 'right' }}
                        value={row.share}
                        onChange={e => updateRow(i, 'share', e.target.value)}
                      />
                      <span style={{ fontSize: 12, color: 'var(--ops-muted)' }}>%</span>
                      <button
                        onClick={() => removeRow(i)}
                        disabled={rows.length === 1}
                        style={{ background: 'none', border: 'none', cursor: rows.length === 1 ? 'not-allowed' : 'pointer', color: 'var(--accent-red)', display: 'flex', alignItems: 'center', opacity: rows.length === 1 ? 0.3 : 1 }}
                        title="Remove this row"
                      >
                        <X size={13} />
                      </button>
                    </div>
                  )
                })}

                {/* Share total indicator */}
                <div className="flex items-center justify-between">
                  <button
                    onClick={addRow}
                    disabled={rows.length >= pubContracts.length}
                    className="btn-ghost btn-sm flex items-center gap-1"
                    style={{ fontSize: 12 }}
                  >
                    <Plus size={12} /> Add contract
                  </button>
                  {rows.some(r => r.share.trim()) && (
                    <span style={{
                      fontSize: 12, fontFamily: 'monospace', fontWeight: 600, padding: '2px 8px', borderRadius: 4,
                      background: shareOver ? 'rgba(220,38,38,0.15)' : shareUnder ? 'rgba(217,119,6,0.15)' : 'rgba(34,197,94,0.12)',
                      color: shareOver ? 'var(--accent-red)' : shareUnder ? 'var(--accent-amber)' : 'var(--accent-green)',
                      border: `1px solid ${shareOver ? 'rgba(220,38,38,0.3)' : shareUnder ? 'rgba(217,119,6,0.3)' : 'rgba(34,197,94,0.25)'}`,
                    }}>
                      Total: {totalShareNum.toFixed(2)}%
                    </span>
                  )}
                </div>

                {shareOver && (
                  <p style={{ fontSize: 12, color: 'var(--accent-red)' }}>
                    ✕ Total shares exceed 100%. Adjust before applying.
                  </p>
                )}
                {shareUnder && (
                  <p style={{ fontSize: 12, color: 'var(--accent-amber)' }}>
                    ⚠ Total shares are under 100% — {(100 - totalShareNum).toFixed(2)}% will be unallocated for each work.
                  </p>
                )}
              </div>
            )}
          </div>

        </div>

        {/* Footer */}
        <div className="flex items-center justify-between gap-3 p-4 border-t border-ops-border flex-shrink-0">
          <span className="text-xs text-ops-muted">
            {mode === 'replace' && showWarning
              ? `⚠ Replace mode: existing links on ${itemsWithExisting.length} work${itemsWithExisting.length !== 1 ? 's' : ''} will be deleted first`
              : `Append mode: existing links will be preserved`
            }
          </span>
          <div className="flex items-center gap-2">
            <button className="btn-secondary btn-sm" onClick={onClose} disabled={saving}>Cancel</button>
            <button
              className="btn-primary btn-sm flex items-center gap-1.5"
              onClick={handleSave}
              disabled={saving || loadingCheck || shareOver || result !== null || pubContracts.length === 0}
            >
              {saving
                ? <><LoadingSpinner size={13} /> Applying…</>
                : <><CheckCircle size={13} /> Apply to {selectedItems.length} work{selectedItems.length !== 1 ? 's' : ''}</>
              }
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}

// ── Main page ─────────────────────────────────────────────────────────────────

export default function RepertoirePage() {
  const searchParams = useSearchParams()
  const router = useRouter()
  const [loading, setLoading]               = useState(true)
  const [repertoire, setRepertoire]         = useState<(Repertoire & { linked_payee: PayeeMin | null })[]>([])
  const [totalCount, setTotalCount]         = useState(0)
  const [payees, setPayees]                 = useState<PayeeMin[]>([])
  const [contracts, setContracts]           = useState<ContractMin[]>([])
  const [search, setSearch]                 = useState('')
  const [typeFilter, setTypeFilter]         = useState('')
  const [draftFilter, setDraftFilter]       = useState('')
  const [currentPage, setCurrentPage]       = useState(1)
  const [showForm, setShowForm]               = useState(false)
  const [showCatalogueImport, setShowCatalogueImport] = useState(false)
  const [editingItem, setEditingItem]         = useState<Repertoire | null>(null)
  const [prefillRow, setPrefillRow]           = useState<any | null>(null)
  const [error, setError]                   = useState<string | null>(null)
  const [contractLinkCounts, setContractLinkCounts] = useState<Record<string, number>>({})
  // Task 2: delete state
  const [deletingId, setDeletingId]         = useState<string | null>(null)
  const [confirmDelete, setConfirmDelete]   = useState<(Repertoire & { linked_payee: PayeeMin | null }) | null>(null)
  const [deleteError, setDeleteError]       = useState<string | null>(null)
  // Bulk selection
  const [selectedIds, setSelectedIds]       = useState<Set<string>>(new Set())
  const [showBulkLink, setShowBulkLink]     = useState(false)

  useEffect(() => { void loadReferenceData() }, [])
  useEffect(() => { void loadPage() }, [currentPage, search, typeFilter, draftFilter])
  useEffect(() => {
    const nextTotalPages = Math.max(1, Math.ceil(totalCount / PAGE_SIZE))
    if (currentPage > nextTotalPages) setCurrentPage(nextTotalPages)
  }, [currentPage, totalCount])

  useEffect(() => {
    const editId = searchParams.get('edit') ?? searchParams.get('focus')
    if (!editId || showForm) return

    const target = repertoire.find(item => item.id === editId)
    const openTarget = async () => {
      const resolved = target ?? (((await supabase
        .from('repertoire')
        .select('*')
        .eq('id', editId)
        .single()).data as Repertoire | null) ?? null)
      if (!resolved) return

      setEditingItem(resolved)
      setPrefillRow(null)
      setShowForm(true)

      const nextParams = new URLSearchParams(searchParams.toString())
      nextParams.delete('edit')
      nextParams.delete('focus')
      const next = nextParams.toString()
      router.replace(next ? `/repertoire?${next}` : '/repertoire', { scroll: false })
    }

    void openTarget()
  }, [searchParams, repertoire, showForm, router])

  const reloadCounts = async (ids = repertoire.map(item => item.id)) => {
    if (ids.length === 0) {
      setContractLinkCounts({})
      return
    }
    // Query all links from DB directly — do not rely on the repertoire state
    // closure which may be stale when called from inside a child component's
    // onLinksChanged callback. Fetching all links and building counts from the
    // current page result ensures the list always reflects the real DB state.
    const { data: linkData } = await supabase
      .from('contract_repertoire_links')
      .select('repertoire_id')
      .in('repertoire_id', ids)
    const counts: Record<string, number> = {}
    for (const row of (linkData ?? [])) {
      counts[row.repertoire_id] = (counts[row.repertoire_id] ?? 0) + 1
    }
    setContractLinkCounts(counts)
  }

  const applyFilters = (query: any) => {
    let next = query
    if (typeFilter) next = next.eq('repertoire_type', typeFilter)
    if (draftFilter === 'draft') next = next.eq('draft_status', 'draft')
    if (draftFilter === 'needs_linking') next = next.eq('draft_status', 'needs_linking')
    if (search.trim()) {
      const q = search.trim().replace(/,/g, ' ')
      next = next.or([
        `title.ilike.%${q}%`,
        `isrc.ilike.%${q}%`,
        `iswc.ilike.%${q}%`,
        `upc.ilike.%${q}%`,
        `artist_name.ilike.%${q}%`,
        `writer_name.ilike.%${q}%`,
        `internal_code.ilike.%${q}%`,
        `tempo_id.ilike.%${q}%`,
      ].join(','))
    }
    return next
  }

  const loadReferenceData = async () => {
    const [payeeRes, contractRes] = await Promise.all([
      supabase.from('payees').select('id, payee_name').order('payee_name'),
      supabase.from('contracts').select('id, contract_name, contract_code, contract_type, status').order('contract_name'),
    ])
    setPayees(sortByLabel(payeeRes.data ?? [], payee => payee.payee_name))
    setContracts(sortByLabel(contractRes.data ?? [], contract => `${contract.contract_name}${contract.contract_code ? ` (${contract.contract_code})` : ''}`))
  }

  const loadPage = async (page = currentPage) => {
    setLoading(true)
    const from = (page - 1) * PAGE_SIZE
    const to = from + PAGE_SIZE - 1
    const repQuery = applyFilters(
      supabase
        .from('repertoire')
        .select('*, linked_payee:payees(id, payee_name)', { count: 'exact' })
        .order('title')
    )
    const { data: repData, count, error: repErr } = await repQuery.range(from, to)
    if (repErr) {
      setError(repErr.message)
      setRepertoire([])
      setTotalCount(0)
      setContractLinkCounts({})
      setLoading(false)
      return
    }

    const rows = (repData ?? []) as (Repertoire & { linked_payee: PayeeMin | null })[]
    setRepertoire(rows)
    setTotalCount(count ?? 0)
    await reloadCounts(rows.map(row => row.id))
    setLoading(false)
  }

  const filtered = repertoire
  const filteredWorks = filtered.filter(r => r.repertoire_type === 'work')
  const allFilteredSelected = filtered.length > 0 && filtered.every(r => selectedIds.has(r.id))
  const someSelected = selectedIds.size > 0

  const toggleSelect = (id: string) => {
    setSelectedIds(prev => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  const toggleSelectAllVisible = () => {
    if (allFilteredSelected) {
      setSelectedIds(prev => {
        const next = new Set(prev)
        filtered.forEach(r => next.delete(r.id))
        return next
      })
    } else {
      setSelectedIds(prev => {
        const next = new Set(prev)
        filtered.forEach(r => next.add(r.id))
        return next
      })
    }
  }

  // No programmatic navigation to /exceptions exists in this file.
  // The only link to exceptions opens in a new tab (target="_blank") so users
  // are never redirected away from their current repertoire/contract workflow.
  // If unexpected navigation to Exceptions is still observed, the cause is
  // outside this file (e.g. layout-level redirect, middleware, or browser back).
  const openEdit = (r: Repertoire) => { setEditingItem(r); setPrefillRow(null); setShowForm(true) }

  // Task 2: delete handler
  const handleDeleteConfirmed = async () => {
    if (!confirmDelete) return
    setDeletingId(confirmDelete.id)
    setDeleteError(null)

    // Check for dependent import_rows
    const { count: rowCount } = await supabase
      .from('import_rows')
      .select('id', { count: 'exact', head: true })
      .eq('matched_repertoire_id', confirmDelete.id)

    if (rowCount && rowCount > 0) {
      setDeleteError(
        `Cannot delete "${confirmDelete.title}" — it is matched to ${rowCount} import row${rowCount !== 1 ? 's' : ''}. ` +
        `Remove those matches first or re-run matching before deleting.`
      )
      setDeletingId(null)
      return
    }

    const linkedContracts = contractLinkCounts[confirmDelete.id] ?? 0
    if (linkedContracts > 0) {
      setDeleteError(
        `Cannot delete "${confirmDelete.title}" — it is linked to ${linkedContracts} contract${linkedContracts !== 1 ? 's' : ''}. Remove linked data first.`
      )
      setDeletingId(null)
      return
    }

    // Delete the repertoire record
    const { error: delErr } = await supabase.from('repertoire').delete().eq('id', confirmDelete.id)
    if (delErr) {
      setDeleteError(delErr.message)
      setDeletingId(null)
      return
    }

    setRepertoire(prev => prev.filter(r => r.id !== confirmDelete.id))
    setConfirmDelete(null)
    setDeletingId(null)
  }

  const selectedWorkItems = repertoire.filter(r => selectedIds.has(r.id) && r.repertoire_type === 'work')
  const totalPages = Math.max(1, Math.ceil(totalCount / PAGE_SIZE))
  const pageStart = totalCount === 0 ? 0 : (currentPage - 1) * PAGE_SIZE + 1
  const pageEnd = totalCount === 0 ? 0 : pageStart + filtered.length - 1

  const handleBulkDelete = async () => {
    const ids = Array.from(selectedIds)
    if (ids.length === 0) return

    const blockedByLinks = filtered.filter(r => selectedIds.has(r.id) && (contractLinkCounts[r.id] ?? 0) > 0)
    if (blockedByLinks.length > 0) {
      setError(`Cannot delete selected repertoire: ${blockedByLinks.length} item${blockedByLinks.length !== 1 ? 's are' : ' is'} linked to contracts. Remove linked data first.`)
      return
    }

    const { data: matchedRows } = await supabase
      .from('import_rows')
      .select('matched_repertoire_id')
      .in('matched_repertoire_id', ids)

    const matchedIds = new Set((matchedRows ?? []).map((row: any) => row.matched_repertoire_id).filter(Boolean))
    if (matchedIds.size > 0) {
      setError(`Cannot delete selected repertoire: ${matchedIds.size} item${matchedIds.size !== 1 ? 's are' : ' is'} still matched to import rows. Remove linked data first.`)
      return
    }

    if (!confirm(`Delete ${ids.length} selected repertoire record${ids.length !== 1 ? 's' : ''}? This cannot be undone.`)) return

    setDeletingId('__bulk__')
    const { error: delErr } = await supabase.from('repertoire').delete().in('id', ids)
    if (delErr) {
      setError(delErr.message)
      setDeletingId(null)
      return
    }
    setRepertoire(prev => prev.filter(r => !selectedIds.has(r.id)))
    setSelectedIds(new Set())
    setDeletingId(null)
  }

  return (
    <div className="space-y-4">
      <div className="page-header">
        <div>
          <h1 className="page-title">Repertoire</h1>
          <p className="page-subtitle">
            {totalCount === 0
              ? '0 total items'
              : `Showing ${pageStart}-${pageEnd} of ${totalCount} items · tracks, releases, works`}
          </p>
        </div>
        <div className="flex gap-2 items-center">
          {someSelected && (
            <>
              {selectedWorkItems.length > 0 && (
                <button
                  onClick={() => setShowBulkLink(true)}
                  className="btn-secondary flex items-center gap-1.5"
                  style={{ borderColor: 'rgba(37,99,235,0.5)', color: '#60a5fa' }}
                >
                  <Link2 size={14} />
                  Assign Contract to Selected ({selectedWorkItems.length})
                </button>
              )}
              <button
                onClick={handleBulkDelete}
                className="btn-ghost flex items-center gap-1.5"
                style={{ color: 'var(--accent-red)' }}
                disabled={deletingId === '__bulk__'}
              >
                {deletingId === '__bulk__' ? <LoadingSpinner size={13} /> : <Trash2 size={14} />}
                Delete selected ({selectedIds.size})
              </button>
            </>
          )}
          <button onClick={() => setShowCatalogueImport(true)} className="btn-secondary flex items-center gap-1.5">
            <Upload size={14} /> Bulk Import
          </button>
          <button onClick={() => { setEditingItem(null); setPrefillRow(null); setShowForm(true) }} className="btn-primary flex items-center gap-1.5">
            <Plus size={14} /> Add Item
          </button>
        </div>
      </div>

      {error && <Alert type="error">{error}</Alert>}

      {/* Filters */}
      <div className="card p-3 flex items-center gap-2 flex-wrap">
        <div className="relative">
          <Search size={13} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-ops-muted" />
          <input className="ops-input pl-8 w-64" placeholder="Search title, Tempo ID, ISWC, ISRC, UPC, artist…"
            value={search}
            onChange={e => {
              setSearch(e.target.value)
              setCurrentPage(1)
              setSelectedIds(new Set())
            }} />
        </div>
        <select className="ops-select w-36" value={typeFilter} onChange={e => {
          setTypeFilter(e.target.value)
          setCurrentPage(1)
          setSelectedIds(new Set())
        }}>
          <option value="">All types</option>
          <option value="release">Releases</option>
          <option value="track">Tracks</option>
          <option value="work">Works (Publishing)</option>
        </select>
        <select className="ops-select w-40" value={draftFilter} onChange={e => {
          setDraftFilter(e.target.value)
          setCurrentPage(1)
          setSelectedIds(new Set())
        }}>
          <option value="">All statuses</option>
          <option value="draft">Draft only</option>
          <option value="needs_linking">Needs linking</option>
        </select>
        <button onClick={() => void loadPage()} className="btn-ghost btn-sm"><RefreshCw size={13} /></button>
        {someSelected && (
          <button
            className="btn-ghost btn-sm text-ops-muted ml-auto"
            onClick={() => setSelectedIds(new Set())}
          >
            Clear selection ({selectedIds.size})
          </button>
        )}
      </div>

      {/* Bulk selection hint */}
      {filteredWorks.length > 0 && !someSelected && (
        <p className="text-xs text-ops-muted px-1">
          Check rows in the table to select them for bulk actions. Contract linking only applies to selected works.
        </p>
      )}

      {/* Repertoire table */}
      <div className="card">
        {loading ? (
          <div className="flex justify-center py-16"><LoadingSpinner size={22} /></div>
        ) : filtered.length === 0 ? (
          <EmptyState title="No repertoire found" icon={BookOpen} description="Add tracks, releases, and works" />
        ) : (
          <div className="overflow-x-auto">
            <table className="ops-table">
              <thead>
                <tr>
                  {/* Checkbox column — header selects all visible items */}
                  <th style={{ width: 32 }}>
                    {filtered.length > 0 && (
                      <input
                        type="checkbox"
                        checked={allFilteredSelected}
                        onChange={toggleSelectAllVisible}
                        title="Select / deselect all visible rows"
                      />
                    )}
                  </th>
                  {/* Task 1: Removed "Linked Payee" column — payee allocation is handled via contract links */}
                  <th style={{ width: 36, color: 'var(--ops-subtle)' }}>#</th>
                  <th>Type</th><th>Title</th><th>Artist / Writer</th>
                  <th>Tempo ID</th><th>ISWC</th><th>ISRC</th><th>UPC</th><th>Code</th>
                  <th>Contracts</th><th>Status</th><th></th>
                </tr>
              </thead>
              <tbody>
                {filtered.map((r, rowIdx) => {
                  const isWork = r.repertoire_type === 'work'
                  const isSelected = selectedIds.has(r.id)
                  return (
                    <tr
                      key={r.id}
                      onClick={() => openEdit(r)}
                      style={{
                        cursor: 'pointer',
                        background: isSelected ? 'rgba(37,99,235,0.07)' : undefined,
                      }}
                      title="Click to edit"
                    >
                      <td onClick={e => e.stopPropagation()}>
                        <input
                          type="checkbox"
                          checked={isSelected}
                          onChange={() => toggleSelect(r.id)}
                        />
                      </td>
                      <td className="font-mono text-ops-subtle" style={{ fontSize: 11, textAlign: 'right', paddingRight: 8 }}>{pageStart + rowIdx}</td>
                      <td onClick={e => e.stopPropagation()}>
                        <span className={`badge ${r.repertoire_type === 'track' ? 'badge-master' : r.repertoire_type === 'release' ? 'badge-publishing' : 'badge-info'}`}>
                          {r.repertoire_type}
                        </span>
                      </td>
                      <td className="text-xs font-medium">
                        {r.title}
                        {(r.draft_status === 'draft' || r.draft_status === 'needs_linking') && (
                          <span className="ml-1 badge badge-pending text-[10px]">
                            {r.draft_status === 'draft' ? 'Draft' : 'Needs Linking'}
                          </span>
                        )}
                      </td>
                      <td className="text-xs text-ops-muted">
                        {r.artist_name && <div>{r.artist_name}</div>}
                        {r.writer_name && <div className="text-ops-subtle">{r.writer_name}</div>}
                      </td>
                      <td className="font-mono text-xs">
                        {(r as any).tempo_id
                          ? <span className="text-cyan-400">{(r as any).tempo_id}</span>
                          : <span className="text-ops-muted">—</span>}
                      </td>
                      <td className="font-mono text-xs">
                        {r.iswc ? <span className="text-blue-400">{r.iswc}</span> : <span className="text-ops-muted">—</span>}
                      </td>
                      <td className="font-mono text-xs text-ops-muted">{r.isrc ?? '—'}</td>
                      <td className="font-mono text-xs text-ops-muted">{r.upc ?? '—'}</td>
                      <td className="font-mono text-xs text-ops-subtle">{r.internal_code ?? '—'}</td>
                      <td className="text-xs">
                        {r.repertoire_type === 'work' ? (() => {
                          const n = contractLinkCounts[r.id] ?? 0
                          if (n === 0) return (
                            <span style={{ display: 'flex', alignItems: 'center', gap: 4, color: 'var(--ops-muted)', fontSize: 11 }}>
                              <Link2 size={10} /> <span style={{ color: 'var(--ops-subtle)' }}>0 linked</span>
                            </span>
                          )
                          if (n === 1) return (
                            <span style={{ display: 'flex', alignItems: 'center', gap: 4, color: 'var(--accent-green)', fontSize: 11 }}>
                              <Link2 size={10} /> 1 linked
                            </span>
                          )
                          return (
                            <span style={{ display: 'flex', alignItems: 'center', gap: 4, color: 'var(--accent-green)', fontSize: 11, fontWeight: 600 }}>
                              <Link2 size={10} /> {n} linked
                            </span>
                          )
                        })() : <span className="text-ops-subtle">—</span>}
                      </td>
                      <td>
                        <span className={`badge ${r.active_status ? 'badge-approved' : 'badge-pending'}`}>
                          {r.active_status ? 'Active' : 'Inactive'}
                        </span>
                      </td>
                      {/* Task 2: Delete action */}
                      <td onClick={e => e.stopPropagation()}>
                        <button
                          className="btn-ghost btn-sm"
                          title="Delete this record"
                          onClick={() => { setDeleteError(null); setConfirmDelete(r) }}
                        >
                          <Trash2 size={13} className="text-red-400" />
                        </button>
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
            {/* Record count footer — makes clear how many records exist and are shown, no silent cap */}
            <div className="px-3 py-2 border-t text-xs text-ops-muted flex items-center justify-between gap-3 flex-wrap" style={{ borderColor: 'var(--ops-border)' }}>
              <span>
                {totalCount === 0
                  ? '0 records'
                  : <>Showing {pageStart}-{pageEnd} of {totalCount} record{totalCount !== 1 ? 's' : ''}</>
                }
              </span>
              <div className="flex items-center gap-2">
                <button
                  className="btn-ghost btn-sm"
                  onClick={() => setCurrentPage(page => Math.max(1, page - 1))}
                  disabled={currentPage === 1}
                >
                  Previous
                </button>
                <span className="text-ops-subtle">Page {totalPages === 0 ? 0 : currentPage} of {totalPages}</span>
                <button
                  className="btn-ghost btn-sm"
                  onClick={() => setCurrentPage(page => Math.min(totalPages, page + 1))}
                  disabled={currentPage >= totalPages}
                >
                  Next
                </button>
              </div>
            </div>
          </div>
        )}
      </div>

      {/* Task 2: Delete confirmation modal */}
      {confirmDelete && (
        <div className="fixed inset-0 bg-black/70 z-50 flex items-center justify-center p-4">
          <div className="bg-ops-surface border border-ops-border rounded-xl w-full max-w-md p-5 space-y-4">
            <div className="flex items-center gap-2 text-red-400">
              <Trash2 size={16} />
              <span className="font-semibold">Delete Repertoire Record</span>
            </div>
            <p className="text-sm text-ops-text">
              Delete <span className="font-semibold">"{confirmDelete.title}"</span>?
              {confirmDelete.repertoire_type === 'work' && (
                <span className="block mt-1 text-ops-muted text-xs">
                  This work cannot be deleted while contract links or matched import rows still exist.
                </span>
              )}
            </p>
            {deleteError && (
              <Alert type="error">{deleteError}</Alert>
            )}
            <div className="flex justify-end gap-2">
              <button
                className="btn-secondary"
                onClick={() => { setConfirmDelete(null); setDeleteError(null) }}
                disabled={!!deletingId}
              >
                Cancel
              </button>
              <button
                className="btn-primary bg-red-600 hover:bg-red-700 border-red-600"
                onClick={handleDeleteConfirmed}
                disabled={!!deletingId}
              >
                {deletingId ? <LoadingSpinner size={13} /> : <Trash2 size={13} />}
                {deletingId ? 'Deleting…' : 'Delete'}
              </button>
            </div>
          </div>
        </div>
      )}

      {showCatalogueImport && (
        <CatalogueImportModal
          onClose={() => setShowCatalogueImport(false)}
          onSaved={() => { setShowCatalogueImport(false); void loadPage() }}
        />
      )}

      {showForm && (
        <RepertoireFormModal
          item={editingItem}
          prefillRow={prefillRow}
          payees={payees}
          contracts={contracts}
          onClose={() => { setShowForm(false); setEditingItem(null); setPrefillRow(null); reloadCounts() }}
          onSaved={() => { setShowForm(false); setEditingItem(null); setPrefillRow(null); void loadPage() }}
          onLinksChanged={reloadCounts}
        />
      )}

      {showBulkLink && selectedWorkItems.length > 0 && (
        <BulkLinkContractsModal
          selectedItems={selectedWorkItems}
          contracts={contracts}
          onClose={() => setShowBulkLink(false)}
          onSaved={(linkedWorkIds) => {
            setContractLinkCounts(prev => {
              const next = { ...prev }
              linkedWorkIds.forEach(id => {
                next[id] = Math.max(next[id] ?? 0, 1)
              })
              return next
            })
            setShowBulkLink(false)
            setSelectedIds(new Set())
            void loadPage()
          }}
        />
      )}

    </div>
  )
}

// ── Repertoire form modal ─────────────────────────────────────────────────────

function RepertoireFormModal({ item, prefillRow, payees, contracts, onClose, onSaved, onLinksChanged }: {
  item: Repertoire | null
  prefillRow: any | null
  payees: PayeeMin[]
  contracts: ContractMin[]
  onClose: () => void
  onSaved: () => void
  onLinksChanged?: () => void
}) {
  const isEdit = !!item
  const isISWC = (val: string) => /^T[-\s]?[\d]{3}[.\s]?[\d]{3}[.\s]?[\d]{3}[-\s]?[\d]$/i.test(val.trim())

  const inferredType = prefillRow
    ? (prefillRow.domain === 'publishing' ? 'work' : 'track')
    : (item?.repertoire_type ?? 'track')

  // For publishing prefill rows: if identifier looks like ISWC, put it in iswc;
  // otherwise treat it as Tempo ID (numeric / non-ISWC format)
  const prefillIdentifier = prefillRow?.identifier_raw ?? ''
  const prefillIswc = prefillRow?.identifier_raw && isISWC(prefillRow.identifier_raw)
    ? prefillRow.identifier_raw : ''
  const prefillIsrc = prefillRow?.identifier_raw && !isISWC(prefillRow.identifier_raw) && prefillRow?.domain !== 'publishing'
    ? prefillRow.identifier_raw : ''
  const prefillTempoId = prefillRow?.identifier_raw && !isISWC(prefillRow.identifier_raw) && prefillRow?.domain === 'publishing'
    ? prefillRow.identifier_raw : ''

  const [form, setForm] = useState({
    repertoire_type: inferredType,
    title:           item?.title ?? prefillRow?.title_raw ?? '',
    artist_name:     item?.artist_name ?? prefillRow?.artist_name_raw ?? '',
    writer_name:     item?.writer_name ?? '',
    isrc:            item?.isrc ?? prefillIsrc,
    iswc:            item?.iswc ?? prefillIswc,
    upc:             item?.upc ?? '',
    internal_code:   item?.internal_code ?? '',
    source_id:       item?.source_id ?? '',
    tempo_id:        (item as any)?.tempo_id ?? prefillTempoId,
    linked_payee_id: item?.linked_payee_id ?? '',
    active_status:   item?.active_status ?? true,
    draft_status:    (item?.draft_status ?? (prefillRow ? 'needs_linking' : 'active')) as string,
    notes:           item?.notes ?? '',
  })
  const [saving, setSaving]       = useState(false)
  const [formError, setFormError] = useState<string | null>(null)
  const [savedId, setSavedId]     = useState<string | null>(item?.id ?? null)

  // Writers + splits for works
  // Stored as structured list; serialized to writer_name on save
  const parseWritersFromString = (s: string | null | undefined): { name: string; split: string }[] => {
    if (!s) return [{ name: '', split: '' }]
    // Try to parse "Name (50%), Name2 (50%)" format
    const parts = s.split(',').map(p => p.trim()).filter(Boolean)
    const parsed = parts.map(p => {
      const m = p.match(/^(.+?)\s*\((\d+(?:\.\d+)?)%\)$/)
      if (m) return { name: m[1].trim(), split: m[2] }
      return { name: p, split: '' }
    })
    return parsed.length > 0 ? parsed : [{ name: '', split: '' }]
  }
  const [writers, setWriters] = useState<{ name: string; split: string }[]>(() =>
    inferredType === 'work' ? parseWritersFromString(item?.writer_name) : [{ name: '', split: '' }]
  )

  const setF = (key: string, val: string | boolean) => setForm(prev => ({ ...prev, [key]: val }))

  const save = async () => {
    if (!form.title.trim()) { setFormError('Title required.'); return }
    setSaving(true); setFormError(null)

    if (form.repertoire_type === 'work' && form.tempo_id.trim()) {
      let duplicateQuery = supabase
        .from('repertoire')
        .select('id,title')
        .eq('repertoire_type', 'work')
        .eq('tempo_id', form.tempo_id.trim())
        .limit(1)

      if (isEdit) duplicateQuery = duplicateQuery.neq('id', item!.id)

      const { data: duplicateTempoRows, error: duplicateTempoErr } = await duplicateQuery
      if (duplicateTempoErr) {
        setFormError(duplicateTempoErr.message)
        setSaving(false)
        return
      }
      if ((duplicateTempoRows ?? []).length > 0) {
        const existing = duplicateTempoRows?.[0]
        setFormError(`A publishing work with Tempo ID ${form.tempo_id.trim()} already exists${existing?.title ? ` (${existing.title})` : ''}.`)
        setSaving(false)
        return
      }
    }

    // Serialize writers for works
    let writerNameVal = form.writer_name
    if (form.repertoire_type === 'work') {
      const validWriters = writers.filter(w => w.name.trim())
      if (validWriters.length > 0) {
        writerNameVal = validWriters.map(w =>
          w.split ? `${w.name.trim()} (${w.split}%)` : w.name.trim()
        ).join(', ')
      } else {
        writerNameVal = ''
      }
    }
    const payload = {
      ...form,
      linked_payee_id: form.linked_payee_id || null,
      isrc:            form.isrc || null,
      iswc:            form.iswc || null,
      upc:             form.upc || null,
      internal_code:   form.internal_code || null,
      source_id:       form.source_id || null,
      tempo_id:        form.tempo_id || null,
      artist_name:     form.artist_name || null,
      writer_name:     writerNameVal || null,
      draft_status:    form.draft_status || null,
      notes:           form.notes || null,
      updated_at:      new Date().toISOString(),
    }
    if (isEdit) {
      const { error } = await supabase.from('repertoire').update(payload).eq('id', item!.id)
      if (error) { setFormError(error.message); setSaving(false); return }
      setSavedId(item!.id)
    } else {
      const { data, error } = await supabase
        .from('repertoire')
        .insert({ ...payload, created_at: new Date().toISOString() })
        .select('id').single()
      if (error) { setFormError(error.message); setSaving(false); return }
      setSavedId(data!.id)
    }
    setSaving(false)
    if (form.repertoire_type !== 'work') { onSaved(); return }
    // For works: stay open so user can set contract links immediately
  }

  const isWork = form.repertoire_type === 'work'
  const handleClose = () => { if (savedId && isWork) onSaved(); else onClose() }

  return (
    <div className="fixed inset-0 bg-black/70 z-50 flex items-center justify-center p-4">
      <div className="bg-ops-surface border border-ops-border rounded-xl w-full max-w-lg max-h-[90vh] overflow-y-auto">
        <div className="flex items-center justify-between p-4 border-b border-ops-border">
          <span className="font-semibold">{isEdit ? 'Edit Repertoire Item' : 'New Repertoire Item'}</span>
          <button onClick={handleClose} className="btn-ghost btn-sm">✕</button>
        </div>

        <div className="p-4 space-y-3">
          {formError && <Alert type="error">{formError}</Alert>}
          {prefillRow && (
            <Alert type="info">Pre-filled from unmatched import row. Review and save to add to catalogue.</Alert>
          )}

          <div className="grid grid-cols-2 gap-3">
            <div className="ops-field">
              <label className="ops-label">Type *</label>
              <select className="ops-select" value={form.repertoire_type} onChange={e => setF('repertoire_type', e.target.value)}>
                <option value="track">Track (Master)</option>
                <option value="release">Release (Master)</option>
                <option value="work">Work (Publishing)</option>
              </select>
            </div>
            <div className="ops-field">
              <label className="ops-label">Draft Status</label>
              <select className="ops-select" value={form.draft_status} onChange={e => setF('draft_status', e.target.value)}>
                <option value="active">Active</option>
                <option value="draft">Draft</option>
                <option value="needs_linking">Needs Linking</option>
              </select>
            </div>
            <div className="ops-field col-span-2">
              <label className="ops-label">Title *</label>
              <input className="ops-input" value={form.title} onChange={e => setF('title', e.target.value)} />
            </div>
            <div className="ops-field">
              <label className="ops-label">Artist Name</label>
              <input className="ops-input" value={form.artist_name} onChange={e => setF('artist_name', e.target.value)} />
            </div>

            {isWork ? (
              <div className="ops-field col-span-2">
                <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 6 }}>
                  <label className="ops-label" style={{ marginBottom: 0 }}>Writers &amp; Splits</label>
                  <span style={{ fontSize: 11, color: 'var(--ops-muted)' }}>
                    Total: {(() => {
                      const total = writers.reduce((s, w) => s + (parseFloat(w.split) || 0), 0)
                      return <span style={{ color: Math.abs(total - 100) < 0.01 ? 'var(--accent-green)' : total > 100 ? 'var(--accent-red)' : 'var(--ops-muted)', fontFamily: 'monospace', fontWeight: 600 }}>{total.toFixed(2)}%</span>
                    })()}
                  </span>
                </div>
                <div style={{ display: 'flex', flexDirection: 'column', gap: 5 }}>
                  {writers.map((w, i) => (
                    <div key={i} style={{ display: 'grid', gridTemplateColumns: '1fr 80px 24px', gap: 5, alignItems: 'center' }}>
                      <input
                        className="ops-input text-xs"
                        placeholder={`Writer ${i + 1} name`}
                        value={w.name}
                        onChange={e => setWriters(prev => prev.map((x, j) => j === i ? { ...x, name: e.target.value } : x))}
                      />
                      <div style={{ position: 'relative' }}>
                        <input
                          className="ops-input text-xs font-mono"
                          style={{ paddingRight: 22, textAlign: 'right' }}
                          placeholder="50"
                          type="number"
                          min="0"
                          max="100"
                          step="0.01"
                          value={w.split}
                          onChange={e => setWriters(prev => prev.map((x, j) => j === i ? { ...x, split: e.target.value } : x))}
                        />
                        <span style={{ position: 'absolute', right: 7, top: '50%', transform: 'translateY(-50%)', fontSize: 11, color: 'var(--ops-muted)', pointerEvents: 'none' }}>%</span>
                      </div>
                      <button
                        type="button"
                        onClick={() => setWriters(prev => prev.length === 1 ? [{ name: '', split: '' }] : prev.filter((_, j) => j !== i))}
                        style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'var(--ops-subtle)', display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 0 }}
                        title="Remove writer"
                      >
                        <X size={13} />
                      </button>
                    </div>
                  ))}
                </div>
                <button
                  type="button"
                  className="btn-ghost btn-sm mt-1"
                  style={{ fontSize: 12 }}
                  onClick={() => setWriters(prev => [...prev, { name: '', split: '' }])}
                >
                  + Add writer
                </button>
                <p style={{ fontSize: 11, color: 'var(--ops-subtle)', marginTop: 4 }}>
                  Splits are informational — for publishing catalogue export. Royalty allocation uses contract links below.
                </p>
              </div>
            ) : (
              <div className="ops-field">
                <label className="ops-label">Writer Name(s)</label>
                <input className="ops-input" value={form.writer_name} onChange={e => setF('writer_name', e.target.value)} />
              </div>
            )}

            {isWork ? (
              <>
                <div className="ops-field col-span-2">
                  <label className="ops-label">Tempo ID <span className="ml-1 text-cyan-400 text-[10px]">Primary Publishing Identifier</span></label>
                  <input className="ops-input font-mono" value={form.tempo_id}
                    onChange={e => setF('tempo_id', e.target.value)} placeholder="e.g. 12345678" />
                  <p className="text-[10px] text-ops-subtle mt-0.5">Sony Song ID / Tempo ID — primary match key for publishing imports.</p>
                </div>
                <div className="ops-field col-span-2">
                  <label className="ops-label">ISWC <span className="ml-1 text-ops-muted text-[10px]">Secondary identifier</span></label>
                  <input className="ops-input font-mono" value={form.iswc}
                    onChange={e => setF('iswc', e.target.value.toUpperCase())} placeholder="e.g. T-034.524.680-1" />
                  <p className="text-[10px] text-ops-subtle mt-0.5">Format: T-ddd.ddd.ddd-d · Used as fallback if Tempo ID is absent.</p>
                </div>
                <div className="ops-field">
                  <label className="ops-label">Internal Code</label>
                  <input className="ops-input font-mono" value={form.internal_code} onChange={e => setF('internal_code', e.target.value)} />
                </div>
                <div className="ops-field">
                  <label className="ops-label">Source ID (legacy)</label>
                  <input className="ops-input font-mono" value={form.source_id} onChange={e => setF('source_id', e.target.value)} />
                </div>
              </>
            ) : (
              <>
                <div className="ops-field">
                  <label className="ops-label">ISRC</label>
                  <input className="ops-input font-mono" value={form.isrc}
                    onChange={e => setF('isrc', e.target.value.toUpperCase())} placeholder="e.g. GBARL2400001" />
                </div>
                <div className="ops-field">
                  <label className="ops-label">UPC</label>
                  <input className="ops-input font-mono" value={form.upc} onChange={e => setF('upc', e.target.value)} />
                </div>
                <div className="ops-field">
                  <label className="ops-label">Internal Code</label>
                  <input className="ops-input font-mono" value={form.internal_code} onChange={e => setF('internal_code', e.target.value)} />
                </div>
                <div className="ops-field">
                  <label className="ops-label">Source ID</label>
                  <input className="ops-input font-mono" value={form.source_id} onChange={e => setF('source_id', e.target.value)} />
                </div>
              </>
            )}

            {/* Task 1: linked_payee_id is retained for data integrity but clearly marked as legacy/informational.
                It is NOT shown for works where contract links handle allocation.
                Only visible for non-work types where it may still provide a useful hint. */}
            {!isWork && (
              <div className="ops-field col-span-2">
                <label className="ops-label">
                  Linked Payee <span className="text-ops-subtle font-normal text-[10px]">(optional, informational only)</span>
                </label>
                <select className="ops-select" value={form.linked_payee_id} onChange={e => setF('linked_payee_id', e.target.value)}>
                  <option value="">— None —</option>
                  {payees.map(p => <option key={p.id} value={p.id}>{p.payee_name}</option>)}
                </select>
                <p className="text-[10px] text-ops-subtle mt-0.5">
                  For reference only. Royalty allocation uses contract links — not this field.
                </p>
              </div>
            )}
          </div>

          <div className="ops-field">
            <label className="ops-label">Notes</label>
            <textarea className="ops-textarea" value={form.notes} onChange={e => setF('notes', e.target.value)} rows={2} />
          </div>
          <label className="flex items-center gap-2 text-sm">
            <input type="checkbox" checked={form.active_status} onChange={e => setF('active_status', e.target.checked)} />
            Active
          </label>
        </div>

        <div className="flex justify-end gap-2 px-4 pb-3">
          <button onClick={handleClose} className="btn-secondary">{savedId && isWork ? 'Done' : 'Cancel'}</button>
          <button onClick={save} disabled={saving} className="btn-primary">
            {saving ? 'Saving…' : isEdit ? 'Save Changes' : 'Add to Catalogue'}
          </button>
        </div>

        {/* Work → contract links — shown once item exists */}
        {isWork && savedId && (
          <div className="border-t border-ops-border px-4 pb-4 pt-3">
            <WorkContractLinks repertoireId={savedId} contracts={contracts} onLinksChanged={onLinksChanged} />
          </div>
        )}
        {isWork && !savedId && (
          <div className="border-t border-ops-border px-4 pb-4 pt-3">
            <p style={{ fontSize: 12, color: 'var(--ops-muted)' }}>
              Save this work first, then you can link it to publishing contracts with shares.
            </p>
          </div>
        )}
      </div>
    </div>
  )
}

// ── Catalogue Import Modal ────────────────────────────────────────────────────
// Dedicated bulk-import for catalogue records (tracks / releases / works).
// Matches Works_Template.csv headers exactly.
// Completely separate from the income/sales import flow — no matching engine,
// no statement periods, no income or currency concepts whatsoever.
//
// Expected CSV headers (all optional except title):
//   title, repertoire_type, writer_name, iswc, internal_code,
//   source_id, linked_payee_id, active_status, notes, draft_status

type CatalogueRow = {
  _rowNum:         number
  selected:        boolean
  title:           string
  repertoire_type: string
  writer_name:     string
  tempo_id:        string
  iswc:            string
  internal_code:   string
  source_id:       string
  active_status:   boolean
  notes:           string
  draft_status:    string
  _warning:        string | null
}

const CATALOGUE_TEMPLATE_HEADERS = [
  'title', 'repertoire_type', 'writer_name', 'tempo_id', 'iswc',
  'internal_code', 'source_id', 'linked_payee_id',
  'active_status', 'notes', 'draft_status',
]

function parseCatalogueCsv(text: string): { rows: CatalogueRow[]; unknownHeaders: string[] } {
  const cleaned = text.replace(/^\uFEFF/, '')
  const lines = cleaned.replace(/\r\n/g, '\n').replace(/\r/g, '\n').split('\n').filter(l => l.trim())
  if (lines.length < 2) return { rows: [], unknownHeaders: [] }

  const sample = lines[0]
  const delim  = (sample.match(/;/g) ?? []).length >= (sample.match(/,/g) ?? []).length ? ';' : ','
  const rawHeaders = lines[0].split(delim).map(h => h.trim().replace(/^"|"$/g, '').toLowerCase().replace(/\s+/g, '_'))
  const knownSet   = new Set(CATALOGUE_TEMPLATE_HEADERS)
  const unknownHeaders = rawHeaders.filter(h => !knownSet.has(h))

  const get = (obj: Record<string, string>, key: string) => (obj[key] ?? '').trim()

  const rows: CatalogueRow[] = []
  for (let i = 1; i < lines.length; i++) {
    const vals = lines[i].split(delim).map(v => v.trim().replace(/^"|"$/g, ''))
    const obj: Record<string, string> = {}
    rawHeaders.forEach((h, idx) => { obj[h] = vals[idx] ?? '' })

    const title           = get(obj, 'title')
    const rawType         = get(obj, 'repertoire_type') || 'work'
    const repertoire_type = ['track', 'release', 'work'].includes(rawType) ? rawType : 'work'
    const active_raw      = get(obj, 'active_status').toLowerCase()
    const active_status   = active_raw === '' || active_raw === 'true' || active_raw === '1' || active_raw === 'yes'
    const rawDraft        = get(obj, 'draft_status') || 'active'
    const draft_status    = ['active', 'draft', 'needs_linking'].includes(rawDraft) ? rawDraft : 'active'

    let _warning: string | null = null
    if (!title) _warning = 'No title — row will be skipped'
    else if (!['track', 'release', 'work'].includes(rawType))
      _warning = `Unknown type "${rawType}" — defaulted to "work"`

    rows.push({
      _rowNum: i, selected: !!title,
      title, repertoire_type, draft_status, active_status,
      writer_name:   get(obj, 'writer_name'),
      tempo_id:      get(obj, 'tempo_id'),
      iswc:          get(obj, 'iswc').toUpperCase(),
      internal_code: get(obj, 'internal_code'),
      source_id:     get(obj, 'source_id'),
      notes:         get(obj, 'notes'),
      _warning,
    })
  }
  return { rows, unknownHeaders }
}

function downloadCatalogueTemplate() {
  const header  = CATALOGUE_TEMPLATE_HEADERS.join(',')
  const example = 'My Song Title,work,Jane Smith,12345678,T-034.524.680-1,INT-001,,true,,Optional note,active'
  const blob = new Blob([header + '\n' + example + '\n'], { type: 'text/csv' })
  const url  = URL.createObjectURL(blob)
  const a    = document.createElement('a'); a.href = url; a.download = 'Works_Template.csv'; a.click()
  URL.revokeObjectURL(url)
}

function CatalogueImportModal({ onClose, onSaved }: {
  onClose: () => void
  onSaved: () => void
}) {
  const fileRef = React.useRef<HTMLInputElement>(null)

  const [step, setStep]                     = useState<'upload' | 'review'>('upload')
  const [fileName, setFileName]             = useState('')
  const [rows, setRows]                     = useState<CatalogueRow[]>([])
  const [unknownHeaders, setUnknownHeaders] = useState<string[]>([])
  const [saving, setSaving]                 = useState(false)
  const [savedCount, setSavedCount]         = useState<number | null>(null)
  const [error, setError]                   = useState<string | null>(null)

  const updateRow = (i: number, key: keyof CatalogueRow, val: string | boolean) =>
    setRows(prev => prev.map((r, idx) => idx === i ? { ...r, [key]: val } : r))

  function handleFile(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0]
    if (!file) return
    setFileName(file.name)
    setError(null)
    const reader = new FileReader()
    reader.onload = ev => {
      const { rows: parsed, unknownHeaders: unk } = parseCatalogueCsv(ev.target?.result as string)
      if (parsed.length === 0) { setError('No data rows found. Check the file has a header row and at least one data row.'); return }
      setRows(parsed)
      setUnknownHeaders(unk)
      setStep('review')
    }
    reader.readAsText(file, 'utf-8')
  }

  async function saveAll() {
    const toSave = rows.filter(r => r.selected && r.title.trim())
    if (toSave.length === 0) { setError('No valid rows selected.'); return }
    setSaving(true); setError(null)
    let count = 0
    for (const row of toSave) {
      if (row.repertoire_type === 'work' && row.tempo_id) {
        const { data: duplicateRows } = await supabase
          .from('repertoire')
          .select('id')
          .eq('repertoire_type', 'work')
          .eq('tempo_id', row.tempo_id)
          .limit(1)
        if ((duplicateRows ?? []).length > 0) continue
      }
      const { error: e } = await supabase.from('repertoire').insert({
        title:           row.title.trim(),
        repertoire_type: row.repertoire_type,
        writer_name:     row.writer_name   || null,
        tempo_id:        row.tempo_id      || null,
        iswc:            row.iswc          || null,
        internal_code:   row.internal_code || null,
        source_id:       row.source_id     || null,
        active_status:   row.active_status,
        notes:           row.notes         || null,
        draft_status:    row.draft_status,
        created_at:      new Date().toISOString(),
        updated_at:      new Date().toISOString(),
      })
      if (!e) count++
    }
    setSavedCount(count)
    setSaving(false)
    if (count > 0) setTimeout(onSaved, 1200)
  }

  const selected = rows.filter(r => r.selected && r.title.trim()).length
  const warnings = rows.filter(r => r._warning).length

  return (
    <div className="fixed inset-0 bg-black/70 z-50 flex items-center justify-center p-4">
      <div className="bg-ops-surface border border-ops-border rounded-xl w-full max-w-4xl max-h-[90vh] flex flex-col">

        {/* Header */}
        <div className="flex items-center justify-between p-4 border-b border-ops-border flex-shrink-0">
          <div>
            <span className="font-semibold">Bulk Import Catalogue Records</span>
            <span className="ml-2 text-xs text-ops-muted">
              {step === 'upload'
                ? 'Create multiple tracks, releases, or works from a CSV file'
                : `${rows.length} rows parsed · ${selected} selected`}
            </span>
          </div>
          <button onClick={onClose} className="btn-ghost btn-sm"><X size={14} /></button>
        </div>

        {/* Body */}
        <div className="flex-1 overflow-y-auto p-4 space-y-4">
          {error && <Alert type="error">{error}</Alert>}

          {savedCount !== null && (
            <Alert type="success">
              {savedCount} record{savedCount !== 1 ? 's' : ''} added to catalogue. Closing…
            </Alert>
          )}

          {/* Upload step */}
          {step === 'upload' && (
            <div className="space-y-4">
              <div className="rounded border p-3 text-xs space-y-2" style={{ borderColor: 'var(--ops-border)', background: 'var(--ops-surface-2)' }}>
                <p className="font-semibold text-ops-text">Expected CSV headers</p>
                <p className="font-mono text-ops-muted break-all">{CATALOGUE_TEMPLATE_HEADERS.join(', ')}</p>
                <ul className="text-ops-subtle space-y-0.5 list-disc list-inside">
                  <li><span className="font-semibold text-ops-text">title</span> — required. All other columns are optional.</li>
                  <li><span className="font-semibold text-ops-text">tempo_id</span> — Sony Song ID / Tempo ID. Primary publishing identifier.</li>
                  <li><span className="font-semibold text-ops-text">repertoire_type</span> — <code>track</code>, <code>release</code>, or <code>work</code>. Defaults to <code>work</code> if blank.</li>
                  <li><span className="font-semibold text-ops-text">draft_status</span> — <code>active</code>, <code>draft</code>, or <code>needs_linking</code>. Defaults to <code>active</code>.</li>
                  <li><span className="font-semibold text-ops-text">active_status</span> — <code>true</code> / <code>false</code>. Defaults to <code>true</code>.</li>
                </ul>
              </div>

              <button className="btn-ghost btn-sm flex items-center gap-1.5" onClick={downloadCatalogueTemplate}>
                <FileDown size={13} /> Download template CSV
              </button>

              <div
                className="border-2 border-dashed rounded-lg p-12 text-center cursor-pointer transition-colors hover:border-blue-500"
                style={{ borderColor: 'var(--ops-border)' }}
                onClick={() => fileRef.current?.click()}
              >
                <Upload size={28} className="mx-auto text-ops-muted mb-3" />
                <p className="text-sm text-ops-text">Click to choose a CSV file</p>
                <p className="text-xs text-ops-muted mt-1">Comma or semicolon delimited · UTF-8 or UTF-8 BOM</p>
                {fileName && <p className="text-xs text-green-400 mt-3 font-mono">{fileName}</p>}
              </div>
              <input ref={fileRef} type="file" accept=".csv,.txt" className="hidden" onChange={handleFile} />
            </div>
          )}

          {/* Review step */}
          {step === 'review' && (
            <div className="space-y-3">
              {unknownHeaders.length > 0 && (
                <Alert type="warning">
                  Unrecognised columns were ignored: <span className="font-mono">{unknownHeaders.join(', ')}</span>
                </Alert>
              )}
              {warnings > 0 && (
                <Alert type="warning">
                  {warnings} row{warnings !== 1 ? 's have' : ' has'} warnings. Rows with no title are deselected automatically.
                </Alert>
              )}

              <div className="overflow-x-auto">
                <table className="ops-table text-xs">
                  <thead>
                    <tr>
                      <th>
                        <input
                          type="checkbox"
                          checked={rows.filter(r => r.title.trim()).every(r => r.selected)}
                          onChange={e => setRows(prev => prev.map(r => ({ ...r, selected: r.title.trim() ? e.target.checked : false })))}
                        />
                      </th>
                      <th>#</th>
                      <th>Type</th>
                      <th>Title *</th>
                      <th>Writer</th>
                      <th>Tempo ID</th>
                      <th>ISWC</th>
                      <th>Internal Code</th>
                      <th>Draft Status</th>
                      <th>Active</th>
                      <th>Notes</th>
                      <th></th>
                    </tr>
                  </thead>
                  <tbody>
                    {rows.map((row, i) => (
                      <tr key={i} className={!row.selected || !row.title.trim() ? 'opacity-40' : ''}>
                        <td>
                          <input
                            type="checkbox"
                            checked={row.selected && !!row.title.trim()}
                            disabled={!row.title.trim()}
                            onChange={e => updateRow(i, 'selected', e.target.checked)}
                          />
                        </td>
                        <td className="font-mono text-ops-subtle">{row._rowNum}</td>
                        <td>
                          <select className="ops-select text-xs" value={row.repertoire_type} onChange={e => updateRow(i, 'repertoire_type', e.target.value)}>
                            <option value="track">track</option>
                            <option value="release">release</option>
                            <option value="work">work</option>
                          </select>
                        </td>
                        <td>
                          <input className="ops-input text-xs" value={row.title} placeholder="Required"
                            onChange={e => updateRow(i, 'title', e.target.value)} />
                        </td>
                        <td>
                          <input className="ops-input text-xs" value={row.writer_name}
                            onChange={e => updateRow(i, 'writer_name', e.target.value)} />
                        </td>
                        <td>
                          <input className="ops-input font-mono text-xs" value={row.tempo_id} placeholder="e.g. 12345678"
                            onChange={e => updateRow(i, 'tempo_id', e.target.value)} />
                        </td>
                        <td>
                          <input className="ops-input font-mono text-xs" value={row.iswc} placeholder="T-…"
                            onChange={e => updateRow(i, 'iswc', e.target.value.toUpperCase())} />
                        </td>
                        <td>
                          <input className="ops-input font-mono text-xs" value={row.internal_code}
                            onChange={e => updateRow(i, 'internal_code', e.target.value)} />
                        </td>
                        <td>
                          <select className="ops-select text-xs" value={row.draft_status} onChange={e => updateRow(i, 'draft_status', e.target.value)}>
                            <option value="active">active</option>
                            <option value="draft">draft</option>
                            <option value="needs_linking">needs_linking</option>
                          </select>
                        </td>
                        <td className="text-center">
                          <input type="checkbox" checked={row.active_status}
                            onChange={e => updateRow(i, 'active_status', e.target.checked)} />
                        </td>
                        <td>
                          <input className="ops-input text-xs" value={row.notes}
                            onChange={e => updateRow(i, 'notes', e.target.value)} />
                        </td>
                        <td>
                          {row._warning && (
                            <span title={row._warning} className="cursor-help">
                              <AlertTriangle size={12} className="text-amber-400" />
                            </span>
                          )}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          )}
        </div>

        {/* Footer */}
        <div className="flex items-center justify-between gap-3 p-4 border-t border-ops-border flex-shrink-0">
          <span className="text-xs text-ops-muted">
            {step === 'review' && `${selected} of ${rows.length} rows selected for import`}
          </span>
          <div className="flex items-center gap-2">
            {step === 'review' && (
              <button
                className="btn-ghost btn-sm"
                onClick={() => { setStep('upload'); setRows([]); setFileName(''); setError(null); setSavedCount(null) }}
              >
                ← Choose different file
              </button>
            )}
            <button className="btn-secondary btn-sm" onClick={onClose}>Cancel</button>
            {step === 'review' && (
              <button
                className="btn-primary btn-sm flex items-center gap-1.5"
                disabled={saving || selected === 0 || savedCount !== null}
                onClick={saveAll}
              >
                {saving
                  ? <><LoadingSpinner size={13} /> Saving…</>
                  : <><CheckCircle size={13} /> Add {selected} record{selected !== 1 ? 's' : ''} to catalogue</>
                }
              </button>
            )}
          </div>
        </div>
      </div>
    </div>
  )
}
