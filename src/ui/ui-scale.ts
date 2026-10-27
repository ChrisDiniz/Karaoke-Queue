/**
 * Automatic UI zoom levels for desktop windows. Width and height are logical
 * Electron content dimensions, so OS display DPI scaling is already reflected.
 */
export const UI_SCALE = {
  standard: 1,
  qhd: 1.1,
  ultraHd: 1.2
} as const

export type UiScalePreference = 'auto' | '100' | '110' | '125' | '150'

export interface UiScaleState {
  preference: UiScalePreference
  automaticFactor: number
  effectiveFactor: number
}

export const UI_SCALE_PREFERENCES: readonly UiScalePreference[] = ['auto', '100', '110', '125', '150']

export function getUiScaleFactor(width: number, height: number): number {
  if (width >= 3200 && height >= 1800) return UI_SCALE.ultraHd
  if (width >= 2400 && height >= 1200) return UI_SCALE.qhd
  return UI_SCALE.standard
}

export function isUiScalePreference(value: unknown): value is UiScalePreference {
  return typeof value === 'string' && UI_SCALE_PREFERENCES.includes(value as UiScalePreference)
}

export function normalizeUiScalePreference(value: unknown): UiScalePreference {
  return isUiScalePreference(value) ? value : 'auto'
}

export function resolveUiScaleFactor(preference: UiScalePreference, automaticFactor: number): number {
  return preference === 'auto' ? automaticFactor : Number(preference) / 100
}

export function createUiScaleState(
  preference: UiScalePreference,
  automaticFactor: number
): UiScaleState {
  return {
    preference,
    automaticFactor,
    effectiveFactor: resolveUiScaleFactor(preference, automaticFactor)
  }
}
