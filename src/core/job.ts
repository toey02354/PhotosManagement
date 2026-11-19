import { lstat, mkdir } from 'node:fs/promises'
import { basename, join } from 'node:path'
import type { JobEvent, JobOptions } from '../shared/job'
import { convertBuddhistEraDatePrefix, normalizeFilename, stripDatePrefix } from './filename'
import { buildSourceIndex, IMAGE_EXTENSIONS, matchTargetsToSources, moveWithoutReplacing, pathExists, scanFolder, VIDEO_EXTENSIONS, type FileRecord } from './files'
import { copyEmbeddedMetadata, datePrefix, findExiftool, findSetFile, getBestCreatedDate, livePhotoIdentifier, setFilesystemDates } from './metadata'

type Detail = { target: string; source?: string; error?: string; warning?: string }
const yn = (value: boolean) => value ? 'YES' : 'NO'
const counter = (text: string, value: number) => `${text.padEnd(29)}: ${value}`

export async function processJob(options: JobOptions, emit: (event: JobEvent) => void): Promise<void> {
  const { targetFolder, sourceFolder, dryRun } = options
  const sourceMatch = options.copyMetadata || options.syncFinderDates
  const renameEnabled = options.addDatePrefix || options.convertBuddhistEra
  const liveFolder = join(targetFolder, 'LivePhotos')
  const [exiftool, setFile] = await Promise.all([findExiftool(), findSetFile()])

  emit({ type: 'status', message: 'Scanning target folder…' })
  const targets = await scanFolder(targetFolder)
  let sources: FileRecord[] = [], ambiguous: ReturnType<typeof buildSourceIndex>['ambiguous'] = []
  let matches = new Map<string, string>()
  if (sourceMatch) {
    emit({ type: 'status', message: 'Scanning metadata source folder…' })
    sources = await scanFolder(sourceFolder, options.recursiveSource)
    const index = buildSourceIndex(sources); ambiguous = index.ambiguous
    matches = await matchTargetsToSources(targets, index.sourceByKey)
  }

  const sourceDates = new Map<string, Date | null>()
  let current = 0
  for (const [target, source] of matches) {
    sourceDates.set(target, await getBestCreatedDate(source, exiftool))
    emit({ type: 'progress', current: ++current, total: Math.max(matches.size, 1), label: 'Reading source metadata' })
  }
  const groups = new Map<string, FileRecord[]>()
  for (const file of targets) groups.set(normalizeFilename(file.filename), [...(groups.get(normalizeFilename(file.filename)) ?? []), file])
  const stats = {
    targetFiles: targets.length, sourceFiles: sources.length, groups: groups.size, matchedTargets: matches.size,
    ambiguousSources: ambiguous.length, sourceDateUsed: 0, needsRename: 0, renameActions: 0,
    beDetected: 0, beActions: 0, alreadyOk: 0, metadataActions: 0, metadataFailures: 0,
    fsDateActions: 0, fsDateWarnings: 0, liveGroups: 0, liveVideoActions: 0, liveVideoSkipped: 0,
    conflictGroups: 0, missingDate: 0, nameCollisionSkips: 0,
  }
  const missingDates: string[] = [], metadataErrors: Detail[] = [], fsWarnings: Detail[] = [], liveSkips: string[] = []
  const conflicts: { group: string; files: string[] }[] = [], collisions: { source: string; destination: string }[] = []

  current = 0
  for (const [target, source] of matches) {
    const sourceDate = sourceDates.get(target)
    if (options.copyMetadata) {
      if (!exiftool) { stats.metadataFailures++; metadataErrors.push({ target, source, error: 'ExifTool not found' }) }
      else if (dryRun) stats.metadataActions++
      else { const error = await copyEmbeddedMetadata(source, target, exiftool); if (error) { stats.metadataFailures++; metadataErrors.push({ target, source, error }) } else stats.metadataActions++ }
    }
    if (options.syncFinderDates) {
      if (!sourceDate) { stats.fsDateWarnings++; fsWarnings.push({ target, warning: 'matched source has no readable capture/created date' }) }
      else if (dryRun) stats.fsDateActions++
      else { const warning = await setFilesystemDates(target, sourceDate, setFile); if (warning) { stats.fsDateWarnings++; fsWarnings.push({ target, warning }) } else stats.fsDateActions++ }
    }
    emit({ type: 'progress', current: ++current, total: Math.max(matches.size, 1), label: 'Copying/syncing metadata' })
  }

  const previewDestinations = new Set<string>()
  const previewVacated = new Set<string>()
  const pathKey = (path: string) => path.normalize('NFC').toLowerCase()
  const move = async (source: string, destination: string) => {
    if (!dryRun) return !await pathExists(destination) && await moveWithoutReplacing(source, destination)
    const key = pathKey(destination)
    if (previewDestinations.has(key) || (!previewVacated.has(key) && await pathExists(destination))) return false
    const sourceKey = pathKey(source)
    previewDestinations.delete(sourceKey)
    previewVacated.add(sourceKey)
    previewDestinations.add(key)
    return true
  }

  let groupNumber = 0
  for (const [normalized, files] of groups) {
    const sizes = new Set(files.map((file) => file.size)), extensions = new Set(files.map((file) => file.extension))
    const mixedMedia = [...extensions].some((ext) => IMAGE_EXTENSIONS.has(ext)) && [...extensions].some((ext) => VIDEO_EXTENSIONS.has(ext))
    const pairedVideos = new Set<string>()
    if (mixedMedia && options.moveLivePhotoVideos) {
      const identifiers = new Set<string>()
      for (const file of files.filter((item) => IMAGE_EXTENSIONS.has(item.extension))) {
        const identifier = await livePhotoIdentifier(file.path, exiftool)
        if (identifier) identifiers.add(identifier)
      }
      for (const file of files.filter((item) => item.extension === '.mov')) {
        const identifier = await livePhotoIdentifier(file.path, exiftool)
        if (identifier && identifiers.has(identifier)) pairedVideos.add(file.path)
      }
    }
    if (sizes.size > 1 && !mixedMedia) {
      stats.conflictGroups++; conflicts.push({ group: normalized, files: files.map((file) => file.filename) })
      emit({ type: 'progress', current: ++groupNumber, total: Math.max(groups.size, 1), label: 'Processing files' }); continue
    }
    if (pairedVideos.size) stats.liveGroups++
    const processed: { name: string; path: string; pairedVideo: boolean }[] = []
    for (const file of files) {
      let working = file.filename, beDetected = false
      if (options.convertBuddhistEra) { const result = convertBuddhistEraDatePrefix(file.filename); working = result.name; beDetected = result.detected; if (beDetected) stats.beDetected++ }
      let nextName = working
      if (options.addDatePrefix) {
        const sourceDate = sourceMatch ? sourceDates.get(file.path) : null
        const created = sourceDate || await getBestCreatedDate(file.path, exiftool)
        if (sourceDate) stats.sourceDateUsed++
        if (!created) { stats.missingDate++; missingDates.push(file.filename) }
        nextName = `${created ? datePrefix(created) : 'UNSORTED'}-${stripDatePrefix(working)}`
      }
      const needsRename = nextName !== file.filename
      if (needsRename) stats.needsRename++; else stats.alreadyOk++
      if (beDetected && needsRename && renameEnabled) stats.beActions++
      let name = needsRename && renameEnabled ? nextName : file.filename
      let path = join(targetFolder, name)
      if (needsRename && renameEnabled) {
        if (!await move(file.path, path)) { stats.nameCollisionSkips++; collisions.push({ source: file.path, destination: path }); name = file.filename; path = file.path }
        else stats.renameActions++
      } else { name = file.filename; path = file.path }
      processed.push({ name, path, pairedVideo: pairedVideos.has(file.path) })
    }
    for (const file of processed.filter((item) => item.pairedVideo)) {
      const destination = join(liveFolder, file.name)
      if (!dryRun) {
        await mkdir(liveFolder, { recursive: true })
        if (!(await lstat(liveFolder)).isDirectory()) throw new Error('LivePhotos must be a regular directory.')
      }
      if (!await move(file.path, destination)) {
        stats.liveVideoSkipped++
        liveSkips.push(destination)
      } else stats.liveVideoActions++
    }
    emit({ type: 'progress', current: ++groupNumber, total: Math.max(groups.size, 1), label: 'Processing files' })
  }

  const lines = [
    '================ PLAN / RESULT SUMMARY ================',
    `Mode                         : ${dryRun ? 'DRY RUN / PREVIEW' : 'COMPLETED'}`,
    `Target folder                : ${targetFolder}`, `Metadata source folder       : ${sourceMatch ? sourceFolder : '(disabled)'}`,
    `ExifTool                     : ${exiftool ?? 'NOT FOUND'}`, `SetFile                      : ${setFile ?? 'NOT FOUND'}`,
    '-------------------------------------------------------', `Date prefix                  : ${yn(options.addDatePrefix)}`,
    `B.E. -> C.E.                 : ${yn(options.convertBuddhistEra)}`, `Move LivePhoto videos        : ${yn(options.moveLivePhotoVideos)}`,
    `Original metadata matching   : ${sourceMatch ? 'AUTO' : 'OFF'}`, `Copy matched metadata        : ${yn(options.copyMetadata)}`,
    `Sync Finder dates            : ${yn(options.syncFinderDates)}`, `Recursive source search      : ${yn(options.recursiveSource)}`,
    '-------------------------------------------------------', counter('Target files scanned', stats.targetFiles), counter('Source files scanned', stats.sourceFiles),
    counter('Groups processed', stats.groups), counter('Filename source matches', stats.matchedTargets), counter('Ambiguous source keys', stats.ambiguousSources),
    counter('Source date used for naming', stats.sourceDateUsed), counter(dryRun ? 'Would copy source metadata' : 'Copied source metadata', stats.metadataActions),
    counter('Metadata copy failures', stats.metadataFailures), counter(dryRun ? 'Would sync Finder dates' : 'Synced Finder dates', stats.fsDateActions),
    counter('Finder date warnings', stats.fsDateWarnings), counter('Needs rename', stats.needsRename), counter('B.E. prefixes detected', stats.beDetected),
    counter(dryRun ? 'Would convert B.E. prefixes' : 'Converted B.E. prefixes', stats.beActions), counter(dryRun ? 'Would rename' : 'Renamed', stats.renameActions),
    counter('Already correctly named', stats.alreadyOk), counter('Rename collisions skipped', stats.nameCollisionSkips), counter('Live Photo groups', stats.liveGroups),
    counter(dryRun ? 'Would move LivePhoto videos' : 'Moved LivePhoto videos', stats.liveVideoActions), counter('Skipped LivePhoto videos', stats.liveVideoSkipped),
    counter('Conflict groups', stats.conflictGroups),
    counter('Missing capture/Created Date', stats.missingDate), '=======================================================',
  ]
  if (dryRun) lines.push('', 'PREVIEW ONLY — no files were changed.')
  if (ambiguous.length) { lines.push('', 'AMBIGUOUS IMG_#### SOURCES — SKIPPED'); for (const item of ambiguous) lines.push(`  ${item.key}`, ...item.sources.map((path) => `    - ${path}`)) }
  if (metadataErrors.length) { lines.push('', 'METADATA COPY ERRORS'); for (const item of metadataErrors) lines.push(`  - ${basename(item.target)} <- ${basename(item.source!)}: ${item.error}`) }
  if (fsWarnings.length) { lines.push('', 'FINDER DATE WARNINGS'); for (const item of fsWarnings) lines.push(`  - ${basename(item.target)}: ${item.warning}`) }
  if (missingDates.length) lines.push('', 'MISSING CAPTURE / CREATED DATE', ...missingDates.map((name) => `  - ${name}`))
  if (collisions.length) { lines.push('', 'RENAME COLLISIONS — SKIPPED'); for (const item of collisions) lines.push(`  - ${basename(item.source)} -> ${basename(item.destination)}`) }
  if (liveSkips.length) lines.push('', 'LIVE PHOTO VIDEO DESTINATIONS ALREADY EXIST', ...liveSkips.map((path) => `  - ${path}`))
  if (conflicts.length) lines.push('', 'CONFLICT GROUPS — FILES LEFT IN PLACE', ...conflicts.map((item) => `  - ${item.group}: ${item.files.join(', ')}`))
  emit({ type: 'summary', text: lines.join('\n') }); emit({ type: 'progress', current: 1, total: 1, label: 'Done' }); emit({ type: 'done' })
}
