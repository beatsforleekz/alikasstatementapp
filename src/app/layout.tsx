import type { Metadata } from 'next'
import './globals.css'
import { AuthProvider } from '@/lib/auth/AuthContext'
import AuthGuard from '@/components/auth/AuthGuard'
import AppShell from '@/components/layout/AppShell'
import { ThemeProvider } from '@/lib/theme/ThemeContext'

export const metadata: Metadata = {
  title: 'Statement Ops',
  description: 'Music business statement operations system',
}

export default function RootLayout({
  children,
}: {
  children: React.ReactNode
}) {
  return (
    // No hardcoded dark class — ThemeProvider applies .dark dynamically
    <html lang="en">
      <body className="min-h-screen" style={{ backgroundColor: 'var(--ops-bg)', color: 'var(--ops-text)' }}>
        <ThemeProvider>
          <AuthProvider>
            <AuthGuard>
              <AppShell>
                {children}
              </AppShell>
            </AuthGuard>
          </AuthProvider>
        </ThemeProvider>
      </body>
    </html>
  )
}
