export interface RepertoireMetadataSourceRow {
  domain?: string | null
  identifier_raw?: string | null
  tempo_id?: string | null
  iswc?: string | null
}

export interface ExistingRepertoireMetadata {
  tempo_id?: string | null
  iswc?: string | null
}

export interface RepertoireMetadataPatch {
  tempo_id?: string
  iswc?: string
}

export function normalizeRepertoireIdentifier(value: string | null | undefined): string {
  return (value ?? '').trim().replace(/[-\s.]/g, '').toUpperCase()
}

export function isIswcIdentifier(value: string | null | undefined): boolean {
  return /^T\d{10}$/.test(normalizeRepertoireIdentifier(value))
}

function uniqueCandidate(
  rows: RepertoireMetadataSourceRow[],
  selectValue: (row: RepertoireMetadataSourceRow) => string,
): string | null {
  const candidates = new Map<string, string>()

  for (const row of rows) {
    if (row.domain && row.domain !== 'publishing') continue
    const value = selectValue(row).trim()
    if (!value) continue
    candidates.set(normalizeRepertoireIdentifier(value), value)
  }

  return candidates.size === 1 ? Array.from(candidates.values())[0] : null
}

/**
 * Build a fill-only catalogue metadata patch from import rows matched to one work.
 * Conflicting source identifiers are deliberately ignored rather than guessed.
 */
export function buildRepertoireMetadataPatch(
  existing: ExistingRepertoireMetadata,
  rows: RepertoireMetadataSourceRow[],
): RepertoireMetadataPatch {
  const patch: RepertoireMetadataPatch = {}

  if (!existing.tempo_id?.trim()) {
    const tempoId = uniqueCandidate(rows, row => {
      if (row.tempo_id?.trim()) return row.tempo_id
      return row.identifier_raw?.trim() && !isIswcIdentifier(row.identifier_raw)
        ? row.identifier_raw
        : ''
    })
    if (tempoId) patch.tempo_id = tempoId.trim()
  }

  if (!existing.iswc?.trim()) {
    const iswc = uniqueCandidate(rows, row => {
      if (row.iswc?.trim()) return row.iswc
      return isIswcIdentifier(row.identifier_raw) ? (row.identifier_raw ?? '') : ''
    })
    if (iswc) patch.iswc = iswc.trim().toUpperCase()
  }

  return patch
}
