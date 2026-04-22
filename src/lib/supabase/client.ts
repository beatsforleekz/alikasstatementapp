/**
 * Supabase client setup
 * Uses standard @supabase/supabase-js — fully Netlify-compatible.
 * No edge-only middleware or cookie-based SSR client needed for this internal tool.
 */
import { createClient } from '@supabase/supabase-js'

const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL!
const supabaseAnonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!

if (!supabaseUrl || !supabaseAnonKey) {
  throw new Error(
    'Missing Supabase environment variables. ' +
    'Set NEXT_PUBLIC_SUPABASE_URL and NEXT_PUBLIC_SUPABASE_ANON_KEY in your .env.local file.'
  )
}

// Browser / client-side Supabase instance (uses anon key)
export const supabase = createClient(supabaseUrl, supabaseAnonKey)

/**
 * Server-side Supabase client using the service role key.
 * Use only in API route handlers (src/app/api/**).
 * Never expose the service role key to the browser.
 */
export function createServerClient() {
  const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY
  if (!serviceRoleKey) {
    throw new Error(
      'SUPABASE_SERVICE_ROLE_KEY is not set. ' +
      'This is required for server-side API routes.'
    )
  }
  return createClient(supabaseUrl, serviceRoleKey, {
    auth: {
      // Service role client bypasses RLS — do not persist session
      persistSession: false,
      autoRefreshToken: false,
    },
  })
}

