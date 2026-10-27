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

use std::collections::HashSet;
use std::fs::{self, File};
use std::io::{Read as IoRead, Write};
use std::path::{Path, PathBuf};

use chrono::Utc;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use unicase::UniCase;
use unicode_normalization::UnicodeNormalization;
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
        Self {
            page_history: false,
            embeddings: false,
        }
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
    run_guarded("export_package", || {
        export_package_impl(project_path, output_path, options)
    })
}

fn export_package_impl(
    project_path: String,
    output_path: String,
    options: ExportOptions,
) -> Result<PackageManifest, String> {
    let root = PathBuf::from(&project_path);
    if !root.is_dir() {
        return Err(format!(
            "Project path is not a directory: {}",
            root.display()
        ));
    }
    if !root.join("schema.md").is_file() {
        return Err("Cannot export project: missing schema.md".into());
    }
    let output = PathBuf::from(&output_path);
    if let Some(parent) = output.parent() {
        fs::create_dir_all(parent).map_err(|e| format!("Cannot create output dir: {e}"))?;
    }

    let file =
        File::create(&output).map_err(|e| format!("Cannot create {}: {e}", output.display()))?;
    let mut zip = ZipWriter::new(file);
    let opts: FileOptions<()> = FileOptions::default()
        .compression_method(CompressionMethod::Deflated)
        .unix_permissions(0o644);

    let mut entries: Vec<PackageFileEntry> = Vec::new();

    // Project definitions must survive a fresh-directory roundtrip.
    for name in ["schema.md", "purpose.md"] {
        let path = root.join(name);
        if path.is_file() {
            write_file_to_zip(&mut zip, &path, name, &opts, &mut entries)?;
        }
    }

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
    zip.start_file(MANIFEST_NAME, opts)
        .map_err(|e| format!("zip start manifest: {e}"))?;
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

    zip.start_file(arc_path, *opts)
        .map_err(|e| format!("zip start {arc_path}: {e}"))?;
    zip.write_all(&bytes)
        .map_err(|e| format!("zip write {arc_path}: {e}"))?;

    entries.push(PackageFileEntry {
        path: arc_path.to_string(),
        sha256: digest,
        size,
    });
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
    mf.read_to_string(&mut buf)
        .map_err(|e| format!("read manifest: {e}"))?;
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

    let target = fs::canonicalize(&target).map_err(|e| format!("resolve target: {e}"))?;
    let mut destinations = HashSet::new();
    let mut manifest_names = HashSet::new();
    for expected in &manifest.files {
        validate_archive_name(&expected.path, false)?;
        if !manifest_names.insert(expected.path.clone()) {
            return Err(format!("Duplicate manifest entry: {}", expected.path));
        }
    }
    let manifest_by_path: std::collections::HashMap<&str, &PackageFileEntry> = manifest
        .files
        .iter()
        .map(|e| (e.path.as_str(), e))
        .collect();
    let staging = ImportStaging::new()?;
    let mut planned = Vec::new();
    let mut seen_files = HashSet::new();
    let mut manifest_count = 0;

    // Preflight and stage ALL bytes before touching any destination file,
    // including files that SkipExisting would skip. A later bad entry must
    // never leave an earlier valid entry partially imported.
    for i in 0..archive.len() {
        let mut entry = archive
            .by_index(i)
            .map_err(|e| format!("read entry {i}: {e}"))?;
        let name = entry.name().to_string();
        if name == MANIFEST_NAME {
            manifest_count += 1;
            continue;
        }
        let directory = entry.is_dir();
        validate_archive_name(&name, directory)?;
        if entry
            .unix_mode()
            .is_some_and(|mode| mode & 0o170000 == 0o120000)
        {
            return Err(format!("Symlink archive entry is not allowed: {name}"));
        }
        let destination = unmap_archive_path(&target, name.trim_end_matches('/'));
        check_import_destination(&target, &destination)?;
        if directory {
            continue;
        }
        // Case folding also prevents collisions when a package moves from a
        // case-sensitive filesystem to Windows or a default macOS volume.
        if !destinations.insert(import_path_key(&destination)) {
            return Err(format!("Duplicate package destination: {name}"));
        }
        let expected = manifest_by_path
            .get(name.as_str())
            .ok_or_else(|| format!("Unlisted package entry: {name}"))?;
        if expected.size != entry.size() {
            return Err(format!("Size mismatch: {name}"));
        }
        seen_files.insert(name.clone());
        let staged = staging.0.join(i.to_string());
        let mut output = File::create(&staged).map_err(|e| format!("stage {name}: {e}"))?;
        let mut hash = Sha256::new();
        let mut size = 0u64;
        let mut buffer = [0u8; 65536];
        loop {
            let n = entry
                .read(&mut buffer)
                .map_err(|e| format!("read {name}: {e}"))?;
            if n == 0 {
                break;
            }
            size += n as u64;
            if size > expected.size {
                return Err(format!("Size mismatch: {name}"));
            }
            hash.update(&buffer[..n]);
            output
                .write_all(&buffer[..n])
                .map_err(|e| format!("stage {name}: {e}"))?;
        }
        if size != expected.size || format!("{:x}", hash.finalize()) != expected.sha256 {
            return Err(format!("Checksum or size mismatch: {name}"));
        }
        planned.push((destination, staged));
    }
    if manifest_count != 1 || seen_files != manifest_names {
        return Err("Package manifest does not match archive contents".into());
    }
    if !seen_files.contains("schema.md") && !target.join("schema.md").is_file() {
        return Err("This older package has no schema.md. Create a project first and import into that project, or re-export with LLM Wiki 0.8.1 or newer.".into());
    }
    // Reject file/directory conflicts before committing any payload.
    for (destination, _) in &planned {
        if destination.is_dir()
            || destination
                .ancestors()
                .skip(1)
                .take_while(|parent| parent.starts_with(&target))
                .any(|parent| destinations.contains(&import_path_key(parent)))
        {
            return Err(format!(
                "Conflicting package destination: {}",
                destination.display()
            ));
        }
    }

    let mut written = 0u32;
    let mut skipped = 0u32;
    for (destination, staged) in planned {
        check_import_destination(&target, &destination)?;
        if destination.exists()
            && matches!(options.conflict_strategy, ConflictStrategy::SkipExisting)
        {
            skipped += 1;
            continue;
        }
        if let Some(parent) = destination.parent() {
            fs::create_dir_all(parent).map_err(|e| format!("create parent: {e}"))?;
        }
        check_import_destination(&target, &destination)?;
        // Copy into the same filesystem, then atomically replace the final
        // file. A failed copy must not truncate the user's existing page.
        let temporary =
            destination.with_file_name(format!(".llmwiki-import-{}.tmp", uuid::Uuid::new_v4()));
        let result =
            fs::copy(&staged, &temporary).and_then(|_| fs::rename(&temporary, &destination));
        if let Err(error) = result {
            let _ = fs::remove_file(&temporary);
            return Err(format!("write {}: {error}", destination.display()));
        }
        written += 1;
    }
    fs::create_dir_all(target.join("wiki")).map_err(|e| format!("create wiki: {e}"))?;
    Ok(ImportResult {
        manifest,
        files_written: written,
        files_skipped: skipped,
        checksum_mismatches: Vec::new(),
    })
}

/// ZIP names use forward slashes on every host. Reject Windows special
/// paths even on Unix so a package has the same interpretation everywhere.
fn validate_archive_name(name: &str, directory: bool) -> Result<(), String> {
    let clean = if directory {
        name.strip_suffix('/').unwrap_or(name)
    } else {
        name
    };
    let parts: Vec<_> = clean.split('/').collect();
    let invalid_component = parts.iter().any(|part| {
        let stem = part.split('.').next().unwrap_or("").to_ascii_uppercase();
        part.is_empty()
            || *part == "."
            || *part == ".."
            || part.ends_with(['.', ' '])
            || part
                .chars()
                .any(|c| c.is_control() || "\\:<>\"|?*".contains(c))
            || matches!(stem.as_str(), "CON" | "PRN" | "AUX" | "NUL")
            || (stem.len() == 4
                && (stem.starts_with("COM") || stem.starts_with("LPT"))
                && matches!(stem.as_bytes()[3], b'1'..=b'9'))
    });
    let allowed = if directory {
        matches!(parts[0], "raw" | "wiki" | "shared")
    } else {
        matches!(clean, "schema.md" | "purpose.md")
            || (parts.len() > 1 && matches!(parts[0], "raw" | "wiki" | "shared"))
    };
    if invalid_component || !allowed {
        return Err(format!("Unsafe package entry: {name}"));
    }
    if parts[0] == "shared"
        && parts.get(1).is_some_and(|part| {
            part.eq_ignore_ascii_case("chats") || part.eq_ignore_ascii_case("conversations.json")
        })
    {
        return Err(format!(
            "Private chat data is not allowed in a package: {name}"
        ));
    }
    Ok(())
}

// Compare components consistently for duplicate AND ancestor conflicts.
// NFC preserves canonical equivalence, and UniCase handles full Unicode
// case folding (including characters such as sharp S), on every host.
fn import_path_key(path: &Path) -> Vec<UniCase<String>> {
    path.components()
        .map(|part| UniCase::new(part.as_os_str().to_string_lossy().nfc().collect()))
        .collect()
}

fn check_import_destination(target: &Path, destination: &Path) -> Result<(), String> {
    let relative = destination
        .strip_prefix(target)
        .map_err(|_| "Import path escapes target")?;
    let mut path = target.to_path_buf();
    for component in relative.components() {
        path.push(component);
        match fs::symlink_metadata(&path) {
            Ok(meta) if meta.file_type().is_symlink() => {
                return Err(format!("Symlink import destination: {}", path.display()))
            }
            Ok(meta) if path != destination && !meta.is_dir() => {
                return Err(format!(
                    "Import parent is not a directory: {}",
                    path.display()
                ))
            }
            Ok(_) => {}
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
            Err(e) => return Err(format!("inspect destination {}: {e}", path.display())),
        }
    }
    Ok(())
}

struct ImportStaging(PathBuf);
impl ImportStaging {
    fn new() -> Result<Self, String> {
        let path = std::env::temp_dir().join(format!("llmwiki-import-{}", uuid::Uuid::new_v4()));
        let mut builder = fs::DirBuilder::new();
        #[cfg(unix)]
        {
            use std::os::unix::fs::DirBuilderExt;
            builder.mode(0o700);
        }
        builder
            .create(&path)
            .map_err(|e| format!("create staging directory: {e}"))?;
        Ok(Self(path))
    }
}
impl Drop for ImportStaging {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.0);
    }
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

#[cfg(test)]
mod tests {
    use super::*;

    struct Sandbox(PathBuf);
    impl Sandbox {
        fn new() -> Self {
            let root =
                std::env::temp_dir().join(format!("llmwiki-package-{}", uuid::Uuid::new_v4()));
            fs::create_dir_all(&root).unwrap();
            Self(root)
        }
        fn path(&self, name: &str) -> String {
            self.0.join(name).to_string_lossy().into_owned()
        }
    }
    impl Drop for Sandbox {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }
    fn fixture(s: &Sandbox, files: &[(&str, &[u8])], listed: bool) -> String {
        let path = s.path("input.llmwiki");
        let mut zip = ZipWriter::new(File::create(&path).unwrap());
        let opts = FileOptions::<()>::default();
        let entries = files
            .iter()
            .map(|(name, data)| {
                zip.start_file(*name, opts).unwrap();
                zip.write_all(data).unwrap();
                PackageFileEntry {
                    path: name.to_string(),
                    sha256: format!("{:x}", Sha256::digest(data)),
                    size: data.len() as u64,
                }
            })
            .collect();
        let manifest = PackageManifest {
            schema_version: 1,
            app_version: "0.8.0".into(),
            exported_at: "2026-10-26".into(),
            exported_by: None,
            project_name: "test".into(),
            includes: PackageIncludes::default(),
            files: if listed { entries } else { vec![] },
        };
        zip.start_file(MANIFEST_NAME, opts).unwrap();
        zip.write_all(&serde_json::to_vec(&manifest).unwrap())
            .unwrap();
        zip.finish().unwrap();
        path
    }
    fn import(pkg: String, target: String) -> Result<ImportResult, String> {
        import_package_impl(
            pkg,
            target,
            ImportOptions {
                conflict_strategy: ConflictStrategy::OverwriteAll,
            },
        )
    }
    #[test]
    fn rejects_unsafe_names_before_writing_any_file() {
        for name in [
            "../outside.md",
            "shared/../../outside.md",
            "/tmp/llmwiki-escape.md",
            "C:/escape.md",
            "wiki/../escape.md",
            "wiki\\escape.md",
            "wiki/a:stream",
            ".llm-wiki-local/chats/a.json",
        ] {
            let s = Sandbox::new();
            let pkg = fixture(
                &s,
                &[
                    ("schema.md", b"schema"),
                    ("wiki/valid.md", b"valid"),
                    (name, b"bad"),
                ],
                true,
            );
            assert!(import(pkg, s.path("out")).is_err(), "accepted {name}");
            assert!(
                !s.0.join("out/wiki/valid.md").exists(),
                "partial import for {name}"
            );
            assert!(!s.0.join("outside.md").exists());
        }
    }
    #[test]
    fn rejects_unlisted_files_before_overwrite() {
        let s = Sandbox::new();
        fs::create_dir_all(s.0.join("out/wiki")).unwrap();
        fs::write(s.0.join("out/schema.md"), "schema").unwrap();
        fs::write(s.0.join("out/wiki/page.md"), "original").unwrap();
        let pkg = fixture(&s, &[("wiki/page.md", b"replacement")], false);
        assert!(import(pkg, s.path("out")).is_err());
        assert_eq!(
            fs::read_to_string(s.0.join("out/wiki/page.md")).unwrap(),
            "original"
        );
    }
    #[test]
    fn rejects_checksum_mismatch_before_overwrite() {
        let s = Sandbox::new();
        let pkg = fixture(
            &s,
            &[("schema.md", b"schema"), ("wiki/page.md", b"new")],
            true,
        );
        // Rebuild the zip with its manifest checksum deliberately wrong.
        let mut manifest = inspect_package_impl(pkg.clone()).unwrap();
        manifest.files[1].sha256 = "00".repeat(32);
        let mut zip = ZipWriter::new(File::create(&pkg).unwrap());
        let opts = FileOptions::<()>::default();
        for (name, data) in [("schema.md", "schema"), ("wiki/page.md", "new")] {
            zip.start_file(name, opts).unwrap();
            zip.write_all(data.as_bytes()).unwrap();
        }
        zip.start_file(MANIFEST_NAME, opts).unwrap();
        zip.write_all(&serde_json::to_vec(&manifest).unwrap())
            .unwrap();
        zip.finish().unwrap();
        fs::create_dir_all(s.0.join("out/wiki")).unwrap();
        fs::write(s.0.join("out/wiki/page.md"), "original").unwrap();
        assert!(import(pkg, s.path("out")).is_err());
        assert_eq!(
            fs::read_to_string(s.0.join("out/wiki/page.md")).unwrap(),
            "original"
        );
    }
    #[cfg(unix)]
    #[test]
    fn rejects_existing_symlink_destination() {
        let s = Sandbox::new();
        fs::create_dir_all(s.0.join("out")).unwrap();
        fs::create_dir_all(s.0.join("elsewhere")).unwrap();
        std::os::unix::fs::symlink(s.0.join("elsewhere"), s.0.join("out/wiki")).unwrap();
        let pkg = fixture(
            &s,
            &[("schema.md", b"schema"), ("wiki/page.md", b"bad")],
            true,
        );
        assert!(import(pkg, s.path("out")).is_err());
        assert!(!s.0.join("elsewhere/page.md").exists());
    }
    #[test]
    fn roundtrip_preserves_project_definition_and_privacy() {
        let s = Sandbox::new();
        fs::create_dir_all(s.0.join("project/wiki")).unwrap();
        fs::create_dir_all(s.0.join("project/.llm-wiki-local/chats")).unwrap();
        for (name, text) in [
            ("schema.md", "custom schema"),
            ("purpose.md", "custom purpose"),
            ("wiki/page.md", "knowledge"),
            (".llm-wiki-local/chats/private.json", "secret"),
        ] {
            fs::write(s.0.join("project").join(name), text).unwrap();
        }
        export_package_impl(
            s.path("project"),
            s.path("export.llmwiki"),
            ExportOptions {
                app_version: "0.8.1".into(),
                project_name: "test".into(),
                exported_by: None,
                includes: PackageIncludes::default(),
            },
        )
        .unwrap();
        import(s.path("export.llmwiki"), s.path("restored")).unwrap();
        assert_eq!(
            fs::read_to_string(s.0.join("restored/schema.md")).unwrap(),
            "custom schema"
        );
        assert_eq!(
            fs::read_to_string(s.0.join("restored/purpose.md")).unwrap(),
            "custom purpose"
        );
        assert_eq!(
            fs::read_to_string(s.0.join("restored/wiki/page.md")).unwrap(),
            "knowledge"
        );
        assert!(!s.0.join("restored/.llm-wiki-local").exists());
    }
    #[test]
    fn rejects_case_and_unicode_destination_aliases_before_any_write() {
        for (first, second) in [
            ("wiki/Foo", "wiki/foo/bar.md"),
            ("wiki/café.md", "wiki/cafe\u{301}.md"),
        ] {
            let s = Sandbox::new();
            fs::create_dir_all(s.0.join("out")).unwrap();
            fs::write(s.0.join("out/schema.md"), "original schema").unwrap();
            let pkg = fixture(
                &s,
                &[
                    ("schema.md", b"replacement"),
                    (first, b"one"),
                    (second, b"two"),
                ],
                true,
            );
            assert!(import(pkg, s.path("out")).is_err());
            assert_eq!(
                fs::read_to_string(s.0.join("out/schema.md")).unwrap(),
                "original schema"
            );
            assert!(!s.0.join("out").join(first).exists());
        }
    }

    #[test]
    fn legacy_package_requires_existing_schema() {
        let s = Sandbox::new();
        let pkg = fixture(&s, &[("wiki/page.md", b"knowledge")], true);
        let error = import(pkg.clone(), s.path("out")).unwrap_err();
        assert!(error.contains("schema.md"));
        assert!(!s.0.join("out/wiki/page.md").exists());
        fs::create_dir_all(s.0.join("out")).unwrap();
        fs::write(s.0.join("out/schema.md"), "local schema").unwrap();
        import(pkg, s.path("out")).unwrap();
        assert_eq!(
            fs::read_to_string(s.0.join("out/schema.md")).unwrap(),
            "local schema"
        );
    }
}
