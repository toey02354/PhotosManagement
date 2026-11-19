import { app, BrowserWindow, dialog, ipcMain } from 'electron'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { stat } from 'node:fs/promises'
import { processJob } from '../core/job'
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

app.whenReady().then(() => {
  ipcMain.handle('folder:choose', async (_event, kind: 'target' | 'source') => {
    const result = await dialog.showOpenDialog({
      title: kind === 'target' ? 'Choose Target Folder' : 'Choose Metadata Source Folder',
      properties: ['openDirectory'],
    })
    return result.canceled ? null : result.filePaths[0] ?? null
  })

  let jobRunning = false
  const startJob = async (event: Electron.IpcMainInvokeEvent, options: JobOptions, dryRun: boolean) => {
    if (jobRunning) throw new Error('Another Photos Management job is already running.')
    jobRunning = true
    const emit = (jobEvent: JobEvent) => {
      if (!event.sender.isDestroyed()) event.sender.send('job:event', jobEvent)
    }
    try {
      if (!(await stat(options.targetFolder)).isDirectory()) throw new Error('Please choose a valid Target Folder.')
      if ((options.copyMetadata || options.syncFinderDates) && !(await stat(options.sourceFolder)).isDirectory()) {
        throw new Error('Please choose a valid Metadata Source Folder.')
      }
      await processJob({ ...options, dryRun }, emit)
    } catch (error) {
      emit({ type: 'error', message: error instanceof Error ? error.message : String(error) })
    } finally {
      jobRunning = false
    }
  }
  ipcMain.handle('job:preview', (event, options: JobOptions) => startJob(event, options, true))
  ipcMain.handle('job:run', (event, options: JobOptions) => startJob(event, options, false))

  createWindow()
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})
