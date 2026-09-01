import { describe, expect, it } from 'vitest'
import { buildSourceIndex, type FileRecord } from './files'

const record = (filename: string, extension: string, path = filename): FileRecord => ({ filename, extension, path, size: 1 })

describe('source indexing', () => {
  it('prefers HEIC over lower-priority canonical originals', () => {
    const result = buildSourceIndex([
      record('IMG_0415.jpg', '.jpg'), record('IMG_0415.HEIC', '.heic'),
    ])
    expect(result.sourceByKey.get('IMG_0415')?.filename).toBe('IMG_0415.HEIC')
    expect(result.ambiguous).toEqual([])
  })

  it('marks equally preferred originals as ambiguous', () => {
    const result = buildSourceIndex([
      record('IMG_0415.HEIC', '.heic', '/a/IMG_0415.HEIC'),
      record('20250101-IMG_0415.HEIC', '.heic', '/b/IMG_0415.HEIC'),
    ])
    expect(result.sourceByKey.has('IMG_0415')).toBe(false)
    expect(result.ambiguous[0].sources).toHaveLength(2)
  })

  it('ignores derived files as authoritative sources', () => {
    expect(buildSourceIndex([record('IMG_0415_Original.jpg', '.jpg')]).sourceByKey.size).toBe(0)
  })
})
