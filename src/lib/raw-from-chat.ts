import { convertFileSrc } from "@tauri-apps/api/core"
import {
  copyFile,
  createDirectory,
  fileExists,
  preprocessFile,
  readFile,
  readFileAsBase64,
  writeBinaryFile,
  writeFile,
} from "@/commands/fs"
import { hasUsableLlm } from "@/lib/has-usable-llm"
import { getFileCategory, isTextReadable } from "@/lib/file-types"
import { getFileName, normalizePath } from "@/lib/path-utils"
import { enqueueSourceIngest } from "@/lib/source-lifecycle"
import { extractImageAsMarkdown } from "@/lib/vision-caption"
import { fetchAndExtract, slugFromTitle, type WebFetchResult } from "@/lib/web-fetch"
import { useWikiStore, type LlmConfig, type MultimodalConfig } from "@/stores/wiki-store"
import type { WikiProject } from "@/types/wiki"

export interface AddFilesFromChatResult {
  imported: string[]
  contextApplied: number
  failed: string[]
}

// Marker comment that delimits chat-originated context so future tooling can
// strip / rewrite it without ambiguity. Must match the open token used by
// buildContextBlock() and the sidecar prepend in ingest.ts.
export const CHAT_CONTEXT_MARKER = "<!-- llmwiki:chat-context"

// Sidecar lives next to the binary source as ".<basename>.context.md". The
// dot prefix hides it in the file tree AND makes isIngestableSourcePath()
// skip it so it never becomes its own ingest target.
export function contextSidecarPath(rawDestPath: string): string {
  const norm = normalizePath(rawDestPath)
  const slash = norm.lastIndexOf("/")
  const dir = slash >= 0 ? norm.slice(0, slash) : ""
  const name = slash >= 0 ? norm.slice(slash + 1) : norm
  return `${dir}/.${name}.context.md`
}

/**
 * Read a source file the same way ingest used to (via `read_file`, which
 * extracts text for PDF/Office on the Rust side), but if a sibling
 * `.<name>.context.md` exists, prepend it to the returned text.
 *
 * Text sources don't need this — their context was already inlined into
 * the file at chat-drop time. Sidecars only exist for binaries that we
 * couldn't safely mutate at drop time.
 */
export async function readSourceWithSidecar(sourcePath: string): Promise<string> {
  let content = ""
  try {
    content = await readFile(sourcePath)
  } catch {
    content = ""
  }
  try {
    const sidecar = await readFile(contextSidecarPath(sourcePath))
    if (sidecar && sidecar.trim()) {
      return `${sidecar.replace(/\s+$/, "")}\n\n${content}`
    }
  } catch {
    // No sidecar — the common case.
  }
  return content
}

export function buildContextBlock(note: string): string {
  const trimmed = note.trim()
  if (!trimmed) return ""
  const date = new Date().toISOString().slice(0, 10)
  return `${CHAT_CONTEXT_MARKER} added=${date} -->
## Context (added via chat)

${trimmed}

---

`
}

async function getUniqueDestPath(dir: string, fileName: string): Promise<string> {
  const basePath = `${dir}/${fileName}`
  if (!(await fileExists(basePath))) return basePath
  const ext = fileName.includes(".") ? fileName.slice(fileName.lastIndexOf(".")) : ""
  const nameWithoutExt = ext ? fileName.slice(0, -ext.length) : fileName
  const date = new Date().toISOString().slice(0, 10).replace(/-/g, "")
  const withDate = `${dir}/${nameWithoutExt}-${date}${ext}`
  if (!(await fileExists(withDate))) return withDate
  for (let i = 2; i <= 99; i++) {
    const withCounter = `${dir}/${nameWithoutExt}-${date}-${i}${ext}`
    if (!(await fileExists(withCounter))) return withCounter
  }
  return `${dir}/${nameWithoutExt}-${date}-${Date.now()}${ext}`
}

/**
 * Copy user-dropped files into raw/sources/, attaching the chat message as
 * "## Context" so the wiki has the WHY alongside the WHAT.
 *
 *   - Text-readable (md/txt/csv/code/...): prepend the block inline into
 *     the file. The source on disk now leads with `<!-- llmwiki:chat-context ... -->`.
 *   - Binary (pdf/docx/xlsx/...): write a sibling `.<name>.context.md` sidecar.
 *     ingest.readSourceWithSidecar() prepends it to the extracted text at
 *     parse time, so binaries see the same merged shape as text without
 *     having to mutate the binary itself.
 */
export async function addFilesToRawWithContext(
  project: WikiProject,
  sourcePaths: string[],
  contextNote: string,
  llmConfig: LlmConfig,
): Promise<AddFilesFromChatResult> {
  const pp = normalizePath(project.path)
  const block = buildContextBlock(contextNote)
  const imported: string[] = []
  const failed: string[] = []
  let contextApplied = 0

  for (const sourcePath of sourcePaths) {
    const originalName = getFileName(sourcePath) || "unknown"
    const destPath = await getUniqueDestPath(`${pp}/raw/sources`, originalName)
    try {
      await copyFile(sourcePath, destPath)

      if (block) {
        const category = getFileCategory(destPath)
        if (isTextReadable(category)) {
          try {
            const existing = await readFile(destPath).catch(() => "")
            await writeFile(destPath, block + existing)
            contextApplied++
          } catch (err) {
            console.warn(
              `[raw-from-chat] inline prepend failed for ${destPath}:`,
              err instanceof Error ? err.message : err,
            )
          }
        } else {
          try {
            await writeFile(contextSidecarPath(destPath), block)
            contextApplied++
          } catch (err) {
            console.warn(
              `[raw-from-chat] sidecar write failed for ${destPath}:`,
              err instanceof Error ? err.message : err,
            )
          }
        }
      }

      imported.push(destPath)
      preprocessFile(destPath).catch(() => {})
    } catch (err) {
      console.error(`[raw-from-chat] copy failed for ${originalName}:`, err)
      failed.push(sourcePath)
    }
  }

  if (imported.length > 0 && hasUsableLlm(llmConfig)) {
    await enqueueSourceIngest(project, imported, llmConfig)
  }

  return { imported, contextApplied, failed }
}

export interface UrlIngestFailure {
  url: string
  error: string
}

export interface AddUrlsFromChatResult {
  imported: string[]
  failed: UrlIngestFailure[]
}

const RAW_WEB_SUBDIR = "raw/sources/web"

function buildWebMarkdownFile(fetched: WebFetchResult, contextBlock: string): string {
  // Minimal YAML frontmatter — keeps the original URL machine-readable so a
  // future "re-fetch" action can just look at this field, and keeps title /
  // fetched-at out of the prose so wiki search doesn't index timestamps.
  const fm = [
    "---",
    `source_url: ${fetched.finalUrl}`,
    `title: ${JSON.stringify(fetched.title)}`,
    `fetched_at: ${fetched.fetchedAt}`,
    fetched.byline ? `byline: ${JSON.stringify(fetched.byline)}` : "",
    "---",
    "",
  ]
    .filter(Boolean)
    .join("\n")
  return `${fm}${contextBlock}# ${fetched.title}\n\n${fetched.markdown}\n`
}

export async function addUrlsToRawWithContext(
  project: WikiProject,
  urls: string[],
  contextNote: string,
  llmConfig: LlmConfig,
  options: { onProgress?: (url: string, status: "fetching" | "done" | "failed") => void } = {},
): Promise<AddUrlsFromChatResult> {
  const pp = normalizePath(project.path)
  const webDir = `${pp}/${RAW_WEB_SUBDIR}`
  const block = buildContextBlock(contextNote)
  const imported: string[] = []
  const failed: UrlIngestFailure[] = []

  // Best-effort dir create. createDirectory is idempotent.
  try {
    await createDirectory(webDir)
  } catch {
    // If write_file is happy to mkdir-p, this is redundant; if not, the
    // first writeFile will surface the same error.
  }

  for (const url of urls) {
    options.onProgress?.(url, "fetching")
    try {
      const fetched = await fetchAndExtract(url, { timeoutMs: 30000 })
      const date = new Date().toISOString().slice(0, 10).replace(/-/g, "")
      const slug = slugFromTitle(fetched.title, "web")
      let destPath = `${webDir}/${slug}-${date}.md`
      let n = 2
      while (await fileExists(destPath)) {
        destPath = `${webDir}/${slug}-${date}-${n}.md`
        n++
        if (n > 99) {
          destPath = `${webDir}/${slug}-${date}-${Date.now()}.md`
          break
        }
      }
      await writeFile(destPath, buildWebMarkdownFile(fetched, block))
      imported.push(destPath)
      options.onProgress?.(url, "done")
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      failed.push({ url, error: msg })
      options.onProgress?.(url, "failed")
      console.warn(`[raw-from-chat] URL fetch failed (${url}):`, msg)
    }
  }

  if (imported.length > 0 && hasUsableLlm(llmConfig)) {
    await enqueueSourceIngest(project, imported, llmConfig)
  }

  return { imported, failed }
}

/**
 * Standalone-image ingest: paste / drag-drop / sources-view import.
 *
 * Each item is either an on-disk path (drag-drop) or in-memory base64
 * + media type (clipboard paste). The pipeline is the same shape for
 * both:
 *
 *   1. Persist the image bytes under `raw/sources/images/`. Original
 *      filename slug for path inputs; date + counter for clipboard.
 *   2. Ask the vision LLM to extract the image's full content as
 *      wiki-ready markdown (description + verbatim OCR + structure —
 *      see STANDALONE_IMAGE_EXTRACT_PROMPT). The user's chat note
 *      becomes "userNote" context for the vision call.
 *   3. Write a sibling `.md` next to the image with frontmatter
 *      pointing back to the image file, the optional chat-context
 *      block, and the extracted markdown. The `.md` (not the image)
 *      is what enters the ingest queue — image bytes have no
 *      chunkable text, so they'd just be filtered out anyway.
 *
 * The image file is kept on disk so the sources view can still
 * preview it via ImagePreview. The wiki ends up referencing the
 * extracted markdown; the image is the visual receipt.
 */
const RAW_IMAGES_SUBDIR = "raw/sources/images"

export interface ChatImageItem {
  /** Original on-disk path (drag-drop, file picker). Mutually exclusive with base64. */
  sourcePath?: string
  /** Raw base64 of the image bytes (clipboard paste). Pair with mediaType. */
  base64?: string
  /** MIME type — e.g. "image/png", "image/jpeg". Required when base64 is set. */
  mediaType?: string
  /** Optional display name override. Falls back to source filename or
   *  "pasted-image" for clipboard inputs. */
  displayName?: string
}

export interface AddImagesFromChatResult {
  /** Paths of the `.md` companions written and queued for ingest. */
  imported: string[]
  /** Paths of the image files saved (parallel array to imported). */
  imagePaths: string[]
  /** Items we failed to process — base64 length OR sourcePath for debug. */
  failed: { item: string; error: string }[]
  /** Count of items where the LLM reply matched a "no image visible"
   *  refusal pattern — strong signal the configured model is text-only.
   *  Callers surface this in the user-facing reply so the user knows
   *  to switch models, not just stare at a stubbed .md. */
  visionRefusals: number
  /** Whether the LLM used was the dedicated multimodal endpoint
   *  (true) or the main chat LLM (false). Determines which "go fix
   *  your config" hint to show. */
  usedDedicatedVisionLlm: boolean
  /** Model name we attempted vision with — for inclusion in the
   *  user-facing message ("MiniMax-M2.7 returned no image content"). */
  attemptedVisionModel: string
}

function extensionForMediaType(mediaType: string): string {
  switch (mediaType.toLowerCase()) {
    case "image/png":
      return "png"
    case "image/jpeg":
    case "image/jpg":
      return "jpg"
    case "image/webp":
      return "webp"
    case "image/gif":
      return "gif"
    case "image/bmp":
      return "bmp"
    case "image/svg+xml":
      return "svg"
    case "image/tiff":
    case "image/tif":
      return "tif"
    default:
      // Best-effort: split off "image/" prefix; if it's something
      // exotic, fall back to "bin" so the file still lands on disk
      // but doesn't masquerade as a known type.
      return mediaType.startsWith("image/") ? mediaType.slice("image/".length) : "bin"
  }
}

function slugifyForFilename(input: string): string {
  return input
    .toLowerCase()
    .replace(/[^a-z0-9一-鿿]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40) || "image"
}

/**
 * Pick the LLM that should handle vision extraction for an uploaded
 * image. Honours the user's multimodal-config settings the same way
 * the ingest caption pipeline does:
 *
 *   - mm.enabled + mm.useMainLlm → main chat LLM
 *   - mm.enabled + !mm.useMainLlm → dedicated multimodal endpoint
 *   - !mm.enabled → main chat LLM (best-effort — caller surfaces a
 *     "vision not configured" hint in the resulting markdown so the
 *     user knows why a text-only main LLM returned a stub)
 *
 * Returning the main LLM rather than null when multimodal is OFF
 * matches the choice the user made via the chat AskUserQuestion
 * flow ("reuse chat LLM"), but the placeholder text differs so a
 * stubbed extraction is visibly attributable to the missing config.
 */
function resolveVisionLlm(mm: MultimodalConfig, mainLlm: LlmConfig): LlmConfig {
  if (mm.enabled && !mm.useMainLlm) {
    return {
      provider: mm.provider,
      apiKey: mm.apiKey,
      model: mm.model,
      ollamaUrl: mm.ollamaUrl,
      customEndpoint: mm.customEndpoint,
      azureApiVersion: mm.azureApiVersion,
      azureModelFamily: mm.azureModelFamily,
      apiMode: mm.apiMode,
      maxContextSize: mainLlm.maxContextSize,
    }
  }
  return mainLlm
}

/**
 * Downsize an image before handing it to the vision LLM.
 *
 * Why:
 *   - **Tauri IPC limits**: payloads above ~2MB regularly crash the
 *     custom-protocol channel and fall back to postMessage, which
 *     fails with `Error: The resource id <n> is invalid.` mid-stream.
 *     The user sees their vision call silently die after a 30s wait.
 *   - **Vision LLM tile pricing**: providers internally tile images at
 *     1024-2048px regardless of input resolution. A 4K screenshot
 *     pays the same OCR quality as a 2K one but burns 3-4× the
 *     bandwidth and prompt tokens.
 *   - **Latency**: re-encoded JPEG @ q=0.85 of a screenshot is
 *     typically 100-300 KB instead of 2-5 MB. Uploads to remote
 *     vision APIs drop by ~10×.
 *
 * What:
 *   - Decode the original PNG/JPEG/etc into an Image element.
 *   - If long-side ≤ `maxDim`, return the original bytes unchanged
 *     (no quality loss when not needed).
 *   - Otherwise rescale to `maxDim` on the longer side via canvas,
 *     re-encode as JPEG q=0.85, return the new base64 + media type.
 *
 * What this is NOT:
 *   - Not used for the on-disk archival copy of the image. That copy
 *     is the user's authoritative source and stays original-fidelity.
 *     Only the in-flight LLM payload is shrunk.
 *   - Not used for SVG (vector — has no pixel dimensions to base
 *     downsize on; passed through unchanged).
 */
/**
 * URL variant — load an image from a tauri:// or http(s):// URL into
 * a canvas WITHOUT crossing IPC, then downsize. Used for the drag-
 * drop / file-picker flow where the original bytes already live on
 * disk and we want to avoid pulling them across IPC just to shrink
 * them. The URL must be reachable from the webview (convertFileSrc
 * for local paths, regular http URL for fetched images).
 */
async function downsizeImageFromUrl(
  url: string,
  maxDim: number = 1280,
): Promise<{ base64: string; mediaType: string; downsized: boolean }> {
  const img = new Image()
  // Tauri's converted file URLs are same-origin to the webview by
  // design, so CORS isn't needed; for http(s) sources crossOrigin
  // would be required, but path inputs are always local.
  await new Promise<void>((resolve, reject) => {
    img.onload = () => resolve()
    img.onerror = () => reject(new Error(`image decode failed for ${url}`))
    img.src = url
  })
  const w = img.naturalWidth
  const h = img.naturalHeight
  const longest = Math.max(w, h)
  if (longest <= maxDim || longest === 0) {
    // Caller falls back to readFileAsBase64 in this branch.
    return { base64: "", mediaType: "", downsized: false }
  }
  const scale = maxDim / longest
  const targetW = Math.max(1, Math.round(w * scale))
  const targetH = Math.max(1, Math.round(h * scale))
  const canvas = document.createElement("canvas")
  canvas.width = targetW
  canvas.height = targetH
  const ctx = canvas.getContext("2d")
  if (!ctx) return { base64: "", mediaType: "", downsized: false }
  ctx.drawImage(img, 0, 0, targetW, targetH)
  const dataUrl = canvas.toDataURL("image/jpeg", 0.85)
  const commaIdx = dataUrl.indexOf(",")
  if (commaIdx < 0) return { base64: "", mediaType: "", downsized: false }
  return {
    base64: dataUrl.slice(commaIdx + 1),
    mediaType: "image/jpeg",
    downsized: true,
  }
}

async function downsizeImageForVision(
  base64: string,
  mediaType: string,
  // 1280px on the long side aligns with the input tile size that
  // OpenAI / Anthropic / Gemini all use internally — sending bigger
  // burns bandwidth and IPC budget without changing OCR accuracy.
  // Picked over 2048 after Tauri's macOS IPC custom-protocol still
  // dropped ~600KB JPEG payloads with "resource id invalid".
  maxDim: number = 1280,
): Promise<{ base64: string; mediaType: string; downsized: boolean }> {
  if (mediaType === "image/svg+xml") {
    return { base64, mediaType, downsized: false }
  }
  // base64 → Blob → object URL → HTMLImageElement (canvas needs a
  // bitmap source; we can't go base64 → canvas directly). Using a
  // Blob URL avoids the giant data: URL allocation that base64-as-
  // data-url would force.
  const binary = atob(base64)
  const bytes = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i)
  const blob = new Blob([bytes], { type: mediaType })
  const url = URL.createObjectURL(blob)
  try {
    const img = new Image()
    await new Promise<void>((resolve, reject) => {
      img.onload = () => resolve()
      img.onerror = () => reject(new Error(`image decode failed for ${mediaType}`))
      img.src = url
    })
    const w = img.naturalWidth
    const h = img.naturalHeight
    const longest = Math.max(w, h)
    if (longest <= maxDim || longest === 0) {
      return { base64, mediaType, downsized: false }
    }
    const scale = maxDim / longest
    const targetW = Math.max(1, Math.round(w * scale))
    const targetH = Math.max(1, Math.round(h * scale))
    const canvas = document.createElement("canvas")
    canvas.width = targetW
    canvas.height = targetH
    const ctx = canvas.getContext("2d")
    if (!ctx) return { base64, mediaType, downsized: false }
    ctx.drawImage(img, 0, 0, targetW, targetH)
    // JPEG q=0.85 is the sweet spot: vision models retain full OCR
    // accuracy at q≥0.7, file shrinks 10× vs PNG; lossy for diagrams
    // is acceptable because the original-fidelity PNG stays on disk
    // for human preview.
    const dataUrl = canvas.toDataURL("image/jpeg", 0.85)
    const commaIdx = dataUrl.indexOf(",")
    if (commaIdx < 0) return { base64, mediaType, downsized: false }
    return {
      base64: dataUrl.slice(commaIdx + 1),
      mediaType: "image/jpeg",
      downsized: true,
    }
  } finally {
    URL.revokeObjectURL(url)
  }
}

/**
 * Heuristic — did the vision LLM actually look at the image, or did
 * it fall back to "I can't see any image" because the model is
 * text-only and silently dropped the image_url block?
 *
 * Common refusal phrases across English / Chinese / structured-output
 * variants. Used to swap a "couldn't extract" hint into the .md so the
 * user is told to enable multimodal in Settings instead of seeing the
 * model's literal "no image" reply as if it were OCR output.
 */
function looksLikeNoImageRefusal(text: string): boolean {
  const t = text.trim().toLowerCase()
  if (t.length === 0) return true
  if (t.length > 600) return false
  return (
    t.includes("no image") ||
    t.includes("cannot see") ||
    t.includes("can't see") ||
    t.includes("not provided") ||
    t.includes("not visible") ||
    t.includes("don't see") ||
    t.includes("没有图片") ||
    t.includes("看不到") ||
    t.includes("没有看到") ||
    t.includes("未提供") ||
    t.includes("无法看到")
  )
}

export async function addImagesToRawWithContext(
  project: WikiProject,
  items: ChatImageItem[],
  contextNote: string,
  llmConfig: LlmConfig,
  options: {
    onProgress?: (label: string, status: "saving" | "extracting" | "done" | "failed") => void
    signal?: AbortSignal
  } = {},
): Promise<AddImagesFromChatResult> {
  const pp = normalizePath(project.path)
  const imagesDir = `${pp}/${RAW_IMAGES_SUBDIR}`
  const block = buildContextBlock(contextNote)
  const noteForVision = contextNote.trim()
  const imported: string[] = []
  const imagePaths: string[] = []
  const failed: { item: string; error: string }[] = []
  let visionRefusals = 0
  // Resolved once up-front so the result can report which LLM we
  // actually used — even if no images were processed (caller wants
  // to surface "your main LLM has no vision" before any item ran).
  const mmCfgInitial = useWikiStore.getState().multimodalConfig
  const visionLlmInitial = resolveVisionLlm(mmCfgInitial, llmConfig)
  const usedDedicatedVisionLlm = mmCfgInitial.enabled && !mmCfgInitial.useMainLlm
  const attemptedVisionModel = visionLlmInitial.model

  try {
    await createDirectory(imagesDir)
  } catch {
    // First writeBinaryFile / copyFile will surface a clearer error.
  }

  for (let idx = 0; idx < items.length; idx++) {
    const item = items[idx]
    if (options.signal?.aborted) break

    const isPath = Boolean(item.sourcePath && item.sourcePath.length > 0)
    const labelBase = item.displayName
      ?? (isPath ? getFileName(item.sourcePath!) : `pasted-image-${idx + 1}`)
    options.onProgress?.(labelBase, "saving")

    try {
      // 1. Resolve final destination and persist the image bytes.
      const date = new Date().toISOString().slice(0, 10).replace(/-/g, "")
      let ext: string
      let stem: string
      if (isPath) {
        const orig = getFileName(item.sourcePath!) || "image"
        const dot = orig.lastIndexOf(".")
        ext = dot >= 0 ? orig.slice(dot + 1).toLowerCase() : "png"
        stem = slugifyForFilename(dot >= 0 ? orig.slice(0, dot) : orig)
      } else {
        const mt = item.mediaType ?? "image/png"
        ext = extensionForMediaType(mt)
        stem = slugifyForFilename(item.displayName ?? "pasted")
      }

      let imageDest = `${imagesDir}/${stem}-${date}.${ext}`
      let n = 2
      while (await fileExists(imageDest)) {
        imageDest = `${imagesDir}/${stem}-${date}-${n}.${ext}`
        n++
        if (n > 99) {
          imageDest = `${imagesDir}/${stem}-${date}-${Date.now()}.${ext}`
          break
        }
      }

      // For drag-drop / picker we have a path — `copyFile` is small
      // IPC (just paths), no body bytes cross IPC. The image stays
      // original-fidelity on disk and we read it back in-webview via
      // convertFileSrc later only if needed for vision.
      //
      // For clipboard we have base64 in JS memory. We MUST NOT save
      // the original via writeBinaryFile — that would push 2-3MB
      // through Tauri's IPC custom-protocol, which on macOS
      // collapses ("IPC custom protocol failed, postMessage
      // fallback") and breaks every subsequent IPC call in the
      // session, including the vision request body.
      //
      // The fix: downsize in JS first (Canvas, zero IPC), then save
      // the SMALL JPEG via writeBinaryFile (~150-300KB — fits IPC
      // comfortably). Original-resolution clipboard images aren't
      // preserved anywhere — but they came from clipboard, the user
      // doesn't have an "original" file anyway; the downsized JPEG
      // IS the wiki archive.
      let savedBase64: string  // bytes that end up on disk
      let savedMediaType: string
      let visionBase64: string  // bytes that get sent to vision LLM
      let visionMediaType: string
      let savedExt = ext

      if (isPath) {
        // Path inputs — original copied to disk via Rust-side
        // file-to-file copy (no body crosses IPC). For vision we
        // downsize in-webview via Image+canvas from the converted
        // tauri:// URL — also IPC-free.
        await copyFile(item.sourcePath!, imageDest)
        const sourceUrl = convertFileSrc(item.sourcePath!)
        const shrunk = await downsizeImageFromUrl(sourceUrl).catch((err) => {
          console.warn("[raw-from-chat] path-input downsize failed:", err)
          return null
        })
        if (shrunk && shrunk.downsized) {
          visionBase64 = shrunk.base64
          visionMediaType = shrunk.mediaType
          console.info(
            "%c[raw-from-chat] downsized for vision (path input)",
            "color: #059669; font-weight: bold;",
            {
              newBytesApprox: Math.round(shrunk.base64.length * 0.75),
              newMediaType: shrunk.mediaType,
            },
          )
        } else {
          // Image already small — fall back to readFileAsBase64. The
          // IPC payload is bounded (<1280px image is typically <1MB).
          const read = await readFileAsBase64(imageDest)
          visionBase64 = read.base64
          visionMediaType = read.mimeType
        }
        // Disk version stays original — copyFile already did it.
        savedBase64 = ""
        savedMediaType = ""
      } else {
        // Clipboard input. Downsize from the in-memory base64 via
        // blob URL → Image → canvas. Save the downsized JPEG to
        // disk (small IPC). Use same downsized bytes for vision.
        if (!item.base64) {
          throw new Error("clipboard image missing base64 payload")
        }
        const origMediaType = item.mediaType ?? "image/png"
        let shrunk: { base64: string; mediaType: string; downsized: boolean } | null = null
        try {
          shrunk = await downsizeImageForVision(item.base64, origMediaType)
        } catch (err) {
          console.warn(
            "[raw-from-chat] clipboard downsize failed, will save original (IPC may break):",
            err instanceof Error ? err.message : err,
          )
        }
        if (shrunk && shrunk.downsized) {
          savedBase64 = shrunk.base64
          savedMediaType = shrunk.mediaType
          visionBase64 = shrunk.base64
          visionMediaType = shrunk.mediaType
          savedExt = "jpg"
          console.info(
            "%c[raw-from-chat] downsized clipboard image",
            "color: #059669; font-weight: bold;",
            {
              origBytesApprox: Math.round(item.base64.length * 0.75),
              newBytesApprox: Math.round(shrunk.base64.length * 0.75),
              newMediaType: shrunk.mediaType,
            },
          )
        } else {
          // No downsize needed OR downsize failed. Use original.
          savedBase64 = item.base64
          savedMediaType = origMediaType
          visionBase64 = item.base64
          visionMediaType = origMediaType
        }
        // Re-derive dest path if extension changed (PNG → JPG).
        if (savedExt !== ext) {
          imageDest = imageDest.replace(/\.[^.]+$/, `.${savedExt}`)
        }
        await writeBinaryFile(imageDest, savedBase64)
      }

      // Vision LLM gets `visionBase64` / `visionMediaType` set above.
      // Both branches guarantee these are populated.
      const imageBase64 = visionBase64
      const mediaType = visionMediaType

      // 2. Vision LLM extracts image content as markdown.
      //
      // Resolve which LLM to use: the dedicated multimodal endpoint
      // (when configured) or the main chat LLM (the user's "reuse
      // chat LLM" choice). Falling back to main LLM when multimodal
      // is OFF preserves the user's earlier preference, but if main
      // is text-only the model will silently drop the image_url
      // block and reply with "no image visible" — we detect that
      // refusal and swap in a clear placeholder so the user knows
      // to enable multimodal rather than seeing the LLM's confused
      // text as if it were OCR output.
      const mm = useWikiStore.getState().multimodalConfig
      const visionLlm = resolveVisionLlm(mm, llmConfig)
      console.info(
        "%c[raw-from-chat] image pipeline start",
        "color: #059669; font-weight: bold;",
        {
          item: labelBase,
          imageDest,
          origBytesApprox: Math.round(imageBase64.length * 0.75),
          mediaType,
          visionProvider: visionLlm.provider,
          visionModel: visionLlm.model,
          mmEnabled: mm.enabled,
          mmUseMainLlm: mm.useMainLlm,
        },
      )
      const usingDedicated = mm.enabled && !mm.useMainLlm
      options.onProgress?.(labelBase, "extracting")
      let extracted = ""
      if (hasUsableLlm(visionLlm)) {
        try {
          // imageBase64 / mediaType are already the downsized bytes
          // (decided above before the disk write to keep IPC small).
          extracted = await extractImageAsMarkdown(
            imageBase64,
            mediaType,
            visionLlm,
            options.signal,
            { userNote: noteForVision },
          )
          if (looksLikeNoImageRefusal(extracted)) {
            visionRefusals++
            const hint = usingDedicated
              ? `_Vision extraction returned no usable content — the configured multimodal model (${visionLlm.model}) does not appear to support image input. Switch to a vision-capable model in Settings → Multimodal, then re-ingest._`
              : `_Vision extraction returned no usable content — the current chat LLM (${visionLlm.model}) is text-only. Open Settings → Multimodal, enable it, and configure a vision-capable model, then re-ingest._`
            console.warn(
              `[raw-from-chat] vision LLM refusal on ${imageDest}; raw reply: ${extracted.slice(0, 200)}`,
            )
            extracted = hint
          }
        } catch (err) {
          // Don't fail the whole import on a vision error — keep the
          // image saved and the .md companion still gets written
          // with the user's note. The ingest LLM at least sees
          // structure and can be re-run later.
          console.warn(
            `[raw-from-chat] vision extract failed for ${imageDest}:`,
            err instanceof Error ? err.message : err,
          )
          extracted = `_Image content extraction failed — re-run ingest after fixing the vision LLM config. Error: ${err instanceof Error ? err.message : String(err)}_`
        }
      } else {
        extracted = "_No vision-capable LLM configured — image saved but content not extracted. Open Settings → Multimodal to set up a vision-capable model, then re-ingest._"
      }

      // 3. Write .md companion. Frontmatter records the image path so
      // a future "re-extract" action can find the original bytes.
      const imageBasename = getFileName(imageDest)
      const mdDest = imageDest.replace(/\.[^.]+$/, ".md")
      const frontmatter = [
        "---",
        `source_image: ${imageBasename}`,
        `media_type: ${mediaType}`,
        `captured_at: ${new Date().toISOString()}`,
        "---",
        "",
      ].join("\n")
      // Image reference uses the absolute filesystem path. The wiki's
      // markdown-image-resolver treats relative paths as wiki-root-
      // relative (`![](foo.jpg)` → `<project>/wiki/foo.jpg`), which
      // would 404 because our image lives in raw/sources/images/.
      // Absolute paths are passed through to convertFileSrc directly,
      // which loads the file regardless of where the .md is opened
      // from (raw-source preview, wiki page that references it, etc.).
      const body = `${block}# Image: ${imageBasename}\n\n![](${imageDest})\n\n${extracted}\n`
      await writeFile(mdDest, frontmatter + body)

      imported.push(mdDest)
      imagePaths.push(imageDest)
      preprocessFile(mdDest).catch(() => {})
      options.onProgress?.(labelBase, "done")
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      failed.push({ item: labelBase, error: msg })
      options.onProgress?.(labelBase, "failed")
      console.warn(`[raw-from-chat] image import failed (${labelBase}):`, msg)
    }
  }

  if (imported.length > 0 && hasUsableLlm(llmConfig)) {
    await enqueueSourceIngest(project, imported, llmConfig)
  }

  return {
    imported,
    imagePaths,
    failed,
    visionRefusals,
    usedDedicatedVisionLlm,
    attemptedVisionModel,
  }
}

/**
 * Cheap test: does a file path look like an image we should route
 * through addImagesToRawWithContext rather than addFilesToRawWithContext?
 * Matches by extension only — same set the Rust read_file_as_base64
 * MIME table recognises.
 */
export function isImageSourcePath(path: string): boolean {
  const name = getFileName(path).toLowerCase()
  const dot = name.lastIndexOf(".")
  if (dot < 0) return false
  const ext = name.slice(dot + 1)
  return ["png", "jpg", "jpeg", "gif", "webp", "bmp", "tif", "tiff", "svg"].includes(ext)
}
