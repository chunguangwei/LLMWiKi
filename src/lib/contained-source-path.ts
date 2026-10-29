import { getRelativePath, isAbsolutePath, normalizePath } from "@/lib/path-utils"

/** Resolve legacy project-relative paths, rejecting foreign or traversal paths.
 * This is a lexical guard against stale project state, not a symlink sandbox.
 */
export function resolveContainedSourcePath(root: string, path: string): string {
  const base = normalizePath(root).replace(/\/+$/, "")
  const normalized = normalizePath(path)
  const absolute = isAbsolutePath(normalized) ? normalized : base + "/" + normalized
  const relative = getRelativePath(absolute, base)
  if (!isAbsolutePath(root) || relative === absolute || !relative ||
      relative.split("/").some((part) => part === "." || part === ".." || !part)) {
    throw Object.assign(new Error("Source path is outside the project directory: " + path), { nonRetryable: true })
  }
  return absolute
}
