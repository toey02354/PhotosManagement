import type { JobEvent, JobOptions } from '../shared/job'

export async function processJob(
  options: JobOptions,
  emit: (event: JobEvent) => void,
): Promise<void> {
  // Migration target: rename_createddate_livephoto_gui_v9.py::process_job.
  // Keeping this boundary UI-independent lets preview and execution share a plan.
  emit({ type: 'status', message: 'The TypeScript processing engine is ready to be migrated.' })
  emit({
    type: 'summary',
    text: [
      options.dryRun ? 'PREVIEW' : 'RUN',
      `Target: ${options.targetFolder}`,
      `Metadata source: ${options.sourceFolder || '(disabled)'}`,
      '',
      'Project initialization is complete. File operations are intentionally disabled until the v9 engine is ported and covered by tests.',
    ].join('\n'),
  })
  emit({ type: 'done' })
}
