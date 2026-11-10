import path from 'node:path'

export const VIDEO_LIBRARY_SUPPORTED_EXTENSIONS = Object.freeze([
  '.mp4', '.mkv', '.webm', '.avi', '.mov', '.mpeg', '.mpg', '.wmv'
] as const)

const supportedExtensions = new Set<string>(VIDEO_LIBRARY_SUPPORTED_EXTENSIONS)

/** Container recognition only; this does not claim that an engine can decode the file. */
export function isSupportedVideoExtension(filename: string): boolean {
  if (filename.includes('/') || filename.includes('\\')) return false
  const extension = path.extname(filename).toLowerCase()
  return supportedExtensions.has(extension)
}

/** Return the canonical five-digit prefix when the filename follows the library contract. */
export function parseVideoCode(filename: string): string | undefined {
  if (!isSupportedVideoExtension(filename)) return undefined

  const extension = path.extname(filename)
  const stem = filename.slice(0, -extension.length)
  const match = /^([0-9]{5})(?:$|[ _-])/.exec(stem)
  return match?.[1]
}

export type VideoAvailability = 'available' | 'ambiguous' | 'missing' | 'unreadable' | 'unknown'
export type VideoLibraryScanStatus = 'not-scanned' | 'scanning' | 'ready' | 'degraded' | 'closed'

/** Pathless inventory item suitable for future Controller synchronization. */
export interface VideoLibraryInventoryItem {
  musicCode: string
  availability: VideoAvailability
  candidateCount: number
}

export interface VideoLibraryCounts {
  availableCodes: number
  ambiguousCodes: number
  missingCodes: number
  unreadableCodes: number
  unknownCodes: number
  indexedFiles: number
  invalidFilenames: number
  unreadableFiles: number
}

/** Snapshot contains no filesystem paths. `revision` identifies its pathless inventory state. */
export interface VideoLibrarySnapshot {
  version: 1
  revision: string
  scanStatus: VideoLibraryScanStatus
  scannedAt: string | null
  configuredRootCount: number
  scannedRootCount: number
  unavailableRootCount: number
  counts: VideoLibraryCounts
  items: VideoLibraryInventoryItem[]
}

/** Local diagnostics intentionally use root indexes and relative paths, never absolute paths. */
export interface VideoLibraryDiagnostic {
  code: 'INVALID_FILENAME' | 'UNREADABLE_FILE' | 'ROOT_UNAVAILABLE' | 'UNSAFE_ENTRY' | 'DUPLICATE_CODE'
  rootIndex: number
  musicCode?: string
  relativePath?: string
  conflictingPaths?: string[]
  filesystemCode?: string
}

export type VideoLookupResult =
  | { status: 'available'; musicCode: string; filePath: string }
  | { status: Exclude<VideoAvailability, 'available'>; musicCode: string }
  | { status: 'invalid-code'; musicCode: string }

/** Main-process-only result used to stream an indexed file; never cross an IPC or inventory boundary. */
export type VideoMediaOpenResult =
  | { status: 'available'; musicCode: string; revision: string; extension: string; size: number; filePath: string; handle: import('node:fs/promises').FileHandle }
  | { status: Exclude<VideoAvailability, 'available'> | 'invalid-code'; musicCode: string }

export function isCanonicalVideoCode(value: unknown): value is string {
  return typeof value === 'string' && /^[0-9]{5}$/.test(value)
}
