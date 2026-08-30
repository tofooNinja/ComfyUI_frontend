import { createTestingPinia } from '@pinia/testing'
import { setActivePinia } from 'pinia'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type * as MissingModelDownload from '@/platform/missingModel/missingModelDownload'
import { useMissingModelStore } from '@/platform/missingModel/missingModelStore'

const mocks = vi.hoisted(() => ({
  downloadModel: vi.fn<typeof MissingModelDownload.downloadModel>(),
  fetchModelMetadata: vi.fn<typeof MissingModelDownload.fetchModelMetadata>(),
  fetchServerModelDownload:
    vi.fn<typeof MissingModelDownload.fetchServerModelDownload>(),
  isTrustedHuggingFaceUrl:
    vi.fn<typeof MissingModelDownload.isTrustedHuggingFaceUrl>(),
  openGatedRepoPage: vi.fn<typeof MissingModelDownload.openGatedRepoPage>()
}))

vi.mock('@/stores/assetsStore', () => ({
  useAssetsStore: () => ({ invalidateModelsForCategory: vi.fn() })
}))

vi.mock('@/platform/missingModel/missingModelDownload', () => ({
  downloadModel: mocks.downloadModel,
  fetchModelMetadata: mocks.fetchModelMetadata,
  fetchServerModelDownload: mocks.fetchServerModelDownload,
  isTrustedHuggingFaceUrl: mocks.isTrustedHuggingFaceUrl,
  openGatedRepoPage: mocks.openGatedRepoPage
}))

import { useMissingModelDownload } from './useMissingModelDownload'

const downloadUrl =
  'https://huggingface.co/org/model/resolve/main/model.safetensors'
const repoUrl = 'https://huggingface.co/org/model'

describe('useMissingModelDownload', () => {
  beforeEach(() => {
    setActivePinia(createTestingPinia({ stubActions: false }))
    vi.clearAllMocks()
    delete window.__comfyDesktop2
    mocks.isTrustedHuggingFaceUrl.mockImplementation((url) => url === repoUrl)
    mocks.fetchModelMetadata.mockResolvedValue({
      fileSize: null,
      gatedRepoUrl: null
    })
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('exposes fetched file metadata to components', async () => {
    mocks.fetchModelMetadata.mockResolvedValueOnce({
      fileSize: 1024,
      gatedRepoUrl: null
    })

    const { fileSizeFor, prefetchModelMetadata } = useMissingModelDownload()
    await prefetchModelMetadata(downloadUrl)

    expect(fileSizeFor(downloadUrl)).toBe(1024)
  })

  it('exposes fetched gated repository metadata to components', async () => {
    mocks.fetchModelMetadata.mockResolvedValueOnce({
      fileSize: null,
      gatedRepoUrl: repoUrl
    })

    const { gatedRepoUrlFor, prefetchModelMetadata } = useMissingModelDownload()
    await prefetchModelMetadata(downloadUrl)

    expect(gatedRepoUrlFor(downloadUrl)).toBe(repoUrl)
  })

  it('skips metadata already classified by the store', async () => {
    const store = useMissingModelStore()
    const sizedUrl = `${downloadUrl}?sized`
    const gatedUrl = `${downloadUrl}?gated`
    store.setFileSize(sizedUrl, 1024)
    store.setGatedRepoUrl(gatedUrl, repoUrl)

    const { prefetchModelMetadata } = useMissingModelDownload()
    await prefetchModelMetadata(sizedUrl)
    await prefetchModelMetadata(gatedUrl)

    expect(mocks.fetchModelMetadata).not.toHaveBeenCalled()
  })

  it('downloads with the current missing-model folder paths', async () => {
    const store = useMissingModelStore()
    store.setFolderPaths({ checkpoints: ['/models/checkpoints'] })
    const model = {
      name: 'model.safetensors',
      url: downloadUrl,
      directory: 'checkpoints'
    }
    mocks.downloadModel.mockResolvedValueOnce(undefined)

    await useMissingModelDownload().downloadMissingModel(model)

    expect(mocks.downloadModel).toHaveBeenCalledWith(model, {
      checkpoints: ['/models/checkpoints']
    })
    expect(store.serverDownloads[downloadUrl]).toBeUndefined()
  })

  it('tracks a server-side download until it completes', async () => {
    vi.useFakeTimers()
    try {
      const store = useMissingModelStore()
      const model = {
        name: 'model.safetensors',
        url: downloadUrl,
        directory: 'checkpoints'
      }
      const task = {
        task_id: 'task-1',
        status: 'created' as const,
        downloaded: 0,
        total: 100,
        progress: 0,
        error: null
      }
      mocks.downloadModel.mockResolvedValueOnce(task)
      mocks.fetchServerModelDownload
        .mockResolvedValueOnce({
          ...task,
          status: 'running',
          downloaded: 50,
          progress: 0.5
        })
        .mockResolvedValueOnce({
          ...task,
          status: 'completed',
          downloaded: 100,
          progress: 1
        })

      const { downloadMissingModel, serverDownloadFor } =
        useMissingModelDownload()
      await downloadMissingModel(model)
      expect(serverDownloadFor(downloadUrl)?.status).toBe('created')

      // A second click while running must not start another download.
      await downloadMissingModel(model)
      expect(mocks.downloadModel).toHaveBeenCalledTimes(1)

      await vi.advanceTimersByTimeAsync(1000)
      expect(serverDownloadFor(downloadUrl)?.progress).toBe(0.5)
      await vi.advanceTimersByTimeAsync(1000)
      expect(serverDownloadFor(downloadUrl)?.status).toBe('completed')
      expect(store.serverDownloads[downloadUrl]?.downloaded).toBe(100)
    } finally {
      vi.useRealTimers()
    }
  })

  it('opens a trusted access page through the Desktop bridge', async () => {
    let receiver: unknown
    let openedUrl: string | undefined
    const bridge = {
      isRemote: () => true,
      async openModelAccessPage(this: unknown, url: string) {
        receiver = this
        openedUrl = url
        return true
      }
    }
    window.__comfyDesktop2 = bridge

    await useMissingModelDownload().openModelAccessPage(repoUrl)

    expect(receiver).toBe(bridge)
    expect(openedUrl).toBe(repoUrl)
    expect(mocks.openGatedRepoPage).not.toHaveBeenCalled()
  })

  it('falls back when the Desktop bridge declines the access page', async () => {
    const openModelAccessPage = vi.fn().mockResolvedValue(false)
    window.__comfyDesktop2 = {
      isRemote: () => false,
      openModelAccessPage
    }

    await useMissingModelDownload().openModelAccessPage(repoUrl)

    expect(openModelAccessPage).toHaveBeenCalledWith(repoUrl)
    expect(mocks.openGatedRepoPage).toHaveBeenCalledWith(repoUrl)
  })

  it('falls back when the Desktop bridge rejects the access page', async () => {
    const error = new Error('Desktop bridge unavailable')
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {})
    window.__comfyDesktop2 = {
      isRemote: () => false,
      openModelAccessPage: vi.fn().mockRejectedValue(error)
    }

    await useMissingModelDownload().openModelAccessPage(repoUrl)

    expect(consoleError).toHaveBeenCalledWith(
      'Failed to open model access page in Desktop:',
      error
    )
    expect(mocks.openGatedRepoPage).toHaveBeenCalledWith(repoUrl)
  })

  it('rejects untrusted access page URLs before invoking a host', async () => {
    const openModelAccessPage = vi.fn().mockResolvedValue(true)
    window.__comfyDesktop2 = {
      isRemote: () => false,
      openModelAccessPage
    }
    await useMissingModelDownload().openModelAccessPage(
      'https://example.com/org/model'
    )

    expect(openModelAccessPage).not.toHaveBeenCalled()
    expect(mocks.openGatedRepoPage).not.toHaveBeenCalled()
  })
})
