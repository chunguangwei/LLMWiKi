//! JEV evidence-scoring client (SAG2 retrieval arm).
//!
//! Speaks the typesafe/Jev `state + questions -> answers.*.noul` protocol,
//! which both the official OpenRouter decisions endpoint and self-hosted
//! deployments (e.g. Kev-4B behind `/v1/systemone`) implement. One abstract
//! client; the config selects the wire target only.
//!
//! Constraints honored from the Kev-4B self-host manual:
//! - self-hosted servers process one request at a time → per-provider concurrency cap;
//! - state is hard-capped (8192 tokens incl. questions) and accuracy degrades
//!   past ~384 tokens → chunks are truncated before sending;
//! - scores are probabilities, not binary labels → callers fuse them via RRF,
//!   never threshold-gate recall here.

use std::collections::BTreeMap;
use std::sync::{Arc, LazyLock, Mutex};
use std::time::{Duration, Instant};

use serde::{Deserialize, Serialize};
use tokio::sync::Semaphore;

/// Max characters of a chunk sent as `state` (~2000 CJK chars ≈ well under the
/// 8192-token hard cap and the ~384-token accuracy sweet spot per question).
const STATE_CHAR_CAP: usize = 2000;

/// Consecutive fully-failed scoring batches (per provider+base_url) before the
/// JEV arm is treated as unavailable and skipped without any network attempt —
/// i.e. search drops to the traditional LLM Wiki retrieval (BM25 + vector +
/// graph) for the whole cooldown instead of re-paying per-request timeouts.
const CIRCUIT_OPEN_AFTER: u32 = 3;
/// How long a failed JEV endpoint stays skipped before one probe batch may
/// retry (a recovered server costs at most one slow search).
const CIRCUIT_COOLDOWN: Duration = Duration::from_secs(60);

static CIRCUITS: LazyLock<Mutex<BTreeMap<(String, String), Circuit>>> =
    LazyLock::new(|| Mutex::new(BTreeMap::new()));

struct Circuit {
    consecutive_failures: u32,
    open_until: Option<Instant>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct JevConfig {
    #[serde(default)]
    pub enabled: bool,
    /// "openrouter" | "custom"
    #[serde(default = "default_provider")]
    pub provider: String,
    #[serde(default)]
    pub base_url: String,
    #[serde(default)]
    pub model: String,
    #[serde(default)]
    pub api_key: String,
    /// "bearer" | "none"
    #[serde(default = "default_auth")]
    pub auth: String,
}

fn default_provider() -> String {
    "openrouter".to_string()
}
fn default_auth() -> String {
    "bearer".to_string()
}

impl JevConfig {
    pub fn is_usable(&self) -> bool {
        self.enabled
            && !self.base_url.trim().is_empty()
            && !self.model.trim().is_empty()
            && (self.auth == "none" || !self.api_key.trim().is_empty())
    }

    fn request_timeout(&self) -> Duration {
        if self.provider == "openrouter" {
            Duration::from_secs(8)
        } else {
            // Serial self-hosted server (p95 ~170ms): a slow request means
            // queueing; fail fast and let the caller fall back to BM25 order.
            Duration::from_secs(2)
        }
    }

    fn concurrency_permits(&self) -> usize {
        // Kev-style self-hosted deployments process one request at a time.
        if self.provider == "openrouter" { 8 } else { 1 }
    }
}

/// Resolve a user-supplied base URL to the concrete scoring endpoint.
/// Accepts app root, `/v1`, or a full `/systemone` or `/decisions` endpoint
/// (same resolution rules SAG-Wiki uses for custom Jev services).
pub fn resolve_endpoint(base_url: &str) -> String {
    let base = base_url.trim().trim_end_matches('/');
    if base.ends_with("/systemone") || base.ends_with("/decisions") {
        base.to_string()
    } else if base.ends_with("/v1") {
        format!("{base}/systemone")
    } else {
        format!("{base}/v1/systemone")
    }
}

fn client() -> Result<reqwest::Client, String> {
    reqwest::Client::builder()
        .use_rustls_tls()
        .build()
        .map_err(|e| format!("HTTP client error: {e}"))
}

fn apply_auth(req: reqwest::RequestBuilder, cfg: &JevConfig) -> reqwest::RequestBuilder {
    if cfg.auth != "none" && !cfg.api_key.trim().is_empty() {
        req.bearer_auth(cfg.api_key.trim())
    } else {
        req
    }
}

fn question_body() -> serde_json::Value {
    serde_json::json!({
        "evidence": {
            "type": "noul",
            "instructions": "Does this passage provide necessary evidence for answering the question in the state context?",
        }
    })
}

/// One evidence-score call: state = "{query}\n\n{chunk}" so the judgment is
/// grounded against the original question (SAG2 noul semantics).
async fn score_one(
    cfg: &JevConfig,
    endpoint: &str,
    query: &str,
    chunk: &str,
) -> Result<f32, String> {
    let truncated: String = chunk.chars().take(STATE_CHAR_CAP).collect();
    let state = format!("Question: {query}\n\nPassage: {truncated}");
    let body = serde_json::json!({
        "state": state,
        "model": cfg.model,
        "questions": question_body(),
    });
    let resp = apply_auth(client()?.post(endpoint).json(&body), cfg)
        .timeout(cfg.request_timeout())
        .send()
        .await
        .map_err(|e| format!("jev request failed: {e}"))?;
    let status = resp.status();
    let request_id = resp
        .headers()
        .get("x-typesafe-request-id")
        .and_then(|v| v.to_str().ok())
        .unwrap_or("")
        .to_string();
    if status == reqwest::StatusCode::UNPROCESSABLE_ENTITY {
        return Err(format!("jev 422 invalid request (request-id {request_id})"));
    }
    if !status.is_success() {
        return Err(format!("jev HTTP {status} (request-id {request_id})"));
    }
    let json: serde_json::Value = resp
        .json()
        .await
        .map_err(|e| format!("jev bad JSON: {e}"))?;
    // Response shapes: { "evidence": {"noul": p} } (SAG2/Kev) with some
    // deployments nesting under "nouls"/"answers".
    for key in ["evidence"] {
        for container in [&json, &json["nouls"], &json["answers"]] {
            if let Some(p) = container.get(key).and_then(|v| v.get("noul")).and_then(|v| v.as_f64()) {
                return Ok(p.clamp(0.0, 1.0) as f32);
            }
        }
    }
    Err(format!("jev response missing evidence.noul (request-id {request_id})"))
}

/// Score `chunks` against `query`. Returns `None` when JEV is unusable, the
/// circuit is open (endpoint repeatedly failing → traditional retrieval for
/// the cooldown), or the whole batch failed (caller keeps BM25 order).
/// Partial failures yield 0.0 for the failed chunk.
pub async fn score_candidates(
    cfg: &JevConfig,
    query: &str,
    chunks: &[String],
) -> Option<Vec<f32>> {
    if !cfg.is_usable() || chunks.is_empty() {
        return None;
    }
    if circuit_is_open(cfg) {
        return None;
    }
    let endpoint = resolve_endpoint(&cfg.base_url);
    let permits = Arc::new(Semaphore::new(cfg.concurrency_permits()));
    let mut handles = Vec::with_capacity(chunks.len());
    for chunk in chunks.iter() {
        let cfg = cfg.clone();
        let endpoint = endpoint.clone();
        let query = query.to_string();
        let chunk = chunk.clone();
        let permits = Arc::clone(&permits);
        handles.push(tokio::spawn(async move {
            let _permit = permits.acquire().await.expect("semaphore closed");
            score_one(&cfg, &endpoint, &query, &chunk).await
        }));
    }
    let mut out = Vec::with_capacity(chunks.len());
    let mut answered = 0usize;
    let mut evidence = false;
    for h in handles {
        match h.await {
            Ok(Ok(score)) => {
                answered += 1;
                if score > 0.0 {
                    evidence = true;
                }
                out.push(score);
            }
            // transport/HTTP/parse failure → neutral 0.0 for this chunk
            Ok(Err(_)) | Err(_) => out.push(0.0),
        }
    }
    // The circuit tracks service availability only: every request erroring is
    // "unreachable". A healthy server legitimately returning all-zero noul
    // scores (no relevant evidence) must not open it.
    if answered == 0 {
        record_batch_failure(cfg);
    } else {
        record_batch_success(cfg);
    }
    if evidence {
        Some(out)
    } else {
        None
    }
}

fn circuit_key(cfg: &JevConfig) -> (String, String) {
    (cfg.provider.clone(), cfg.base_url.trim().to_lowercase())
}

fn circuit_is_open(cfg: &JevConfig) -> bool {
    let key = circuit_key(cfg);
    let circuits = CIRCUITS.lock().unwrap_or_else(|p| p.into_inner());
    circuits
        .get(&key)
        .and_then(|c| c.open_until)
        .is_some_and(|until| Instant::now() < until)
}

fn record_batch_failure(cfg: &JevConfig) {
    let key = circuit_key(cfg);
    let mut circuits = CIRCUITS.lock().unwrap_or_else(|p| p.into_inner());
    let circuit = circuits.entry(key).or_insert(Circuit {
        consecutive_failures: 0,
        open_until: None,
    });
    circuit.consecutive_failures += 1;
    if circuit.consecutive_failures >= CIRCUIT_OPEN_AFTER {
        circuit.open_until = Some(Instant::now() + CIRCUIT_COOLDOWN);
        eprintln!(
            "[JEV] scoring endpoint failing; skipping evidence arm for {}s (traditional retrieval)",
            CIRCUIT_COOLDOWN.as_secs()
        );
    }
}

fn record_batch_success(cfg: &JevConfig) {
    let key = circuit_key(cfg);
    let mut circuits = CIRCUITS.lock().unwrap_or_else(|p| p.into_inner());
    if let Some(circuit) = circuits.get_mut(&key) {
        *circuit = Circuit {
            consecutive_failures: 0,
            open_until: None,
        };
    }
}

/// Health probe used by the Settings "Test connection" button.
/// Typesafe-style servers (Kev and other `/v1` deployments) expose
/// `GET /v1/models` as the documented auth/connectivity check (manual §5) —
/// use it so a probe never burns a slot on a serial scoring server nor
/// false-negatives on gateways that only pass the GET. Official
/// `/decisions`-style endpoints have no models route, so fall back to one
/// minimal noul round-trip.
#[tauri::command]
pub async fn jev_health_check(config: JevConfig) -> Result<String, String> {
    if !config.is_usable() {
        return Err("JEV not configured: need base URL, model, and API key (unless auth=none)".into());
    }
    let timeout = config.request_timeout().max(Duration::from_secs(5));
    if !config.base_url.trim().ends_with("/decisions") {
        let root = config
            .base_url
            .trim()
            .trim_end_matches('/')
            .trim_end_matches("/systemone")
            .trim_end_matches("/v1")
            .trim_end_matches('/');
        let url = format!("{root}/v1/models");
        let resp = apply_auth(client()?.get(&url), &config)
            .timeout(timeout)
            .send()
            .await
            .map_err(|e| format!("request failed: {e}"))?;
        let status = resp.status();
        let request_id = request_id_of(&resp);
        if !status.is_success() {
            let text = resp.text().await.unwrap_or_default();
            let snippet: String = text.chars().take(200).collect();
            return Err(format!("HTTP {status} (request-id {request_id}): {snippet}"));
        }
        let body: serde_json::Value = resp
            .json()
            .await
            .map_err(|e| format!("models returned bad JSON: {e}"))?;
        let models = body
            .get("data")
            .or_else(|| body.get("models"))
            .and_then(|v| v.as_array())
            .map(|items| {
                items
                    .iter()
                    .filter_map(|item| item.get("id").and_then(|v| v.as_str()))
                    .collect::<Vec<_>>()
                    .join(", ")
            })
            .unwrap_or_default();
        // A successful probe proves the endpoint is back; let the next search
        // try the evidence arm again instead of waiting out the cooldown.
        record_batch_success(&config);
        return Ok(if models.is_empty() {
            format!("JEV reachable via GET {url} (request-id {request_id})")
        } else {
            format!("JEV reachable via GET {url}; models: {models}")
        });
    }
    let endpoint = resolve_endpoint(&config.base_url);
    let body = serde_json::json!({
        "state": "connection probe",
        "model": config.model,
        "questions": { "ok": { "type": "noul" } },
    });
    let resp = apply_auth(client()?.post(&endpoint).json(&body), &config)
        .timeout(timeout)
        .send()
        .await
        .map_err(|e| format!("request failed: {e}"))?;
    let status = resp.status();
    let request_id = request_id_of(&resp);
    if !status.is_success() {
        let text = resp.text().await.unwrap_or_default();
        let snippet: String = text.chars().take(200).collect();
        return Err(format!("HTTP {status} (request-id {request_id}): {snippet}"));
    }
    record_batch_success(&config);
    Ok(format!("JEV reachable via {endpoint} (request-id {request_id})"))
}

fn request_id_of(resp: &reqwest::Response) -> String {
    resp.headers()
        .get("x-typesafe-request-id")
        .and_then(|v| v.to_str().ok())
        .unwrap_or("n/a")
        .to_string()
}

#[cfg(test)]
mod health_tests {
    use super::*;

    #[test]
    fn models_url_derivation_covers_accepted_forms() {
        for base in [
            "https://host/kev-4b",
            "https://host/kev-4b/v1",
            "https://host/kev-4b/v1/systemone",
            "https://host/kev-4b/v1/systemone/",
        ] {
            let root = base
                .trim_end_matches('/')
                .trim_end_matches("/systemone")
                .trim_end_matches("/v1")
                .trim_end_matches('/');
            assert_eq!(format!("{root}/v1/models"), "https://host/kev-4b/v1/models", "base {base}");
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn endpoint_resolution_covers_all_accepted_forms() {
        assert_eq!(
            resolve_endpoint("https://host/kev-4b"),
            "https://host/kev-4b/v1/systemone"
        );
        assert_eq!(
            resolve_endpoint("https://host/kev-4b/v1"),
            "https://host/kev-4b/v1/systemone"
        );
        assert_eq!(
            resolve_endpoint("https://host/kev-4b/v1/systemone"),
            "https://host/kev-4b/v1/systemone"
        );
        assert_eq!(
            resolve_endpoint("https://openrouter.ai/api/alpha/decisions"),
            "https://openrouter.ai/api/alpha/decisions"
        );
        assert_eq!(
            resolve_endpoint("https://host/kev-4b/"),
            "https://host/kev-4b/v1/systemone"
        );
    }

    #[test]
    fn usability_requires_key_unless_auth_none() {
        let base = JevConfig {
            enabled: true,
            provider: "custom".into(),
            base_url: "https://h/kev-4b".into(),
            model: "kev-latest".into(),
            api_key: "".into(),
            auth: "bearer".into(),
        };
        assert!(!base.is_usable());
        assert!(JevConfig { api_key: "k".into(), ..base.clone() }.is_usable());
        assert!(JevConfig { auth: "none".into(), ..base.clone() }.is_usable());
        assert!(!JevConfig { enabled: false, ..base.clone() }.is_usable());
    }

    #[test]
    fn disabled_config_skips_scoring_without_network() {
        let cfg = JevConfig {
            enabled: false,
            provider: "custom".into(),
            base_url: "http://127.0.0.1:1".into(),
            model: "m".into(),
            api_key: "k".into(),
            auth: "bearer".into(),
        };
        let rt = tokio::runtime::Builder::new_current_thread().build().unwrap();
        assert!(rt.block_on(score_candidates(&cfg, "q", &[chunk("x")])).is_none());
    }

    #[test]
    fn unreachable_server_yields_none_not_error() {
        let cfg = JevConfig {
            enabled: true,
            provider: "custom".into(),
            base_url: "http://127.0.0.1:9".into(), // discard port, instant refuse
            model: "m".into(),
            api_key: "k".into(),
            auth: "bearer".into(),
        };
        record_batch_success(&cfg); // isolate from shared circuit state
        let rt = tokio::runtime::Builder::new_current_thread().enable_all().build().unwrap();
        assert!(rt.block_on(score_candidates(&cfg, "q", &[chunk("p")])).is_none());
    }

    fn unreachable_cfg(port: u16) -> JevConfig {
        JevConfig {
            enabled: true,
            provider: "custom".into(),
            base_url: format!("http://127.0.0.1:{port}"),
            model: "m".into(),
            api_key: "k".into(),
            auth: "bearer".into(),
        }
    }

    #[test]
    fn repeated_unreachable_batches_open_the_circuit_skipping_the_arm() {
        let cfg = unreachable_cfg(12); // discard port, instant refuse
        record_batch_success(&cfg);
        let rt = tokio::runtime::Builder::new_current_thread().enable_all().build().unwrap();
        for _ in 0..CIRCUIT_OPEN_AFTER {
            assert!(rt.block_on(score_candidates(&cfg, "q", &[chunk("p")])).is_none());
        }
        // Traditional retrieval mode from here: arm is skipped without network.
        assert!(circuit_is_open(&cfg));
        assert!(rt.block_on(score_candidates(&cfg, "q", &[chunk("p")])).is_none());
        // A successful health probe (or batch) closes it again.
        record_batch_success(&cfg);
        assert!(!circuit_is_open(&cfg));
    }

    #[test]
    fn single_failure_does_not_open_the_circuit() {
        let cfg = unreachable_cfg(13);
        record_batch_success(&cfg);
        let rt = tokio::runtime::Builder::new_current_thread().enable_all().build().unwrap();
        assert!(rt.block_on(score_candidates(&cfg, "q", &[chunk("p")])).is_none());
        assert!(!circuit_is_open(&cfg));
    }

    fn chunk(s: &str) -> String {
        s.to_string()
    }
}
