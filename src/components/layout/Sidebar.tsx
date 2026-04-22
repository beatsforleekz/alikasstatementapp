'use client'
import { useCallback, useEffect, useRef, useState } from 'react'
import Link from 'next/link'
import { usePathname } from 'next/navigation'
import {
  LayoutDashboard, Users, FileText, Upload, ListChecks,
  PlayCircle, GitMerge, AlertTriangle, Mail, BookOpen,
  ChevronRight, Disc3, LogOut, Settings, ScrollText, ShieldAlert,
  LifeBuoy,
} from 'lucide-react'
import { useAuth } from '@/lib/auth/AuthContext'
import { supabase } from '@/lib/supabase/client'
import { createOpsLiveChannel } from '@/lib/utils/liveOps'
import { IMPORT_EXCEPTION_ISSUE_TYPES } from '@/lib/utils/exceptionEngine'

const NAV_SECTIONS = [
  {
    label: 'Overview',
    items: [
      { href: '/', label: 'Dashboard', icon: LayoutDashboard },
    ],
  },
  {
    label: 'Data',
    items: [
      { href: '/payees', label: 'Payees', icon: Users },
      { href: '/contracts', label: 'Contracts', icon: ScrollText },
      { href: '/repertoire', label: 'Repertoire', icon: BookOpen },
      { href: '/imports', label: 'Imports', icon: Upload },
    ],
  },
  {
    label: 'Statement Runs',
    items: [
      { href: '/statement-run?domain=master', label: 'Master Run', icon: Disc3 },
      { href: '/statement-run?domain=publishing', label: 'Publishing Run', icon: FileText },
    ],
  },
  {
    label: 'Statements',
    items: [
      { href: '/statements', label: 'All Statements', icon: ListChecks },
      { href: '/reconciliation', label: 'Reconciliation', icon: GitMerge },
      { href: '/email-prep', label: 'Email Prep', icon: Mail },
    ],
  },
  {
    label: 'Quality',
    items: [
      { href: '/sales-errors', label: 'Sales Errors', icon: ShieldAlert },
      { href: '/exceptions', label: 'Exceptions', icon: AlertTriangle },
    ],
  },
  {
    label: 'Support',
    items: [
      { href: '/help', label: 'Help & Workflow', icon: LifeBuoy },
    ],
  },
]

export default function Sidebar() {
  const pathname = usePathname()
  const { user, signOut } = useAuth()
  const [openExceptionCount, setOpenExceptionCount] = useState(0)
  const refreshTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  const loadOpenExceptionCount = useCallback(async () => {
    let query = supabase
      .from('exceptions')
      .select('id', { count: 'exact', head: true })
      .eq('resolution_status', 'open')
    for (const issueType of IMPORT_EXCEPTION_ISSUE_TYPES) {
      query = query.neq('issue_type', issueType)
    }
    const { count } = await query
    setOpenExceptionCount(count ?? 0)
  }, [])

  useEffect(() => {
    void loadOpenExceptionCount()
    const scheduleRefresh = () => {
      if (refreshTimerRef.current) clearTimeout(refreshTimerRef.current)
      refreshTimerRef.current = setTimeout(() => { void loadOpenExceptionCount() }, 150)
    }
    const channel = createOpsLiveChannel(`sidebar-live-${Date.now()}`, scheduleRefresh)
    return () => {
      if (refreshTimerRef.current) clearTimeout(refreshTimerRef.current)
      supabase.removeChannel(channel)
    }
  }, [loadOpenExceptionCount])

  return (
    <aside
      className="fixed top-0 left-0 h-screen w-56 flex flex-col z-40 border-r"
      style={{
        backgroundColor: 'var(--sidebar-bg)',
        borderColor: 'var(--sidebar-border)',
      }}
    >
      {/* Logo */}
      <div className="px-4 py-4 border-b" style={{ borderColor: 'var(--sidebar-border)' }}>
        <div className="flex items-center gap-2">
          <div className="w-7 h-7 rounded bg-blue-600 flex items-center justify-center flex-shrink-0">
            <PlayCircle size={14} className="text-white" />
          </div>
          <div>
            <div className="text-sm font-bold leading-none" style={{ color: 'var(--sidebar-text)' }}>
              Statement Ops
            </div>
            <div className="text-[10px] leading-none mt-0.5" style={{ color: 'var(--sidebar-muted)' }}>
              Music Rights
            </div>
          </div>
        </div>
      </div>

      {/* Nav */}
      <nav className="flex-1 overflow-y-auto py-3 px-2">
        {NAV_SECTIONS.map((section) => (
          <div key={section.label} className="mb-4">
            <div className="px-2 mb-1.5">
              <span className="text-[10px] font-bold uppercase tracking-widest" style={{ color: 'var(--sidebar-muted)' }}>
                {section.label}
              </span>
            </div>
            {section.items.map((item) => {
              const Icon = item.icon
              const hrefBase = item.href.split('?')[0]
              const isActive =
                item.href === '/'
                  ? pathname === '/'
                  : pathname.startsWith(hrefBase)

              return (
                <Link
                  key={item.href}
                  href={item.href}
                  className="flex items-center gap-2.5 px-2 py-1.5 rounded text-sm transition-colors mb-0.5"
                  style={{
                    backgroundColor: isActive ? 'var(--sidebar-active-bg)' : 'transparent',
                    color: isActive ? 'var(--sidebar-active)' : 'var(--sidebar-muted)',
                    fontWeight: isActive ? 600 : 400,
                  }}
                  onMouseEnter={e => {
                    if (!isActive) {
                      e.currentTarget.style.backgroundColor = 'var(--ops-surface-2)'
                      e.currentTarget.style.color = 'var(--sidebar-text)'
                    }
                  }}
                  onMouseLeave={e => {
                    if (!isActive) {
                      e.currentTarget.style.backgroundColor = 'transparent'
                      e.currentTarget.style.color = 'var(--sidebar-muted)'
                    }
                  }}
                >
                  <Icon size={14} className="shrink-0" />
                  <span>{item.label}</span>
                  <span className="ml-auto flex items-center gap-1.5">
                    {item.href === '/exceptions' && openExceptionCount > 0 && (
                      <span
                        className="inline-flex min-w-[18px] h-[18px] items-center justify-center rounded-full px-1.5 text-[10px] font-semibold"
                        style={{ backgroundColor: 'rgba(220, 38, 38, 0.14)', color: '#b91c1c' }}
                        title={`${openExceptionCount} exceptions pending review`}
                      >
                        {openExceptionCount}
                      </span>
                    )}
                    {isActive && <ChevronRight size={12} className="opacity-60" />}
                  </span>
                </Link>
              )
            })}
          </div>
        ))}
      </nav>

      {/* Footer */}
      <div className="px-3 py-3 border-t space-y-1" style={{ borderColor: 'var(--sidebar-border)' }}>
        <Link
          href="/settings"
          className="flex items-center gap-1.5 text-xs px-2 py-1.5 rounded transition-colors w-full"
          style={{
            color: pathname === '/settings' ? 'var(--sidebar-active)' : 'var(--sidebar-muted)',
            backgroundColor: pathname === '/settings' ? 'var(--sidebar-active-bg)' : 'transparent',
          }}
        >
          <Settings size={12} />
          Settings
        </Link>

        {user && (
          <div className="text-[10px] truncate px-2" style={{ color: 'var(--sidebar-muted)' }} title={user.email ?? ''}>
            {user.email}
          </div>
        )}
        <button
          onClick={() => signOut()}
          className="flex items-center gap-1.5 text-[11px] transition-colors w-full px-2 py-1"
          style={{ color: 'var(--sidebar-muted)' }}
          onMouseEnter={e => e.currentTarget.style.color = 'var(--sidebar-text)'}
          onMouseLeave={e => e.currentTarget.style.color = 'var(--sidebar-muted)'}
        >
          <LogOut size={11} />
          Sign out
        </button>
        <div className="text-[10px] font-mono px-2" style={{ color: 'var(--ops-subtle)' }}>v0.2.0</div>
      </div>
    </aside>
  )
}
