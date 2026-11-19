import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { JobEvent, JobOptions } from '../shared/job'
import { processJob } from './job'

const temporary: string[] = []
afterEach(async () => Promise.all(temporary.splice(0).map((path) => rm(path, { recursive: true, force: true }))))

async function folder() { const path = await mkdtemp(join(tmpdir(), 'photos-management-')); temporary.push(path); return path }
const options = (targetFolder: string, dryRun: boolean): JobOptions => ({
  targetFolder, sourceFolder: '', dryRun, addDatePrefix: false, convertBuddhistEra: true,
  moveLivePhotoVideos: true, copyMetadata: false, syncFinderDates: false, recursiveSource: false,
})

async function run(config: JobOptions) {
  const events: JobEvent[] = []; await processJob(config, (event) => events.push(event))
  return events.find((event): event is Extract<JobEvent, { type: 'summary' }> => event.type === 'summary')!.text
}

describe('Node job engine', () => {
  it('keeps preview immutable while reporting a B.E. rename', async () => {
    const target = await folder(), original = '25671221-IMG_4697.JPG'
    await writeFile(join(target, original), 'photo')
    const summary = await run(options(target, true))
    expect(await readdir(target)).toEqual([original])
    expect(summary).toContain('Would rename                 : 1')
    expect(summary).toContain('PREVIEW ONLY — no files were changed.')
  })

  it('renames a B.E. prefix and moves the matching Live Photo video', async () => {
    const target = await folder()
    await writeFile(join(target, '25671221-IMG_4697.JPG'), 'still')
    await writeFile(join(target, '25671221-IMG_4697.MOV'), 'video-content')
    const summary = await run(options(target, false))
    expect(await readFile(join(target, '20241221-IMG_4697.JPG'), 'utf8')).toBe('still')
    expect(await readFile(join(target, 'LivePhotos', '20241221-IMG_4697.MOV'), 'utf8')).toBe('video-content')
    expect(summary).toContain('Renamed                      : 2')
    expect(summary).toContain('Moved LivePhoto videos       : 1')
  })

  it('reports different-sized same-base files without moving them', async () => {
    const target = await folder()
    await writeFile(join(target, 'IMG_0001.jpg'), 'a')
    await writeFile(join(target, 'IMG_0001.png'), 'different')
    const config = options(target, false); config.convertBuddhistEra = false; config.moveLivePhotoVideos = false
    const summary = await run(config)
    expect((await readdir(target)).sort()).toEqual(['IMG_0001.jpg', 'IMG_0001.png'])
    expect(summary).toContain('Conflict groups              : 1')
  })

  it('matches an _Original source for Finder date synchronization', async () => {
    const target = await folder(), source = await folder()
    await writeFile(join(target, 'IMG_2959_Original.jpg'), 'derived')
    await writeFile(join(source, 'IMG_2959_Original.HEIC'), 'original')
    const config = options(target, true)
    config.convertBuddhistEra = false
    config.sourceFolder = source
    config.syncFinderDates = true
    const summary = await run(config)
    expect(summary).toContain('Filename source matches      : 1')
    expect(summary).toContain('Would sync Finder dates      : 1')
  })

  it('falls back to a matching Live Photo MOV source', async () => {
    const target = await folder(), source = await folder()
    await writeFile(join(target, 'IMG_2741_Original.jpg'), 'derived')
    await writeFile(join(source, 'IMG_2741_Original.mov'), 'live-video')
    const config = options(target, true)
    config.convertBuddhistEra = false
    config.sourceFolder = source
    config.syncFinderDates = true
    const summary = await run(config)
    expect(summary).toContain('Filename source matches      : 1')
    expect(summary).toContain('Would sync Finder dates      : 1')
  })
})
