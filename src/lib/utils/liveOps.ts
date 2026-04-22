'use client'

import { supabase } from '@/lib/supabase/client'

export function createOpsLiveChannel(channelName: string, onChange: () => void) {
  return supabase
    .channel(channelName)
    .on('postgres_changes', { event: '*', schema: 'public', table: 'statement_records' }, onChange)
    .on('postgres_changes', { event: '*', schema: 'public', table: 'exceptions' }, onChange)
    .on('postgres_changes', { event: '*', schema: 'public', table: 'import_rows' }, onChange)
    .subscribe()
}
