import { downloadUrlToHfRepoUrl, isCivitaiModelUrl } from '@/utils/formatUtil'
import { isDesktop } from '@/platform/distribution/types'
import { api } from '@/scripts/api'
import { useElectronDownloadStore } from '@/stores/electronDownloadStore'
import { useSidebarTabStore } from '@/stores/workspace/sidebarTabStore'
import type { ComfyDesktop2Bridge } from '@/types'

const ALLOWED_SOURCES = [
  'https://civitai.com/',
  'https://civitai.red/',
  'https://huggingface.co/',
  'http://localhost:'
] as const

// Intentionally restrictive subset of model extensions permitted for download.
// Does not include .bin, .onnx, .gguf — see MODEL_FILE_EXTENSIONS in
// missingModelScan.ts for the broader scanning set.
const ALLOWED_SUFFIXES = [
  '.safetensors',
  '.sft',
  '.ckpt',
  '.pth',
  '.pt'
] as const

const WHITE_LISTED_URLS: ReadonlySet<string> = new Set([
  'https://huggingface.co/stabilityai/stable-zero123/resolve/main/stable_zero123.ckpt',
  'https://huggingface.co/TencentARC/T2I-Adapter/resolve/main/models/t2iadapter_depth_sd14v1.pth?download=true',
  'https://github.com/xinntao/Real-ESRGAN/releases/download/v0.1.0/RealESRGAN_x4plus.pth'
])

const MODEL_LIBRARY_TAB_ID = 'model-library'

export interface ModelWithUrl {
  name: string
  url: string
  directory: string
}

/** Task returned by the server's `POST /models/download` endpoint. */
export interface ServerDownloadTask {
  task_id: string
  status: 'created' | 'running' | 'completed' | 'failed'
  downloaded: number
  total: number | null
  progress: number
  error: string | null
}

/**
 * Asks the ComfyUI server to download the model into its models directory.
 * Resolves to `null` when the server has no such endpoint (older core), so the
 * caller can fall back to a browser download. Rejected requests (untrusted
 * host, bad filename, existing file, ...) resolve to a failed task.
 */
export async function requestServerModelDownload(
  model: ModelWithUrl
): Promise<ServerDownloadTask | null> {
  let response: Response
  try {
    response = await api.fetchApi('/models/download', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        url: model.url,
        folder: model.directory,
        filename: model.name
      })
    })
  } catch (error: unknown) {
    console.warn('[missingModelDownload] Server download unavailable:', error)
    return null
  }
  if (response.status === 404) return null

  if (!response.ok) {
    let message = `HTTP ${response.status}`
    try {
      const body: { error?: string } = await response.json()
      if (body.error) message = body.error
    } catch {
      // keep the status message
    }
    return {
      task_id: '',
      status: 'failed',
      downloaded: 0,
      total: null,
      progress: 0,
      error: message
    }
  }
  return (await response.json()) as ServerDownloadTask
}

export async function fetchServerModelDownload(
  taskId: string
): Promise<ServerDownloadTask | null> {
  try {
    const response = await api.fetchApi(
      `/models/download/${encodeURIComponent(taskId)}`
    )
    if (!response.ok) return null
    return (await response.json()) as ServerDownloadTask
  } catch {
    return null
  }
}

async function startDesktop2ModelDownload(
  bridge: ComfyDesktop2Bridge,
  model: ModelWithUrl
): Promise<void> {
  try {
    await bridge.downloadModel?.(model.url, model.name, model.directory)
  } catch (error: unknown) {
    console.error('Failed to start Desktop2 model download:', error)
  }
}

function openUrlInNewTab(url: string, downloadAs?: string): void {
  try {
    const protocol = new URL(url).protocol
    if (protocol !== 'https:' && protocol !== 'http:') {
      console.warn('[missingModelDownload] Blocked unsupported URL scheme')
      return
    }
  } catch {
    console.warn('[missingModelDownload] Blocked malformed download URL')
    return
  }

  const link = document.createElement('a')
  link.href = url
  if (downloadAs) link.download = downloadAs
  link.target = '_blank'
  link.rel = 'noopener noreferrer'
  link.click()
}

export function openGatedRepoPage(url: string): void {
  if (!isTrustedHuggingFaceUrl(url)) return
  openUrlInNewTab(url)
}

function hasHuggingFaceHost(url: string): boolean {
  try {
    return new URL(url).hostname.toLowerCase() === 'huggingface.co'
  } catch {
    return false
  }
}

export function isTrustedHuggingFaceUrl(url: string): boolean {
  try {
    return new URL(url).origin === 'https://huggingface.co'
  } catch {
    return false
  }
}

/**
 * Converts a model download URL to a browsable page URL.
 * - HuggingFace: `/resolve/` → `/blob/` (file page with model info)
 * - Civitai: strips `/api/download` or `/api/v1` prefix (model page)
 */
export function toBrowsableUrl(url: string): string {
  if (isCivitaiModelUrl(url)) {
    return url.replace('/api/download/', '/').replace('/api/v1/', '/')
  }
  if (hasHuggingFaceHost(url)) {
    return url.replace('/resolve/', '/blob/')
  }
  return url
}

export function isModelDownloadable(model: ModelWithUrl): boolean {
  if (WHITE_LISTED_URLS.has(model.url)) return true
  if (!ALLOWED_SOURCES.some((source) => model.url.startsWith(source)))
    return false
  if (!ALLOWED_SUFFIXES.some((suffix) => model.name.endsWith(suffix)))
    return false
  return true
}

/**
 * Starts a model download. Returns the server-side task when the backend
 * downloaded the model itself; `undefined` when the download was handed to the
 * desktop app or the browser instead.
 */
export async function downloadModel(
  model: ModelWithUrl,
  paths: Record<string, string[]>
): Promise<ServerDownloadTask | undefined> {
  const desktop2Bridge = window.__comfyDesktop2
  if (desktop2Bridge?.downloadModel && !desktop2Bridge.isRemote()) {
    void startDesktop2ModelDownload(desktop2Bridge, model)
    return
  }

  if (!isDesktop) {
    const task = await requestServerModelDownload(model)
    if (task) return task
    openUrlInNewTab(model.url, model.name)
    return
  }

  const modelPaths = paths[model.directory]
  if (modelPaths?.[0]) {
    useSidebarTabStore().activeSidebarTabId = MODEL_LIBRARY_TAB_ID
    void useElectronDownloadStore().start({
      url: model.url,
      savePath: modelPaths[0],
      filename: model.name
    })
  }
}

interface ModelMetadata {
  fileSize: number | null
  gatedRepoUrl: string | null
}

interface MetadataFetchResult {
  metadata: ModelMetadata
  cacheable: boolean
}

interface CivitaiModelFile {
  sizeKB: number
  downloadUrl: string
}

interface CivitaiModelVersionResponse {
  files: CivitaiModelFile[]
}

const metadataCache = new Map<string, ModelMetadata>()
const inflight = new Map<string, Promise<ModelMetadata>>()

export function clearMetadataCache(): void {
  metadataCache.clear()
  inflight.clear()
}

async function fetchCivitaiMetadata(url: string): Promise<MetadataFetchResult> {
  try {
    const pathname = new URL(url).pathname
    const versionIdMatch =
      pathname.match(/^\/api\/download\/models\/(\d+)$/) ??
      pathname.match(/^\/api\/v1\/models-versions\/(\d+)$/)

    if (!versionIdMatch) {
      return {
        metadata: { fileSize: null, gatedRepoUrl: null },
        cacheable: false
      }
    }

    const [, modelVersionId] = versionIdMatch
    const apiUrl = `https://civitai.com/api/v1/model-versions/${modelVersionId}`
    const res = await fetch(apiUrl)
    if (!res.ok) {
      return {
        metadata: { fileSize: null, gatedRepoUrl: null },
        cacheable: false
      }
    }

    const data: CivitaiModelVersionResponse = await res.json()
    const matchingFile = data.files?.find((file) => {
      const downloadUrl = file.downloadUrl
      return (
        typeof downloadUrl === 'string' &&
        downloadUrl.length > 0 &&
        downloadUrl.startsWith(url)
      )
    })
    const fileSize = matchingFile?.sizeKB ? matchingFile.sizeKB * 1024 : null
    return {
      metadata: { fileSize, gatedRepoUrl: null },
      cacheable: true
    }
  } catch {
    return {
      metadata: { fileSize: null, gatedRepoUrl: null },
      cacheable: false
    }
  }
}

const GATED_STATUS_CODES = new Set([401, 403, 451])
const HUGGING_FACE_GATED_ERROR_CODE = 'GatedRepo'

async function fetchHeadMetadata(url: string): Promise<MetadataFetchResult> {
  try {
    // Deliberately uncredentialed HEADs prevent re-checks from clearing gating.
    const response = await fetch(url, { method: 'HEAD' })
    if (!response.ok) {
      if (
        isTrustedHuggingFaceUrl(url) &&
        GATED_STATUS_CODES.has(response.status) &&
        response.headers.get('x-error-code') === HUGGING_FACE_GATED_ERROR_CODE
      ) {
        return {
          metadata: {
            fileSize: null,
            gatedRepoUrl: downloadUrlToHfRepoUrl(url)
          },
          cacheable: true
        }
      }
      return {
        metadata: { fileSize: null, gatedRepoUrl: null },
        cacheable: false
      }
    }
    const size = response.headers.get('content-length')
    const parsedSize = size ? parseInt(size, 10) : null
    return {
      metadata: {
        fileSize:
          parsedSize !== null && !Number.isNaN(parsedSize) ? parsedSize : null,
        gatedRepoUrl: null
      },
      cacheable: true
    }
  } catch {
    return {
      metadata: { fileSize: null, gatedRepoUrl: null },
      cacheable: false
    }
  }
}

export async function fetchModelMetadata(url: string): Promise<ModelMetadata> {
  const cached = metadataCache.get(url)
  if (cached !== undefined) return cached

  const existing = inflight.get(url)
  if (existing) return existing

  const promise = (async () => {
    const result = isCivitaiModelUrl(url)
      ? await fetchCivitaiMetadata(url)
      : await fetchHeadMetadata(url)
    if (result.cacheable) {
      metadataCache.set(url, result.metadata)
    }
    return result.metadata
  })()

  inflight.set(url, promise)
  try {
    return await promise
  } finally {
    inflight.delete(url)
  }
}
