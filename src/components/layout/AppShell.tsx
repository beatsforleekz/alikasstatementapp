'use client'
/**
 * AppShell — renders the sidebar + main layout for authenticated pages,
 * or a bare wrapper for the login page (which has its own full-page layout).
 */
import { usePathname } from 'next/navigation'
import Sidebar from '@/components/layout/Sidebar'

const BARE_ROUTES = ['/login']

export default function AppShell({ children }: { children: React.ReactNode }) {
  const pathname = usePathname()
  const isBare = BARE_ROUTES.includes(pathname)

  if (isBare) {
    return <>{children}</>
  }

  return (
    <div className="flex min-h-screen">
      <Sidebar />
      <main className="flex-1 ml-56 min-h-screen">
        <div className="p-6 max-w-[1400px]">
          {children}
        </div>
      </main>
    </div>
  )
}
