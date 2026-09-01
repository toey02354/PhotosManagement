import { contextBridge, ipcRenderer } from 'electron'
import type { JobEvent, JobOptions, PhotosApi } from '../shared/job'

const api: PhotosApi = {
  chooseFolder: (kind) => ipcRenderer.invoke('folder:choose', kind),
  preview: (options: JobOptions) => ipcRenderer.invoke('job:preview', options),
  run: (options: JobOptions) => ipcRenderer.invoke('job:run', options),
  onJobEvent: (listener) => {
    const handler = (_event: Electron.IpcRendererEvent, jobEvent: JobEvent) => listener(jobEvent)
    ipcRenderer.on('job:event', handler)
    return () => ipcRenderer.removeListener('job:event', handler)
  },
}

contextBridge.exposeInMainWorld('photos', api)
