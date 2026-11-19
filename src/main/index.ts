import { app, BrowserWindow, dialog, ipcMain, nativeImage } from 'electron'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { mkdir, stat } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import { applyPreview, planJob, type PlannedFile } from '../core/job'
import { UndoHistory } from '../core/undo'
import dockLogo from '../renderer/assets/logo.png?inline'
import type { JobEvent, JobOptions } from '../shared/job'

const currentDir = dirname(fileURLToPath(import.meta.url))

function createWindow(): void {
  const window = new BrowserWindow({
    width: 1040,
    height: 820,
    minWidth: 820,
    minHeight: 680,
    title: 'Photos Management',
    webPreferences: {
      preload: join(currentDir, 'index.mjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  })

  if (process.env.VITE_DEV_SERVER_URL) {
    void window.loadURL(process.env.VITE_DEV_SERVER_URL)
  } else {
    void window.loadFile(join(currentDir, '../dist/index.html'))
  }
}

if (!app.requestSingleInstanceLock()) app.quit()

app.whenReady().then(async () => {
  if (process.platform === 'darwin') app.dock?.setIcon(nativeImage.createFromDataURL(dockLogo))
  const userData = app.getPath('userData')
  await mkdir(userData, { recursive: true })
  const history = new UndoHistory(join(userData, 'last-file-run.json'))
  ipcMain.handle('folder:choose', async (_event, kind: 'target' | 'source') => {
    const result = await dialog.showOpenDialog({
      title: kind === 'target' ? 'Choose Target Folder' : 'Choose Metadata Source Folder',
      properties: ['openDirectory'],
    })
    return result.canceled ? null : result.filePaths[0] ?? null
  })

  let jobRunning = false
  let preview: { id: string; sender: number; files: PlannedFile[] } | null = null
  const withJob = async <T>(event: Electron.IpcMainInvokeEvent, work: (emit: (jobEvent: JobEvent) => void) => Promise<T>) => {
    if (jobRunning) throw new Error('Another Photos Management job is already running.')
    jobRunning = true
    const emit = (jobEvent: JobEvent) => {
      if (!event.sender.isDestroyed()) event.sender.send('job:event', jobEvent)
    }
    try {
      return await work(emit)
    } finally {
      jobRunning = false
    }
  }
  ipcMain.handle('job:preview', (event, options: JobOptions) => withJob(event, async (emit) => {
    preview = null
    if (!(await stat(options.targetFolder)).isDirectory()) throw new Error('Please choose a valid Target Folder.')
    if ((options.copyMetadata || options.syncFinderDates) && !(await stat(options.sourceFolder)).isDirectory()) {
      throw new Error('Please choose a valid Metadata Source Folder.')
    }
    const files = await planJob(options, emit)
    const id = randomUUID()
    preview = { id, sender: event.sender.id, files }
    return { id, rows: files.map(({ row }) => row) }
  }))
  ipcMain.handle('job:run', (event, id: string, selected: string[]) => withJob(event, async (emit) => {
    if (!preview || preview.id !== id || preview.sender !== event.sender.id) {
      throw new Error('Create a new preview before running.')
    }
    const { files } = preview
    preview = null
    await applyPreview(files, selected, emit, history.startRun())
  }))
  ipcMain.handle('job:undo-count', () => history.count())
  ipcMain.handle('job:undo', (event) => withJob(event, () => {
    preview = null
    return history.undo()
  }))

  createWindow()
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})
