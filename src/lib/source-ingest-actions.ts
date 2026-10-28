import type { FileNode } from "@/types/wiki"
import { isIngestableSourcePath } from "@/lib/source-lifecycle"
import { isSensitiveConfigSourceFile } from "@/lib/source-filter"

export type SourceIngestActionStatus =
  | "not-ingested"
  | "ingested"
  | "pending"
  | "processing"
  | "done"
  | "failed"
  | "cancelled"

/** Return eligible sources that are not complete or already being processed. */
export function findSourcesAwaitingIngest(
  nodes: readonly FileNode[],
  statuses: ReadonlyMap<string, SourceIngestActionStatus>,
): string[] {
  const paths: string[] = []
  const visit = (node: FileNode) => {
    if (node.is_dir) {
      node.children?.forEach(visit)
      return
    }
    if (!isIngestableSourcePath(node.path) || isSensitiveConfigSourceFile(node.path)) return
    const status = statuses.get(node.path) ?? "not-ingested"
    if (status === "not-ingested" || status === "failed" || status === "cancelled") {
      paths.push(node.path)
    }
  }
  nodes.forEach(visit)
  return paths
}
