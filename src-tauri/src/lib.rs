// qcode Tauri host. Phase 1 surface is intentionally narrow:
//
//   - Boot the webview window (the React UI does the heavy lifting).
//   - Register the qcode:// URL scheme so the qlaud /cli-auth flow can
//     hand back an API key after the user signs in via their browser.
//   - Wire shell + fs + dialog + os + updater plugins for later use.
//
// Phase 2 work lives in agent.rs / sandbox.rs (process supervisor for
// the embedded opencode core) — not implemented yet.

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
            // Register the qcode:// URL scheme on first launch so the
            // qlaud sign-in flow can redirect back into the app.
            #[cfg(any(target_os = "linux", all(debug_assertions, windows)))]
            {
                use tauri_plugin_deep_link::DeepLinkExt;
                app.deep_link().register_all()?;
            }

            // Forward incoming deep links to the frontend. The React
            // app listens for these via `@tauri-apps/plugin-deep-link`
            // and pulls the `?k=<base64>` API key out of the URL.
            let handle = app.handle().clone();
            app.deep_link().on_open_url(move |event| {
                let urls: Vec<String> = event
                    .urls()
                    .iter()
                    .map(|u| u.to_string())
                    .collect();
                let _ = tauri::Emitter::emit(&handle, "qcode://deep-link", urls);
            });
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![ping])
        .run(tauri::generate_context!())
        .expect("error while running qcode");
}

#[tauri::command]
fn ping() -> &'static str {
    "pong"
}
