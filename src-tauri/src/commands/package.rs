//! `.llmwiki` import / export package commands.
//!
//! A `.llmwiki` file is a zip archive that bundles a project for
//! cross-device or team transfer:
//!
//! ```text
//! my-wiki.llmwiki
//! ├── manifest.json    schemaVersion + checksum manifest
//! ├── raw/             original sources (copied verbatim)
//! ├── wiki/            LLM-generated wiki pages
//! └── shared/          .llm-wiki/* state (ingest cache, review queue, …)
//! ```
//!
//! `.llm-wiki-local/` is intentionally NOT included — it holds per-user
//! private state (chat history) that must not be shared with teammates.

use std::fs::{self, File};
use std::io::{Read as IoRead, Write};
use std::path::{Path, PathBuf};

use chrono::Utc;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use walkdir::WalkDir;
use zip::write::FileOptions;
use zip::{CompressionMethod, ZipArchive, ZipWriter};

use crate::panic_guard::run_guarded;

const SCHEMA_VERSION: u32 = 1;
const MANIFEST_NAME: &str = "manifest.json";
const SHARED_DIR_NAME: &str = ".llm-wiki";

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PackageFileEntry {
    pub path: String,
    pub sha256: String,
    pub size: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(default)]
pub struct PackageIncludes {
    pub page_history: bool,
    pub embeddings: bool,
}

impl Default for PackageIncludes {
    fn default() -> Self {
        Self { page_history: false, embeddings: false }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PackageManifest {
    pub schema_version: u32,
    pub app_version: String,
    pub exported_at: String,
    pub exported_by: Option<String>,
    pub project_name: String,
    pub includes: PackageIncludes,
    pub files: Vec<PackageFileEntry>,
}

#[derive(Debug, Clone, Deserialize)]
pub struct ExportOptions {
    pub app_version: String,
    pub project_name: String,
    pub exported_by: Option<String>,
    #[serde(default)]
    pub includes: PackageIncludes,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum ConflictStrategy {
    /// Treat the package as a fresh project (do not overwrite).
    SkipExisting,
    /// Overwrite any existing files in the target directory.
    OverwriteAll,
}

#[derive(Debug, Clone, Deserialize)]
pub struct ImportOptions {
    pub conflict_strategy: ConflictStrategy,
}

#[derive(Debug, Clone, Serialize)]
pub struct ImportResult {
    pub manifest: PackageManifest,
    pub files_written: u32,
    pub files_skipped: u32,
    pub checksum_mismatches: Vec<String>,
}

#[tauri::command]
pub fn export_package(
    project_path: String,
    output_path: String,
    options: ExportOptions,
) -> Result<PackageManifest, String> {
    run_guarded("export_package", || export_package_impl(project_path, output_path, options))
}

fn export_package_impl(
    project_path: String,
    output_path: String,
    options: ExportOptions,
) -> Result<PackageManifest, String> {
    let root = PathBuf::from(&project_path);
    if !root.is_dir() {
        return Err(format!("Project path is not a directory: {}", root.display()));
    }
    let output = PathBuf::from(&output_path);
    if let Some(parent) = output.parent() {
        fs::create_dir_all(parent).map_err(|e| format!("Cannot create output dir: {e}"))?;
    }

    let file = File::create(&output).map_err(|e| format!("Cannot create {}: {e}", output.display()))?;
    let mut zip = ZipWriter::new(file);
    let opts: FileOptions<()> = FileOptions::default()
        .compression_method(CompressionMethod::Deflated)
        .unix_permissions(0o644);

    let mut entries: Vec<PackageFileEntry> = Vec::new();

    // raw/ and wiki/ — always included
    for top in ["raw", "wiki"] {
        let dir = root.join(top);
        if dir.is_dir() {
            add_dir_to_zip(&mut zip, &dir, &root, top, &opts, &mut entries)?;
        }
    }

    // .llm-wiki/ → shared/  (skip page-history if not requested)
    let shared = root.join(SHARED_DIR_NAME);
    if shared.is_dir() {
        for entry in WalkDir::new(&shared).into_iter().filter_map(Result::ok) {
            if !entry.file_type().is_file() {
                continue;
            }
            let rel = entry
                .path()
                .strip_prefix(&shared)
                .map_err(|e| format!("strip_prefix failed: {e}"))?;
            let rel_str = rel.to_string_lossy().replace('\\', "/");
            if !options.includes.page_history && rel_str.starts_with("page-history/") {
                continue;
            }
            // chats and conversations.json should be in .llm-wiki-local/ by
            // now, but defend in case migration hasn't run yet.
            if rel_str.starts_with("chats/") || rel_str == "conversations.json" {
                continue;
            }
            let arc_path = format!("shared/{rel_str}");
            write_file_to_zip(&mut zip, entry.path(), &arc_path, &opts, &mut entries)?;
        }
    }

    let manifest = PackageManifest {
        schema_version: SCHEMA_VERSION,
        app_version: options.app_version,
        exported_at: Utc::now().to_rfc3339(),
        exported_by: options.exported_by,
        project_name: options.project_name,
        includes: options.includes,
        files: entries,
    };

    let manifest_bytes = serde_json::to_vec_pretty(&manifest)
        .map_err(|e| format!("Cannot serialize manifest: {e}"))?;
    zip.start_file(MANIFEST_NAME, opts).map_err(|e| format!("zip start manifest: {e}"))?;
    zip.write_all(&manifest_bytes)
        .map_err(|e| format!("zip write manifest: {e}"))?;

    zip.finish().map_err(|e| format!("zip finish: {e}"))?;
    Ok(manifest)
}

fn add_dir_to_zip(
    zip: &mut ZipWriter<File>,
    dir: &Path,
    root: &Path,
    _top_label: &str,
    opts: &FileOptions<()>,
    entries: &mut Vec<PackageFileEntry>,
) -> Result<(), String> {
    for entry in WalkDir::new(dir).into_iter().filter_map(Result::ok) {
        if !entry.file_type().is_file() {
            continue;
        }
        let rel = entry
            .path()
            .strip_prefix(root)
            .map_err(|e| format!("strip_prefix failed: {e}"))?;
        let arc_path = rel.to_string_lossy().replace('\\', "/");
        write_file_to_zip(zip, entry.path(), &arc_path, opts, entries)?;
    }
    Ok(())
}

fn write_file_to_zip(
    zip: &mut ZipWriter<File>,
    src: &Path,
    arc_path: &str,
    opts: &FileOptions<()>,
    entries: &mut Vec<PackageFileEntry>,
) -> Result<(), String> {
    let bytes = fs::read(src).map_err(|e| format!("Cannot read {}: {e}", src.display()))?;
    let mut hasher = Sha256::new();
    hasher.update(&bytes);
    let digest = format!("{:x}", hasher.finalize());
    let size = bytes.len() as u64;

    zip.start_file(arc_path, *opts).map_err(|e| format!("zip start {arc_path}: {e}"))?;
    zip.write_all(&bytes).map_err(|e| format!("zip write {arc_path}: {e}"))?;

    entries.push(PackageFileEntry { path: arc_path.to_string(), sha256: digest, size });
    Ok(())
}

#[tauri::command]
pub fn inspect_package(package_path: String) -> Result<PackageManifest, String> {
    run_guarded("inspect_package", || inspect_package_impl(package_path))
}

fn inspect_package_impl(package_path: String) -> Result<PackageManifest, String> {
    let file = File::open(&package_path).map_err(|e| format!("Cannot open package: {e}"))?;
    let mut archive = ZipArchive::new(file).map_err(|e| format!("Invalid zip: {e}"))?;
    let mut mf = archive
        .by_name(MANIFEST_NAME)
        .map_err(|_| "Package missing manifest.json".to_string())?;
    let mut buf = String::new();
    mf.read_to_string(&mut buf).map_err(|e| format!("read manifest: {e}"))?;
    let manifest: PackageManifest =
        serde_json::from_str(&buf).map_err(|e| format!("parse manifest: {e}"))?;
    if manifest.schema_version != SCHEMA_VERSION {
        return Err(format!(
            "Unsupported package schema version {} (this build supports {})",
            manifest.schema_version, SCHEMA_VERSION
        ));
    }
    Ok(manifest)
}

#[tauri::command]
pub fn import_package(
    package_path: String,
    target_path: String,
    options: ImportOptions,
) -> Result<ImportResult, String> {
    run_guarded("import_package", || {
        import_package_impl(package_path, target_path, options)
    })
}

fn import_package_impl(
    package_path: String,
    target_path: String,
    options: ImportOptions,
) -> Result<ImportResult, String> {
    let manifest = inspect_package_impl(package_path.clone())?;
    let target = PathBuf::from(&target_path);
    fs::create_dir_all(&target).map_err(|e| format!("Cannot create target: {e}"))?;

    let file = File::open(&package_path).map_err(|e| format!("Cannot open package: {e}"))?;
    let mut archive = ZipArchive::new(file).map_err(|e| format!("Invalid zip: {e}"))?;

    let mut written = 0u32;
    let mut skipped = 0u32;
    let mut mismatches: Vec<String> = Vec::new();
    let manifest_by_path: std::collections::HashMap<&str, &PackageFileEntry> =
        manifest.files.iter().map(|e| (e.path.as_str(), e)).collect();

    for i in 0..archive.len() {
        let mut entry = archive.by_index(i).map_err(|e| format!("read entry {i}: {e}"))?;
        let name = entry.name().to_string();
        if name == MANIFEST_NAME || name.ends_with('/') {
            continue;
        }
        let on_disk_path = unmap_archive_path(&target, &name);

        if on_disk_path.exists() {
            match options.conflict_strategy {
                ConflictStrategy::SkipExisting => {
                    skipped += 1;
                    continue;
                }
                ConflictStrategy::OverwriteAll => {}
            }
        }

        if let Some(parent) = on_disk_path.parent() {
            fs::create_dir_all(parent).map_err(|e| format!("create parent: {e}"))?;
        }

        let mut bytes: Vec<u8> = Vec::with_capacity(entry.size() as usize);
        entry.read_to_end(&mut bytes).map_err(|e| format!("read {name}: {e}"))?;

        if let Some(expected) = manifest_by_path.get(name.as_str()) {
            let mut hasher = Sha256::new();
            hasher.update(&bytes);
            let actual = format!("{:x}", hasher.finalize());
            if actual != expected.sha256 {
                mismatches.push(name.clone());
                // still write — caller decides what to do with mismatches
            }
        }

        fs::write(&on_disk_path, &bytes).map_err(|e| format!("write {}: {e}", on_disk_path.display()))?;
        written += 1;
    }

    Ok(ImportResult {
        manifest,
        files_written: written,
        files_skipped: skipped,
        checksum_mismatches: mismatches,
    })
}

/// `shared/foo.json` (the convention inside the archive) becomes
/// `.llm-wiki/foo.json` on disk. Other top-level dirs (`raw/`, `wiki/`)
/// are written as-is.
fn unmap_archive_path(target: &Path, arc_name: &str) -> PathBuf {
    if let Some(rest) = arc_name.strip_prefix("shared/") {
        target.join(SHARED_DIR_NAME).join(rest)
    } else {
        target.join(arc_name)
    }
}
