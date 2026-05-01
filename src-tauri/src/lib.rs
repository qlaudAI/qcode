// qcode Tauri host. Phase 1 surface:
//
//   - Boot the webview window with native chrome polish (vibrancy on
//     macOS, acrylic blur on Windows, plain on Linux).
//   - Native application menu (File / Edit / View / Window / Help)
//     with proper platform shortcuts. Menu actions emit a
//     "qcode://menu" event the React app listens for.
//   - qcode:// URL scheme registration so the qlaud /cli-auth flow
//     can hand back an API key after the user signs in.
//   - OS keychain bridge (secret_set / secret_get / secret_del) so
//     the qlaud key never lives in the webview's localStorage.
//   - Plugin wiring: shell, fs, dialog, os, updater, deep-link.
//
// Phase 1 wrap-up will add:
//   - Sidecar opencode subprocess + IPC bridge
//   - Auto-updater backend at qlaud.ai/qcode/release-channels/...

mod menu;
mod secret;

use tauri::{Emitter, Manager, WebviewWindow};
use tauri_plugin_deep_link::DeepLinkExt;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_os::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_deep_link::init())
        .setup(|app| {
            // Register the qcode:// URL scheme. macOS reads this from
            // Info.plist at install time, so registration here is a
            // no-op there — but Linux + dev-mode Windows need it.
            #[cfg(any(target_os = "linux", all(debug_assertions, windows)))]
            {
                app.deep_link().register_all()?;
            }

            // Forward incoming deep links to the frontend. The React
            // app listens via `@tauri-apps/api/event` for the qcode://
            // auth callback URL.
            let handle = app.handle().clone();
            app.deep_link().on_open_url(move |event| {
                let urls: Vec<String> =
                    event.urls().iter().map(|u| u.to_string()).collect();
                let _ = handle.emit("qcode://deep-link", urls);
            });

            // Build + attach the native menu. Menu events route
            // through `menu::dispatch`.
            let menu = menu::build(app.handle())?;
            app.set_menu(menu)?;
            let handle = app.handle().clone();
            app.on_menu_event(move |_window, event| {
                menu::dispatch(&handle, event.id().0.as_str());
            });

            // Apply native window effects to the main window.
            if let Some(window) = app.get_webview_window("main") {
                apply_window_effects(&window);
            }

            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            secret::secret_set,
            secret::secret_get,
            secret::secret_del,
        ])
        .run(tauri::generate_context!())
        .expect("error while running qcode");
}

#[cfg(target_os = "macos")]
fn apply_window_effects(window: &WebviewWindow) {
    use window_vibrancy::{apply_vibrancy, NSVisualEffectMaterial, NSVisualEffectState};
    // HudWindow is the muted, mostly-translucent material used by
    // Apple's own apps (Music, Notes, Reminders). Reads great in
    // light mode and matches our brand red without distorting it.
    let _ = apply_vibrancy(
        window,
        NSVisualEffectMaterial::HudWindow,
        Some(NSVisualEffectState::Active),
        Some(12.0),
    );
}

#[cfg(target_os = "windows")]
fn apply_window_effects(window: &WebviewWindow) {
    use window_vibrancy::apply_acrylic;
    // Acrylic is the Windows 11 blur material; falls back gracefully
    // on Windows 10 (still semi-translucent, less polished).
    let _ = apply_acrylic(window, Some((255, 255, 255, 200)));
}

#[cfg(not(any(target_os = "macos", target_os = "windows")))]
fn apply_window_effects(_window: &WebviewWindow) {
    // Linux: no consistent native blur material across DEs.
    // The page background stays opaque white.
}
