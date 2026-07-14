use std::fs;
use std::path::{Path, PathBuf};
use std::sync::Mutex;

use chrono::Utc;
use serde::{Deserialize, Serialize};
use uuid::Uuid;

const MAX_HISTORY_CONTENT_BYTES: usize = 512 * 1024;
const MAX_ENTRIES_PER_FILE: usize = 30;
static HISTORY_LOCK: Mutex<()> = Mutex::new(());

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FileHistoryEntry {
    pub id: String,
    pub path: String,
    pub timestamp: i64,
    pub author: String,
    pub tool: String,
    pub content: String,
}

/// Return provenance only, never historical content, for Agent retrieval
/// briefings. Reading the same bounded store as the timeline keeps attribution
/// consistent without expanding prompt size or exposing rollback snapshots.
pub fn latest_file_version(path: &Path) -> Option<(i64, String, String)> {
    let root = project_root_for(path)?;
    let _guard = HISTORY_LOCK.lock().ok()?;
    let raw = fs::read_to_string(history_path(&root, path)).ok()?;
    let entries: Vec<FileHistoryEntry> = serde_json::from_str(&raw).ok()?;
    entries
        .last()
        .map(|entry| (entry.timestamp, entry.author.clone(), entry.tool.clone()))
}

fn project_root_for(path: &Path) -> Option<PathBuf> {
    let mut cursor = path.parent();
    while let Some(dir) = cursor {
        if dir.join(".llm-wiki").is_dir() {
            return Some(dir.to_path_buf());
        }
        cursor = dir.parent();
    }
    None
}

fn history_path(root: &Path, path: &Path) -> PathBuf {
    let relative = path.strip_prefix(root).unwrap_or(path).to_string_lossy();
    // Fixed FNV-1a keeps history addresses stable across Rust/toolchain upgrades.
    let mut hash = 0xcbf29ce484222325_u64;
    for byte in relative.as_bytes() {
        hash ^= u64::from(*byte);
        hash = hash.wrapping_mul(0x100000001b3);
    }
    let key = format!("{hash:016x}");
    root.join(".llm-wiki/history").join(format!("{key}.json"))
}

pub fn record_file_version(path: &Path, author: &str, tool: &str) {
    let Ok(metadata) = fs::metadata(path) else {
        return;
    };
    if !metadata.is_file() || metadata.len() as usize > MAX_HISTORY_CONTENT_BYTES {
        return;
    }
    let Ok(content) = fs::read_to_string(path) else {
        return;
    };
    let Some(root) = project_root_for(path) else {
        return;
    };
    if path.starts_with(root.join(".llm-wiki")) {
        return;
    }
    let Ok(_guard) = HISTORY_LOCK.lock() else {
        return;
    };
    let store_path = history_path(&root, path);
    let mut entries: Vec<FileHistoryEntry> = fs::read_to_string(&store_path)
        .ok()
        .and_then(|raw| serde_json::from_str(&raw).ok())
        .unwrap_or_default();
    if entries.last().is_some_and(|entry| entry.content == content) {
        return;
    }
    entries.push(FileHistoryEntry {
        id: Uuid::new_v4().to_string(),
        path: path.to_string_lossy().replace('\\', "/"),
        timestamp: Utc::now().timestamp_millis(),
        author: author.to_string(),
        tool: tool.to_string(),
        content,
    });
    if entries.len() > MAX_ENTRIES_PER_FILE {
        entries.drain(..entries.len() - MAX_ENTRIES_PER_FILE);
    }
    if let Some(parent) = store_path.parent() {
        let _ = fs::create_dir_all(parent);
    }
    if let Ok(raw) = serde_json::to_string(&entries) {
        let _ = fs::write(store_path, raw);
    }
}

fn checked_file(project_path: &str, file_path: &str) -> Result<(PathBuf, PathBuf), String> {
    let root = Path::new(project_path)
        .canonicalize()
        .map_err(|e| e.to_string())?;
    let file = Path::new(file_path)
        .canonicalize()
        .map_err(|e| e.to_string())?;
    if !file.starts_with(&root) || file.starts_with(root.join(".llm-wiki")) {
        return Err("History path must stay inside the project".to_string());
    }
    Ok((root, file))
}

#[tauri::command]
pub async fn list_file_history(
    project_path: String,
    file_path: String,
) -> Result<Vec<FileHistoryEntry>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let (root, file) = checked_file(&project_path, &file_path)?;
        let raw =
            fs::read_to_string(history_path(&root, &file)).unwrap_or_else(|_| "[]".to_string());
        let mut entries: Vec<FileHistoryEntry> = serde_json::from_str(&raw).unwrap_or_default();
        entries.reverse();
        Ok(entries)
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn restore_file_history(
    project_path: String,
    file_path: String,
    entry_id: String,
) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let (root, file) = checked_file(&project_path, &file_path)?;
        let raw = fs::read_to_string(history_path(&root, &file)).map_err(|e| e.to_string())?;
        let entries: Vec<FileHistoryEntry> =
            serde_json::from_str(&raw).map_err(|e| e.to_string())?;
        let entry = entries
            .into_iter()
            .find(|entry| entry.id == entry_id)
            .ok_or_else(|| "History entry not found".to_string())?;
        fs::write(&file, &entry.content).map_err(|e| e.to_string())?;
        record_file_version(&file, "human", "history.restore");
        Ok(entry.content)
    })
    .await
    .map_err(|e| e.to_string())?
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn records_and_restores_append_only_versions() {
        let root = std::env::temp_dir().join(format!("llm-wiki-history-{}", Uuid::new_v4()));
        fs::create_dir_all(root.join(".llm-wiki")).unwrap();
        fs::create_dir_all(root.join("wiki")).unwrap();
        let file = root.join("wiki/page.md");
        fs::write(&file, "before").unwrap();
        record_file_version(&file, "baseline", "before.test");
        fs::write(&file, "after").unwrap();
        record_file_version(&file, "agent", "test.write");

        let entries = list_file_history(
            root.to_string_lossy().into_owned(),
            file.to_string_lossy().into_owned(),
        )
        .await
        .unwrap();
        assert_eq!(entries.len(), 2);
        let old = entries
            .iter()
            .find(|entry| entry.content == "before")
            .unwrap();
        restore_file_history(
            root.to_string_lossy().into_owned(),
            file.to_string_lossy().into_owned(),
            old.id.clone(),
        )
        .await
        .unwrap();
        assert_eq!(fs::read_to_string(&file).unwrap(), "before");
        let restored = list_file_history(
            root.to_string_lossy().into_owned(),
            file.to_string_lossy().into_owned(),
        )
        .await
        .unwrap();
        assert_eq!(restored.first().unwrap().tool, "history.restore");
        let _ = fs::remove_dir_all(root);
    }
}
