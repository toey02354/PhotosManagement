import { basename, extname } from 'node:path'

const DATE_PREFIX = /^\d{8}-/
const IPHONE_SEQUENCE = /^(IMG)_(\d{4})(?=$|[_\-\s(])/i

export function stripDatePrefix(name: string): string {
  return name.replace(DATE_PREFIX, '')
}

export function convertBuddhistEraDatePrefix(name: string): {
  name: string
  detected: boolean
} {
  const match = /^(\d{4})(\d{2})(\d{2})-(.+)$/.exec(name)
  if (!match) return { name, detected: false }

  const [, yearText, monthText, dayText, remainder] = match
  const buddhistYear = Number(yearText)
  const month = Number(monthText)
  const day = Number(dayText)
  if (buddhistYear < 2400 || buddhistYear > 2999) return { name, detected: false }

  const commonEraYear = buddhistYear - 543
  const date = new Date(Date.UTC(commonEraYear, month - 1, day))
  const valid = date.getUTCFullYear() === commonEraYear
    && date.getUTCMonth() === month - 1
    && date.getUTCDate() === day
  if (!valid) return { name, detected: false }

  return {
    name: `${String(commonEraYear).padStart(4, '0')}${monthText}${dayText}-${remainder}`,
    detected: true,
  }
}

export function normalizeFilename(name: string): string {
  const clean = stripDatePrefix(name)
  return clean.slice(0, clean.length - extname(clean).length).toLowerCase().replace(/-\d+$/, '')
}

export function iphoneSequenceKey(name: string): string | null {
  const clean = stripDatePrefix(basename(name))
  const extension = extname(clean)
  const stem = clean.slice(0, clean.length - extension.length)
  const match = IPHONE_SEQUENCE.exec(stem)
  return match ? `IMG_${match[2]}` : null
}

export function isCanonicalIphoneOriginal(name: string): boolean {
  const clean = stripDatePrefix(basename(name))
  const extension = extname(clean)
  const stem = clean.slice(0, clean.length - extension.length)
  return /^IMG_\d{4}$/i.test(stem)
}
