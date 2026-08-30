import {
  downloadModel,
  fetchServerModelDownload,
  isTrustedHuggingFaceUrl,
  openGatedRepoPage
} from '@/platform/missingModel/missingModelDownload'
import type {
  ModelWithUrl,
  ServerDownloadTask
} from '@/platform/missingModel/missingModelDownload'
import { fetchAndStoreModelMetadata } from '@/platform/missingModel/missingModelMetadata'
import { useMissingModelStore } from '@/platform/missingModel/missingModelStore'
import { useAssetsStore } from '@/stores/assetsStore'

const SERVER_DOWNLOAD_POLL_MS = 1000

export function useMissingModelDownload() {
  const store = useMissingModelStore()

  function fileSizeFor(url: string): number | undefined {
    return store.fileSizes[url]
  }

  function gatedRepoUrlFor(url: string): string | undefined {
    return store.gatedRepoUrls[url]
  }

  async function prefetchModelMetadata(url: string): Promise<void> {
    if (fileSizeFor(url) !== undefined || gatedRepoUrlFor(url)) return

    await fetchAndStoreModelMetadata(url, store)
  }

  function serverDownloadFor(url: string): ServerDownloadTask | undefined {
    return store.serverDownloads[url]
  }

  async function pollServerDownload(
    model: ModelWithUrl,
    taskId: string
  ): Promise<void> {
    while (true) {
      await new Promise((resolve) =>
        setTimeout(resolve, SERVER_DOWNLOAD_POLL_MS)
      )
      const task = await fetchServerModelDownload(taskId)
      if (!task) continue
      store.setServerDownload(model.url, task)
      if (task.status === 'completed') {
        useAssetsStore().invalidateModelsForCategory(model.directory)
        return
      }
      if (task.status === 'failed') return
    }
  }

  async function downloadMissingModel(model: ModelWithUrl): Promise<void> {
    const active = serverDownloadFor(model.url)
    if (active?.status === 'running' || active?.status === 'created') return

    const task = await downloadModel(model, store.folderPaths)
    if (!task) return

    store.setServerDownload(model.url, task)
    if (task.status === 'created' || task.status === 'running') {
      void pollServerDownload(model, task.task_id)
    }
  }

  // Always try the bridge: it opens in the user's Electron session. isRemote()
  // describes the backend server, not the user, so it must not gate this. The
  // anchor fallback inside Electron hits shell.openExternal and strands the
  // provider cookies in the system browser.
  async function openModelAccessPage(repoUrl: string): Promise<void> {
    if (!isTrustedHuggingFaceUrl(repoUrl)) {
      console.warn('[missingModelDownload] Blocked untrusted access URL')
      return
    }

    const bridge = window.__comfyDesktop2
    if (bridge?.openModelAccessPage) {
      try {
        if ((await bridge.openModelAccessPage(repoUrl)) === true) return
      } catch (error: unknown) {
        console.error('Failed to open model access page in Desktop:', error)
      }
    }

    openGatedRepoPage(repoUrl)
  }

  return {
    fileSizeFor,
    gatedRepoUrlFor,
    prefetchModelMetadata,
    downloadMissingModel,
    serverDownloadFor,
    openModelAccessPage
  }
}
