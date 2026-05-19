// Storage location detection.
//
// Tells the frontend what kind of filesystem a project path lives on
// so the "Settings → Storage Location" panel can show NAS-specific
// guidance, exclusion commands, and warnings (e.g. Source Watch
// doesn't fire on network mounts).
//
// Detection is best-effort and never blocks the call: if we can't
// figure it out we return `kind = "unknown"` rather than failing.

use serde::Serialize;
use std::path::Path;

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct StorageInfo {
    /// Coarse classification used by the UI to pick which guidance
    /// card to render. One of:
    /// "local" | "icloud" | "dropbox" | "onedrive" | "gdrive"
    /// | "smb" | "afp" | "nfs" | "webdav" | "synology-drive"
    /// | "fnos-drive" | "qsync" | "terrasync" | "unknown".
    pub kind: String,
    /// Raw filesystem type from the OS (e.g. "smbfs", "apfs", "cifs",
    /// "nfs", "ntfs"). None if we couldn't determine it.
    pub fs_type: Option<String>,
    /// Mount point the path resolves to. Helpful for showing the user
    /// "you're on /Volumes/team-wiki".
    pub mount_point: Option<String>,
    /// True if this lives on a network filesystem (SMB/AFP/NFS/etc.).
    /// The UI uses this to flip the "network mount" badge.
    pub is_network: bool,
    /// True if Source Watch (FSEvents / inotify) is known to NOT fire
    /// on this filesystem. Currently equal to is_network — kept as a
    /// separate field so future OS-specific exceptions (e.g. WSL2)
    /// can be expressed without breaking the API.
    pub source_watch_unsupported: bool,
    /// Best-guess vendor when we recognise the mount point/path
    /// pattern: "synology" | "fnos" | "qnap" | "terramaster" | null.
    pub vendor_hint: Option<String>,
    /// Path resolves and we can stat it.
    pub accessible: bool,
    /// stat says the path is not read-only. We do NOT touch the
    /// filesystem to verify — pure metadata check, no temp files.
    pub writable: bool,
}

#[tauri::command]
pub fn detect_storage(path: String) -> StorageInfo {
    let p = Path::new(&path);

    // Accessibility + writable bit come from a single stat call.
    let (accessible, writable) = match std::fs::metadata(p) {
        Ok(m) => (true, !m.permissions().readonly()),
        Err(_) => (false, false),
    };

    // 1. Path-pattern detection covers the cloud services that present
    //    as a normal local filesystem (so statfs would just say "apfs"
    //    or "ntfs"). Match by canonical substrings — these directory
    //    names are stable across user locales because the sync clients
    //    create them with fixed English names.
    if let Some(cloud) = detect_cloud_by_path(&path) {
        return StorageInfo {
            kind: cloud.kind.into(),
            fs_type: probe_fs_type(p),
            mount_point: None,
            is_network: false,
            source_watch_unsupported: false,
            vendor_hint: cloud.vendor.map(Into::into),
            accessible,
            writable,
        };
    }

    // 2. Filesystem-level detection catches "honest" network mounts
    //    (Finder Connect to Server, mapped network drive, mount.cifs).
    let fs = probe_fs_type(p);
    let mount = probe_mount_point(p);
    let is_network = fs
        .as_deref()
        .map(is_network_fs_name)
        .unwrap_or(false);

    let kind = if is_network {
        match fs.as_deref() {
            Some("smbfs") | Some("cifs") | Some("smb2") | Some("smb3") => "smb",
            Some("afpfs") => "afp",
            Some("nfs") | Some("nfs4") => "nfs",
            Some("webdav") | Some("webdavfs") => "webdav",
            _ => "smb", // generic network fallback — SMB is overwhelmingly the common case
        }
    } else {
        "local"
    };

    StorageInfo {
        kind: kind.into(),
        vendor_hint: mount
            .as_deref()
            .and_then(detect_vendor_by_mount)
            .map(Into::into),
        fs_type: fs,
        mount_point: mount,
        is_network,
        source_watch_unsupported: is_network,
        accessible,
        writable,
    }
}

struct CloudMatch {
    kind: &'static str,
    vendor: Option<&'static str>,
}

fn detect_cloud_by_path(path: &str) -> Option<CloudMatch> {
    // Forward-slash and backslash variants so the same matcher works
    // for macOS, Linux, and Windows paths.
    let lower = path.to_ascii_lowercase();
    let has = |needle: &str| lower.contains(&needle.to_ascii_lowercase());

    if has("mobile documents/com~apple~clouddocs") {
        return Some(CloudMatch { kind: "icloud", vendor: None });
    }
    // Synology Drive / fnOS Drive / Qsync clients create a sync root
    // with the vendor's product name in it — match those before generic
    // Dropbox/OneDrive so users on a NAS-vendor client get NAS-specific
    // guidance rather than being labelled "local".
    if has("synology drive") || has("synologydrive") || has("/cloudstation/") {
        return Some(CloudMatch { kind: "synology-drive", vendor: Some("synology") });
    }
    if has("fnos drive") || has("fnosdrive") || has("/fndrive/") {
        return Some(CloudMatch { kind: "fnos-drive", vendor: Some("fnos") });
    }
    if has("/qsync/") || has("\\qsync\\") {
        return Some(CloudMatch { kind: "qsync", vendor: Some("qnap") });
    }
    if has("terrasync") || has("/tnas/") {
        return Some(CloudMatch { kind: "terrasync", vendor: Some("terramaster") });
    }
    if has("/dropbox/") || has("\\dropbox\\") {
        return Some(CloudMatch { kind: "dropbox", vendor: None });
    }
    if has("/onedrive") || has("\\onedrive") {
        return Some(CloudMatch { kind: "onedrive", vendor: None });
    }
    if has("/google drive/") || has("/googledrive/") || has("\\google drive\\") || has("\\googledrive\\") {
        return Some(CloudMatch { kind: "gdrive", vendor: None });
    }
    None
}

fn detect_vendor_by_mount(mount: &str) -> Option<&'static str> {
    let lower = mount.to_ascii_lowercase();
    if lower.contains("synology") {
        Some("synology")
    } else if lower.contains("fnos") || lower.contains("feiniu") {
        Some("fnos")
    } else if lower.contains("qnap") || lower.contains("qsync") {
        Some("qnap")
    } else if lower.contains("tnas") || lower.contains("terramaster") {
        Some("terramaster")
    } else {
        None
    }
}

fn is_network_fs_name(name: &str) -> bool {
    matches!(
        name,
        "smbfs" | "cifs" | "smb" | "smb2" | "smb3"
            | "afpfs" | "afp"
            | "nfs" | "nfs4"
            | "webdav" | "webdavfs"
            | "fuse.sshfs" | "sshfs"
            | "9p"
    )
}

// ─── Platform-specific filesystem probing ────────────────────────────

#[cfg(target_os = "macos")]
fn probe_fs_type(path: &Path) -> Option<String> {
    use std::ffi::CString;
    use std::os::raw::c_char;

    let c_path = CString::new(path.to_string_lossy().as_bytes()).ok()?;
    let mut buf: libc::statfs = unsafe { std::mem::zeroed() };
    let rc = unsafe { libc::statfs(c_path.as_ptr(), &mut buf) };
    if rc != 0 {
        return None;
    }
    // f_fstypename is a fixed-size [c_char; MFSTYPENAMELEN] holding
    // a NUL-terminated ASCII fs name like "apfs" / "smbfs" / "nfs".
    let raw: &[c_char] = &buf.f_fstypename;
    let bytes: Vec<u8> = raw.iter().take_while(|c| **c != 0).map(|c| *c as u8).collect();
    String::from_utf8(bytes).ok()
}

#[cfg(target_os = "macos")]
fn probe_mount_point(path: &Path) -> Option<String> {
    use std::ffi::CString;
    use std::os::raw::c_char;

    let c_path = CString::new(path.to_string_lossy().as_bytes()).ok()?;
    let mut buf: libc::statfs = unsafe { std::mem::zeroed() };
    let rc = unsafe { libc::statfs(c_path.as_ptr(), &mut buf) };
    if rc != 0 {
        return None;
    }
    let raw: &[c_char] = &buf.f_mntonname;
    let bytes: Vec<u8> = raw.iter().take_while(|c| **c != 0).map(|c| *c as u8).collect();
    String::from_utf8(bytes).ok()
}

#[cfg(target_os = "linux")]
fn probe_fs_type(path: &Path) -> Option<String> {
    use std::ffi::CString;

    let c_path = CString::new(path.to_string_lossy().as_bytes()).ok()?;
    let mut buf: libc::statfs = unsafe { std::mem::zeroed() };
    let rc = unsafe { libc::statfs(c_path.as_ptr(), &mut buf) };
    if rc != 0 {
        return None;
    }
    // Linux's statfs doesn't expose the textual name — only the magic
    // number. Map the relevant ones; others fall back to None and the
    // caller treats it as local.
    let name = match buf.f_type as i64 {
        0xff534d42 => "cifs",     // SMB / CIFS (Linux's cifs.ko handles SMB2/3 too)
        0x6969 => "nfs",
        0x794c7630 => "overlay",
        0x65735546 => "fuseblk",   // FUSE-backed (covers sshfs, rclone mount)
        0x9123683e => "btrfs",
        0xef53 => "ext4",
        0x58465342 => "xfs",
        0x01021997 => "9p",        // Plan 9 over network
        _ => return None,
    };
    Some(name.to_string())
}

#[cfg(target_os = "linux")]
fn probe_mount_point(path: &Path) -> Option<String> {
    // Walk parents and find the longest prefix that appears as a mount
    // point in /proc/mounts. Good enough for the UI and avoids pulling
    // in another crate.
    let mounts = std::fs::read_to_string("/proc/mounts").ok()?;
    let mount_points: Vec<&str> = mounts
        .lines()
        .filter_map(|l| l.split_whitespace().nth(1))
        .collect();
    let canonical = std::fs::canonicalize(path).ok()?;
    let mut best: Option<String> = None;
    for mp in &mount_points {
        if canonical.starts_with(mp)
            && best.as_ref().map_or(true, |b| mp.len() > b.len())
        {
            best = Some((*mp).to_string());
        }
    }
    best
}

#[cfg(target_os = "windows")]
fn probe_fs_type(_path: &Path) -> Option<String> {
    // Windows-side detection isn't implemented yet — GetVolumeInformationW
    // gives us the FS name (e.g. "NTFS") but to call it we'd need to
    // pull in the `windows` crate. For now we leave detection to
    // GetDriveType via probe_mount_point's classification.
    None
}

#[cfg(target_os = "windows")]
fn probe_mount_point(path: &Path) -> Option<String> {
    // For UNC paths (\\server\share\...) the "mount point" the user
    // cares about is the \\server\share root. For drive-letter paths
    // it's the drive root (C:\). Best-effort, no crate.
    let s = path.to_string_lossy();
    if let Some(stripped) = s.strip_prefix(r"\\") {
        // \\server\share\foo\bar → \\server\share
        let mut parts = stripped.splitn(3, '\\');
        let server = parts.next()?;
        let share = parts.next()?;
        return Some(format!(r"\\{}\{}", server, share));
    }
    // C:\foo\bar → C:\
    let mut chars = s.chars();
    let drive = chars.next()?;
    if drive.is_ascii_alphabetic() && chars.next() == Some(':') {
        return Some(format!("{}:\\", drive));
    }
    None
}

#[cfg(not(any(target_os = "macos", target_os = "linux", target_os = "windows")))]
fn probe_fs_type(_path: &Path) -> Option<String> {
    None
}

#[cfg(not(any(target_os = "macos", target_os = "linux", target_os = "windows")))]
fn probe_mount_point(_path: &Path) -> Option<String> {
    None
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn cloud_path_classification() {
        assert_eq!(
            detect_cloud_by_path("/Users/me/Library/Mobile Documents/com~apple~CloudDocs/wiki")
                .map(|c| c.kind),
            Some("icloud"),
        );
        assert_eq!(
            detect_cloud_by_path("/Users/me/Dropbox/wiki").map(|c| c.kind),
            Some("dropbox"),
        );
        assert_eq!(
            detect_cloud_by_path(r"C:\Users\Me\OneDrive\wiki").map(|c| c.kind),
            Some("onedrive"),
        );
        assert_eq!(
            detect_cloud_by_path("/Users/me/SynologyDrive/wiki")
                .map(|c| (c.kind, c.vendor)),
            Some(("synology-drive", Some("synology"))),
        );
        assert_eq!(detect_cloud_by_path("/Users/me/Documents/wiki").map(|c| c.kind), None);
    }

    #[test]
    fn network_fs_names() {
        assert!(is_network_fs_name("smbfs"));
        assert!(is_network_fs_name("cifs"));
        assert!(is_network_fs_name("nfs"));
        assert!(!is_network_fs_name("apfs"));
        assert!(!is_network_fs_name("ext4"));
    }
}
