import { access, readdir, realpath, stat } from 'node:fs/promises'
import { constants } from 'node:fs'
import { extname, join } from 'node:path'
import { iphoneSequenceKey, isAuthoritativeIphoneOriginal } from './filename'

export const IMAGE_EXTENSIONS = new Set(['.jpg', '.jpeg', '.heic', '.png', '.dng', '.tif', '.tiff'])
export const VIDEO_EXTENSIONS = new Set(['.mov', '.mp4', '.m4v'])
export const SUPPORTED_EXTENSIONS = new Set([...IMAGE_EXTENSIONS, ...VIDEO_EXTENSIONS])

export interface FileRecord { filename: string; path: string; extension: string; size: number }
export interface AmbiguousSource { key: string; sources: string[] }

export async function pathExists(path: string): Promise<boolean> {
  try { await access(path, constants.F_OK); return true } catch { return false }
}

export async function scanFolder(folder: string, recursive = false): Promise<FileRecord[]> {
  const records: FileRecord[] = []
  const visit = async (directory: string): Promise<void> => {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      if (entry.name.startsWith('.')) continue
      const path = join(directory, entry.name)
      if (entry.isDirectory()) { if (recursive) await visit(path); continue }
      if (!entry.isFile()) continue
      const extension = extname(entry.name).toLowerCase()
      if (!SUPPORTED_EXTENSIONS.has(extension)) continue
      try { records.push({ filename: entry.name, path, extension, size: (await stat(path)).size }) } catch { /* File disappeared. */ }
    }
  }
  await visit(folder)
  return records
}

export function buildSourceIndex(records: FileRecord[]) {
  const candidates = new Map<string, FileRecord[]>()
  for (const record of records) {
    const key = iphoneSequenceKey(record.filename)
    if (!SUPPORTED_EXTENSIONS.has(record.extension) || !key || !isAuthoritativeIphoneOriginal(record.filename)) continue
    candidates.set(key, [...(candidates.get(key) ?? []), record])
  }
  const sourceByKey = new Map<string, FileRecord>()
  const ambiguous: AmbiguousSource[] = []
  for (const [key, values] of candidates) {
    if (values.length === 1) sourceByKey.set(key, values[0])
    else ambiguous.push({ key, sources: values.map((value) => value.path) })
  }
  return { sourceByKey, ambiguous }
}

export async function matchTargetsToSources(targets: FileRecord[], sources: Map<string, FileRecord>) {
  const matches = new Map<string, string>()
  for (const target of targets) {
    const key = IMAGE_EXTENSIONS.has(target.extension) ? iphoneSequenceKey(target.filename) : null
    const source = key ? sources.get(key) : undefined
    if (!source) continue
    const targetDate = /^\d{8}(?=-)/.exec(target.filename)?.[0]
    const sourceDate = /^\d{8}(?=-)/.exec(source.filename)?.[0]
    if (targetDate && sourceDate && targetDate !== sourceDate) continue
    try { if (await realpath(target.path) === await realpath(source.path)) continue } catch { if (target.path === source.path) continue }
    matches.set(target.path, source.path)
  }
  return matches
}
