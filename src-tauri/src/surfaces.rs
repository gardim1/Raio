//! The three product surfaces are separate native windows. Exactly one is shown at a time.

use tauri::{AppHandle, Emitter, Manager, PhysicalPosition, WebviewUrl, WebviewWindow, WebviewWindowBuilder};

pub const EXPANDED: &str = "expanded";
pub const ISLAND: &str = "island";
pub const MINI: &str = "mini";
const SURFACES: [&str; 3] = [EXPANDED, ISLAND, MINI];

/// Logical size of the Island window: room for the open capsule (384x156) plus margins.
pub const ISLAND_SIZE: (f64, f64) = (420.0, 184.0);
const MINI_SIZE: (f64, f64) = (380.0, 300.0);
const EDGE_MARGIN: f64 = 24.0;

fn floating(app: &AppHandle, label: &str, size: (f64, f64)) -> tauri::Result<WebviewWindow> {
    WebviewWindowBuilder::new(app, label, WebviewUrl::App(format!("index.html?surface={label}").into()))
        // The Island must never take focus from the user's editor, even when clicked.
        .focusable(label != ISLAND)
        .title("Raio")
        .inner_size(size.0, size.1)
        .decorations(false)
        .transparent(true)
        .shadow(false)
        .resizable(false)
        .skip_taskbar(true)
        .always_on_top(true)
        .focused(false)
        .visible(false)
        .build()
}

/// Creates the Island (top-centre of the primary display) and the Mini Player (bottom-right), hidden.
pub fn create_floating_surfaces(app: &AppHandle) -> tauri::Result<()> {
    let island = floating(app, ISLAND, ISLAND_SIZE)?;
    let mini = floating(app, MINI, MINI_SIZE)?;
    if let Some(monitor) = island.primary_monitor()? {
        let scale = monitor.scale_factor();
        let origin = monitor.position();
        let size = monitor.size();
        let island_w = (ISLAND_SIZE.0 * scale) as i32;
        island.set_position(PhysicalPosition::new(origin.x + (size.width as i32 - island_w) / 2, origin.y))?;
        let (mini_w, mini_h) = ((MINI_SIZE.0 * scale) as i32, (MINI_SIZE.1 * scale) as i32);
        let margin = (EDGE_MARGIN * scale) as i32;
        mini.set_position(PhysicalPosition::new(
            origin.x + size.width as i32 - mini_w - margin,
            origin.y + size.height as i32 - mini_h - margin * 3,
        ))?;
    }
    // Until the renderer publishes the capsule rectangle, the transparent Island lets clicks through.
    island.set_ignore_cursor_events(true)?;
    Ok(())
}

/// Intents a surface may receive when it is shown.
const INTENTS: [&str; 1] = ["replay"];

/// Shows one surface and hides the others. Only the Expanded window takes keyboard focus.
/// An optional intent (e.g. "replay") is forwarded to the shown surface as a `surface-intent` event.
#[tauri::command]
pub fn show_surface(app: AppHandle, surface: String, intent: Option<String>) -> Result<(), String> {
    if !SURFACES.contains(&surface.as_str()) {
        return Err(format!("unknown surface: {surface}"));
    }
    if let Some(intent) = intent.as_deref() {
        if !INTENTS.contains(&intent) {
            return Err(format!("unknown intent: {intent}"));
        }
    }
    for label in SURFACES {
        let Some(window) = app.get_webview_window(label) else { continue };
        let result = if label == surface {
            window.show().and_then(|_| if label == EXPANDED { window.set_focus() } else { Ok(()) })
        } else {
            window.hide()
        };
        result.map_err(|e| e.to_string())?;
        // Hidden webviews may keep animating; tell each surface whether it is on screen.
        let _ = app.emit_to(label, "surface-visible", label == surface);
    }
    if let Some(intent) = intent {
        app.emit_to(surface.as_str(), "surface-intent", intent).map_err(|e| e.to_string())?;
    }
    Ok(())
}

/// Optional always-on-top for the Mini Player (the "pin" toggle).
#[tauri::command]
pub fn set_always_on_top(app: AppHandle, surface: String, on_top: bool) -> Result<(), String> {
    if surface != MINI {
        return Err("only the Mini Player has an always-on-top toggle".into());
    }
    let window = app.get_webview_window(MINI).ok_or("mini window missing")?;
    window.set_always_on_top(on_top).map_err(|e| e.to_string())
}
