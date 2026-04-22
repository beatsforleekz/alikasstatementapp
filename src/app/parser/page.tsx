'use client'

import Link from 'next/link'
import { Alert } from '@/components/ui'

export default function ParserPage() {
  return (
    <div className="space-y-4">
      <div className="page-header">
        <div>
          <h1 className="page-title">Parser Tool</h1>
          <p className="page-subtitle">Temporarily disabled until the in-app Sony parser is production-ready.</p>
        </div>
      </div>

      <Alert type="warning">
        The in-app parser review is currently disabled because it is not producing reliable clean output. Use the existing local parser workflow, then continue in <Link href="/imports" className="underline">Imports</Link>.
      </Alert>
    </div>
  )
}
