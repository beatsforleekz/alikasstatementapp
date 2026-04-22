export function compareOptionLabels(a: string | null | undefined, b: string | null | undefined) {
  const left = (a ?? '').trim()
  const right = (b ?? '').trim()
  return left.localeCompare(right, undefined, { sensitivity: 'base', numeric: true })
}

export function sortByLabel<T>(items: T[], getLabel: (item: T) => string | null | undefined): T[] {
  return [...items].sort((a, b) => compareOptionLabels(getLabel(a), getLabel(b)))
}

export function sortStrings(items: string[]): string[] {
  return [...items].sort(compareOptionLabels)
}

export function sortOptionEntries<T extends readonly [string, string]>(items: T[]): T[] {
  return [...items].sort((a, b) => compareOptionLabels(a[1], b[1]))
}
