/** Small, DOM-independent subset of the keyboard event fields used by Standalone V1. */
export interface StandaloneKeyboardStroke {
  readonly key: string
  /** Physical code identifies numeric keypad digits even when NumLock emits navigation key values. */
  readonly code?: string
  readonly repeat?: boolean
  readonly ctrlKey?: boolean
  readonly shiftKey?: boolean
  readonly altKey?: boolean
  readonly metaKey?: boolean
}

export type StandaloneKeyboardAction =
  | { readonly type: 'digit'; readonly digit: string }
  | { readonly type: 'confirm-normal' }
  | { readonly type: 'confirm-priority' }
  | { readonly type: 'toggle-pause' }
  | { readonly type: 'next' }
  | { readonly type: 'restart' }
  | { readonly type: 'confirm-stop-all' }
  | { readonly type: 'show-current-track-info' }
  | { readonly type: 'backspace' }
  | { readonly type: 'escape' }

/** Interprets only V1 keys. Repeated keydown events and unsupported modifier combinations are ignored. */
export function interpretStandaloneKeyboardStroke(
  stroke: StandaloneKeyboardStroke
): StandaloneKeyboardAction | undefined {
  if (stroke.repeat) return undefined

  const ctrl = stroke.ctrlKey === true
  const shift = stroke.shiftKey === true
  const alt = stroke.altKey === true
  const meta = stroke.metaKey === true

  if ((stroke.key === ' ' || stroke.code === 'Space') && ctrl && !shift && !alt && !meta) {
    return { type: 'confirm-stop-all' }
  }

  if (!ctrl && !shift && !alt && !meta) {
    const keypadDigit = stroke.code?.match(/^Numpad([0-9])$/)?.[1]
    if (keypadDigit !== undefined) return { type: 'digit', digit: keypadDigit }
  }

  if (stroke.key === 'ArrowRight') {
    return ctrl && !shift && !alt && !meta ? { type: 'next' } : undefined
  }
  if (ctrl || shift || alt || meta) return undefined

  if (/^[0-9]$/.test(stroke.key)) return { type: 'digit', digit: stroke.key }
  if (stroke.key === 'Enter') return { type: 'confirm-normal' }
  if (stroke.key === ' ') return { type: 'toggle-pause' }
  if (stroke.key === 'Backspace') return { type: 'backspace' }
  if (stroke.key === 'Escape') return { type: 'escape' }

  const normalizedKey = stroke.key.toLowerCase()
  if (normalizedKey === 'p') return { type: 'confirm-priority' }
  if (normalizedKey === 'r') return { type: 'restart' }
  if (normalizedKey === 'i') return { type: 'show-current-track-info' }
  return undefined
}
