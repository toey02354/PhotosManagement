import { access, stat } from 'node:fs/promises'
import { constants } from 'node:fs'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

const execute = promisify(execFile)
const pad = (value: number) => String(value).padStart(2, '0')
async function executable(path: string) { try { await access(path, constants.X_OK); return true } catch { return false } }
async function which(name: string) { try { return (await execute('which', [name])).stdout.trim() || null } catch { return null } }

export async function findExiftool() {
  const found = await which('exiftool'); if (found) return found
  for (const path of ['/opt/homebrew/bin/exiftool', '/usr/local/bin/exiftool', '/usr/bin/exiftool']) if (await executable(path)) return path
  return null
}

export async function findSetFile() {
  const found = await which('SetFile'); if (found) return found
  for (const path of ['/usr/bin/SetFile', '/Developer/Tools/SetFile']) if (await executable(path)) return path
  try { const path = (await execute('xcrun', ['--find', 'SetFile'])).stdout.trim(); return path && await executable(path) ? path : null } catch { return null }
}

export function parseExiftoolDate(value: string): Date | null {
  const match = /^(\d{4}):(\d{2}):(\d{2})[ T](\d{2}):(\d{2}):(\d{2})/.exec(value.trim())
  if (!match) return null
  const p = match.slice(1).map(Number), date = new Date(p[0], p[1] - 1, p[2], p[3], p[4], p[5])
  return Number.isNaN(date.valueOf()) ? null : date
}

export async function getBestCreatedDate(path: string, exiftool: string | null): Promise<Date | null> {
  if (exiftool) try {
    const output = (await execute(exiftool, ['-s3', '-DateTimeOriginal', '-CreateDate', '-MediaCreateDate', '-TrackCreateDate', path], { maxBuffer: 1024 * 1024 })).stdout
    for (const line of output.split(/\r?\n/)) { const date = parseExiftoolDate(line); if (date) return date }
  } catch { /* Fall through. */ }
  if (process.platform === 'darwin') try {
    const value = (await execute('mdls', ['-raw', '-name', 'kMDItemContentCreationDate', path])).stdout.trim()
    const match = /^(\d{4})-(\d{2})-(\d{2}) (\d{2}):(\d{2}):(\d{2}) ([+-]\d{4})$/.exec(value)
    if (match) { const date = new Date(`${match[1]}-${match[2]}-${match[3]}T${match[4]}:${match[5]}:${match[6]}${match[7].slice(0, 3)}:${match[7].slice(3)}`); if (!Number.isNaN(date.valueOf())) return date }
  } catch { /* Fall through. */ }
  try { const details = await stat(path); return details.birthtimeMs > 0 ? details.birthtime : null } catch { return null }
}

export async function copyEmbeddedMetadata(source: string, target: string, exiftool: string): Promise<string | null> {
  const excluded = ['FileName', 'Directory', 'FileSize', 'FileType', 'FileTypeExtension', 'MIMEType', 'ImageWidth', 'ImageHeight', 'ExifImageWidth', 'ExifImageHeight', 'Orientation', 'ThumbnailImage', 'PreviewImage', 'JpgFromRaw', 'ICC_Profile:All'].map((tag) => `--${tag}`)
  try { await execute(exiftool, ['-overwrite_original_in_place', '-P', '-TagsFromFile', source, '-all:all', ...excluded, target], { maxBuffer: 4 * 1024 * 1024 }); return null }
  catch (error) { return error instanceof Error ? error.message : String(error) }
}

export async function setFilesystemDates(path: string, date: Date, setFile: string | null): Promise<string | null> {
  const warnings: string[] = []
  const touchTime = `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}${pad(date.getHours())}${pad(date.getMinutes())}.${pad(date.getSeconds())}`
  try { await execute('touch', ['-t', touchTime, path]) } catch (error) { warnings.push(`touch: ${String(error)}`) }
  if (!setFile) warnings.push('SetFile not found; Finder Created date was not changed')
  else {
    const value = `${pad(date.getMonth() + 1)}/${pad(date.getDate())}/${date.getFullYear()} ${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`
    try { await execute(setFile, ['-d', value, '-m', value, path]) } catch (error) { warnings.push(`SetFile: ${String(error)}`) }
  }
  return warnings.length ? warnings.join('; ') : null
}

export function datePrefix(date: Date) { return `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}` }
