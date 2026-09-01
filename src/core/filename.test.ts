import { describe, expect, it } from 'vitest'
import {
  convertBuddhistEraDatePrefix,
  iphoneSequenceKey,
  isAuthoritativeIphoneOriginal,
  isCanonicalIphoneOriginal,
  normalizeFilename,
  stripDatePrefix,
} from './filename'

describe('v9 filename behavior', () => {
  it('strips one leading date prefix', () => {
    expect(stripDatePrefix('20250104-IMG_0415.HEIC')).toBe('IMG_0415.HEIC')
  })

  it('converts a valid Buddhist Era prefix to Common Era', () => {
    expect(convertBuddhistEraDatePrefix('25671221-IMG_4697.JPG')).toEqual({
      name: '20241221-IMG_4697.JPG', detected: true,
    })
  })

  it('leaves Common Era and invalid calendar dates unchanged', () => {
    expect(convertBuddhistEraDatePrefix('20250104-IMG_0415.HEIC').detected).toBe(false)
    expect(convertBuddhistEraDatePrefix('25670230-IMG_0415.HEIC').detected).toBe(false)
  })

  it('normalizes date-prefixed duplicate suffixes', () => {
    expect(normalizeFilename('20250104-IMG_0415-2.HEIC')).toBe('img_0415')
  })

  it('matches only conservative IMG sequence names', () => {
    expect(iphoneSequenceKey('20250104-IMG_0415_Original.jpg')).toBe('IMG_0415')
    expect(iphoneSequenceKey('holiday_IMG_0415.jpg')).toBeNull()
  })

  it('recognizes canonical originals with optional date prefixes', () => {
    expect(isCanonicalIphoneOriginal('IMG_0415.HEIC')).toBe(true)
    expect(isCanonicalIphoneOriginal('20250104-IMG_0415.jpg')).toBe(true)
    expect(isCanonicalIphoneOriginal('IMG_0415_Original.jpg')).toBe(false)
  })

  it('accepts explicitly labeled originals as metadata sources', () => {
    expect(isAuthoritativeIphoneOriginal('IMG_0415_Original.HEIC')).toBe(true)
    expect(isAuthoritativeIphoneOriginal('20250104-IMG_0415_Original.jpg')).toBe(true)
    expect(isAuthoritativeIphoneOriginal('IMG_0415-edit.jpg')).toBe(false)
  })
})
