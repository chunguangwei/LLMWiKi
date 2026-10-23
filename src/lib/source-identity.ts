import { getFileName, normalizePath } from "@/lib/path-utils"

const RAW_SOURCES_PREFIX = "raw/sources/"
const RAW_SOURCES_MARKER = "/raw/sources/"
const MAX_SOURCE_SUMMARY_SLUG_LENGTH = 120
// Filesystem components commonly allow 255 UTF-8 bytes; reserve three for
// the .md extension. Keep portable existing names unchanged.
const MAX_SOURCE_SUMMARY_SLUG_BYTES = 252
const FALLBACK_SOURCE_PART = "source"

export function sourceIdentityForPath(projectPath: string, sourcePath: string): string {
  const pp = normalizePath(projectPath).replace(/\/+$/, "")
  const sp = normalizePath(sourcePath)
  const projectRawSourcesPrefix = `${pp}/${RAW_SOURCES_PREFIX}`
  const spKey = sp.toLowerCase()
  if (spKey.startsWith(projectRawSourcesPrefix.toLowerCase())) {
    return sp.slice(projectRawSourcesPrefix.length)
  }
  if (spKey.startsWith(RAW_SOURCES_PREFIX)) {
    return sp.slice(RAW_SOURCES_PREFIX.length)
  }
  const markerIndex = spKey.indexOf(RAW_SOURCES_MARKER)
  if (markerIndex >= 0) {
    return sp.slice(markerIndex + RAW_SOURCES_MARKER.length)
  }
  return getFileName(sp)
}

export function sourceReferenceIdentity(sourceReference: string): string {
  const ref = normalizePath(sourceReference)
  const refKey = ref.toLowerCase()
  if (refKey.startsWith(RAW_SOURCES_PREFIX)) {
    return ref.slice(RAW_SOURCES_PREFIX.length)
  }
  const markerIndex = refKey.indexOf(RAW_SOURCES_MARKER)
  if (markerIndex >= 0) {
    return ref.slice(markerIndex + RAW_SOURCES_MARKER.length)
  }
  return ref
}

export function sourceSummarySlugFromIdentity(sourceIdentity: string): string {
  const previous = previousSourceSummarySlugFromIdentity(sourceIdentity)
  const encoder = new TextEncoder()
  if (encoder.encode(previous).length <= MAX_SOURCE_SUMMARY_SLUG_BYTES && !/[\uD800-\uDFFF]/u.test(previous)) {
    return previous
  }

  const suffix = `--${stableSlugHash(sourceIdentity)}`
  const readable = (previous.endsWith(suffix) ? previous.slice(0, -suffix.length) : previous)
    .replace(/[\uD800-\uDFFF]/gu, "")
  const prefixBudget = MAX_SOURCE_SUMMARY_SLUG_BYTES - encoder.encode(suffix).length
  let prefix = ""
  let bytes = 0
  // Iterate code points, rather than UTF-16 units, to avoid splitting a
  // surrogate pair at the truncation boundary.
  for (const character of readable) {
    const size = encoder.encode(character).length
    if (bytes + size > prefixBudget) break
    prefix += character
    bytes += size
  }
  return `${prefix.replace(/-+$/, "") || FALLBACK_SOURCE_PART}${suffix}`
}

function previousSourceSummarySlugFromIdentity(sourceIdentity: string): string {
  const withoutExt = sourceIdentity.replace(/\.[^/.]+$/, "")
  const parts = withoutExt
    .split("/")
    .map((part) => part.trim())
    .filter(Boolean)

  if (parts.length <= 1) {
    return parts[0] || "source"
  }

  const hash = stableSlugHash(sourceIdentity)
  const slug = parts.map((part) => {
    const { readable, structuralLength } = readableSlugPart(part)
    return `${structuralLength}-${readable}`
  }).join("--")
  const fullSlug = `${slug}--${hash}`
  if (fullSlug.length <= MAX_SOURCE_SUMMARY_SLUG_LENGTH) {
    return fullSlug
  }

  const readableLimit = MAX_SOURCE_SUMMARY_SLUG_LENGTH - hash.length - 2
  const readablePrefix = slug.slice(0, readableLimit).replace(/-+$/, "")
  return `${readablePrefix || "source"}--${hash}`
}

export function legacySourceSummarySlugFromIdentity(sourceIdentity: string): string {
  const withoutExt = sourceIdentity.replace(/\.[^/.]+$/, "")
  const parts = withoutExt
    .split("/")
    .map((part) => part.trim())
    .filter(Boolean)

  if (parts.length <= 1) {
    return parts[0] || "source"
  }

  const hash = stableSlugHash(sourceIdentity)
  const slug = parts.map((part) => {
    const encoded = encodeURIComponent(part)
    return `${encoded.length}-${encoded}`
  }).join("--")
  return `${slug}--${hash}`
}

export function sourceSummarySlugCandidatesFromIdentity(sourceIdentity: string): string[] {
  const canonical = sourceSummarySlugFromIdentity(sourceIdentity)
  const previous = previousSourceSummarySlugFromIdentity(sourceIdentity)
  const previousReadable = previousReadableSourceSummarySlugFromIdentity(sourceIdentity)
  const legacy = legacySourceSummarySlugFromIdentity(sourceIdentity)
  return Array.from(new Set([canonical, previous, previousReadable, legacy]))
}

function previousReadableSourceSummarySlugFromIdentity(sourceIdentity: string): string {
  const withoutExt = sourceIdentity.replace(/\.[^/.]+$/, "")
  const parts = withoutExt
    .split("/")
    .map((part) => part.trim())
    .filter(Boolean)

  if (parts.length <= 1) {
    return parts[0] || "source"
  }

  const hash = stableSlugHash(sourceIdentity)
  const slug = parts.map((part) => {
    const { readable } = readableSlugPart(part)
    return `${Array.from(readable).length}-${readable}`
  }).join("--")
  const fullSlug = `${slug}--${hash}`
  if (fullSlug.length <= MAX_SOURCE_SUMMARY_SLUG_LENGTH) {
    return fullSlug
  }

  const readableLimit = MAX_SOURCE_SUMMARY_SLUG_LENGTH - hash.length - 2
  const readablePrefix = slug.slice(0, readableLimit).replace(/-+$/, "")
  return `${readablePrefix || "source"}--${hash}`
}

function readableSlugPart(part: string): { readable: string; structuralLength: number } {
  const structural = part
    .normalize("NFKC")
    .trim()
    .replace(/\s+/g, "-")
    .replace(/[^\p{L}\p{N}-]/gu, "")
    .replace(/^-|-$/g, "")
    .toLowerCase()
  const readable = structural.replace(/-+/g, "-") || FALLBACK_SOURCE_PART
  return {
    readable,
    structuralLength: Math.max(1, Array.from(structural || FALLBACK_SOURCE_PART).length),
  }
}

function stableSlugHash(value: string): string {
  let hash = 0x811c9dc5
  for (let i = 0; i < value.length; i += 1) {
    hash ^= value.charCodeAt(i)
    hash = Math.imul(hash, 0x01000193)
  }
  return (hash >>> 0).toString(36)
}
