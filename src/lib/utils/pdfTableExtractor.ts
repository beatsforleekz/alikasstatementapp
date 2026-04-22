export interface ExtractedPdfTable {
  id: string
  label: string
  headers: string[]
  rows: string[][]
  confidence: 'positioned' | 'plaintext' | 'ocr' | 'manual'
}

interface PositionedChunk {
  x: number
  y: number
  text: string
}

function latin1Decode(bytes: Uint8Array): string {
  return new TextDecoder('latin1').decode(bytes)
}

function bytesFromLatin1(value: string): Uint8Array {
  const out = new Uint8Array(value.length)
  for (let i = 0; i < value.length; i++) out[i] = value.charCodeAt(i) & 0xff
  return out
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

function cleanCellText(value: string): string {
  return value.replace(/\s+/g, ' ').trim()
}

function decodePdfString(raw: string): string {
  let out = ''
  for (let i = 0; i < raw.length; i++) {
    const ch = raw[i]
    if (ch !== '\\') {
      out += ch
      continue
    }
    i++
    const next = raw[i] ?? ''
    if (next === 'n') out += '\n'
    else if (next === 'r') out += '\r'
    else if (next === 't') out += '\t'
    else if (next === 'b') out += '\b'
    else if (next === 'f') out += '\f'
    else if (/[0-7]/.test(next)) {
      const octal = `${next}${raw[i + 1] ?? ''}${raw[i + 2] ?? ''}`.match(/^[0-7]{1,3}/)?.[0] ?? next
      out += String.fromCharCode(parseInt(octal, 8))
      i += octal.length - 1
    } else {
      out += next
    }
  }
  return cleanCellText(out)
}

async function inflateStream(bytes: Uint8Array): Promise<string | null> {
  try {
    if (typeof DecompressionStream === 'undefined') return null
    const ds = new DecompressionStream('deflate')
    const input = new Blob([new Uint8Array(bytes)])
    const ab = await new Response(input.stream().pipeThrough(ds)).arrayBuffer()
    return latin1Decode(new Uint8Array(ab))
  } catch {
    return null
  }
}

async function extractContentStreams(pdfText: string): Promise<string[]> {
  const results: string[] = []
  const streamRegex = /(<<[\s\S]*?>>)?\s*stream\r?\n([\s\S]*?)\r?\nendstream/g
  let match: RegExpExecArray | null

  while ((match = streamRegex.exec(pdfText)) !== null) {
    const dict = match[1] ?? ''
    const streamBody = match[2] ?? ''
    if (dict.includes('/FlateDecode')) {
      const inflated = await inflateStream(bytesFromLatin1(streamBody))
      if (inflated) results.push(inflated)
    } else {
      results.push(streamBody)
    }
  }

  return results
}

function extractTextFromArrayToken(token: string): string[] {
  const strings: string[] = []
  const stringRegex = /\(((?:\\.|[^\\)])*)\)|<([0-9A-Fa-f\s]+)>/g
  let match: RegExpExecArray | null
  while ((match = stringRegex.exec(token)) !== null) {
    if (match[1] != null) strings.push(decodePdfString(match[1]))
    else if (match[2] != null) {
      const hex = match[2].replace(/\s+/g, '')
      const bytes = new Uint8Array(hex.length / 2)
      for (let i = 0; i < hex.length; i += 2) bytes[i / 2] = parseInt(hex.slice(i, i + 2), 16)
      strings.push(cleanCellText(new TextDecoder().decode(bytes)))
    }
  }
  return strings.filter(Boolean)
}

function parsePositionedChunks(streamText: string): PositionedChunk[] {
  const chunks: PositionedChunk[] = []
  const tokenRegex = /(-?\d+(?:\.\d+)?)\s+(-?\d+(?:\.\d+)?)\s+Td|(-?\d+(?:\.\d+)?)\s+(-?\d+(?:\.\d+)?)\s+TD|(-?\d+(?:\.\d+)?)\s+(-?\d+(?:\.\d+)?)\s+(-?\d+(?:\.\d+)?)\s+(-?\d+(?:\.\d+)?)\s+(-?\d+(?:\.\d+)?)\s+(-?\d+(?:\.\d+)?)\s+Tm|(T\*)|(\[((?:\\.|[^\]])*?)\]\s*TJ)|(\(((?:\\.|[^\\)])*)\)\s*Tj)/g
  let currentX = 0
  let currentY = 0
  let lineHeight = 12
  let match: RegExpExecArray | null

  while ((match = tokenRegex.exec(streamText)) !== null) {
    if (match[1] != null && match[2] != null) {
      currentX += parseFloat(match[1])
      currentY += parseFloat(match[2])
      continue
    }
    if (match[3] != null && match[4] != null) {
      currentX += parseFloat(match[3])
      currentY += parseFloat(match[4])
      lineHeight = Math.abs(parseFloat(match[4])) || lineHeight
      continue
    }
    if (match[9] != null && match[10] != null) {
      currentX = parseFloat(match[9])
      currentY = parseFloat(match[10])
      continue
    }
    if (match[11]) {
      currentY -= lineHeight
      currentX = 0
      continue
    }
    if (match[12]) {
      const texts = extractTextFromArrayToken(match[12])
      const text = cleanCellText(texts.join(' '))
      if (text) chunks.push({ x: currentX, y: currentY, text })
      continue
    }
    if (match[13]) {
      const text = decodePdfString(match[14] ?? '')
      if (text) chunks.push({ x: currentX, y: currentY, text })
    }
  }

  return chunks
}

function mergeRowChunks(chunks: PositionedChunk[]): string[] {
  const sorted = [...chunks].sort((a, b) => a.x - b.x)
  const cells: Array<{ x: number; text: string }> = []
  for (const chunk of sorted) {
    const last = cells[cells.length - 1]
    if (last && Math.abs(chunk.x - last.x) < 28) {
      last.text = cleanCellText(`${last.text} ${chunk.text}`)
    } else {
      cells.push({ x: chunk.x, text: chunk.text })
    }
  }
  return cells.map(cell => cell.text).filter(Boolean)
}

function segmentTableRows(rows: string[][], confidence: 'positioned' | 'plaintext'): ExtractedPdfTable[] {
  const tables: ExtractedPdfTable[] = []
  let start = -1

  const flush = (end: number) => {
    if (start === -1) return
    const slice = rows.slice(start, end)
      .filter(row => row.length >= 2)
      .map(row => row.map(cleanCellText).filter(Boolean))
      .filter(row => row.length >= 2)
    start = -1
    if (slice.length < 2) return
    const width = Math.max(...slice.map(row => row.length))
    const headers = Array.from({ length: width }, (_, idx) => cleanCellText(slice[0][idx] ?? `Column ${idx + 1}`))
    const body = slice.slice(1).map(row => Array.from({ length: width }, (_, idx) => row[idx] ?? ''))
    tables.push({
      id: `table-${tables.length + 1}`,
      label: `Table ${tables.length + 1} · ${headers.slice(0, 3).join(' / ')}`,
      headers,
      rows: body,
      confidence,
    })
  }

  rows.forEach((row, idx) => {
    if (row.length >= 2) {
      if (start === -1) start = idx
    } else {
      flush(idx)
    }
  })
  flush(rows.length)
  return tables
}

function buildPositionedTables(streams: string[]): ExtractedPdfTable[] {
  const positioned = streams.flatMap(parsePositionedChunks)
  if (positioned.length === 0) return []

  const grouped = new Map<number, PositionedChunk[]>()
  for (const chunk of positioned) {
    const key = Math.round(chunk.y / 3) * 3
    const list = grouped.get(key) ?? []
    list.push(chunk)
    grouped.set(key, list)
  }

  const rows = Array.from(grouped.entries())
    .sort((a, b) => b[0] - a[0])
    .map(([, chunks]) => mergeRowChunks(chunks))
    .filter(row => row.length > 0)

  return segmentTableRows(rows, 'positioned')
}

function buildPlainTextTables(rawPdfText: string): ExtractedPdfTable[] {
  const strings = Array.from(rawPdfText.matchAll(/\(((?:\\.|[^\\)])*)\)/g))
    .map(match => decodePdfString(match[1] ?? ''))
    .filter(Boolean)

  const rawLines = strings
    .flatMap(value => value.split(/\r?\n/))
    .map(line => cleanCellText(line))
    .filter(Boolean)

  const rows = rawLines.map(line =>
    line
      .split(/\t+|\s{2,}| \| |;/)
      .map(cleanCellText)
      .filter(Boolean)
  )

  return segmentTableRows(rows, 'plaintext')
}

function buildManualTable(label = 'Manual Review Table', confidence: ExtractedPdfTable['confidence'] = 'manual'): ExtractedPdfTable[] {
  return [{
    id: 'manual-1',
    label,
    headers: ['Song Title', 'Tempo ID', 'ISWC', 'Mech', 'Dg Mech', 'Perf', 'Dg Perf', 'Synch', 'Other', 'Song Total'],
    rows: [],
    confidence,
  }]
}

async function tryBrowserOcr(file: File): Promise<ExtractedPdfTable[] | null> {
  if (typeof window === 'undefined') return null
  const browserOcr = (window as any).__STATEMENT_OPS_OCR__
  if (typeof browserOcr !== 'function') return null

  try {
    const result = await browserOcr(file)
    if (!result || !Array.isArray(result.tables) || result.tables.length === 0) return null
    return result.tables.map((table: any, idx: number) => ({
      id: table.id ?? `ocr-${idx + 1}`,
      label: table.label ?? `OCR Table ${idx + 1}`,
      headers: Array.isArray(table.headers) ? table.headers : [],
      rows: Array.isArray(table.rows) ? table.rows : [],
      confidence: 'ocr',
    }))
  } catch {
    return null
  }
}

export async function extractPdfTables(file: File): Promise<ExtractedPdfTable[]> {
  if (file.type.startsWith('image/')) {
    const ocrTables = await tryBrowserOcr(file)
    return ocrTables ?? buildManualTable('Image Review Table', 'manual')
  }

  const bytes = new Uint8Array(await file.arrayBuffer())
  const rawPdfText = latin1Decode(bytes)

  const streams = await extractContentStreams(rawPdfText)
  const positionedTables = buildPositionedTables(streams)
  if (positionedTables.length > 0) return positionedTables

  const plainTextTables = buildPlainTextTables(rawPdfText)
  if (plainTextTables.length > 0) return plainTextTables

  const ocrTables = await tryBrowserOcr(file)
  return ocrTables ?? buildManualTable('Scanned PDF Review Table', 'manual')
}
