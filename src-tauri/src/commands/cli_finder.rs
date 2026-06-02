//! Locate a user-installed CLI binary (e.g. `claude`, `codex`).
//!
//! macOS apps launched from Finder/Dock inherit launchd's minimal PATH
//! (basically /usr/bin:/bin:/usr/sbin:/sbin), so a binary installed by
//! the official native installer (~/.local/bin/<name>) or by a non-system
//! npm prefix (~/.npm-global/bin, nvm versioned dirs) is invisible to
//! `which::which` from inside the GUI process. Same shape on Windows when
//! the bundle is launched outside a shell. We fall back to a curated list
//! of well-known install paths before reporting "not found".
//!
//! Order: which first (cheap, correct when PATH is set), then a fixed
//! sequence of candidate directories. First file hit wins.

use std::path::PathBuf;

/// Find `name` on PATH, with fallbacks to common install locations the
/// user's shell knows but the GUI process does not.
pub fn find_cli(name: &str) -> Result<PathBuf, String> {
    #[cfg(windows)]
    {
        for ext in &["cmd", "exe"] {
            if let Ok(p) = which::which(format!("{}.{}", name, ext)) {
                return Ok(p);
            }
        }
    }

    if let Ok(p) = which::which(name) {
        return Ok(p);
    }

    for path in fallback_candidates(name) {
        if path.is_file() {
            return Ok(path);
        }
    }

    Err(format!("`{}` not found on PATH", name))
}

fn fallback_candidates(name: &str) -> Vec<PathBuf> {
    let mut out = Vec::new();

    if let Some(home) = std::env::var_os("HOME") {
        let home = PathBuf::from(home);
        // Official native installer (curl … | sh) writes here.
        out.push(home.join(".local/bin").join(name));
        // Older native-installer layout: ~/.<name>/local/<name>
        out.push(home.join(format!(".{name}")).join("local").join(name));
        // Common npm-global prefixes.
        out.push(home.join(".npm-global/bin").join(name));
        out.push(home.join(".volta/bin").join(name));
        out.push(home.join(".bun/bin").join(name));
    }

    out.push(PathBuf::from("/opt/homebrew/bin").join(name));
    out.push(PathBuf::from("/usr/local/bin").join(name));
    out.push(PathBuf::from("/usr/bin").join(name));

    #[cfg(windows)]
    {
        if let Some(appdata) = std::env::var_os("APPDATA") {
            let appdata = PathBuf::from(appdata);
            for ext in &["cmd", "exe", ""] {
                let basename = if ext.is_empty() {
                    name.to_string()
                } else {
                    format!("{}.{}", name, ext)
                };
                out.push(appdata.join("npm").join(&basename));
            }
        }
    }

    out
}
