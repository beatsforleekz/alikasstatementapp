import clsx from 'clsx'
import type { CSSProperties } from 'react'
import type { StatementRecord, Exception } from '@/lib/types'

export type NoticeTone = 'error' | 'warning' | 'info' | 'success'

export function getNoticePanelStyle(type: NoticeTone) {
  const toneMap: Record<NoticeTone, CSSProperties> = {
    error: {
      background: 'color-mix(in srgb, var(--accent-red) 8%, var(--ops-surface))',
      borderColor: 'color-mix(in srgb, var(--accent-red) 22%, var(--ops-border))',
      color: 'var(--ops-text)',
    },
    warning: {
      background: 'color-mix(in srgb, var(--accent-amber) 10%, var(--ops-surface))',
      borderColor: 'color-mix(in srgb, var(--accent-amber) 26%, var(--ops-border))',
      color: 'var(--ops-text)',
    },
    info: {
      background: 'color-mix(in srgb, var(--accent-blue) 8%, var(--ops-surface))',
      borderColor: 'color-mix(in srgb, var(--accent-blue) 20%, var(--ops-border))',
      color: 'var(--ops-text)',
    },
    success: {
      background: 'color-mix(in srgb, var(--accent-green) 8%, var(--ops-surface))',
      borderColor: 'color-mix(in srgb, var(--accent-green) 20%, var(--ops-border))',
      color: 'var(--ops-text)',
    },
  }

  return toneMap[type]
}

// ============================================================
// DOMAIN BADGE
// ============================================================
export function DomainBadge({ domain }: { domain: 'master' | 'publishing' }) {
  return (
    <span className={domain === 'master' ? 'badge-master' : 'badge-publishing'}>
      {domain === 'master' ? 'Master' : 'Publishing'}
    </span>
  )
}

// ============================================================
// APPROVAL STATUS BADGE
// ============================================================
export function ApprovalBadge({ status }: { status: string }) {
  const map: Record<string, string> = {
    approved: 'badge-approved',
    pending: 'badge-pending',
    rejected: 'badge-rejected',
    on_hold: 'badge-hold',
  }
  const labels: Record<string, string> = {
    approved: 'Approved',
    pending: 'Pending',
    rejected: 'Rejected',
    on_hold: 'On Hold',
  }
  return (
    <span className={map[status] ?? 'badge-pending'}>
      {labels[status] ?? status}
    </span>
  )
}

// ============================================================
// STATEMENT STATUS BADGES
// ============================================================
export function PayableBadge({ record }: { record: Pick<StatementRecord, 'is_payable' | 'is_recouping' | 'carry_forward_amount'> }) {
  if (record.is_recouping) return <span className="badge-recouping">Recouping</span>
  if (record.is_payable) return <span className="badge-payable">Payable</span>
  if (record.carry_forward_amount > 0) return <span className="badge-warning">Carry Forward</span>
  return <span className="badge-pending">No Balance</span>
}

export function EmailStatusBadge({ status }: { status: string }) {
  if (status === 'sent') return <span className="badge-sent">Sent</span>
  if (status === 'prepared') return <span className="badge-info">Prepared</span>
  return <span className="badge-pending">Not Prepared</span>
}

export function OutputBadge({ generated }: { generated: boolean }) {
  return generated
    ? <span className="badge-approved">Output Ready</span>
    : <span className="badge-pending">No Output</span>
}

// ============================================================
// SEVERITY BADGE
// ============================================================
export function SeverityBadge({ severity }: { severity: 'critical' | 'warning' | 'info' }) {
  const map = { critical: 'badge-critical', warning: 'badge-warning', info: 'badge-info' }
  return <span className={map[severity]}>{severity}</span>
}

// ============================================================
// STAT CARD
// ============================================================
interface StatCardProps {
  label: string
  value: string | number
  sub?: string
  color?: 'default' | 'green' | 'amber' | 'red' | 'blue' | 'cyan'
  onClick?: () => void
}

export function StatCard({ label, value, sub, color = 'default', onClick }: StatCardProps) {
  const valueColors = {
    default: 'text-ops-text',
    green: 'text-green-400',
    amber: 'text-amber-400',
    red: 'text-red-400',
    blue: 'text-blue-400',
    cyan: 'text-cyan-400',
  }
  return (
    <div
      className={clsx('stat-card', onClick && 'cursor-pointer hover:border-ops-border-hover transition-colors')}
      onClick={onClick}
    >
      <div className={clsx('stat-value', valueColors[color])}>{value}</div>
      <div className="stat-label">{label}</div>
      {sub && <div className="text-xs text-ops-subtle mt-0.5">{sub}</div>}
    </div>
  )
}

// ============================================================
// AMOUNT DISPLAY
// ============================================================
export function Amount({
  value,
  currency = 'GBP',
  size = 'normal',
}: {
  value: number
  currency?: string
  size?: 'normal' | 'large' | 'small'
}) {
  const formatted = new Intl.NumberFormat('en-GB', {
    style: 'currency',
    currency,
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(value)

  const cls = clsx(
    'font-mono tabular-nums',
    value > 0 ? 'text-green-400' : value < 0 ? 'text-red-400' : 'text-ops-muted',
    size === 'large' && 'text-2xl font-bold',
    size === 'small' && 'text-xs',
    size === 'normal' && 'text-sm'
  )

  return <span className={cls}>{formatted}</span>
}

// ============================================================
// LOADING SPINNER
// ============================================================
export function LoadingSpinner({ size = 16 }: { size?: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      className="animate-spin text-ops-muted"
    >
      <circle cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="3" strokeOpacity="0.2" />
      <path
        d="M12 2a10 10 0 0 1 10 10"
        stroke="currentColor"
        strokeWidth="3"
        strokeLinecap="round"
      />
    </svg>
  )
}

// ============================================================
// EMPTY STATE
// ============================================================
export function EmptyState({ title, description, icon: Icon }: {
  title: string
  description?: string
  icon?: React.ComponentType<{ size?: string | number; className?: string }>
}) {
  return (
    <div className="empty-state">
      {Icon && <Icon size={28} className="text-ops-subtle" />}
      <div className="empty-state-title">{title}</div>
      {description && <div className="empty-state-desc">{description}</div>}
    </div>
  )
}

// ============================================================
// SECTION HEADER
// ============================================================
export function SectionHeader({
  title,
  action,
}: {
  title: string
  action?: React.ReactNode
}) {
  return (
    <div className="flex items-center justify-between mb-3">
      <span className="section-title">{title}</span>
      {action}
    </div>
  )
}

// ============================================================
// ALERT / INLINE NOTICE
// ============================================================
export function Alert({
  type,
  children,
}: {
  type: NoticeTone
  children: React.ReactNode
}) {
  return (
    <div
      className={clsx('rounded border px-4 py-3 text-sm')}
      style={getNoticePanelStyle(type)}
    >
      {children}
    </div>
  )
}

// ============================================================
// CONFIRMATION GATE INDICATOR
// ============================================================
export function ConfirmGate({
  label,
  confirmed,
  onConfirm,
  disabled,
}: {
  label: string
  confirmed: boolean
  onConfirm?: () => void
  disabled?: boolean
}) {
  return (
    <div className="flex items-center justify-between py-2">
      <div className="flex items-center gap-2">
        <div
          className={clsx(
            'w-4 h-4 rounded-full border-2 flex items-center justify-center',
            confirmed ? 'border-green-500 bg-green-500/20' : 'border-ops-border'
          )}
        >
          {confirmed && (
            <svg viewBox="0 0 12 12" fill="none" className="w-2.5 h-2.5">
              <path d="M2 6l3 3 5-5" stroke="#22c55e" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
          )}
        </div>
        <span className={clsx('text-sm', confirmed ? 'text-green-400' : 'text-ops-muted')}>
          {label}
        </span>
      </div>
      {!confirmed && onConfirm && (
        <button
          className="btn-sm btn-secondary"
          onClick={onConfirm}
          disabled={disabled}
        >
          Confirm
        </button>
      )}
    </div>
  )
}
