import { useEffect, useMemo, useState } from 'react'
import logo from './assets/logo.png'
import type { JobEvent, JobOptions, JobPreview } from '../shared/job'

const initialOptions: JobOptions = {
  targetFolder: '', sourceFolder: '', dryRun: true,
  addDatePrefix: false, convertBuddhistEra: false, moveLivePhotoVideos: false,
  copyMetadata: false, syncFinderDates: false, recursiveSource: false,
}

export default function App() {
  const [options, setOptions] = useState(initialOptions)
  const [summary, setSummary] = useState('Choose folders and options, then preview the changes.')
  const [busy, setBusy] = useState(false)
  const [undoCount, setUndoCount] = useState(0)
  const [status, setStatus] = useState('Ready')
  const [progress, setProgress] = useState(0)
  const [preview, setPreview] = useState<{ result: JobPreview; options: JobOptions } | null>(null)
  const [selected, setSelected] = useState(new Set<string>())
  const rows = preview?.options === options ? preview.result.rows : null
  const needsSource = options.copyMetadata || options.syncFinderDates
  const canStart = Boolean(options.targetFolder && (!needsSource || options.sourceFolder)) && !busy

  useEffect(() => window.photos.onJobEvent((event: JobEvent) => {
    if (event.type === 'status') setStatus(event.message)
    if (event.type === 'progress') {
      setProgress(event.total > 0 ? Math.min(100, event.current / event.total * 100) : 0)
      setStatus(`${event.label} — ${event.current}/${event.total}`)
    }
    if (event.type === 'summary') setSummary(event.text)
    if (event.type === 'error') { setSummary(event.message); setStatus('Error') }
    if (event.type === 'done') { setStatus('Done'); setProgress(100) }
  }), [])

  useEffect(() => {
    void window.photos.undoCount().then(setUndoCount).catch((error: unknown) => setSummary(String(error)))
  }, [])

  const refreshUndo = async () => {
    try { setUndoCount(await window.photos.undoCount()) }
    catch (error) { setSummary(String(error)); setStatus('Error') }
  }

  const undo = async () => {
    if (!window.confirm('Undo the last run’s file renames and moves? Metadata and Finder date edits will stay as applied.')) return
    setBusy(true)
    setPreview(null)
    setProgress(0)
    setStatus('Undoing file changes…')
    try {
      const result = await window.photos.undo()
      setUndoCount(result.remaining)
      setSummary([
        `Reversed ${result.restored} file operations. ${result.cleared} were already at their original paths.`,
        ...result.warnings,
      ].join('\n'))
      setStatus(result.remaining ? 'Undo incomplete' : 'Undo complete')
      setProgress(100)
    } catch (error) {
      setSummary(String(error))
      setStatus('Error')
      await refreshUndo()
    } finally {
      setBusy(false)
    }
  }

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
    if (!dryRun && (!rows || !preview || !selected.size ||
        !window.confirm(`Apply the reviewed changes to ${selected.size} selected files?

Target: ${options.targetFolder}`))) return
    setBusy(true)
    setPreview(null)
    setProgress(0)
    setStatus(dryRun ? 'Preparing preview…' : 'Applying changes…')
    try {
      if (dryRun) {
        const result = await window.photos.preview(options)
        if (result) {
          setPreview({ result, options })
          setSelected(new Set(result.rows.filter((row) => row.actions.length).map((row) => row.id)))
        }
      } else if (preview) {
        await window.photos.run(preview.result.id, [...selected])
      }
    } catch (error) {
      setSummary(String(error))
      setStatus('Error')
    } finally {
      if (!dryRun) await refreshUndo()
      setBusy(false)
    }
  }

  return <main>
    <header className="app-header">
      <img src={logo} width="68" height="68" alt="" />
      <div>
        <h1>Photos Management</h1>
        <p>Rename photos, organize Live Photo videos, and restore metadata from originals.</p>
      </div>
    </header>
    <div inert={busy}>
    <section><h2>1. Target folder</h2><p>Files to rename, move, or update</p><div className="folder"><input value={options.targetFolder} readOnly placeholder="Choose a folder…"/><button onClick={() => choose('target')}>Choose…</button></div></section>
    <section><h2>2. Rename & organize</h2><div className="checks">{actions.slice(0, 3).map(([key, label]) => <label key={key}><input type="checkbox" checked={options[key]} onChange={(e) => setOptions({ ...options, [key]: e.target.checked })}/>{label}</label>)}</div></section>
    <section><h2>3. Restore metadata <span>optional</span></h2><div className="checks">{actions.slice(3).map(([key, label]) => <label key={key} className={key === 'recursiveSource' && !needsSource ? 'disabled' : ''}><input type="checkbox" checked={options[key]} disabled={key === 'recursiveSource' && !needsSource} onChange={(e) => setOptions({ ...options, [key]: e.target.checked })}/>{label}</label>)}</div>{needsSource && <div className="folder"><input value={options.sourceFolder} readOnly placeholder="Choose the folder containing originals…"/><button onClick={() => choose('source')}>Choose…</button><button className="quiet" onClick={() => setOptions({ ...options, sourceFolder: options.targetFolder })}>Use target</button></div>}</section>
    </div>
    <div className="run"><button className="quiet" disabled={busy || !undoCount} onClick={() => void undo()}>Undo last run</button><button className="preview" disabled={!canStart} onClick={() => start(true)}>Preview changes</button><button className="primary" disabled={!canStart || !rows || !selected.size} onClick={() => start(false)}>Run selected</button></div>
    <div className="progress-row"><span>{status}</span><progress value={progress} max="100" /></div>
    {rows && <section>
      <h2>File preview</h2>
      <p>{selected.size} selected · {rows.length} scanned</p>
      <div className="preview-table">
        <table>
          <thead><tr><th scope="col">Apply</th><th scope="col">Current name</th><th scope="col">Proposed path</th><th scope="col">Date source</th><th scope="col">Actions and notes</th></tr></thead>
          <tbody>{rows.map((row) => <tr key={row.id}>
            <td><input type="checkbox" aria-label={`Apply changes to ${row.current}`} disabled={busy || !row.actions.length}
              checked={selected.has(row.id)} onChange={(event) => {
                const checked = event.target.checked
                setSelected((previous) => {
                  const next = new Set(previous)
                  if (checked) next.add(row.id)
                  else next.delete(row.id)
                  return next
                })
              }}/></td>
            <td>{row.current}</td><td>{row.proposed}</td><td>{row.dateSource ?? '—'}</td>
            <td>{[...row.actions, ...row.notes].join(' · ')}</td>
          </tr>)}</tbody>
        </table>
      </div>
    </section>}
    <section className="summary"><h2>Summary</h2><pre>{summary}</pre></section>
  </main>
}
