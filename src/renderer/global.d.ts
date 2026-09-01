import type { PhotosApi } from '../shared/job'

declare global {
  interface Window {
    photos: PhotosApi
  }
}

export {}
