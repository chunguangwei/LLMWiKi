mod api_server;
mod clip_server;
mod commands;
mod panic_guard;
mod proxy;
mod tray;
mod types;

use panic_guard::run_guarded;
use std::sync::Mutex;
use tauri::Manager;

// Close-to-tray behavior, ported from upstream 0e292ee. Holds the
// user's title-bar-close preference ("ask" | "minimize" | "exit") so
// the on_window_event handler (which has no access to the frontend
// store) can decide what to do. Seeded to "ask" in `.setup()` and kept
// in sync from the frontend via the `set_close_behavior` command +
// the persisted generalConfig (see src/lib/project-store.ts).
struct CloseBehaviorState(Mutex<String>);

#[tauri::command]
fn clip_server_status() -> String {
    run_guarded("clip_server_status", || {
        Ok(clip_server::get_daemon_status().to_string())
    })
    .unwrap_or_else(|e| format!("error: {e}"))
}

#[tauri::command]
fn api_server_status() -> String {
    run_guarded("api_server_status", || {
        Ok(api_server::get_api_status().to_string())
    })
    .unwrap_or_else(|e| format!("error: {e}"))
}

#[tauri::command]
fn api_server_reload_config() -> String {
    run_guarded("api_server_reload_config", || {
        api_server::invalidate_config_cache();
        Ok("ok".to_string())
    })
    .unwrap_or_else(|e| format!("error: {e}"))
}

/// Resolve the absolute path to the bundled MCP server entry
/// (`mcp-server/dist/src/index.js`) so the Settings UI can show a ready
/// MCP client config. Searches dev-repo layouts (CARGO_MANIFEST_DIR and
/// cwd, walking up a couple levels) first, then the packaged Tauri
/// resource dir, then the executable dir / macOS `.app/Resources`. This
/// mirrors how the bundled resource is mapped in the per-platform
/// `tauri.*.conf.json` files (`../mcp-server/dist` → `mcp-server/dist`).
#[tauri::command]
fn mcp_server_entry_path(app: tauri::AppHandle) -> Result<String, String> {
    run_guarded("mcp_server_entry_path", || {
        let relative = std::path::Path::new("mcp-server")
            .join("dist")
            .join("src")
            .join("index.js");
        let mut candidates = Vec::new();

        let mut push_repo_candidates = |base: std::path::PathBuf| {
            candidates.push(base.join(&relative));
            candidates.push(base.join("..").join(&relative));
            candidates.push(base.join("..").join("..").join(&relative));
        };

        push_repo_candidates(std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR")));
        if let Ok(cwd) = std::env::current_dir() {
            push_repo_candidates(cwd);
        }
        if let Ok(resource_dir) = app.path().resource_dir() {
            candidates.push(resource_dir.join(&relative));
        }
        if let Ok(exe) = std::env::current_exe() {
            if let Some(exe_dir) = exe.parent() {
                candidates.push(exe_dir.join(&relative));
                candidates.push(exe_dir.join("..").join("Resources").join(&relative));
            }
        }

        for candidate in &candidates {
            if candidate.is_file() {
                return Ok(candidate
                    .canonicalize()
                    .unwrap_or_else(|_| candidate.clone())
                    .to_string_lossy()
                    .into_owned());
            }
        }

        Err("MCP server entry was not found. Run `npm run mcp:build` from the LLM Wiki repository, then reopen Settings.".to_string())
    })
}

/// Apply a proxy configuration to the process env immediately, so the
/// next outbound HTTP request picks it up without needing the user to
/// restart the app. tauri-plugin-http builds a fresh
/// `reqwest::ClientBuilder` per fetch and reqwest's `auto_sys_proxy`
/// re-reads HTTP_PROXY / HTTPS_PROXY / NO_PROXY each time, so updating
/// these env vars is sufficient to flip the proxy on/off live.
///
/// Returns the same human-readable summary `apply_proxy_env` produces
/// for logging.
#[tauri::command]
fn set_proxy_env(config: proxy::ProxyConfig) -> String {
    let summary = proxy::apply_proxy_env(&config);
    eprintln!("[proxy] live update: {summary}");
    summary
}

/// Update the cached close-to-tray behavior (ported from upstream
/// 0e292ee). The frontend calls this whenever the user saves
/// Settings → General and once on startup to hydrate from the
/// persisted config, so the window-close handler below always sees the
/// current preference. Rejects unknown values so a malformed IPC call
/// can't leave the app in an undefined close mode.
#[tauri::command]
fn set_close_behavior(
    value: String,
    state: tauri::State<'_, CloseBehaviorState>,
) -> Result<String, String> {
    let normalized = match value.as_str() {
        "ask" | "minimize" | "exit" => value,
        other => return Err(format!("Invalid close behavior: {other}")),
    };
    let mut guard = state
        .0
        .lock()
        .map_err(|_| "Close behavior state is unavailable".to_string())?;
    *guard = normalized.clone();
    Ok(normalized)
}

/// Read the current close behavior, defaulting to "ask" if the lock is
/// poisoned. Used by the on_window_event handler, which runs outside an
/// async command and so can't take `tauri::State` directly.
fn close_behavior<R: tauri::Runtime>(window: &tauri::Window<R>) -> String {
    window
        .state::<CloseBehaviorState>()
        .0
        .lock()
        .map(|value| value.clone())
        .unwrap_or_else(|_| "ask".to_string())
}

// IDENTIFIER LOCK: the bundle identifier in tauri.conf.json
// (com.llmwiki.app) is load-bearing — it scopes the OS app-data dir
// (macOS: ~/Library/Application Support/<identifier>/app-state.json)
// where all config + API keys live, AND the keyring service name in
// commands/config_backup.rs. Changing it orphans every user's config
// and decryption key. Do NOT change it. Locked since 0.4.10.
#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let mut builder = tauri::Builder::default();

    // Single-instance guard MUST be the first plugin registered. When a
    // second copy launches (e.g. the user relaunches after an abnormal
    // exit left an orphaned process still holding ports 19827/19828),
    // the secondary exits inside this plugin's setup — before it ever
    // reaches start_clip_server() in .setup() below — and the primary's
    // window is shown/focused instead. This stops two instances from
    // fighting over the clip/API server ports.
    #[cfg(desktop)]
    {
        builder = builder.plugin(tauri_plugin_single_instance::init(|app, _argv, _cwd| {
            use tauri::Manager;
            if let Some(window) = app.get_webview_window("main") {
                let _ = window.show();
                let _ = window.unminimize();
                let _ = window.set_focus();
            }
        }));
    }

    builder
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_store::Builder::default().build())
        // Launch-at-startup, ported from upstream 0e292ee. Registers an
        // OS-level auto-launch entry (macOS LaunchAgent / Windows
        // registry Run key / Linux .desktop autostart) toggled from
        // Settings → General. No autostart args; the app reads its
        // own persisted config on launch.
        .plugin(tauri_plugin_autostart::init(
            tauri_plugin_autostart::MacosLauncher::LaunchAgent,
            None::<Vec<&str>>,
        ))
        // In-place auto-update + relaunch. The updater fetches the
        // signed latest.json from our GitHub releases (endpoint +
        // pubkey in tauri.conf.json) and replaces the app in place,
        // so the OS app-data dir (config + keys) is never touched.
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_process::init())
        // Rust-backed fetch so third-party LLM APIs that reject
        // browser-origin headers via CORS preflight (MiniMax, Volcengine
        // Ark's api/coding/v3, etc.) still work. Requests leave the app
        // from Rust, never the webview.
        .plugin(tauri_plugin_http::init())
        .setup(|app| {
            // Start the web-clip server here (not before the builder) so a
            // secondary instance — which the single-instance plugin exits
            // before reaching this setup hook — never tries to bind the
            // clip port out from under the primary.
            clip_server::start_clip_server();
            // Config safety net — runs BEFORE anything reads
            // app-state.json (proxy config below, and the frontend's
            // first store load). On a fresh/empty install, restore the
            // encrypted backup from ~/Documents/LLMWiki/; then refresh
            // the backup to capture the current state. Best-effort: a
            // keychain prompt decline or headless env must never block
            // startup.
            {
                let h = app.handle().clone();
                match commands::config_backup::restore_if_empty(&h) {
                    Ok(true) => eprintln!("[config-backup] restored config from encrypted backup"),
                    Ok(false) => {}
                    Err(e) => eprintln!("[config-backup] restore skipped: {e}"),
                }
                if let Err(e) = commands::config_backup::auto_backup(&h) {
                    eprintln!("[config-backup] backup skipped: {e}");
                }
            }
            // Let the PDF extractor find the bundled pdfium dynamic
            // library via Tauri's platform-correct resource path.
            if let Ok(dir) = app.path().resource_dir() {
                commands::fs::set_resource_dir_hint(dir);
            }
            // Apply user-configured global HTTP proxy by setting
            // HTTP_PROXY / HTTPS_PROXY / NO_PROXY env vars BEFORE
            // any HTTP request is made. tauri-plugin-http's reqwest
            // client reads these on first construction. Lives next
            // to the resource-dir hint so the proxy applies to
            // everything: LLM, embedding, update check, deep
            // research, captioning. See src-tauri/src/proxy.rs.
            if let Ok(dir) = app.path().app_data_dir() {
                let store_path = dir.join("app-state.json");
                eprintln!("[proxy] reading from {}", store_path.display());
                if let Some(cfg) = proxy::read_proxy_config_from_store(&store_path) {
                    let summary = proxy::apply_proxy_env(&cfg);
                    eprintln!("[proxy] {summary}");
                } else {
                    eprintln!("[proxy] no proxyConfig in store, requests go direct");
                }
            } else {
                eprintln!("[proxy] could not resolve app_data_dir");
            }
            // Registry of running `claude` subprocesses, keyed by the
            // frontend-generated stream id. Populated by claude_cli_spawn,
            // drained on process exit or by claude_cli_kill.
            app.manage(commands::claude_cli::ClaudeCliState::default());
            app.manage(commands::codex_cli::CodexCliState::default());
            app.manage(commands::file_sync::FileSyncState::default());
            // Tray + close-to-tray state, ported from upstream 0e292ee.
            // Seed the close behavior to "ask"; the frontend rehydrates
            // it from the persisted generalConfig on startup. Tray
            // creation is best-effort: some Linux desktops lack a tray,
            // so a failure logs and continues rather than aborting
            // startup.
            app.manage(CloseBehaviorState(Mutex::new("ask".to_string())));
            if let Err(err) = tray::create_tray(app.handle()) {
                eprintln!("[tray] system tray unavailable, continuing without it: {err}");
            }
            api_server::start_api_server(app.handle().clone());
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            commands::fs::read_file,
            commands::fs::write_file,
            commands::fs::write_file_atomic,
            commands::fs::write_binary_file,
            commands::fs::list_directory,
            commands::fs::copy_file,
            commands::fs::copy_directory,
            commands::fs::preprocess_file,
            commands::fs::delete_file,
            commands::fs::find_related_wiki_pages,
            commands::fs::create_directory,
            commands::fs::file_exists,
            commands::fs::get_file_modified_time,
            commands::fs::get_file_size,
            commands::fs::get_file_md5,
            commands::fs::read_file_as_base64,
            commands::project::create_project,
            commands::project::open_project,
            commands::project::open_project_folder,
            commands::package::export_package,
            commands::package::import_package,
            commands::package::inspect_package,
            commands::search::search_project,
            clip_server_status,
            api_server_status,
            api_server_reload_config,
            mcp_server_entry_path,
            commands::vectorstore::vector_upsert,
            commands::vectorstore::vector_search,
            commands::vectorstore::vector_delete,
            commands::vectorstore::vector_count,
            commands::vectorstore::vector_upsert_chunks,
            commands::vectorstore::vector_search_chunks,
            commands::vectorstore::vector_delete_page,
            commands::vectorstore::vector_count_chunks,
            commands::vectorstore::vector_clear_chunks,
            commands::vectorstore::vector_optimize_chunks,
            commands::vectorstore::vector_legacy_row_count,
            commands::vectorstore::vector_drop_legacy,
            commands::claude_cli::claude_cli_detect,
            commands::claude_cli::claude_cli_spawn,
            commands::claude_cli::claude_cli_kill,
            commands::codex_cli::codex_cli_detect,
            commands::codex_cli::codex_cli_spawn,
            commands::codex_cli::codex_cli_kill,
            commands::extract_images::extract_pdf_images_cmd,
            commands::extract_images::extract_office_images_cmd,
            commands::extract_images::extract_and_save_pdf_images_cmd,
            commands::extract_images::extract_and_save_office_images_cmd,
            commands::file_sync::start_project_file_watcher,
            commands::file_sync::stop_project_file_watcher,
            commands::file_sync::rescan_project_files,
            commands::file_sync::get_file_change_queue,
            commands::file_sync::retry_file_change_task,
            commands::file_sync::ignore_file_change_task,
            commands::storage::detect_storage,
            commands::config_crypto::export_config,
            commands::config_crypto::import_config,
            commands::config_backup::config_backup_status,
            commands::config_backup::config_backup_now,
            commands::github_backup::github_backup_now,
            commands::github_backup::github_pull_now,
            commands::github_backup::github_list_versions,
            commands::github_backup::github_restore_version,
            commands::github_backup::github_validate_and_prepare,
            commands::github_backup::github_oauth_device_start,
            commands::github_backup::github_oauth_device_poll,
            commands::github_backup::github_save_token,
            commands::github_backup::github_token_status,
            commands::github_backup::github_clear_token,
            set_proxy_env,
            set_close_behavior,
        ])
        .on_window_event(|window, event| {
            // Close-to-tray, ported from upstream 0e292ee. The fork
            // previously hard-coded per-OS behavior (macOS: hide;
            // others: confirm-then-quit). That branching is now driven
            // by the user's `closeBehavior` preference cached in
            // CloseBehaviorState, identical across platforms:
            //   - "exit":     destroy the window and quit the process.
            //   - "minimize": hide to the tray, keep running.
            //   - "ask":      confirm; OK quits, Cancel hides to tray.
            if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                api.prevent_close();
                let behavior = close_behavior(window);
                let win = window.clone();
                let app = window.app_handle().clone();
                match behavior.as_str() {
                    "exit" => {
                        tauri::async_runtime::spawn(async move {
                            let _ = win.destroy();
                            app.exit(0);
                        });
                    }
                    "minimize" => {
                        let _ = window.hide();
                    }
                    _ => {
                        tauri::async_runtime::spawn(async move {
                            use tauri_plugin_dialog::DialogExt;
                            let confirmed = app
                                .dialog()
                                .message(
                                    "Quit LLM Wiki? Choose OK to exit. Choose Cancel to hide the window and keep background features running.",
                                )
                                .title("LLM Wiki")
                                .kind(tauri_plugin_dialog::MessageDialogKind::Warning)
                                .blocking_show();

                            if confirmed {
                                let _ = win.destroy();
                                app.exit(0);
                            } else {
                                let _ = win.hide();
                            }
                        });
                    }
                }
            }
        })
        .build(tauri::generate_context!())
        .expect("error while building tauri application")
        .run(|app, event| {
            #[cfg(target_os = "macos")]
            if let tauri::RunEvent::Reopen {
                has_visible_windows,
                ..
            } = event
            {
                if !has_visible_windows {
                    use tauri::Manager;
                    if let Some(window) = app.get_webview_window("main") {
                        let _ = window.show();
                        let _ = window.set_focus();
                    }
                }
            }
            let _ = (app, event); // suppress unused warnings on non-macOS
        });
}
