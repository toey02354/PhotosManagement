import { lstat, open, readFile, rename, unlink } from 'node:fs/promises'
import { dirname } from 'node:path'
import { randomUUID } from 'node:crypto'
import { fileIdentity, moveWithoutReplacing, pathExists, sameFile, type FileIdentity } from './files'

interface RecordedMove {
  from: string
  to: string
  identity: FileIdentity
  parent: string
}

async function directoryIdentity(path: string) {
  const stat = await lstat(path, { bigint: true })
  if (!stat.isDirectory()) throw new Error('Expected a regular directory.')
  return `${stat.dev}:${stat.ino}:${stat.birthtimeNs}`
}

async function matches(path: string, identity: FileIdentity) {
  return await pathExists(path) && sameFile(identity, await fileIdentity(path))
}

export class UndoHistory {
  constructor(private readonly path: string) {}

  private async read(): Promise<RecordedMove[]> {
    try {
      return JSON.parse(await readFile(this.path, 'utf8')) as RecordedMove[]
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []
      throw error
    }
  }

  private async save(moves: RecordedMove[]) {
    const temporary = `${this.path}.${randomUUID()}.tmp`
    const file = await open(temporary, 'wx', 0o600)
    try {
      try {
        await file.writeFile(JSON.stringify(moves))
        await file.sync()
      } finally {
        await file.close()
      }
      await rename(temporary, this.path)
    } finally {
      if (await pathExists(temporary)) await unlink(temporary)
    }
  }

  async count() {
    return (await this.read()).length
  }

  startRun() {
    let moves: RecordedMove[] = []
    return async (from: string, to: string) => {
      if (await pathExists(to)) return false
      const identity = await fileIdentity(from)
      const parent = await directoryIdentity(dirname(from))
      const next = [...moves, { from, to, identity, parent }]
      // Save the intent before changing either path so an interrupted move is recoverable.
      await this.save(next)
      moves = next
      return moveWithoutReplacing(from, to)
    }
  }

  async undo() {
    const moves = await this.read()
    let remaining = moves
    let restored = 0
    let cleared = 0
    const warnings: string[] = []
    for (const entry of [...moves].reverse()) {
      try {
        const { from, to, identity, parent } = entry
        if (await directoryIdentity(dirname(from)) !== parent) {
          throw new Error('Original folder changed.')
        }
        if (!await matches(to, identity)) {
          if (!await matches(from, identity)) throw new Error('Moved file is missing or has changed.')
          cleared++
        } else if (await matches(from, identity)) {
          // The forward or reverse move stopped after linking and before unlinking.
          await unlink(to)
          restored++
        } else {
          if (!await moveWithoutReplacing(to, from)) throw new Error('Original path is occupied.')
          restored++
        }
      } catch (error) {
        warnings.push(`${entry.to}: ${error instanceof Error ? error.message : String(error)}`)
        continue
      }
      const next = remaining.filter((move) => move !== entry)
      await this.save(next)
      remaining = next
    }
    return { restored, cleared, remaining: remaining.length, warnings }
  }
}
