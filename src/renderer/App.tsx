import { useEffect, useMemo, useState } from 'react'
import type { JobEvent, JobOptions } from '../shared/job'

const initialOptions: JobOptions = {
  targetFolder: '', sourceFolder: '', dryRun: true,
  addDatePrefix: true, convertBuddhistEra: true, moveLivePhotoVideos: true,
  copyMetadata: true, syncFinderDates: true, recursiveSource: true,
}

export default function App() {
  const [options, setOptions] = useState(initialOptions)
  const [summary, setSummary] = useState('Choose folders and options, then Preview or Run for Real.')
  const [busy, setBusy] = useState(false)
  const [status, setStatus] = useState('Ready')
  const [progress, setProgress] = useState(0)
  const needsSource = options.copyMetadata || options.syncFinderDates
  const canStart = Boolean(options.targetFolder && (!needsSource || options.sourceFolder)) && !busy

  useEffect(() => window.photos.onJobEvent((event: JobEvent) => {
    if (event.type === 'status') setStatus(event.message)
    if (event.type === 'progress') {
      setProgress(event.total > 0 ? Math.min(100, event.current / event.total * 100) : 0)
      setStatus(`${event.label} — ${event.current}/${event.total}`)
    }
    if (event.type === 'summary') setSummary(event.text)
    if (event.type === 'error') { setSummary(event.message); setStatus('Error'); setBusy(false) }
    if (event.type === 'done') { setStatus('Done'); setProgress(100); setBusy(false) }
  }), [])

  const actions = useMemo(() => [
    ['addDatePrefix', 'Add / refresh YYYYMMDD- from capture / Created Date'],
    ['convertBuddhistEra', 'Convert Buddhist Era YYYYMMDD- to C.E.'],
    ['moveLivePhotoVideos', 'Move only Live Photo videos to LivePhotos/'],
    ['copyMetadata', 'Copy EXIF/XMP/IPTC, GPS/location, and dates'],
    ['syncFinderDates', 'Sync Finder Created and Modified dates'],
    ['recursiveSource', 'Search Metadata Source subfolders'],
  ] as const, [])

  const choose = async (kind: 'target' | 'source') => {
    const folder = await window.photos.chooseFolder(kind)
    if (folder) setOptions((value) => ({ ...value, [kind === 'target' ? 'targetFolder' : 'sourceFolder']: folder }))
  }

  const start = async (dryRun: boolean) => {
    if (!dryRun) {
      const writes = [
        options.addDatePrefix && 'rename with date prefixes',
        options.convertBuddhistEra && 'convert B.E. prefixes',
        options.moveLivePhotoVideos && 'move Live Photo videos',
        options.copyMetadata && 'copy embedded metadata',
        options.syncFinderDates && 'change Finder dates',
      ].filter(Boolean).join(', ')
      if (!window.confirm(`This is NOT a preview.\n\nTarget: ${options.targetFolder}\nSource: ${needsSource ? options.sourceFolder : 'disabled'}\n\nEnabled writes: ${writes || 'none'}\n\nContinue?`)) return
    }
    setBusy(true); setProgress(0); setStatus(dryRun ? 'Preparing preview…' : 'Starting…')
    const job = { ...options, dryRun }
    try { await (dryRun ? window.photos.preview(job) : window.photos.run(job)) }
    catch (error) { setSummary(String(error)); setStatus('Error'); setBusy(false) }
  }

  return <main>
    <header><p className="eyebrow">PHOTO WORKFLOW</p><h1>Photos Management</h1><p>Rename photos, organize Live Photo videos, and restore metadata from originals.</p></header>
    <section><h2>1. Target folder</h2><p>Files to rename, move, or update</p><div className="folder"><input value={options.targetFolder} readOnly placeholder="Choose a folder…"/><button onClick={() => choose('target')}>Choose…</button></div></section>
    <section><h2>2. Rename & organize</h2><div className="checks">{actions.slice(0, 3).map(([key, label]) => <label key={key}><input type="checkbox" checked={options[key]} onChange={(e) => setOptions({ ...options, [key]: e.target.checked })}/>{label}</label>)}</div></section>
    <section><h2>3. Restore metadata <span>optional</span></h2><div className="checks">{actions.slice(3).map(([key, label]) => <label key={key} className={key === 'recursiveSource' && !needsSource ? 'disabled' : ''}><input type="checkbox" checked={options[key]} disabled={key === 'recursiveSource' && !needsSource} onChange={(e) => setOptions({ ...options, [key]: e.target.checked })}/>{label}</label>)}</div>{needsSource && <div className="folder"><input value={options.sourceFolder} readOnly placeholder="Choose the folder containing originals…"/><button onClick={() => choose('source')}>Choose…</button><button className="quiet" onClick={() => setOptions({ ...options, sourceFolder: options.targetFolder })}>Use target</button></div>}</section>
    <div className="run"><button className="preview" disabled={!canStart} onClick={() => start(true)}>Preview changes</button><button className="primary" disabled={!canStart} onClick={() => start(false)}>Run for real</button></div>
    <div className="progress-row"><span>{status}</span><progress value={progress} max="100" /></div>
    <section className="summary"><h2>Summary</h2><pre>{summary}</pre></section>
  </main>
}
