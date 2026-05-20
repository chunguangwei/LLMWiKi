//! Encrypted config export / import.
//!
//! Threat model: the exported file must stay confidential even if an
//! attacker has BOTH the file and the app binary. We therefore never
//! embed a key in the binary. Instead the user supplies a passphrase at
//! export time; we derive a 256-bit key from it with Argon2id (memory-
//! hard KDF) and encrypt with AES-256-GCM (authenticated). Decompiling
//! the app reveals nothing — security rests entirely on the passphrase.
//!
//! File layout (password-based export):
//!   magic "LWBK1" (5) | salt (16) | nonce (12) | ciphertext+tag (..)
//!
//! The `aead_*` helpers (raw-key AEAD) are reused by config_backup.rs
//! for the keyring-managed auto-backup, which uses a random key instead
//! of a passphrase-derived one.

use aes_gcm::aead::{Aead, KeyInit};
use aes_gcm::{Aes256Gcm, Key, Nonce};
use argon2::Argon2;
use rand::RngCore;
use tauri::Manager;
use zeroize::Zeroize;

const MAGIC_PW: &[u8; 5] = b"LWBK1";
const SALT_LEN: usize = 16;
const NONCE_LEN: usize = 12;
const KEY_LEN: usize = 32;
const GCM_TAG_LEN: usize = 16;

/// Argon2id key derivation. Uses the argon2 crate defaults (Argon2id,
/// v19, m=19 MiB, t=2, p=1) — a sensible interactive-use baseline.
fn derive_key(password: &str, salt: &[u8]) -> Result<[u8; KEY_LEN], String> {
    let mut key = [0u8; KEY_LEN];
    Argon2::default()
        .hash_password_into(password.as_bytes(), salt, &mut key)
        .map_err(|e| format!("key derivation failed: {e}"))?;
    Ok(key)
}

/// AES-256-GCM encrypt with a raw 32-byte key. Output is
/// `nonce (12) || ciphertext+tag`.
pub fn aead_encrypt(key: &[u8; KEY_LEN], plaintext: &[u8]) -> Result<Vec<u8>, String> {
    let cipher = Aes256Gcm::new(Key::<Aes256Gcm>::from_slice(key));
    let mut nonce_bytes = [0u8; NONCE_LEN];
    rand::thread_rng().fill_bytes(&mut nonce_bytes);
    let nonce = Nonce::from_slice(&nonce_bytes);
    let ct = cipher
        .encrypt(nonce, plaintext)
        .map_err(|e| format!("encryption failed: {e}"))?;
    let mut out = Vec::with_capacity(NONCE_LEN + ct.len());
    out.extend_from_slice(&nonce_bytes);
    out.extend_from_slice(&ct);
    Ok(out)
}

/// AES-256-GCM decrypt of a `nonce (12) || ciphertext+tag` blob.
pub fn aead_decrypt(key: &[u8; KEY_LEN], blob: &[u8]) -> Result<Vec<u8>, String> {
    if blob.len() < NONCE_LEN + GCM_TAG_LEN {
        return Err("ciphertext too short".into());
    }
    let (nonce_bytes, ct) = blob.split_at(NONCE_LEN);
    let cipher = Aes256Gcm::new(Key::<Aes256Gcm>::from_slice(key));
    let nonce = Nonce::from_slice(nonce_bytes);
    cipher
        .decrypt(nonce, ct)
        .map_err(|_| "decryption failed (wrong password or corrupt file)".to_string())
}

/// Passphrase-based encrypt: `magic || salt || aead(nonce||ct)`.
pub fn encrypt_with_password(plaintext: &str, password: &str) -> Result<Vec<u8>, String> {
    let mut salt = [0u8; SALT_LEN];
    rand::thread_rng().fill_bytes(&mut salt);
    let mut key = derive_key(password, &salt)?;
    let body = aead_encrypt(&key, plaintext.as_bytes());
    key.zeroize();
    let body = body?;
    let mut out = Vec::with_capacity(MAGIC_PW.len() + SALT_LEN + body.len());
    out.extend_from_slice(MAGIC_PW);
    out.extend_from_slice(&salt);
    out.extend_from_slice(&body);
    Ok(out)
}

/// Passphrase-based decrypt.
pub fn decrypt_with_password(blob: &[u8], password: &str) -> Result<String, String> {
    let header = MAGIC_PW.len() + SALT_LEN + NONCE_LEN + GCM_TAG_LEN;
    if blob.len() < header {
        return Err("file too short / not a config backup".into());
    }
    if &blob[..MAGIC_PW.len()] != MAGIC_PW {
        return Err("not an LLM Wiki config backup (bad magic)".into());
    }
    let salt = &blob[MAGIC_PW.len()..MAGIC_PW.len() + SALT_LEN];
    let body = &blob[MAGIC_PW.len() + SALT_LEN..];
    let mut key = derive_key(password, salt)?;
    let pt = aead_decrypt(&key, body);
    key.zeroize();
    let pt = pt?;
    String::from_utf8(pt).map_err(|_| "decrypted data is not valid UTF-8".to_string())
}

fn app_state_path(app: &tauri::AppHandle) -> Result<std::path::PathBuf, String> {
    let dir = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("could not resolve app data dir: {e}"))?;
    Ok(dir.join("app-state.json"))
}

/// Export the whole config store (app-state.json) to `out_path`,
/// encrypted with `password`. The plaintext never leaves Rust
/// unencrypted.
#[tauri::command]
pub fn export_config(app: tauri::AppHandle, out_path: String, password: String) -> Result<(), String> {
    if password.chars().count() < 8 {
        return Err("password must be at least 8 characters".into());
    }
    let src = app_state_path(&app)?;
    let plaintext =
        std::fs::read_to_string(&src).map_err(|e| format!("could not read config: {e}"))?;
    let blob = encrypt_with_password(&plaintext, &password)?;
    std::fs::write(&out_path, blob).map_err(|e| format!("could not write export file: {e}"))?;
    Ok(())
}

/// Import a previously-exported config file: decrypt with `password`,
/// validate it's JSON, back up the current store, then overwrite it.
/// The caller should prompt the user to restart so the new config is
/// re-read.
#[tauri::command]
pub fn import_config(app: tauri::AppHandle, in_path: String, password: String) -> Result<(), String> {
    let blob = std::fs::read(&in_path).map_err(|e| format!("could not read file: {e}"))?;
    let plaintext = decrypt_with_password(&blob, &password)?;
    serde_json::from_str::<serde_json::Value>(&plaintext)
        .map_err(|e| format!("decrypted data is not valid config JSON: {e}"))?;
    let dst = app_state_path(&app)?;
    if let Some(parent) = dst.parent() {
        let _ = std::fs::create_dir_all(parent);
    }
    if dst.exists() {
        // Keep a one-shot safety copy of whatever was there before.
        let _ = std::fs::copy(&dst, dst.with_extension("json.pre-import"));
    }
    std::fs::write(&dst, plaintext).map_err(|e| format!("could not write config: {e}"))?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn password_roundtrip() {
        let plain = r#"{"llmConfig":{"apiKey":"sk-secret"}}"#;
        let blob = encrypt_with_password(plain, "correct horse battery").unwrap();
        // Magic header present, ciphertext differs from plaintext.
        assert_eq!(&blob[..5], MAGIC_PW);
        assert!(!blob.windows(plain.len()).any(|w| w == plain.as_bytes()));
        let out = decrypt_with_password(&blob, "correct horse battery").unwrap();
        assert_eq!(out, plain);
    }

    #[test]
    fn wrong_password_fails() {
        let blob = encrypt_with_password("{}", "right-password").unwrap();
        assert!(decrypt_with_password(&blob, "wrong-password").is_err());
    }

    #[test]
    fn tamper_detected() {
        let mut blob = encrypt_with_password("{}", "pw-pw-pw-pw").unwrap();
        let last = blob.len() - 1;
        blob[last] ^= 0xff;
        assert!(decrypt_with_password(&blob, "pw-pw-pw-pw").is_err());
    }

    #[test]
    fn raw_aead_roundtrip() {
        let key = [7u8; KEY_LEN];
        let blob = aead_encrypt(&key, b"hello").unwrap();
        assert_eq!(aead_decrypt(&key, &blob).unwrap(), b"hello");
    }
}
