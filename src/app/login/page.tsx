'use client'
import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { useAuth } from '@/lib/auth/AuthContext'
import { LogIn, AlertCircle } from 'lucide-react'

export default function LoginPage() {
  const { signIn } = useAuth()
  const router = useRouter()
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    if (!email.trim() || !password.trim()) {
      setError('Email and password are required.')
      return
    }
    setLoading(true)
    setError(null)
    const { error } = await signIn(email.trim(), password)
    if (error) {
      setError(error)
      setLoading(false)
      return
    }
    router.replace('/')
  }

  return (
    <div className="min-h-screen bg-ops-bg flex items-center justify-center p-4">
      <div className="w-full max-w-sm">
        {/* Logo block */}
        <div className="mb-8 text-center">
          <div className="inline-flex items-center justify-center w-12 h-12 rounded-xl bg-blue-600 mb-4">
            <LogIn size={20} className="text-white" />
          </div>
          <h1 className="text-xl font-bold text-ops-text">Statement Ops</h1>
          <p className="text-sm text-ops-muted mt-1">Music Rights · Internal Admin</p>
        </div>

        {/* Form */}
        <form
          onSubmit={handleSubmit}
          className="bg-ops-surface border border-ops-border rounded-xl p-6 space-y-4"
        >
          <div className="ops-field">
            <label className="ops-label" htmlFor="email">Email</label>
            <input
              id="email"
              type="email"
              autoComplete="email"
              className="ops-input"
              value={email}
              onChange={e => setEmail(e.target.value)}
              disabled={loading}
              placeholder="you@company.com"
            />
          </div>

          <div className="ops-field">
            <label className="ops-label" htmlFor="password">Password</label>
            <input
              id="password"
              type="password"
              autoComplete="current-password"
              className="ops-input"
              value={password}
              onChange={e => setPassword(e.target.value)}
              disabled={loading}
              placeholder="••••••••"
            />
          </div>

          {error && (
            <div className="flex items-start gap-2 rounded border border-red-800/60 bg-red-950/40 px-3 py-2 text-sm text-red-300">
              <AlertCircle size={14} className="mt-0.5 shrink-0" />
              <span>{error}</span>
            </div>
          )}

          <button
            type="submit"
            disabled={loading}
            className="btn-primary w-full justify-center py-2"
          >
            {loading ? 'Signing in…' : 'Sign In'}
          </button>
        </form>

        <p className="mt-4 text-center text-xs text-ops-subtle">
          User accounts are managed in Supabase Auth.
        </p>
      </div>
    </div>
  )
}
