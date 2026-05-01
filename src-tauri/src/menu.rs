// Native application menu. Tauri 2's Menu API mirrors AppKit / Win32
// menu structure, so the bar reads natively on every platform.
//
// macOS gets the standard "qcode" app menu (About, Preferences, Hide,
// Quit). Linux + Windows just see File / Edit / View / Window / Help.
//
// The frontend listens to "qcode://menu" events to react to actions
// (new chat, open folder, command palette). We keep the wiring narrow:
// the menu only emits intent; the React app decides what to do.

use tauri::{
    menu::{AboutMetadataBuilder, Menu, MenuBuilder, MenuItemBuilder, PredefinedMenuItem, SubmenuBuilder},
    AppHandle, Emitter, Manager, Runtime,
};

const MENU_EVENT: &str = "qcode://menu";

pub fn build<R: Runtime>(handle: &AppHandle<R>) -> tauri::Result<Menu<R>> {
    // ─── App menu (macOS only — Tauri folds these elsewhere on win/linux) ──
    let about_md = AboutMetadataBuilder::new()
        .name(Some("qcode"))
        .version(Some(env!("CARGO_PKG_VERSION")))
        .copyright(Some("© 2026 qlaud"))
        .website(Some("https://qlaud.ai"))
        .website_label(Some("qlaud.ai"))
        .build();

    let app_menu = SubmenuBuilder::new(handle, "qcode")
        .item(&PredefinedMenuItem::about(handle, Some("About qcode"), Some(about_md))?)
        .separator()
        .item(
            &MenuItemBuilder::with_id("preferences", "Preferences…")
                .accelerator("CmdOrCtrl+,")
                .build(handle)?,
        )
        .item(
            &MenuItemBuilder::with_id("sign_out", "Sign Out")
                .build(handle)?,
        )
        .separator()
        .item(&PredefinedMenuItem::services(handle, None)?)
        .separator()
        .item(&PredefinedMenuItem::hide(handle, None)?)
        .item(&PredefinedMenuItem::hide_others(handle, None)?)
        .item(&PredefinedMenuItem::show_all(handle, None)?)
        .separator()
        .item(&PredefinedMenuItem::quit(handle, Some("Quit qcode"))?)
        .build()?;

    // ─── File ──────────────────────────────────────────────────────
    let file_menu = SubmenuBuilder::new(handle, "File")
        .item(
            &MenuItemBuilder::with_id("new_chat", "New Chat")
                .accelerator("CmdOrCtrl+N")
                .build(handle)?,
        )
        .item(
            &MenuItemBuilder::with_id("open_folder", "Open Folder…")
                .accelerator("CmdOrCtrl+O")
                .build(handle)?,
        )
        .separator()
        .item(
            &MenuItemBuilder::with_id("close_window", "Close Window")
                .accelerator("CmdOrCtrl+W")
                .build(handle)?,
        )
        .build()?;

    // ─── Edit ──────────────────────────────────────────────────────
    let edit_menu = SubmenuBuilder::new(handle, "Edit")
        .item(&PredefinedMenuItem::undo(handle, None)?)
        .item(&PredefinedMenuItem::redo(handle, None)?)
        .separator()
        .item(&PredefinedMenuItem::cut(handle, None)?)
        .item(&PredefinedMenuItem::copy(handle, None)?)
        .item(&PredefinedMenuItem::paste(handle, None)?)
        .item(&PredefinedMenuItem::select_all(handle, None)?)
        .build()?;

    // ─── View ──────────────────────────────────────────────────────
    let view_menu = SubmenuBuilder::new(handle, "View")
        .item(
            &MenuItemBuilder::with_id("command_palette", "Command Palette…")
                .accelerator("CmdOrCtrl+K")
                .build(handle)?,
        )
        .item(
            &MenuItemBuilder::with_id("model_picker", "Switch Model…")
                .accelerator("CmdOrCtrl+M")
                .build(handle)?,
        )
        .separator()
        .item(&PredefinedMenuItem::fullscreen(handle, None)?)
        .build()?;

    // ─── Window ────────────────────────────────────────────────────
    let window_menu = SubmenuBuilder::new(handle, "Window")
        .item(&PredefinedMenuItem::minimize(handle, None)?)
        .item(&PredefinedMenuItem::maximize(handle, None)?)
        .build()?;

    // ─── Help ──────────────────────────────────────────────────────
    let help_menu = SubmenuBuilder::new(handle, "Help")
        .item(
            &MenuItemBuilder::with_id("docs", "qcode Documentation")
                .build(handle)?,
        )
        .item(
            &MenuItemBuilder::with_id("github", "GitHub Repository")
                .build(handle)?,
        )
        .item(
            &MenuItemBuilder::with_id("dashboard", "qlaud Dashboard")
                .build(handle)?,
        )
        .build()?;

    let menu = MenuBuilder::new(handle)
        .items(&[&app_menu, &file_menu, &edit_menu, &view_menu, &window_menu, &help_menu])
        .build()?;

    Ok(menu)
}

pub fn dispatch<R: Runtime>(handle: &AppHandle<R>, id: &str) {
    // Most menu items are pure intent — emit and let the frontend
    // decide. A few (links to external URLs) we handle in Rust because
    // the frontend should never have to know about absolute URLs.
    match id {
        "docs" => open_url(handle, "https://docs.qlaud.ai/qcode"),
        "github" => open_url(handle, "https://github.com/qlaudAI/qcode"),
        "dashboard" => open_url(handle, "https://qlaud.ai/dashboard"),
        "close_window" => {
            if let Some(w) = handle.webview_windows().values().next() {
                let _ = w.close();
            }
        }
        _ => {
            let _ = handle.emit(MENU_EVENT, id);
        }
    }
}

fn open_url<R: Runtime>(handle: &AppHandle<R>, url: &str) {
    use tauri_plugin_shell::ShellExt;
    let _ = handle.shell().open(url, None);
}
