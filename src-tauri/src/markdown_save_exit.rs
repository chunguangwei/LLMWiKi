use std::sync::Mutex;
use tauri::{Emitter, Manager, Runtime};

pub const SAVE_BEFORE_EXIT_EVENT: &str = "llmwiki://save-before-exit";

#[derive(Default)]
struct ExitGate {
    preparing: bool,
    allowed: bool,
}

impl ExitGate {
    fn request(&mut self) -> bool {
        if self.allowed || self.preparing {
            return false;
        }
        self.preparing = true;
        true
    }

    fn finish(&mut self) {
        self.preparing = false;
        self.allowed = true;
    }

    fn cancel(&mut self) {
        self.preparing = false;
        self.allowed = false;
    }
}

#[derive(Default)]
pub struct MarkdownSaveExitState(Mutex<ExitGate>);

pub fn request_exit<R: Runtime>(app: &tauri::AppHandle<R>) {
    let state = app.state::<MarkdownSaveExitState>();
    let should_notify = match state.0.lock() {
        Ok(mut gate) => gate.request(),
        Err(_) => false,
    };
    if state.0.lock().map(|gate| gate.allowed).unwrap_or(false) {
        app.exit(0);
        return;
    }
    if !should_notify {
        return;
    }
    let Some(window) = app.get_webview_window("main") else {
        app.exit(0);
        return;
    };
    if let Err(error) = window.emit(SAVE_BEFORE_EXIT_EVENT, ()) {
        eprintln!("[exit] failed to request Markdown flush: {error}");
        cancel_markdown_save_exit(state);
    }
}

pub fn exit_allowed<R: Runtime>(app: &tauri::AppHandle<R>) -> bool {
    app.state::<MarkdownSaveExitState>()
        .0
        .lock()
        .map(|gate| gate.allowed)
        .unwrap_or(false)
}

#[tauri::command]
pub fn finish_markdown_save_exit<R: Runtime>(
    app: tauri::AppHandle<R>,
    state: tauri::State<'_, MarkdownSaveExitState>,
) {
    if let Ok(mut gate) = state.0.lock() {
        gate.finish();
    }
    app.exit(0);
}

#[tauri::command]
pub fn cancel_markdown_save_exit(state: tauri::State<'_, MarkdownSaveExitState>) {
    if let Ok(mut gate) = state.0.lock() {
        gate.cancel();
    }
}

#[cfg(test)]
mod tests {
    use super::ExitGate;

    #[test]
    fn duplicate_exit_requests_share_one_flush() {
        let mut gate = ExitGate::default();
        assert!(gate.request());
        assert!(!gate.request());
        gate.cancel();
        assert!(gate.request());
    }

    #[test]
    fn confirmed_exit_is_allowed_after_flush() {
        let mut gate = ExitGate::default();
        assert!(gate.request());
        gate.finish();
        assert!(gate.allowed);
        assert!(!gate.preparing);
        assert!(!gate.request());
    }
}
