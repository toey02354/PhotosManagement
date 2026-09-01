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

export type JobEvent =
  | { type: 'status'; message: string }
  | { type: 'progress'; current: number; total: number; label: string }
  | { type: 'summary'; text: string }
  | { type: 'error'; message: string }
  | { type: 'done' }

export interface PhotosApi {
  chooseFolder: (kind: 'target' | 'source') => Promise<string | null>
  preview: (options: JobOptions) => Promise<void>
  run: (options: JobOptions) => Promise<void>
  onJobEvent: (listener: (event: JobEvent) => void) => () => void
}
