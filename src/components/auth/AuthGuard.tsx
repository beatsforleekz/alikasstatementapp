'use client'
/**
 * AuthGuard — renders children only when the user has an active session.
 * Shows a loading state while the initial session is being resolved.
 * Redirects to /login if no session.
 *
 * Placed in the root layout so every page is protected by default.
 * The /login page is excluded (it's outside the AuthGuard in layout.tsx).
 */
import { useEffect } from 'react'
import { useRouter, usePathname } from 'next/navigation'
import { useAuth } from '@/lib/auth/AuthContext'

export default function AuthGuard({ children }: { children: React.ReactNode }) {
  const { session, loading } = useAuth()
  const router = useRouter()
  const pathname = usePathname()

  useEffect(() => {
    // Don't redirect while the session is still being resolved
    if (loading) return
    // If no session and not already on the login page, redirect
    if (!session && pathname !== '/login') {
      router.replace('/login')
    }
  }, [session, loading, pathname, router])

  // While resolving the session, show a minimal spinner
  if (loading) {
    return (
      <div className="min-h-screen bg-ops-bg flex items-center justify-center">
        <div className="flex items-center gap-2 text-ops-muted text-sm">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" className="animate-spin">
            <circle cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="3" strokeOpacity="0.2" />
            <path d="M12 2a10 10 0 0 1 10 10" stroke="currentColor" strokeWidth="3" strokeLinecap="round" />
          </svg>
          Loading…
        </div>
      </div>
    )
  }

  // No session and not on login page — return null while redirect happens
  if (!session && pathname !== '/login') {
    return null
  }

  return <>{children}</>
}
