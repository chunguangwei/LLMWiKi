//! GitHub-backed versioned backup & multi-device sync for a wiki project.
//!
//! Why the REST Git Data API (and NOT git2/libgit2): the fork ships as a
//! self-contained Tauri desktop app with no system git dependency. Bundling
//! libgit2 would add a native build dep (and a much larger binary) just to
//! talk to one remote. Instead we drive GitHub's Git Data API directly over
//! HTTPS with the reqwest client we already depend on — blobs, trees,
//! commits and refs are all plain JSON endpoints. The trade-off is that we
//! reimplement the small slice of git plumbing we need (blob hashing,
//! three-way merge) ourselves; that logic is pure and unit-tested below.
//!
//! Sync model: there is no local `.git`. The frontend persists a
//! `last_sync_sha` (the commit this device last synced to) and passes it in
//! per call; each sync command returns the new sha so the frontend can
//! persist it. `last_sync_sha` plays the role of the merge BASE — the common
//! ancestor used to tell "remote changed it" from "I changed it" from "we
//! both changed it". This is what lets two devices sharing one repo converge
//! instead of clobbering each other.
//!
//! Token handling: a GitHub PAT (or OAuth-device-flow token) is stored in the
//! OS keychain under the SAME service name as the rest of the app
//! ("com.llmwiki.app") with user "github-pat". Commands read it from the
//! keychain themselves — the token is never round-tripped through JS except
//! at save time. This matches commands/config_backup.rs.

use base64::{engine::general_purpose::STANDARD as B64, Engine};
use keyring::Entry;
use serde::{Deserialize, Serialize};
use sha1::{Digest, Sha1};
use std::collections::BTreeMap;
use std::path::{Path, PathBuf};
use std::time::{Duration, UNIX_EPOCH};
use walkdir::WalkDir;

const KEYRING_SERVICE: &str = "com.llmwiki.app";
const KEYRING_USER: &str = "github-pat";

const API_BASE: &str = "https://api.github.com";
const API_VERSION: &str = "2022-11-28";
/// GitHub rejects requests without a User-Agent; it does not have to be a
/// real browser, just a stable product name.
const USER_AGENT: &str = "LLMWiki";

/// Default per-file size ceiling. GitHub's Git Data blob endpoint tops out at
/// 100 MB, and base64 inflates the body ~1.33×; 50 MB keeps us comfortably
/// inside that and skips the giant binaries (model dumps, video) that don't
/// belong in a wiki backup anyway.
const DEFAULT_MAX_BYTES: u64 = 50 * 1024 * 1024;

/// HTTP request timeout. Blob up/downloads can be a few MB each, so this is
/// generous relative to the search client's 8s.
const HTTP_TIMEOUT_SECS: u64 = 120;

// ---------------------------------------------------------------------------
// Token storage (keyring) — mirrors commands/config_backup.rs conventions.
// ---------------------------------------------------------------------------

fn token_entry() -> Result<Entry, String> {
    Entry::new(KEYRING_SERVICE, KEYRING_USER).map_err(|e| format!("keyring unavailable: {e}"))
}

/// Persist the PAT/OAuth token in the OS keychain. Public so the OAuth flow
/// and the explicit save command can both reuse it.
pub fn save_github_token(token: String) -> Result<(), String> {
    let token = token.trim();
    if token.is_empty() {
        return Err("token is empty".to_string());
    }
    token_entry()?
        .set_password(token)
        .map_err(|e| format!("could not store token: {e}"))
}

/// Read the stored token, returning None when nothing is saved (vs. an Err
/// for an actual keychain failure the caller may want to surface).
pub fn get_github_token() -> Result<Option<String>, String> {
    match token_entry()?.get_password() {
        Ok(t) => Ok(Some(t)),
        Err(keyring::Error::NoEntry) => Ok(None),
        Err(e) => Err(format!("keyring read failed: {e}")),
    }
}

/// Remove the stored token (sign-out). Treats "already absent" as success so
/// the command is idempotent.
pub fn delete_github_token() -> Result<(), String> {
    match token_entry()?.delete_credential() {
        Ok(()) => Ok(()),
        Err(keyring::Error::NoEntry) => Ok(()),
        Err(e) => Err(format!("could not delete token: {e}")),
    }
}

/// Fetch the token or fail with a user-actionable message — used by every
/// command that talks to the API.
fn require_token() -> Result<String, String> {
    get_github_token()?.ok_or_else(|| "No GitHub token saved. Connect GitHub first.".to_string())
}

// ---------------------------------------------------------------------------
// Pure helpers (unit-tested) — git blob hashing, scope filter, enumeration,
// three-way conflict resolution. These contain ZERO network/IO logic that
// can't run in a test (enumerate_files uses a temp dir).
// ---------------------------------------------------------------------------

/// Compute git's blob object id for `content`.
///
/// git hashes `b"blob " + len_decimal + b"\0" + content` with SHA-1 and hex-
/// encodes the digest. We need this so a sync can compare a local file
/// against the `sha` field GitHub returns in a tree listing and upload ONLY
/// the blobs that actually changed — without it, every sync would re-push
/// every file. Verified in tests against the canonical `"hello\n"` id.
pub fn git_blob_sha1(content: &[u8]) -> String {
    let mut hasher = Sha1::new();
    hasher.update(format!("blob {}\0", content.len()).as_bytes());
    hasher.update(content);
    let digest = hasher.finalize();
    let mut out = String::with_capacity(40);
    for byte in digest {
        out.push_str(&format!("{byte:02x}"));
    }
    out
}

/// Whether a project-relative path must NEVER be synced.
///
/// Always excluded: local-only state, the source ingest cache, any nested
/// git metadata, OS cruft, and dependency dirs. When `include_raw_sources`
/// is false we additionally drop the whole `raw/` tree (the original ingested
/// PDFs/office docs, often large) — but `wiki/`, `schema.md`, `purpose.md`
/// and `.llm-wiki/` are core project state and are kept regardless.
///
/// `rel_path` is expected to use forward slashes (we normalize before calling
/// this from enumerate_files); we still guard against backslashes for safety.
pub fn is_excluded(rel_path: &str, include_raw_sources: bool) -> bool {
    let rel = rel_path.replace('\\', "/");
    let rel = rel.trim_start_matches("./");

    // Unconditional excludes. Matched as a path PREFIX (segment-aware) so
    // `raw/sources/.cache/x` is excluded but a file literally named
    // `.DS_Store` anywhere is excluded too.
    const ALWAYS_DIRS: &[&str] = &[".llm-wiki-local/", "raw/sources/.cache/", ".git/", "node_modules/"];
    for dir in ALWAYS_DIRS {
        if rel == dir.trim_end_matches('/') || rel.starts_with(dir) || rel.contains(&format!("/{dir}")) {
            return true;
        }
    }
    // .DS_Store can appear in any directory.
    if rel == ".DS_Store" || rel.ends_with("/.DS_Store") {
        return true;
    }

    if !include_raw_sources {
        // Drop the raw/ tree, but never the core paths.
        let is_core = rel == "wiki"
            || rel.starts_with("wiki/")
            || rel == "schema.md"
            || rel == "purpose.md"
            || rel == ".llm-wiki"
            || rel.starts_with(".llm-wiki/");
        if !is_core && (rel == "raw" || rel.starts_with("raw/")) {
            return true;
        }
    }

    false
}

/// Walk `project_dir`, applying the scope filter, and split the surviving
/// files into (in-scope, oversize-skipped).
///
/// Returns `(files, skipped_oversize)` where each `files` entry is
/// `(rel_path, abs_path, size)` with `rel_path` using forward slashes (the
/// path form git/GitHub trees use). Files larger than `max_bytes` are NOT
/// returned in `files` — their relative paths go into `skipped_oversize` so
/// the UI can warn the user they aren't backed up.
pub fn enumerate_files(
    project_dir: &Path,
    include_raw_sources: bool,
    max_bytes: u64,
) -> Result<(Vec<(String, PathBuf, u64)>, Vec<String>), String> {
    let mut files = Vec::new();
    let mut skipped = Vec::new();

    for entry in WalkDir::new(project_dir).into_iter().filter_map(Result::ok) {
        if !entry.file_type().is_file() {
            continue;
        }
        let abs = entry.path();
        let rel = match abs.strip_prefix(project_dir) {
            Ok(r) => r.to_string_lossy().replace('\\', "/"),
            Err(_) => continue,
        };
        if rel.is_empty() || is_excluded(&rel, include_raw_sources) {
            continue;
        }
        let size = entry.metadata().map(|m| m.len()).unwrap_or(0);
        if size > max_bytes {
            skipped.push(rel);
            continue;
        }
        files.push((rel, abs.to_path_buf(), size));
    }

    files.sort_by(|a, b| a.0.cmp(&b.0));
    skipped.sort();
    Ok((files, skipped))
}

/// Per-path presence + content fingerprint at one of the three merge points.
/// `None` blob means "the file does not exist at this point".
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PathState {
    /// blob sha at base (last_sync_sha tree)
    pub base: Option<String>,
    /// blob sha in the local working dir
    pub local: Option<String>,
    /// blob sha in the remote tree
    pub remote: Option<String>,
}

/// The decision the resolver reaches for one path during a pull/merge.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum MergeAction {
    /// remote wins: download the remote blob and overwrite/create locally
    TakeRemote,
    /// local wins: keep the working-dir copy (it will be pushed on backup)
    KeepLocal,
    /// remote deleted the file and we should delete it locally too
    DeleteLocal,
    /// nothing to do (identical, or both already agree)
    NoOp,
}

/// Three-way merge for ONE path, given presence/blob at base, local, remote
/// plus the timestamps used to break "both changed" ties.
///
/// `local_mtime_epoch` is the working file's mtime (seconds); `remote_epoch`
/// is the remote commit's author/committer date (seconds). "Latest wins":
/// whichever side was touched more recently is taken. This is deliberately
/// simple and predictable — a wiki is human-edited prose, so a clean
/// last-writer-wins per file beats trying to line-merge markdown.
///
/// Rule matrix (b=base, l=local, r=remote blob shas):
///   - l == r                          → NoOp (already converged)
///   - changed-remote-only (l==b, r!=b)→ TakeRemote
///   - changed-local-only  (r==b, l!=b)→ KeepLocal
///   - both-changed (l!=b, r!=b, l!=r) → latest-wins(remote_epoch vs mtime)
///   - new-remote-only (b=None,l=None) → TakeRemote
///   - new-local-only  (b=None,r=None) → KeepLocal
///   - added-both, differing           → latest-wins
///   - deleted-remote, local unchanged → DeleteLocal
///   - deleted-remote, local changed   → latest-wins (delete vs keep)
///   - deleted-local, remote unchanged → KeepLocal (honor local delete; push removes it)
///   - deleted-local, remote changed   → latest-wins (remote edit vs local delete)
pub fn resolve_merge(
    state: &PathState,
    local_mtime_epoch: i64,
    remote_epoch: i64,
) -> MergeAction {
    let PathState { base, local, remote } = state;

    // Fast path: local already equals remote.
    if local == remote {
        return MergeAction::NoOp;
    }

    let local_changed = local != base;
    let remote_changed = remote != base;

    match (local.is_some(), remote.is_some()) {
        // Both sides have the file (and they differ — handled above if equal).
        (true, true) => {
            if !local_changed && remote_changed {
                MergeAction::TakeRemote
            } else if local_changed && !remote_changed {
                MergeAction::KeepLocal
            } else {
                // both changed (or base==None add-both): latest wins
                latest_wins_keep_or_take(local_mtime_epoch, remote_epoch)
            }
        }
        // Remote has it, local does not → either a remote add, a remote that
        // we deleted locally, or remote-edit-vs-local-delete.
        (false, true) => {
            // local deleted (had a base) ?
            let local_deleted = base.is_some() && local.is_none();
            if local_deleted {
                if remote_changed {
                    // remote-edit vs local-delete → latest wins
                    if remote_epoch >= local_mtime_epoch {
                        MergeAction::TakeRemote
                    } else {
                        // local delete wins; nothing to write, push will drop it
                        MergeAction::NoOp
                    }
                } else {
                    // remote unchanged, we deleted → honor the delete (NoOp:
                    // file already gone locally; push omits it from the tree)
                    MergeAction::NoOp
                }
            } else {
                // brand-new remote file we've never seen → take it
                MergeAction::TakeRemote
            }
        }
        // Local has it, remote does not → remote delete, or a brand-new local.
        (true, false) => {
            let remote_deleted = base.is_some() && remote.is_none();
            if remote_deleted {
                if local_changed {
                    // delete-remote vs local-edit → latest wins
                    if remote_epoch >= local_mtime_epoch {
                        MergeAction::DeleteLocal
                    } else {
                        MergeAction::KeepLocal
                    }
                } else {
                    // remote deleted, local untouched → delete locally
                    MergeAction::DeleteLocal
                }
            } else {
                // brand-new local file → keep (push uploads it)
                MergeAction::KeepLocal
            }
        }
        // Neither side has it.
        (false, false) => MergeAction::NoOp,
    }
}

/// Tie-break helper for the "both present and both changed" case.
fn latest_wins_keep_or_take(local_mtime_epoch: i64, remote_epoch: i64) -> MergeAction {
    if remote_epoch >= local_mtime_epoch {
        MergeAction::TakeRemote
    } else {
        MergeAction::KeepLocal
    }
}

// ---------------------------------------------------------------------------
// REST client — small typed helpers over reqwest. Each maps one GitHub
// endpoint; higher layers compose them.
// ---------------------------------------------------------------------------

fn http_client() -> Result<reqwest::Client, String> {
    reqwest::Client::builder()
        .timeout(Duration::from_secs(HTTP_TIMEOUT_SECS))
        .build()
        .map_err(|e| format!("HTTP client error: {e}"))
}

/// Apply the auth + content-negotiation headers GitHub's API requires.
fn auth(req: reqwest::RequestBuilder, token: &str) -> reqwest::RequestBuilder {
    req.header("Authorization", format!("Bearer {token}"))
        .header("Accept", "application/vnd.github+json")
        .header("X-GitHub-Api-Version", API_VERSION)
        .header("User-Agent", USER_AGENT)
}

/// Read a non-2xx response into a useful error string (status + truncated
/// body) so failures surface a real GitHub message, not just "request failed".
async fn err_body(resp: reqwest::Response) -> String {
    let status = resp.status();
    let text = resp.text().await.unwrap_or_default();
    format!("GitHub API HTTP {status}: {}", text.chars().take(300).collect::<String>())
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GithubUser {
    pub login: String,
    #[serde(default)]
    pub name: Option<String>,
    #[serde(default)]
    pub avatar_url: Option<String>,
}

/// GET /user — validates a token and returns the authenticated identity.
pub async fn validate_token(token: &str) -> Result<GithubUser, String> {
    let resp = auth(http_client()?.get(format!("{API_BASE}/user")), token)
        .send()
        .await
        .map_err(|e| format!("validate_token request failed: {e}"))?;
    if !resp.status().is_success() {
        return Err(err_body(resp).await);
    }
    // The /user payload uses snake_case avatar_url; serde rename_all=camelCase
    // on the struct only affects (de)serialization OF our struct field names,
    // so we deserialize from the raw value to be tolerant of extra fields.
    let v: serde_json::Value = resp.json().await.map_err(|e| format!("validate_token parse: {e}"))?;
    Ok(GithubUser {
        login: v.get("login").and_then(|x| x.as_str()).unwrap_or_default().to_string(),
        name: v.get("name").and_then(|x| x.as_str()).map(|s| s.to_string()),
        avatar_url: v.get("avatar_url").and_then(|x| x.as_str()).map(|s| s.to_string()),
    })
}

/// GET /repos/{owner}/{repo}; if 404, create it private+auto_init. Returns
/// `true` when it had to create the repo (so the UI can say "created").
pub async fn ensure_repo(token: &str, owner: &str, repo: &str, private: bool) -> Result<bool, String> {
    let client = http_client()?;
    let resp = auth(client.get(format!("{API_BASE}/repos/{owner}/{repo}")), token)
        .send()
        .await
        .map_err(|e| format!("ensure_repo lookup failed: {e}"))?;
    if resp.status().is_success() {
        return Ok(false);
    }
    if resp.status() != reqwest::StatusCode::NOT_FOUND {
        return Err(err_body(resp).await);
    }
    // 404 → create under the authenticated user. auto_init gives us an
    // initial commit + default branch so subsequent ref reads succeed.
    let body = serde_json::json!({ "name": repo, "private": private, "auto_init": true });
    let resp = auth(client.post(format!("{API_BASE}/user/repos")), token)
        .json(&body)
        .send()
        .await
        .map_err(|e| format!("create repo failed: {e}"))?;
    if !resp.status().is_success() {
        return Err(err_body(resp).await);
    }
    Ok(true)
}

/// GET .../git/ref/heads/{branch} → the commit sha the branch points at, or
/// None when the branch doesn't exist yet (404).
pub async fn get_ref_sha(token: &str, owner: &str, repo: &str, branch: &str) -> Result<Option<String>, String> {
    let resp = auth(
        http_client()?.get(format!("{API_BASE}/repos/{owner}/{repo}/git/ref/heads/{branch}")),
        token,
    )
    .send()
    .await
    .map_err(|e| format!("get_ref_sha failed: {e}"))?;
    if resp.status() == reqwest::StatusCode::NOT_FOUND {
        return Ok(None);
    }
    if !resp.status().is_success() {
        return Err(err_body(resp).await);
    }
    let v: serde_json::Value = resp.json().await.map_err(|e| format!("get_ref_sha parse: {e}"))?;
    Ok(v.get("object").and_then(|o| o.get("sha")).and_then(|s| s.as_str()).map(|s| s.to_string()))
}

#[derive(Debug, Clone)]
pub struct CommitInfo {
    pub tree_sha: String,
    /// committer date as a unix epoch (seconds)
    pub epoch: i64,
}

/// GET .../git/commits/{sha} → the commit's tree sha + committer date.
pub async fn get_commit(token: &str, owner: &str, repo: &str, sha: &str) -> Result<CommitInfo, String> {
    let resp = auth(
        http_client()?.get(format!("{API_BASE}/repos/{owner}/{repo}/git/commits/{sha}")),
        token,
    )
    .send()
    .await
    .map_err(|e| format!("get_commit failed: {e}"))?;
    if !resp.status().is_success() {
        return Err(err_body(resp).await);
    }
    let v: serde_json::Value = resp.json().await.map_err(|e| format!("get_commit parse: {e}"))?;
    let tree_sha = v
        .get("tree")
        .and_then(|t| t.get("sha"))
        .and_then(|s| s.as_str())
        .ok_or("get_commit: missing tree sha")?
        .to_string();
    let date = v
        .get("committer")
        .and_then(|c| c.get("date"))
        .and_then(|d| d.as_str())
        .unwrap_or("");
    Ok(CommitInfo { tree_sha, epoch: parse_iso8601_epoch(date) })
}

#[derive(Debug, Clone)]
pub struct TreeEntryRemote {
    pub path: String,
    pub sha: String,
    // `kind`/`mode` mirror the GitHub tree-entry shape for completeness; the
    // sync engine only needs path+sha today, so they're read-allowed.
    #[allow(dead_code)]
    pub kind: String, // "blob" | "tree"
    #[allow(dead_code)]
    pub mode: String,
}

/// GET .../git/trees/{tree_sha}?recursive=1 → the full flat file listing.
///
/// Note GitHub truncates very large trees (`truncated:true`); we surface that
/// as an error rather than silently syncing a partial snapshot.
pub async fn get_tree_recursive(token: &str, owner: &str, repo: &str, tree_sha: &str) -> Result<Vec<TreeEntryRemote>, String> {
    let resp = auth(
        http_client()?.get(format!("{API_BASE}/repos/{owner}/{repo}/git/trees/{tree_sha}?recursive=1")),
        token,
    )
    .send()
    .await
    .map_err(|e| format!("get_tree failed: {e}"))?;
    if !resp.status().is_success() {
        return Err(err_body(resp).await);
    }
    let v: serde_json::Value = resp.json().await.map_err(|e| format!("get_tree parse: {e}"))?;
    if v.get("truncated").and_then(|t| t.as_bool()).unwrap_or(false) {
        return Err("remote tree is too large (truncated by GitHub); cannot sync safely".to_string());
    }
    let mut out = Vec::new();
    if let Some(arr) = v.get("tree").and_then(|t| t.as_array()) {
        for e in arr {
            let kind = e.get("type").and_then(|x| x.as_str()).unwrap_or("").to_string();
            if kind != "blob" {
                continue; // we reconstruct directories from blob paths
            }
            out.push(TreeEntryRemote {
                path: e.get("path").and_then(|x| x.as_str()).unwrap_or_default().to_string(),
                sha: e.get("sha").and_then(|x| x.as_str()).unwrap_or_default().to_string(),
                kind,
                mode: e.get("mode").and_then(|x| x.as_str()).unwrap_or("100644").to_string(),
            });
        }
    }
    Ok(out)
}

/// POST .../git/blobs with base64 content → the new blob sha.
pub async fn create_blob(token: &str, owner: &str, repo: &str, base64_content: &str) -> Result<String, String> {
    let body = serde_json::json!({ "content": base64_content, "encoding": "base64" });
    let resp = auth(
        http_client()?.post(format!("{API_BASE}/repos/{owner}/{repo}/git/blobs")),
        token,
    )
    .json(&body)
    .send()
    .await
    .map_err(|e| format!("create_blob failed: {e}"))?;
    if !resp.status().is_success() {
        return Err(err_body(resp).await);
    }
    let v: serde_json::Value = resp.json().await.map_err(|e| format!("create_blob parse: {e}"))?;
    v.get("sha").and_then(|s| s.as_str()).map(|s| s.to_string()).ok_or("create_blob: missing sha".to_string())
}

/// GET .../git/blobs/{sha} → the decoded raw bytes.
pub async fn get_blob(token: &str, owner: &str, repo: &str, sha: &str) -> Result<Vec<u8>, String> {
    let resp = auth(
        http_client()?.get(format!("{API_BASE}/repos/{owner}/{repo}/git/blobs/{sha}")),
        token,
    )
    .send()
    .await
    .map_err(|e| format!("get_blob failed: {e}"))?;
    if !resp.status().is_success() {
        return Err(err_body(resp).await);
    }
    let v: serde_json::Value = resp.json().await.map_err(|e| format!("get_blob parse: {e}"))?;
    let content = v.get("content").and_then(|c| c.as_str()).unwrap_or("");
    // GitHub returns base64 with embedded newlines; strip whitespace first.
    let cleaned: String = content.chars().filter(|c| !c.is_whitespace()).collect();
    B64.decode(cleaned.as_bytes()).map_err(|e| format!("get_blob base64 decode: {e}"))
}

/// One entry for a tree-creation request.
#[derive(Debug, Clone, Serialize)]
pub struct TreeEntryInput {
    pub path: String,
    pub mode: String,
    #[serde(rename = "type")]
    pub kind: String,
    pub sha: String,
}

/// POST .../git/trees → a new tree sha. We always build the FULL tree from
/// scratch (not base_tree deltas) so locally-deleted paths drop out cleanly.
pub async fn create_tree(token: &str, owner: &str, repo: &str, entries: &[TreeEntryInput]) -> Result<String, String> {
    let body = serde_json::json!({ "tree": entries });
    let resp = auth(
        http_client()?.post(format!("{API_BASE}/repos/{owner}/{repo}/git/trees")),
        token,
    )
    .json(&body)
    .send()
    .await
    .map_err(|e| format!("create_tree failed: {e}"))?;
    if !resp.status().is_success() {
        return Err(err_body(resp).await);
    }
    let v: serde_json::Value = resp.json().await.map_err(|e| format!("create_tree parse: {e}"))?;
    v.get("sha").and_then(|s| s.as_str()).map(|s| s.to_string()).ok_or("create_tree: missing sha".to_string())
}

/// POST .../git/commits → a new commit sha. `parents` is empty for the very
/// first commit on an empty repo (rare, since auto_init seeds one).
pub async fn create_commit(token: &str, owner: &str, repo: &str, message: &str, tree_sha: &str, parents: &[String]) -> Result<String, String> {
    let body = serde_json::json!({ "message": message, "tree": tree_sha, "parents": parents });
    let resp = auth(
        http_client()?.post(format!("{API_BASE}/repos/{owner}/{repo}/git/commits")),
        token,
    )
    .json(&body)
    .send()
    .await
    .map_err(|e| format!("create_commit failed: {e}"))?;
    if !resp.status().is_success() {
        return Err(err_body(resp).await);
    }
    let v: serde_json::Value = resp.json().await.map_err(|e| format!("create_commit parse: {e}"))?;
    v.get("sha").and_then(|s| s.as_str()).map(|s| s.to_string()).ok_or("create_commit: missing sha".to_string())
}

/// PATCH (or create) the branch ref to point at `sha`.
///
/// If the branch doesn't exist we POST .../git/refs to create it; otherwise
/// PATCH .../git/refs/heads/{branch}. `force` controls whether a non-
/// fast-forward update is allowed (we set it true after a pull-merge has
/// already reconciled the histories).
pub async fn update_ref(token: &str, owner: &str, repo: &str, branch: &str, sha: &str, force: bool) -> Result<(), String> {
    let client = http_client()?;
    // Does the ref exist?
    let exists = get_ref_sha(token, owner, repo, branch).await?.is_some();
    let resp = if exists {
        let body = serde_json::json!({ "sha": sha, "force": force });
        auth(
            client.patch(format!("{API_BASE}/repos/{owner}/{repo}/git/refs/heads/{branch}")),
            token,
        )
        .json(&body)
        .send()
        .await
    } else {
        let body = serde_json::json!({ "ref": format!("refs/heads/{branch}"), "sha": sha });
        auth(client.post(format!("{API_BASE}/repos/{owner}/{repo}/git/refs")), token)
            .json(&body)
            .send()
            .await
    }
    .map_err(|e| format!("update_ref failed: {e}"))?;
    if !resp.status().is_success() {
        return Err(err_body(resp).await);
    }
    Ok(())
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CommitSummary {
    pub sha: String,
    pub message: String,
    pub date: String,
    pub author: String,
}

/// GET .../commits?sha={branch}&per_page=N → recent commit summaries for the
/// version-history UI.
pub async fn list_commits(token: &str, owner: &str, repo: &str, branch: &str, per_page: u32) -> Result<Vec<CommitSummary>, String> {
    let resp = auth(
        http_client()?.get(format!(
            "{API_BASE}/repos/{owner}/{repo}/commits?sha={branch}&per_page={per_page}"
        )),
        token,
    )
    .send()
    .await
    .map_err(|e| format!("list_commits failed: {e}"))?;
    if !resp.status().is_success() {
        return Err(err_body(resp).await);
    }
    let v: serde_json::Value = resp.json().await.map_err(|e| format!("list_commits parse: {e}"))?;
    let mut out = Vec::new();
    if let Some(arr) = v.as_array() {
        for c in arr {
            let commit = c.get("commit");
            out.push(CommitSummary {
                sha: c.get("sha").and_then(|s| s.as_str()).unwrap_or_default().to_string(),
                message: commit
                    .and_then(|x| x.get("message"))
                    .and_then(|m| m.as_str())
                    .unwrap_or_default()
                    .to_string(),
                date: commit
                    .and_then(|x| x.get("committer"))
                    .and_then(|a| a.get("date"))
                    .and_then(|d| d.as_str())
                    .unwrap_or_default()
                    .to_string(),
                author: commit
                    .and_then(|x| x.get("author"))
                    .and_then(|a| a.get("name"))
                    .and_then(|n| n.as_str())
                    .unwrap_or_default()
                    .to_string(),
            });
        }
    }
    Ok(out)
}

// ---------------------------------------------------------------------------
// Small time helper. We avoid pulling chrono parsing into the hot path by
// hand-parsing the fixed ISO-8601 "YYYY-MM-DDTHH:MM:SSZ" GitHub returns.
// ---------------------------------------------------------------------------

/// Parse GitHub's ISO-8601 UTC timestamp to a unix epoch (seconds). Returns 0
/// on any parse failure (treated as "very old", so a malformed remote date
/// loses every latest-wins tie — safe default).
fn parse_iso8601_epoch(s: &str) -> i64 {
    // chrono is already a dependency; use it for correctness over hand-rolling
    // leap-year math.
    chrono::DateTime::parse_from_rfc3339(s)
        .map(|dt| dt.timestamp())
        .unwrap_or(0)
}

// ---------------------------------------------------------------------------
// Sync engine — these are the async #[tauri::command]s the frontend calls.
// ---------------------------------------------------------------------------

/// Build a path→blob-sha map from a remote tree listing.
fn remote_tree_map(entries: &[TreeEntryRemote]) -> BTreeMap<String, String> {
    entries.iter().map(|e| (e.path.clone(), e.sha.clone())).collect()
}

/// File's mtime as a unix epoch (seconds), 0 if unavailable.
fn file_mtime_epoch(path: &Path) -> i64 {
    std::fs::metadata(path)
        .and_then(|m| m.modified())
        .ok()
        .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0)
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BackupResult {
    pub new_sha: String,
    pub pushed_files: Vec<String>,
    pub skipped_oversize: Vec<String>,
    /// whether a pull-merge ran before pushing (remote had moved on)
    pub pulled_first: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PullResult {
    pub new_sha: String,
    pub changed_files: Vec<String>,
    pub deleted_files: Vec<String>,
    pub conflicts: Vec<String>,
}

/// Push the working dir to GitHub as a new commit.
///
/// 1. ensure repo exists; read the branch's current remote sha.
/// 2. if the remote moved since `last_sync_sha` (and we had a base), pull-
///    merge first so we don't clobber another device's work; the merged
///    remote sha becomes the new commit's parent.
/// 3. enumerate local files, hash them, upload only blobs whose sha differs
///    from the remote tree, build a full tree (dropping deleted paths),
///    commit, and move the ref.
#[tauri::command]
pub async fn github_backup_now(
    project_dir: String,
    owner: String,
    repo: String,
    branch: String,
    include_raw_sources: bool,
    last_sync_sha: String,
) -> Result<BackupResult, String> {
    let token = require_token()?;
    let dir = PathBuf::from(&project_dir);
    let private = true; // backups are always created private; ensure_repo only creates on 404

    ensure_repo(&token, &owner, &repo, private).await?;

    let mut remote_sha = get_ref_sha(&token, &owner, &repo, &branch).await?;
    let mut pulled_first = false;

    // If the branch advanced on the remote relative to our last sync, merge
    // the remote into the working dir BEFORE building our push tree. We use
    // the just-merged remote sha as the parent so our commit is a proper
    // fast-forward of the remote tip (no force needed).
    if let Some(ref rsha) = remote_sha {
        if !last_sync_sha.is_empty() && *rsha != last_sync_sha {
            let _pull = pull_merge_inner(&token, &dir, &owner, &repo, &branch, include_raw_sources, &last_sync_sha).await?;
            pulled_first = true;
            // re-read in case the branch moved again (cheap and safe)
            remote_sha = get_ref_sha(&token, &owner, &repo, &branch).await?;
        }
    }

    // Remote tree (path → blob sha) so we can skip unchanged blobs.
    let remote_map = match &remote_sha {
        Some(sha) => {
            let commit = get_commit(&token, &owner, &repo, sha).await?;
            let tree = get_tree_recursive(&token, &owner, &repo, &commit.tree_sha).await?;
            remote_tree_map(&tree)
        }
        None => BTreeMap::new(),
    };

    let (files, skipped_oversize) = enumerate_files(&dir, include_raw_sources, DEFAULT_MAX_BYTES)?;

    let mut entries: Vec<TreeEntryInput> = Vec::with_capacity(files.len());
    let mut pushed_files = Vec::new();

    for (rel, abs, _size) in &files {
        let content = std::fs::read(abs).map_err(|e| format!("read {rel}: {e}"))?;
        let local_sha = git_blob_sha1(&content);
        let blob_sha = match remote_map.get(rel) {
            // unchanged: reuse the existing remote blob sha, no upload
            Some(remote) if *remote == local_sha => remote.clone(),
            // new or changed: upload, then reference the fresh blob
            _ => {
                let b64 = B64.encode(&content);
                let sha = create_blob(&token, &owner, &repo, &b64).await?;
                pushed_files.push(rel.clone());
                sha
            }
        };
        entries.push(TreeEntryInput {
            path: rel.clone(),
            mode: "100644".to_string(),
            kind: "blob".to_string(),
            sha: blob_sha,
        });
    }

    // Nothing local? Avoid creating an empty tree that would wipe the repo —
    // only commit when there is at least one file in scope.
    if entries.is_empty() {
        let new_sha = remote_sha.unwrap_or_default();
        return Ok(BackupResult { new_sha, pushed_files, skipped_oversize, pulled_first });
    }

    let tree_sha = create_tree(&token, &owner, &repo, &entries).await?;
    let parents: Vec<String> = remote_sha.iter().cloned().collect();
    let msg = format!("LLMWiki backup {}", chrono::Utc::now().format("%Y-%m-%d %H:%M:%S UTC"));
    let new_commit = create_commit(&token, &owner, &repo, &msg, &tree_sha, &parents).await?;
    // Force only when we have no parent overlap concern; since parent is the
    // current remote tip (possibly after merge), a non-force update is a
    // fast-forward. Use force=false to refuse if the branch raced ahead.
    update_ref(&token, &owner, &repo, &branch, &new_commit, false).await?;

    Ok(BackupResult { new_sha: new_commit, pushed_files, skipped_oversize, pulled_first })
}

/// Internal pull-merge used by both the public pull command and the
/// pull-first step of backup. Applies the resolver per path and writes the
/// results into the working dir. Returns the reconciliation lists + the
/// remote sha that should become the new base.
async fn pull_merge_inner(
    token: &str,
    dir: &Path,
    owner: &str,
    repo: &str,
    branch: &str,
    include_raw_sources: bool,
    last_sync_sha: &str,
) -> Result<PullResult, String> {
    let remote_sha = match get_ref_sha(token, owner, repo, branch).await? {
        Some(s) => s,
        None => {
            // No remote branch yet → nothing to pull.
            return Ok(PullResult { new_sha: String::new(), changed_files: vec![], deleted_files: vec![], conflicts: vec![] });
        }
    };

    let remote_commit = get_commit(token, owner, repo, &remote_sha).await?;
    let remote_tree = get_tree_recursive(token, owner, repo, &remote_commit.tree_sha).await?;
    let remote_map = remote_tree_map(&remote_tree);
    let remote_epoch = remote_commit.epoch;

    // Base tree (from last_sync_sha) tells us what each side STARTED from.
    let base_map: BTreeMap<String, String> = if last_sync_sha.is_empty() {
        BTreeMap::new()
    } else {
        match get_commit(token, owner, repo, last_sync_sha).await {
            Ok(base_commit) => {
                let base_tree = get_tree_recursive(token, owner, repo, &base_commit.tree_sha).await?;
                remote_tree_map(&base_tree)
            }
            // base commit unreachable (history rewritten?) → treat as empty
            Err(_) => BTreeMap::new(),
        }
    };

    // Local working-dir blob shas.
    let (local_files, _skipped) = enumerate_files(dir, include_raw_sources, DEFAULT_MAX_BYTES)?;
    let mut local_map: BTreeMap<String, (PathBuf, String)> = BTreeMap::new();
    for (rel, abs, _size) in &local_files {
        let content = std::fs::read(abs).map_err(|e| format!("read {rel}: {e}"))?;
        local_map.insert(rel.clone(), (abs.clone(), git_blob_sha1(&content)));
    }

    // Union of all paths across base/local/remote.
    let mut all_paths: std::collections::BTreeSet<String> = std::collections::BTreeSet::new();
    all_paths.extend(base_map.keys().cloned());
    all_paths.extend(remote_map.keys().cloned());
    all_paths.extend(local_map.keys().cloned());

    let mut changed_files = Vec::new();
    let mut deleted_files = Vec::new();
    let mut conflicts = Vec::new();

    for path in all_paths {
        let state = PathState {
            base: base_map.get(&path).cloned(),
            local: local_map.get(&path).map(|(_, sha)| sha.clone()),
            remote: remote_map.get(&path).cloned(),
        };
        let local_mtime = local_map
            .get(&path)
            .map(|(abs, _)| file_mtime_epoch(abs))
            .unwrap_or(0);

        // A "conflict" for reporting purposes = both sides changed the same
        // path (the latest-wins tie-break fired). The action still resolves
        // it; we just surface it so the UI can flag it.
        let both_changed = state.local != state.base
            && state.remote != state.base
            && state.local.is_some()
            && state.remote.is_some()
            && state.local != state.remote;

        match resolve_merge(&state, local_mtime, remote_epoch) {
            MergeAction::TakeRemote => {
                let sha = remote_map.get(&path).ok_or("TakeRemote without remote sha")?;
                let bytes = get_blob(token, owner, repo, sha).await?;
                let abs = dir.join(&path);
                if let Some(parent) = abs.parent() {
                    std::fs::create_dir_all(parent).map_err(|e| format!("mkdir {}: {e}", parent.display()))?;
                }
                std::fs::write(&abs, &bytes).map_err(|e| format!("write {path}: {e}"))?;
                changed_files.push(path.clone());
                if both_changed {
                    conflicts.push(path.clone());
                }
            }
            MergeAction::DeleteLocal => {
                let abs = dir.join(&path);
                if abs.exists() {
                    let _ = std::fs::remove_file(&abs);
                }
                deleted_files.push(path.clone());
            }
            MergeAction::KeepLocal => {
                if both_changed {
                    // local won the tie but remote also changed → flag it
                    conflicts.push(path.clone());
                }
            }
            MergeAction::NoOp => {}
        }
    }

    Ok(PullResult {
        new_sha: remote_sha,
        changed_files,
        deleted_files,
        conflicts,
    })
}

/// Pull the remote branch into the working dir (three-way merge against
/// `last_sync_sha`). Returns the lists the frontend uses to refresh its UI.
#[tauri::command]
pub async fn github_pull_now(
    project_dir: String,
    owner: String,
    repo: String,
    branch: String,
    include_raw_sources: bool,
    last_sync_sha: String,
) -> Result<PullResult, String> {
    let token = require_token()?;
    let dir = PathBuf::from(&project_dir);
    pull_merge_inner(&token, &dir, &owner, &repo, &branch, include_raw_sources, &last_sync_sha).await
}

/// List recent versions (commits) on a branch for the history UI.
#[tauri::command]
pub async fn github_list_versions(owner: String, repo: String, branch: String, limit: u32) -> Result<Vec<CommitSummary>, String> {
    let token = require_token()?;
    let per_page = limit.clamp(1, 100);
    list_commits(&token, &owner, &repo, &branch, per_page).await
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RestoreResult {
    pub restored_files: Vec<String>,
}

/// Restore a specific commit's snapshot onto disk.
///
/// Writes every blob from that commit's tree into the working dir,
/// overwriting existing files. NOTE: this does NOT delete local files that
/// are absent from the snapshot — restoring an old version brings its files
/// back but leaves newer-only files in place. Run a fresh backup afterward to
/// capture the restored state as a new version. `include_raw_sources` filters
/// which restored paths are written (so a wiki-only device doesn't pull back
/// raw sources it never wanted).
#[tauri::command]
pub async fn github_restore_version(
    project_dir: String,
    owner: String,
    repo: String,
    sha: String,
    include_raw_sources: bool,
) -> Result<RestoreResult, String> {
    let token = require_token()?;
    let dir = PathBuf::from(&project_dir);

    let commit = get_commit(&token, &owner, &repo, &sha).await?;
    let tree = get_tree_recursive(&token, &owner, &repo, &commit.tree_sha).await?;

    let mut restored_files = Vec::new();
    for entry in &tree {
        if is_excluded(&entry.path, include_raw_sources) {
            continue;
        }
        let bytes = get_blob(&token, &owner, &repo, &entry.sha).await?;
        let abs = dir.join(&entry.path);
        if let Some(parent) = abs.parent() {
            std::fs::create_dir_all(parent).map_err(|e| format!("mkdir {}: {e}", parent.display()))?;
        }
        std::fs::write(&abs, &bytes).map_err(|e| format!("write {}: {e}", entry.path))?;
        restored_files.push(entry.path.clone());
    }

    Ok(RestoreResult { restored_files })
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ValidatePrepareResult {
    pub login: String,
    pub created: bool,
}

/// Validate the stored token AND make sure the target repo exists (creating
/// it private on first use). Used by the "Connect & set up" button.
#[tauri::command]
pub async fn github_validate_and_prepare(owner: String, repo: String, private: bool) -> Result<ValidatePrepareResult, String> {
    let token = require_token()?;
    let user = validate_token(&token).await?;
    let created = ensure_repo(&token, &owner, &repo, private).await?;
    Ok(ValidatePrepareResult { login: user.login, created })
}

// ---------------------------------------------------------------------------
// Token commands.
// ---------------------------------------------------------------------------

/// Save a PAT pasted by the user.
#[tauri::command]
pub fn github_save_token(token: String) -> Result<(), String> {
    save_github_token(token)
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TokenStatus {
    pub has_token: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub login: Option<String>,
}

/// Report whether a token is stored and, if so, whose it is (validated live).
#[tauri::command]
pub async fn github_token_status() -> Result<TokenStatus, String> {
    match get_github_token()? {
        None => Ok(TokenStatus { has_token: false, login: None }),
        Some(token) => match validate_token(&token).await {
            Ok(user) => Ok(TokenStatus { has_token: true, login: Some(user.login) }),
            // Stored but invalid/expired/offline — still report has_token so
            // the UI shows "connected (needs re-auth)" rather than "none".
            Err(_) => Ok(TokenStatus { has_token: true, login: None }),
        },
    }
}

/// Forget the stored token (sign out).
#[tauri::command]
pub fn github_clear_token() -> Result<(), String> {
    delete_github_token()
}

// ---------------------------------------------------------------------------
// Tests — pure helpers only (no network).
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicU64, Ordering};

    fn tmp_dir() -> PathBuf {
        static COUNTER: AtomicU64 = AtomicU64::new(0);
        let id = COUNTER.fetch_add(1, Ordering::SeqCst);
        let path = std::env::temp_dir().join(format!("llm-wiki-gh-test-{}-{id}", std::process::id()));
        let _ = std::fs::remove_dir_all(&path);
        std::fs::create_dir_all(&path).unwrap();
        path
    }

    fn write(root: &Path, rel: &str, content: &[u8]) {
        let p = root.join(rel);
        std::fs::create_dir_all(p.parent().unwrap()).unwrap();
        std::fs::write(p, content).unwrap();
    }

    #[test]
    fn blob_sha_matches_git_known_value() {
        // `git hash-object` of a file containing "hello\n".
        assert_eq!(git_blob_sha1(b"hello\n"), "ce013625030ba8dba906f756967f9e9ca394464a");
    }

    #[test]
    fn blob_sha_empty_matches_git() {
        // git's empty-blob id, a well-known constant.
        assert_eq!(git_blob_sha1(b""), "e69de29bb2d1d6434b8b29ae775ad8c2e48c5391");
    }

    #[test]
    fn scope_filter_always_excludes_local_and_cruft() {
        for raw in [true, false] {
            assert!(is_excluded(".llm-wiki-local/state.json", raw));
            assert!(is_excluded("raw/sources/.cache/x.bin", raw));
            assert!(is_excluded(".git/config", raw));
            assert!(is_excluded(".DS_Store", raw));
            assert!(is_excluded("wiki/.DS_Store", raw));
            assert!(is_excluded("node_modules/pkg/index.js", raw));
        }
    }

    #[test]
    fn scope_filter_raw_toggle() {
        // include_raw_sources = false → raw/ dropped, core kept
        assert!(is_excluded("raw/sources/doc.pdf", false));
        assert!(!is_excluded("wiki/concepts/a.md", false));
        assert!(!is_excluded("schema.md", false));
        assert!(!is_excluded("purpose.md", false));
        assert!(!is_excluded(".llm-wiki/config.json", false));

        // include_raw_sources = true → raw/ kept (except the always-cache)
        assert!(!is_excluded("raw/sources/doc.pdf", true));
        assert!(is_excluded("raw/sources/.cache/x.bin", true));
    }

    #[test]
    fn enumerate_splits_scope_and_size() {
        let root = tmp_dir();
        write(&root, "wiki/a.md", b"hello");
        write(&root, "schema.md", b"schema");
        write(&root, "raw/sources/doc.pdf", b"pdf-bytes");
        write(&root, ".llm-wiki-local/state.json", b"{}");
        write(&root, ".DS_Store", b"x");
        write(&root, "wiki/big.bin", &vec![0u8; 1024]);

        // max_bytes small enough that big.bin is oversize; raw excluded.
        let (files, skipped) = enumerate_files(&root, false, 512).unwrap();
        let rels: Vec<&str> = files.iter().map(|(r, _, _)| r.as_str()).collect();

        assert!(rels.contains(&"wiki/a.md"));
        assert!(rels.contains(&"schema.md"));
        assert!(!rels.contains(&"raw/sources/doc.pdf")); // raw excluded
        assert!(!rels.contains(&".llm-wiki-local/state.json"));
        assert!(!rels.contains(&".DS_Store"));
        assert!(!rels.contains(&"wiki/big.bin")); // oversize
        assert_eq!(skipped, vec!["wiki/big.bin".to_string()]);

        // include raw → pdf appears
        let (files2, _) = enumerate_files(&root, true, 512).unwrap();
        let rels2: Vec<&str> = files2.iter().map(|(r, _, _)| r.as_str()).collect();
        assert!(rels2.contains(&"raw/sources/doc.pdf"));

        let _ = std::fs::remove_dir_all(root);
    }

    // ---- conflict matrix --------------------------------------------------

    fn s(b: Option<&str>, l: Option<&str>, r: Option<&str>) -> PathState {
        PathState {
            base: b.map(|x| x.to_string()),
            local: l.map(|x| x.to_string()),
            remote: r.map(|x| x.to_string()),
        }
    }

    #[test]
    fn merge_changed_remote_only_takes_remote() {
        // base==local, remote differs
        let st = s(Some("A"), Some("A"), Some("B"));
        assert_eq!(resolve_merge(&st, 100, 200), MergeAction::TakeRemote);
    }

    #[test]
    fn merge_changed_local_only_keeps_local() {
        let st = s(Some("A"), Some("B"), Some("A"));
        assert_eq!(resolve_merge(&st, 100, 200), MergeAction::KeepLocal);
    }

    #[test]
    fn merge_both_changed_latest_wins() {
        let st = s(Some("A"), Some("L"), Some("R"));
        // remote newer → take remote
        assert_eq!(resolve_merge(&st, 100, 200), MergeAction::TakeRemote);
        // local newer → keep local
        assert_eq!(resolve_merge(&st, 300, 200), MergeAction::KeepLocal);
    }

    #[test]
    fn merge_identical_is_noop() {
        let st = s(Some("A"), Some("B"), Some("B"));
        assert_eq!(resolve_merge(&st, 100, 200), MergeAction::NoOp);
    }

    #[test]
    fn merge_new_remote_only_takes_remote() {
        let st = s(None, None, Some("R"));
        assert_eq!(resolve_merge(&st, 0, 200), MergeAction::TakeRemote);
    }

    #[test]
    fn merge_new_local_only_keeps_local() {
        let st = s(None, Some("L"), None);
        assert_eq!(resolve_merge(&st, 100, 0), MergeAction::KeepLocal);
    }

    #[test]
    fn merge_added_both_latest_wins() {
        let st = s(None, Some("L"), Some("R"));
        assert_eq!(resolve_merge(&st, 100, 200), MergeAction::TakeRemote);
        assert_eq!(resolve_merge(&st, 300, 200), MergeAction::KeepLocal);
    }

    #[test]
    fn merge_deleted_remote_unchanged_local_deletes() {
        // base has it, remote dropped it, local untouched
        let st = s(Some("A"), Some("A"), None);
        assert_eq!(resolve_merge(&st, 100, 200), MergeAction::DeleteLocal);
    }

    #[test]
    fn merge_deleted_remote_changed_local_latest_wins() {
        let st = s(Some("A"), Some("L"), None);
        // remote (delete) newer → DeleteLocal
        assert_eq!(resolve_merge(&st, 100, 200), MergeAction::DeleteLocal);
        // local (edit) newer → KeepLocal
        assert_eq!(resolve_merge(&st, 300, 200), MergeAction::KeepLocal);
    }

    #[test]
    fn merge_deleted_local_unchanged_remote_is_noop() {
        // we deleted locally, remote untouched → honor delete (push omits)
        let st = s(Some("A"), None, Some("A"));
        assert_eq!(resolve_merge(&st, 100, 200), MergeAction::NoOp);
    }

    #[test]
    fn merge_deleted_local_changed_remote_latest_wins() {
        let st = s(Some("A"), None, Some("R"));
        // remote edit newer → take remote (resurrect)
        assert_eq!(resolve_merge(&st, 100, 200), MergeAction::TakeRemote);
        // local delete newer → keep deleted (NoOp)
        assert_eq!(resolve_merge(&st, 300, 200), MergeAction::NoOp);
    }

    #[test]
    fn merge_both_absent_noop() {
        let st = s(Some("A"), None, None);
        assert_eq!(resolve_merge(&st, 100, 200), MergeAction::NoOp);
    }
}
