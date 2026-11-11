//! SQLite FTS5 BM25 keyword index for wiki pages (SAG2-style lexical arm).
//!
//! Replaces the hand-rolled per-file bonus scoring that walked every page and
//! matched bigram tokens. Chinese needs word segmentation for FTS5's
//! unicode61 tokenizer (which treats a CJK run as ONE token), so both the
//! index and the query go through jieba `cut_for_search` and are stored /
//! matched as space-joined tokens.
//!
//! Storage: `<project>/.llm-wiki/fts.db` (same directory convention as the
//! LanceDB vector store). Kept fresh on every search by a hash-gated sync
//! reusing the directory scan the graph arm already performs; unchanged
//! pages cost one sha256 compare each.
//!
//! Snippets are NOT served from the index (tokenized text would show word
//! seams), so callers re-read the page text — see `search.rs`.
//!
//! TODO(hooks): wiki page writes/deletes do not push into the index yet;
//! freshness comes entirely from the hash-gated sync on the search path.
//! Hooking `upsert`/`remove` into the fs.rs / agent write paths would move
//! the sha256 cost off search latency but is not required for correctness.

use std::collections::BTreeMap;
use std::path::Path;
use std::sync::LazyLock;

use rusqlite::{params, Connection};
use sha2::{Digest, Sha256};

/// BM25 column weights for (path, title, body, hash) — UNINDEXED columns
/// keep a weight slot but never match. Title matters ~5x more than body.
const TITLE_WEIGHT: f64 = 5.0;
const BODY_WEIGHT: f64 = 1.0;

pub struct FtsDoc<'a> {
    pub path: &'a str,
    pub title: &'a str,
    pub content: &'a str,
}

#[derive(Debug)]
pub struct FtsHit {
    pub path: String,
    /// Higher is better (negated FTS5 `bm25()` rank).
    pub score: f64,
    pub title_match: bool,
}

fn jieba_dict() -> &'static jieba_rs::Jieba {
    static JIEBA: LazyLock<jieba_rs::Jieba> = LazyLock::new(jieba_rs::Jieba::new);
    &JIEBA
}

pub fn hash_of(content: &str) -> String {
    let mut hasher = Sha256::new();
    hasher.update(content.as_bytes());
    format!("{:x}", hasher.finalize())
}

/// Segment text into lowercased FTS-safe tokens joined by spaces.
/// `cut_for_search` emits both whole words and sub-words so multi-character
/// queries match longer indexed runs (SAG2 pre-tokenization strategy).
fn tokenize(text: &str) -> String {
    jieba_dict()
        .cut_for_search(text, false)
        .iter()
        .map(|token| token.word.trim().to_lowercase())
        .filter(|token| {
            !token.is_empty()
                && token != " "
                && !crate::commands::search::is_stop_word(token)
                && token.chars().any(|c| c.is_alphanumeric())
        })
        .collect::<Vec<_>>()
        .join(" ")
}

/// Segmented query terms (longest first), used by the search layer to anchor
/// snippets on a term the page actually contains when the full query phrase
/// does not appear verbatim.
pub fn query_tokens(query: &str) -> Vec<String> {
    let mut tokens: Vec<String> = tokenize(query).split(' ').map(str::to_string).collect();
    tokens.sort_by(|a, b| b.chars().count().cmp(&a.chars().count()));
    tokens.dedup();
    tokens
}

fn quote_match_token(token: &str) -> String {
    format!("\"{}\"", token.replace('"', "\"\""))
}

/// FTS5 MATCH expression: OR over query tokens so BM25 ranks by aggregate
/// evidence instead of requiring every token (AND kills recall on long Qs).
fn build_match_expression(query: &str) -> Option<String> {
    let tokens = tokenize(query);
    let quoted: Vec<String> = tokens
        .split(' ')
        .filter(|token| !token.is_empty())
        .map(quote_match_token)
        .collect();
    (!quoted.is_empty()).then(|| quoted.join(" OR "))
}

pub fn open(project_path: &str) -> Result<Connection, String> {
    let dir = Path::new(&project_path.replace('\\', "/")).join(".llm-wiki");
    std::fs::create_dir_all(&dir).map_err(|e| format!("fts dir: {e}"))?;
    let conn = Connection::open(dir.join("fts.db")).map_err(|e| format!("fts open: {e}"))?;
    conn.busy_timeout(std::time::Duration::from_millis(1500))
        .map_err(|e| format!("fts busy timeout: {e}"))?;
    conn.execute_batch(
        "CREATE VIRTUAL TABLE IF NOT EXISTS pages_fts USING fts5(
            path UNINDEXED,
            title_tok,
            body_tok,
            hash UNINDEXED,
            tokenize='unicode61'
         );",
    )
    .map_err(|e| format!("fts schema: {e}"))?;
    Ok(conn)
}

/// Bring the index in sync with the current page set (hash-gated upserts,
/// deletes for vanished pages). `docs` is the complete current scan when
/// `complete`; if the caller truncated its walk (MAX_SEARCH_FILES), missing
/// entries are kept so a capped scan never churns the index.
pub fn sync(conn: &Connection, docs: &[FtsDoc<'_>], complete: bool) -> Result<(), String> {
    let mut stored: BTreeMap<String, String> = BTreeMap::new();
    {
        let mut stmt = conn
            .prepare("SELECT path, hash FROM pages_fts")
            .map_err(|e| format!("fts read hashes: {e}"))?;
        let rows = stmt
            .query_map([], |row| Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?)))
            .map_err(|e| format!("fts read hashes: {e}"))?;
        for row in rows.flatten() {
            stored.insert(row.0, row.1);
        }
    }
    let tx = conn
        .unchecked_transaction()
        .map_err(|e| format!("fts tx: {e}"))?;
    let mut present: std::collections::BTreeSet<&str> = std::collections::BTreeSet::new();
    for doc in docs {
        present.insert(doc.path);
        let hash = hash_of(doc.content);
        if stored.get(doc.path).is_some_and(|old| *old == hash) {
            continue;
        }
        tx.execute(
            "DELETE FROM pages_fts WHERE path = ?1",
            params![doc.path],
        )
        .map_err(|e| format!("fts delete stale: {e}"))?;
        tx.execute(
            "INSERT INTO pages_fts(path, title_tok, body_tok, hash) VALUES (?1, ?2, ?3, ?4)",
            params![doc.path, tokenize(doc.title), tokenize(doc.content), hash],
        )
        .map_err(|e| format!("fts insert: {e}"))?;
    }
    if complete {
        for missing in stored.keys().filter(|path| !present.contains(path.as_str())) {
            tx.execute("DELETE FROM pages_fts WHERE path = ?1", params![missing])
                .map_err(|e| format!("fts delete removed: {e}"))?;
        }
    }
    tx.commit().map_err(|e| format!("fts commit: {e}"))
}

/// BM25-ranked search. Returns hits best-first with `title_match` set when
/// the page also matches on the title column. Errors (e.g. a malformed
/// expression) are logged and treated as zero keyword hits so a broken index
/// never takes down vector/graph search.
pub fn search(conn: &Connection, query: &str, limit: usize) -> Vec<FtsHit> {
    let Some(expr) = build_match_expression(query) else {
        return Vec::new();
    };
    let weights = format!("0.0, {TITLE_WEIGHT}, {BODY_WEIGHT}, 0.0");
    let title_expr = format!("title_tok : ( {expr} )");
    let mut title_paths: std::collections::BTreeSet<String> = std::collections::BTreeSet::new();
    if let Ok(mut stmt) = conn.prepare("SELECT path FROM pages_fts WHERE pages_fts MATCH ?1") {
        if let Ok(rows) = stmt.query_map(params![title_expr], |row| row.get::<_, String>(0)) {
            for row in rows.flatten() {
                title_paths.insert(row);
            }
        }
    }
    let sql = format!(
        "SELECT path, bm25(pages_fts, {weights}) FROM pages_fts
         WHERE pages_fts MATCH ?1 ORDER BY bm25(pages_fts, {weights}) ASC LIMIT ?2"
    );
    let mut stmt = match conn.prepare(&sql) {
        Ok(stmt) => stmt,
        Err(err) => {
            eprintln!("[Fts] search failed, skipping keyword arm: {err}");
            return Vec::new();
        }
    };
    let rows = match stmt.query_map(params![expr, limit as i64], |row| {
        Ok((row.get::<_, String>(0)?, row.get::<_, f64>(1)?))
    }) {
        Ok(rows) => rows,
        Err(err) => {
            eprintln!("[Fts] query failed, skipping keyword arm: {err}");
            return Vec::new();
        }
    };
    rows.flatten()
        .map(|(path, rank)| FtsHit {
            score: -rank,
            title_match: title_paths.contains(&path),
            path,
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    fn temp_project() -> (Connection, std::path::PathBuf) {
        let root = std::env::temp_dir().join(format!("llmwiki-fts-{}", uuid::Uuid::new_v4()));
        fs::create_dir_all(&root).unwrap();
        let conn = open(root.to_str().unwrap()).unwrap();
        (conn, root)
    }

    #[test]
    fn sync_then_search_ranks_title_match_first() {
        let (conn, root) = temp_project();
        let docs = vec![
            FtsDoc {
                path: "wiki/a.md",
                title: "Attention",
                content: "body mentions attention only in passing.",
            },
            FtsDoc {
                path: "wiki/b.md",
                title: "Random",
                content: "attention is mentioned briefly.",
            },
        ];
        sync(&conn, &docs, true).unwrap();
        let hits = search(&conn, "attention", 10);
        assert_eq!(hits[0].path, "wiki/a.md");
        assert!(hits[0].title_match);
        assert!(!hits[1].title_match);
        fs::remove_dir_all(root).ok();
    }

    #[test]
    fn cjk_query_matches_page_through_jieba_segmentation() {
        let (conn, root) = temp_project();
        let docs = vec![
            FtsDoc {
                path: "wiki/tacit.md",
                title: "默会知识",
                content: "默会知识强调难以言明的实践经验。",
            },
            FtsDoc {
                path: "wiki/other.md",
                title: "显性知识",
                content: "显性知识可以清晰表述。",
            },
        ];
        sync(&conn, &docs, true).unwrap();
        let hits = search(&conn, "知识", 10);
        assert_eq!(hits.len(), 2);
        // Query tokens are OR-fused by BM25; the segmented-phrase page must
        // rank first, and a page-only term must recall exactly one page.
        let hits = search(&conn, "默会知识强调", 10);
        assert_eq!(hits[0].path, "wiki/tacit.md");
        let hits = search(&conn, "实践经验", 10);
        assert_eq!(hits.len(), 1);
        assert_eq!(hits[0].path, "wiki/tacit.md");
        fs::remove_dir_all(root).ok();
    }

    #[test]
    fn sync_upserts_changed_and_deletes_removed_pages() {
        let (conn, root) = temp_project();
        let v1 = "markeralpha content";
        sync(
            &conn,
            &[FtsDoc {
                path: "wiki/x.md",
                title: "X",
                content: v1,
            }],
            true,
        )
        .unwrap();
        assert_eq!(search(&conn, "markeralpha", 10).len(), 1);

        // Page edited: old marker gone, new marker found.
        sync(
            &conn,
            &[FtsDoc {
                path: "wiki/x.md",
                title: "X",
                content: "markerbeta content",
            }],
            true,
        )
        .unwrap();
        assert!(search(&conn, "markeralpha", 10).is_empty());
        assert_eq!(search(&conn, "markerbeta", 10).len(), 1);

        // Page deleted from disk.
        sync(&conn, &[], true).unwrap();
        assert!(search(&conn, "markerbeta", 10).is_empty());
        fs::remove_dir_all(root).ok();
    }
}
