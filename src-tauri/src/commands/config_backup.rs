//! Encrypted auto-backup of the config store, for same-machine
//! reinstall recovery.
//!
//! Why: all config + API keys live in `app-state.json` under the OS
//! app-data dir. A normal uninstall leaves that file in place, but a
//! deep-cleaning uninstaller (AppCleaner et al.) removes it, losing the
//! user's keys. To survive that, on every launch we write an encrypted
//! copy to a STABLE path outside app-data (~/Documents/LLMWiki/), and on
//! a fresh/empty launch we auto-restore from it.
//!
//! Key handling: the backup is encrypted with a random 256-bit key kept
//! in the OS keychain (macOS Keychain / Windows Credential Manager /
//! Linux Secret Service via keyring). The keychain survives an app-data
//! wipe, so restore works; and because the key is random + keychain-held
//! (never in the binary), decompiling the app reveals nothing.
//!
//! Scope: this path is for SAME-machine recovery only (the keychain key
//! is machine-local). Cross-machine migration uses the passphrase-based
//! export/import in config_crypto.rs.
//!
//! Backup file layout: magic "LWAB1" (5) | nonce (12) | ciphertext+tag.

use crate::commands::config_crypto::{aead_decrypt, aead_encrypt};
use base64::{engine::general_purpose::STANDARD as B64, Engine};
use keyring::Entry;
use rand::RngCore;
use tauri::Manager;
use zeroize::Zeroize;

const KEYRING_SERVICE: &str = "com.llmwiki.app";
const KEYRING_USER: &str = "config-backup-key";
const MAGIC_AB: &[u8; 5] = b"LWAB1";
const KEY_LEN: usize = 32;

fn keyring_entry() -> Result<Entry, String> {
    Entry::new(KEYRING_SERVICE, KEYRING_USER).map_err(|e| format!("keyring unavailable: {e}"))
}

/// Fetch the backup data key from the keychain, creating + storing a
/// fresh random one on first use.
fn get_or_create_key() -> Result<[u8; KEY_LEN], String> {
    let entry = keyring_entry()?;
    match entry.get_password() {
        Ok(b64) => {
            let bytes = B64
                .decode(b64.as_bytes())
                .map_err(|e| format!("corrupt keyring entry: {e}"))?;
            if bytes.len() != KEY_LEN {
                return Err("keyring key has wrong length".into());
            }
            let mut k = [0u8; KEY_LEN];
            k.copy_from_slice(&bytes);
            Ok(k)
        }
        Err(keyring::Error::NoEntry) => {
            let mut k = [0u8; KEY_LEN];
            rand::thread_rng().fill_bytes(&mut k);
            entry
                .set_password(&B64.encode(k))
                .map_err(|e| format!("could not store keyring key: {e}"))?;
            Ok(k)
        }
        Err(e) => Err(format!("keyring read failed: {e}")),
    }
}

/// Read the existing key without creating one (restore path).
fn get_existing_key() -> Result<Option<[u8; KEY_LEN]>, String> {
    let entry = keyring_entry()?;
    match entry.get_password() {
        Ok(b64) => {
            let bytes = B64
                .decode(b64.as_bytes())
                .map_err(|e| format!("corrupt keyring entry: {e}"))?;
            if bytes.len() != KEY_LEN {
                return Ok(None);
            }
            let mut k = [0u8; KEY_LEN];
            k.copy_from_slice(&bytes);
            Ok(Some(k))
        }
        Err(keyring::Error::NoEntry) => Ok(None),
        Err(e) => Err(format!("keyring read failed: {e}")),
    }
}

fn app_state_path(app: &tauri::AppHandle) -> Result<std::path::PathBuf, String> {
    let dir = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("could not resolve app data dir: {e}"))?;
    Ok(dir.join("app-state.json"))
}

fn backup_path(app: &tauri::AppHandle) -> Result<std::path::PathBuf, String> {
    let docs = app
        .path()
        .document_dir()
        .map_err(|e| format!("could not resolve documents dir: {e}"))?;
    Ok(docs.join("LLMWiki").join("config-backup.enc"))
}

/// Whether the live config store already holds usable config (so we
/// must NOT clobber it with a restore).
fn has_usable_config(app: &tauri::AppHandle) -> bool {
    let Ok(path) = app_state_path(app) else {
        return false;
    };
    let Ok(s) = std::fs::read_to_string(&path) else {
        return false;
    };
    match serde_json::from_str::<serde_json::Value>(&s) {
        Ok(v) => v.get("llmConfig").is_some() || v.get("providerConfigs").is_some(),
        Err(_) => false,
    }
}

/// Encrypt the current config store and write it to the stable backup
/// path. No-op (Ok) when there's nothing meaningful to back up.
pub fn auto_backup(app: &tauri::AppHandle) -> Result<(), String> {
    let src = app_state_path(app)?;
    let plaintext = match std::fs::read_to_string(&src) {
        Ok(s) => s,
        Err(_) => return Ok(()), // no store yet
    };
    let trimmed = plaintext.trim();
    if trimmed.is_empty() || trimmed == "{}" {
        return Ok(());
    }
    let mut key = get_or_create_key()?;
    let body = aead_encrypt(&key, plaintext.as_bytes());
    key.zeroize();
    let body = body?;
    let mut out = Vec::with_capacity(MAGIC_AB.len() + body.len());
    out.extend_from_slice(MAGIC_AB);
    out.extend_from_slice(&body);
    let dst = backup_path(app)?;
    if let Some(parent) = dst.parent() {
        let _ = std::fs::create_dir_all(parent);
    }
    std::fs::write(&dst, out).map_err(|e| format!("backup write failed: {e}"))?;
    Ok(())
}

/// On a fresh/empty install, restore config from the encrypted backup.
/// Returns Ok(true) if a restore happened. Best-effort: any missing
/// piece (no backup file, no keychain key) yields Ok(false), never an
/// error that would block startup.
pub fn restore_if_empty(app: &tauri::AppHandle) -> Result<bool, String> {
    if has_usable_config(app) {
        return Ok(false);
    }
    let bk = backup_path(app)?;
    let blob = match std::fs::read(&bk) {
        Ok(b) => b,
        Err(_) => return Ok(false),
    };
    if blob.len() < MAGIC_AB.len() || &blob[..MAGIC_AB.len()] != MAGIC_AB {
        return Ok(false);
    }
    let mut key = match get_existing_key()? {
        Some(k) => k,
        None => return Ok(false),
    };
    let pt = aead_decrypt(&key, &blob[MAGIC_AB.len()..]);
    key.zeroize();
    let pt = pt?;
    let dst = app_state_path(app)?;
    if let Some(parent) = dst.parent() {
        let _ = std::fs::create_dir_all(parent);
    }
    std::fs::write(&dst, &pt).map_err(|e| format!("restore write failed: {e}"))?;
    Ok(true)
}

#[derive(serde::Serialize)]
pub struct BackupStatus {
    pub exists: bool,
    pub path: String,
    pub last_backup_ms: Option<u64>,
}

#[tauri::command]
pub fn config_backup_status(app: tauri::AppHandle) -> Result<BackupStatus, String> {
    let p = backup_path(&app)?;
    let exists = p.exists();
    let last_backup_ms = if exists {
        std::fs::metadata(&p)
            .ok()
            .and_then(|m| m.modified().ok())
            .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
            .map(|d| d.as_millis() as u64)
    } else {
        None
    };
    Ok(BackupStatus {
        exists,
        path: p.to_string_lossy().to_string(),
        last_backup_ms,
    })
}

/// Force a backup now (Settings button).
#[tauri::command]
pub fn config_backup_now(app: tauri::AppHandle) -> Result<(), String> {
    auto_backup(&app)
}
