/**
 * BELIEVE AUTOMATIC REPORT PARSER
 *
 * Believe distributes sales reports as semicolon-delimited CSVs.
 * Fields are quoted with double-quotes. Dates are YYYY/MM/DD.
 * Numeric fields use decimal points (not locale-formatted).
 *
 * This module:
 *   1. Parses the semicolon-delimited format
 *   2. Maps Believe column names to the import_rows schema
 *   3. Normalizes dates, numbers, and identifiers
 *   4. Preserves all source fields in raw_payload_json for audit
 *
 * ISRC is the primary match key. UPC is secondary.
 * Net Revenue is the definitive monetary amount (net_amount).
 */

// ============================================================
// BELIEVE COLUMN HEADERS (exact, case-sensitive)
// ============================================================
export const BELIEVE_HEADERS = [
  'Reporting month',
  'Sales Month',
  'Platform',
  'Country / Region',
  'Label Name',
  'Artist Name',
  'Release title',
  'Track title',
  'UPC',
  'ISRC',
  'Release Catalog nb',
  'Streaming Subscription Type',
  'Release type',
  'Sales Type',
  'Quantity',
  'Client Payment Currency',
  'Unit Price',
  'Mechanical Fee',
  'Gross Revenue',
  'Client share rate',
  'Net Revenue',
] as const

export type BelieveHeader = typeof BELIEVE_HEADERS[number]

// ============================================================
// NORMALIZATION HELPERS
// ============================================================

/** Convert YYYY/MM/DD or YYYY-MM-DD to a JS Date string (YYYY-MM-DD) */
function normalizeDate(raw: string | undefined | null): string | null {
  if (!raw) return null
  const cleaned = raw.trim().replace(/\//g, '-')
  // Validate it looks like a date
  if (/^\d{4}-\d{2}-\d{2}/.test(cleaned)) return cleaned.slice(0, 10)
  return null
}

/** Strip quotes and parse float. Believe uses decimal points. */
function parseNum(raw: string | undefined | null): number | null {
  if (raw == null || raw.trim() === '') return null
  const cleaned = raw.replace(/"/g, '').trim()
  const n = parseFloat(cleaned)
  return isNaN(n) ? null : n
}

/** Normalise ISRC: uppercase, strip hyphens/spaces */
function normalizeISRC(raw: string | undefined | null): string | null {
  if (!raw) return null
  return raw.replace(/[-\s"]/g, '').toUpperCase().trim() || null
}

/** Normalise UPC: strip non-digits */
function normalizeUPC(raw: string | undefined | null): string | null {
  if (!raw) return null
  return raw.replace(/["\s]/g, '').trim() || null
}

// ============================================================
// PARSE A SINGLE BELIEVE ROW → import_rows shape
// ============================================================

export interface BelieveNormalizedRow {
  // Fields that map directly to import_rows columns
  transaction_date:        string | null    // Sales Month (YYYY-MM-DD)
  artist_name_raw:         string | null    // Artist Name
  title_raw:               string | null    // Track title (primary)
  identifier_raw:          string | null    // ISRC (primary match key)
  normalized_identifier:   string | null    // ISRC normalized
  country_raw:             string | null    // Country / Region
  row_type:                string | null    // Sales Type (Stream, Download, etc.)
  currency:                string | null    // Client Payment Currency
  quantity:                number | null    // Quantity
  net_amount:              number | null    // Net Revenue — PRIMARY financial field
  amount:                  number | null    // Net Revenue alias (for pipeline compat)
  royalty_rate:            number | null    // Client share rate
  retailer:                string | null    // Platform
  channel:                 string | null    // Platform (also mapped to channel)
  gross_amount:            number | null    // Gross Revenue
  sale_amount_original:    number | null    // Unit Price
  deducted_amount:         number | null    // Mechanical Fee (deduction field)

  // Believe-specific metadata (stored in raw_payload_json, not direct columns)
  // These are preserved but don't map to standard import_rows fields:
  _believe_reporting_month:   string | null
  _believe_label_name:        string | null
  _believe_release_title:     string | null
  _believe_upc:               string | null
  _believe_release_catalog_nb:string | null
  _believe_streaming_sub_type:string | null
  _believe_release_type:      string | null
  _believe_unit_price:        number | null
  _believe_mechanical_fee:    number | null
}

export function parseBelieveRow(row: Record<string, string>): BelieveNormalizedRow {
  const isrc = normalizeISRC(row['ISRC'])
  const upc  = normalizeUPC(row['UPC'])

  // Primary identifier: ISRC. If no ISRC, fall back to UPC.
  const identifier_raw = isrc ?? upc

  return {
    // Core import_rows fields
    transaction_date:      normalizeDate(row['Sales Month']),
    artist_name_raw:       row['Artist Name']?.trim() || null,
    title_raw:             row['Track title']?.trim() || null,
    identifier_raw,
    normalized_identifier: isrc,          // always ISRC in normalized slot
    country_raw:           row['Country / Region']?.trim() || null,
    row_type:              row['Sales Type']?.trim() || 'sale',
    currency:              row['Client Payment Currency']?.trim() || null,
    quantity:              parseNum(row['Quantity']),
    net_amount:            parseNum(row['Net Revenue']),   // DEFINITIVE monetary amount
    amount:                parseNum(row['Net Revenue']),   // alias for pipeline compat
    royalty_rate:          parseNum(row['Client share rate']),
    retailer:              row['Platform']?.trim() || null,
    channel:               row['Platform']?.trim() || null,
    gross_amount:          parseNum(row['Gross Revenue']),
    sale_amount_original:  parseNum(row['Unit Price']),
    deducted_amount:       parseNum(row['Mechanical Fee']),

    // Believe-specific audit metadata (prefixed with _believe_)
    _believe_reporting_month:    normalizeDate(row['Reporting month']),
    _believe_label_name:         row['Label Name']?.trim() || null,
    _believe_release_title:      row['Release title']?.trim() || null,
    _believe_upc:                upc,
    _believe_release_catalog_nb: row['Release Catalog nb']?.trim() || null,
    _believe_streaming_sub_type: row['Streaming Subscription Type']?.trim() || null,
    _believe_release_type:       row['Release type']?.trim() || null,
    _believe_unit_price:         parseNum(row['Unit Price']),
    _believe_mechanical_fee:     parseNum(row['Mechanical Fee']),
  }
}

// ============================================================
// DETECT BELIEVE FORMAT
// Checks whether a set of column headers matches the Believe format.
// ============================================================
export function isBelieveFormat(headers: string[]): boolean {
  const required: BelieveHeader[] = ['ISRC', 'Net Revenue', 'Client Payment Currency', 'Sales Month', 'Platform']
  return required.every(h => headers.includes(h))
}

// ============================================================
// SEMICOLON CSV PARSER
// Believe uses semicolons as delimiters and double-quotes around fields.
// PapaParse handles this natively via the delimiter option.
// This helper just exports the config to use.
// ============================================================
export const BELIEVE_PAPA_CONFIG = {
  delimiter: ';',
  header: true,
  skipEmptyLines: true,
  quoteChar: '"',
}

// ============================================================
// AUTO-COLUMN MAP
// Maps Believe column headers to import_rows target fields.
// Used to pre-fill the column mapping UI (same as Eddy auto-map).
// ============================================================
export const BELIEVE_COLUMN_MAP: Record<string, string> = {
  'Sales Month':             'transaction_date',
  'Platform':                'retailer',
  'Country / Region':        'country_raw',
  'Artist Name':             'artist_name_raw',
  'Track title':             'title_raw',
  'ISRC':                    'identifier_raw',
  'Quantity':                'quantity',
  'Client Payment Currency': 'currency',
  'Net Revenue':             'net_amount',
  'Client share rate':       'royalty_rate',
  'Gross Revenue':           'gross_amount',
  'Unit Price':              'sale_amount_original',
  'Mechanical Fee':          'deducted_amount',
  'Sales Type':              'row_type',
  // These are intentionally skipped (stored in raw_payload_json only):
  // 'Reporting month', 'Label Name', 'Release title',
  // 'UPC', 'Release Catalog nb', 'Streaming Subscription Type', 'Release type'
}
