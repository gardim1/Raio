//! Tray menu: switch surfaces and quit. Raio never runs commands from here.

use tauri::AppHandle;
use tauri::menu::{Menu, MenuItem, PredefinedMenuItem};
use tauri::tray::TrayIconBuilder;

use crate::surfaces::{EXPANDED, ISLAND, MINI, show_surface};

pub fn install(app: &AppHandle) -> tauri::Result<()> {
    let island = MenuItem::with_id(app, ISLAND, "Show Island", true, None::<&str>)?;
    let mini = MenuItem::with_id(app, MINI, "Show Mini Player", true, None::<&str>)?;
    let expanded = MenuItem::with_id(app, EXPANDED, "Open Raio", true, None::<&str>)?;
    let separator = PredefinedMenuItem::separator(app)?;
    let quit = MenuItem::with_id(app, "quit", "Quit Raio", true, None::<&str>)?;
    let menu = Menu::with_items(app, &[&expanded, &mini, &island, &separator, &quit])?;
    let mut builder = TrayIconBuilder::with_id("raio").tooltip("Raio").menu(&menu).show_menu_on_left_click(true);
    if let Some(icon) = app.default_window_icon() {
        builder = builder.icon(icon.clone());
    }
    builder
        .on_menu_event(|app, event| match event.id.as_ref() {
            "quit" => app.exit(0),
            surface => {
                let _ = show_surface(app.clone(), surface.to_string(), None);
            }
        })
        .build(app)?;
    Ok(())
}
