export interface JobOptions {
  targetFolder: string
  sourceFolder: string
  dryRun: boolean
  addDatePrefix: boolean
  convertBuddhistEra: boolean
  moveLivePhotoVideos: boolean
  copyMetadata: boolean
  syncFinderDates: boolean
  recursiveSource: boolean
}

export interface PreviewRow {
  id: string
  current: string
  proposed: string
  dateSource?: string
  actions: string[]
  notes: string[]
}

export interface JobPreview {
  id: string
  rows: PreviewRow[]
}

export type JobEvent =
  | { type: 'status'; message: string }
  | { type: 'progress'; current: number; total: number; label: string }
  | { type: 'summary'; text: string }
  | { type: 'error'; message: string }
  | { type: 'done' }

export interface PhotosApi {
  chooseFolder: (kind: 'target' | 'source') => Promise<string | null>
  preview: (options: JobOptions) => Promise<JobPreview | null>
  run: (previewId: string, selected: string[]) => Promise<void>
  undoCount: () => Promise<number>
  undo: () => Promise<UndoResult>
  onJobEvent: (listener: (event: JobEvent) => void) => () => void
}


export interface UndoResult {
  restored: number
  cleared: number
  remaining: number
  warnings: string[]
}
