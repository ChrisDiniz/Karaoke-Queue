import crypto from 'node:crypto'
import { TextDecoder } from 'node:util'

export type MusicCatalogDelimiter = ';' | ','

export type MusicCatalogErrorCode =
  | 'INVALID_INPUT'
  | 'FILE_TOO_LARGE'
  | 'INVALID_UTF8'
  | 'INVALID_CONTROL_CHARACTER'
  | 'MALFORMED_CSV'
  | 'INVALID_HEADER'
  | 'AMBIGUOUS_DELIMITER'
  | 'INVALID_COLUMN_COUNT'
  | 'FIELD_TOO_LARGE'
  | 'TOO_MANY_RECORDS'
  | 'INVALID_MUSIC_NUMBER'
  | 'DUPLICATE_MUSIC_NUMBER'
  | 'EMPTY_CATALOG'
  | 'INVALID_SEARCH_QUERY'
  | 'UNSAFE_FILE'
  | 'FILE_CHANGED'
  | 'FILE_READ_FAILED'
  | 'DATABASE_FAILURE'
  | 'CATALOG_IMPORT_BUSY'
  | 'CATALOG_CHANGED_DURING_CONFIRMATION'
  | 'CATALOG_REPORT_STALE'
  | 'CATALOG_CLOSED'

export class MusicCatalogError extends Error {
  constructor(
    readonly code: MusicCatalogErrorCode,
    message: string,
    readonly rowNumber?: number,
    readonly field?: string
  ) {
    super(message)
    this.name = 'MusicCatalogError'
  }
}

export interface MusicCatalogRecord {
  /** Original CSV identifier; never numerically converted or zero-padded. */
  musicNumber: string
  /** Five-digit identifier used only to associate this row with a video. */
  videoCode: string
  artist: string | null
  title: string | null
  normalizedArtist: string
  normalizedTitle: string
}

export interface MusicCatalogWarning {
  code: 'MISSING_ARTIST' | 'MISSING_TITLE'
  rowNumber: number
  field: 'artista' | 'nome_musica'
}

export interface MusicCatalogImportIssue {
  readonly rowNumber: number
  readonly field: 'numero'
  readonly value: string
  readonly code: 'INVALID_MUSIC_NUMBER'
  readonly reason: string
}

export interface MusicCatalogImportIssuePage {
  readonly catalogRevision: string | null
  readonly generation: number
  readonly total: number
  readonly offset: number
  readonly issues: MusicCatalogImportIssue[]
}

export interface ParsedMusicCatalog {
  records: MusicCatalogRecord[]
  delimiter: MusicCatalogDelimiter
  warnings: MusicCatalogWarning[]
  warningCount: number
  missingArtistCount: number
  missingTitleCount: number
  recordCount: number
  revision: string
}

export interface ParsedMusicCatalogWithIssues extends ParsedMusicCatalog {
  readonly issues: MusicCatalogImportIssue[]
}

export interface MusicCatalogMetadata {
  revision: string | null
  importedAt: string | null
  recordCount: number
  sourceName: string | null
}

export interface MusicCatalogDatabaseQuery {
  originalCodePrefix: string | null
  videoCodePrefix: string | null
  normalizedText: string
  limit: number
  offset: number
}

export interface MusicCatalogDatabasePage {
  metadata: MusicCatalogMetadata
  total: number
  records: MusicCatalogRecord[]
}

export interface MusicCatalogRepository {
  getMusicCatalogMetadata(): MusicCatalogMetadata
  replaceMusicCatalog(records: readonly MusicCatalogRecord[], metadata: {
    revision: string
    importedAt: string
    sourceName?: string | null
  }): void
  searchMusicCatalog(query: MusicCatalogDatabaseQuery): MusicCatalogDatabasePage
  getMusicCatalogRecordByVideoCode(videoCode: string): {
    metadata: MusicCatalogMetadata
    record: MusicCatalogRecord | null
  }
  /** Present only for isolated Standalone catalog databases. */
  replaceMusicCatalogWithImportIssues?(
    records: readonly MusicCatalogRecord[],
    metadata: { revision: string; importedAt: string; sourceName?: string | null },
    issues: readonly MusicCatalogImportIssue[],
    expectedGeneration: number
  ): void
  /** Reads a bounded page and its revision/count from one SQLite read transaction. */
  getMusicCatalogImportIssuePage?(offset: number, limit: number): MusicCatalogImportIssuePage
}

export const MAX_MUSIC_CATALOG_FILE_BYTES = 32 * 1024 * 1024
const MAX_RECORDS = 100_000
const MAX_FIELD_LENGTH = 4096
const MAX_COLUMNS = 3
const MAX_REPORTED_WARNINGS = 500
const REQUIRED_HEADERS = ['artista', 'numero', 'nome_musica'] as const

interface CsvRow {
  rowNumber: number
  fields: string[]
}

function normalizedSearchText(value: string | null): string {
  return (value ?? '')
    .normalize('NFD')
    .replace(/\p{M}/gu, '')
    .toLocaleLowerCase('pt-BR')
    .replace(/\s+/gu, ' ')
    .trim()
}

export function normalizeMusicCatalogText(value: string | null): string {
  return normalizedSearchText(value)
}

/** Validates the CSV representation and returns the canonical five-digit video code. */
export function normalizeCatalogCodeForVideoMatch(code: unknown): string {
  if (typeof code !== 'string' || !/^[1-9][0-9]{0,4}$/.test(code)) {
    throw new MusicCatalogError('INVALID_MUSIC_NUMBER', 'O número da música deve conter de 1 a 5 dígitos ASCII e não pode começar com zero.', undefined, 'numero')
  }
  return code.padStart(5, '0')
}

export function normalizeMusicCatalogSearchText(value: unknown): string {
  if (typeof value !== 'string') {
    throw new MusicCatalogError('INVALID_SEARCH_QUERY', 'A busca do catálogo precisa ser texto.')
  }
  if (value.length > 256) {
    throw new MusicCatalogError('INVALID_SEARCH_QUERY', 'A busca do catálogo excede o tamanho permitido.')
  }
  return normalizedSearchText(value)
}

function decodeCsvInput(input: Uint8Array | string): string {
  let text: string
  if (typeof input === 'string') {
    text = input
    if (Buffer.byteLength(text, 'utf8') > MAX_MUSIC_CATALOG_FILE_BYTES) {
      throw new MusicCatalogError('FILE_TOO_LARGE', 'O arquivo CSV excede o tamanho permitido.')
    }
  } else if (input instanceof Uint8Array) {
    if (input.byteLength > MAX_MUSIC_CATALOG_FILE_BYTES) {
      throw new MusicCatalogError('FILE_TOO_LARGE', 'O arquivo CSV excede o tamanho permitido.')
    }
    try {
      text = new TextDecoder('utf-8', { fatal: true }).decode(input)
    } catch (error) {
      throw new MusicCatalogError('INVALID_UTF8', 'O arquivo CSV precisa usar UTF-8 válido.')
    }
  } else {
    throw new MusicCatalogError('INVALID_INPUT', 'O conteúdo do CSV precisa ser texto ou bytes UTF-8.')
  }

  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1)
  if (/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u.test(text)) {
    throw new MusicCatalogError('INVALID_CONTROL_CHARACTER', 'O CSV contém caracteres de controle inválidos.')
  }
  return text
}

function parseRows(
  text: string,
  delimiter: MusicCatalogDelimiter,
  maxRows = MAX_RECORDS + 1,
  stopAfterMaxRows = false
): CsvRow[] {
  const rows: CsvRow[] = []
  let fields: string[] = []
  let field = ''
  let quoted = false
  let quoteClosed = false
  let hasRecordContent = false
  let stopped = false
  let line = 1
  let rowStartLine = 1

  const append = (value: string): void => {
    field += value
    if (field.length > MAX_FIELD_LENGTH) {
      throw new MusicCatalogError('FIELD_TOO_LARGE', 'Um campo do CSV excede o tamanho permitido.', rowStartLine)
    }
  }

  const pushField = (): void => {
    fields.push(field)
    if (fields.length > MAX_COLUMNS) {
      throw new MusicCatalogError('INVALID_COLUMN_COUNT', 'O CSV deve conter exatamente três colunas.', rowStartLine)
    }
    field = ''
    quoteClosed = false
  }

  const pushRow = (): void => {
    if (hasRecordContent || fields.length > 0 || field.length > 0 || quoteClosed) {
      pushField()
      rows.push({ rowNumber: rowStartLine, fields })
      if (stopAfterMaxRows && rows.length >= maxRows) stopped = true
      if (rows.length > maxRows) {
        throw new MusicCatalogError('TOO_MANY_RECORDS', 'O CSV contém mais registros do que o limite permitido.', rowStartLine)
      }
    }
    fields = []
    field = ''
    quoted = false
    quoteClosed = false
    hasRecordContent = false
  }

  for (let index = 0; index < text.length; index++) {
    if (stopped) break
    const character = text[index]

    if (quoted) {
      if (character === '"') {
        if (text[index + 1] === '"') {
          append('"')
          index++
        } else {
          quoted = false
          quoteClosed = true
        }
      } else if (character === '\r' || character === '\n') {
        if (character === '\r' && text[index + 1] === '\n') index++
        append('\n')
        line++
      } else {
        append(character)
      }
      continue
    }

    if (quoteClosed) {
      if (character === delimiter) {
        pushField()
        hasRecordContent = true
      } else if (character === '\r' || character === '\n') {
        pushRow()
        if (character === '\r' && text[index + 1] === '\n') index++
        line++
        rowStartLine = line
      } else if (character === ' ' || character === '\t') {
        // Spaces after a quoted field are formatting, not part of its value.
      } else {
        throw new MusicCatalogError('MALFORMED_CSV', 'Há conteúdo inesperado após um campo entre aspas.', rowStartLine)
      }
      continue
    }

    if (character === '"') {
      if (field.trim().length > 0) {
        throw new MusicCatalogError('MALFORMED_CSV', 'Aspas precisam começar no início de um campo CSV.', rowStartLine)
      }
      field = ''
      quoted = true
      hasRecordContent = true
    } else if (character === delimiter) {
      pushField()
      hasRecordContent = true
    } else if (character === '\r' || character === '\n') {
      pushRow()
      if (character === '\r' && text[index + 1] === '\n') index++
      line++
      rowStartLine = line
    } else {
      append(character)
      if (character !== ' ' && character !== '\t') hasRecordContent = true
    }
  }

  if (quoted) {
    throw new MusicCatalogError('MALFORMED_CSV', 'O CSV termina antes do fechamento de um campo entre aspas.', rowStartLine)
  }
  if (stopped) return rows
  pushRow()
  return rows
}

function normalizeHeader(value: string): string {
  return value.replace(/^\uFEFF/u, '').trim().toLocaleLowerCase('pt-BR')
}

function detectDelimiter(text: string): { delimiter: MusicCatalogDelimiter; headers: string[] } {
  const candidates: Array<{ delimiter: MusicCatalogDelimiter; headers: string[] }> = []
  const parseErrors: MusicCatalogError[] = []

  for (const delimiter of [';', ','] as const) {
    try {
      const firstRow = parseRows(text, delimiter, 1, true)[0]
      if (!firstRow) continue
      const headers = firstRow.fields.map(normalizeHeader)
      if (headers.length === REQUIRED_HEADERS.length &&
          new Set(headers).size === REQUIRED_HEADERS.length &&
          REQUIRED_HEADERS.every(header => headers.includes(header))) {
        candidates.push({ delimiter, headers })
      }
    } catch (error) {
      if (error instanceof MusicCatalogError) parseErrors.push(error)
      else throw error
    }
  }

  if (candidates.length > 1) {
    throw new MusicCatalogError('AMBIGUOUS_DELIMITER', 'Não foi possível identificar um delimitador CSV sem ambiguidade.')
  }
  if (candidates.length === 1) return candidates[0]
  if (parseErrors.length === 2 && parseErrors.every(error => error.code === 'MALFORMED_CSV')) throw parseErrors[0]
  throw new MusicCatalogError('INVALID_HEADER', 'O CSV precisa conter os cabeçalhos artista, numero e nome_musica exatamente uma vez.')
}

function normalizeMetadata(value: string): string | null {
  const normalized = value.normalize('NFC').replace(/\s+/gu, ' ').trim()
  return normalized.length === 0 ? null : normalized
}

function compareMusicNumbers(left: string, right: string): number {
  return left.length - right.length || (left < right ? -1 : left > right ? 1 : 0)
}

export function calculateMusicCatalogRevision(records: readonly MusicCatalogRecord[]): string {
  const semanticRows = [...records]
    .sort((left, right) => compareMusicNumbers(left.musicNumber, right.musicNumber))
    .map(record => [record.musicNumber, record.artist, record.title])
  return crypto.createHash('sha256').update(JSON.stringify(semanticRows)).digest('hex')
}

function parseMusicCatalogCsvInternal(
  input: Uint8Array | string,
  recoverInvalidMusicNumbers: boolean
): ParsedMusicCatalogWithIssues {
  const text = decodeCsvInput(input)
  if (text.trim().length === 0) {
    throw new MusicCatalogError('EMPTY_CATALOG', 'O arquivo CSV está vazio.')
  }
  const { delimiter, headers } = detectDelimiter(text)
  const rows = parseRows(text, delimiter)
  if (rows.length < 2) {
    throw new MusicCatalogError('EMPTY_CATALOG', 'O catálogo precisa conter pelo menos um registro de música.', rows[0]?.rowNumber ?? 1)
  }

  const headerRow = rows[0]
  const indexes = Object.fromEntries(headers.map((header, index) => [header, index])) as Record<typeof REQUIRED_HEADERS[number], number>
  const records: MusicCatalogRecord[] = []
  const seenNumbers = new Map<string, number>()
  const warnings: MusicCatalogWarning[] = []
  const issues: MusicCatalogImportIssue[] = []
  let warningCount = 0
  let missingArtistCount = 0
  let missingTitleCount = 0

  for (const row of rows.slice(1)) {
    if (row.fields.length !== REQUIRED_HEADERS.length) {
      throw new MusicCatalogError('INVALID_COLUMN_COUNT', 'O registro não contém exatamente três colunas.', row.rowNumber)
    }
    const musicNumber = row.fields[indexes.numero].trim()
    let videoCode: string
    try {
      videoCode = normalizeCatalogCodeForVideoMatch(musicNumber)
    } catch {
      const issue = new MusicCatalogError(
        'INVALID_MUSIC_NUMBER',
        'O número da música deve conter de 1 a 5 dígitos ASCII e não pode começar com zero.',
        row.rowNumber,
        'numero'
      )
      if (!recoverInvalidMusicNumbers) throw issue
      issues.push({
        rowNumber: row.rowNumber,
        field: 'numero',
        value: musicNumber,
        code: 'INVALID_MUSIC_NUMBER',
        reason: 'O código deve conter de 1 a 5 dígitos, sem zero inicial.'
      })
      continue
    }
    const previousRow = seenNumbers.get(musicNumber)
    if (previousRow !== undefined) {
      throw new MusicCatalogError('DUPLICATE_MUSIC_NUMBER', `O número da música está duplicado (primeira ocorrência na linha ${previousRow}).`, row.rowNumber, 'numero')
    }
    seenNumbers.set(musicNumber, row.rowNumber)

    const artist = normalizeMetadata(row.fields[indexes.artista])
    const title = normalizeMetadata(row.fields[indexes.nome_musica])
    if (artist === null) {
      missingArtistCount++
      warningCount++
      if (warnings.length < MAX_REPORTED_WARNINGS) warnings.push({ code: 'MISSING_ARTIST', rowNumber: row.rowNumber, field: 'artista' })
    }
    if (title === null) {
      missingTitleCount++
      warningCount++
      if (warnings.length < MAX_REPORTED_WARNINGS) warnings.push({ code: 'MISSING_TITLE', rowNumber: row.rowNumber, field: 'nome_musica' })
    }
    records.push({
      musicNumber,
      videoCode,
      artist,
      title,
      normalizedArtist: normalizedSearchText(artist),
      normalizedTitle: normalizedSearchText(title)
    })
  }

  if (records.length === 0) throw new MusicCatalogError('EMPTY_CATALOG', 'O catálogo precisa conter pelo menos um registro de música.', headerRow.rowNumber)
  return {
    records,
    delimiter,
    warnings,
    warningCount,
    missingArtistCount,
    missingTitleCount,
    recordCount: records.length,
    revision: calculateMusicCatalogRevision(records),
    issues
  }
}

/** Strict parser retained for consumers that require every row to be valid. */
export function parseMusicCatalogCsv(input: Uint8Array | string): ParsedMusicCatalog {
  const { issues: _issues, ...parsed } = parseMusicCatalogCsvInternal(input, false)
  return parsed
}

/** Standalone import parser: only invalid music-number rows are recoverable. */
export function parseMusicCatalogCsvWithRecoverableIssues(input: Uint8Array | string): ParsedMusicCatalogWithIssues {
  return parseMusicCatalogCsvInternal(input, true)
}
