export const DEFAULT_SIDEBAR_DISPLAY_NAME = 'Karaoke Queue'
export const SIDEBAR_DISPLAY_NAME_LIMIT = 17

type GraphemeSegmenter = new (
  locale?: string,
  options?: { granularity: 'grapheme' }
) => { segment: (input: string) => Iterable<{ segment: string }> }

function graphemes(value: string): string[] {
  const Segmenter = (Intl as unknown as { Segmenter?: GraphemeSegmenter }).Segmenter
  if (Segmenter) return [...new Segmenter(undefined, { granularity: 'grapheme' }).segment(value)].map(item => item.segment)
  return Array.from(value)
}

export function countVisibleCharacters(value: string): number {
  return graphemes(value).length
}

export function sanitizeSidebarDisplayNameInput(value: string): string {
  const allowed = value.normalize('NFC').replace(/\s/gu, ' ').replace(/[^\p{L}\p{N}\p{M} ]/gu, '')
  return graphemes(allowed).slice(0, SIDEBAR_DISPLAY_NAME_LIMIT).join('')
}

export function normalizeSidebarDisplayName(value: string): string {
  return sanitizeSidebarDisplayNameInput(value).trim()
}

export function validateSidebarDisplayName(value: unknown): string {
  if (typeof value !== 'string') throw new Error('Nome exibido inválido')
  const normalized = normalizeSidebarDisplayName(value)
  const normalizedInput = value.normalize('NFC').trim()
  if (!normalized || normalized !== normalizedInput
    || countVisibleCharacters(normalized) > SIDEBAR_DISPLAY_NAME_LIMIT) {
    throw new Error('Informe um nome válido com até 17 caracteres.')
  }
  return normalized
}
