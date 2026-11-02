import fs from 'node:fs'
import path from 'node:path'
import { writeOperatingModeConfiguration } from '../src/operating-mode'

/** Existing Controller E2Es seed their intended mode instead of testing first-run Welcome. */
export function prepareControllerModeProfile(userDataDirectory: string): void {
  fs.mkdirSync(userDataDirectory, { recursive: true })
  const modePath = path.join(userDataDirectory, 'operating-mode.json')
  if (!fs.existsSync(modePath)) writeOperatingModeConfiguration(userDataDirectory, 'controller')
}
