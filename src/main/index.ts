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

app.whenReady().then(() => {
  ipcMain.handle('folder:choose', async (_event, kind: 'target' | 'source') => {
    const result = await dialog.showOpenDialog({
      title: kind === 'target' ? 'Choose Target Folder' : 'Choose Metadata Source Folder',
      properties: ['openDirectory'],
    })
    return result.canceled ? null : result.filePaths[0] ?? null
  })

  const startJob = async (event: Electron.IpcMainInvokeEvent, options: JobOptions) => {
    const emit = (jobEvent: JobEvent) => event.sender.send('job:event', jobEvent)
    try {
      if (!(await stat(options.targetFolder)).isDirectory()) throw new Error('Please choose a valid Target Folder.')
      if ((options.copyMetadata || options.syncFinderDates) && !(await stat(options.sourceFolder)).isDirectory()) {
        throw new Error('Please choose a valid Metadata Source Folder.')
      }
      await processJob(options, emit)
    } catch (error) {
      emit({ type: 'error', message: error instanceof Error ? error.message : String(error) })
    }
  }
  ipcMain.handle('job:preview', startJob)
  ipcMain.handle('job:run', startJob)

  createWindow()
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})
