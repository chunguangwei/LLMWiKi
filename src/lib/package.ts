import { invoke } from "@tauri-apps/api/core"
import type {
  ExportOptions,
  ImportOptions,
  ImportResult,
  PackageManifest,
} from "./package-manifest"

export async function exportPackage(
  projectPath: string,
  outputPath: string,
  options: ExportOptions,
): Promise<PackageManifest> {
  return invoke<PackageManifest>("export_package", {
    projectPath,
    outputPath,
    options,
  })
}

export async function importPackage(
  packagePath: string,
  targetPath: string,
  options: ImportOptions,
): Promise<ImportResult> {
  return invoke<ImportResult>("import_package", {
    packagePath,
    targetPath,
    options,
  })
}

export async function inspectPackage(packagePath: string): Promise<PackageManifest> {
  return invoke<PackageManifest>("inspect_package", { packagePath })
}

/** Suggested file name based on project and date — `<slug>-<YYYYMMDD>.llmwiki`. */
export function suggestPackageFileName(projectName: string): string {
  const slug = projectName
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/(^-|-$)/g, "")
    .slice(0, 40) || "wiki"
  const now = new Date()
  const y = now.getFullYear()
  const m = String(now.getMonth() + 1).padStart(2, "0")
  const d = String(now.getDate()).padStart(2, "0")
  return `${slug}-${y}${m}${d}.llmwiki`
}
