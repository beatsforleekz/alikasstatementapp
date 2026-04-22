'use client'
import { useParams, useRouter } from 'next/navigation'
import { useEffect } from 'react'

// Edit page redirects to the payee detail page which handles edit mode inline
export default function PayeeEditPage() {
  const params = useParams()
  const router = useRouter()
  useEffect(() => {
    router.replace(`/payees/${params.id}`)
  }, [params.id, router])
  return null
}
