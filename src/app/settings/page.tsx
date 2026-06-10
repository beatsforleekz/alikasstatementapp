'use client'
import { useEffect, useState } from 'react'
import { useTheme } from '@/lib/theme/ThemeContext'
import type { Theme } from '@/lib/theme/ThemeContext'
import { Sun, Moon, Monitor, Settings, Info, Send, UserRound } from 'lucide-react'
import { IMPORT_TYPE_OPTIONS } from '@/lib/types'
import { useAuth } from '@/lib/auth/AuthContext'
import { supabase } from '@/lib/supabase/client'

const THEME_OPTIONS: { value: Theme; label: string; icon: React.ElementType; desc: string }[] = [
  { value: 'light',  label: 'Light',  icon: Sun,     desc: 'Clean, high-contrast light background. Default.' },
  { value: 'dark',   label: 'Dark',   icon: Moon,    desc: 'Reduced-glare dark palette for low-light work.' },
  { value: 'system', label: 'System', icon: Monitor, desc: 'Follows your operating system preference.' },
]

const BADGE_STYLES: Record<string, string> = {
  primary:   'badge-approved',
  legacy:    'badge-pending',
  secondary: 'badge-info',
}

export default function SettingsPage() {
  const { theme, setTheme, resolvedTheme } = useTheme()
  const { user, profile, refreshProfile } = useAuth()
  const [displayName, setDisplayName] = useState('')
  const [jobTitle, setJobTitle] = useState('')
  const [savingProfile, setSavingProfile] = useState(false)
  const [profileMessage, setProfileMessage] = useState<string | null>(null)
  const [profileError, setProfileError] = useState<string | null>(null)

  const masterTypes     = IMPORT_TYPE_OPTIONS.filter(o => o.domain === 'master')
  const publishingTypes = IMPORT_TYPE_OPTIONS.filter(o => o.domain === 'publishing')

  useEffect(() => {
    setDisplayName(
      profile?.display_name
      ?? user?.user_metadata?.display_name
      ?? user?.user_metadata?.full_name
      ?? user?.user_metadata?.name
      ?? user?.email
      ?? ''
    )
    setJobTitle(profile?.job_title ?? '')
  }, [profile, user])

  async function saveProfile() {
    if (!user) return
    setSavingProfile(true)
    setProfileError(null)
    setProfileMessage(null)
    const { error } = await supabase
      .from('user_profiles')
      .update({
        display_name: displayName.trim() || null,
        job_title: jobTitle.trim() || null,
      })
      .eq('id', user.id)
    if (error) {
      setProfileError(error.message)
      setSavingProfile(false)
      return
    }
    await refreshProfile()
    setProfileMessage('Profile updated.')
    setSavingProfile(false)
  }

  return (
    <div className="space-y-6 max-w-2xl">
      <div className="page-header">
        <div>
          <div className="flex items-center gap-2 mb-1">
            <Settings size={18} className="text-ops-muted" />
            <h1 className="page-title">Settings</h1>
          </div>
          <p className="page-subtitle">Application preferences and appearance</p>
        </div>
      </div>

      <div className="card">
        <div className="card-header">
          <div className="flex items-center gap-2">
            <UserRound size={14} className="text-ops-muted" />
            <span className="text-sm font-semibold" style={{ color: 'var(--ops-text)' }}>Your Profile</span>
          </div>
          <span className="text-xs text-ops-muted">
            Used for approval and audit display
          </span>
        </div>
        <div className="card-body space-y-4">
          <p className="text-xs" style={{ color: 'var(--ops-muted)' }}>
            Set the name that should appear when you approve statements or complete review actions.
          </p>
          <div className="space-y-3">
            <div className="ops-field">
              <label className="ops-label">Display Name</label>
              <input
                className="ops-input"
                value={displayName}
                onChange={e => setDisplayName(e.target.value)}
                placeholder="Your name for approvals"
              />
            </div>
            <div className="ops-field">
              <label className="ops-label">Job Title</label>
              <input
                className="ops-input"
                value={jobTitle}
                onChange={e => setJobTitle(e.target.value)}
                placeholder="Optional"
              />
            </div>
            <div className="ops-field">
              <label className="ops-label">Email</label>
              <input
                className="ops-input"
                value={user?.email ?? ''}
                disabled
              />
            </div>
          </div>
          {profileError && (
            <div className="text-xs text-red-400">{profileError}</div>
          )}
          {profileMessage && (
            <div className="text-xs text-green-400">{profileMessage}</div>
          )}
          <div className="flex justify-end">
            <button onClick={() => { void saveProfile() }} className="btn-primary" disabled={savingProfile || !user}>
              {savingProfile ? 'Saving…' : 'Save Profile'}
            </button>
          </div>
        </div>
      </div>

      {/* Appearance */}
      <div className="card">
        <div className="card-header">
          <span className="text-sm font-semibold" style={{ color: 'var(--ops-text)' }}>Appearance</span>
          <span className="text-xs text-ops-muted">
            Currently: <span className="font-mono">{resolvedTheme}</span>
          </span>
        </div>
        <div className="card-body space-y-4">
          <p className="text-xs" style={{ color: 'var(--ops-muted)' }}>
            Choose how Statement Ops looks. Your preference is saved locally on this device.
          </p>
          <div className="grid grid-cols-3 gap-3">
            {THEME_OPTIONS.map(opt => {
              const Icon = opt.icon
              const isActive = theme === opt.value
              return (
                <button
                  key={opt.value}
                  onClick={() => setTheme(opt.value)}
                  className="text-left p-4 rounded-lg border transition-all"
                  style={{
                    borderColor: isActive ? 'var(--accent-blue)' : 'var(--ops-border)',
                    backgroundColor: isActive ? 'color-mix(in srgb, var(--accent-blue) 8%, var(--ops-surface))' : 'var(--ops-surface-2)',
                  }}
                >
                  <div className="flex items-center gap-2 mb-2">
                    <Icon size={16} style={{ color: isActive ? 'var(--accent-blue)' : 'var(--ops-muted)' }} />
                    <span className="text-sm font-semibold" style={{ color: isActive ? 'var(--accent-blue)' : 'var(--ops-text)' }}>
                      {opt.label}
                    </span>
                    {isActive && (
                      <span className="ml-auto text-[10px] font-bold uppercase tracking-wider" style={{ color: 'var(--accent-blue)' }}>
                        Active
                      </span>
                    )}
                  </div>
                  <p className="text-xs" style={{ color: 'var(--ops-muted)' }}>{opt.desc}</p>
                </button>
              )
            })}
          </div>
        </div>
      </div>

      {/* Import types — Master */}
      <div className="card">
        <div className="card-header">
          <span className="text-sm font-semibold" style={{ color: 'var(--ops-text)' }}>
            Import Types — Master
          </span>
          <span className="badge-master">Master</span>
        </div>
        <div className="card-body space-y-3 text-xs" style={{ color: 'var(--ops-muted)' }}>
          {masterTypes.map(opt => (
            <div key={opt.value} className="flex items-start gap-3 p-3 rounded-lg" style={{ backgroundColor: 'var(--ops-surface-2)' }}>
              {opt.badge && (
                <span className={`badge ${BADGE_STYLES[opt.badge] ?? 'badge-pending'} mt-0.5 shrink-0`}>
                  {opt.badge.charAt(0).toUpperCase() + opt.badge.slice(1)}
                </span>
              )}
              <div>
                <div className="font-semibold text-sm" style={{ color: 'var(--ops-text)' }}>{opt.label}</div>
                <div className="mt-0.5">{opt.description}</div>
              </div>
            </div>
          ))}
        </div>
      </div>

      {/* Import types — Publishing */}
      <div className="card">
        <div className="card-header">
          <span className="text-sm font-semibold" style={{ color: 'var(--ops-text)' }}>
            Import Types — Publishing
          </span>
          <span className="badge-publishing">Publishing</span>
        </div>
        <div className="card-body space-y-3 text-xs" style={{ color: 'var(--ops-muted)' }}>
          {publishingTypes.map(opt => (
            <div key={opt.value} className="flex items-start gap-3 p-3 rounded-lg" style={{ backgroundColor: 'var(--ops-surface-2)' }}>
              {opt.badge && (
                <span className={`badge ${BADGE_STYLES[opt.badge] ?? 'badge-pending'} mt-0.5 shrink-0`}>
                  {opt.badge.charAt(0).toUpperCase() + opt.badge.slice(1)}
                </span>
              )}
              <div>
                <div className="font-semibold text-sm" style={{ color: 'var(--ops-text)' }}>{opt.label}</div>
                <div className="mt-0.5">{opt.description}</div>
              </div>
            </div>
          ))}
          <div className="p-3 rounded-lg border border-blue-800/40" style={{ backgroundColor: 'var(--ops-surface-2)' }}>
            <div className="text-xs font-semibold mb-1" style={{ color: 'var(--ops-text)' }}>Publishing Matching Note</div>
            <div>Sony Publishing imports are identifier-driven. Rows are matched by ISWC, then allocated to payees based on stored work-level splits. Payee name and contract name in the source file are not required for matching.</div>
          </div>
        </div>
      </div>

      {/* Publishing allocation reference */}
      <div className="card">
        <div className="card-header">
          <span className="text-sm font-semibold" style={{ color: 'var(--ops-text)' }}>Publishing Allocation Model</span>
        </div>
        <div className="card-body space-y-2 text-xs" style={{ color: 'var(--ops-muted)' }}>
          <p>For each matched publishing import row:</p>
          <ol className="list-decimal list-inside space-y-1 ml-2">
            <li>Row matched to repertoire work via ISWC (primary) or title (fallback).</li>
            <li>Active splits found in <span className="font-mono">contract_repertoire_payee_splits</span> for that work.</li>
            <li>For each split (one per payee per contract):</li>
          </ol>
          <div className="ml-6 p-2 rounded font-mono" style={{ backgroundColor: 'var(--ops-surface)', color: 'var(--ops-text)' }}>
            allocated = source_amount × contract_income_type_rate × split_percent
          </div>
          <p>Writer names in the source file are <strong>not</strong> used to determine payment. Only stored splits define who receives what.</p>
        </div>
      </div>

      {/* Sending parties note */}
      <div className="card">
        <div className="card-header">
          <div className="flex items-center gap-2">
            <Send size={14} className="text-ops-muted" />
            <span className="text-sm font-semibold" style={{ color: 'var(--ops-text)' }}>Sending Parties</span>
          </div>
        </div>
        <div className="card-body text-xs" style={{ color: 'var(--ops-muted)' }}>
          Sending parties (the entity issuing statements) can be managed per contract. Each contract can have one sending party. Manage sending parties in the Contracts section or add them inline when creating a contract.
        </div>
      </div>

      {/* About */}
      <div className="card">
        <div className="card-header">
          <span className="text-sm font-semibold" style={{ color: 'var(--ops-text)' }}>About</span>
        </div>
        <div className="card-body">
          <div className="flex items-center gap-2 text-xs" style={{ color: 'var(--ops-muted)' }}>
            <Info size={13} />
            <span>Statement Ops v0.2.0 · Music business statement operations system</span>
          </div>
          <div className="mt-2 text-xs" style={{ color: 'var(--ops-subtle)' }}>
            Statement unit: Contract + Payee + Period · Balance model: Approach B (zero-base) ·
            Publishing: ISWC-first, split-driven allocation
          </div>
        </div>
      </div>
    </div>
  )
}
