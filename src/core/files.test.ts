import { describe, expect, it } from 'vitest'
import { buildSourceIndex, type FileRecord } from './files'

const record = (filename: string, extension: string, path = filename): FileRecord => ({ filename, extension, path, size: 1 })

describe('source indexing', () => {
  it('skips competing originals across formats', () => {
    const result = buildSourceIndex([
      record('IMG_0415.jpg', '.jpg'), record('IMG_0415.HEIC', '.heic'),
    ])
    expect(result.sourceByKey.has('IMG_0415')).toBe(false)
    expect(result.ambiguous[0].sources).toHaveLength(2)
  })

  it('marks equally preferred originals as ambiguous', () => {
    const result = buildSourceIndex([
      record('IMG_0415.HEIC', '.heic', '/a/IMG_0415.HEIC'),
      record('20250101-IMG_0415.HEIC', '.heic', '/b/IMG_0415.HEIC'),
    ])
    expect(result.sourceByKey.has('IMG_0415')).toBe(false)
    expect(result.ambiguous[0].sources).toHaveLength(2)
  })

  it('accepts explicitly labeled originals but ignores edited derivatives', () => {
    expect(buildSourceIndex([record('IMG_0415_Original.jpg', '.jpg')]).sourceByKey.size).toBe(1)
    expect(buildSourceIndex([record('IMG_0415-edit.jpg', '.jpg')]).sourceByKey.size).toBe(0)
  })

  it('allows a unique video source and skips competing matches', () => {
    const videoOnly = buildSourceIndex([record('IMG_2741_Original.mov', '.mov')])
    expect(videoOnly.sourceByKey.get('IMG_2741')?.filename).toBe('IMG_2741_Original.mov')

    const withStill = buildSourceIndex([
      record('IMG_2741_Original.mov', '.mov'),
      record('IMG_2741_Original.HEIC', '.heic'),
    ])
    expect(withStill.ambiguous[0].sources).toHaveLength(2)
  })
})
