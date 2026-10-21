export function getWriterNameOptions(values: Array<string | null | undefined>): string[] {
  const names = new Map<string, string>()

  for (const value of values) {
    for (const part of formatImportedWriterNames(value ?? '').split(',')) {
      const name = part.replace(/\s*\(\d+(?:\.\d+)?%\)\s*$/, '').trim()
      if (!name) continue
      const key = name.toLocaleLowerCase()
      if (!names.has(key)) names.set(key, name)
    }
  }

  return Array.from(names.values()).sort((a, b) => a.localeCompare(b, undefined, { sensitivity: 'base' }))
}

export function formatImportedWriterNames(value: string): string {
  return value.replace(/;\s*NC:\s*/gi, ', ').trim()
}
