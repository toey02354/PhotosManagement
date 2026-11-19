import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { UndoHistory } from './undo'

const temporary: string[] = []
afterEach(async () => Promise.all(temporary.splice(0).map((path) => rm(path, { recursive: true, force: true }))))

async function setup() {
  const folder = await mkdtemp(join(tmpdir(), 'photos-undo-'))
  temporary.push(folder)
  const journal = join(folder, 'last-run.json')
  const original = join(folder, 'IMG_1234.MOV')
  const renamed = join(folder, '20241119-IMG_1234.MOV')
  await writeFile(original, 'video')
  return { folder, journal, original, renamed }
}

describe('Undo history', () => {
  it('restores a rename and subsequent move after reopening history', async () => {
    const { folder, journal, original, renamed } = await setup()
    const live = join(folder, 'LivePhotos')
    await mkdir(live)
    const moved = join(live, '20241119-IMG_1234.MOV')
    const move = new UndoHistory(journal).startRun()
    expect(await move(original, renamed)).toBe(true)
    expect(await move(renamed, moved)).toBe(true)

    const reopened = new UndoHistory(journal)
    expect(await reopened.count()).toBe(2)
    expect(await reopened.undo()).toMatchObject({ restored: 2, remaining: 0, warnings: [] })
    expect(await readFile(original, 'utf8')).toBe('video')
    await expect(readFile(renamed)).rejects.toMatchObject({ code: 'ENOENT' })
    await expect(readFile(moved)).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('keeps a blocked move available for retry and preserves both files', async () => {
    const { journal, original, renamed } = await setup()
    const history = new UndoHistory(journal)
    await history.startRun()(original, renamed)
    await writeFile(original, 'new file')
    expect(await history.undo()).toMatchObject({ restored: 0, remaining: 1 })
    expect(await readFile(original, 'utf8')).toBe('new file')
    expect(await readFile(renamed, 'utf8')).toBe('video')

    await rm(original)
    expect(await history.undo()).toMatchObject({ restored: 1, remaining: 0 })
    expect(await readFile(original, 'utf8')).toBe('video')
  })

  it('keeps a file edited after the run at its current location', async () => {
    const { journal, original, renamed } = await setup()
    const history = new UndoHistory(journal)
    await history.startRun()(original, renamed)
    await writeFile(renamed, 'edited video')
    expect(await history.undo()).toMatchObject({ restored: 0, remaining: 1 })
    expect(await readFile(renamed, 'utf8')).toBe('edited video')
    await expect(readFile(original)).rejects.toMatchObject({ code: 'ENOENT' })
  })
})
