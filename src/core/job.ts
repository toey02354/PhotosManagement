import { lstat, mkdir } from 'node:fs/promises'
import { basename, dirname, join, relative } from 'node:path'
import type { JobEvent, JobOptions, PreviewRow } from '../shared/job'
import { convertBuddhistEraDatePrefix, normalizeFilename, stripDatePrefix } from './filename'
import { buildSourceIndex, fileIdentity, sameFile, type FileIdentity, IMAGE_EXTENSIONS, matchTargetsToSources, moveWithoutReplacing, pathExists, scanFolder, VIDEO_EXTENSIONS, type FileRecord } from './files'
import { copyEmbeddedMetadata, datePrefix, findExiftool, findSetFile, getBestCreatedDate, livePhotoIdentifier, setFilesystemDates } from './metadata'

type Operation =
  | { type: 'copy'; source: string; identity: FileIdentity }
  | { type: 'dates'; date: Date; source: string; identity: FileIdentity }
  | { type: 'move'; destination: string }

export interface PlannedFile {
  row: PreviewRow
  path: string
  identity: FileIdentity
  operations: { order: number; operation: Operation }[]
}

type Detail = { target: string; source?: string; error?: string; warning?: string }
const yn = (value: boolean) => value ? 'YES' : 'NO'
const counter = (text: string, value: number) => `${text.padEnd(29)}: ${value}`

export async function planJob(options: JobOptions, emit: (event: JobEvent) => void): Promise<PlannedFile[]> {
  const { targetFolder, sourceFolder } = options
  const sourceMatch = options.copyMetadata || options.syncFinderDates
  const renameEnabled = options.addDatePrefix || options.convertBuddhistEra
  const liveFolder = join(targetFolder, 'LivePhotos')
  const [exiftool, setFile] = await Promise.all([findExiftool(), findSetFile()])

  emit({ type: 'status', message: 'Scanning target folder…' })
  const targets = await scanFolder(targetFolder)
  const plan = new Map<string, PlannedFile>()
  for (const file of targets) {
    plan.set(file.path, {
      row: { id: file.path, current: file.filename, proposed: file.filename, actions: [], notes: [] },
      path: file.path,
      identity: await fileIdentity(file.path),
      operations: [],
    })
  }
  const note = (path: string, message: string) => plan.get(path)?.row.notes.push(message)
  let order = 0
  const action = (path: string, label: string, operation: Operation) => {
    const entry = plan.get(path)
    if (!entry) return
    entry.row.actions.push(label)
    entry.operations.push({ order: order++, operation })
    if (operation.type === 'move') entry.row.proposed = relative(targetFolder, operation.destination)
  }
  let sources: FileRecord[] = [], ambiguous: ReturnType<typeof buildSourceIndex>['ambiguous'] = []
  let matches = new Map<string, string>()
  if (sourceMatch) {
    emit({ type: 'status', message: 'Scanning metadata source folder…' })
    sources = await scanFolder(sourceFolder, options.recursiveSource)
    const index = buildSourceIndex(sources); ambiguous = index.ambiguous
    matches = await matchTargetsToSources(targets, index.sourceByKey)
  }

  const sourceIdentities = new Map<string, FileIdentity>()
  const sourceDates = new Map<string, Date | null>()
  let current = 0
  for (const [target, source] of matches) {
    if (!sourceIdentities.has(source)) sourceIdentities.set(source, await fileIdentity(source))
    sourceDates.set(target, await getBestCreatedDate(source, exiftool))
    emit({ type: 'progress', current: ++current, total: Math.max(matches.size, 1), label: 'Reading source metadata' })
  }
  if (sourceMatch) for (const file of targets) {
    if (!matches.has(file.path)) note(file.path, 'No unambiguous metadata source')
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
      if (!exiftool) { note(target, 'Metadata skipped: ExifTool unavailable'); stats.metadataFailures++; metadataErrors.push({ target, source, error: 'ExifTool not found' }) }
      else {
        stats.metadataActions++
        action(target, 'Copy embedded metadata', { type: 'copy', source, identity: sourceIdentities.get(source)! })
      }
    }
    if (options.syncFinderDates) {
      if (!sourceDate) { note(target, 'Finder dates skipped: source has no readable date'); stats.fsDateWarnings++; fsWarnings.push({ target, warning: 'matched source has no readable capture/created date' }) }
      else {
        stats.fsDateActions++
        const entry = plan.get(target)
        if (entry) entry.row.dateSource = `Matched original (${basename(source)})`
        action(target, 'Sync Finder dates', { type: 'dates', date: sourceDate, source, identity: sourceIdentities.get(source)! })
        if (!setFile) note(target, 'SetFile unavailable: only Modified date can be synced')
      }
    }
    emit({ type: 'progress', current: ++current, total: Math.max(matches.size, 1), label: 'Planning metadata changes' })
  }

  const previewDestinations = new Set<string>()
  const previewVacated = new Set<string>()
  const pathKey = (path: string) => path.normalize('NFC').toLowerCase()
  const move = async (source: string, destination: string) => {
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
      for (const file of files) note(file.path, 'Rename skipped: conflicting filenames')
      stats.conflictGroups++; conflicts.push({ group: normalized, files: files.map((file) => file.filename) })
      emit({ type: 'progress', current: ++groupNumber, total: Math.max(groups.size, 1), label: 'Processing files' }); continue
    }
    if (pairedVideos.size) stats.liveGroups++
    const processed: { original: string; name: string; path: string; pairedVideo: boolean }[] = []
    for (const file of files) {
      let working = file.filename, beDetected = false
      if (options.convertBuddhistEra) { const result = convertBuddhistEraDatePrefix(file.filename); working = result.name; beDetected = result.detected; if (beDetected) stats.beDetected++ }
      let nextName = working
      if (options.addDatePrefix) {
        const sourceDate = sourceMatch ? sourceDates.get(file.path) : null
        let dateSource = sourceDate ? `Matched original (${basename(matches.get(file.path)!)})` : 'Target file'
        const created = sourceDate || await getBestCreatedDate(file.path, exiftool, (origin) => { dateSource = origin })
        const entry = plan.get(file.path)
        if (entry) entry.row.dateSource = created ? dateSource : 'No readable date'
        if (sourceDate) stats.sourceDateUsed++
        if (!created) { stats.missingDate++; missingDates.push(file.filename) }
        nextName = `${created ? datePrefix(created) : 'UNSORTED'}-${stripDatePrefix(working)}`
      }
      if (beDetected && !options.addDatePrefix) {
        const entry = plan.get(file.path)
        if (entry) entry.row.dateSource = 'Existing Buddhist Era prefix'
      }
      const needsRename = nextName !== file.filename
      if (needsRename) stats.needsRename++; else stats.alreadyOk++
      if (beDetected && needsRename && renameEnabled) stats.beActions++
      let name = needsRename && renameEnabled ? nextName : file.filename
      let path = join(targetFolder, name)
      if (needsRename && renameEnabled) {
        if (!await move(file.path, path)) { note(file.path, `Rename skipped: ${name} already exists`); stats.nameCollisionSkips++; collisions.push({ source: file.path, destination: path }); name = file.filename; path = file.path }
        else { stats.renameActions++; action(file.path, 'Rename', { type: 'move', destination: path }) }
      } else { name = file.filename; path = file.path }
      if (options.moveLivePhotoVideos && file.extension === '.mov' && !pairedVideos.has(file.path)) {
        note(file.path, 'Move skipped: no verified Live Photo pair')
      }
      processed.push({ original: file.path, name, path, pairedVideo: pairedVideos.has(file.path) })
    }
    for (const file of processed.filter((item) => item.pairedVideo)) {
      const destination = join(liveFolder, file.name)
      if (await pathExists(liveFolder) && !(await lstat(liveFolder)).isDirectory()) {
        stats.liveVideoSkipped++
        note(file.original, 'Move skipped: LivePhotos is not a regular directory')
        continue
      }
      if (!await move(file.path, destination)) {
        stats.liveVideoSkipped++
        liveSkips.push(destination)
        note(file.original, `Move skipped: ${relative(targetFolder, destination)} already exists`)
      } else {
        stats.liveVideoActions++
        action(file.original, 'Move to LivePhotos', { type: 'move', destination })
      }
    }
    emit({ type: 'progress', current: ++groupNumber, total: Math.max(groups.size, 1), label: 'Processing files' })
  }

  const lines = [
    '================ PLAN / RESULT SUMMARY ================',
    `Mode                         : DRY RUN / PREVIEW`,
    `Target folder                : ${targetFolder}`, `Metadata source folder       : ${sourceMatch ? sourceFolder : '(disabled)'}`,
    `ExifTool                     : ${exiftool ?? 'NOT FOUND'}`, `SetFile                      : ${setFile ?? 'NOT FOUND'}`,
    '-------------------------------------------------------', `Date prefix                  : ${yn(options.addDatePrefix)}`,
    `B.E. -> C.E.                 : ${yn(options.convertBuddhistEra)}`, `Move LivePhoto videos        : ${yn(options.moveLivePhotoVideos)}`,
    `Original metadata matching   : ${sourceMatch ? 'AUTO' : 'OFF'}`, `Copy matched metadata        : ${yn(options.copyMetadata)}`,
    `Sync Finder dates            : ${yn(options.syncFinderDates)}`, `Recursive source search      : ${yn(options.recursiveSource)}`,
    '-------------------------------------------------------', counter('Target files scanned', stats.targetFiles), counter('Source files scanned', stats.sourceFiles),
    counter('Groups processed', stats.groups), counter('Filename source matches', stats.matchedTargets), counter('Ambiguous source keys', stats.ambiguousSources),
    counter('Source date used for naming', stats.sourceDateUsed), counter('Would copy source metadata', stats.metadataActions),
    counter('Metadata copy failures', stats.metadataFailures), counter('Would sync Finder dates', stats.fsDateActions),
    counter('Finder date warnings', stats.fsDateWarnings), counter('Needs rename', stats.needsRename), counter('B.E. prefixes detected', stats.beDetected),
    counter('Would convert B.E. prefixes', stats.beActions), counter('Would rename', stats.renameActions),
    counter('Already correctly named', stats.alreadyOk), counter('Rename collisions skipped', stats.nameCollisionSkips), counter('Live Photo groups', stats.liveGroups),
    counter('Would move LivePhoto videos', stats.liveVideoActions), counter('Skipped LivePhoto videos', stats.liveVideoSkipped),
    counter('Conflict groups', stats.conflictGroups),
    counter('Missing capture/Created Date', stats.missingDate), '=======================================================',
  ]
  lines.push('', 'PREVIEW ONLY — no files were changed.')
  if (ambiguous.length) { lines.push('', 'AMBIGUOUS IMG_#### SOURCES — SKIPPED'); for (const item of ambiguous) lines.push(`  ${item.key}`, ...item.sources.map((path) => `    - ${path}`)) }
  if (metadataErrors.length) { lines.push('', 'METADATA COPY ERRORS'); for (const item of metadataErrors) lines.push(`  - ${basename(item.target)} <- ${basename(item.source!)}: ${item.error}`) }
  if (fsWarnings.length) { lines.push('', 'FINDER DATE WARNINGS'); for (const item of fsWarnings) lines.push(`  - ${basename(item.target)}: ${item.warning}`) }
  if (missingDates.length) lines.push('', 'MISSING CAPTURE / CREATED DATE', ...missingDates.map((name) => `  - ${name}`))
  if (collisions.length) { lines.push('', 'RENAME COLLISIONS — SKIPPED'); for (const item of collisions) lines.push(`  - ${basename(item.source)} -> ${basename(item.destination)}`) }
  if (liveSkips.length) lines.push('', 'LIVE PHOTO VIDEO DESTINATIONS ALREADY EXIST', ...liveSkips.map((path) => `  - ${path}`))
  if (conflicts.length) lines.push('', 'CONFLICT GROUPS — FILES LEFT IN PLACE', ...conflicts.map((item) => `  - ${item.group}: ${item.files.join(', ')}`))
  for (const { row } of plan.values()) {
    if (!row.actions.length && !row.notes.length) row.notes.push('No changes needed')
  }
  emit({ type: 'summary', text: lines.join('\n') }); emit({ type: 'progress', current: 1, total: 1, label: 'Done' }); emit({ type: 'done' })
  return [...plan.values()]
}

export async function applyPreview(files: PlannedFile[], selected: string[], emit: (event: JobEvent) => void,
  move = moveWithoutReplacing,
) {
  const selection = new Set(selected)
  const rows = files.filter(({ row, operations }) => selection.has(row.id) && operations.length)
  const [exiftool, setFile] = await Promise.all([findExiftool(), findSetFile()])
  const results: string[] = []
  const states = rows.map((file) => ({ file, current: file.path, started: false, failed: false }))
  const operations = states.flatMap((state) => state.file.operations.map((entry) => ({ ...entry, state })))
    .sort((a, b) => a.order - b.order)
  let actions = 0
  for (const [index, { operation, state }] of operations.entries()) {
    const { file } = state
    if (!state.failed) try {
      if (!state.started && !sameFile(file.identity, await fileIdentity(state.current))) {
        throw new Error('File changed since preview.')
      }
      state.started = true
      if (operation.type === 'move') {
        const folder = dirname(operation.destination)
        await mkdir(folder, { recursive: true })
        if (!(await lstat(folder)).isDirectory()) throw new Error('Destination must be a regular directory.')
        if (!await move(state.current, operation.destination)) {
          throw new Error(`Destination already exists: ${operation.destination}`)
        }
        state.current = operation.destination
        actions++
      } else {
        if (!sameFile(operation.identity, await fileIdentity(operation.source))) {
          throw new Error('Metadata source changed since preview.')
        }
        const warning = operation.type === 'copy'
          ? exiftool ? await copyEmbeddedMetadata(operation.source, state.current, exiftool) : 'ExifTool unavailable'
          : await setFilesystemDates(state.current, operation.date, setFile)
        if (warning) results.push(`${file.row.current}: ${warning}`)
        else actions++
      }
    } catch (error) {
      state.failed = true
      results.push(`${file.row.current}: ${error instanceof Error ? error.message : String(error)}`)
    }
    emit({ type: 'progress', current: index + 1, total: operations.length, label: 'Applying preview' })
  }
  emit({ type: 'summary', text: [`Completed ${actions} of ${operations.length} actions across ${rows.length} selected files.`, ...results].join('\n') })
  emit({ type: 'done' })
}
