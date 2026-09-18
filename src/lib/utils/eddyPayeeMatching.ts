import type { Payee, PayeeAlias } from '@/lib/types'

export type PayeeSearchResult = {
  payee: Payee
  aliases: string[]
}

export function normalizeEddyPayeeName(value: string | null | undefined) {
  return (value ?? '').trim().replace(/\s+/g, ' ').toLowerCase()
}

export function automaticallyMatchEddyPayee(
  rawName: string,
  payees: Payee[],
  aliases: PayeeAlias[],
) {
  const normalized = normalizeEddyPayeeName(rawName)
  const direct = payees.find(payee => [
    payee.payee_name,
    payee.display_name,
    payee.statement_name,
    payee.performer_name,
  ].some(name => normalizeEddyPayeeName(name) === normalized))
  if (direct) return direct

  const alias = aliases.find(item => normalizeEddyPayeeName(item.alias_name) === normalized)
  return alias ? payees.find(payee => payee.id === alias.payee_id) ?? null : null
}

export function searchEddyPayees(
  query: string,
  payees: Payee[],
  aliases: PayeeAlias[],
): PayeeSearchResult[] {
  const normalizedQuery = normalizeEddyPayeeName(query)
  const aliasesByPayee = aliases.reduce<Record<string, string[]>>((acc, alias) => {
    if (!acc[alias.payee_id]) acc[alias.payee_id] = []
    acc[alias.payee_id].push(alias.alias_name)
    return acc
  }, {})

  return payees
    .map(payee => ({ payee, aliases: aliasesByPayee[payee.id] ?? [] }))
    .map(result => {
      const fields = [
        result.payee.payee_name,
        result.payee.display_name,
        result.payee.statement_name,
        result.payee.performer_name,
        result.payee.primary_contact_name,
        result.payee.primary_email,
        result.payee.vendor_reference,
        ...result.aliases,
      ].map(normalizeEddyPayeeName).filter(Boolean)
      const rank = !normalizedQuery
        ? 3
        : fields.some(field => field === normalizedQuery)
          ? 0
          : fields.some(field => field.startsWith(normalizedQuery))
            ? 1
            : fields.some(field => field.includes(normalizedQuery))
              ? 2
              : 99
      return { ...result, rank }
    })
    .filter(result => result.rank < 99)
    .sort((a, b) => a.rank - b.rank || a.payee.payee_name.localeCompare(b.payee.payee_name))
    .slice(0, 50)
    .map(({ payee, aliases: matchedAliases }) => ({ payee, aliases: matchedAliases }))
}

export function findDuplicateEddyRunPayee<T extends { id: string; payee_id: string | null }>(
  artists: T[],
  payeeId: string,
  currentArtistId?: string,
) {
  return artists.find(artist => artist.payee_id === payeeId && artist.id !== currentArtistId) ?? null
}
